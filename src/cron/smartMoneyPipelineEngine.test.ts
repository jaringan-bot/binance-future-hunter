import { describe, it, expect } from "vitest";
import {
  evaluateSmartMoneyEntry,
  consolidationScore,
  slopeRatioScore,
  calculateScenarioC,
  type SmartMoneyInput,
} from "./smartMoneyPipelineEngine.js";

// Baseline input dengan semua skenario nol -> NO_TRADE. Test override per bidang.
function baseInput(over: Partial<SmartMoneyInput> = {}): SmartMoneyInput {
  return {
    oiVelocityPct: 0,
    fundingPct: 0,
    priceChange1hAbs: 1000, // besar -> consolidation 0
    atr1h: 10,
    isLiquiditySweep: false,
    liqSpike: 0,
    liqMean24h: 100,
    takerRatioFutures: 50, // < 60 -> absorption 0
    slopeSpot: 0,
    slopeFutures: 1,
    takerSpotNorm: 0,
    multiTfAlign: 0,
    regime: "RANGING",
    sweepIsCounterTrend: false,
    ...over,
  };
}

describe("smartMoneyPipelineEngine helpers", () => {
  it("consolidationScore = max(0, 100 - (|dP|/(0.35*ATR))*100)", () => {
    expect(consolidationScore(0, 10)).toBe(100);
    expect(consolidationScore(3.5, 10)).toBeCloseTo(0, 10); // ratio 1
    expect(consolidationScore(1.75, 10)).toBeCloseTo(50, 10); // ratio 0.5
    expect(consolidationScore(5, 0)).toBe(0); // atr guard
  });
  it("slopeRatioScore = min(100, (spot/fut)*33), guard fut=0", () => {
    expect(slopeRatioScore(3, 1)).toBeCloseTo(99, 10);
    expect(slopeRatioScore(1, 1)).toBeCloseTo(33, 10);
    expect(slopeRatioScore(10, 1)).toBe(100);
    expect(slopeRatioScore(5, 0)).toBe(0);
  });
  it("calculateScenarioC matches DIVERGENCE_W composite (exported for Phase 2)", () => {
    // slopeRatio(3,1)=99 -> 0.5*99 + 0.3*80 + 0.2*100 = 49.5+24+20 = 93.5
    expect(calculateScenarioC({ slopeSpot: 3, slopeFutures: 1, takerSpotNorm: 80, multiTfAlign: 100 })).toBeCloseTo(93.5, 5);
    expect(calculateScenarioC({ slopeSpot: 0, slopeFutures: 1, takerSpotNorm: 0, multiTfAlign: 0 })).toBe(0);
  });
});

describe("smartMoneyPipelineEngine.evaluateSmartMoneyEntry", () => {
  it("all-quiet -> TRAD_NO_TRADE (finalScore < 50)", () => {
    const r = evaluateSmartMoneyEntry(baseInput());
    expect(r.decision).toBe("TRAD_NO_TRADE");
    expect(r.finalScore).toBeLessThan(50);
    expect(r.activeCount).toBe(0);
  });

  it("Scenario A maxed -> S_A=100, TRAD_TRADE, dominant SQUEEZE", () => {
    const r = evaluateSmartMoneyEntry(baseInput({ oiVelocityPct: 100, fundingPct: 100, priceChange1hAbs: 0, atr1h: 10 }));
    expect(r.scenarioScores.squeeze).toBeCloseTo(100, 6);
    expect(r.decision).toBe("TRAD_TRADE");
    expect(r.dominantScenario).toBe("SQUEEZE");
    expect(r.confluenceBonus).toBe(0); // only one active
  });

  it("confluence bonus: two scenarios at 50 -> +10 -> finalScore 60 -> WATCH", () => {
    // A = 50 (oi50,f50,consol50 via dP=17.5,atr100). C = 50 (slopeRatio100 via 10/1).
    const r = evaluateSmartMoneyEntry(
      baseInput({
        oiVelocityPct: 50,
        fundingPct: 50,
        priceChange1hAbs: 17.5,
        atr1h: 100,
        slopeSpot: 10,
        slopeFutures: 1,
        takerSpotNorm: 0,
        multiTfAlign: 0,
      }),
    );
    expect(r.scenarioScores.squeeze).toBeCloseTo(50, 6);
    expect(r.scenarioScores.divergence).toBeCloseTo(50, 6);
    expect(r.activeCount).toBe(2);
    expect(r.confluenceBonus).toBe(10);
    expect(r.finalScore).toBeCloseTo(60, 6);
    expect(r.decision).toBe("TRAD_WATCH");
  });

  it("Scenario B sweep maxed -> TRAD_TRADE when regime not trending", () => {
    const r = evaluateSmartMoneyEntry(
      baseInput({ isLiquiditySweep: true, liqSpike: 500, liqMean24h: 100, takerRatioFutures: 75, regime: "RANGING" }),
    );
    expect(r.scenarioScores.sweep).toBeCloseTo(100, 6); // 40 + 35 + 25
    expect(r.decision).toBe("TRAD_TRADE");
  });

  it("global regime filter: strong trending + counter-trend sweep forces S_B=0", () => {
    const r = evaluateSmartMoneyEntry(
      baseInput({
        isLiquiditySweep: true,
        liqSpike: 500,
        liqMean24h: 100,
        takerRatioFutures: 75,
        regime: "TRENDING_UP",
        sweepIsCounterTrend: true,
      }),
    );
    expect(r.scenarioScores.sweep).toBe(0);
    expect(r.regimeFilterApplied).toBe(true);
    expect(r.decision).toBe("TRAD_NO_TRADE"); // other scenarios quiet
  });

  it("decision gate boundaries: 50->WATCH, 75->TRADE", () => {
    // Single scenario A tuned to exactly 50 then 75 (no confluence).
    const at50 = evaluateSmartMoneyEntry(baseInput({ oiVelocityPct: 50, fundingPct: 50, priceChange1hAbs: 17.5, atr1h: 100 }));
    expect(at50.finalScore).toBeCloseTo(50, 6);
    expect(at50.decision).toBe("TRAD_WATCH");
    const at75 = evaluateSmartMoneyEntry(baseInput({ oiVelocityPct: 75, fundingPct: 75, priceChange1hAbs: 8.75, atr1h: 100 }));
    expect(at75.finalScore).toBeCloseTo(75, 6);
    expect(at75.decision).toBe("TRAD_TRADE");
  });
});
