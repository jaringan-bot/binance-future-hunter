import { describe, it, expect, afterEach, vi } from "vitest";
import { setKvNamespace } from "./kvConfig.js";
import {
  recordNonWatchlistQuery,
  getTopQueriedNonWatchlistSymbols,
  MIN_QUERY_COUNT,
  TOP_N_NON_WATCHLIST,
} from "./queryFrequency.js";

class FakeKv {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async list(options: { prefix: string }) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(options.prefix)).map((name) => ({ name }));
    return { keys, list_complete: true, cacheStatus: null };
  }
}

class ThrowingKv {
  async get(): Promise<string | null> {
    throw new Error("KV unavailable");
  }
  async put(): Promise<void> {
    throw new Error("KV unavailable");
  }
  async list(): Promise<never> {
    throw new Error("KV unavailable");
  }
}

describe("recordNonWatchlistQuery", () => {
  afterEach(() => setKvNamespace(undefined));

  it("no-ops for a watchlist symbol (never writes to KV)", async () => {
    const fake = new FakeKv();
    setKvNamespace(fake as unknown as KVNamespace);
    await recordNonWatchlistQuery("BTCUSDT");
    expect(fake.store.size).toBe(0);
  });

  it("increments a counter for a non-watchlist symbol", async () => {
    const fake = new FakeKv();
    setKvNamespace(fake as unknown as KVNamespace);
    await recordNonWatchlistQuery("PEPEUSDT");
    await recordNonWatchlistQuery("PEPEUSDT");
    expect(fake.store.get("basis_query_count:PEPEUSDT")).toBe("2");
  });

  it("is case-insensitive (normalizes to uppercase)", async () => {
    const fake = new FakeKv();
    setKvNamespace(fake as unknown as KVNamespace);
    await recordNonWatchlistQuery("pepeusdt");
    expect(fake.store.get("basis_query_count:PEPEUSDT")).toBe("1");
  });

  it("swallows KV errors silently instead of throwing", async () => {
    setKvNamespace(new ThrowingKv() as unknown as KVNamespace);
    await expect(recordNonWatchlistQuery("PEPEUSDT")).resolves.toBeUndefined();
  });
});

describe("getTopQueriedNonWatchlistSymbols", () => {
  afterEach(() => setKvNamespace(undefined));

  it(`filters out symbols below MIN_QUERY_COUNT (${MIN_QUERY_COUNT}), sorts descending, caps at TOP_N_NON_WATCHLIST (${TOP_N_NON_WATCHLIST})`, async () => {
    const fake = new FakeKv();
    setKvNamespace(fake as unknown as KVNamespace);
    const seeds: [string, number][] = [
      ["PEPEUSDT", 10],
      ["WIFUSDT", 8],
      ["BONKUSDT", 7],
      ["FLOKIUSDT", 6],
      ["SHIBUSDT", 5],
      ["ORDIUSDT", 4],
      ["MEMEUSDT", 2], // below MIN_QUERY_COUNT, excluded
    ];
    for (const [symbol, count] of seeds) {
      await fake.put(`basis_query_count:${symbol}`, String(count));
    }

    const result = await getTopQueriedNonWatchlistSymbols();
    expect(result).toHaveLength(TOP_N_NON_WATCHLIST);
    expect(result.map((r) => r.symbol)).toEqual(["PEPEUSDT", "WIFUSDT", "BONKUSDT", "FLOKIUSDT", "SHIBUSDT"]);
    expect(result[0]).toEqual({ symbol: "PEPEUSDT", count: 10 });
  });

  it("returns an empty array when no counters exist", async () => {
    setKvNamespace(new FakeKv() as unknown as KVNamespace);
    expect(await getTopQueriedNonWatchlistSymbols()).toEqual([]);
  });

  it("returns an empty array (not a throw) when KV list fails", async () => {
    setKvNamespace(new ThrowingKv() as unknown as KVNamespace);
    expect(await getTopQueriedNonWatchlistSymbols()).toEqual([]);
  });
});
