import { describe, it, expect, vi, afterEach } from "vitest";
import { findWallCandidates, scanWallCandidates } from "./wallTrackingCron.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { setD1Database } from "../d1Client.js";

// Minimal fake D1 for the scanWallCandidates() integration test -- same
// bind()-returns-new-instance semantics as the fuller fake in
// d1Client.wallTracking.test.ts, kept local since only INSERT is exercised here.
class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private rows: Record<string, unknown>[],
    private sql: string,
  ) {}
  bind(...args: unknown[]): FakeStatement {
    const s = new FakeStatement(this.rows, this.sql);
    s.args = args;
    return s;
  }
  async run() {
    const [symbol, capturedAt, side, price, qty, medianRatio] = this.args;
    this.rows.push({ symbol, capturedAt, side, price, qty, medianRatio });
    return { success: true };
  }
}
class FakeD1 {
  rows: Record<string, unknown>[] = [];
  prepare(sql: string) {
    return new FakeStatement(this.rows, sql);
  }
  async batch(statements: FakeStatement[]) {
    return Promise.all(statements.map((s) => s.run()));
  }
}

describe("findWallCandidates", () => {
  it("returns levels with qty >= 2x median", () => {
    const levels: [string, string][] = [
      ["100", "10"],
      ["99", "10"],
      ["98", "10"],
      ["97", "10"],
      ["96", "30"], // median of [10,10,10,10,30] = 10, 30 >= 2*10
    ];
    const result = findWallCandidates(levels);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ price: 96, qty: 30, medianRatio: 3 });
  });

  it("returns empty array when no level clears the 2x-median threshold", () => {
    const levels: [string, string][] = [
      ["100", "10"],
      ["99", "11"],
      ["98", "12"],
    ];
    expect(findWallCandidates(levels)).toEqual([]);
  });

  it("returns multiple candidates when several levels clear the threshold", () => {
    const levels: [string, string][] = [
      ["100", "5"],
      ["99", "5"],
      ["98", "50"],
      ["97", "5"],
      ["96", "40"],
    ];
    const result = findWallCandidates(levels);
    expect(result.map((r) => r.price).sort()).toEqual([96, 98]);
  });

  it("returns empty array when median is 0 (avoids division by zero)", () => {
    const levels: [string, string][] = [
      ["100", "0"],
      ["99", "0"],
      ["98", "5"],
    ];
    expect(findWallCandidates(levels)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(findWallCandidates([])).toEqual([]);
  });
});

describe("scanWallCandidates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setD1Database(undefined);
  });

  it("fetches depth, finds candidates per side, and inserts them into D1", async () => {
    const fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);

    vi.spyOn(binanceProxy, "getOrderBookDepth").mockResolvedValue({
      lastUpdateId: 1,
      E: 1,
      T: 1,
      bids: [
        ["100", "10"],
        ["99", "10"],
        ["98", "10"],
        ["97", "10"],
        ["96", "30"], // candidate: 30 >= 2 * median(10)
      ],
      asks: [
        ["101", "5"],
        ["102", "5"],
        ["103", "5"],
      ], // no candidate: all equal, none clears 2x median
    });

    await scanWallCandidates("BTCUSDT");

    expect(binanceProxy.getOrderBookDepth).toHaveBeenCalledWith("BTCUSDT", 20);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({ symbol: "BTCUSDT", side: "bid", price: 96, qty: 30 });
  });

  it("inserts nothing when neither side has a candidate", async () => {
    const fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);

    vi.spyOn(binanceProxy, "getOrderBookDepth").mockResolvedValue({
      lastUpdateId: 1,
      E: 1,
      T: 1,
      bids: [["100", "10"], ["99", "10"]],
      asks: [["101", "10"], ["102", "10"]],
    });

    await scanWallCandidates("ETHUSDT");
    expect(fake.rows).toHaveLength(0);
  });
});
