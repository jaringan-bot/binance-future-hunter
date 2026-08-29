import { describe, it, expect } from "vitest";
import {
  computeShortSqueezeBoost,
  computeLongSqueezeRisk,
  computeDirectionalTiming,
  computeDcaSafetyScore,
  resolvePauseLevel,
  isCapitulation,
  computeDynamicIntervalPct,
  evaluateDcaSmartMoney,
  DCA_TIMING_TRADE_MIN,
  type DcaSmartMoneyInput,
} from "./dcaSmartMoneyAdapter.js";
import type { KlineCandle } from "../toolHelpers.js";

function baseInput(over: Partial<DcaSmartMoneyInput> = {}): DcaSmartMoneyInput {
  return {
    symbol: "BTCUSDT",
    side: "LONG",
    currentPrice: 100,
    scenarioC: { slopeSpot: 3, slopeFutures: 1, takerSpotNorm: 80, multiTfAlign: 100 },
    fundingRate: -0.0002,
    fundingHistory30d: Array.from({ length: 30 }, (_, i) => -0.0001 + i * 0.00001),
    oiVelocityPerHour: 50,
    oiVelocityHistory: [10, 20, 30, 40, 50, 60],
    regime: "RANGING",
    candles1h: makeCandles(30, 100, 2),
    liqSpikeUsd: 100_000,
    liqMean24hUsd: 500_000,
    atr1h: 2,
    ...over,
  };
}

function makeCandles(n: number, base: number, atrHint: number): KlineCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = base + Math.sin(i) * atrHint;
    return {
      openTime: i * 3_600_000,
      open: c - 0.5,
      high: c + atrHint,
      low: c - atrHint,
      close: c,
      volume: 1000,
    };
  });
}

describe("squeeze boost / risk", () => {
  it("ShortSqueezeBoost only when funding percentile < 20", () => {
    expect(computeShortSqueezeBoost(10)).toBe(50); // (20-10)*5
    expect(computeShortSqueezeBoost(20)).toBe(0);
    expect(computeShortSqueezeBoost(50)).toBe(0);
  });
  it("LongSqueezeRisk only when funding percentile > 80", () => {
    expect(computeLongSqueezeRisk(90)).toBe(50);
    expect(computeLongSqueezeRisk(80)).toBe(0);
  });
});

describe("computeDirectionalTiming", () => {
  it("LONG scores higher with negative funding (short squeeze setup)", () => {
    const lowFund = computeDirectionalTiming("LONG", 70, 10, 60);
    const highFund = computeDirectionalTiming("LONG", 70, 90, 60);
    expect(lowFund.score).toBeGreaterThan(highFund.score);
  });
  it("SHORT mirrors: high funding boosts timing", () => {
    const shortHighFund = computeDirectionalTiming("SHORT", 70, 90, 60);
    const shortLowFund = computeDirectionalTiming("SHORT", 70, 10, 60);
    expect(shortHighFund.score).toBeGreaterThan(shortLowFund.score);
  });
});

describe("pause guard hierarchy", () => {
  it("STOP on safety < 20 or capitulation", () => {
    expect(resolvePauseLevel(15, 50, 0, false)).toBe("STOP");
    expect(resolvePauseLevel(80, 50, 0, true)).toBe("STOP");
  });
  it("HARD on safety < 50 or long squeeze > 80", () => {
    expect(resolvePauseLevel(40, 50, 0, false)).toBe("PAUSE_HARD");
    expect(resolvePauseLevel(80, 50, 85, false)).toBe("PAUSE_HARD");
  });
  it("SOFT on safety < 70 or S_C < 25", () => {
    expect(resolvePauseLevel(65, 50, 0, false)).toBe("PAUSE_SOFT");
    expect(resolvePauseLevel(80, 20, 0, false)).toBe("PAUSE_SOFT");
  });
  it("NONE when all clear", () => {
    expect(resolvePauseLevel(80, 50, 0, false)).toBe("NONE");
  });
});

