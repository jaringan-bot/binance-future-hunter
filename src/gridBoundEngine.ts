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
import { computeATR, type KlineCandle } from "./toolHelpers.js";

// computeATR dulu didefinisikan di sini; sekarang tinggal di toolHelpers.ts
// (satu file dengan computeTrueRange + calculateADX). Di-re-export apa adanya
// supaya import lama `import { computeATR } from "../gridBoundEngine.js"`
// (price.ts, fullPipeline.ts, gridBoundEngine.test.ts) tetap valid tanpa
// perubahan.
export { computeATR } from "./toolHelpers.js";

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

export interface GridShape {
  rangePercentage: number;
  gridType: GridBoundType;
  gridCount: number;
}

/**
 * Bentuk grid (gridType + gridCount) SEMATA-MATA dari lower/upper.
 *
 * Diekstrak dari computeGridBounds() supaya ada SATU definisi: fungsi ini
 * yang dipakai computeGridBounds sendiri, DAN yang dipakai Stage 4.2 untuk
 * merekonstruksi bentuk grid dari `lower_price`/`upper_price` di
 * pipeline_decision_log -- tabel itu tidak menyimpan gridCount/gridType.
 *
 * JUJUR TENTANG BATASNYA: hasilnya REKONSTRUKSI, bukan nilai yang dipersist.
 * Kalau lower/upper yang tersimpan sudah dibulatkan ke tick size oleh
 * gridBotConfig, gridCount hasil rekonstruksi bisa meleset satu level dari
 * yang benar-benar dipakai saat keputusan dibuat. Cukup untuk metrik outcome
 * agregat; JANGAN dipakai untuk merekonstruksi order.
 */
export function deriveGridShape(lowerPrice: number, upperPrice: number): GridShape | null {
  if (
    !Number.isFinite(lowerPrice) ||
    !Number.isFinite(upperPrice) ||
    lowerPrice <= 0 ||
    upperPrice <= lowerPrice
  ) {
    return null;
  }
  const rangePercentage = ((upperPrice - lowerPrice) / lowerPrice) * 100;
  return {
    rangePercentage,
    gridType: rangePercentage > GEOMETRIC_RANGE_THRESHOLD_PCT ? "GEOMETRIC" : "ARITHMETIC",
    gridCount: computeGridCount(rangePercentage),
  };
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

  // deriveGridShape() mengembalikan null hanya kalau lower/upper tidak
  // membentuk range valid (upper <= lower, mis. ATR nol pada pair yang datar
  // total). Fallback-nya jalur MIN_GRID_COUNT/ARITHMETIC yang PERSIS sama
  // dengan perilaku sebelumnya -- lihat computeGridCount(0).
  const shape = deriveGridShape(lowerPrice, upperPrice);
  const rangePercentage = shape?.rangePercentage ?? 0;
  const gridType: GridBoundType = shape?.gridType ?? "ARITHMETIC";
  const gridCount = shape?.gridCount ?? computeGridCount(rangePercentage);

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
