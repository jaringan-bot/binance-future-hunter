// detectLiquiditySweep -- pure function, TIDAK fetch dari Binance sendiri.
// Semua data (candle, CVD dua window, OI velocity, liquidation) diinjeksi
// caller (whalescope_detect_liquidity_sweep, src/tools/liquiditySweep.ts),
// pola yang sama dengan computeCvdDivergence / computeOiVelocity /
// estimateStopLossLiquidityRisk.
//
// Model: "Liquidity Sweep / Mean Reversion Pasca-Stop Run". Candle aktif
// (C_0 = candle terakhir array) menembus swing high/low yang dibentuk candle
// SEBELUMNYA (computeIsolatedSwingLevels, mengecualikan C_0), lalu harga
// ditutup KEMBALI di dalam range -- pola stop-run yang khas dibalik oleh
// smart money. Konfirmasi dari 3 sumber independen:
//   1. CVD absorption   -- harga bikin extreme baru TAPI net taker delta tidak
//   2. OI flush          -- OI velocity negatif atau maxStepDelta melonjak
//   3. liquidation cluster -- forced-liquidation dominan di sisi yang "diburu"
// Fault-tolerant: verdict tetap valid tanpa data liquidation (banyak pair /
// window: /fapi/v1/allForceOrders kosong atau di-rate-limit Binance).
import { computeIsolatedSwingLevels, type KlineCandle, type CvdSummary } from "../toolHelpers.js";
import type { OiVelocityResult } from "./oiVelocity.js";

const HOUR_MS = 3_600_000;

// Default multiplier budget penetrasi: seberapa jauh (dalam kelipatan ATR14)
// wick boleh menembus swing level dan masih dihitung "sweep" (bukan breakout
// beneran). 1.5 = spec advisor; belum di-backtest ke pair spesifik.
export const DEFAULT_ATR_SWEEP_MULT = 1.5;
// maxStepDelta dianggap "melonjak" kalau > pergerakan OI NET sepanjang window
// dikali ini -- nangkep spike-lalu-reversal (slope net ~0 tapi jelas bukan
// datar), semangat yang sama dengan komentar maxStepDelta di oiVelocity.ts.
export const DEFAULT_OI_SPIKE_MULT = 2.0;

export interface LiquidationLite {
  side: string; // "BUY" | "SELL" (case-insensitive)
  price: number;
  notionalUsd: number;
}

export interface LiquiditySweepInput {
  /** Candle ascending (index 0 = tertua). Candle TERAKHIR = C_0 (aktif). */
  candles: KlineCandle[];
  lookbackBars: number;
  /** Berapa candle tail yang dikecualikan dari swing range. Default 1 (C_0). */
  excludeLast?: number;
  atr14: number;
  atrSweepMult?: number;
  /** CVD taker window candle aktif (C_0). */
  activeCvd: CvdSummary;
  /** CVD taker window pembanding tepat sebelum C_0 (mis. candle C_-1). */
  priorCvd: CvdSummary;
  /** Hasil computeOiVelocity, atau null kalau fetch OI gagal. */
  oiVelocity: OiVelocityResult | null;
  oiSpikeMult?: number;
  /** Force orders sekitar zona sweep, atau null/[] kalau feed gagal/kosong. */
  liquidations: LiquidationLite[] | null;
}

export type SweepSide = "SELL_SIDE" | "BUY_SIDE" | "NONE";

export interface LiquiditySweepResult {
  isLiquiditySweep: boolean;
  side: SweepSide;
  direction: "LONG" | "SHORT" | null;
  confidence: number; // 0..1
  geometry: {
    hRange: number;
    lRange: number;
    activeHigh: number;
    activeLow: number;
    activeClose: number;
    penetration: number; // satuan harga, seberapa jauh melewati level (0 kalau tidak menembus)
    penetrationAtr: number; // penetration / atr14 (0 kalau atr14 <= 0)
    withinAtrBudget: boolean;
    reclaimed: boolean;
  };
  orderFlow: {
    priceExtreme: boolean; // C_0 bikin lower-low (sell-side) / higher-high (buy-side)
    cvdExtreme: boolean; // CVD ikut bikin extreme baru (= TIDAK ada absorption)
    cvdAbsorption: boolean;
    activeCvd: number;
    priorCvd: number;
  };
  openInterest: {
    available: boolean;
    velocityPerHour: number | null;
    maxStepDelta: number | null;
    flushDetected: boolean;
  };
  liquidations: {
    available: boolean;
    count: number;
    dominantSide: "BUY" | "SELL" | null;
    clusterConfirms: boolean;
  };
  confirmations: string[];
  dataGaps: string[];
  reasons: string[];
}

function emptyResult(reason: string): LiquiditySweepResult {
  return {
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
    reasons: [reason],
  };
}

