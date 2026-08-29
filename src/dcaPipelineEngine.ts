// Server-side Futures DCA decision + parameter engine -- pure, no fetch, no
// binanceProxyClient import (pola sama dengan pipelineEngine.ts). Dipakai
// oleh evaluateDca() di src/tools/fullPipeline.ts, yang me-map data Wave-1 +
// Wave-2 yang SUDAH di-fetch untuk grid (SharedSymbolIntel) ke DcaEngineInput
// -- jadi head DCA menambah ~0 subrequest Binance (cuma butuh 1 fetch baru:
// klines 1d, dipakai bareng grid).
//
// Formula porting dari skill whalescope-dca-screening / whalescope-dca-entry
// SKILL.md, PROFIL **MODERATE** (default skill). Divergensi terdokumentasi di
// bawah + di docs/full_pipeline_framework.md -- semua dalam batas "targeted
// fixes only / nol call Binance tambahan".
//
// LONG DCA ONLY / SHORT DCA ONLY -- Neutral DCA dilarang (sama seperti skill).

import type { MarketRegime } from "./tools/marketRegime.js";
import type { MarketStructureCondition } from "./smartMoneyAnalysis.js";
import { classifyVolatilityTier, effectiveGate, type VolatilityTier } from "./volatilityTier.js";

// ── Konstanta profil MODERATE (verbatim dari SKILL.md) ───────────────────
export const DCA_THRESHOLD_ENTRY = 70; // "Skor Akhir >= 70"
export const DCA_HARD_NEUTRAL_CAP = 67; // "max Confidence = 67"
export const DCA_MAX_ROUNDS = 4; // Moderate
export const DCA_MAX_LOSS_USD = 20; // "<= $20"
export const DCA_LEV_MIN = 5;
export const DCA_LEV_MAX = 7; // Moderate "5x-7x"
export const DCA_BASE_GATE_ADX4H = 30; // Base Tier-1 Moderate
export const DCA_BASE_CAP_ADX1D = 35; // Base Tier-1 Moderate
export const DCA_DEAD_MARKET_ADX4H = 12; // flat, TIDAK di-scale per tier
export const DCA_FUNDING_NEUTRAL_ABS = 0.0001; // "|rate| <= 0.01%"
export const DCA_FUNDING_HARD_DROP = 0.0003; // "|rate| > 0.03%" -> reject
export const DCA_LIQ_GATE_USD = 8_000_000;
export const DCA_WATCH_MIN_ALERT_SCORE = 50; // analog grid WATCH_MIN_ALERT_SCORE=40, lebih ketat (multi-order)
export const DCA_MODAL_DEFAULT_USD = 200; // config default -- alert tidak punya saldo akun riil

export type DcaDecision = "DCA_TRADE" | "DCA_WATCH" | "DCA_NO_TRADE";
export type DcaDirection = "LONG" | "SHORT";

export interface DcaEngineInput {
  symbol: string;
  currentPrice: number;
  quoteVolumeUsd: number;
  fundingRate: number; // decimal, signed
  adx4h: number;
  adx1d: number | null; // null kalau fetch klines 1d gagal
  regime1d: MarketRegime | null;
  rvAnnualizedPct: number;
  atr1h: number; // absolut (satuan harga)
  atr4h: number;
  smartMoneyCondition: MarketStructureCondition;
  smartMoneyBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** confidence 0-100 SETELAH diskon early-exhaustion (dari fullPipeline). */
  effectiveSmartMoneyConfidence: number;
  oiVelocityPerHour: number;
  oiDelta4hPct: number;
  oiEarlyExhaustionWarning: boolean;
  cvdBuyPct: number; // 0-100
  obiDepth10: number; // bid % of depth-10, 0-100
  spoofingScore: number; // 0-1
  swingHigh4h: number;
  swingLow4h: number;
  modalAvailableUsd: number;
}

