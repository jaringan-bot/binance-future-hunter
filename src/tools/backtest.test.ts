import { describe, it, expect } from "vitest";
import {
  aggregateBacktestResults,
  applyExecutionCost,
  DEFAULT_FEE_BPS,
  DEFAULT_SLIPPAGE_BPS,
} from "./backtest.js";

describe("aggregateBacktestResults", () => {
  it("returns zeros for an empty result set", () => {
    expect(aggregateBacktestResults([])).toEqual({ winRate: 0, avgReturn: 0, maxDrawdown: 0, sampleSize: 0 });
  });

  it("computes 100% win rate when every trade is profitable", () => {
    const result = aggregateBacktestResults([{ forwardReturn: 0.02 }, { forwardReturn: 0.05 }]);
    expect(result.winRate).toBe(1);
    expect(result.avgReturn).toBeCloseTo(0.035, 5);
    expect(result.sampleSize).toBe(2);
  });

  it("computes 0% win rate when every trade loses", () => {
    const result = aggregateBacktestResults([{ forwardReturn: -0.01 }, { forwardReturn: -0.03 }]);
    expect(result.winRate).toBe(0);
    expect(result.maxDrawdown).toBeCloseTo(-0.03, 5);
  });

  it("handles a mixed set of wins and losses", () => {
    const result = aggregateBacktestResults([
      { forwardReturn: 0.04 },
      { forwardReturn: -0.02 },
      { forwardReturn: 0.01 },
      { forwardReturn: -0.05 },
    ]);
    expect(result.winRate).toBe(0.5);
    expect(result.sampleSize).toBe(4);
    expect(result.maxDrawdown).toBeCloseTo(-0.05, 5);
    expect(result.avgReturn).toBeCloseTo(-0.005, 5);
  });

  it("treats exactly-zero return as not a win", () => {
    const result = aggregateBacktestResults([{ forwardReturn: 0 }, { forwardReturn: 0.01 }]);
    expect(result.winRate).toBe(0.5);
  });

  it("maxDrawdown is the single worst loss, not the sum of losses", () => {
    const result = aggregateBacktestResults([{ forwardReturn: -0.01 }, { forwardReturn: -0.02 }, { forwardReturn: -0.03 }]);
    expect(result.maxDrawdown).toBeCloseTo(-0.03, 5);
  });
});

describe("applyExecutionCost", () => {
  it("subtracts fee + slippage on both sides (entry + exit)", () => {
    // 10 bps total per side -> 20 bps = 0.002 round-trip
    expect(applyExecutionCost(0.05, 6, 4)).toBeCloseTo(0.05 - 0.002, 10);
    expect(applyExecutionCost(-0.01, 6, 4)).toBeCloseTo(-0.012, 10);
  });

  it("is a no-op when both costs are zero", () => {
    expect(applyExecutionCost(0.0123, 0, 0)).toBe(0.0123);
  });

  it("can flip a marginal gross win into a net loss", () => {
    const gross = 0.0005; // +5 bps
    const net = applyExecutionCost(gross, DEFAULT_FEE_BPS, DEFAULT_SLIPPAGE_BPS);
    expect(gross).toBeGreaterThan(0);
    expect(net).toBeLessThan(0);
    // default round-trip = 2 * (4 + 2) / 10000 = 0.0012
    expect(net).toBeCloseTo(0.0005 - 0.0012, 10);
  });

  it("feeds through the aggregate so win rate becomes execution-aware", () => {
    const gross = [{ r: 0.0005 }, { r: 0.02 }, { r: -0.01 }];
    const net = gross.map((g) => ({
      forwardReturn: applyExecutionCost(g.r, DEFAULT_FEE_BPS, DEFAULT_SLIPPAGE_BPS),
    }));
    // gross win rate would be 2/3; after costs the +5bps trade is a loss
    expect(aggregateBacktestResults(net).winRate).toBeCloseTo(1 / 3, 10);
  });
});
