import type { KlineCandle } from "./toolHelpers.js";
import { computeTrueRange } from "./toolHelpers.js";

export function computeATR(candles: KlineCandle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(computeTrueRange(candles[i], candles[i - 1]));
  }
  if (trueRanges.length < period) {
    return trueRanges.reduce((a, b) => a + b, 0) / (trueRanges.length || 1);
  }
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

const GEOMETRIC_RANGE_THRESHOLD_PCT = 20;
const TARGET_STEP_PCT = 0.75;
const MIN_GRID_COUNT = 10;
const MAX_GRID_COUNT = 150;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeGridCount(rangePercentage: number): number {
  if (!Number.isFinite(rangePercentage) || rangePercentage <= 0) return MIN_GRID_COUNT;
  const raw = Math.round(rangePercentage / TARGET_STEP_PCT);
  return clamp(raw, MIN_GRID_COUNT, MAX_GRID_COUNT);
}

export interface GridBoundOpts {
  lookbackBars: number;
  atrPeriod: number;
  atrMult: number;
  slExtraAtr: number;
  slPctBuffer: number;
  tpAtrMult?: number;
}

export interface GridBoundResult {
  upperPrice: number;
  lowerPrice: number;
  atr: number;
  hh: number;
  ll: number;
  rangePercentage: number;
  gridType: "ARITHMETIC" | "GEOMETRIC";
  gridCount: number;
  stopLossPrice: number;
  takeProfitPrice: number;
}

export function computeGridBounds(
  candles: KlineCandle[],
  currentPrice: number,
  opts: GridBoundOpts,
): GridBoundResult {
  const window = candles.slice(-Math.max(opts.lookbackBars, 1));
  const highs = window.map((c) => c.high);
  const lows = window.map((c) => c.low);
  const hh = highs.length ? Math.max(...highs) : currentPrice;
  const ll = lows.length ? Math.min(...lows) : currentPrice;
  const atr = computeATR(candles, opts.atrPeriod);
  const upperPrice = hh + atr * opts.atrMult;
  const lowerRaw = ll - atr * opts.atrMult;
  const lowerPrice = Math.max(lowerRaw, currentPrice * 1e-3);
  const rangePercentage = lowerPrice > 0 ? ((upperPrice - lowerPrice) / lowerPrice) * 100 : 0;
  const gridType: "ARITHMETIC" | "GEOMETRIC" =
    rangePercentage > GEOMETRIC_RANGE_THRESHOLD_PCT ? "GEOMETRIC" : "ARITHMETIC";
  const gridCount = computeGridCount(rangePercentage);
  const slBeforeBuffer = lowerPrice - atr * opts.slExtraAtr;
  const stopLossPrice = Math.max(slBeforeBuffer * (1 - opts.slPctBuffer / 100), currentPrice * 1e-4);
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
