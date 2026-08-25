// Logika murni yang identik antara tool Futures dan versi Spot-nya
// (binance_get_agg_trades vs binance_get_spot_agg_trades, binance_get_klines
// vs binance_get_spot_klines, plus dipakai lagi di binance_analyze_pair).
// Diekstrak ke sini supaya perubahan bug/formula cukup di satu tempat, dan
// bisa di-unit-test terpisah dari 25 tool handler.
import type { AggTrade, KlineTuple } from "./binanceProxyClient.js";

export interface CvdSummary {
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  buyPct: number;
  cvd: number;
}

// m: true = buyer adalah maker -> artinya SELLER yang agresif (taker sell).
// m: false = buyer adalah taker -> artinya BUYER yang agresif (taker buy).
export function computeCvdFromTrades(trades: AggTrade[]): CvdSummary {
  let buyVolume = 0;
  let sellVolume = 0;
  for (const t of trades) {
    const qty = parseFloat(t.q);
    if (t.m) sellVolume += qty;
    else buyVolume += qty;
  }
  const totalVolume = buyVolume + sellVolume;
  const buyPct = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 0;
  const cvd = buyVolume - sellVolume; // Cumulative Volume Delta sederhana untuk window ini
  return { buyVolume, sellVolume, totalVolume, buyPct, cvd };
}

// Dipakai tool histori (open interest, long/short ratio, top trader ratio,
// funding rate history, taker volume ratio, liquidation history) buat batasi
// jumlah baris yang di-print ke teks -- tanpa ini, panggilan limit besar
// (misal 500 buat kalibrasi baseline ala docs/mm_detection_framework.md
// Section 4.2) bisa nge-dump puluhan KB tabel ke context Claude. Summary
// stats (avg/tren/dominance) tetap harus dihitung dari SEMUA data yang
// di-fetch (bukan cuma `shown`), cuma tampilan tabel yang dipotong.
export interface TruncatedRows<T> {
  shown: T[];
  totalCount: number;
  truncated: boolean;
}

export function truncateRows<T>(rows: T[], max = 15): TruncatedRows<T> {
  const totalCount = rows.length;
  const truncated = totalCount > max;
  const shown = truncated ? rows.slice(-max) : rows;
  return { shown, totalCount, truncated };
}

export type PriceBias = "BULLISH" | "BEARISH" | "SIDEWAYS";

export function classifyPriceBias(changePct: number): PriceBias {
  return changePct > 1 ? "BULLISH" : changePct < -1 ? "BEARISH" : "SIDEWAYS";
}

export interface KlineCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KlinesSummary {
  candles: KlineCandle[];
  closes: number[];
  firstClose: number;
  lastClose: number;
  changePct: number;
  bias: PriceBias;
  swingHigh: number;
  swingLow: number;
}

// Format Binance native: [openTime, open, high, low, close, volume, closeTime, ...]
export function summarizeKlines(raw: KlineTuple[]): KlinesSummary {
  const candles: KlineCandle[] = raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const firstClose = closes[0] ?? 0;
  const lastClose = closes[closes.length - 1] ?? 0;
  const changePct = closes.length >= 2 && firstClose !== 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;

  return {
    candles,
    closes,
    firstClose,
    lastClose,
    changePct,
    bias: classifyPriceBias(changePct),
    swingHigh: highs.length ? Math.max(...highs) : 0,
    swingLow: lows.length ? Math.min(...lows) : 0,
  };
}

export function computeTrueRange(curr: KlineCandle, prev: KlineCandle): number {
  return Math.max(
    curr.high - curr.low,
    Math.abs(curr.high - prev.close),
    Math.abs(curr.low - prev.close),
  );
}

export interface AdxResult {
  adx: number;
  plusDI: number;
  minusDI: number;
}

// ADX (Average Directional Index) standar Wilder, dipakai binance_market_regime
// buat bedain kondisi TRENDING (ADX>25) vs RANGING (ADX<20). Butuh minimal
// 2*period+1 candle buat smoothing Wilder yang stabil (bukan cuma period+1) --
// dengan data kurang dari itu, ADX/DI awal masih bias ke rata-rata sederhana
// pertama, belum full Wilder-smoothed.
export function calculateADX(candles: KlineCandle[], period = 14): AdxResult {
  if (candles.length < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };

  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trueRanges.push(tr);

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smoothing: seed = sum period pertama, lalu prev - prev/period + current.
  function wilderSmooth(values: number[]): number[] {
    const smoothed: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    smoothed.push(sum);
    for (let i = period; i < values.length; i++) {
      sum = sum - sum / period + values[i];
      smoothed.push(sum);
    }
    return smoothed;
  }

  const smoothedTR = wilderSmooth(trueRanges);
  const smoothedPlusDM = wilderSmooth(plusDMs);
  const smoothedMinusDM = wilderSmooth(minusDMs);

  const dxValues: number[] = [];
  const plusDIs: number[] = [];
  const minusDIs: number[] = [];
  for (let i = 0; i < smoothedTR.length; i++) {
    const tr = smoothedTR[i];
    const plusDI = tr === 0 ? 0 : (smoothedPlusDM[i] / tr) * 100;
    const minusDI = tr === 0 ? 0 : (smoothedMinusDM[i] / tr) * 100;
    plusDIs.push(plusDI);
    minusDIs.push(minusDI);
    const diSum = plusDI + minusDI;
    dxValues.push(diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100);
  }

  if (dxValues.length < period) {
    // Belum cukup DX buat smoothing ADX penuh -- balikin rata-rata DX yang ada
    // sebagai estimasi kasar, lebih baik daripada 0 (yang keliru dibaca "flat").
    const avgDx = dxValues.reduce((a, b) => a + b, 0) / (dxValues.length || 1);
    return { adx: avgDx, plusDI: plusDIs[plusDIs.length - 1] ?? 0, minusDI: minusDIs[minusDIs.length - 1] ?? 0 };
  }

  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return { adx, plusDI: plusDIs[plusDIs.length - 1] ?? 0, minusDI: minusDIs[minusDIs.length - 1] ?? 0 };
}