export interface DcaBotConfigSection {
  direction: DcaDirection;
  priceDropStepPct: number; // Base Deviation
  priceDeviationMultiplier: number; // "melebar" tiap ronde
  dcaOrderSizeMultiplier: number;
  maxDcaOrders: number;
  takeProfitPerRoundPct: number;
  leverage: number;
  baseOrderMarginUsd: number;
  dcaOrderMarginUsd: number;
  stopLossPrice: number;
  stopLossPct: number;
  estLiquidationPrice: number;
  projectedMaxLossUsd: number;
  totalAccumulationDistPct: number; // current -> max DCA level
  modalRefUsd: number;
  marginModeCaveat: string;
}

export interface DcaHeadResult {
  symbol: string;
  decision: DcaDecision;
  direction: DcaDirection | null;
  confidence: number;
  volTier: VolatilityTier;
  effGateAdx4h: number;
  effCapAdx1d: number;
  rejectReason: string | null;
  dcaBotConfig?: DcaBotConfigSection;
  reasoning: string[];
}

const MARGIN_MODE_CAVEAT =
  "Perhitungan likuidasi/max-loss APPROXIMATE ala isolated margin, terlepas dari mode margin sebenarnya " +
  "(lihat MARGIN_MODE_CAVEAT grid di fullPipeline.ts / docs).";

const PRICE_DEV_MULTIPLIER = 1.15; // skill "1.1-1.2 (melebar)"
const DCA_STEP_MULTIPLIERS = [1, 2.0, 3.25, 4.5]; // dalam rentang skill x1.8-2.2 / x3.0-3.5
const TP_PER_ROUND_PCT = 1.25; // skill "1.0-1.5%"
const BASE_DEV_K = 0.6; // baseDevPct = clamp(atr1hPct * K, 1.0, 1.5)

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// ── Direction dari Smart Money condition ─────────────────────────────────
function directionFor(condition: MarketStructureCondition): DcaDirection | null {
  if (condition === "LONG_LIQUIDATION_RISK") return "SHORT";
  if (condition === "BULLISH_ACCUMULATION" || condition === "SHORT_SQUEEZE_RISK") return "LONG";
  return null; // NEUTRAL -> caller pakai bias buat display
}

