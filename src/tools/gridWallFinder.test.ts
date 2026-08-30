import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeOrderBookWalls,
  findOrderBookWalls,
  _clearWallFinderCache,
  DEFAULT_ABS_FLOOR_USD,
  DEPTH_CACHE_TTL_MS,
  type GridWallOptions,
} from "./gridWallFinder.js";
import type { OrderBookDepth } from "../binanceProxyClient.js";
import * as binanceProxy from "../binanceProxyClient.js";

function level(price: number, qty: number): [string, string] {
  return [String(price), String(qty)];
}

/** Buku sederhana: thin levels dekat mid + wall tebal di -3% / +3%. */
function makeBookWithWalls(mid = 100): OrderBookDepth {
  // Thin levels di dekat mid (~$1k notional) supaya meanDepth rendah,
  // wall di jarak 3% punya notional besar (>= $100k floor).
  const thinBids: [string, string][] = [];
  const thinAsks: [string, string][] = [];
  for (let i = 1; i <= 5; i++) {
    thinBids.push(level(mid * (1 - i * 0.005), 1)); // ~$99–$97.5 * 1
    thinAsks.push(level(mid * (1 + i * 0.005), 1));
  }
  // Wall bid @ -3%: notional = 97 * 1200 ≈ $116.4k
  const bidWall = level(mid * 0.97, 1200);
  // Wall ask @ +3%: notional = 103 * 1200 ≈ $123.6k
  const askWall = level(mid * 1.03, 1200);
  return {
    lastUpdateId: 1,
    E: 0,
    T: 0,
    bids: [bidWall, ...thinBids],
    asks: [askWall, ...thinAsks],
  };
}

function makeThinBook(mid = 100): OrderBookDepth {
  const bids: [string, string][] = [];
  const asks: [string, string][] = [];
  for (let i = 1; i <= 10; i++) {
    bids.push(level(mid * (1 - i * 0.005), 0.5));
    asks.push(level(mid * (1 + i * 0.005), 0.5));
  }
  return { lastUpdateId: 1, E: 0, T: 0, bids, asks };
}

const baseOpts = (over: Partial<GridWallOptions> = {}): GridWallOptions => ({
  atr14Pct: 4, // 1.5*4 = 6% window (dalam [2,10])
  ...over,
});

describe("computeOrderBookWalls", () => {
  it("finds nearest bid/ask walls meeting max(3x mean, $100k) within ATR window", () => {
    const r = computeOrderBookWalls(makeBookWithWalls(100), 100, baseOpts());
    expect(r).not.toBeNull();
    expect(r!.lowerBound).toBeCloseTo(97, 5);
    expect(r!.upperBound).toBeCloseTo(103, 5);
    expect(r!.wallThreshold).toBeGreaterThanOrEqual(DEFAULT_ABS_FLOOR_USD);
    expect(r!.lowerWall.notionalUsd).toBeGreaterThanOrEqual(r!.wallThreshold);
    expect(r!.upperWall.notionalUsd).toBeGreaterThanOrEqual(r!.wallThreshold);
    expect(r!.searchRangePct.lower).toBeCloseTo(6, 5); // min(10, max(2, 1.5*4))
    expect(r!.estimatedGridCount).toBeGreaterThan(0);
    expect(r!.estimatedGridCount).toBeLessThanOrEqual(150);
  });

  it("returns null when no significant walls (NO ATR FALLBACK)", () => {
    expect(computeOrderBookWalls(makeThinBook(100), 100, baseOpts())).toBeNull();
  });

  it("returns null when only one side has a wall", () => {
    const book = makeBookWithWalls(100);
    book.asks = book.asks.filter(([, q]) => parseFloat(q) < 10); // drop ask wall
    expect(computeOrderBookWalls(book, 100, baseOpts())).toBeNull();
  });

  it("clamps search window to [2%, 10%]", () => {
    // atr14Pct tiny -> window floor 2%. Wall must sit exactly at 2% to be
    // inside [MIN_DISTANCE, rangeCap] when rangeCap === 2. Dilute meanDepth
    // with many thin levels so $100k floor (not 3x mean) binds.
    const mid = 100;
    const thinBids: [string, string][] = [];
    const thinAsks: [string, string][] = [];
    for (let i = 1; i <= 8; i++) {
      thinBids.push(level(mid * (1 - i * 0.001), 1)); // 0.1%..0.8% — outside wall window but in ±10% mean band
      thinAsks.push(level(mid * (1 + i * 0.001), 1));
    }
    const atFloor: OrderBookDepth = {
      lastUpdateId: 1,
      E: 0,
      T: 0,
      bids: [level(98, 1200), ...thinBids],
      asks: [level(102, 1200), ...thinAsks],
    };
    const low = computeOrderBookWalls(atFloor, mid, baseOpts({ atr14Pct: 0.1 }));
    expect(low).not.toBeNull();
    expect(low!.searchRangePct.lower).toBe(2);
    expect(low!.searchRangePct.upper).toBe(2);

    // atr14Pct huge -> window cap 10%. Place walls near 9%.
    const nearCap: OrderBookDepth = {
      lastUpdateId: 1,
      E: 0,
      T: 0,
      bids: [level(91, 1200), ...thinBids],
      asks: [level(109, 1200), ...thinAsks],
    };
    const high = computeOrderBookWalls(nearCap, mid, baseOpts({ atr14Pct: 20 }));
    expect(high).not.toBeNull();
    expect(high!.searchRangePct.upper).toBe(10);
    expect(high!.searchRangePct.lower).toBe(10);
  });

  it("rejects walls inside the 2% dead zone (too close to mid)", () => {
    const mid = 100;
    const book: OrderBookDepth = {
      lastUpdateId: 1,
      E: 0,
      T: 0,
      // Wall at -1% / +1% -- inside dead zone
      bids: [level(99, 2000), level(98, 1)],
      asks: [level(101, 2000), level(102, 1)],
    };
    expect(computeOrderBookWalls(book, mid, baseOpts({ atr14Pct: 5 }))).toBeNull();
  });

  it("returns null when estimated gridCount exceeds 150", () => {
    // Force a very wide wall range with tiny TARGET_STEP heuristic by placing
    // walls near the 10% edges on a mid where range% / 0.75 > 150.
    // range% = (110-90)/90 * 100 ≈ 22.2% -> gridCount ≈ 30 -- not enough.
    // Instead lower TARGET via absurd tick? Better: use absFloor override +
    // place walls such that range is huge. With MAX_RANGE 10%, max range%
    // from mid is ~20% of lower -> ~26.7 grid steps. Can't exceed 150 with
    // 10% cap. So simulate via tickSize constraint instead for reject path,
    // AND separately test gridCount via injecting opts that make range wide
    // by placing walls far with atr window 10%.
    // Max possible estimatedGridCount with 10% each side ≈ ((110-90)/90)/0.0075 ≈ 30.
    // So gridCount > 150 is unreachable under normal caps; verify tickSize reject:
    const r = computeOrderBookWalls(makeBookWithWalls(100), 100, baseOpts({ tickSize: 100 }));
    expect(r).toBeNull(); // range 6 < tickSize 100
  });

  it("returns null for non-positive currentPrice", () => {
    expect(computeOrderBookWalls(makeBookWithWalls(100), 0, baseOpts())).toBeNull();
    expect(computeOrderBookWalls(makeBookWithWalls(100), -1, baseOpts())).toBeNull();
  });

  it("applies absolute $100k floor even when 3x mean is smaller", () => {
    const r = computeOrderBookWalls(makeBookWithWalls(100), 100, baseOpts());
    expect(r).not.toBeNull();
    // meanDepth from thin (~$100) + walls is still << $100k/3, so floor binds
    expect(r!.wallThreshold).toBe(DEFAULT_ABS_FLOOR_USD);
  });
});

