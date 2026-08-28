import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setProxyConfig, getCurrentFundingRateNative, getAllTicker24hrNative, getKlinesNative, BinanceProxyError } from "./binanceProxyClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const fundingBody = {
  symbol: "BTCUSDT",
  markPrice: "50000",
  indexPrice: "50000",
  estimatedSettlePrice: "50000",
  lastFundingRate: "0.0001",
  nextFundingTime: 0,
  interestRate: "0.0001",
  time: 0,
};

describe("binanceProxyClient proxy failover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setProxyConfig(undefined, undefined);
  });

  it("throws immediately when primary is not configured, even with direct fallback enabled", async () => {
    // Direct fallback only kicks in AFTER a configured primary fails -- it's
    // not a substitute for setup, so the "PROXY_URL belum diset" error must
    // stay clear for deployments that simply forgot to set secrets.
    await expect(getCurrentFundingRateNative("BTCUSDT")).rejects.toThrow(BinanceProxyError);
  });

  it("falls over to the direct Binance endpoint when primary fails and no secondary is configured", async () => {
    setProxyConfig("https://primary.example", "secret1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ msg: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse(fundingBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCurrentFundingRateNative("BTCUSDT");
    expect(result.lastFundingRate).toBe("0.0001");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const directUrl = String(fetchMock.mock.calls[1][0]);
    expect(directUrl).toContain("https://fapi.binance.com/fapi/v1/premiumIndex");
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string> | undefined)?.["x-proxy-secret"]).toBeUndefined();
  });

  it("does NOT use direct fallback when explicitly disabled", async () => {
    setProxyConfig("https://primary.example", "secret1", undefined, undefined, false);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ msg: "forbidden" }, 403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentFundingRateNative("BTCUSDT")).rejects.toThrow(BinanceProxyError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails over to secondary on a 403 (WAF block) from primary", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ msg: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse(fundingBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCurrentFundingRateNative("BTCUSDT");
    expect(result.lastFundingRate).toBe("0.0001");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("secondary.example");
  });

  it("falls over to secondary then direct when primary AND secondary both fail", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ msg: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse({ msg: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse(fundingBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCurrentFundingRateNative("BTCUSDT");
    expect(result.lastFundingRate).toBe("0.0001");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("https://fapi.binance.com");
  });

  it("falls over on 401 (wrong secret) -- a bad primary secret doesn't imply the secondary's is bad too", async () => {
    setProxyConfig("https://primary.example", "wrong-secret", "https://secondary.example", "secret2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ msg: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(fundingBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCurrentFundingRateNative("BTCUSDT");
    expect(result.lastFundingRate).toBe("0.0001");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls over on 402 (Vercel primary disabled for billing) -- secondary account is unaffected", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: "402", message: "Payment required" } }, 402))
      .mockResolvedValueOnce(jsonResponse(fundingBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCurrentFundingRateNative("BTCUSDT");
    expect(result.lastFundingRate).toBe("0.0001");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("secondary.example");
  });

  it("fails over to the other endpoint on a 418 (Binance IP rate-ban) from primary", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: -1003, msg: "IP banned" }, 418))
      .mockResolvedValueOnce(jsonResponse(fundingBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCurrentFundingRateNative("BTCUSDT");
    expect(result.lastFundingRate).toBe("0.0001");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("secondary.example");
  });

  it("round-robins the first-tried endpoint across calls when both are configured", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(fundingBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    await getCurrentFundingRateNative("BTCUSDT");
    await getCurrentFundingRateNative("BTCUSDT");
    await getCurrentFundingRateNative("BTCUSDT");
    await getCurrentFundingRateNative("BTCUSDT");

    const firstHosts = fetchMock.mock.calls.map((c) => new URL(String(c[0])).host);
    // alternating: primary, secondary, primary, secondary
    expect(firstHosts).toEqual([
      "primary.example",
      "secondary.example",
      "primary.example",
      "secondary.example",
    ]);
  });

  it("still falls back to the other endpoint when the round-robin-selected one fails", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    // call #1 tries primary first (ok). call #2 tries secondary first (fails 500) -> primary.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fundingBody, 200))
      .mockResolvedValueOnce(jsonResponse({ msg: "err" }, 500))
      .mockResolvedValueOnce(jsonResponse(fundingBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    await getCurrentFundingRateNative("BTCUSDT");
    await getCurrentFundingRateNative("BTCUSDT");
    expect(new URL(String(fetchMock.mock.calls[1][0])).host).toBe("secondary.example");
    expect(new URL(String(fetchMock.mock.calls[2][0])).host).toBe("primary.example");
  });

  it("does NOT fail over on a non-retriable 400 (would fail identically on any tier)", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ msg: "bad symbol" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentFundingRateNative("BTCUSDT")).rejects.toThrow(BinanceProxyError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once (same tier, no failover) when the proxy body is not valid JSON, then succeeds", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const klineRow: [number, string, string, string, string, string, number, string, number, string, string, string] = [
      1000, "1", "2", "0.5", "1.5", "10", 1999, "10", 5, "5", "5", "0",
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("[[1000,\"1\",\"2\",\"0.5\",\"1.5\",\"10\",1999,\"10\",5,\"5\",\"5\",\"0\"],[trunca", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse([klineRow], 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getKlinesNative("BTCUSDT", "1h", 50);

    expect(result).toEqual([klineRow]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Same tier both times (primary), not a failover to secondary/direct.
    expect(String(fetchMock.mock.calls[0][0])).toContain("primary.example");
    expect(String(fetchMock.mock.calls[1][0])).toContain("primary.example");
  });

  it("throws BinanceProxyError when the retry also gets an invalid JSON body", async () => {
    setProxyConfig("https://primary.example", "secret1");
    const fetchMock = vi.fn().mockImplementation(async () => new Response("not json at all", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getKlinesNative("BTCUSDT", "1h", 50)).rejects.toThrow(BinanceProxyError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails over to secondary after primary's network-error retries are exhausted", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down")) // primary: initial + 3 retries
      .mockResolvedValueOnce(jsonResponse(fundingBody, 200)); // secondary succeeds
    vi.stubGlobal("fetch", fetchMock);

    const promise = getCurrentFundingRateNative("BTCUSDT");
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);
    const result = await promise;

    expect(result.lastFundingRate).toBe("0.0001");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe("getAllTicker24hrNative", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setProxyConfig(undefined, undefined);
  });

  it("calls the ticker/24hr endpoint without a symbol param and returns the full array", async () => {
    setProxyConfig("https://primary.example", "secret1");
    const allTickers = [
      { symbol: "BTCUSDT", quoteVolume: "1000" },
      { symbol: "ETHUSDT", quoteVolume: "500" },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(allTickers, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getAllTicker24hrNative();

    expect(result).toEqual(allTickers);
    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(calledUrl.searchParams.get("path")).toBe("/fapi/v1/ticker/24hr");
    expect(calledUrl.searchParams.has("symbol")).toBe(false);
  });
});