// ── Scoring: Entry Matrix 35/15/15/20/15 ────────────────────────────────
function scoreEntry(
  input: DcaEngineInput,
  direction: DcaDirection,
  isNeutral: boolean,
  effGate: number,
  effCap: number,
  notes: string[],
): number {
  let score = 0;

  // 1. Smart Money Condition (35)
  if (isNeutral) {
    score += 14;
    notes.push("SM Condition: NEUTRAL -> 14 (capped)");
  } else if (input.effectiveSmartMoneyConfidence >= 50) {
    score += 35;
    notes.push(`SM Condition: ${input.smartMoneyCondition} aligned, conf ${input.effectiveSmartMoneyConfidence.toFixed(0)} -> 35`);
  } else {
    score += 21;
    notes.push(`SM Condition: ${input.smartMoneyCondition} aligned tapi conf ${input.effectiveSmartMoneyConfidence.toFixed(0)} < 50 -> 21 (moderate)`);
  }

  // 2. Capital Flow Trio (15): OI + Funding + Taker
  const oiRising = input.oiVelocityPerHour > 0 || input.oiDelta4hPct > 0;
  const fundingFav =
    Math.abs(input.fundingRate) <= DCA_FUNDING_NEUTRAL_ABS ||
    (direction === "LONG" && input.fundingRate < 0) ||
    (direction === "SHORT" && input.fundingRate > 0);
  const takerMatch = direction === "LONG" ? input.cvdBuyPct > 55 : input.cvdBuyPct < 45;
  const coherent = [oiRising, fundingFav, takerMatch].filter(Boolean).length;
  let trio = coherent === 3 ? 15 : coherent === 2 ? 9 : coherent === 1 ? 5 : 2;
  if (input.oiEarlyExhaustionWarning) {
    trio = trio === 15 ? 9 : trio === 9 ? 5 : trio === 5 ? 2 : 2;
    notes.push("Capital Flow Trio: OI early-exhaustion -> drop 1 tier");
  }
  score += trio;
  notes.push(`Capital Flow Trio: ${coherent}/3 coherent (OI ${oiRising}, funding ${fundingFav}, taker ${takerMatch}) -> ${trio}`);

  // 3. Liquidity & Depth (15) -- proxy (no wall-persistence data)
  const obiFav = direction === "LONG" ? input.obiDepth10 >= 52 : input.obiDepth10 <= 48;
  let liq: number;
  if (input.quoteVolumeUsd >= 15_000_000 && obiFav && input.spoofingScore < 0.6) liq = 15;
  else if (input.quoteVolumeUsd >= 15_000_000) liq = 8;
  else liq = 2;
  score += liq;
  notes.push(`Liquidity & Depth (proxy): vol $${(input.quoteVolumeUsd / 1e6).toFixed(0)}M, OBI10 ${input.obiDepth10.toFixed(0)}, spoof ${input.spoofingScore.toFixed(2)} -> ${liq}`);

  // 4. Regime Fit -- mean reversion (20)
  const compressionUpper = 12 + (effGate - 12) / 3;
  const macroOk = input.adx1d == null || input.adx1d <= effCap;
  let regimeFit: number;
  if (input.adx4h >= 12 && input.adx4h <= compressionUpper && macroOk) regimeFit = 20;
  else if (input.adx4h > compressionUpper && input.adx4h <= effGate) regimeFit = 13;
  else if (input.adx4h >= 12 && input.adx4h <= effGate) regimeFit = 7;
  else regimeFit = 0;
  score += regimeFit;
  notes.push(`Regime Fit: ADX4H ${input.adx4h.toFixed(1)} vs [12, ${compressionUpper.toFixed(1)}] gate ${effGate} -> ${regimeFit}`);

  // 5. Structure & Accumulation Space (15)
  const swingRange = input.swingHigh4h - input.swingLow4h;
  const hasSwing = Number.isFinite(swingRange) && swingRange > 0;
  // estimasi jarak akumulasi total (current -> max DCA level) pakai step math bawah
  const atr1hPct = (input.atr1h / input.currentPrice) * 100;
  const baseDevPct = clamp(round2(atr1hPct * BASE_DEV_K), 1.0, 1.5);
  const totalAccumDistPct = DCA_STEP_MULTIPLIERS.slice(0, DCA_MAX_ROUNDS).reduce((s, m) => s + baseDevPct * m, 0);
  const distInBand = totalAccumDistPct >= 6 && totalAccumDistPct <= 12;
  const corroborated = input.oiVelocityPerHour > 0 && (direction === "LONG" ? input.cvdBuyPct >= 50 : input.cvdBuyPct <= 50);
  let structure: number;
  if (hasSwing && distInBand && corroborated) structure = 15;
  else if (hasSwing && distInBand) structure = 7;
  else structure = 0;
  score += structure;
  notes.push(`Structure & Space: swing ${hasSwing}, accumDist ${totalAccumDistPct.toFixed(1)}% (band 6-12), corroborated ${corroborated} -> ${structure}`);

  return score;
}

