// evaluateTraditionalFuturesEntry -- pure "head" untuk sinyal Traditional
// Futures (Single Entry / Single SL / Single TP + R:R). Menerima data yang
// SUDAH di-fetch di Wave 1 & Wave 2 (fullPipeline / tool liquiditySweep) --
// NOL subrequest baru ke Binance relay.
//
// Alur:
//   1. computeIsolatedSwingLevels(candles) -> hRange / lRange (kecualikan C_0)
//   2. detectLiquiditySweep(...)           -> sweepResult
//   3. calculateTraditionalBracket(...)    -> bracket (Entry/SL/TP/RR/leverage)
//   4. Downgrade TRAD_TRADE -> TRAD_WATCH kalau konviksi lemah:
//        - MEAN_REVERSION: ADX14 > 25 (fade sweep di pasar trending = riskan)
//        - TREND_BREAKOUT: rec. leverage < 3 (SL terlalu lebar, sizing tidak layak)
//
// Semua threshold di sini heuristik, BELUM di-backtest.
import { computeIsolatedSwingLevels, type KlineCandle, type CvdSummary } from "../toolHelpers.js";
import type { OiVelocityResult } from "../tools/oiVelocity.js";
import { detectLiquiditySweep, type LiquiditySweepResult, type LiquidationLite } from "../tools/liquiditySweepEngine.js";
import {
  calculateTraditionalBracket,
  BREAKOUT_TP_R_MULT,
  type TraditionalBracket,
  type TradScenario,
} from "../tools/traditionalFuturesEngine.js";
import type { MarketRegime } from "../tools/marketRegime.js";
import type { PriceBias } from "../toolHelpers.js";

// ADX di atas ini -> fade-sweep (mean reversion) cuma layak WATCH, tidak TRADE.
export const MEAN_REVERSION_MAX_ADX_FOR_TRADE = 25;
// Rec. leverage di bawah ini -> breakout cuma layak WATCH (SL kelewat lebar).
export const BREAKOUT_MIN_LEVERAGE_FOR_TRADE = 3;

export interface TraditionalWave1 {
  activePrice: number;
  candles: KlineCandle[]; // klines 1h Wave 1 (ascending, terakhir = C_0)
  atr14: number;
  adx14: number;
  regime: MarketRegime;
  bias: PriceBias;
  activeCvd: CvdSummary; // CVD taker window C_0 (dari aggTrades Wave 1)
  priorCvd: CvdSummary; // CVD taker window C_-1
  oiVelocity: OiVelocityResult | null; // dari OI history Wave 1/2
  lookbackBars: number;
}

export interface TraditionalWave2 {
  liquidations: LiquidationLite[] | null; // force orders Wave 2, null kalau tidak/ gagal di-fetch
}

export type TraditionalDecision = "TRAD_TRADE" | "TRAD_WATCH" | "TRAD_NO_TRADE";

export interface TraditionalFuturesResult {
  decision: TraditionalDecision;
  scenario: TradScenario;
  side: "LONG" | "SHORT" | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  takeProfit2: number | null;
  rr: number;
  slPct: number;
  recommendedLeverage: number;
  confidence: number; // 0..1 -- sweep confidence (A) atau turunan ADX (B)
  bracket: TraditionalBracket;
  sweep: LiquiditySweepResult;
  reasons: string[];
  dataGaps: string[];
}

function breakoutConfidence(adx14: number): number {
  return Math.max(0, Math.min(1, 0.5 + (adx14 - 25) / 50));
}

function noTradeResult(
  bracket: TraditionalBracket,
  sweep: LiquiditySweepResult,
  reasons: string[],
  dataGaps: string[],
): TraditionalFuturesResult {
  return {
    decision: "TRAD_NO_TRADE",
    scenario: bracket.scenario,
    side: bracket.side,
    entry: bracket.entry,
    stopLoss: bracket.stopLoss,
    takeProfit: bracket.takeProfit,
    takeProfit2: bracket.takeProfit2,
    rr: bracket.rr,
    slPct: bracket.slPct,
    recommendedLeverage: bracket.recommendedLeverage,
    confidence: 0,
    bracket,
    sweep,
    reasons,
    dataGaps,
  };
}

const EMPTY_SWEEP: LiquiditySweepResult = {
  isLiquiditySweep: false,
  side: "NONE",
  direction: null,
  confidence: 0,
  geometry: {
    hRange: 0,
    lRange: 0,
    activeHigh: 0,
    activeLow: 0,
    activeClose: 0,
    penetration: 0,
    penetrationAtr: 0,
    withinAtrBudget: false,
    reclaimed: false,
  },
  orderFlow: { priceExtreme: false, cvdExtreme: false, cvdAbsorption: false, activeCvd: 0, priorCvd: 0 },
  openInterest: { available: false, velocityPerHour: null, maxStepDelta: null, flushDetected: false },
  liquidations: { available: false, count: 0, dominantSide: null, clusterConfirms: false },
  confirmations: [],
  dataGaps: [],
  reasons: [],
};

