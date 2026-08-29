// smartMoneyMetrics.ts -- pure metric normalization helpers untuk Smart Money
// Core Engine V2 (src/cron/smartMoneyPipelineEngine.ts). Semua fungsi murni
// (tanpa fetch), input angka/array -> output angka ternormalisasi 0-100 atau
// nilai turunan. Dipisah dari engine supaya bisa di-unit-test terisolasi
// (pola pure-helper + thin-engine yang sama dengan toolHelpers.ts /
// pipelineEngine.ts).
import { summarizeKlines, computeATR, type PriceBias } from "../toolHelpers.js";
import type { KlineTuple } from "../binanceProxyClient.js";

/**
 * Wilder ATR dari raw klines Binance (KlineTuple[]). Reuse computeATR
 * (toolHelpers.ts) yang sudah pakai Wilder smoothing -- TIDAK menduplikasi
 * math ATR. `period` default 14.
 */
export function calculateATR(klines: KlineTuple[], period = 14): number {
  const { candles } = summarizeKlines(klines);
  return computeATR(candles, period);
}

/**
 * Percentile rank funding rate SAAT INI terhadap distribusi 30 hari (rolling).
 * Return 0-100: fraksi nilai historis yang <= fundingRate, dikali 100.
 * Signed (bukan magnitude) -- funding positif ekstrem -> percentile tinggi
 * (long crowded / squeeze risk), funding negatif ekstrem -> percentile rendah.
 * History kosong -> 50 (netral, tidak ada basis pembanding).
 */
export function normalizeFunding(fundingRate: number, history30d: number[]): number {
  const valid = history30d.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return 50;
  const atOrBelow = valid.filter((v) => v <= fundingRate).length;
  const pct = (atOrBelow / valid.length) * 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * Normalisasi lonjakan likuidasi terhadap rata-rata 24 jam.
 * Baseline: 2.5x mean = 75 pts, 5.0x mean = 100 pts.
 * Guard: liqMean24h <= 0 -> 0 (tidak ada baseline yang bisa dibandingkan).
 */
export function normalizeLiquidation(liqSpike: number, liqMean24h: number): number {
  if (!(liqMean24h > 0)) return 0;
  if (liqSpike < 2.5 * liqMean24h) return Math.min(74, (liqSpike / (2.5 * liqMean24h)) * 75);
  return Math.min(100, 75 + ((liqSpike / liqMean24h - 2.5) / 2.5) * 25);
}

/**
 * Normalisasi taker absorption ratio (0-100 skala persen).
 * Di bawah 60% = 0 pts (floor). 60%-75% = linear 0-100 pts. Di atas 75% = 100 pts.
 */
export function normalizeAbsorption(takerRatio: number): number {
  if (takerRatio < 60) return 0;
  return Math.min(100, ((takerRatio - 60) / 15) * 100);
}

/**
 * Slope regresi linear (OLS) atas deret nilai `dataPoints` dengan x = index
 * 0..n-1. Return 0 kalau < 2 titik atau variansi x nol.
 */
export function calculateSlope(dataPoints: number[]): number {
  const ys = dataPoints.filter((v) => Number.isFinite(v));
  const n = ys.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += ys[i];
    sumXY += i * ys[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Skor keselarasan multi-timeframe (Phase 1: 1h & 4h saja).
 *   - 1h SIDEWAYS (tidak ada arah)      -> 0
 *   - 1h berarah, 4h SEARAH (aligned)   -> 100
 *   - 1h berarah, 4h beda/sideways      -> 50 ("1h only")
 */
export function multiTfAlignScore(bias1h: PriceBias, bias4h: PriceBias): number {
  if (bias1h === "SIDEWAYS") return 0;
  return bias4h === bias1h ? 100 : 50;
}

/**
 * Percentile rank kecepatan OI saat ini terhadap distribusi velocity historis
 * (mis. dihitung rolling dari openInterestHist). Return 0-100. History kosong
 * -> 50 (netral).
 */
export function getOIVelocityPercentile(currentVelocity: number, historyVelocities: number[]): number {
  const valid = historyVelocities.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return 50;
  const atOrBelow = valid.filter((v) => v <= currentVelocity).length;
  return Math.min(100, Math.max(0, (atOrBelow / valid.length) * 100));
}

/**
 * EMA sederhana (Wilder-style smoothing factor k = 2/(period+1)).
 * Return nilai EMA terakhir; array kosong -> 0.
 */
export function ema(values: number[], period: number): number {
  const ys = values.filter((v) => Number.isFinite(v));
  if (ys.length === 0) return 0;
  if (ys.length === 1 || period <= 1) return ys[ys.length - 1];
  const k = 2 / (period + 1);
  let out = ys[0];
  for (let i = 1; i < ys.length; i++) {
    out = ys[i] * k + out * (1 - k);
  }
  return out;
}
