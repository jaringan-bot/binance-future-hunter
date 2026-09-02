import { describe, it, expect } from "vitest";
import { computeInstitutionalFlowScore } from "./institutionalFlow.js";
import type { DivergenceResult } from "./tools/crossExchange.js";
import type { CrossVenueWall } from "./tools/crossVenueDepth.js";
import type { WhaleAggregate } from "./tools/hyperliquidWhale.js";
import type { CftcTrend } from "./cftcClient.js";

function whale(overrides: Partial<WhaleAggregate> = {}): WhaleAggregate {
  return {
    coin: "BTC",
    totalWallets: 4,
    netLongWallets: 3,
    netShortWallets: 1,
    accumulatingCount: 2,
    reducingCount: 0,
    flippedCount: 0,
    confidencePct: 0.75,
    ...overrides,
  };
}

function cftcTrend(overrides: Partial<CftcTrend> = {}): CftcTrend {
  return {
    weeksAvailable: 4,
    oldest: { reportDate: "2026-07-28", openInterest: 20000, levNetPct: -0.3, amNetPct: 0.1 },
    latest: { reportDate: "2026-08-18", openInterest: 21000, levNetPct: 0.0, amNetPct: 0.15 },
    levNetPctChange: 30,
    amNetPctChange: 5,
    direction: "RISING",
    ...overrides,
  };
}

function wall(overrides: Partial<CrossVenueWall> = {}): CrossVenueWall {
  return { venue: "Binance", side: "bid", price: 60000, qty: 10, medianRatio: 3, corroboratedBy: ["Bybit"], ...overrides };
}

function divergence(maxDivergence: number): DivergenceResult {
  return { maxDivergence, highest: { exchange: "OKX", fundingRate: maxDivergence }, lowest: { exchange: "Binance", fundingRate: 0 } };
}

