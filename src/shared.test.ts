import { describe, it, expect } from "vitest";
import {
  computeRealizedVolatility,
  computeFallbackRvProxy,
  assignVolatilityTier,
  parseTimeParam,
  symbolSchema,
  asArray,
  clampRpiDepthLimit,
  DEFAULT_RPI_DEPTH_LIMIT,
  isRestrictedUpstream,
  isRpiDepthUnavailable,
} from "./shared.js";
import { BinanceProxyError } from "./binanceProxyClient.js";
import { StreamGatewayError } from "./streamGatewayClient.js";

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

describe("computeFallbackRvProxy", () => {
  it("returns 0 when price is zero or negative", () => {
    expect(computeFallbackRvProxy(1, 0)).toBe(0);
    expect(computeFallbackRvProxy(1, -5)).toBe(0);
  });

  it("annualizes the raw ATR/price ratio instead of returning it un-annualized", () => {
    // Raw ratio here is 0.05 (matching the ~0.03-0.08 "buggy" example range) --
    // the fallback proxy must scale it up via sqrt(365) * calibratedFactor, not
    // return the raw ratio directly.
    const atr14 = 5;
    const price1d = 100;
    const rawRatio = atr14 / price1d;
    const proxy = computeFallbackRvProxy(atr14, price1d);
    expect(proxy).toBeGreaterThan(rawRatio * 10);
    expect(proxy).toBeCloseTo(rawRatio * Math.sqrt(365) * 0.8, 10);
    expect(proxy).toBeGreaterThanOrEqual(0.3);
    expect(proxy).toBeLessThanOrEqual(1.5);
  });

  it("respects a custom calibratedFactor", () => {
    expect(computeFallbackRvProxy(5, 100, 1)).toBeCloseTo((5 / 100) * Math.sqrt(365), 10);
  });
});

describe("assignVolatilityTier", () => {
  it("assigns tier 1 (x1.0) below the 60% threshold", () => {
    expect(assignVolatilityTier(0)).toEqual({ tier: 1, multiplier: 1.0 });
    expect(assignVolatilityTier(0.59)).toEqual({ tier: 1, multiplier: 1.0 });
  });

  it("assigns tier 2 (x1.25) between 60% and 120%", () => {
    expect(assignVolatilityTier(0.6)).toEqual({ tier: 2, multiplier: 1.25 });
    expect(assignVolatilityTier(1.19)).toEqual({ tier: 2, multiplier: 1.25 });
  });

  it("assigns tier 3 (x1.6) at or above the 120% threshold", () => {
    expect(assignVolatilityTier(1.2)).toEqual({ tier: 3, multiplier: 1.6 });
    expect(assignVolatilityTier(3)).toEqual({ tier: 3, multiplier: 1.6 });
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

describe("symbolSchema", () => {
  it("accepts a normal symbol and uppercases lowercase input", () => {
    expect(symbolSchema.parse("btcusdt")).toBe("BTCUSDT");
    expect(symbolSchema.parse("ETHUSDT")).toBe("ETHUSDT");
  });

  it("accepts the longest real Binance symbol (17 chars) and dated-contract underscores", () => {
    expect(symbolSchema.parse("CSOPSKHYNIX2LUSDT")).toBe("CSOPSKHYNIX2LUSDT");
    expect(symbolSchema.parse("BTCUSDT_260925")).toBe("BTCUSDT_260925");
  });

  it("rejects an empty string", () => {
    expect(() => symbolSchema.parse("")).toThrow();
  });

  it("rejects a symbol over 20 chars (would risk exceeding the 512-byte KV key limit)", () => {
    expect(() => symbolSchema.parse("A".repeat(21) + "USDT")).toThrow();
  });

  it("rejects symbols with characters outside [A-Z0-9_]", () => {
    expect(() => symbolSchema.parse("BTC:USDT")).toThrow();
    expect(() => symbolSchema.parse("BTC/USDT")).toThrow();
    expect(() => symbolSchema.parse("BTC USDT")).toThrow();
    expect(() => symbolSchema.parse("BTCUSDT\n")).toThrow();
  });
});

describe("asArray", () => {
  it("returns the same array when the value is already an array", () => {
    const rows = [{ a: 1 }];
    expect(asArray(rows)).toBe(rows);
  });

  it("returns [] for undefined, null, and non-arrays", () => {
    expect(asArray(undefined)).toEqual([]);
    expect(asArray(null)).toEqual([]);
    expect(asArray({ assets: [] })).toEqual([]);
    expect(asArray("x")).toEqual([]);
  });
});

describe("clampRpiDepthLimit", () => {
  it("defaults to 100 when limit is missing or non-finite", () => {
    expect(clampRpiDepthLimit(undefined)).toBe(DEFAULT_RPI_DEPTH_LIMIT);
    expect(clampRpiDepthLimit(NaN)).toBe(100);
    expect(clampRpiDepthLimit("20")).toBe(100);
  });

  it("returns an exact documented limit unchanged", () => {
    expect(clampRpiDepthLimit(5)).toBe(5);
    expect(clampRpiDepthLimit(100)).toBe(100);
    expect(clampRpiDepthLimit(1000)).toBe(1000);
  });

  it("snaps an off-grid limit to the nearest documented value", () => {
    expect(clampRpiDepthLimit(15)).toBe(10);
    expect(clampRpiDepthLimit(30)).toBe(20);
    expect(clampRpiDepthLimit(80)).toBe(100);
  });
});

describe("isRestrictedUpstream / isRpiDepthUnavailable", () => {
  it("flags HTTP 401/403/404 via status or message", () => {
    expect(isRestrictedUpstream(new StreamGatewayError("stream gateway HTTP 401", 401))).toBe(true);
    expect(isRestrictedUpstream(new BinanceProxyError("Proxy/Binance error HTTP 403: denied", 403))).toBe(true);
    expect(isRestrictedUpstream(new BinanceProxyError("HTTP 404: <!DOCTYPE html> Not Found", 404))).toBe(true);
    expect(isRestrictedUpstream(new Error("stream gateway HTTP 401"))).toBe(true);
  });

  it("flags Binance -4021 and HTML 404 bodies", () => {
    expect(isRestrictedUpstream(new BinanceProxyError('HTTP 400: {"code":-4021,"msg":"not valid depth limit"}', 400))).toBe(
      true,
    );
    expect(isRestrictedUpstream(new Error("<!DOCTYPE html><title>404 Not Found</title>"))).toBe(true);
  });

  it("does not flag unrelated 5xx / generic errors", () => {
    expect(isRestrictedUpstream(new StreamGatewayError("stream gateway HTTP 502", 502))).toBe(false);
    expect(isRestrictedUpstream(new Error("network down"))).toBe(false);
  });

  it("treats HTTP 400 as RPI-unavailable even without -4021", () => {
    const err = new BinanceProxyError("Proxy/Binance error HTTP 400: bad request", 400);
    expect(isRestrictedUpstream(err)).toBe(false);
    expect(isRpiDepthUnavailable(err)).toBe(true);
  });
});
