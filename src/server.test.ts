import { describe, it, expect } from "vitest";
import { computeRealizedVolatility, parseTimeParam } from "./server.js";

describe("computeRealizedVolatility", () => {
  it("returns zero for fewer than 2 closes", () => {
    expect(computeRealizedVolatility([100], 365)).toEqual({ periodPct: 0, annualizedPct: 0 });
    expect(computeRealizedVolatility([], 365)).toEqual({ periodPct: 0, annualizedPct: 0 });
  });

  it("returns zero volatility for a perfectly flat series", () => {
    const result = computeRealizedVolatility([100, 100, 100, 100], 365);
    expect(result.periodPct).toBe(0);
    expect(result.annualizedPct).toBe(0);
  });

  it("computes positive volatility for a moving series, annualized scales with periodsPerYear", () => {
    const closes = [100, 102, 99, 103, 101];
    const daily = computeRealizedVolatility(closes, 365);
    const hourly = computeRealizedVolatility(closes, 365 * 24);
    expect(daily.periodPct).toBeGreaterThan(0);
    // Same period-vol input, larger periodsPerYear -> larger annualized number.
    expect(hourly.annualizedPct).toBeGreaterThan(daily.annualizedPct);
  });
});

describe("parseTimeParam", () => {
  it("returns undefined when input is undefined", () => {
    expect(parseTimeParam(undefined, "startTime")).toBeUndefined();
  });

  it("parses a valid ISO 8601 string to epoch ms", () => {
    expect(parseTimeParam("2026-07-01T00:00:00Z", "startTime")).toBe(1782864000000);
  });

  it("throws a clear error for an unparseable string", () => {
    expect(() => parseTimeParam("not-a-date", "startTime")).toThrow(/startTime tidak valid/);
  });
});
