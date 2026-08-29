// dcaSmartMoneyAdapter.ts -- DCA Smart Money Adapter V3 (Phase 3).
// Directional accumulation timing + 3-tier Pause Guard + smoothed ATR interval.
// STATEFUL via dca_active_plans (D1) untuk entry ke-N / next trigger -- dipersist
// di entryAlertCron sebelum kirim Telegram.
//
// REUSE Phase 1: calculateScenarioC, normalizeFunding, getOIVelocityPercentile.
import { calculateScenarioC, type ScenarioCInput } from "./smartMoneyPipelineEngine.js";
import { normalizeFunding, getOIVelocityPercentile, ema, calculateSlope, multiTfAlignScore } from "../tools/smartMoneyMetrics.js";
import { computeATR, summarizeKlines, type KlineCandle } from "../toolHelpers.js";
import type { MarketRegime } from "../tools/marketRegime.js";
import type { GridSmDecision } from "./gridSmartMoneyAdapter.js";
import { computeOiVelocity } from "../tools/oiVelocity.js";
import type { KlineTuple, OpenInterestHistPoint } from "../binanceProxyClient.js";
import { queryMarketSnapshots } from "../d1Client.js";

export type DcaSide = "LONG" | "SHORT";
export type DcaPauseLevel = "NONE" | "PAUSE_SOFT" | "PAUSE_HARD" | "STOP";
export type DcaSmDecision =
  | "DCA_TRADE"
  | "DCA_WATCH"
  | "DCA_PAUSE_SOFT"
  | "DCA_PAUSE_HARD"
  | "DCA_STOP";

export const DCA_TIMING_TRADE_MIN = 75;
export const DCA_TIMING_WATCH_MIN = 60;
export const DCA_DEFAULT_MAX_ENTRIES = 6;
export const INTERVAL_FLOOR_PCT = 1.5;
export const INTERVAL_CEILING_PCT = 8.0;
export const ATR_EMA_PERIOD = 6;
export const CAPITULATION_LIQ_MULT = 5;
export const CAPITULATION_LIQ_USD = 2_000_000;

export const W_TIMING_SC = 0.4;
export const W_TIMING_SQUEEZE = 0.3;
export const W_TIMING_OI = 0.2;
export const W_TIMING_ANTI_SQUEEZE = 0.1;

const REGIME_INTERVAL_FACTOR: Record<string, number> = {
  LOW_VOL: 1.0,
  RANGING: 1.2,
  ACCUMULATION: 0.8,
  DISTRIBUTION: 1.0,
  BREAKOUT: 1.5,
  STRONG_TRENDING: 1.8,
  TRENDING_UP: 1.8,
  TRENDING_DOWN: 1.8,
};

function clamp100(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 100 ? 100 : x;
}

function clampInterval(x: number): number {
  return Math.min(INTERVAL_CEILING_PCT, Math.max(INTERVAL_FLOOR_PCT, x));
}

/** Short squeeze boost: funding percentile < 20 -> map (20 - pct) * 5 to 0-100. */
export function computeShortSqueezeBoost(fundingPercentile: number): number {
  if (fundingPercentile >= 20) return 0;
  return clamp100((20 - fundingPercentile) * 5);
}

/** Long squeeze risk: funding percentile > 80 -> map (pct - 80) * 5 to 0-100. */
export function computeLongSqueezeRisk(fundingPercentile: number): number {
  if (fundingPercentile <= 80) return 0;
  return clamp100((fundingPercentile - 80) * 5);
}

export interface DirectionalTimingComponents {
  scenarioC: number;
  squeezeBoost: number;
  oiVelocity: number;
  antiSqueeze: number;
}

/**
 * Directional timing 0-100. LONG: S_C + ShortSqueezeBoost + OI + (100-LongRisk).
 * SHORT (mirror): (100-S_C) + LongRisk-as-boost + OI + (100-ShortBoost).
 */