describe("isCapitulation", () => {
  it("triggers on liq > 5x baseline", () => {
    expect(isCapitulation({ liqSpikeUsd: 6_000_000, liqMean24hUsd: 1_000_000 })).toBe(true);
  });
  it("triggers on $2M+ liq with price drop > 2×ATR", () => {
    expect(isCapitulation({ liqSpikeUsd: 2_500_000, liqMean24hUsd: 0, priceDropAbs: 5, atr1h: 2 })).toBe(true);
  });
});

describe("computeDynamicIntervalPct", () => {
  it("clamps to [1.5, 8.0] with regime factor", () => {
    const pct = computeDynamicIntervalPct(makeCandles(40, 100, 0.5), 100, "BREAKOUT");
    expect(pct).toBeGreaterThanOrEqual(1.5);
    expect(pct).toBeLessThanOrEqual(8.0);
  });
});

describe("evaluateDcaSmartMoney", () => {
  it("1. valid accumulation -> DCA_TRADE when timing high and pause NONE", () => {
    const r = evaluateDcaSmartMoney(
      baseInput({
        scenarioC: { slopeSpot: 5, slopeFutures: 1, takerSpotNorm: 90, multiTfAlign: 100 },
        fundingHistory30d: Array.from({ length: 20 }, () => -0.0005),
        fundingRate: -0.001,
        oiVelocityPerHour: 80,
        oiVelocityHistory: [10, 20, 30, 40, 50, 60, 70, 80],
      }),
    );
    expect(r.timingScore).toBeGreaterThanOrEqual(DCA_TIMING_TRADE_MIN);
    expect(r.decision).toBe("DCA_TRADE");
    expect(r.pauseLevel).toBe("NONE");
  });

  it("2. PAUSE_SOFT during distribution (S_C < 25)", () => {
    const r = evaluateDcaSmartMoney(
      baseInput({
        scenarioC: { slopeSpot: 0, slopeFutures: 1, takerSpotNorm: 0, multiTfAlign: 0 },
        fundingRate: 0,
        fundingHistory30d: [-0.0001, -0.00005, 0, 0.00005, 0.0001],
        liqSpikeUsd: 50_000,
        liqMean24hUsd: 500_000,
      }),
    );
    expect(r.scenarioCScore).toBeLessThan(25);
    expect(r.safetyScore).toBeGreaterThanOrEqual(20);
    expect(r.decision).toBe("DCA_PAUSE_SOFT");
    expect(r.pauseLevel).toBe("PAUSE_SOFT");
  });

  it("3. PAUSE_HARD during Long Squeeze Risk > 80", () => {
    const r = evaluateDcaSmartMoney(
      baseInput({
        scenarioC: { slopeSpot: 3, slopeFutures: 1, takerSpotNorm: 50, multiTfAlign: 50 },
        fundingRate: 0.001,
        fundingHistory30d: Array.from({ length: 10 }, (_, i) => i * 0.00001),
      }),
    );
    expect(r.decision).toBe("DCA_PAUSE_HARD");
    expect(r.pauseLevel).toBe("PAUSE_HARD");
  });

  it("4. DCA_STOP during capitulation liquidation spikes", () => {
    const r = evaluateDcaSmartMoney(
      baseInput({
        liqSpikeUsd: 10_000_000,
        liqMean24hUsd: 1_000_000,
        scenarioC: { slopeSpot: 3, slopeFutures: 1, takerSpotNorm: 80, multiTfAlign: 100 },
      }),
    );
    expect(r.decision).toBe("DCA_STOP");
    expect(r.pauseLevel).toBe("STOP");
    expect(r.reasons.some((x) => x.includes("INVALIDATED"))).toBe(true);
  });

  it("5. Cross-product override from Grid Bot GRID_NO_TRADE", () => {
    const r = evaluateDcaSmartMoney(
      baseInput({
        gridSmDecision: "GRID_NO_TRADE",
        scenarioC: { slopeSpot: 2, slopeFutures: 1, takerSpotNorm: 60, multiTfAlign: 50 },
        fundingRate: -0.0001,
        fundingHistory30d: [-0.0002, -0.0001, 0, 0.0001, 0.0002],
      }),
    );
    expect(r.decision).toBe("DCA_PAUSE_SOFT");
    expect(r.pauseReason).toContain("Grid Bot detects range breakdown");
  });
});
