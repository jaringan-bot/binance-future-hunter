import { describe, it, expect } from "vitest";
import { computeFundingDivergence } from "./crossExchange.js";

describe("computeFundingDivergence", () => {
  it("returns zero divergence for an empty list", () => {
    expect(computeFundingDivergence([])).toEqual({ maxDivergence: 0, highest: null, lowest: null });
  });

  it("returns zero divergence for a single entry (highest and lowest are the same)", () => {
    const entry = { exchange: "Binance", fundingRate: 0.0001 };
    const result = computeFundingDivergence([entry]);
    expect(result.maxDivergence).toBe(0);
    expect(result.highest).toEqual(entry);
    expect(result.lowest).toEqual(entry);
  });

  it("computes the range between the highest and lowest funding rate", () => {
    const result = computeFundingDivergence([
      { exchange: "Binance", fundingRate: 0.0001 },
      { exchange: "Bybit", fundingRate: 0.0005 },
      { exchange: "OKX", fundingRate: -0.0002 },
    ]);
    expect(result.lowest?.exchange).toBe("OKX");
    expect(result.highest?.exchange).toBe("Bybit");
    expect(result.maxDivergence).toBeCloseTo(0.0007, 8);
  });

  it("handles all-negative funding rates correctly", () => {
    const result = computeFundingDivergence([
      { exchange: "Binance", fundingRate: -0.0005 },
      { exchange: "Bybit", fundingRate: -0.0001 },
    ]);
    expect(result.lowest?.exchange).toBe("Binance");
    expect(result.highest?.exchange).toBe("Bybit");
    expect(result.maxDivergence).toBeCloseTo(0.0004, 8);
  });

  it("does not mutate the input array order", () => {
    const entries = [
      { exchange: "Bybit", fundingRate: 0.0005 },
      { exchange: "Binance", fundingRate: 0.0001 },
    ];
    const copy = [...entries];
    computeFundingDivergence(entries);
    expect(entries).toEqual(copy);
  });
});
