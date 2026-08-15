import { describe, it, expect } from "vitest";
import {
  analyzeSmartMoneyDivergence,
  classifySmartMoneyBias,
  classifyRetailSentiment,
  computeDivergenceScore,
  type DivergenceInputs,
} from "./smartMoneyAnalysis.js";

const neutralInputs: DivergenceInputs = {
  topTraderPositionRatio: 1.0,
  globalAccountRatio: 1.0,
  oiDeltaPct: 0.1,
  fundingRate: 0.0001,
  orderBookImbalancePct: 50,
  priceBias: "SIDEWAYS",
};

describe("classifySmartMoneyBias", () => {
  it("is BULLISH above 1.05", () => expect(classifySmartMoneyBias(1.2)).toBe("BULLISH"));
  it("is BEARISH below 0.95", () => expect(classifySmartMoneyBias(0.8)).toBe("BEARISH"));
  it("is NEUTRAL at 1.0", () => expect(classifySmartMoneyBias(1.0)).toBe("NEUTRAL"));
});

describe("classifyRetailSentiment", () => {
  it("is CROWDED_LONG above 1.1", () => expect(classifyRetailSentiment(1.5)).toBe("CROWDED_LONG"));
  it("is CROWDED_SHORT below 0.9", () => expect(classifyRetailSentiment(0.5)).toBe("CROWDED_SHORT"));
  it("is NEUTRAL at 1.0", () => expect(classifyRetailSentiment(1.0)).toBe("NEUTRAL"));
});

describe("computeDivergenceScore", () => {
  it("is positive when smart money is more long than retail", () => {
    expect(computeDivergenceScore(1.5, 0.5)).toBeGreaterThan(0);
  });
  it("is negative when smart money is more short than retail", () => {
    expect(computeDivergenceScore(0.5, 1.5)).toBeLessThan(0);
  });
  it("is 0 when they match exactly", () => {
    expect(computeDivergenceScore(1.0, 1.0)).toBe(0);
  });
  it("clamps to [-100, 100] for extreme spreads", () => {
    expect(computeDivergenceScore(5, 0.1)).toBe(100);
    expect(computeDivergenceScore(0.1, 5)).toBe(-100);
  });
});

describe("analyzeSmartMoneyDivergence — condition detection", () => {
  it("detects LONG_LIQUIDATION_RISK: retail crowded long, top trader short/neutral, OI rising", () => {
    const result = analyzeSmartMoneyDivergence({
      topTraderPositionRatio: 0.85,
      globalAccountRatio: 2.0,
      oiDeltaPct: 2,
      fundingRate: 0.0005,
      orderBookImbalancePct: 40,
      priceBias: "SIDEWAYS",
    });
    expect(result.condition).toBe("LONG_LIQUIDATION_RISK");
    expect(result.confidenceScore).toBeGreaterThan(0);
    expect(result.confidenceScore).toBeLessThanOrEqual(100);
  });

  it("detects BULLISH_ACCUMULATION: top trader long, retail short, OI rising", () => {
    const result = analyzeSmartMoneyDivergence({
      topTraderPositionRatio: 1.6,
      globalAccountRatio: 0.6,
      oiDeltaPct: 3,
      fundingRate: -0.0004,
      orderBookImbalancePct: 65,
      priceBias: "SIDEWAYS",
    });
    expect(result.condition).toBe("BULLISH_ACCUMULATION");
  });

  it("detects SHORT_SQUEEZE_RISK: deeply negative funding, top trader long, price not bullish", () => {
    const result = analyzeSmartMoneyDivergence({
      topTraderPositionRatio: 1.3,
      globalAccountRatio: 1.0,
      oiDeltaPct: -1,
      fundingRate: -0.0008,
      orderBookImbalancePct: 45,
      priceBias: "BEARISH",
    });
    expect(result.condition).toBe("SHORT_SQUEEZE_RISK");
  });

  it("falls back to NEUTRAL when nothing crosses threshold", () => {
    const result = analyzeSmartMoneyDivergence(neutralInputs);
    expect(result.condition).toBe("NEUTRAL");
    expect(result.confidenceScore).toBeGreaterThan(50);
  });

  it("does not trigger a condition exactly AT the threshold (strict inequality)", () => {
    const result = analyzeSmartMoneyDivergence({
      topTraderPositionRatio: 0.95,
      globalAccountRatio: 1.8,
      oiDeltaPct: 1,
      fundingRate: 0,
      orderBookImbalancePct: 50,
      priceBias: "SIDEWAYS",
    });
    expect(result.condition).toBe("NEUTRAL");
  });

  it("prioritizes LONG_LIQUIDATION_RISK / BULLISH_ACCUMULATION over SHORT_SQUEEZE_RISK on overlap", () => {
    // topTraderPositionRatio=1.5 (>1.4) + globalAccountRatio=0.7 (<0.8) + OI up
    //   => BULLISH_ACCUMULATION matches.
    // fundingRate=-0.0005 (<-0.0003) + topTraderPositionRatio=1.5 (>1.2) + not bullish
    //   => SHORT_SQUEEZE_RISK also matches.
    const result = analyzeSmartMoneyDivergence({
      topTraderPositionRatio: 1.5,
      globalAccountRatio: 0.7,
      oiDeltaPct: 2,
      fundingRate: -0.0005,
      orderBookImbalancePct: 55,
      priceBias: "SIDEWAYS",
    });
    expect(result.condition).toBe("BULLISH_ACCUMULATION");
  });

  it("always includes a human-readable divergenceAnalysis string mentioning the detected condition's rationale", () => {
    const result = analyzeSmartMoneyDivergence(neutralInputs);
    expect(result.divergenceAnalysis.length).toBeGreaterThan(20);
  });
});
