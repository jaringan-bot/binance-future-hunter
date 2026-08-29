import { describe, it, expect } from "vitest";
import { calculateTraditionalBracket, type TraditionalBracketInput } from "./traditionalFuturesEngine.js";
import type { LiquiditySweepResult, SweepSide } from "./liquiditySweepEngine.js";

function sweep(
  o: {
    isLiquiditySweep?: boolean;
    side?: SweepSide;
    confidence?: number;
    geometry?: Partial<LiquiditySweepResult["geometry"]>;
  } = {},
): LiquiditySweepResult {
  const side: SweepSide = o.side ?? "NONE";
  return {
    isLiquiditySweep: o.isLiquiditySweep ?? false,
    side,
    direction: side === "SELL_SIDE" ? "LONG" : side === "BUY_SIDE" ? "SHORT" : null,
    confidence: o.confidence ?? 0,
    geometry: {
      hRange: 120,
      lRange: 100,
      activeHigh: 103,
      activeLow: 98,
      activeClose: 101,
      penetration: 2,
      penetrationAtr: 0.2,
      withinAtrBudget: true,
      reclaimed: true,
      ...o.geometry,
    },
    orderFlow: { priceExtreme: true, cvdExtreme: false, cvdAbsorption: true, activeCvd: -5, priorCvd: -20 },
    openInterest: { available: true, velocityPerHour: -100, maxStepDelta: 0, flushDetected: true },
    liquidations: { available: false, count: 0, dominantSide: null, clusterConfirms: false },
    confirmations: [],
    dataGaps: [],
    reasons: [],
  };
}

function baseInput(overrides: Partial<TraditionalBracketInput> = {}): TraditionalBracketInput {
  return {
    activePrice: 101,
    atr14: 10,
    sweepResult: sweep(),
    adx14: 15,
    regime: "RANGING",
    bias: "SIDEWAYS",
    hRange: 120,
    lRange: 100,
    priorSwingHigh: 118,
    priorSwingLow: 100,
    ...overrides,
  };
}

