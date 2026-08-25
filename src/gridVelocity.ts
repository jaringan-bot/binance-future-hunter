import type { KlineCandle } from "./toolHelpers.js";

export interface GridVelocityInput {
  candles: KlineCandle[];
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  gridType: "ARITHMETIC" | "GEOMETRIC";
  matchesNeeded: number;
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

const NOTE =
  "Informasi tambahan, bukan gate/wasit. Estimasi kasar berbasis histori singkat — proxy range candle ≥ step grid, bukan bukti match penuh. Sampel kecil rawan bias. Tidak mengubah keputusan TRADE/WATCH/NO_TRADE.";

export function computeGridVelocity(input: GridVelocityInput): GridVelocityResult {
  const { candles, lowerPrice, upperPrice, gridCount, gridType, matchesNeeded, candleDurationHours = 1 } = input;
  const note = NOTE;

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
    stepSize = lowerPrice * (priceRatio - 1);
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