describe("computeInstitutionalFlowScore", () => {
  it("reports NEUTRAL/0 alignment and zero available components when everything is missing", () => {
    const score = computeInstitutionalFlowScore({
      fundingDivergence: null,
      crossVenueWalls: null,
      hyperliquidWhale: null,
      cftcTrend: null,
    });
    expect(score.componentsAvailable).toBe(0);
    expect(score.netDirection).toBe("NEUTRAL");
    expect(score.alignmentScore).toBe(0);
    expect(score.components.every((c) => !c.available)).toBe(true);
  });

  it("votes LONG for whale when netLongWallets dominates, with strength = confidencePct", () => {
    const score = computeInstitutionalFlowScore({
      fundingDivergence: null,
      crossVenueWalls: null,
      hyperliquidWhale: whale({ netLongWallets: 3, netShortWallets: 1, confidencePct: 0.75 }),
      cftcTrend: null,
    });
    const whaleComponent = score.components.find((c) => c.name === "hyperliquid_whale")!;
    expect(whaleComponent.available).toBe(true);
    expect(whaleComponent.direction).toBe("LONG");
    expect(whaleComponent.strength).toBe(0.75);
    expect(score.netDirection).toBe("LONG");
    expect(score.componentsAvailable).toBe(1);
    expect(score.alignmentScore).toBe(75); // 1 component, fully agreeing -> 0.75/1 * 100
  });

  it("treats whale aggregate with zero wallets as unavailable, not a NEUTRAL vote", () => {
    const score = computeInstitutionalFlowScore({
      fundingDivergence: null,
      crossVenueWalls: null,
      hyperliquidWhale: whale({ totalWallets: 0, netLongWallets: 0, netShortWallets: 0, confidencePct: 0 }),
      cftcTrend: null,
    });
    const whaleComponent = score.components.find((c) => c.name === "hyperliquid_whale")!;
    expect(whaleComponent.available).toBe(false);
    expect(whaleComponent.unavailableReason).toContain("WATCHLIST");
    expect(score.componentsAvailable).toBe(0);
  });

  it("votes SHORT for CFTC trend FALLING, scales strength by levNetPctChange up to the 10-point cap", () => {
    const score = computeInstitutionalFlowScore({
      fundingDivergence: null,
      crossVenueWalls: null,
      hyperliquidWhale: null,
      cftcTrend: cftcTrend({ direction: "FALLING", levNetPctChange: -25 }), // beyond scale -> clamped to 1.0
    });
    const cftcComponent = score.components.find((c) => c.name === "cftc_trend")!;
    expect(cftcComponent.direction).toBe("SHORT");
    expect(cftcComponent.strength).toBe(1);
    expect(score.netDirection).toBe("SHORT");
  });

  it("treats CFTC trend with fewer than 2 weeks of history as unavailable", () => {
    const score = computeInstitutionalFlowScore({
      fundingDivergence: null,
      crossVenueWalls: null,
      hyperliquidWhale: null,
      cftcTrend: cftcTrend({ weeksAvailable: 1, levNetPctChange: null }),
    });
    const cftcComponent = score.components.find((c) => c.name === "cftc_trend")!;
    expect(cftcComponent.available).toBe(false);
  });

  it("votes LONG for cross-venue walls when corroborated bid walls outnumber corroborated ask walls", () => {
    const walls = [
      wall({ side: "bid", corroboratedBy: ["Bybit"] }),
      wall({ side: "bid", corroboratedBy: ["OKX"] }),
      wall({ side: "ask", corroboratedBy: [] }), // not corroborated, excluded from strength denominator numerator but counted in totalWalls
    ];
    const score = computeInstitutionalFlowScore({
      fundingDivergence: null,
      crossVenueWalls: walls,
      hyperliquidWhale: null,
      cftcTrend: null,
    });
    const wallComponent = score.components.find((c) => c.name === "cross_venue_walls")!;
    expect(wallComponent.available).toBe(true);
    expect(wallComponent.direction).toBe("LONG");
    expect(wallComponent.strength).toBeCloseTo(2 / 3); // 2 corroborated out of 3 total candidates
  });

  it("treats cross-venue walls as unavailable when none are corroborated across venues", () => {
    const score = computeInstitutionalFlowScore({
      fundingDivergence: null,
      crossVenueWalls: [wall({ corroboratedBy: [] })],
      hyperliquidWhale: null,
      cftcTrend: null,
    });
    const wallComponent = score.components.find((c) => c.name === "cross_venue_walls")!;
    expect(wallComponent.available).toBe(false);
  });

  it("combines multiple agreeing components into a higher alignmentScore", () => {
    const score = computeInstitutionalFlowScore({
      fundingDivergence: null,
      crossVenueWalls: [wall({ side: "bid", corroboratedBy: ["Bybit"] })],
      hyperliquidWhale: whale({ netLongWallets: 3, netShortWallets: 1, confidencePct: 0.75 }),
      cftcTrend: cftcTrend({ direction: "RISING", levNetPctChange: 10 }),
    });
    expect(score.componentsAvailable).toBe(3);
    expect(score.netDirection).toBe("LONG");
    // all 3 agree LONG: (0.75 + 1.0 + 1.0) / 3 * 100
    expect(score.alignmentScore).toBeCloseTo(((0.75 + 1 + 1) / 3) * 100);
  });

  it("does not let disagreeing components change netDirection when the majority strength wins", () => {
    const score = computeInstitutionalFlowScore({
      fundingDivergence: null,
      crossVenueWalls: null,
      hyperliquidWhale: whale({ netLongWallets: 1, netShortWallets: 3, confidencePct: 0.75 }), // SHORT, strength 0.75
      cftcTrend: cftcTrend({ direction: "RISING", levNetPctChange: 2 }), // LONG, strength 0.2 (below deadband-adjacent but still LONG per direction field)
    });
    expect(score.netDirection).toBe("SHORT"); // 0.75 short-strength beats 0.2 long-strength
  });

  it("flags funding divergence at/above the 0.1% threshold without affecting directional votes", () => {
    const score = computeInstitutionalFlowScore({
      fundingDivergence: divergence(0.001),
      crossVenueWalls: null,
      hyperliquidWhale: null,
      cftcTrend: null,
    });
    expect(score.fundingDivergenceFlag).toBe(true);
    expect(score.fundingDivergenceNote).toContain("tidak sepakat");
  });

  it("does not flag funding divergence below the threshold", () => {
    const score = computeInstitutionalFlowScore({
      fundingDivergence: divergence(0.0005),
      crossVenueWalls: null,
      hyperliquidWhale: null,
      cftcTrend: null,
    });
    expect(score.fundingDivergenceFlag).toBe(false);
    expect(score.fundingDivergenceNote).toBeNull();
  });
});
