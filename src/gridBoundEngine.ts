// gridBoundEngine.ts -- kalkulator bound grid "Compass-equivalent" murni
// (tanpa fetch), dipakai whalescope_full_pipeline (src/tools/fullPipeline.ts)
// buat ngitung sendiri upper/lower/SL/TP/gridCount/gridType, karena TIDAK ada
// tool existing yang menghasilkan angka-angka itu -- analyze_futures_grid_risk
// (futuresGridRisk.ts) cuma MENGANALISIS parameter grid yang SUDAH ada, bukan
// menghitungnya dari nol.
//
// "Compass-equivalent" = pendekatan HEURISTIK yang meniru filosofi umum fitur
// auto-pricing Binance Futures Grid ("Compass"), BUKAN reverse-engineering
// algoritma internal Binance (yang tidak publik). Formula di sini: swing
// high/low dari lookback window + buffer ATR di kedua sisi. Didokumentasikan
// eksplisit sebagai heuristik di docs/full_pipeline_framework.md.
import { computeTrueRange, type KlineCandle } from "./toolHelpers.js";

// ─────────────────────────────────────────────────────────────
// ATR (Average True Range) -- Wilder's, dibangun di atas computeTrueRange()
// yang sama dipakai calculateADX (toolHelpers.ts). Beda dari smoothedTR
// internal calculateADX (yang SENGAJA dibiarkan sebagai cumulative sum
// karena cuma dipakai sebagai denominator rasio +DI/-DI di sana) -- di sini
// hasil akhirnya DINORMALISASI (dibagi `period`) supaya jadi ATR per-candle
// yang bisa langsung dipakai sebagai satuan harga (buat buffer upper/lower/SL).
// ─────────────────────────────────────────────────────────────
export function computeATR(candles: KlineCandle[], period = 14): number {
  if (candles.length < 2) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(computeTrueRange(candles[i], candles[i - 1]));
  }

  if (trueRanges.length < period) {
    // Fallback graceful sama spirit-nya kayak calculateADX's dxValues.length <
    // period branch: rata-rata sederhana dari true range yang ada, lebih baik
    // dari 0 (yang keliru dibaca "tidak ada volatilitas").
    return trueRanges.reduce((a, b) => a + b, 0) / (trueRanges.length || 1);
  }

  // Wilder smoothing: seed = rata-rata `period` pertama, lalu
  // prev - prev/period + current/period (bentuk ternormalisasi dari
  // wilderSmooth() calculateADX, supaya hasil akhirnya ATR per-candle
  // langsung, bukan cumulative sum).
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

export type GridBoundType = "ARITHMETIC" | "GEOMETRIC";

export interface GridBoundOptions {
  atrPeriod: number;
  atrMult: number;
  slExtraAtr: number;
  slPctBuffer: number; // persen, misal 1.0 = 1%
  tpAtrMult?: number; // opsional, default simetris ke atrMult kalau tidak diisi
  lookbackBars: number;
}

export interface GridBoundResult {
  upperPrice: number;
  lowerPrice: number;
  atr: number;
  hh: number; // highest-high window lookback
  ll: number; // lowest-low window lookback
  rangePercentage: number;
  gridType: GridBoundType;
  gridCount: number;
  stopLossPrice: number;
  takeProfitPrice: number;
}

// Threshold rangePercentage sama PERSIS dengan gridTypeMismatch check di
// gridRiskEngine.ts:141-142 -- di sana itu POST-HOC (bandingin gridType yang
// SUDAH dipilih user vs range aktual), di sini itu ATURAN KONSTRUKSI (pilih
// gridType dari range yang baru dihitung). Karena aturan sama, grid yang
// dibentuk fungsi ini SELALU lolos gridTypeMismatch=false ketika dianalisis
// ulang lewat calculateGridRisk().
const GEOMETRIC_RANGE_THRESHOLD_PCT = 20;

