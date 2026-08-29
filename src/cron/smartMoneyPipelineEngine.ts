// smartMoneyPipelineEngine.ts -- Smart Money Core Engine V2 (pure "head"),
// berjalan PARALEL dengan traditionalPipelineEngine.ts. Order-flow +
// derivatives driven: tiga skenario (Squeeze / Sweep / Divergence), masing-
// masing di-skor 0-100, lalu dikomposit jadi FinalScore + keputusan
// TRAD_NO_TRADE / TRAD_WATCH / TRAD_TRADE.
//
// Fungsi MURNI: menerima metrik yang SUDAH dinormalisasi/di-fetch di tempat
// lain (smartMoneyMetrics.ts + Wave 1/2 fullPipeline / cron), NOL subrequest.
// Semua bobot/threshold di sini heuristik spec V2, BELUM di-backtest.
import { normalizeLiquidation, normalizeAbsorption } from "../tools/smartMoneyMetrics.js";
import type { MarketRegime } from "../tools/marketRegime.js";

export type SmartMoneyDecision = "TRAD_TRADE" | "TRAD_WATCH" | "TRAD_NO_TRADE";
export type SmartMoneyScenario = "SQUEEZE" | "SWEEP" | "DIVERGENCE" | "NONE";

// ── Bobot & threshold (di-export supaya bisa dites/dituning) ──
export const SQUEEZE_W = { oiVel: 0.4, funding: 0.35, consolidation: 0.25 };
export const SWEEP_W = { sweepConf: 0.4, liq: 0.35, absorption: 0.25 };
export const DIVERGENCE_W = { slopeRatio: 0.5, takerSpot: 0.3, multiTf: 0.2 };
export const CONSOLIDATION_ATR_MULT = 0.35;
export const SLOPE_RATIO_MULT = 33;
export const ACTIVE_SUBSCORE_MIN = 40;
export const CONFLUENCE_BONUS = 10;
export const SM_WATCH_MIN_SCORE = 50;
export const SM_TRADE_MIN_SCORE = 75;

export interface SmartMoneyInput {
  // ── Scenario A: Squeeze ──
  /** OI velocity ternormalisasi 0-100 (mis. percentile / turunan whalescope_get_oi_velocity). */
  oiVelocityPct: number;
  /** Funding percentile 0-100 (smartMoneyMetrics.normalizeFunding). */
  fundingPct: number;
  /** |ΔP_1h| pergerakan harga 1 jam, absolut, satuan harga (sama dengan atr1h). */
  priceChange1hAbs: number;
  /** ATR 1h (satuan harga, smartMoneyMetrics.calculateATR). */
  atr1h: number;

  // ── Scenario B: Sweep ──
  /** whalescope_detect_liquidity_sweep.isLiquiditySweep -> SweepConfidence 100/0. */
  isLiquiditySweep: boolean;
  liqSpike: number;
  liqMean24h: number;
  /** Taker buy ratio futures (persen 0-100) untuk AbsorptionScore. */
  takerRatioFutures: number;

  // ── Scenario C: Divergence ──
  slopeSpot: number;
  slopeFutures: number;
  /** Taker spot ternormalisasi 0-100. */
  takerSpotNorm: number;
  /** MultiTF alignment 0/50/100 (smartMoneyMetrics.multiTfAlignScore, 1h+4h). */
  multiTfAlign: number;

  // ── Global regime filter ──
  regime: MarketRegime;
  /** true kalau Scenario B adalah sweep melawan tren (counter-trend). */
  sweepIsCounterTrend: boolean;
}

export interface SmartMoneyResult {
  decision: SmartMoneyDecision;
  finalScore: number;
  scenarioScores: { squeeze: number; sweep: number; divergence: number };
  activeCount: number;
  confluenceBonus: number;
  dominantScenario: SmartMoneyScenario;
  regimeFilterApplied: boolean;
  reasons: string[];
}

function clamp100(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 100 ? 100 : x;
}

/** ConsolidationScore = max(0, 100 - (|ΔP_1h| / (0.35 * ATR_1h)) * 100). */
export function consolidationScore(priceChange1hAbs: number, atr1h: number): number {
  if (!(atr1h > 0)) return 0;
  const ratio = Math.abs(priceChange1hAbs) / (CONSOLIDATION_ATR_MULT * atr1h);
  return Math.max(0, 100 - ratio * 100);
}

/** SlopeRatio = min(100, (SlopeSpot / SlopeFutures) * 33). Guard slopeFutures 0 -> 0. */
export function slopeRatioScore(slopeSpot: number, slopeFutures: number): number {
  if (slopeFutures === 0 || !Number.isFinite(slopeFutures)) return 0;
  return Math.min(100, (slopeSpot / slopeFutures) * SLOPE_RATIO_MULT);
}