const EMPTY_BRACKET: TraditionalBracket = {
  decision: "TRAD_NO_TRADE",
  scenario: "NONE",
  side: null,
  entry: null,
  stopLoss: null,
  takeProfit: null,
  takeProfit2: null,
  rr: 0,
  slPct: 0,
  recommendedLeverage: 0,
  reasons: [],
};

// Stub TRAD_NO_TRADE untuk jalur yang tidak mengevaluasi Traditional Futures
// (hard-screen gagal, pipeline error) -- caller memperlakukannya sama seperti
// grid NO_TRADE. Tidak menyentuh engine bracket murni.
export function stubTraditionalResult(reason: string): TraditionalFuturesResult {
  return noTradeResult(EMPTY_BRACKET, EMPTY_SWEEP, [reason], []);
}

export function evaluateTraditionalFuturesEntry(
  wave1: TraditionalWave1,
  wave2: TraditionalWave2,
): TraditionalFuturesResult {
  const excludeLast = 1;
  if (wave1.candles.length < wave1.lookbackBars + excludeLast + 1 || wave1.candles.length < 3) {
    return noTradeResult(
      EMPTY_BRACKET,
      EMPTY_SWEEP,
      [`Candle tidak cukup: butuh minimal ${Math.max(wave1.lookbackBars + 2, 3)}, dapat ${wave1.candles.length}.`],
      [],
    );
  }

  const { hRange, lRange } = computeIsolatedSwingLevels(wave1.candles, wave1.lookbackBars, excludeLast);
  const priorCandle = wave1.candles[wave1.candles.length - 2];

  const sweep = detectLiquiditySweep({
    candles: wave1.candles,
    lookbackBars: wave1.lookbackBars,
    excludeLast,
    atr14: wave1.atr14,
    activeCvd: wave1.activeCvd,
    priorCvd: wave1.priorCvd,
    oiVelocity: wave1.oiVelocity,
    liquidations: wave2.liquidations,
  });

  const bracket = calculateTraditionalBracket({
    activePrice: wave1.activePrice,
    atr14: wave1.atr14,
    sweepResult: sweep,
    adx14: wave1.adx14,
    regime: wave1.regime,
    bias: wave1.bias,
    hRange,
    lRange,
    priorSwingHigh: priorCandle.high,
    priorSwingLow: priorCandle.low,
  });

  const dataGaps = [...sweep.dataGaps];

  if (bracket.decision === "TRAD_NO_TRADE") {
    return noTradeResult(bracket, sweep, bracket.reasons, dataGaps);
  }

  // bracket.decision === "TRAD_TRADE" -- tentukan TRADE vs WATCH.
  let decision: TraditionalDecision = "TRAD_TRADE";
  const reasons = [...bracket.reasons];
  let confidence: number;

  if (bracket.scenario === "MEAN_REVERSION") {
    confidence = sweep.confidence;
    if (wave1.adx14 > MEAN_REVERSION_MAX_ADX_FOR_TRADE) {
      decision = "TRAD_WATCH";
      reasons.push(
        `ADX14 ${wave1.adx14.toFixed(1)} > ${MEAN_REVERSION_MAX_ADX_FOR_TRADE} -- fade sweep di pasar trending, turunkan ke WATCH.`,
      );
    }
  } else {
    // TREND_BREAKOUT
    confidence = breakoutConfidence(wave1.adx14);
    if (bracket.recommendedLeverage < BREAKOUT_MIN_LEVERAGE_FOR_TRADE || bracket.rr < BREAKOUT_TP_R_MULT) {
      decision = "TRAD_WATCH";
      reasons.push(
        `Rec. leverage ${bracket.recommendedLeverage}x < ${BREAKOUT_MIN_LEVERAGE_FOR_TRADE} atau RR ${bracket.rr.toFixed(2)} < ${BREAKOUT_TP_R_MULT} -- turunkan ke WATCH.`,
      );
    }
  }

  return {
    decision,
    scenario: bracket.scenario,
    side: bracket.side,
    entry: bracket.entry,
    stopLoss: bracket.stopLoss,
    takeProfit: bracket.takeProfit,
    takeProfit2: bracket.takeProfit2,
    rr: bracket.rr,
    slPct: bracket.slPct,
    recommendedLeverage: bracket.recommendedLeverage,
    confidence,
    bracket,
    sweep,
    reasons,
    dataGaps,
  };
}
