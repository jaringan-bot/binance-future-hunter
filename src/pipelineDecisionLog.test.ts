import { describe, it, expect } from "vitest";
import { didStopLossTouch, scoreBucket, toPipelineDecisionLogRow } from "./pipelineDecisionLog.js";
import type { SymbolPipelineResult } from "./tools/fullPipeline.js";

function result(partial: Partial<SymbolPipelineResult> & Pick<SymbolPipelineResult, "symbol" | "decision">): SymbolPipelineResult {
  return {
    rankingScore: 0,
    hardScreen: {
      passed: false,
      reasons: ["vol"],
      quoteVolumeUsd: 1_000_000,
      fundingRate: 0.0001,
      regime1h: "RANGING",
      regime4h: "TRENDING_DOWN",
    },
    reasoning: [],
    ...partial,
  } as SymbolPipelineResult;
}

describe("scoreBucket", () => {
  it("splits at the installed 40 / 55 thresholds", () => {
    expect(scoreBucket(39.9)).toBe("lt_40");
    expect(scoreBucket(40)).toBe("40_55");
    expect(scoreBucket(54.9)).toBe("40_55");
    expect(scoreBucket(55)).toBe("gte_55");
    expect(scoreBucket(80)).toBe("gte_55");
  });
});

describe("didStopLossTouch", () => {
  it("returns null when stopLoss is missing or lows are empty", () => {
    expect(didStopLossTouch([10, 9], null)).toBeNull();
    expect(didStopLossTouch([], 9)).toBeNull();
    expect(didStopLossTouch([10], Number.NaN)).toBeNull();
  });

  it("is true when any low is at or below stopLoss", () => {
    expect(didStopLossTouch([10.2, 9.5, 10.1], 9.5)).toBe(true);
    expect(didStopLossTouch([10.2, 9.4], 9.5)).toBe(true);
  });

  it("is false when every low stays above stopLoss", () => {
    expect(didStopLossTouch([10.2, 9.6], 9.5)).toBe(false);
  });
});

describe("toPipelineDecisionLogRow", () => {
  it("maps a compact row including hard-screen reject (null grid bounds)", () => {
    const row = toPipelineDecisionLogRow(
      result({ symbol: "ontusdt", decision: "NO_TRADE", rankingScore: 12 }),
      1_700_000_000_000,
      "entry_alert",
    );
    expect(row).toMatchObject({
      runAt: 1_700_000_000_000,
      symbol: "ONTUSDT",
      source: "entry_alert",
      sourceRef: null,
      decision: "NO_TRADE",
      rankingScore: 12,
      hardScreenPassed: false,
      hardScreenReasons: ["vol"],
      quoteVolumeUsd: 1_000_000,
      fundingRate: 0.0001,
      regime1h: "RANGING",
      regime4h: "TRENDING_DOWN",
      gridRiskStatus: null,
      lowerPrice: null,
      upperPrice: null,
      stopLoss: null,
    });
  });

  it("prefers gridBotConfig bounds and keeps dropstab source_ref", () => {
    const row = toPipelineDecisionLogRow(
      result({
        symbol: "ATOMUSDT",
        decision: "WATCH",
        rankingScore: 40.5,
        hardScreen: {
          passed: true,
          reasons: [],
          quoteVolumeUsd: 9_000_000,
          fundingRate: 0.0002,
          regime1h: "RANGING",
          regime4h: "RANGING",
        },
        gridBotConfig: {
          lower: 4.1,
          upper: 4.8,
          gridCount: 20,
          gridType: "ARITHMETIC",
          leverage: 5,
          marginMode: "ISOLATED",
          stopLoss: 3.9,
          takeProfit: 5.0,
          marginModeCaveat: "",
        },
        risk: {
          chosenLeverage: 5,
          initialCapitalSolved: 80,
          evaluatedLeverages: [],
          gridRisk: { status: "MODERATE" } as never,
        },
      }),
      99,
      "dropstab",
      "  token-matang-9ugwlm9y9l  ",
    );
    expect(row.source).toBe("dropstab");
    expect(row.sourceRef).toBe("token-matang-9ugwlm9y9l");
    expect(row.lowerPrice).toBe(4.1);
    expect(row.upperPrice).toBe(4.8);
    expect(row.stopLoss).toBe(3.9);
    expect(row.gridRiskStatus).toBe("MODERATE");
    expect(row.hardScreenPassed).toBe(true);
  });

  it("falls back to gridSetup when gridBotConfig is absent", () => {
    const row = toPipelineDecisionLogRow(
      result({
        symbol: "BTCUSDT",
        decision: "TRADE",
        rankingScore: 60,
        gridSetup: { lowerPrice: 100, upperPrice: 120, stopLossPrice: 95 } as never,
      }),
      1,
      "manual",
      "",
    );
    expect(row.sourceRef).toBeNull();
    expect(row.lowerPrice).toBe(100);
    expect(row.upperPrice).toBe(120);
    expect(row.stopLoss).toBe(95);
  });
});
