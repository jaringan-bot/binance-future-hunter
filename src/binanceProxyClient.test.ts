import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setProxyConfig, getCurrentFundingRateNative, BinanceProxyError } from "./binanceProxyClient.js";

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

  it("throws the primary error directly when no secondary is configured", async () => {
    setProxyConfig("https://primary.example", "secret1");
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

  it("does NOT fail over on a non-retriable 400 (would fail identically on secondary)", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ msg: "bad symbol" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentFundingRateNative("BTCUSDT")).rejects.toThrow(BinanceProxyError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