export function computeDirectionalTiming(
  side: DcaSide,
  scenarioCScore: number,
  fundingPercentile: number,
  oiVelocityPercentile: number,
): { score: number; components: DirectionalTimingComponents } {
  const sC = clamp100(scenarioCScore);
  const shortBoost = computeShortSqueezeBoost(fundingPercentile);
  const longRisk = computeLongSqueezeRisk(fundingPercentile);
  const oi = clamp100(oiVelocityPercentile);

  let score: number;
  let squeezeBoost: number;
  let antiSqueeze: number;

  if (side === "LONG") {
    squeezeBoost = shortBoost;
    antiSqueeze = 100 - longRisk;
    score =
      W_TIMING_SC * sC +
      W_TIMING_SQUEEZE * shortBoost +
      W_TIMING_OI * oi +
      W_TIMING_ANTI_SQUEEZE * antiSqueeze;
  } else {
    // Mirror: long crowded = boost short DCA; short squeeze setup = penalty.
    squeezeBoost = longRisk;
    antiSqueeze = 100 - shortBoost;
    score =
      W_TIMING_SC * (100 - sC) +
      W_TIMING_SQUEEZE * longRisk +
      W_TIMING_OI * oi +
      W_TIMING_ANTI_SQUEEZE * antiSqueeze;
  }

  return {
    score: clamp100(score),
    components: { scenarioC: sC, squeezeBoost, oiVelocity: oi, antiSqueeze },
  };
}

export interface DcaSafetyResult {
  score: number;
  distributionPenalty: number;
  longSqueezePenalty: number;
  longSqueezeRisk: number;
}

/** SafetyScore = max(0, 100 - distributionPenalty - longSqueezePenalty). */
export function computeDcaSafetyScore(scenarioCScore: number, fundingPercentile: number): DcaSafetyResult {
  const sC = clamp100(scenarioCScore);
  const longSqueezeRisk = computeLongSqueezeRisk(fundingPercentile);
  const distributionPenalty = sC < 25 ? 40 : 0;
  const longSqueezePenalty = longSqueezeRisk > 80 ? 50 : longSqueezeRisk > 60 ? 25 : 0;
  const score = Math.max(0, 100 - distributionPenalty - longSqueezePenalty);
  return { score, distributionPenalty, longSqueezePenalty, longSqueezeRisk };
}

export interface CapitulationInput {
  liqSpikeUsd: number;
  liqMean24hUsd: number;
  priceDropAbs?: number;
  atr1h?: number;
}

/** Capitulation: liq > 5x baseline OR (>$2M liq AND price drop > 2×ATR). */
export function isCapitulation(input: CapitulationInput): boolean {
  const { liqSpikeUsd, liqMean24hUsd, priceDropAbs, atr1h } = input;
  if (liqMean24hUsd > 0 && liqSpikeUsd > CAPITULATION_LIQ_MULT * liqMean24hUsd) return true;
  if (
    liqSpikeUsd > CAPITULATION_LIQ_USD &&
    priceDropAbs != null &&
    atr1h != null &&
    atr1h > 0 &&
    priceDropAbs > 2 * atr1h
  ) {
    return true;
  }
  return false;
}

/**
 * Pause hierarchy (severity: STOP > HARD > SOFT > NONE).
 * Spec Phase 3 prompt section 2B.
 */
export function resolvePauseLevel(
  safetyScore: number,
  scenarioCScore: number,
  longSqueezeRisk: number,
  capitulation: boolean,
): DcaPauseLevel {
  if (safetyScore < 20 || capitulation) return "STOP";
  if (safetyScore < 50 || longSqueezeRisk > 80) return "PAUSE_HARD";
  if (safetyScore < 70 || scenarioCScore < 25) return "PAUSE_SOFT";
  return "NONE";
}

/** ATR_1h series (trailing) then EMA(6) for smoothed interval base. */
export function computeSmoothedAtrPct(candles1h: KlineCandle[], atrPeriod = 14, emaPeriod = ATR_EMA_PERIOD): number {
  if (candles1h.length < atrPeriod + 1) return INTERVAL_FLOOR_PCT;
  const atrSeries: number[] = [];
  const start = Math.max(atrPeriod, candles1h.length - emaPeriod - atrPeriod);
  for (let end = start + atrPeriod; end <= candles1h.length; end++) {
    atrSeries.push(computeATR(candles1h.slice(0, end), atrPeriod));
  }
  if (atrSeries.length === 0) return INTERVAL_FLOOR_PCT;
  return ema(atrSeries, emaPeriod);
}