describe("calculateTraditionalBracket", () => {
  it("Scenario A sell-side sweep -> LONG bracket, SL half an ATR below the wick", () => {
    const r = calculateTraditionalBracket(
      baseInput({ sweepResult: sweep({ isLiquiditySweep: true, side: "SELL_SIDE", geometry: { activeLow: 98 }  }) }),
    );
    expect(r.scenario).toBe("MEAN_REVERSION");
    expect(r.side).toBe("LONG");
    expect(r.entry).toBe(101);
    expect(r.stopLoss).toBeCloseTo(93, 10); // 98 - 0.5*10
    expect(r.takeProfit).toBe(120); // hRange
    expect(r.decision).toBe("TRAD_TRADE");
  });

  it("Scenario A buy-side sweep -> SHORT bracket, SL half an ATR above the wick", () => {
    const r = calculateTraditionalBracket(
      baseInput({
        activePrice: 119,
        sweepResult: sweep({ isLiquiditySweep: true, side: "BUY_SIDE", geometry: { activeHigh: 122 }  }),
      }),
    );
    expect(r.side).toBe("SHORT");
    expect(r.entry).toBe(119);
    expect(r.stopLoss).toBeCloseTo(127, 10); // 122 + 0.5*10
    expect(r.takeProfit).toBe(100); // lRange
    expect(r.decision).toBe("TRAD_TRADE");
  });

  it("computes RR as |TP-Entry| / |Entry-SL|", () => {
    const r = calculateTraditionalBracket(
      baseInput({
        activePrice: 101,
        hRange: 120,
        sweepResult: sweep({ isLiquiditySweep: true, side: "SELL_SIDE", geometry: { activeLow: 98 }  }),
      }),
    );
    // reward = 120-101 = 19 ; risk = 101-93 = 8
    expect(r.rr).toBeCloseTo(19 / 8, 6);
  });

  it("forces TRAD_NO_TRADE when RR < 1.5 (quality filter)", () => {
    const r = calculateTraditionalBracket(
      baseInput({
        activePrice: 101,
        hRange: 109, // reward 8 vs risk 8 -> RR 1.0
        sweepResult: sweep({ isLiquiditySweep: true, side: "SELL_SIDE", geometry: { activeLow: 98 }  }),
      }),
    );
    expect(r.rr).toBeLessThan(1.5);
    expect(r.decision).toBe("TRAD_NO_TRADE");
    expect(r.stopLoss).not.toBeNull(); // bracket still populated for context
  });

  it("Scenario B bullish breakout -> LONG, SL = prior swing low, TP = 2x risk", () => {
    const r = calculateTraditionalBracket(
      baseInput({ activePrice: 100, adx14: 30, regime: "BREAKOUT", bias: "BULLISH", priorSwingLow: 96 }),
    );
    expect(r.scenario).toBe("TREND_BREAKOUT");
    expect(r.side).toBe("LONG");
    expect(r.stopLoss).toBe(96);
    expect(r.takeProfit).toBe(108); // 100 + 2*(100-96)
    expect(r.rr).toBeCloseTo(2, 6);
    expect(r.decision).toBe("TRAD_TRADE");
  });

  it("Scenario B bearish breakout -> SHORT, SL = prior swing high", () => {
    const r = calculateTraditionalBracket(
      baseInput({ activePrice: 100, adx14: 28, regime: "BREAKOUT", bias: "BEARISH", priorSwingHigh: 104 }),
    );
    expect(r.side).toBe("SHORT");
    expect(r.stopLoss).toBe(104);
    expect(r.takeProfit).toBe(92); // 100 - 2*(104-100)
    expect(r.decision).toBe("TRAD_TRADE");
  });

  it("breakout with SIDEWAYS bias -> TRAD_NO_TRADE (no direction)", () => {
    const r = calculateTraditionalBracket(baseInput({ adx14: 30, regime: "BREAKOUT", bias: "SIDEWAYS" }));
    expect(r.decision).toBe("TRAD_NO_TRADE");
    expect(r.scenario).toBe("NONE");
  });

  it("no sweep and ADX <= 25 -> TRAD_NO_TRADE, scenario NONE", () => {
    const r = calculateTraditionalBracket(baseInput({ adx14: 18, regime: "RANGING" }));
    expect(r.decision).toBe("TRAD_NO_TRADE");
    expect(r.scenario).toBe("NONE");
  });

  it("Scenario A takes priority over Scenario B when both would apply", () => {
    const r = calculateTraditionalBracket(
      baseInput({
        activePrice: 101,
        adx14: 30,
        regime: "BREAKOUT",
        bias: "BULLISH",
        sweepResult: sweep({ isLiquiditySweep: true, side: "SELL_SIDE", geometry: { activeLow: 98 }  }),
      }),
    );
    expect(r.scenario).toBe("MEAN_REVERSION");
  });

  it("recommended leverage = floor(100/(slPct+2)), capped at 20", () => {
    // risk 1 on entry 100 -> slPct 1% -> floor(100/3) = 33 -> capped 20
    const r = calculateTraditionalBracket(
      baseInput({ activePrice: 100, adx14: 30, regime: "BREAKOUT", bias: "BULLISH", priorSwingLow: 99 }),
    );
    expect(r.slPct).toBeCloseTo(1, 6);
    expect(r.recommendedLeverage).toBe(20);
  });

  it("recommended leverage floors low for a wide stop", () => {
    // risk 20 on entry 100 -> slPct 20% -> floor(100/22) = 4
    const r = calculateTraditionalBracket(
      baseInput({ activePrice: 100, adx14: 30, regime: "BREAKOUT", bias: "BULLISH", priorSwingLow: 80 }),
    );
    expect(r.recommendedLeverage).toBe(4);
  });

  it("returns TRAD_NO_TRADE when the structural TP sits on the wrong side of entry", () => {
    const r = calculateTraditionalBracket(
      baseInput({
        activePrice: 101,
        hRange: 100, // below entry
        lRange: 95,
        sweepResult: sweep({ isLiquiditySweep: true, side: "SELL_SIDE", geometry: { activeLow: 98 }  }),
      }),
    );
    expect(r.decision).toBe("TRAD_NO_TRADE");
  });
});
