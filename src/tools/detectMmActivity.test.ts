import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  calculateAbsorptionScore,
  calculateSpoofingScore,
  calculateStopHuntScore,
  calculateBasisArbScore,
  calculateOiDivergenceScore,
  calculateFundingExtremeScore,
  classifyTier,
  registerMmDetectionTools,
} from "./detectMmActivity.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as orderbookDelta from "./orderbookDelta.js";
import * as queryFrequency from "../queryFrequency.js";
import type { KlineTuple } from "../binanceProxyClient.js";

describe("calculateAbsorptionScore", () => {
  it("scores high when CVD buy-dominant, price flat, OI spiking", () => {
    const result = calculateAbsorptionScore({ cvdBuyPct: 65, priceChangePct: 0.1, oiChangePct: 5 });
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it("scores moderate for weak absorption (buy dominant but price falling)", () => {
    const result = calculateAbsorptionScore({ cvdBuyPct: 58, priceChangePct: -1, oiChangePct: 0 });
    expect(result.score).toBe(0.5);
  });

  it("scores low with no clear pattern", () => {
    const result = calculateAbsorptionScore({ cvdBuyPct: 50, priceChangePct: 2, oiChangePct: 1 });
    expect(result.score).toBe(0.1);
  });

  it("caps score at 1.0 even for extreme OI spikes", () => {
    const result = calculateAbsorptionScore({ cvdBuyPct: 80, priceChangePct: 0, oiChangePct: 20 });
    expect(result.score).toBeLessThanOrEqual(1.0);
  });
});

// LEGACY 1-snapshot function -- computeMmSignals() no longer calls this,
// still used by fullPipeline.ts (see comment above the export). Delta-based
// spoofing tests live in orderbookDelta.test.ts.
describe("calculateSpoofingScore", () => {
  it("flags anomaly when spread wide and wall large relative to volume", () => {
    const result = calculateSpoofingScore({ bestBidQty: 1000, bestAskQty: 50, spreadPct: 0.3, volume24h: 50000 });
    expect(result.score).toBe(0.6);
  });

  it("scores low for normal spread/wall", () => {
    const result = calculateSpoofingScore({ bestBidQty: 10, bestAskQty: 10, spreadPct: 0.01, volume24h: 50000 });
    expect(result.score).toBe(0.1);
  });

  it("handles zero volume24h without dividing by zero", () => {
    const result = calculateSpoofingScore({ bestBidQty: 10, bestAskQty: 10, spreadPct: 0.5, volume24h: 0 });
    expect(result.score).toBe(0.1);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});

describe("calculateStopHuntScore", () => {
  it("scores high for long wick + small body + reversal", () => {
    // wickRatio = (115-100.5)/(115-95) = 0.725 > 0.7; bodyRatio = 0.5/20 = 0.025 < 0.2;
    // close(100) < open(100.5) is a down candle, previous was up (prevClose>prevOpen) -> reversal.
    const result = calculateStopHuntScore({ high: 115, low: 95, open: 100.5, close: 100, prevOpen: 99, prevClose: 101 });
    expect(result.score).toBe(0.8);
  });

  it("scores moderate for long wick without full reversal pattern", () => {
    // Same wick/body as above, but previous candle was ALSO down -> no reversal.
    const result = calculateStopHuntScore({ high: 115, low: 95, open: 100.5, close: 100, prevOpen: 101, prevClose: 99 });
    expect(result.score).toBe(0.5);
  });

  it("scores low for a normal candle with small wick", () => {
    const result = calculateStopHuntScore({ high: 102, low: 99, open: 100, close: 101.5, prevOpen: 99, prevClose: 100 });
    expect(result.score).toBe(0.1);
  });

  it("doesn't divide by zero when high equals low", () => {
    const result = calculateStopHuntScore({ high: 100, low: 100, open: 100, close: 100, prevOpen: 100, prevClose: 100 });
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it("scores high for long LOWER wick + small body + reversal up (downside hunt of shorts)", () => {
    // lowerWickRatio = (99.5-85)/20 = 0.725 > 0.7; bodyRatio = 0.5/20 = 0.025 < 0.2;
    // close(100) > open(99.5) is an up candle, previous was down (prevClose<prevOpen) -> reversal.
    const result = calculateStopHuntScore({ high: 105, low: 85, open: 99.5, close: 100, prevOpen: 101, prevClose: 99 });
    expect(result.score).toBe(0.8);
    expect(result.evidence).toContain("hunt of shorts");
  });

  it("raises score to 0.9 when OI-drop proxy present alongside classic upper-wick stop-hunt", () => {
    const result = calculateStopHuntScore({ high: 115, low: 95, open: 100.5, close: 100, prevOpen: 99, prevClose: 101, oiDropPct: -3 });
    expect(result.score).toBe(0.9);
    expect(result.evidence).toContain("forced-liquidation cascade");
    expect(result.evidence).toContain("BUKAN data liquidation riil");
  });

  it("does not raise score when oiDropPct is above threshold (-1%, not a drop)", () => {
    const result = calculateStopHuntScore({ high: 115, low: 95, open: 100.5, close: 100, prevOpen: 99, prevClose: 101, oiDropPct: -1 });
    expect(result.score).toBe(0.8);
  });

  it("raises the moderate tier (0.5 -> 0.6) with OI-drop proxy when wick is long but not full pattern", () => {
    const result = calculateStopHuntScore({ high: 115, low: 95, open: 100.5, close: 100, prevOpen: 101, prevClose: 99, oiDropPct: -5 });
    expect(result.score).toBe(0.6);
  });
});

describe("calculateBasisArbScore", () => {
  it("scores very high with extreme z-score and extreme funding", () => {
    const result = calculateBasisArbScore({ basis: 0.002, fundingRate: 0.001, threshold: 0.0005, basisZScore: 2.5 });
    expect(result.score).toBe(0.9);
  });

  it("falls through to threshold-based score when z-score present but not extreme", () => {
    const result = calculateBasisArbScore({ basis: 0.0006, fundingRate: 0.0001, threshold: 0.0005, basisZScore: 0.5 });
    expect(result.score).toBe(0.5);
  });

  it("scores 0.7 without z-score when basis is more than 2x threshold", () => {
    const result = calculateBasisArbScore({ basis: 0.0012, fundingRate: 0.0001, threshold: 0.0005 });
    expect(result.score).toBe(0.7);
  });

  it("scores low when basis is within normal range", () => {
    const result = calculateBasisArbScore({ basis: 0.0001, fundingRate: 0.0001, threshold: 0.0005 });
    expect(result.score).toBe(0.1);
  });
});

describe("calculateOiDivergenceScore", () => {
  it("scores high when OI spikes while price stays flat", () => {
    const result = calculateOiDivergenceScore({ oiChangePct: 6, priceChangePct: 0.2 });
    expect(result.score).toBe(0.8);
  });

  it("scores 0.7 when OI rises against price direction", () => {
    const result = calculateOiDivergenceScore({ oiChangePct: 4, priceChangePct: -1 });
    expect(result.score).toBe(0.7);
  });

  it("scores low when OI and price move together normally", () => {
    const result = calculateOiDivergenceScore({ oiChangePct: 1, priceChangePct: 1 });
    expect(result.score).toBe(0.1);
  });
});

describe("calculateFundingExtremeScore", () => {
  it("scores 1.0 above 3x threshold", () => {
    expect(calculateFundingExtremeScore({ fundingRate: 0.001, threshold: 0.0003 }).score).toBe(1.0);
  });

  it("scores 0.8 above 2x threshold", () => {
    expect(calculateFundingExtremeScore({ fundingRate: 0.0007, threshold: 0.0003 }).score).toBe(0.8);
  });

  it("scores 0.6 above threshold", () => {
    expect(calculateFundingExtremeScore({ fundingRate: 0.0004, threshold: 0.0003 }).score).toBe(0.6);
  });

  it("scales proportionally below threshold", () => {
    const result = calculateFundingExtremeScore({ fundingRate: 0.00015, threshold: 0.0003 });
    expect(result.score).toBeCloseTo(0.25, 5);
  });

  it("handles negative funding rate the same as positive (uses abs)", () => {
    expect(calculateFundingExtremeScore({ fundingRate: -0.001, threshold: 0.0003 }).score).toBe(1.0);
  });
});

describe("classifyTier", () => {
  it("classifies boundaries correctly", () => {
    expect(classifyTier(0)).toBe("Weak");
    expect(classifyTier(1.9)).toBe("Weak");
    expect(classifyTier(2)).toBe("Moderate");
    expect(classifyTier(3.4)).toBe("Moderate");
    expect(classifyTier(3.5)).toBe("Strong");
    expect(classifyTier(4.9)).toBe("Strong");
    expect(classifyTier(5)).toBe("Extreme");
    expect(classifyTier(6)).toBe("Extreme");
  });
});

vi.mock("../binanceProxyClient.js", () => ({
  getAggTrades: vi.fn(),
  getOpenInterestNative: vi.fn(),
  getOpenInterestHistNative: vi.fn(),
  getCurrentFundingRateNative: vi.fn(),
  getKlinesNative: vi.fn(),
  getSpotPrice: vi.fn(),
}));

vi.mock("./orderbookDelta.js", () => ({
  fetchOrderBookDelta: vi.fn(),
  calculateSpoofingScoreFromDelta: vi.fn(() => ({ score: 0.1, evidence: "no spoofing" })),
}));

vi.mock("../queryFrequency.js", () => ({
  recordNonWatchlistQuery: vi.fn(),
}));

type MmToolResult = { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown> };
type MmToolHandler = (args: { symbol: string }) => Promise<MmToolResult>;

function makeKlines(count: number): KlineTuple[] {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + i * 0.1;
    return [
      i * 3_600_000,
      open.toFixed(2),
      (open + 1).toFixed(2),
      (open - 1).toFixed(2),
      (open + 0.5).toFixed(2),
      String(1000 + i),
      i * 3_600_000 + 3_599_999,
      "0",
      10,
      "0",
      "0",
      "0",
    ] as unknown as KlineTuple;
  });
}

describe("binance_detect_mm_activity tool handler (query-frequency tracking, H3)", () => {
  let handler: MmToolHandler;

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.mocked(binanceProxy.getAggTrades).mockResolvedValue([]);
    vi.mocked(binanceProxy.getOpenInterestNative).mockResolvedValue({ symbol: "X", openInterest: "1000", time: 0 });
    vi.mocked(binanceProxy.getOpenInterestHistNative).mockResolvedValue([
      { symbol: "X", sumOpenInterest: "1000", sumOpenInterestValue: "0", timestamp: 0 },
    ]);
    vi.mocked(binanceProxy.getCurrentFundingRateNative).mockResolvedValue({
      symbol: "X",
      markPrice: "100",
      lastFundingRate: "0.0001",
    } as never);
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue(makeKlines(20));
    vi.mocked(binanceProxy.getSpotPrice).mockRejectedValue(new Error("no spot"));
    vi.mocked(orderbookDelta.fetchOrderBookDelta).mockResolvedValue({
      wallDeltas: [],
      bestBid1: 100,
      bestAsk1: 100.1,
      bestBid2: 100,
      bestAsk2: 100.1,
      spreadPct1: 0.1,
      spreadPct2: 0.1,
    });

    const fakeServer = {
      registerTool: (_name: string, _config: unknown, cb: unknown) => {
        handler = cb as MmToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerMmDetectionTools(fakeServer);
  });

  it("calls recordNonWatchlistQuery for a non-watchlist symbol", async () => {
    await handler({ symbol: "PEPEUSDT" });
    expect(queryFrequency.recordNonWatchlistQuery).toHaveBeenCalledWith("PEPEUSDT");
  });

  it("does not call recordNonWatchlistQuery for a watchlist symbol", async () => {
    await handler({ symbol: "BTCUSDT" });
    expect(queryFrequency.recordNonWatchlistQuery).not.toHaveBeenCalled();
  });
});