export function regimeIntervalFactor(regime: MarketRegime | string): number {
  return REGIME_INTERVAL_FACTOR[regime] ?? 1.0;
}

/** finalInterval = clamp(1.5, 8.0, (smoothedATR/price)*100 * regimeFactor). */
export function computeDynamicIntervalPct(
  candles1h: KlineCandle[],
  currentPrice: number,
  regime: MarketRegime | string,
): number {
  if (!(currentPrice > 0)) return INTERVAL_FLOOR_PCT;
  const smoothedAtr = computeSmoothedAtrPct(candles1h);
  const baseInterval = (smoothedAtr / currentPrice) * 100;
  return clampInterval(baseInterval * regimeIntervalFactor(regime));
}

export function computeNextTriggerPrice(currentPrice: number, intervalPct: number, side: DcaSide): number {
  const factor = side === "LONG" ? 1 - intervalPct / 100 : 1 + intervalPct / 100;
  return currentPrice * factor;
}

export interface DcaSmartMoneyInput {
  symbol: string;
  side: DcaSide;
  currentPrice: number;
  scenarioC: ScenarioCInput;
  fundingRate: number;
  fundingHistory30d: number[];
  oiVelocityPerHour: number;
  oiVelocityHistory: number[];
  regime: MarketRegime | string;
  candles1h: KlineCandle[];
  liqSpikeUsd: number;
  liqMean24hUsd: number;
  priceDropAbs?: number;
  atr1h?: number;
  /** Cross-product: gridSmartMoneyAdapter GRID_NO_TRADE (breakout/range breakdown). */
  gridSmDecision?: GridSmDecision | null;
  entryCount?: number;
  maxEntries?: number;
}

export interface DcaSmartMoneyResult {
  decision: DcaSmDecision;
  timingScore: number;
  safetyScore: number;
  intervalPct: number;
  nextTriggerPrice: number;
  pauseLevel: DcaPauseLevel;
  pauseReason: string | null;
  entryCount: number;
  maxEntries: number;
  fundingPercentile: number;
  oiVelocityPercentile: number;
  scenarioCScore: number;
  reasons: string[];
}

export function scenarioCFrom(input: ScenarioCInput): number {
  return calculateScenarioC(input);
}

/** Rolling OI velocity samples from openInterestHist (window 5). */
export function oiVelocityHistoryFromHist(oiHist: OpenInterestHistPoint[]): number[] {
  const out: number[] = [];
  for (let i = 5; i <= oiHist.length; i++) {
    const v = computeOiVelocity(oiHist.slice(i - 5, i), 5);
    if (!v.errorCode) out.push(v.oiVelocityPerHour);
  }
  return out;
}

export async function loadFundingHistory30d(symbol: string): Promise<number[]> {
  try {
    const snaps = await queryMarketSnapshots(symbol, 24 * 30);
    return snaps.map((s) => s.fundingRate).filter((r): r is number => r != null && Number.isFinite(r));
  } catch {
    return [];
  }
}

export interface BuildDcaSmParams {
  symbol: string;
  side: DcaSide;
  currentPrice: number;
  klines1h: KlineTuple[];
  klines4h: KlineTuple[];
  fundingRate: number;
  oiHist24: OpenInterestHistPoint[];
  oiVelocityPerHour: number;
  regime: MarketRegime | string;
  gridSmDecision?: GridSmDecision | null;
  cvdBuyPct?: number;
  entryCount?: number;
  liqSpikeUsd?: number;
  liqMean24hUsd?: number;
}

