import { describe, it, expect } from "vitest";
import { walkDepthForNotional, walkDepthToStopLoss } from "./depthWalker.js";

describe("walkDepthForNotional", () => {
  it("returns EMPTY_DEPTH when the depth array is empty", () => {
    const result = walkDepthForNotional({ side: "BUY", targetNotionalUsd: 1000, depth: [] });
    expect(result.errorCode).toBe("EMPTY_DEPTH");
  });

  it("returns INVALID_BEST_PRICE when the first level's price is zero", () => {
    const result = walkDepthForNotional({ side: "BUY", targetNotionalUsd: 1000, depth: [["0", "10"]] });
    expect(result.errorCode).toBe("INVALID_BEST_PRICE");
  });

  it("returns INVALID_BEST_PRICE when the first level's price is not a number", () => {
    const result = walkDepthForNotional({ side: "BUY", targetNotionalUsd: 1000, depth: [["abc", "10"]] });
    expect(result.errorCode).toBe("INVALID_BEST_PRICE");
  });

  it("returns ZERO_FILL when every level has zero quantity", () => {
    const result = walkDepthForNotional({
      side: "BUY",
      targetNotionalUsd: 1000,
      depth: [
        ["100", "0"],
        ["101", "0"],
      ],
    });
    expect(result.errorCode).toBe("ZERO_FILL");
  });

  it("computes correct BUY fill price and slippage on a known 2-level book", () => {
    // Level 1: 10 qty @ 100 = $1000 notional. Level 2: 10 qty @ 110 = $1100.
    // Target $1500 -> fills all of level 1 ($1000) + 500/110=4.5454.. qty of level 2.
    const result = walkDepthForNotional({
      side: "BUY",
      targetNotionalUsd: 1500,
      depth: [
        ["100", "10"],
        ["110", "10"],
      ],
    });
    expect(result.errorCode).toBeUndefined();
    expect(result.bestPrice).toBe(100);
    expect(result.filledNotionalUsd).toBeCloseTo(1500, 5);
    const expectedQty = 10 + 500 / 110;
    expect(result.filledQty).toBeCloseTo(expectedQty, 5);
    const expectedAvgFill = 1500 / expectedQty;
    expect(result.avgFillPrice).toBeCloseTo(expectedAvgFill, 5);
    const expectedSlippagePct = ((expectedAvgFill - 100) / 100) * 100;
    expect(result.slippagePct).toBeCloseTo(expectedSlippagePct, 5);
    expect(result.partialFill).toBe(false);
  });

  it("flags partialFill when the target notional exceeds all available depth", () => {
    const result = walkDepthForNotional({
      side: "BUY",
      targetNotionalUsd: 1_000_000,
      depth: [["100", "10"]],
    });
    expect(result.partialFill).toBe(true);
    expect(result.filledNotionalUsd).toBeCloseTo(1000, 5);
  });

  it("computes correct SELL slippage direction (avg fill below best price)", () => {
    const result = walkDepthForNotional({
      side: "SELL",
      targetNotionalUsd: 1500,
      depth: [
        ["100", "10"],
        ["90", "10"],
      ],
    });
    expect(result.bestPrice).toBe(100);
    expect(result.avgFillPrice).toBeLessThan(100);
    expect(result.slippagePct).toBeGreaterThan(0);
  });
});

describe("walkDepthToStopLoss", () => {
  const bids: [string, string][] = [
    ["99", "5"],
    ["98", "5"],
    ["97", "5"],
  ];
  const asks: [string, string][] = [
    ["101", "5"],
    ["102", "5"],
    ["103", "5"],
  ];

  it("LONG walks bids downward to the stop-loss price, summing notional", () => {
    const result = walkDepthToStopLoss({
      positionSide: "LONG",
      currentPrice: 100,
      stopLossPrice: 98,
      bids,
      asks,
    });
    expect(result.rejected).toBe(false);
    // Only levels with price >= 98 count: 99*5 + 98*5 = 985
    expect(result.notionalUsd).toBeCloseTo(99 * 5 + 98 * 5, 5);
    expect(result.levelsWalked).toBe(2);
  });

  it("LONG is rejected when stopLossPrice >= currentPrice", () => {
    const result = walkDepthToStopLoss({
      positionSide: "LONG",
      currentPrice: 100,
      stopLossPrice: 100,
      bids,
      asks,
    });
    expect(result.rejected).toBe(true);
    expect(result.errorCode).toBe("INVALID_SL_ORDERING_LONG");
    expect(result.notionalUsd).toBe(0);
  });

  it("SHORT walks asks upward to the stop-loss price, summing notional", () => {
    const result = walkDepthToStopLoss({
      positionSide: "SHORT",
      currentPrice: 100,
      stopLossPrice: 102,
      bids,
      asks,
    });
    expect(result.rejected).toBe(false);
    // Only levels with price <= 102 count: 101*5 + 102*5 = 1015
    expect(result.notionalUsd).toBeCloseTo(101 * 5 + 102 * 5, 5);
    expect(result.levelsWalked).toBe(2);
  });

  it("SHORT is rejected when stopLossPrice <= currentPrice", () => {
    const result = walkDepthToStopLoss({
      positionSide: "SHORT",
      currentPrice: 100,
      stopLossPrice: 100,
      bids,
      asks,
    });
    expect(result.rejected).toBe(true);
    expect(result.errorCode).toBe("INVALID_SL_ORDERING_SHORT");
    expect(result.notionalUsd).toBe(0);
  });
});