// gridCount: heuristik SEDERHANA (bukan histogram-optimized / bukan hasil
// backtest) -- target lebar tiap grid-step ~0.75% dari range, dibatasi ke
// rentang [MIN_GRID, MAX_GRID] biar tidak absurd untuk range sangat sempit
// (step-count meledak) atau sangat lebar (step jadi kasar sekali).
// calculateGridRisk() sendiri cuma mensyaratkan gridCount>=2 (gridRiskEngine.ts:123);
// batas atas 150 dipilih supaya notional-per-order tidak keburu-buru
// ketabrak minNotional Binance untuk capital kecil ($20 default risk_usd).
const TARGET_STEP_PCT = 0.75;
const MIN_GRID_COUNT = 10;
const MAX_GRID_COUNT = 150;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeGridCount(rangePercentage: number): number {
  if (!Number.isFinite(rangePercentage) || rangePercentage <= 0) return MIN_GRID_COUNT;
  const raw = Math.round(rangePercentage / TARGET_STEP_PCT);
  return clamp(raw, MIN_GRID_COUNT, MAX_GRID_COUNT);
}

/**
 * computeGridBounds() -- tahap "Compass-equivalent" pipeline: dari candle 1h
 * (Wave 1 fullPipeline.ts) + harga saat ini, hasilkan SEMUA parameter grid
 * siap-pakai (upper/lower/SL/TP/gridCount/gridType) TANPA butuh fetch
 * tambahan -- murni fungsi candle+currentPrice+opsi -> hasil.
 *
 * Formula (didokumentasikan detail di docs/full_pipeline_framework.md):
 * 1. HH/LL = swing high/low dari `lookbackBars` candle terakhir.
 * 2. upperPrice = HH + ATR*atrMult, lowerPrice = LL - ATR*atrMult -- buffer ATR
 *    di kedua sisi supaya bound tidak persis di titik swing (grid butuh
 *    sedikit ruang di luar swing biar tidak langsung breakout begitu deploy).
 * 3. stopLossPrice = lowerPrice - ATR*slExtraAtr, lalu diperlebar lagi
 *    slPctBuffer% di bawah itu -- DUA margin keamanan independen sesuai
 *    parameter tool (sl_extra_atr, sl_pct_buffer).
 * 4. gridType dipilih dari rangePercentage vs threshold 20% (sama seperti
 *    gridRiskEngine.ts), gridCount dari heuristik target-step-percentage.
 * 5. takeProfitPrice: default simetris ke upperPrice + ATR*(tpAtrMult ?? atrMult).
 */
export function computeGridBounds(
  candles: KlineCandle[],
  currentPrice: number,
  opts: GridBoundOptions,
): GridBoundResult {
  const window = candles.slice(-Math.max(opts.lookbackBars, 1));
  const highs = window.map((c) => c.high);
  const lows = window.map((c) => c.low);

  const hh = highs.length ? Math.max(...highs) : currentPrice;
  const ll = lows.length ? Math.min(...lows) : currentPrice;

  const atr = computeATR(candles, opts.atrPeriod);

  const upperPrice = hh + atr * opts.atrMult;
  const lowerRaw = ll - atr * opts.atrMult;
  // lowerPrice tidak boleh <= 0 -- floor kecil di atas nol supaya geometricGrid
  // (gridRiskEngine.ts) tidak menerima input tak valid untuk pair harga rendah
  // dengan ATR besar relatif (jarang, tapi mencegah NaN/negative propagation).
  const lowerPrice = Math.max(lowerRaw, currentPrice * 0.001);

  const rangePercentage = lowerPrice > 0 ? ((upperPrice - lowerPrice) / lowerPrice) * 100 : 0;
  const gridType: GridBoundType = rangePercentage > GEOMETRIC_RANGE_THRESHOLD_PCT ? "GEOMETRIC" : "ARITHMETIC";
  const gridCount = computeGridCount(rangePercentage);

  const slBeforeBuffer = lowerPrice - atr * opts.slExtraAtr;
  const stopLossPrice = Math.max(slBeforeBuffer * (1 - opts.slPctBuffer / 100), currentPrice * 0.0001);

  const tpAtrMult = opts.tpAtrMult ?? opts.atrMult;
  const takeProfitPrice = upperPrice + atr * tpAtrMult;

  return {
    upperPrice,
    lowerPrice,
    atr,
    hh,
    ll,
    rangePercentage,
    gridType,
    gridCount,
    stopLossPrice,
    takeProfitPrice,
  };
}