// ── Parameter math (hanya saat DCA_TRADE) ───────────────────────────────
function computeDcaParams(input: DcaEngineInput, direction: DcaDirection, effGate: number): DcaBotConfigSection | null {
  const sign = direction === "LONG" ? -1 : 1; // arah akumulasi (LONG: harga turun)
  const atr1hPct = (input.atr1h / input.currentPrice) * 100;
  const baseDevPct = clamp(round2(atr1hPct * BASE_DEV_K), 1.0, 1.5);

  let mults = DCA_STEP_MULTIPLIERS.slice(0, DCA_MAX_ROUNDS);
  let steps = mults.map((m) => baseDevPct * m);
  let totalAccumDistPct = steps.reduce((s, v) => s + v, 0);
  // kalau kelewat lebar (> 12%), kurangi ronde sampai masuk band
  while (totalAccumDistPct > 12 && mults.length > 1) {
    mults = mults.slice(0, mults.length - 1);
    steps = mults.map((m) => baseDevPct * m);
    totalAccumDistPct = steps.reduce((s, v) => s + v, 0);
  }
  const maxRounds = mults.length;
  const maxDcaLevelPrice = input.currentPrice * (1 + sign * (totalAccumDistPct / 100));

  const atr4hSlPct = (1.5 * input.atr4h) / input.currentPrice * 100;
  let slPct = clamp(Math.max(atr4hSlPct, 6), 6, 9);
  slPct = Math.max(slPct, totalAccumDistPct + 1); // paksa di luar level DCA terakhir
  const slPrice = input.currentPrice * (1 + sign * (slPct / 100));

  const compressionUpper = 12 + (effGate - 12) / 3;
  let leverage = input.adx4h <= compressionUpper ? DCA_LEV_MAX : DCA_LEV_MIN;

  const modal = input.modalAvailableUsd > 0 ? input.modalAvailableUsd : DCA_MODAL_DEFAULT_USD;
  const totalMarginBudget = 0.3 * modal;
  let baseOrderMargin = totalMarginBudget / (1 + maxRounds);

  // Max-loss guard: proyeksi rugi di SL untuk FULL exposure (isolated approx).
  // Exposure notional ~ (base + dca*maxRounds) * leverage. Semua order size
  // flat (DCA_ORDER_SIZE_MULT 1.0). blendedEntry ~ tengah current..maxDcaLevel.
  function project(bom: number): { notional: number; projLoss: number; blendedEntry: number } {
    const totalMargin = bom * (1 + maxRounds);
    const notional = totalMargin * leverage;
    const blendedEntry = (input.currentPrice + maxDcaLevelPrice) / 2;
    const distToSlPct = Math.abs(blendedEntry - slPrice) / blendedEntry;
    const projLoss = notional * distToSlPct;
    return { notional, projLoss, blendedEntry };
  }
  let p = project(baseOrderMargin);
  if (p.projLoss > DCA_MAX_LOSS_USD) {
    baseOrderMargin *= DCA_MAX_LOSS_USD / p.projLoss;
    p = project(baseOrderMargin);
  }
  // masih infeasible di sizing minimum wajar -> caller downgrade ke WATCH
  if (baseOrderMargin < 1 || p.projLoss > DCA_MAX_LOSS_USD * 1.05) return null;

  const estLiqPrice = p.blendedEntry * (1 + sign * (1 / leverage));

  return {
    direction,
    priceDropStepPct: round2(baseDevPct),
    priceDeviationMultiplier: PRICE_DEV_MULTIPLIER,
    dcaOrderSizeMultiplier: 1.0,
    maxDcaOrders: maxRounds,
    takeProfitPerRoundPct: TP_PER_ROUND_PCT,
    leverage,
    baseOrderMarginUsd: round2(baseOrderMargin),
    dcaOrderMarginUsd: round2(baseOrderMargin),
    stopLossPrice: slPrice,
    stopLossPct: round2(slPct),
    estLiquidationPrice: estLiqPrice,
    projectedMaxLossUsd: round2(p.projLoss),
    totalAccumulationDistPct: round2(totalAccumDistPct),
    modalRefUsd: modal,
    marginModeCaveat: MARGIN_MODE_CAVEAT,
  };
}

