// Test wall_tracking read/write path in d1Client.ts. No D1 test harness
// existed in the repo before this feature (miniflare/wrangler D1 isn't
// wired into vitest), so this hand-rolls a minimal fake D1Database covering
// only the queries d1Client.ts actually issues for wall_tracking, dispatched
// by matching the start of the SQL string.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setD1Database,
  insertWallCandidates,
  queryWallPersistence,
  pruneOldWallTracking,
} from "./d1Client.js";

interface FakeRow {
  symbol: string;
  captured_at: number;
  side: string;
  price: number;
  qty: number;
  median_ratio: number;
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}

  // Real D1's PreparedStatement.bind() returns a NEW bound statement rather
  // than mutating the one it was called on -- this matters because
  // insertWallCandidates() (like the existing insertSignalSnapshots) calls
  // .bind() multiple times on the SAME prepared statement, once per row.
  bind(...args: unknown[]): FakeStatement {
    const bound = new FakeStatement(this.db, this.sql);
    bound.args = args;
    return bound;
  }

  async run(): Promise<{ success: true }> {
    if (this.sql.startsWith("INSERT INTO wall_tracking")) {
      const [symbol, captured_at, side, price, qty, median_ratio] = this.args as [
        string,
        number,
        string,
        number,
        number,
        number,
      ];
      this.db.rows.push({ symbol, captured_at, side, price, qty, median_ratio });
      return { success: true };
    }
    if (this.sql.startsWith("DELETE FROM wall_tracking")) {
      const [cutoff] = this.args as [number];
      this.db.rows = this.db.rows.filter((r) => r.captured_at >= cutoff);
      return { success: true };
    }
    throw new Error(`FakeStatement.run: unhandled SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.startsWith("SELECT captured_at, qty FROM wall_tracking")) {
      const [symbol, side, lowPrice, highPrice, cutoff] = this.args as [string, string, number, number, number];
      const results = this.db.rows
        .filter(
          (r) =>
            r.symbol === symbol &&
            r.side === side &&
            r.price >= lowPrice &&
            r.price <= highPrice &&
            r.captured_at >= cutoff,
        )
        .sort((a, b) => a.captured_at - b.captured_at)
        .map((r) => ({ captured_at: r.captured_at, qty: r.qty }));
      return { results: results as T[] };
    }
    throw new Error(`FakeStatement.all: unhandled SQL: ${this.sql}`);
  }
}

class FakeD1 {
  rows: FakeRow[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<{ success: true }[]> {
    return Promise.all(statements.map((s) => s.run()));
  }
}

describe("wall_tracking D1 read/write path", () => {
  let fake: FakeD1;

  beforeEach(() => {
    fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);
  });

  afterEach(() => {
    setD1Database(undefined);
  });

  it("insertWallCandidates batch-inserts one row per candidate", async () => {
    await insertWallCandidates([
      { symbol: "BTCUSDT", capturedAt: 1000, side: "bid", price: 60000, qty: 5, medianRatio: 3 },
      { symbol: "BTCUSDT", capturedAt: 1000, side: "ask", price: 60100, qty: 4, medianRatio: 2.5 },
    ]);
    expect(fake.rows).toHaveLength(2);
    expect(fake.rows[0]).toMatchObject({ symbol: "BTCUSDT", side: "bid", price: 60000, qty: 5 });
  });

  it("insertWallCandidates is a no-op for an empty array (no batch call needed)", async () => {
    await insertWallCandidates([]);
    expect(fake.rows).toHaveLength(0);
  });

  it("queryWallPersistence filters by symbol, side, price tolerance band, and lookback window", async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    fake.rows = [
      { symbol: "BTCUSDT", captured_at: now - 4 * 60_000, side: "bid", price: 60000, qty: 10, median_ratio: 3 },
      { symbol: "BTCUSDT", captured_at: now - 3 * 60_000, side: "bid", price: 60000, qty: 8, median_ratio: 2.4 },
      { symbol: "BTCUSDT", captured_at: now - 3 * 60_000, side: "ask", price: 60000, qty: 8, median_ratio: 2.4 }, // wrong side
      { symbol: "ETHUSDT", captured_at: now - 3 * 60_000, side: "bid", price: 60000, qty: 8, median_ratio: 2.4 }, // wrong symbol
      { symbol: "BTCUSDT", captured_at: now - 3 * 60_000, side: "bid", price: 70000, qty: 8, median_ratio: 2.4 }, // outside price band
      { symbol: "BTCUSDT", captured_at: now - 20 * 60_000, side: "bid", price: 60000, qty: 99, median_ratio: 9 }, // outside lookback window
    ];

    try {
      // lookback window: 5 minutes -- covers the first two rows only.
      const points = await queryWallPersistence("BTCUSDT", "bid", 60000, 5);
      expect(points).toEqual([
        { capturedAt: now - 4 * 60_000, qty: 10 },
        { capturedAt: now - 3 * 60_000, qty: 8 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pruneOldWallTracking deletes rows older than the cutoff", async () => {
    fake.rows = [
      { symbol: "BTCUSDT", captured_at: 1000, side: "bid", price: 60000, qty: 10, median_ratio: 3 },
      { symbol: "BTCUSDT", captured_at: 5000, side: "bid", price: 60000, qty: 10, median_ratio: 3 },
    ];
    await pruneOldWallTracking(3000);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].captured_at).toBe(5000);
  });
});
