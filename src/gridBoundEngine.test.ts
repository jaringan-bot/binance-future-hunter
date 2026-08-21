import { describe, it, expect } from "vitest";
import { computeATR, computeGridBounds } from "./gridBoundEngine.js";
import type { KlineCandle } from "./toolHelpers.js";

function candle(openTime: number, high: number, low: number, close: number, open?: number): KlineCandle {
  return { openTime, open: open ?? close, high, low, close, volume: 100 };
}

describe("computeATR", () => {
  it("matches a hand-computed fixture when every true range is identical", () => {
    // Tiap candle punya true range persis 2 (high-low=2, tanpa gap ke close
    // sebelumnya) -- ATR Wilder untuk deret konstan HARUS sama dengan nilai
    // konstan itu sendiri, terlepas dari period.
    const candles: KlineCandle[] = [
      candle(0, 10, 8, 9),
      candle(1, 11, 9, 10),
      candle(2, 12, 10, 11),
      candle(3, 13, 11, 12),
      candle(4, 14, 12, 13),
    ];
    expect(computeATR(candles, 3)).toBeCloseTo(2, 10);
  });

  it("falls back to a simple average when there are fewer true ranges than the period", () => {
    const candles: KlineCandle[] = [candle(0, 10, 8, 9), candle(1, 12, 8, 10), candle(2, 11, 7, 9)];
    // true ranges: |12-8|=4 (candle1 vs candle0 close 9 -> max(4, |12-9|=3, |8-9|=1)=4),
    // candle2 vs candle1 close10 -> max(11-7=4, |11-10|=1, |7-10|=3)=4
    const atr = computeATR(candles, 14);
    expect(atr).toBeCloseTo(4, 10);
  });

  it("returns 0 for fewer than 2 candles", () => {
    expect(computeATR([], 14)).toBe(0);
    expect(computeATR([candle(0, 10, 8, 9)], 14)).toBe(0);
  });
});

function buildRangeCandles(count: number, base: number, spread: number): KlineCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const wobble = (i % 2 === 0 ? 1 : -1) * spread * 0.1;
    return candle(i * 3_600_000, base + spread + wobble, base - spread + wobble, base + wobble);
  });
}

describe("computeGridBounds", () => {
  const baseOpts = { atrPeriod: 14, atrMult: 1, slExtraAtr: 1.5, slPctBuffer: 1, lookbackBars: 20 };

  it("produces upper > lower > 0 and stopLoss below lower for a normal tight-range fixture", () => {
    const candles = buildRangeCandles(40, 100, 1); // range kecil relatif ke harga -> ARITHMETIC
    const result = computeGridBounds(candles, 100, baseOpts);

    expect(result.upperPrice).toBeGreaterThan(result.lowerPrice);
    expect(result.lowerPrice).toBeGreaterThan(0);
    expect(result.stopLossPrice).toBeLessThan(result.lowerPrice);
    expect(result.gridType).toBe("ARITHMETIC");
    expect(result.rangePercentage).toBeLessThanOrEqual(20);
  });

  it("selects GEOMETRIC when range exceeds the 20% threshold (wide-range fixture)", () => {
    const candles = buildRangeCandles(40, 300, 100); // range sangat lebar relatif ke harga
    const result = computeGridBounds(candles, 300, baseOpts);

    expect(result.upperPrice).toBeGreaterThan(result.lowerPrice);
    expect(result.lowerPrice).toBeGreaterThan(0);
    expect(result.stopLossPrice).toBeLessThan(result.lowerPrice);
    expect(result.gridType).toBe("GEOMETRIC");
    expect(result.rangePercentage).toBeGreaterThan(20);
  });

  it("keeps gridCount within the documented [10, 150] heuristic bounds for both fixtures", () => {
    const tight = computeGridBounds(buildRangeCandles(40, 100, 1), 100, baseOpts);
    const wide = computeGridBounds(buildRangeCandles(40, 300, 100), 300, baseOpts);

    expect(tight.gridCount).toBeGreaterThanOrEqual(10);
    expect(tight.gridCount).toBeLessThanOrEqual(150);
    expect(wide.gridCount).toBeGreaterThanOrEqual(10);
    expect(wide.gridCount).toBeLessThanOrEqual(150);
  });

  it("keeps takeProfitPrice above upperPrice", () => {
    const result = computeGridBounds(buildRangeCandles(40, 100, 1), 100, baseOpts);
    expect(result.takeProfitPrice).toBeGreaterThan(result.upperPrice);
  });

  it("applies a symmetric default takeProfit multiplier equal to atrMult when tpAtrMult is omitted", () => {
    const candles = buildRangeCandles(40, 100, 1);
    const withoutTp = computeGridBounds(candles, 100, baseOpts);
    const withExplicitSameTp = computeGridBounds(candles, 100, { ...baseOpts, tpAtrMult: baseOpts.atrMult });
    expect(withoutTp.takeProfitPrice).toBeCloseTo(withExplicitSameTp.takeProfitPrice, 10);
  });
});