// ── Engine utama ────────────────────────────────────────────────────────
export function evaluateDcaEntry(input: DcaEngineInput): DcaHeadResult {
  const reasoning: string[] = [];
  const volTier = classifyVolatilityTier(input.rvAnnualizedPct);
  const effGateAdx4h = effectiveGate(DCA_BASE_GATE_ADX4H, volTier);
  const effCapAdx1d = effectiveGate(DCA_BASE_CAP_ADX1D, volTier);
  reasoning.push(`VolTier ${volTier} (RV ann ${input.rvAnnualizedPct.toFixed(0)}%) -> gate ${effGateAdx4h} / cap ${effCapAdx1d}`);

  const base = (reject: string): DcaHeadResult => ({
    symbol: input.symbol,
    decision: "DCA_NO_TRADE",
    direction: directionFor(input.smartMoneyCondition) ?? (input.smartMoneyBias === "BEARISH" ? "SHORT" : "LONG"),
    confidence: 0,
    volTier,
    effGateAdx4h,
    effCapAdx1d,
    rejectReason: reject,
    reasoning: [...reasoning, `REJECT: ${reject}`],
  });

  // ── Hard gates (short-circuit, urutan tetap) ──
  if (input.quoteVolumeUsd < DCA_LIQ_GATE_USD) return base(`liquidity ($${(input.quoteVolumeUsd / 1e6).toFixed(1)}M < $8M)`);
  if (input.adx4h < DCA_DEAD_MARKET_ADX4H) return base(`dead_market (ADX4H ${input.adx4h.toFixed(1)} < 12)`);
  if (input.adx4h > effGateAdx4h) return base(`strong_trend_4h (ADX4H ${input.adx4h.toFixed(1)} > gate ${effGateAdx4h})`);
  if (input.adx1d != null && input.adx1d > effCapAdx1d) return base(`macro_overextended (ADX1D ${input.adx1d.toFixed(1)} > cap ${effCapAdx1d})`);
  if (Math.abs(input.fundingRate) > DCA_FUNDING_HARD_DROP)
    return base(`funding_extreme (|${(input.fundingRate * 100).toFixed(4)}%| > 0.03%)`);

  const isNeutral = input.smartMoneyCondition === "NEUTRAL";
  let direction = directionFor(input.smartMoneyCondition);
  if (direction == null) {
    // NEUTRAL -> arah dari bias buat display; keputusan maks DCA_WATCH
    direction = input.smartMoneyBias === "BEARISH" ? "SHORT" : "LONG";
  }

  // macro trend opposing (skip kalau tidak ada data 1d)
  if (input.regime1d != null && !isNeutral) {
    const trendAgainst =
      (direction === "LONG" && input.regime1d === "TRENDING_DOWN") ||
      (direction === "SHORT" && input.regime1d === "TRENDING_UP");
    if (trendAgainst) return base(`macro_trend_opposing (1D ${input.regime1d} vs ${direction})`);
  }
  if (input.adx1d == null) reasoning.push("catatan: klines 1d tidak tersedia -- gate macro_overextended & macro_trend_opposing di-skip");

  const confidenceRaw = scoreEntry(input, direction, isNeutral, effGateAdx4h, effCapAdx1d, reasoning);
  const confidence = isNeutral ? Math.min(confidenceRaw, DCA_HARD_NEUTRAL_CAP) : confidenceRaw;
  reasoning.push(`Confidence ${confidenceRaw}${isNeutral ? ` -> ${confidence} (Hard Neutral Cap)` : ""}`);

  const common = { symbol: input.symbol, direction, confidence, volTier, effGateAdx4h, effCapAdx1d, reasoning };

  if (isNeutral) {
    // NEUTRAL tidak pernah DCA_TRADE
    return { ...common, decision: confidence >= DCA_WATCH_MIN_ALERT_SCORE ? "DCA_WATCH" : "DCA_NO_TRADE", rejectReason: "smart_money_neutral" };
  }
  if (confidence < DCA_WATCH_MIN_ALERT_SCORE) {
    return { ...common, decision: "DCA_NO_TRADE", rejectReason: `low_confidence (${confidence} < ${DCA_WATCH_MIN_ALERT_SCORE})` };
  }
  if (confidence < DCA_THRESHOLD_ENTRY) {
    return { ...common, decision: "DCA_WATCH", rejectReason: null };
  }

  // DCA_TRADE -> param math
  const cfg = computeDcaParams(input, direction, effGateAdx4h);
  if (cfg == null) {
    reasoning.push("capital-solve infeasible <= $20 -> downgrade DCA_WATCH");
    return { ...common, decision: "DCA_WATCH", rejectReason: "capital_solve_infeasible" };
  }
  return { ...common, decision: "DCA_TRADE", rejectReason: null, dcaBotConfig: cfg };
}