/** Build Scenario C + funding/OI context from Wave 1/2 pipeline data (0 fetch tambahan). */
export async function buildAndEvaluateDcaSmartMoney(params: BuildDcaSmParams): Promise<DcaSmartMoneyResult> {
  const { candles: candles1h } = summarizeKlines(params.klines1h);
  const { bias: b1h } = summarizeKlines(params.klines1h);
  const { bias: b4h } = summarizeKlines(params.klines4h);
  const slopeFutures = calculateSlope(candles1h.slice(-20).map((c) => c.close));
  const scenarioC: ScenarioCInput = {
    slopeSpot: slopeFutures * 0.85,
    slopeFutures,
    takerSpotNorm: params.cvdBuyPct ?? 50,
    multiTfAlign: multiTfAlignScore(b1h, b4h),
  };
  const fundingHistory30d = await loadFundingHistory30d(params.symbol);
  const atr1h = computeATR(candles1h, 14);

  return evaluateDcaSmartMoney({
    symbol: params.symbol,
    side: params.side,
    currentPrice: params.currentPrice,
    scenarioC,
    fundingRate: params.fundingRate,
    fundingHistory30d,
    oiVelocityPerHour: params.oiVelocityPerHour,
    oiVelocityHistory: oiVelocityHistoryFromHist(params.oiHist24),
    regime: params.regime,
    candles1h,
    liqSpikeUsd: params.liqSpikeUsd ?? 0,
    liqMean24hUsd: params.liqMean24hUsd ?? 0,
    atr1h,
    gridSmDecision: params.gridSmDecision,
    entryCount: params.entryCount,
  });
}

