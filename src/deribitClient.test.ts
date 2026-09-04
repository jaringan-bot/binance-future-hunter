import { describe, it, expect, vi, afterEach } from "vitest";
import { getOptionsSummary, computeOptionsPositioning, type DeribitOptionInstrument } from "./deribitClient.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function instrument(name: string, openInterest: number, volume = 0): DeribitOptionInstrument {
  return {
    instrument_name: name,
    open_interest: openInterest,
    volume,
    mark_price: 0.01,
    bid_price: 0.009,
    ask_price: 0.011,
  };
}

describe("getOptionsSummary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches Deribit book summary for BTC options and returns the result array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        result: [instrument("BTC-26MAR27-100000-C", 10), instrument("BTC-26MAR27-100000-P", 5)],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const list = await getOptionsSummary("BTC");
    expect(list).toHaveLength(2);
    expect(list[0].instrument_name).toBe("BTC-26MAR27-100000-C");

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("www.deribit.com/api/v2/public/get_book_summary_by_currency");
    expect(url).toContain("currency=BTC");
    expect(url).toContain("kind=option");
  });

  it("throws on non-ok HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("err", false, 503)));
    await expect(getOptionsSummary("ETH")).rejects.toThrow("Deribit HTTP 503");
  });

  it("throws when jsonrpc error is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ jsonrpc: "2.0", error: { code: 10001, message: "bad" }, result: null })),
    );
    await expect(getOptionsSummary("BTC")).rejects.toThrow("Deribit");
  });
});

describe("computeOptionsPositioning", () => {
  it("aggregates put/call OI from instrument_name suffix -P/-C (no option_type field)", () => {
    const out = computeOptionsPositioning([
      instrument("BTC-4SEP26-100000-C", 100),
      instrument("BTC-4SEP26-100000-P", 40),
      instrument("BTC-25DEC26-120000-C", 50),
      instrument("BTC-25DEC26-120000-P", 20),
      instrument("BTC-PERPETUAL", 999), // ignored — not -C/-P
    ]);
    expect(out.instrumentCount).toBe(4);
    expect(out.callCount).toBe(2);
    expect(out.putCount).toBe(2);
    expect(out.totalCallOi).toBe(150);
    expect(out.totalPutOi).toBe(60);
    expect(out.putCallRatio).toBeCloseTo(60 / 150);
    expect(out.totalVolume).toBe(0);
  });

  it("returns putCallRatio null when call OI is zero (no divide-by-zero)", () => {
    const out = computeOptionsPositioning([instrument("ETH-4SEP26-3000-P", 10)]);
    expect(out.totalCallOi).toBe(0);
    expect(out.totalPutOi).toBe(10);
    expect(out.putCallRatio).toBeNull();
  });

  it("handles empty instrument list", () => {
    const out = computeOptionsPositioning([]);
    expect(out).toMatchObject({
      instrumentCount: 0,
      callCount: 0,
      putCount: 0,
      totalCallOi: 0,
      totalPutOi: 0,
      putCallRatio: null,
      totalVolume: 0,
    });
  });
});