function assessOiFlush(oi: OiVelocityResult, spikeMult: number): boolean {
  if (oi.oiVelocityPerHour < 0) return true;
  const windowHours = (oi.windowEndMs - oi.windowStartMs) / HOUR_MS;
  const netAbsMove = Math.abs(oi.oiVelocityPerHour) * (windowHours > 0 ? windowHours : 0);
  if (netAbsMove === 0) return oi.maxStepDelta > 0;
  return oi.maxStepDelta > netAbsMove * spikeMult;
}

function dominantLiquidationSide(liqs: LiquidationLite[]): "BUY" | "SELL" | null {
  let buy = 0;
  let sell = 0;
  for (const l of liqs) {
    const notional = Number.isFinite(l.notionalUsd) ? l.notionalUsd : 0;
    if (String(l.side).toUpperCase() === "SELL") sell += notional;
    else if (String(l.side).toUpperCase() === "BUY") buy += notional;
  }
  if (buy === 0 && sell === 0) return null;
  return sell >= buy ? "SELL" : "BUY";
}

export function detectLiquiditySweep(input: LiquiditySweepInput): LiquiditySweepResult {
  const excludeLast = input.excludeLast ?? 1;
  const atrSweepMult = input.atrSweepMult ?? DEFAULT_ATR_SWEEP_MULT;
  const oiSpikeMult = input.oiSpikeMult ?? DEFAULT_OI_SPIKE_MULT;

  // Butuh minimal 1 candle historis + 1 candle aktif.
  if (input.candles.length < excludeLast + 2) {
    return emptyResult(
      `Candle tidak cukup: butuh minimal ${excludeLast + 2}, dapat ${input.candles.length}.`,
    );
  }

  const active = input.candles[input.candles.length - 1];
  const { hRange, lRange } = computeIsolatedSwingLevels(input.candles, input.lookbackBars, excludeLast);
  if (hRange === 0 && lRange === 0) {
    return emptyResult("Window swing terisolasi kosong -- lookbackBars/excludeLast melebihi jumlah candle historis.");
  }

  const atr14 = input.atr14 > 0 ? input.atr14 : 0;
  const budget = atr14 * atrSweepMult;
  const dataGaps: string[] = [];
  if (atr14 === 0) dataGaps.push("ATR14 <= 0 -- budget penetrasi tidak bisa dievaluasi, geometri sweep ditolak.");

  // ── Sisi SELL (stop-run ke bawah, hunt LONG) ──
  const sweptLow = active.low < lRange;
  const penLow = sweptLow ? lRange - active.low : 0;
  const reclaimLow = active.close > lRange;
  const withinBudgetLow = atr14 > 0 && penLow <= budget;
  const sellSideSweep = sweptLow && withinBudgetLow && reclaimLow;

  // ── Sisi BUY (stop-run ke atas, hunt SHORT) ──
  const sweptHigh = active.high > hRange;
  const penHigh = sweptHigh ? active.high - hRange : 0;
  const reclaimHigh = active.close < hRange;
  const withinBudgetHigh = atr14 > 0 && penHigh <= budget;
  const buySideSweep = sweptHigh && withinBudgetHigh && reclaimHigh;

  let side: SweepSide = "NONE";
  if (sellSideSweep && buySideSweep) {
    side = penLow >= penHigh ? "SELL_SIDE" : "BUY_SIDE";
  } else if (sellSideSweep) {
    side = "SELL_SIDE";
  } else if (buySideSweep) {
    side = "BUY_SIDE";
  }

  const isSell = side === "SELL_SIDE";
  const isBuy = side === "BUY_SIDE";
  const direction = isSell ? "LONG" : isBuy ? "SHORT" : null;

  // Geometri yang dilaporkan mengikuti sisi terpilih; kalau NONE, laporkan
  // sisi yang MENEMBUS (kalau ada) supaya advisor tetap lihat konteksnya.
  const reportSweptLow = isSell || (side === "NONE" && sweptLow && !sweptHigh);
  const penetration = reportSweptLow ? penLow : isBuy || (side === "NONE" && sweptHigh) ? penHigh : 0;
  const penetrationAtr = atr14 > 0 ? penetration / atr14 : 0;
  const withinAtrBudget = reportSweptLow ? withinBudgetLow : isBuy || (side === "NONE" && sweptHigh) ? withinBudgetHigh : false;
  const reclaimed = reportSweptLow ? reclaimLow : isBuy || (side === "NONE" && sweptHigh) ? reclaimHigh : false;

  // ── Order flow: Price-vs-CVD divergence (absorption) ──
  const activeNet = input.activeCvd.cvd;
  const priorNet = input.priorCvd.cvd;
  const cvdDataPresent = input.activeCvd.totalVolume > 0 && input.priorCvd.totalVolume > 0;
  if (!cvdDataPresent) {
    dataGaps.push("CVD dua window kosong (aggTrades gagal/tidak ada) -- absorption tidak bisa dinilai.");
  }
  let priceExtreme = false;
  let cvdExtreme = false;
  if (isSell || reportSweptLow) {
    priceExtreme = sweptLow;
    cvdExtreme = activeNet < priorNet; // net taker delta lebih negatif dari window pembanding
  } else if (isBuy || (side === "NONE" && sweptHigh)) {
    priceExtreme = sweptHigh;
    cvdExtreme = activeNet > priorNet;
  }
  const cvdAbsorption = cvdDataPresent && priceExtreme && !cvdExtreme;

  // ── Open Interest ──
  const oiAvailable = input.oiVelocity != null && !input.oiVelocity.errorCode;
  const flushDetected = oiAvailable ? assessOiFlush(input.oiVelocity as OiVelocityResult, oiSpikeMult) : false;
  if (!oiAvailable) dataGaps.push("OI velocity tidak tersedia -- verdict bersandar pada CVD absorption + liquidation.");

  // ── Liquidations ──
  const liqs = input.liquidations ?? [];
  const liqAvailable = liqs.length > 0;
  const domSide = liqAvailable ? dominantLiquidationSide(liqs) : null;
  const expectedLiqSide = isSell ? "SELL" : isBuy ? "BUY" : null;
  const clusterConfirms = liqAvailable && expectedLiqSide != null && domSide === expectedLiqSide;
  if (!liqAvailable) {
    dataGaps.push("Data liquidation (allForceOrders) kosong/gagal -- verdict berbasis OI velocity + CVD absorption saja.");
  }

  // ── Verdict ──
  const geometryPass = sellSideSweep || buySideSweep;
  const confirmations: string[] = [];
  if (cvdAbsorption) confirmations.push("CVD absorption (harga extreme tanpa CVD extreme)");
  if (flushDetected) confirmations.push("OI flush (velocity negatif / maxStepDelta melonjak)");
  if (clusterConfirms) confirmations.push(`Liquidation cluster ${domSide} dominan di sisi yang diburu`);

  const isLiquiditySweep = geometryPass && confirmations.length >= 1;

  let confidence = 0;
  if (geometryPass) {
    confidence = 0.4 + (cvdAbsorption ? 0.2 : 0) + (flushDetected ? 0.2 : 0) + (clusterConfirms ? 0.2 : 0);
    confidence = Math.round(Math.min(1, confidence) * 100) / 100;
  }
  if (!isLiquiditySweep) confidence = 0;

  const reasons: string[] = [];
  if (!geometryPass) {
    if (!sweptLow && !sweptHigh) reasons.push("Candle aktif tidak menembus swing high/low terisolasi -- bukan sweep.");
    else if ((sweptLow && !reclaimLow) || (sweptHigh && !reclaimHigh))
      reasons.push("Level tertembus tapi harga TIDAK ditutup kembali di dalam range (reclaim gagal) -- lebih mirip breakout.");
    else reasons.push(`Penetrasi ${penetrationAtr.toFixed(2)} ATR melebihi budget ${atrSweepMult} ATR -- breakout, bukan sweep.`);
  } else {
    reasons.push(
      `${side === "SELL_SIDE" ? "Sell-side" : "Buy-side"} sweep: penetrasi ${penetrationAtr.toFixed(2)} ATR lalu reclaim ke dalam range.`,
    );
    if (confirmations.length === 0) reasons.push("Geometri lolos tapi TIDAK ada konfirmasi order flow / OI / liquidation.");
    else reasons.push(...confirmations);
  }

  return {
    isLiquiditySweep,
    side,
    direction,
    confidence,
    geometry: {
      hRange,
      lRange,
      activeHigh: active.high,
      activeLow: active.low,
      activeClose: active.close,
      penetration,
      penetrationAtr,
      withinAtrBudget,
      reclaimed,
    },
    orderFlow: {
      priceExtreme,
      cvdExtreme,
      cvdAbsorption,
      activeCvd: activeNet,
      priorCvd: priorNet,
    },
    openInterest: {
      available: oiAvailable,
      velocityPerHour: oiAvailable ? (input.oiVelocity as OiVelocityResult).oiVelocityPerHour : null,
      maxStepDelta: oiAvailable ? (input.oiVelocity as OiVelocityResult).maxStepDelta : null,
      flushDetected,
    },
    liquidations: {
      available: liqAvailable,
      count: liqs.length,
      dominantSide: domSide,
      clusterConfirms,
    },
    confirmations,
    dataGaps,
    reasons,
  };
}
