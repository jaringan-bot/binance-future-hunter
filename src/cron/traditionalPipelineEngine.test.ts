import { describe, it, expect } from "vitest";
import {
  evaluateTraditionalFuturesEntry,
  type TraditionalWave1,
  type TraditionalWave2,
} from "./traditionalPipelineEngine.js";
import type { KlineCandle, CvdSummary } from "../toolHelpers.js";
import type { OiVelocityResult } from "../tools/oiVelocity.js";

function c(high: number, low: number, close: number): KlineCandle {
  return { openTime: 0, open: close, high, low, close, volume: 1 };
}
function cvd(net: number): CvdSummary {
  const buyVolume = net > 0 ? net : 0;
  const sellVolume = net < 0 ? -net : 0;
  const totalVolume = buyVolume + sellVolume;
  return { buyVolume, sellVolume, totalVolume, buyPct: totalVolume ? (buyVolume / totalVolume) * 100 : 0, cvd: net };
}
function oi(velocityPerHour: number): OiVelocityResult {
  return { oiVelocityPerHour: velocityPerHour, maxStepDelta: 0, pointsUsed: 4, windowStartMs: 0, windowEndMs: 3_600_000 };
}

// 22 candles. Isolated window (lookback 20, excludeLast 1) = indices 1..20:
// low 100 (lRange), high 120 (hRange). Index 21 = active candle (overridden).
function history(): KlineCandle[] {
  const arr = [c(500, 1, 250)]; // index 0, outside the 20-bar window
  for (let i = 1; i <= 20; i++) arr.push(c(120, 100, 110));
  return arr;
}

function wave1(active: KlineCandle, o: Partial<TraditionalWave1> = {}): TraditionalWave1 {
  return {
    activePrice: active.close,
    candles: [...history(), active],
    atr14: 10,
    adx14: 15,
    regime: "RANGING",
    bias: "SIDEWAYS",
    activeCvd: cvd(-5),
    priorCvd: cvd(-20),
    oiVelocity: oi(-100),
    lookbackBars: 20,
    ...o,
  };
}
const NO_LIQ: TraditionalWave2 = { liquidations: null };

describe("evaluateTraditionalFuturesEntry", () => {
  it("mean-reversion sweep in a ranging market (ADX <= 25) -> TRAD_TRADE LONG", () => {
    const r = evaluateTraditionalFuturesEntry(wave1(c(103, 98, 101), { adx14: 18 }), NO_LIQ);
    expect(r.scenario).toBe("MEAN_REVERSION");
    expect(r.decision).toBe("TRAD_TRADE");
    expect(r.side).toBe("LONG");
    expect(r.entry).toBe(101);
  });

  it("mean-reversion sweep while trending (ADX > 25) -> TRAD_WATCH", () => {
    const r = evaluateTraditionalFuturesEntry(wave1(c(103, 98, 101), { adx14: 32 }), NO_LIQ);
    expect(r.scenario).toBe("MEAN_REVERSION");
    expect(r.decision).toBe("TRAD_WATCH");
  });

  it("trend breakout (bullish, tight stop) -> TRAD_TRADE SHORT/LONG per bias", () => {
    // active candle stays inside the range -> not a sweep; breakout path instead
    const active = c(112, 108, 111);
    const w1 = wave1(active, {
      activePrice: 111,
      adx14: 30,
      regime: "BREAKOUT",
      bias: "BULLISH",
      activeCvd: cvd(30),
      priorCvd: cvd(5),
      oiVelocity: oi(200),
    });
    // prior candle (index 20) low is 100 -> risk 11 on entry 111 -> slPct ~9.9%
    const r = evaluateTraditionalFuturesEntry(w1, NO_LIQ);
    expect(r.scenario).toBe("TREND_BREAKOUT");
    expect(r.side).toBe("LONG");
    expect(r.decision).toBe("TRAD_TRADE");
    expect(r.rr).toBeCloseTo(2, 6);
  });

  it("trend breakout with a stop so wide rec. leverage < 3 -> TRAD_WATCH", () => {
    const hist = history();
    hist[hist.length - 1] = c(120, 50, 110); // prior candle: very low swing low
    const active = c(112, 108, 111);
    const w1: TraditionalWave1 = {
      activePrice: 111,
      candles: [...hist, active],
      atr14: 10,
      adx14: 30,
      regime: "BREAKOUT",
      bias: "BULLISH",
      activeCvd: cvd(30),
      priorCvd: cvd(5),
      oiVelocity: oi(200),
      lookbackBars: 20,
    };
    const r = evaluateTraditionalFuturesEntry(w1, NO_LIQ);
    expect(r.scenario).toBe("TREND_BREAKOUT");
    expect(r.recommendedLeverage).toBeLessThan(3);
    expect(r.decision).toBe("TRAD_WATCH");
  });

  it("no sweep and no breakout -> TRAD_NO_TRADE", () => {
    const r = evaluateTraditionalFuturesEntry(
      wave1(c(112, 108, 111), { activeCvd: cvd(1), priorCvd: cvd(1), oiVelocity: oi(5), adx14: 15, regime: "RANGING" }),
      NO_LIQ,
    );
    expect(r.decision).toBe("TRAD_NO_TRADE");
    expect(r.scenario).toBe("NONE");
  });

  it("sweep present but bracket RR < 1.5 -> TRAD_NO_TRADE", () => {
    // hRange 120 is fixed by history(); shrink reward by moving entry near hRange.
    const hist = history();
    for (let i = 1; i <= 20; i++) hist[i] = c(112, 100, 106); // hRange now 112
    const active = c(109, 98, 108); // sweeps low 98 < 100, closes 108 back inside
    const w1: TraditionalWave1 = {
      activePrice: 108,
      candles: [...hist, active],
      atr14: 10,
      adx14: 15,
      regime: "RANGING",
      bias: "SIDEWAYS",
      activeCvd: cvd(-5),
      priorCvd: cvd(-20),
      oiVelocity: oi(-100),
      lookbackBars: 20,
    };
    // reward = 112-108 = 4 ; risk = 108-(98-5)=15 -> RR 0.27
    const r = evaluateTraditionalFuturesEntry(w1, NO_LIQ);
    expect(r.rr).toBeLessThan(1.5);
    expect(r.decision).toBe("TRAD_NO_TRADE");
  });

  it("returns TRAD_NO_TRADE without throwing when candles are insufficient", () => {
    const r = evaluateTraditionalFuturesEntry(
      { ...wave1(c(103, 98, 101)), candles: [c(103, 98, 101)] },
      NO_LIQ,
    );
    expect(r.decision).toBe("TRAD_NO_TRADE");
    expect(r.reasons.join(" ")).toMatch(/candle/i);
  });

  it("carries the sweep dataGaps (liquidation feed null) into the result", () => {
    const r = evaluateTraditionalFuturesEntry(wave1(c(103, 98, 101), { adx14: 18 }), { liquidations: null });
    expect(r.dataGaps.join(" ")).toMatch(/liquidation/i);
  });

  it("exposes entry / SL / TP / RR / recommendedLeverage from the bracket", () => {
    const r = evaluateTraditionalFuturesEntry(wave1(c(103, 98, 101), { adx14: 18 }), NO_LIQ);
    expect(r.entry).toBe(101);
    expect(r.stopLoss).toBeCloseTo(93, 6);
    expect(r.takeProfit).toBe(120);
    expect(r.rr).toBeGreaterThan(1.5);
    expect(r.recommendedLeverage).toBeGreaterThanOrEqual(1);
  });
});