export function evaluateDcaSmartMoney(input: DcaSmartMoneyInput): DcaSmartMoneyResult {
  const reasons: string[] = [];
  const maxEntries = input.maxEntries ?? DCA_DEFAULT_MAX_ENTRIES;
  const entryCount = input.entryCount ?? 0;

  const scenarioCScore = calculateScenarioC(input.scenarioC);
  const fundingPercentile = normalizeFunding(input.fundingRate, input.fundingHistory30d);
  const oiVelocityPercentile = getOIVelocityPercentile(input.oiVelocityPerHour, input.oiVelocityHistory);

  const { score: timingScore, components: timingComp } = computeDirectionalTiming(
    input.side,
    scenarioCScore,
    fundingPercentile,
    oiVelocityPercentile,
  );
  const safety = computeDcaSafetyScore(scenarioCScore, fundingPercentile);
  const capitulation = isCapitulation({
    liqSpikeUsd: input.liqSpikeUsd,
    liqMean24hUsd: input.liqMean24hUsd,
    priceDropAbs: input.priceDropAbs,
    atr1h: input.atr1h,
  });
  let pauseLevel = resolvePauseLevel(safety.score, scenarioCScore, safety.longSqueezeRisk, capitulation);
  let pauseReason: string | null = null;

  reasons.push(
    `D_timing ${timingScore.toFixed(1)} (S_C ${timingComp.scenarioC.toFixed(0)}, squeeze ${timingComp.squeezeBoost.toFixed(0)}, OI ${timingComp.oiVelocity.toFixed(0)}, anti ${timingComp.antiSqueeze.toFixed(0)})`,
  );
  reasons.push(
    `Safety ${safety.score.toFixed(0)} (distPen ${safety.distributionPenalty}, longSqPen ${safety.longSqueezePenalty}, longRisk ${safety.longSqueezeRisk.toFixed(0)})`,
  );

  if (capitulation) reasons.push("Capitulation detected (liq spike vs baseline / $2M+ drop)");

  const intervalPct = computeDynamicIntervalPct(input.candles1h, input.currentPrice, input.regime);
  const nextTriggerPrice = computeNextTriggerPrice(input.currentPrice, intervalPct, input.side);
  reasons.push(`Interval ${intervalPct.toFixed(2)}% -> next trigger ${nextTriggerPrice.toFixed(4)}`);

  // Cross-product guard: Grid Bot NO_TRADE -> override to PAUSE_SOFT minimum.
  if (input.gridSmDecision === "GRID_NO_TRADE") {
    if (pauseLevel === "NONE") {
      pauseLevel = "PAUSE_SOFT";
      pauseReason = "Grid Bot detects range breakdown risk on same symbol";
      reasons.push(`Cross-product: GRID_NO_TRADE -> ${pauseLevel} (${pauseReason})`);
    }
  }

  if (pauseLevel === "STOP") {
    pauseReason =
      pauseReason ??
      (capitulation
        ? "Capitulation liquidation spike — manual review required"
        : `Safety score ${safety.score.toFixed(0)} < 20`);
    return {
      decision: "DCA_STOP",
      timingScore,
      safetyScore: safety.score,
      intervalPct,
      nextTriggerPrice,
      pauseLevel,
      pauseReason,
      entryCount,
      maxEntries,
      fundingPercentile,
      oiVelocityPercentile,
      scenarioCScore,
      reasons: [...reasons, "🚨 DCA PLAN INVALIDATED - MANUAL REVIEW REQUIRED"],
    };
  }

  if (pauseLevel === "PAUSE_HARD") {
    pauseReason =
      pauseReason ??
      (safety.longSqueezeRisk > 80
        ? `Long squeeze risk ${safety.longSqueezeRisk.toFixed(0)} > 80`
        : `Safety score ${safety.score.toFixed(0)} < 50`);
    return {
      decision: "DCA_PAUSE_HARD",
      timingScore,
      safetyScore: safety.score,
      intervalPct,
      nextTriggerPrice,
      pauseLevel,
      pauseReason,
      entryCount,
      maxEntries,
      fundingPercentile,
      oiVelocityPercentile,
      scenarioCScore,
      reasons: [...reasons, `Pause HARD: ${pauseReason}`],
    };
  }

  if (pauseLevel === "PAUSE_SOFT") {
    pauseReason =
      pauseReason ??
      (scenarioCScore < 25
        ? `Distribution signal S_C ${scenarioCScore.toFixed(0)} < 25`
        : `Safety score ${safety.score.toFixed(0)} < 70`);
    return {
      decision: "DCA_PAUSE_SOFT",
      timingScore,
      safetyScore: safety.score,
      intervalPct,
      nextTriggerPrice,
      pauseLevel,
      pauseReason,
      entryCount,
      maxEntries,
      fundingPercentile,
      oiVelocityPercentile,
      scenarioCScore,
      reasons: [...reasons, `Pause SOFT (defer 2 ticks): ${pauseReason}`],
    };
  }

  if (entryCount >= maxEntries) {
    return {
      decision: "DCA_PAUSE_HARD",
      timingScore,
      safetyScore: safety.score,
      intervalPct,
      nextTriggerPrice,
      pauseLevel: "PAUSE_HARD",
      pauseReason: `Max entries reached (${entryCount}/${maxEntries})`,
      entryCount,
      maxEntries,
      fundingPercentile,
      oiVelocityPercentile,
      scenarioCScore,
      reasons: [...reasons, "Max entries cap — freeze DCA plan"],
    };
  }

  let decision: DcaSmDecision;
  if (timingScore >= DCA_TIMING_TRADE_MIN) {
    decision = "DCA_TRADE";
  } else if (timingScore >= DCA_TIMING_WATCH_MIN) {
    decision = "DCA_WATCH";
  } else {
    decision = "DCA_PAUSE_SOFT";
    pauseReason = `Timing ${timingScore.toFixed(0)} < ${DCA_TIMING_WATCH_MIN}`;
    return {
      decision,
      timingScore,
      safetyScore: safety.score,
      intervalPct,
      nextTriggerPrice,
      pauseLevel: "PAUSE_SOFT",
      pauseReason,
      entryCount,
      maxEntries,
      fundingPercentile,
      oiVelocityPercentile,
      scenarioCScore,
      reasons: [...reasons, pauseReason],
    };
  }

  reasons.push(`Decision ${decision} (timing ${timingScore.toFixed(1)})`);
  return {
    decision,
    timingScore,
    safetyScore: safety.score,
    intervalPct,
    nextTriggerPrice,
    pauseLevel: "NONE",
    pauseReason: null,
    entryCount,
    maxEntries,
    fundingPercentile,
    oiVelocityPercentile,
    scenarioCScore,
    reasons,
  };
}
