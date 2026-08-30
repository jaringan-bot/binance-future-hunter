import { describe, it, expect } from "vitest";
import {
  computeGridSafetyScore,
  evaluateGridSmartMoney,
  oiGuardScore,
  regimeSafetyScore,
  scenarioCFrom,
  GRID_TRADE_MIN_SCORE,
  GRID_WATCH_MIN_SCORE,
  type GridSmartMoneyInput,
} from "./gridSmartMoneyAdapter.js";
import type { GridWallResult } from "../tools/gridWallFinder.js";
import { calculateScenarioC } from "./smartMoneyPipelineEngine.js";

function wall(over: Partial<GridWallResult> = {}): GridWallResult {
  return {
    meanDepthNotional: 50_000,
    wallThreshold: 100_000,
    lowerBound: 97,
    upperBound: 103,
    lowerWall: { price: 97, qty: 1200, notionalUsd: 116_400, distancePct: 3 },
    upperWall: { price: 103, qty: 1200, notionalUsd: 123_600, distancePct: 3 },
    estimatedGridCount: 8,
    searchRangePct: { lower: 6, upper: 6 },
    ...over,
  };
}

function baseInput(over: Partial<GridSmartMoneyInput> = {}): GridSmartMoneyInput {
  return {
    wall: wall(),
    currentPrice: 100,
    wallPersistenceScore: 100,
    scenarioCScore: 10, // cvdSafety = 90
    regime: "RANGING",
    oiVelocityPercentile: 20, // oiGuard = 100
    isLiquiditySweep: false,
    absorptionRatio: 0,
    ...over,
  };
}

describe("regimeSafetyScore / oiGuardScore", () => {
  it("maps regimes per revised Phase 2 table", () => {
    expect(regimeSafetyScore("RANGING")).toBe(100);
    expect(regimeSafetyScore("LOW_VOL")).toBe(90);
    expect(regimeSafetyScore("ACCUMULATION")).toBe(30);
    expect(regimeSafetyScore("DISTRIBUTION")).toBe(20);
    expect(regimeSafetyScore("BREAKOUT")).toBe(0);
    expect(regimeSafetyScore("STRONG_TRENDING")).toBe(0);
    expect(regimeSafetyScore("TRENDING_UP")).toBe(0);
    expect(regimeSafetyScore("TRENDING_DOWN")).toBe(0);
    expect(regimeSafetyScore("UNKNOWN")).toBe(50);
  });

  it("OI guard: >80 -> 0, <50 -> 100, linear in between", () => {
    expect(oiGuardScore(90)).toBe(0);
    expect(oiGuardScore(81)).toBe(0);
    expect(oiGuardScore(40)).toBe(100);
    expect(oiGuardScore(50)).toBeCloseTo(100, 5);
    expect(oiGuardScore(65)).toBeCloseTo(100 - 15 * 3.33, 1);
    expect(oiGuardScore(80)).toBeCloseTo(100 - 30 * 3.33, 1);
  });
});

describe("computeGridSafetyScore", () => {
  it("weights 30/30/20/20 wall/cvd/regime/oi", () => {
    // wall=100, S_C=0 -> cvd=100, regime RANGING=100, oi=20 -> oiGuard=100
    // score = 0.3*100 + 0.3*100 + 0.2*100 + 0.2*100 = 100
    const r = computeGridSafetyScore({
      wallPersistenceScore: 100,
      scenarioCScore: 0,
      regime: "RANGING",
      oiVelocityPercentile: 20,
    });
    expect(r.score).toBeCloseTo(100, 5);
    expect(r.components.cvdSafety).toBe(100);
  });

  it("high Scenario C (CVD divergence) lowers cvdSafety and total score", () => {
    const safe = computeGridSafetyScore({
      wallPersistenceScore: 100,
      scenarioCScore: 0,
      regime: "RANGING",
      oiVelocityPercentile: 20,
    });
    const risky = computeGridSafetyScore({
      wallPersistenceScore: 100,
      scenarioCScore: 100,
      regime: "RANGING",
      oiVelocityPercentile: 20,
    });
    expect(risky.components.cvdSafety).toBe(0);
    expect(risky.score).toBeLessThan(safe.score);
    // delta = 0.30 * 100 = 30 pts
    expect(safe.score - risky.score).toBeCloseTo(30, 5);
  });

  it("BREAKOUT regime + high OI velocity collapses score", () => {
    const r = computeGridSafetyScore({
      wallPersistenceScore: 100,
      scenarioCScore: 0,
      regime: "BREAKOUT",
      oiVelocityPercentile: 90,
    });
    // 0.3*100 + 0.3*100 + 0.2*0 + 0.2*0 = 60
    expect(r.score).toBeCloseTo(60, 5);
  });
});

