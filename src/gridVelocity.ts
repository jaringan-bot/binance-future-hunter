// gridVelocity.ts -- pure helper untuk estimasi kecepatan match grid (Grid Velocity).
// Dipakai whalescope_full_pipeline sebagai INFORMASI TAMBAHAN (non-gate).
// Tidak mempengaruhi keputusan TRADE/WATCH/NO_TRADE.
//
// Formula mengikuti spesifikasi di prompt Unified Risk / Review:
//   Step_$ (Arithmetic) = (Upper - Lower) / N
//   Step_$ (Geometric)  = Lower * (price_ratio - 1)   [level terendah, proxy konservatif]
//   Crossing_Candles = jumlah candle dengan (High - Low) >= Step_$
//   Crossing_Rate = Crossing_Candles / Total_Candle
//   Est_Candle_per_Match ≈ 1 / Crossing_Rate
//   Est_Waktu_per_Match ≈ Est_Candle_per_Match * durationHours
//   Est_Total_Waktu_BE ≈ Matches_BE * Est_Waktu_per_Match
//
// Catatan wajib (harus selalu dilampirkan di output):
// - Bukan jaminan — histori singkat belum tentu representatif jangka panjang
// - Proxy "range >= Step_$" bukan bukti match penuh terjadi
// - Label "estimasi kasar berbasis histori singkat", bukan "prediksi"
// - Sampel kecil (<50 candle) rawan bias outlier

import type { KlineCandle } from "./toolHelpers.js";

export interface GridVelocityInput {
  candles: KlineCandle[];
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  gridType: "ARITHMETIC" | "GEOMETRIC";
  /** Jumlah match yang dibutuhkan untuk break-even (dari minBreakevenCycles). */
  matchesNeeded: number;
  /** Durasi satu candle dalam jam. Default 1 (TF 1h yang dipakai bounds). */
  candleDurationHours?: number;
}

export interface GridVelocityResult {
  stepSize: number;
  sampleCandles: number;
  crossingCandles: number;
  crossingRate: number;
  estCandlesPerMatch: number | null;
  estHoursPerMatch: number | null;
  estHoursToBreakeven: number | null;
  estDaysToBreakeven: number | null;
  matchesNeeded: number;
  note: string;
}

export function computeGridVelocity(input: GridVelocityInput): GridVelocityResult {
  const {
    candles,
    lowerPrice,
    upperPrice,
    gridCount,
    gridType,
    matchesNeeded,
    candleDurationHours = 1,
  } = input;

  const note =
    "Informasi tambahan, bukan gate/wasit. Estimasi kasar berbasis histori singkat — " +
    "proxy range candle ≥ step grid, bukan bukti match penuh. Sampel kecil rawan bias. " +
    "Tidak mengubah keputusan TRADE/WATCH/NO_TRADE.";

  if (
    !Number.isFinite(lowerPrice) ||
    lowerPrice <= 0 ||
    !Number.isFinite(upperPrice) ||
    upperPrice <= lowerPrice ||
    !Number.isInteger(gridCount) ||
    gridCount < 1 ||
    candles.length === 0
  ) {
    return {
      stepSize: 0,
      sampleCandles: candles.length,
      crossingCandles: 0,
      crossingRate: 0,
      estCandlesPerMatch: null,
      estHoursPerMatch: null,
      estHoursToBreakeven: null,
      estDaysToBreakeven: null,
      matchesNeeded,
      note,
    };
  }

  let stepSize: number;
  if (gridType === "GEOMETRIC") {
    const priceRatio = (upperPrice / lowerPrice) ** (1 / gridCount);
    stepSize = lowerPrice * (priceRatio - 1); // level terendah, proxy konservatif
  } else {
    stepSize = (upperPrice - lowerPrice) / gridCount;
  }

  if (!Number.isFinite(stepSize) || stepSize <= 0) {
    return {
      stepSize: 0,
      sampleCandles: candles.length,
      crossingCandles: 0,
      crossingRate: 0,
      estCandlesPerMatch: null,
      estHoursPerMatch: null,
      estHoursToBreakeven: null,
      estDaysToBreakeven: null,
      matchesNeeded,
      note,
    };
  }

  let crossingCandles = 0;
  for (const c of candles) {
    if (c.high - c.low >= stepSize) crossingCandles += 1;
  }

  const sampleCandles = candles.length;
  const crossingRate = sampleCandles > 0 ? crossingCandles / sampleCandles : 0;

  let estCandlesPerMatch: number | null = null;
  let estHoursPerMatch: number | null = null;
  let estHoursToBreakeven: number | null = null;
  let estDaysToBreakeven: number | null = null;

  if (crossingRate > 0) {
    estCandlesPerMatch = 1 / crossingRate;
    estHoursPerMatch = estCandlesPerMatch * candleDurationHours;
    if (Number.isFinite(matchesNeeded) && matchesNeeded > 0) {
      estHoursToBreakeven = matchesNeeded * estHoursPerMatch;
      estDaysToBreakeven = estHoursToBreakeven / 24;
    }
  }

  return {
    stepSize,
    sampleCandles,
    crossingCandles,
    crossingRate,
    estCandlesPerMatch,
    estHoursPerMatch,
    estHoursToBreakeven,
    estDaysToBreakeven,
    matchesNeeded,
    note,
  };
}
