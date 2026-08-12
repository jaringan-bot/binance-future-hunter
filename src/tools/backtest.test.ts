import { describe, it, expect } from "vitest";
import { aggregateBacktestResults } from "./backtest.js";

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
