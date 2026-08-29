import { describe, it, expect } from "vitest";
import { detectLiquiditySweep, type LiquiditySweepInput } from "./liquiditySweepEngine.js";
import type { KlineCandle, CvdSummary } from "../toolHelpers.js";
import type { OiVelocityResult } from "./oiVelocity.js";

function candle(high: number, low: number, close: number, open = close): KlineCandle {
  return { openTime: 0, open, high, low, close, volume: 1 };
}

function cvd(net: number): CvdSummary {
  const buyVolume = net > 0 ? net : 0;
  const sellVolume = net < 0 ? -net : 0;
  const totalVolume = buyVolume + sellVolume;
  return { buyVolume, sellVolume, totalVolume, buyPct: totalVolume ? (buyVolume / totalVolume) * 100 : 0, cvd: net };
}

function oi(velocityPerHour: number, maxStepDelta = 0, windowMs = 3_600_000): OiVelocityResult {
  return { oiVelocityPerHour: velocityPerHour, maxStepDelta, pointsUsed: 4, windowStartMs: 0, windowEndMs: windowMs };
}

// 3 historical candles: hRange = 120, lRange = 100. Active candle appended by each test.
const HISTORY: KlineCandle[] = [candle(115, 105, 110), candle(120, 108, 112), candle(118, 100, 104)];

function baseInput(active: KlineCandle, overrides: Partial<LiquiditySweepInput> = {}): LiquiditySweepInput {
  return {
    candles: [...HISTORY, active],
    lookbackBars: 3,
    excludeLast: 1,
    atr14: 10,
    atrSweepMult: 1.5,
    activeCvd: cvd(-5),
    priorCvd: cvd(-20),
    oiVelocity: oi(-100),
    liquidations: null,
    ...overrides,
  };
}

describe("detectLiquiditySweep", () => {
  it("flags a sell-side sweep: wick below isolated low, close reclaims, within ATR budget", () => {
    const r = detectLiquiditySweep(baseInput(candle(103, 98, 101)));
    expect(r.isLiquiditySweep).toBe(true);
    expect(r.side).toBe("SELL_SIDE");
    expect(r.direction).toBe("LONG");
    expect(r.geometry.lRange).toBe(100);
    expect(r.geometry.reclaimed).toBe(true);
    expect(r.geometry.withinAtrBudget).toBe(true);
    expect(r.orderFlow.cvdAbsorption).toBe(true);
    expect(r.openInterest.flushDetected).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("does not flag when penetration below the low exceeds the ATR budget", () => {
    const r = detectLiquiditySweep(baseInput(candle(103, 80, 101))); // 20 below lRange, budget = 15
    expect(r.isLiquiditySweep).toBe(false);
    expect(r.side).toBe("NONE");
    expect(r.geometry.withinAtrBudget).toBe(false);
  });

  it("does not flag when the close fails to reclaim the swept level", () => {
    const r = detectLiquiditySweep(baseInput(candle(103, 98, 99))); // close 99 < lRange 100
    expect(r.isLiquiditySweep).toBe(false);
    expect(r.side).toBe("NONE");
    expect(r.geometry.reclaimed).toBe(false);
  });

  it("cvdAbsorption is false when CVD also prints a lower low", () => {
    const r = detectLiquiditySweep(
      baseInput(candle(103, 98, 101), { activeCvd: cvd(-30), priorCvd: cvd(-20), oiVelocity: null }),
    );
    expect(r.orderFlow.cvdAbsorption).toBe(false);
  });

  it("flags a buy-side sweep (mirror): wick above isolated high, close back inside", () => {
    const r = detectLiquiditySweep(
      baseInput(candle(122, 118, 119), { activeCvd: cvd(5), priorCvd: cvd(20), oiVelocity: null }),
    );
    expect(r.side).toBe("BUY_SIDE");
    expect(r.direction).toBe("SHORT");
    expect(r.orderFlow.cvdAbsorption).toBe(true);
    expect(r.isLiquiditySweep).toBe(true);
  });

  it("geometry passes but zero confirmations -> not a sweep, confidence 0", () => {
    const r = detectLiquiditySweep(
      baseInput(candle(103, 98, 101), { activeCvd: cvd(-30), priorCvd: cvd(-10), oiVelocity: oi(50, 1), liquidations: null }),
    );
    expect(r.isLiquiditySweep).toBe(false);
    expect(r.confirmations).toEqual([]);
    expect(r.confidence).toBe(0);
  });

  it("is fault-tolerant: valid positive verdict with the liquidation feed null", () => {
    const r = detectLiquiditySweep(baseInput(candle(103, 98, 101), { oiVelocity: null, liquidations: null }));
    expect(r.isLiquiditySweep).toBe(true); // via CVD absorption alone
    expect(r.liquidations.available).toBe(false);
    expect(r.openInterest.available).toBe(false);
    expect(r.dataGaps.length).toBeGreaterThanOrEqual(2);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("does not claim CVD absorption when both CVD windows are empty (no trade data)", () => {
    const r = detectLiquiditySweep(
      baseInput(candle(103, 98, 101), { activeCvd: cvd(0), priorCvd: cvd(0), oiVelocity: oi(-100) }),
    );
    expect(r.orderFlow.cvdAbsorption).toBe(false);
    expect(r.dataGaps.join(" ")).toMatch(/CVD/i);
  });

  it("detects an OI flush via a maxStepDelta spike even when net velocity is ~flat", () => {
    const r = detectLiquiditySweep(
      baseInput(candle(103, 98, 101), { oiVelocity: oi(0.0001, 500, 3_600_000), activeCvd: cvd(-30), priorCvd: cvd(-10) }),
    );
    expect(r.openInterest.flushDetected).toBe(true);
  });

  it("returns a NONE verdict without throwing when candles are insufficient", () => {
    const r = detectLiquiditySweep(baseInput(candle(103, 98, 101), { candles: [candle(103, 98, 101)] }));
    expect(r.isLiquiditySweep).toBe(false);
    expect(r.side).toBe("NONE");
    expect(r.reasons.join(" ")).toMatch(/candle/i);
  });

  it("confirms a sell-side sweep when SELL liquidations dominate, lifting confidence", () => {
    const withLiq = detectLiquiditySweep(
      baseInput(candle(103, 98, 101), {
        liquidations: [
          { side: "SELL", price: 99, notionalUsd: 1_000_000 },
          { side: "BUY", price: 101, notionalUsd: 100_000 },
        ],
      }),
    );
    const withoutLiq = detectLiquiditySweep(baseInput(candle(103, 98, 101)));
    expect(withLiq.liquidations.available).toBe(true);
    expect(withLiq.liquidations.dominantSide).toBe("SELL");
    expect(withLiq.liquidations.clusterConfirms).toBe(true);
    expect(withLiq.confidence).toBeGreaterThan(withoutLiq.confidence);
  });
});
