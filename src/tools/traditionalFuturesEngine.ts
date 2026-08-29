// calculateTraditionalBracket -- pure function. Menghasilkan bracket
// "Traditional Futures" (Single Entry / Single SL / Single TP + Risk-to-Reward)
// dari data yang SUDAH di-fetch di tempat lain (Wave 1/2 fullPipeline atau tool
// liquiditySweep) -- NOL subrequest baru ke Binance relay.
//
// Dua skenario, saling eksklusif (A diperiksa dulu):
//   A. MEAN_REVERSION (fade sweep)  -- kalau detectLiquiditySweep bilang
//      isLiquiditySweep === true. Entry di harga aktif, SL di luar wick
//      (0.5 ATR), TP ke sisi range lawan.
//   B. TREND_BREAKOUT               -- kalau ADX14 > 25 DAN regime === "BREAKOUT".
//      Entry di harga aktif, SL di swing low/high candle sebelumnya, TP = 2x
//      jarak SL.
//
// Quality filter: RR < minRR (default 1.5) -> decision dipaksa TRAD_NO_TRADE
// (bracket tetap diisi untuk konteks). Leverage rekomendasi (Isolated) dihitung
// dinamis dari SL% + buffer, di-cap maxLeverage (default 20).
//
// Threshold (1.5 RR, 2% buffer, cap 20x, 2.0x TP breakout) = spesifikasi,
// BELUM di-backtest ke pair spesifik.
import type { LiquiditySweepResult } from "./liquiditySweepEngine.js";
import type { MarketRegime } from "./marketRegime.js";
import type { PriceBias } from "../toolHelpers.js";

export const DEFAULT_MIN_RR = 1.5;
export const DEFAULT_MAX_LEVERAGE = 20;
export const DEFAULT_SL_BUFFER_PCT = 2;
// TP breakout = kelipatan jarak SL ini (spec: "minimum 2.0x jarak SL").
export const BREAKOUT_TP_R_MULT = 2.0;

export type TradDecision = "TRAD_TRADE" | "TRAD_NO_TRADE";
export type TradScenario = "MEAN_REVERSION" | "TREND_BREAKOUT" | "NONE";

export interface TraditionalBracketInput {
  activePrice: number;
  atr14: number;
  sweepResult: LiquiditySweepResult;
  adx14: number;
  regime: MarketRegime;
  bias: PriceBias;
  hRange: number;
  lRange: number;
  priorSwingHigh: number; // high candle sebelum C_0
  priorSwingLow: number; // low candle sebelum C_0
  minRR?: number;
  maxLeverage?: number;
  slBufferPct?: number;
}

export interface TraditionalBracket {
  decision: TradDecision;
  scenario: TradScenario;
  side: "LONG" | "SHORT" | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null; // TP1
  takeProfit2: number | null; // TP2 (ekstensi)
  rr: number; // dihitung dari TP1
  slPct: number; // |entry-sl| / entry * 100
  recommendedLeverage: number;
  reasons: string[];
}

function noTrade(scenario: TradScenario, reasons: string[]): TraditionalBracket {
  return {
    decision: "TRAD_NO_TRADE",
    scenario,
    side: null,
    entry: null,
    stopLoss: null,
    takeProfit: null,
    takeProfit2: null,
    rr: 0,
    slPct: 0,
    recommendedLeverage: 0,
    reasons,
  };
}