describe("scenarioCFrom (Phase 1 reuse)", () => {
  it("delegates to calculateScenarioC from smartMoneyPipelineEngine", () => {
    const input = { slopeSpot: 3, slopeFutures: 1, takerSpotNorm: 80, multiTfAlign: 100 };
    expect(scenarioCFrom(input)).toBe(calculateScenarioC(input));
    expect(scenarioCFrom(input)).toBeGreaterThan(40);
  });
});

describe("evaluateGridSmartMoney", () => {
  it("returns GRID_NO_TRADE with exact reason when walls missing (NO ATR FALLBACK)", () => {
    const r = evaluateGridSmartMoney(baseInput({ wall: null }));
    expect(r.decision).toBe("GRID_NO_TRADE");
    expect(r.reasons).toEqual(["No significant liquidity walls found"]);
    expect(r.lowerBound).toBeNull();
    expect(r.upperBound).toBeNull();
    expect(r.positionSizingPct).toBe(0);
    expect(r.components).toBeNull();
  });

  it("GRID_TRADE when score >= 70 with wall bounds and 100% sizing", () => {
    const r = evaluateGridSmartMoney(baseInput());
    expect(r.gridSafetyScore).toBeGreaterThanOrEqual(GRID_TRADE_MIN_SCORE);
    expect(r.decision).toBe("GRID_TRADE");
    expect(r.positionSizingPct).toBe(100);
    expect(r.lowerBound).toBe(97);
    expect(r.upperBound).toBe(103);
  });

  it("GRID_WATCH with 50% sizing when 50 <= score < 70", () => {
    // wall=50, S_C=50 -> cvd=50, ACCUMULATION=30, oi=65 -> oiGuard≈50
    // score = 0.3*50 + 0.3*50 + 0.2*30 + 0.2*50 = 15+15+6+10 = 46 -- too low
    // wall=80, S_C=40 -> cvd=60, ACCUMULATION=30, oi=40 -> 100
    // = 0.3*80 + 0.3*60 + 0.2*30 + 0.2*100 = 24+18+6+20 = 68 -> WATCH
    const r = evaluateGridSmartMoney(
      baseInput({
        wallPersistenceScore: 80,
        scenarioCScore: 40,
        regime: "ACCUMULATION",
        oiVelocityPercentile: 40,
      }),
    );
    expect(r.gridSafetyScore).toBeGreaterThanOrEqual(GRID_WATCH_MIN_SCORE);
    expect(r.gridSafetyScore).toBeLessThan(GRID_TRADE_MIN_SCORE);
    expect(r.decision).toBe("GRID_WATCH");
    expect(r.positionSizingPct).toBe(50);
  });

  it("GRID_NO_TRADE when score < 50 despite walls present", () => {
    // wall=0, S_C=100 -> cvd=0, BREAKOUT=0, oi=90 -> 0 => score 0
    const r = evaluateGridSmartMoney(
      baseInput({
        wallPersistenceScore: 0,
        scenarioCScore: 100,
        regime: "BREAKOUT",
        oiVelocityPercentile: 90,
      }),
    );
    expect(r.gridSafetyScore).toBeLessThan(GRID_WATCH_MIN_SCORE);
    expect(r.decision).toBe("GRID_NO_TRADE");
    expect(r.positionSizingPct).toBe(0);
    expect(r.lowerBound).toBe(97); // walls still reported
  });

  it("GRID_REGRID_SUGGESTED when price breaks lowerBound with sweep + absorption > 65%", () => {
    const r = evaluateGridSmartMoney(
      baseInput({
        currentPrice: 96, // below lowerBound 97
        isLiquiditySweep: true,
        absorptionRatio: 70,
      }),
    );
    expect(r.decision).toBe("GRID_REGRID_SUGGESTED");
    expect(r.positionSizingPct).toBe(100);
    expect(r.reasons.some((x) => x.includes("Sweep recovery"))).toBe(true);
  });

  it("does not re-grid when absorption <= 65% even if price broke lowerBound", () => {
    const r = evaluateGridSmartMoney(
      baseInput({
        currentPrice: 96,
        isLiquiditySweep: true,
        absorptionRatio: 65, // must be > 65
      }),
    );
    expect(r.decision).not.toBe("GRID_REGRID_SUGGESTED");
  });

  it("does not re-grid without liquidity sweep", () => {
    const r = evaluateGridSmartMoney(
      baseInput({
        currentPrice: 96,
        isLiquiditySweep: false,
        absorptionRatio: 80,
      }),
    );
    expect(r.decision).not.toBe("GRID_REGRID_SUGGESTED");
  });
});
