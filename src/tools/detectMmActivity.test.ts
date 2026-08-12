import { describe, it, expect } from "vitest";
import {
  calculateAbsorptionScore,
  calculateSpoofingScore,
  calculateStopHuntScore,
  calculateBasisArbScore,
  calculateOiDivergenceScore,
  calculateFundingExtremeScore,
  classifyTier,
} from "./detectMmActivity.js";

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
