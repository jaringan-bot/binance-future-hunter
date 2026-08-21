import { describe, it, expect } from "vitest";
import {
  evaluateHardScreen,
  scoreTier1Signals,
  scaleCapitalForTargetLoss,
  decidePipelineOutcome,
  TRADE_RANKING_SCORE_THRESHOLD,
  type HardScreenInput,
  type Tier1ScoreInput,
} from "./pipelineEngine.js";
import type { RegimeResult } from "./tools/marketRegime.js";

function baseHardScreen(overrides: Partial<HardScreenInput> = {}): HardScreenInput {
  return {
    tradable: true,
    quoteVolumeUsd: 10_000_000,
    minQuoteVolumeUsd: 5_000_000,
    fundingRate: 0.0001,
    maxAbsFundingRate: 0.0005,
    regime1h: "RANGING",
    regime4h: "RANGING",
    ...overrides,
  };
}

describe("evaluateHardScreen", () => {
  it("passes when all conditions are within bounds", () => {
    const result = evaluateHardScreen(baseHardScreen());
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails and short-circuits regardless of other inputs when not tradable", () => {
    const result = evaluateHardScreen(baseHardScreen({ tradable: false, quoteVolumeUsd: 999_999_999 }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("tidak tradable"))).toBe(true);
  });

  it("fails when quote volume is below the minimum threshold", () => {
    const result = evaluateHardScreen(baseHardScreen({ quoteVolumeUsd: 1_000_000 }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Quote volume"))).toBe(true);
  });

  it("fails when absolute funding rate meets or exceeds the max threshold", () => {
    const result = evaluateHardScreen(baseHardScreen({ fundingRate: -0.0005 }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Funding rate"))).toBe(true);
  });

  it("fails when 1h regime is BREAKOUT", () => {
    const result = evaluateHardScreen(baseHardScreen({ regime1h: "BREAKOUT" }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Regime 1h"))).toBe(true);
  });

  it("fails when 4h regime is BREAKOUT", () => {
    const result = evaluateHardScreen(baseHardScreen({ regime4h: "BREAKOUT" }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("Regime 4h"))).toBe(true);
  });

  it("collects ALL failing reasons, not just the first", () => {
    const result = evaluateHardScreen(
      baseHardScreen({ tradable: false, quoteVolumeUsd: 100, fundingRate: 0.01, regime1h: "BREAKOUT", regime4h: "BREAKOUT" }),
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.length).toBe(5);
  });
});

function regime(overrides: Partial<RegimeResult> = {}): RegimeResult {
  return { regime: "RANGING", confidence: 0.8, reason: "test", ...overrides };
}

function baseTier1(overrides: Partial<Tier1ScoreInput> = {}): Tier1ScoreInput {
  return {
    mmTotalScore: 3,
    smartMoneyCondition: "NEUTRAL",
    smartMoneyConfidenceScore: 50,
    regime1h: regime(),
    regime4h: regime(),
    obiBidPct20: 50,
    cvdBuyPct: 50,
    ...overrides,
  };
}

describe("scoreTier1Signals", () => {
  it("stays within [0, 100]", () => {
    const scenarios: Partial<Tier1ScoreInput>[] = [
      { mmTotalScore: 6, smartMoneyCondition: "BULLISH_ACCUMULATION", smartMoneyConfidenceScore: 100, obiBidPct20: 100, cvdBuyPct: 100 },
      { mmTotalScore: 0, smartMoneyCondition: "LONG_LIQUIDATION_RISK", smartMoneyConfidenceScore: 100, obiBidPct20: 0, cvdBuyPct: 0 },
      { mmTotalScore: 3, regime1h: regime({ regime: "TRENDING_DOWN", confidence: 1 }), regime4h: regime({ regime: "DISTRIBUTION", confidence: 1 }) },
    ];
    for (const overrides of scenarios) {
      const result = scoreTier1Signals(baseTier1(overrides));
      expect(result.rankingScore).toBeGreaterThanOrEqual(0);
      expect(result.rankingScore).toBeLessThanOrEqual(100);
      expect(result.notes.length).toBe(4);
    }
  });

  it("scores higher for BULLISH_ACCUMULATION than LONG_LIQUIDATION_RISK, holding everything else equal", () => {
    const bullish = scoreTier1Signals(baseTier1({ smartMoneyCondition: "BULLISH_ACCUMULATION", smartMoneyConfidenceScore: 80 }));
    const liquidationRisk = scoreTier1Signals(baseTier1({ smartMoneyCondition: "LONG_LIQUIDATION_RISK", smartMoneyConfidenceScore: 80 }));
    expect(bullish.rankingScore).toBeGreaterThan(liquidationRisk.rankingScore);
  });

  it("scores higher for a RANGING regime than a TRENDING_DOWN regime at equal confidence", () => {
    const ranging = scoreTier1Signals(baseTier1({ regime1h: regime({ regime: "RANGING", confidence: 0.9 }), regime4h: regime({ regime: "RANGING", confidence: 0.9 }) }));
    const trendingDown = scoreTier1Signals(baseTier1({ regime1h: regime({ regime: "TRENDING_DOWN", confidence: 0.9 }), regime4h: regime({ regime: "TRENDING_DOWN", confidence: 0.9 }) }));
    expect(ranging.rankingScore).toBeGreaterThan(trendingDown.rankingScore);
  });

  it("scores higher mmComponent-driven ranking with a higher mmTotalScore, all else equal", () => {
    const highMm = scoreTier1Signals(baseTier1({ mmTotalScore: 6 }));
    const lowMm = scoreTier1Signals(baseTier1({ mmTotalScore: 0 }));
    expect(highMm.rankingScore).toBeGreaterThan(lowMm.rankingScore);
  });
});

describe("scaleCapitalForTargetLoss", () => {
  it("solves linearly: doubling the reference loss halves the solved capital for the same target risk", () => {
    const capitalA = scaleCapitalForTargetLoss(1000, 50, 20);
    const capitalB = scaleCapitalForTargetLoss(1000, 100, 20);
    expect(capitalA).toBeCloseTo(capitalB * 2, 10);
  });

  it("solved capital scales proportionally with the target risk budget", () => {
    const capital10 = scaleCapitalForTargetLoss(1000, 50, 10);
    const capital20 = scaleCapitalForTargetLoss(1000, 50, 20);
    expect(capital20).toBeCloseTo(capital10 * 2, 10);
  });

  it("throws when the reference slippageStressedLoss is zero or negative", () => {
    expect(() => scaleCapitalForTargetLoss(1000, 0, 20)).toThrow();
    expect(() => scaleCapitalForTargetLoss(1000, -5, 20)).toThrow();
  });

  it("throws when referenceCapital or targetRiskUsd is not positive", () => {
    expect(() => scaleCapitalForTargetLoss(0, 50, 20)).toThrow();
    expect(() => scaleCapitalForTargetLoss(1000, 50, 0)).toThrow();
  });
});

describe("decidePipelineOutcome", () => {
  it("returns NO_TRADE when hard screen failed, regardless of score/status", () => {
    const result = decidePipelineOutcome({
      hardScreenPassed: false,
      hardScreenReasons: ["some reason"],
      rankingScore: 100,
      gridRiskStatus: "SAFE",
    });
    expect(result.decision).toBe("NO_TRADE");
    expect(result.reasoning).toContain("some reason");
  });

  it("returns NO_TRADE when gridRiskStatus is REJECT even if hard screen passed", () => {
    const result = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: 90,
      gridRiskStatus: "REJECT",
    });
    expect(result.decision).toBe("NO_TRADE");
  });

  it("returns WATCH when gridRiskStatus is HIGH_RISK even with a high score", () => {
    const result = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: 95,
      gridRiskStatus: "HIGH_RISK",
    });
    expect(result.decision).toBe("WATCH");
  });

  it("returns TRADE when SAFE/MODERATE and rankingScore is at or above the threshold", () => {
    const safe = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: TRADE_RANKING_SCORE_THRESHOLD,
      gridRiskStatus: "SAFE",
    });
    const moderate = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: TRADE_RANKING_SCORE_THRESHOLD + 10,
      gridRiskStatus: "MODERATE",
    });
    expect(safe.decision).toBe("TRADE");
    expect(moderate.decision).toBe("TRADE");
  });

  it("returns WATCH when SAFE/MODERATE but rankingScore is below the threshold", () => {
    const result = decidePipelineOutcome({
      hardScreenPassed: true,
      hardScreenReasons: [],
      rankingScore: TRADE_RANKING_SCORE_THRESHOLD - 1,
      gridRiskStatus: "MODERATE",
    });
    expect(result.decision).toBe("WATCH");
  });
});