export interface ScenarioCInput {
  slopeSpot: number;
  slopeFutures: number;
  takerSpotNorm: number;
  multiTfAlign: number;
}

/**
 * Scenario C (Spot vs Futures CVD divergence) sub-score 0-100. Di-export supaya
 * Grid Bot Smart Money Adapter (Phase 2, gridSmartMoneyAdapter.ts) bisa reuse
 * S_C tanpa menjalankan engine penuh. Dipakai juga di dalam evaluateSmartMoneyEntry.
 */
export function calculateScenarioC(i: ScenarioCInput): number {
  return clamp100(
    DIVERGENCE_W.slopeRatio * slopeRatioScore(i.slopeSpot, i.slopeFutures) +
      DIVERGENCE_W.takerSpot * clamp100(i.takerSpotNorm) +
      DIVERGENCE_W.multiTf * clamp100(i.multiTfAlign),
  );
}

function isStrongTrending(regime: MarketRegime): boolean {
  return regime === "TRENDING_UP" || regime === "TRENDING_DOWN";
}

export function evaluateSmartMoneyEntry(input: SmartMoneyInput): SmartMoneyResult {
  const reasons: string[] = [];

  // ── Scenario A: Squeeze ──
  const consol = consolidationScore(input.priceChange1hAbs, input.atr1h);
  const sA = clamp100(
    SQUEEZE_W.oiVel * clamp100(input.oiVelocityPct) +
      SQUEEZE_W.funding * clamp100(input.fundingPct) +
      SQUEEZE_W.consolidation * consol,
  );
  reasons.push(
    `A/Squeeze ${sA.toFixed(1)} (OIvel ${clamp100(input.oiVelocityPct).toFixed(0)}, funding ${clamp100(input.fundingPct).toFixed(0)}, consol ${consol.toFixed(0)})`,
  );

  // ── Scenario B: Sweep ──
  const sweepConfidence = input.isLiquiditySweep ? 100 : 0;
  const liqNorm = normalizeLiquidation(input.liqSpike, input.liqMean24h);
  const absorption = normalizeAbsorption(input.takerRatioFutures);
  let sB = clamp100(SWEEP_W.sweepConf * sweepConfidence + SWEEP_W.liq * liqNorm + SWEEP_W.absorption * absorption);

  // Global regime filter: Strong Trending + counter-trend sweep -> S_B = 0.
  let regimeFilterApplied = false;
  if (isStrongTrending(input.regime) && input.sweepIsCounterTrend) {
    sB = 0;
    regimeFilterApplied = true;
    reasons.push(`B/Sweep di-nol-kan: regime ${input.regime} (strong trending) + counter-trend sweep`);
  } else {
    reasons.push(`B/Sweep ${sB.toFixed(1)} (sweepConf ${sweepConfidence}, liqNorm ${liqNorm.toFixed(0)}, absorption ${absorption.toFixed(0)})`);
  }

  // ── Scenario C: Divergence ──
  const slopeRatio = slopeRatioScore(input.slopeSpot, input.slopeFutures);
  const sC = calculateScenarioC({
    slopeSpot: input.slopeSpot,
    slopeFutures: input.slopeFutures,
    takerSpotNorm: input.takerSpotNorm,
    multiTfAlign: input.multiTfAlign,
  });
  reasons.push(
    `C/Divergence ${sC.toFixed(1)} (slopeRatio ${slopeRatio.toFixed(0)}, takerSpot ${clamp100(input.takerSpotNorm).toFixed(0)}, multiTF ${clamp100(input.multiTfAlign).toFixed(0)})`,
  );

  // ── Composite ──
  const scenarioScores = { squeeze: sA, sweep: sB, divergence: sC };
  const activeCount = [sA, sB, sC].filter((s) => s >= ACTIVE_SUBSCORE_MIN).length;
  const confluenceBonus = activeCount >= 2 ? CONFLUENCE_BONUS : 0;
  const best = Math.max(sA, sB, sC);
  const finalScore = Math.min(100, best + confluenceBonus);

  const dominantScenario: SmartMoneyScenario =
    best <= 0 ? "NONE" : best === sA ? "SQUEEZE" : best === sB ? "SWEEP" : "DIVERGENCE";

  let decision: SmartMoneyDecision;
  if (finalScore < SM_WATCH_MIN_SCORE) decision = "TRAD_NO_TRADE";
  else if (finalScore < SM_TRADE_MIN_SCORE) decision = "TRAD_WATCH";
  else decision = "TRAD_TRADE";

  reasons.push(
    `Composite: max ${best.toFixed(1)} + confluence ${confluenceBonus} (active ${activeCount}) = ${finalScore.toFixed(1)} -> ${decision}`,
  );

  return { decision, finalScore, scenarioScores, activeCount, confluenceBonus, dominantScenario, regimeFilterApplied, reasons };
}
