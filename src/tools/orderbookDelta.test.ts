import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  compareOrderBookSnapshots,
  calculateSpoofingScoreFromDelta,
  fetchOrderBookDelta,
  WALL_VANISH_THRESHOLD_PCT,
} from "./orderbookDelta.js";
import * as binanceProxy from "../binanceProxyClient.js";

describe("compareOrderBookSnapshots", () => {
  it("marks a wall HELD when qty barely shrinks (-10%)", () => {
    // median of [10,10,10,100] = 10, so 100 qualifies as a wall (>=2x median=20)
    const snap1 = { bids: [["100", "100"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [] as [string, string][] };
    const snap2 = { bids: [["100", "90"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [] as [string, string][] };
    const result = compareOrderBookSnapshots(snap1, snap2);
    expect(result.wallDeltas).toHaveLength(1);
    expect(result.wallDeltas[0].status).toBe("HELD");
    expect(result.wallDeltas[0].changePct).toBeCloseTo(-10, 5);
  });

  it("marks a wall SPOOFED when qty vanishes entirely and price did not cross it", () => {
    const snap1 = { bids: [["100", "100"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [] as [string, string][] };
    const snap2 = { bids: [["99.5", "10"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [] as [string, string][] };
    const result = compareOrderBookSnapshots(snap1, snap2);
    const wall = result.wallDeltas.find((w) => w.price === 100)!;
    expect(wall.status).toBe("SPOOFED");
    expect(wall.qty2).toBe(0);
    expect(wall.changePct).toBe(-100);
  });

  it("marks a wall SPOOFED at exactly the -70% boundary (inclusive)", () => {
    const snap1 = { bids: [["100", "100"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [] as [string, string][] };
    const snap2 = { bids: [["100", "30"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [] as [string, string][] };
    const result = compareOrderBookSnapshots(snap1, snap2);
    const wall = result.wallDeltas.find((w) => w.price === 100)!;
    expect(wall.changePct).toBeCloseTo(-70, 5);
    expect(wall.status).toBe("SPOOFED");
  });

  it("marks a wall HELD at -69% (just above the boundary)", () => {
    const snap1 = { bids: [["100", "100"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [] as [string, string][] };
    const snap2 = { bids: [["100", "31"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [] as [string, string][] };
    const result = compareOrderBookSnapshots(snap1, snap2);
    const wall = result.wallDeltas.find((w) => w.price === 100)!;
    expect(wall.changePct).toBeCloseTo(-69, 5);
    expect(wall.status).toBe("HELD");
  });

  it("marks a wall PRICE_MOVED_THROUGH when the OPPOSITE side actually trades through the wall's price", () => {
    // Bid wall at 100 vanishes AND the ask side also drops to 99 (<=100) --
    // strong evidence the market genuinely traded down through 100, not
    // just that a resting order was cancelled.
    const snap1 = { bids: [["100", "100"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [["101", "10"]] as [string, string][] };
    const snap2 = { bids: [["98.5", "50"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [["99", "10"]] as [string, string][] };
    const result = compareOrderBookSnapshots(snap1, snap2);
    const wall = result.wallDeltas.find((w) => w.price === 100)!;
    expect(wall.status).toBe("PRICE_MOVED_THROUGH");
  });

  it("marks a wall SPOOFED (not PRICE_MOVED_THROUGH) when it vanishes from the top of book but the opposite side hasn't moved", () => {
    // Bid wall at 100 (the best bid) vanishes -- best bid necessarily drops
    // to the next level (98.5) purely from the cancellation itself, but the
    // ASK side is unchanged, so nothing actually traded through 100.
    const snap1 = { bids: [["100", "100"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [["101", "10"]] as [string, string][] };
    const snap2 = { bids: [["98.5", "5"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [["101", "10"]] as [string, string][] };
    const result = compareOrderBookSnapshots(snap1, snap2);
    const wall = result.wallDeltas.find((w) => w.price === 100)!;
    expect(wall.status).toBe("SPOOFED");
  });

  it("returns empty wallDeltas when snapshot 1 has no wall candidates", () => {
    const snap1 = { bids: [["100", "10"], ["99", "10"], ["98", "10"]] as [string, string][], asks: [] as [string, string][] };
    const snap2 = { bids: [["100", "10"], ["99", "10"], ["98", "10"]] as [string, string][], asks: [] as [string, string][] };
    const result = compareOrderBookSnapshots(snap1, snap2);
    expect(result.wallDeltas).toEqual([]);
  });

  it("computes spread% for both snapshots", () => {
    const snap1 = { bids: [["100", "10"]] as [string, string][], asks: [["100.5", "10"]] as [string, string][] };
    const snap2 = { bids: [["100", "10"]] as [string, string][], asks: [["101", "10"]] as [string, string][] };
    const result = compareOrderBookSnapshots(snap1, snap2);
    expect(result.spreadPct1).toBeCloseTo(0.5, 5);
    expect(result.spreadPct2).toBeCloseTo(1, 5);
  });
});

describe("WALL_VANISH_THRESHOLD_PCT", () => {
  it("is -70", () => {
    expect(WALL_VANISH_THRESHOLD_PCT).toBe(-70);
  });
});

describe("calculateSpoofingScoreFromDelta", () => {
  it("scores 0.1 when there are no wall candidates at all", () => {
    const result = calculateSpoofingScoreFromDelta({ wallDeltas: [] });
    expect(result.score).toBe(0.1);
  });

  it("scores 0.1 when walls exist but none are spoofed", () => {
    const result = calculateSpoofingScoreFromDelta({
      wallDeltas: [
        { side: "bid", price: 100, qty1: 100, qty2: 95, changePct: -5, priceCrossed: false, status: "HELD" },
      ],
    });
    expect(result.score).toBe(0.1);
  });

  it("scores 0.9 when the largest wall is the one spoofed (high confidence)", () => {
    const result = calculateSpoofingScoreFromDelta({
      wallDeltas: [
        { side: "bid", price: 100, qty1: 100, qty2: 0, changePct: -100, priceCrossed: false, status: "SPOOFED" },
        { side: "ask", price: 105, qty1: 50, qty2: 45, changePct: -10, priceCrossed: false, status: "HELD" },
      ],
    });
    expect(result.score).toBe(0.9);
  });

  it("scores 0.5 when a secondary (non-largest) wall is spoofed but the largest held", () => {
    const result = calculateSpoofingScoreFromDelta({
      wallDeltas: [
        { side: "bid", price: 100, qty1: 100, qty2: 95, changePct: -5, priceCrossed: false, status: "HELD" },
        { side: "ask", price: 105, qty1: 50, qty2: 0, changePct: -100, priceCrossed: false, status: "SPOOFED" },
      ],
    });
    expect(result.score).toBe(0.5);
  });
});

describe("fetchOrderBookDelta", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fetches 2 snapshots with a delay between them and compares them", async () => {
    const snap1 = { lastUpdateId: 1, E: 1, T: 1, bids: [["100", "100"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [] as [string, string][] };
    const snap2 = { lastUpdateId: 2, E: 2, T: 2, bids: [["99.5", "10"], ["99", "10"], ["98", "10"], ["97", "10"]] as [string, string][], asks: [] as [string, string][] };
    const spy = vi
      .spyOn(binanceProxy, "getOrderBookDepth")
      .mockResolvedValueOnce(snap1)
      .mockResolvedValueOnce(snap2);

    const resultPromise = fetchOrderBookDelta("BTCUSDT", 20, 1500);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await resultPromise;

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, "BTCUSDT", 20);
    expect(spy).toHaveBeenNthCalledWith(2, "BTCUSDT", 20);
    expect(result.wallDeltas.find((w) => w.price === 100)?.status).toBe("SPOOFED");
  });
});
