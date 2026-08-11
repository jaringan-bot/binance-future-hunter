import { describe, it, expect } from "vitest";
import { computeCvdFromTrades, classifyPriceBias, summarizeKlines } from "./toolHelpers.js";
import type { AggTrade, KlineTuple } from "./binanceProxyClient.js";

function trade(q: string, m: boolean): AggTrade {
  return { a: 1, p: "100", q, f: 1, l: 1, T: 0, m };
}

describe("computeCvdFromTrades", () => {
  it("sums buy volume when m=false (buyer is taker)", () => {
    const result = computeCvdFromTrades([trade("1.5", false), trade("2.5", false)]);
    expect(result.buyVolume).toBe(4);
    expect(result.sellVolume).toBe(0);
    expect(result.cvd).toBe(4);
    expect(result.buyPct).toBe(100);
  });

  it("sums sell volume when m=true (seller is taker)", () => {
    const result = computeCvdFromTrades([trade("3", true)]);
    expect(result.sellVolume).toBe(3);
    expect(result.buyVolume).toBe(0);
    expect(result.cvd).toBe(-3);
  });

  it("computes buyPct and cvd for a mixed window", () => {
    const result = computeCvdFromTrades([trade("6", false), trade("4", true)]);
    expect(result.totalVolume).toBe(10);
    expect(result.buyPct).toBe(60);
    expect(result.cvd).toBe(2);
  });

  it("returns zeros for an empty trade list", () => {
    const result = computeCvdFromTrades([]);
    expect(result).toEqual({ buyVolume: 0, sellVolume: 0, totalVolume: 0, buyPct: 0, cvd: 0 });
  });
});

describe("classifyPriceBias", () => {
  it("classifies BULLISH above +1%", () => {
    expect(classifyPriceBias(1.5)).toBe("BULLISH");
  });

  it("classifies BEARISH below -1%", () => {
    expect(classifyPriceBias(-2)).toBe("BEARISH");
  });

  it("classifies SIDEWAYS within +-1%", () => {
    expect(classifyPriceBias(0.5)).toBe("SIDEWAYS");
    expect(classifyPriceBias(-0.5)).toBe("SIDEWAYS");
    expect(classifyPriceBias(1)).toBe("SIDEWAYS");
  });
});

function kline(open: string, high: string, low: string, close: string, volume = "1"): KlineTuple {
  return [0, open, high, low, close, volume, 0, "0", 0, "0", "0", "0"];
}

describe("summarizeKlines", () => {
  it("returns zeroed summary for an empty array", () => {
    const result = summarizeKlines([]);
    expect(result.candles).toEqual([]);
    expect(result.changePct).toBe(0);
    expect(result.bias).toBe("SIDEWAYS");
    expect(result.swingHigh).toBe(0);
    expect(result.swingLow).toBe(0);
  });

  it("computes swing high/low across all candles", () => {
    const result = summarizeKlines([
      kline("100", "105", "98", "102"),
      kline("102", "110", "101", "108"),
      kline("108", "109", "95", "97"),
    ]);
    expect(result.swingHigh).toBe(110);
    expect(result.swingLow).toBe(95);
    expect(result.lastClose).toBe(97);
  });

  it("computes changePct from first to last close and classifies bias", () => {
    const result = summarizeKlines([kline("100", "100", "100", "100"), kline("100", "103", "99", "103")]);
    expect(result.changePct).toBeCloseTo(3, 5);
    expect(result.bias).toBe("BULLISH");
  });

  it("maps candle fields (openTime/open/high/low/close/volume) as numbers", () => {
    const result = summarizeKlines([kline("100", "105", "98", "102", "42.5")]);
    expect(result.candles[0]).toEqual({ openTime: 0, open: 100, high: 105, low: 98, close: 102, volume: 42.5 });
  });
});
