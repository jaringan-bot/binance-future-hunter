import { describe, it, expect, vi, afterEach } from "vitest";
import * as binanceProxy from "./binanceProxyClient.js";
import { RateLimitError } from "./rateLimiter.js";
import { fetchAggTradesForWindow } from "./aggTradesPaginator.js";
import type { AggTrade } from "./binanceProxyClient.js";

vi.mock("./binanceProxyClient.js", () => ({
  getAggTradesRange: vi.fn(),
  getSpotAggTradesRange: vi.fn(),
}));

function trade(a: number, T: number): AggTrade {
  return { a, p: "100", q: "1", f: a, l: a, T, m: false };
}

function fullPage(startA: number, startT: number): AggTrade[] {
  return Array.from({ length: 1000 }, (_, i) => trade(startA + i, startT + i));
}

describe("fetchAggTradesForWindow", () => {
  afterEach(() => vi.resetAllMocks());

  it("completes normal pagination within the window (multiple full pages then a partial page)", async () => {
    const now = 10_000_000;
    // Page 1: full 1000, ends well before `now`. Page 2: partial, reaches `now`.
    const page1 = fullPage(0, 0);
    const page2 = [trade(1000, page1[999].T + 1), trade(1001, now)];
    vi.mocked(binanceProxy.getAggTradesRange).mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const result = await fetchAggTradesForWindow("BTCUSDT", "futures", 60, 150, now);

    expect(result.insufficientData).toBe(false);
    expect(result.pagesUsed).toBe(2);
    expect(result.trades.length).toBe(1002);
    expect(binanceProxy.getAggTradesRange).toHaveBeenNthCalledWith(1, "BTCUSDT", { startTime: now - 60 * 60_000, endTime: now, limit: 1000 });
    expect(binanceProxy.getAggTradesRange).toHaveBeenNthCalledWith(2, "BTCUSDT", { fromId: 1000, limit: 1000 });
  });

  it("returns insufficientData=true (not a silently partial window) when maxPages is hit before the window is covered", async () => {
    const now = 10_000_000;
    // Every page is full 1000 and never reaches `now` -- pagination would continue forever.
    let callCount = 0;
    vi.mocked(binanceProxy.getAggTradesRange).mockImplementation(async () => {
      const startA = callCount * 1000;
      const startT = callCount * 1000;
      callCount += 1;
      return fullPage(startA, startT); // last T is always far below `now`
    });

    const result = await fetchAggTradesForWindow("BTCUSDT", "futures", 60, 3, now);

    expect(result.insufficientData).toBe(true);
    expect(result.pagesUsed).toBe(3);
    // Data collected so far is still returned, but callers must check the flag first.
    expect(result.trades.length).toBe(3000);
  });

  it("throws on a malformed (non-array) page response instead of silently proceeding", async () => {
    vi.mocked(binanceProxy.getAggTradesRange).mockResolvedValueOnce({ error: "not an array" } as never);

    await expect(fetchAggTradesForWindow("BTCUSDT", "futures", 60, 150, 10_000_000)).rejects.toThrow(/bukan array/);
  });

  it("backs off and retries on RateLimitError instead of bypassing the shared limiter", async () => {
    const now = 10_000_000;
    const singlePage = [trade(0, now - 1000), trade(1, now)];
    vi.mocked(binanceProxy.getAggTradesRange)
      .mockRejectedValueOnce(new RateLimitError(1800))
      .mockRejectedValueOnce(new RateLimitError(1800))
      .mockResolvedValueOnce(singlePage);

    const result = await fetchAggTradesForWindow("BTCUSDT", "futures", 60, 150, now);

    expect(result.insufficientData).toBe(false);
    expect(result.trades).toEqual(singlePage);
    expect(binanceProxy.getAggTradesRange).toHaveBeenCalledTimes(3);
  });

  it("gives up and rethrows after exhausting rate-limit retries", async () => {
    vi.mocked(binanceProxy.getAggTradesRange).mockRejectedValue(new RateLimitError(1800));

    await expect(fetchAggTradesForWindow("BTCUSDT", "futures", 60, 150, 10_000_000)).rejects.toThrow(RateLimitError);
  });

  it("stops paginating exactly at the window boundary rather than over-fetching (does not call for a 3rd page once the boundary is reached)", async () => {
    const now = 10_000_000;
    const page1 = fullPage(0, 0); // full page, last T < now
    // page2 crosses the boundary: half inside, half beyond `now`.
    const page2 = [
      trade(1000, page1[999].T + 1),
      trade(1001, now), // exactly at boundary, still in range
      trade(1002, now + 5000), // beyond window -- must be excluded, and pagination must stop here
    ];
    vi.mocked(binanceProxy.getAggTradesRange).mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const result = await fetchAggTradesForWindow("BTCUSDT", "futures", 60, 150, now);

    expect(binanceProxy.getAggTradesRange).toHaveBeenCalledTimes(2);
    expect(result.trades.length).toBe(1002); // page1 (1000) + the 2 in-range trades from page2
    expect(result.trades[result.trades.length - 1].T).toBe(now);
    expect(result.insufficientData).toBe(false);
  });

  it("dispatches to the spot range function when market is 'spot'", async () => {
    const now = 10_000_000;
    const page = [trade(0, now - 1000), trade(1, now)];
    vi.mocked(binanceProxy.getSpotAggTradesRange).mockResolvedValueOnce(page);

    const result = await fetchAggTradesForWindow("BTCUSDT", "spot", 60, 150, now);

    expect(binanceProxy.getSpotAggTradesRange).toHaveBeenCalledTimes(1);
    expect(binanceProxy.getAggTradesRange).not.toHaveBeenCalled();
    expect(result.trades).toEqual(page);
  });
});