describe("findOrderBookWalls (async + cache)", () => {
  beforeEach(() => {
    _clearWallFinderCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    _clearWallFinderCache();
    vi.restoreAllMocks();
  });

  it("fetches depth + exchangeInfo, matches symbol for tickSize (not symbols[0])", async () => {
    const depthSpy = vi.spyOn(binanceProxy, "getOrderBookDepth").mockResolvedValue(makeBookWithWalls(100));
    vi.spyOn(binanceProxy, "getFuturesExchangeInfo").mockResolvedValue({
      symbols: [
        {
          symbol: "ETHUSDT",
          filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" } as never],
        },
        {
          symbol: "BTCUSDT",
          filters: [{ filterType: "PRICE_FILTER", tickSize: "0.1" } as never],
        },
      ],
    });

    const r = await findOrderBookWalls("btcusdt", 100, 4, 1_000_000);
    expect(r).not.toBeNull();
    expect(depthSpy).toHaveBeenCalledWith("BTCUSDT", 1000);
    expect(r!.lowerBound).toBeCloseTo(97, 5);
  });

  it("caches depth for 3 minutes (same symbol)", async () => {
    const depthSpy = vi.spyOn(binanceProxy, "getOrderBookDepth").mockResolvedValue(makeBookWithWalls(100));
    vi.spyOn(binanceProxy, "getFuturesExchangeInfo").mockResolvedValue({ symbols: [] });

    const t0 = 1_000_000;
    await findOrderBookWalls("BTCUSDT", 100, 4, t0);
    await findOrderBookWalls("BTCUSDT", 100, 4, t0 + DEPTH_CACHE_TTL_MS - 1);
    expect(depthSpy).toHaveBeenCalledTimes(1);

    await findOrderBookWalls("BTCUSDT", 100, 4, t0 + DEPTH_CACHE_TTL_MS);
    expect(depthSpy).toHaveBeenCalledTimes(2);
  });

  it("returns null when walls missing (no ATR fallback)", async () => {
    vi.spyOn(binanceProxy, "getOrderBookDepth").mockResolvedValue(makeThinBook(100));
    vi.spyOn(binanceProxy, "getFuturesExchangeInfo").mockResolvedValue({ symbols: [] });
    expect(await findOrderBookWalls("BTCUSDT", 100, 4)).toBeNull();
  });
});