export function calculateTraditionalBracket(input: TraditionalBracketInput): TraditionalBracket {
  const minRR = input.minRR ?? DEFAULT_MIN_RR;
  const maxLev = input.maxLeverage ?? DEFAULT_MAX_LEVERAGE;
  const buffer = input.slBufferPct ?? DEFAULT_SL_BUFFER_PCT;

  if (!(input.activePrice > 0) || !(input.atr14 > 0)) {
    return noTrade("NONE", ["activePrice / atr14 tidak valid (<= 0)."]);
  }

  const entry = input.activePrice;
  let scenario: TradScenario = "NONE";
  let side: "LONG" | "SHORT" | null = null;
  let sl = 0;
  let tp1 = 0;

  // ── Skenario A: fade sweep ──
  if (input.sweepResult.isLiquiditySweep && input.sweepResult.side !== "NONE") {
    scenario = "MEAN_REVERSION";
    const mid = (input.hRange + input.lRange) / 2;
    if (input.sweepResult.side === "SELL_SIDE") {
      side = "LONG";
      const penetrationPrice = input.sweepResult.geometry.activeLow;
      sl = penetrationPrice - 0.5 * input.atr14;
      tp1 = input.hRange > entry ? input.hRange : mid;
    } else {
      side = "SHORT";
      const penetrationPrice = input.sweepResult.geometry.activeHigh;
      sl = penetrationPrice + 0.5 * input.atr14;
      tp1 = input.lRange < entry ? input.lRange : mid;
    }
  }
  // ── Skenario B: trend breakout ──
  else if (input.adx14 > 25 && input.regime === "BREAKOUT") {
    if (input.bias === "BULLISH") {
      scenario = "TREND_BREAKOUT";
      side = "LONG";
      sl = input.priorSwingLow;
    } else if (input.bias === "BEARISH") {
      scenario = "TREND_BREAKOUT";
      side = "SHORT";
      sl = input.priorSwingHigh;
    } else {
      return noTrade("NONE", ["Breakout terdeteksi (ADX>25) tapi bias SIDEWAYS -- arah tidak jelas."]);
    }
    const risk = Math.abs(entry - sl);
    tp1 = side === "LONG" ? entry + BREAKOUT_TP_R_MULT * risk : entry - BREAKOUT_TP_R_MULT * risk;
  }

  if (scenario === "NONE" || side === null) {
    return noTrade("NONE", ["Tidak ada skenario: bukan liquidity sweep, dan bukan breakout (ADX>25 + regime BREAKOUT)."]);
  }

  const risk = Math.abs(entry - sl);
  if (!Number.isFinite(risk) || risk === 0) {
    return noTrade(scenario, ["Jarak SL nol / tidak valid."]);
  }
  if (side === "LONG" && !(sl < entry)) {
    return noTrade(scenario, ["SL LONG tidak berada di bawah entry."]);
  }
  if (side === "SHORT" && !(sl > entry)) {
    return noTrade(scenario, ["SL SHORT tidak berada di atas entry."]);
  }

  const tpValid = side === "LONG" ? tp1 > entry : tp1 < entry;
  if (!tpValid) {
    return noTrade(scenario, ["Target TP berada di sisi yang salah dari entry (range/struktur tidak mendukung)."]);
  }

  const reward = Math.abs(tp1 - entry);
  const rr = reward / risk;
  const slPct = (risk / entry) * 100;

  const rawLev = Math.floor(100 / (slPct + buffer));
  const recommendedLeverage = Math.max(1, Math.min(maxLev, Number.isFinite(rawLev) ? rawLev : 1));

  const sign = side === "LONG" ? 1 : -1;
  const tp2Mult = scenario === "TREND_BREAKOUT" ? BREAKOUT_TP_R_MULT + 1.0 : 2.0;
  const tp2 = entry + sign * tp2Mult * risk;

  const base = {
    scenario,
    side,
    entry,
    stopLoss: sl,
    takeProfit: tp1,
    takeProfit2: tp2,
    rr,
    slPct,
    recommendedLeverage,
  };

  if (rr < minRR) {
    return {
      ...base,
      decision: "TRAD_NO_TRADE",
      reasons: [`RR ${rr.toFixed(2)} < minimum ${minRR} -- ditolak oleh quality filter.`],
    };
  }

  return {
    ...base,
    decision: "TRAD_TRADE",
    reasons: [
      `${scenario} ${side}: RR ${rr.toFixed(2)}, SL ${slPct.toFixed(2)}%, rec. leverage ${recommendedLeverage}x (Isolated).`,
    ],
  };
}
