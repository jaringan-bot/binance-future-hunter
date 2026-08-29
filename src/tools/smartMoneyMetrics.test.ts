import { describe, it, expect } from "vitest";
import {
  calculateATR,
  normalizeFunding,
  normalizeLiquidation,
  normalizeAbsorption,
  calculateSlope,
  multiTfAlignScore,
} from "./smartMoneyMetrics.js";
import { summarizeKlines, computeATR } from "../toolHelpers.js";
import type { KlineTuple } from "../binanceProxyClient.js";

function kl(n: number): KlineTuple[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + i;
    return [
      1_700_000_000_000 + i * 3_600_000,
      String(base),
      String(base + 2),
      String(base - 2),
      String(base + 1),
      "1000",
      0,
      "0",
      0,
      "0",
      "0",
      "0",
    ] as KlineTuple;
  });
}

describe("smartMoneyMetrics.calculateATR", () => {
  it("matches Wilder computeATR over the same candles", () => {
    const klines = kl(40);
    const { candles } = summarizeKlines(klines);
    expect(calculateATR(klines, 14)).toBeCloseTo(computeATR(candles, 14), 10);
    expect(calculateATR(klines, 14)).toBeGreaterThan(0);
  });
});

describe("smartMoneyMetrics.normalizeFunding", () => {
  const hist = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it("percentile rank (signed) of current value", () => {
    expect(normalizeFunding(5, hist)).toBe(50);
    expect(normalizeFunding(10, hist)).toBe(100);
    expect(normalizeFunding(0, hist)).toBe(0);
    expect(normalizeFunding(11, hist)).toBe(100);
  });
  it("empty history -> neutral 50", () => {
    expect(normalizeFunding(0.001, [])).toBe(50);
  });
});

describe("smartMoneyMetrics.normalizeLiquidation", () => {
  it("2.5x mean = 75, 5.0x mean = 100", () => {
    expect(normalizeLiquidation(250, 100)).toBeCloseTo(75, 10);
    expect(normalizeLiquidation(500, 100)).toBeCloseTo(100, 10);
  });
  it("below 2.5x scales up to <=74", () => {
    expect(normalizeLiquidation(125, 100)).toBeCloseTo(37.5, 10); // (1.25/2.5)*75
    expect(normalizeLiquidation(1000, 100)).toBe(100); // capped
  });
  it("no baseline -> 0", () => {
    expect(normalizeLiquidation(500, 0)).toBe(0);
  });
});

describe("smartMoneyMetrics.normalizeAbsorption", () => {
  it("floor below 60, linear 60-75, cap above 75", () => {
    expect(normalizeAbsorption(50)).toBe(0);
    expect(normalizeAbsorption(60)).toBe(0);
    expect(normalizeAbsorption(67.5)).toBeCloseTo(50, 10);
    expect(normalizeAbsorption(75)).toBe(100);
    expect(normalizeAbsorption(90)).toBe(100);
  });
});

describe("smartMoneyMetrics.calculateSlope", () => {
  it("OLS slope on index domain", () => {
    expect(calculateSlope([1, 2, 3, 4, 5])).toBeCloseTo(1, 10);
    expect(calculateSlope([5, 4, 3, 2, 1])).toBeCloseTo(-1, 10);
    expect(calculateSlope([3, 3, 3])).toBeCloseTo(0, 10);
    expect(calculateSlope([7])).toBe(0);
    expect(calculateSlope([])).toBe(0);
  });
});

describe("smartMoneyMetrics.multiTfAlignScore", () => {
  it("1h sideways -> 0, aligned -> 100, 1h-only -> 50", () => {
    expect(multiTfAlignScore("SIDEWAYS", "BULLISH")).toBe(0);
    expect(multiTfAlignScore("BULLISH", "BULLISH")).toBe(100);
    expect(multiTfAlignScore("BULLISH", "BEARISH")).toBe(50);
    expect(multiTfAlignScore("BEARISH", "SIDEWAYS")).toBe(50);
  });
});
