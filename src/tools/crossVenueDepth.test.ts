import { describe, it, expect } from "vitest";
import { findCrossVenueWalls, type VenueWallCandidate } from "./crossVenueDepth.js";

function wall(overrides: Partial<VenueWallCandidate>): VenueWallCandidate {
  return { venue: "Binance", side: "bid", price: 100, qty: 30, medianRatio: 3, ...overrides };
}

describe("findCrossVenueWalls", () => {
  it("corroborates walls on the same side within price tolerance across venues", () => {
    const candidates = [wall({ venue: "Binance", price: 100 }), wall({ venue: "Bybit", price: 100.05 })];
    const [a, b] = findCrossVenueWalls(candidates);
    expect(a.corroboratedBy).toEqual(["Bybit"]);
    expect(b.corroboratedBy).toEqual(["Binance"]);
  });

  it("does not corroborate walls on opposite sides even at the same price", () => {
    const candidates = [wall({ venue: "Binance", side: "bid", price: 100 }), wall({ venue: "Bybit", side: "ask", price: 100 })];
    const [a, b] = findCrossVenueWalls(candidates);
    expect(a.corroboratedBy).toEqual([]);
    expect(b.corroboratedBy).toEqual([]);
  });

  it("does not corroborate walls outside the price tolerance band", () => {
    const candidates = [wall({ venue: "Binance", price: 100 }), wall({ venue: "Bybit", price: 105 })];
    const [a, b] = findCrossVenueWalls(candidates);
    expect(a.corroboratedBy).toEqual([]);
    expect(b.corroboratedBy).toEqual([]);
  });

  it("lists multiple corroborating venues", () => {
    const candidates = [
      wall({ venue: "Binance", price: 100 }),
      wall({ venue: "Bybit", price: 100.02 }),
      wall({ venue: "OKX", price: 99.98 }),
    ];
    const [a] = findCrossVenueWalls(candidates);
    expect(a.corroboratedBy.sort()).toEqual(["Bybit", "OKX"]);
  });

  it("returns empty corroboratedBy for a single-venue-only wall", () => {
    const [a] = findCrossVenueWalls([wall({ venue: "Binance" })]);
    expect(a.corroboratedBy).toEqual([]);
  });
});
