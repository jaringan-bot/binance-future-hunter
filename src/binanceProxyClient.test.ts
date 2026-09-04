import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setProxyConfig,
  getRelayEndpoints,
  getCurrentFundingRateNative,
  getAllTicker24hrNative,
  getKlinesNative,
  BinanceProxyError,
  resetTierCooldowns,
  recordTierCooldown,
  isTierCoolingDown,
  RELAY_COOLDOWN_MAX_MS,
} from "./binanceProxyClient.js";

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

  it("getRelayEndpoints reflects the configured relays (URL only, no secret), primary then secondary", () => {
    expect(getRelayEndpoints()).toEqual([]);
    setProxyConfig("https://primary.example", "s1");
    expect(getRelayEndpoints()).toEqual([{ label: "primary", url: "https://primary.example" }]);
    setProxyConfig("https://primary.example", "s1", "https://secondary.example", "s2");
    expect(getRelayEndpoints()).toEqual([
      { label: "primary", url: "https://primary.example" },
      { label: "secondary", url: "https://secondary.example" },
    ]);
    expect(JSON.stringify(getRelayEndpoints())).not.toContain("s1");
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

  it("on a 418 with no secondary, surfaces the 418 rather than failing over to direct", async () => {
    setProxyConfig("https://primary.example", "secret1"); // no secondary, direct enabled by default
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: -1003, msg: "IP banned" }, 418));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentFundingRateNative("BTCUSDT")).rejects.toThrow(/418/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // did NOT try direct
  });

  it("a 451 on the last relay tier does not fall through to direct", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: -1003 }, 418)) // primary banned
      .mockResolvedValueOnce(jsonResponse("<html>451</html>", 451)); // secondary geo-blocked
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentFundingRateNative("BTCUSDT")).rejects.toThrow(/451/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // primary + secondary, NOT direct
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

  it("fails over on a 404 (relay deployment vanished, e.g. Deno DEPLOYMENT_NOT_FOUND) instead of throwing and killing the whole tick", async () => {
    // Incident 2026-08-28: secondary relay's Deno deployment was deleted, the
    // Worker got 404 from the platform. 404 was not in the old allowlist ->
    // callProxy threw immediately without trying the other tier.
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ msg: "Not Found (DEPLOYMENT_NOT_FOUND)" }, 404))
      .mockResolvedValueOnce(jsonResponse(fundingBody, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCurrentFundingRateNative("BTCUSDT");
    expect(result.lastFundingRate).toBe("0.0001");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("secondary.example");
  });

  it("a 404 on the last relay tier does not fall through to direct (would just hit the WAF 403)", async () => {
    setProxyConfig("https://primary.example", "secret1", "https://secondary.example", "secret2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: -1003 }, 418)) // primary banned
      .mockResolvedValueOnce(jsonResponse({ msg: "DEPLOYMENT_NOT_FOUND" }, 404)); // secondary gone
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentFundingRateNative("BTCUSDT")).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // primary + secondary, NOT direct
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

// ─────────────────────────────────────────────────────────────
// PER-RELAY COOLDOWN (2026-09-04, Stage 1 signal-integrity)
//
// Cacat yang ditutup: 418/429 ada di FAILOVER_STATUS, jadi relay-1 yang
// kena IP weight-ban langsung melempar SELURUH bebannya ke relay-2 -- yang
// lalu ikut kena ban. Tidak ada memori bahwa sebuah relay baru saja
// disuruh berhenti.
// ─────────────────────────────────────────────────────────────
describe("per-relay cooldown after 418/429", () => {
  beforeEach(() => {
    resetTierCooldowns();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setProxyConfig(undefined, undefined);
    resetTierCooldowns();
  });

  it("skips a relay that just returned 418 on the NEXT call instead of knocking again", async () => {
    setProxyConfig("https://primary.example", "s1", "https://secondary.example", "s2", false);
    // Body sebuah Response cuma bisa dibaca SEKALI -- wajib factory per
    // panggilan, bukan satu objek yang dipakai ulang.
    const banned = () =>
      jsonResponse({ code: -1003, msg: "Way too many requests; IP(1.2.3.4) banned until 9999999999999." }, 418);
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(banned())) // call 1 -> tier A kena ban
      .mockImplementation(() => Promise.resolve(jsonResponse(fundingBody, 200))); // sisanya sehat
    vi.stubGlobal("fetch", fetchMock);

    // Call 1: tier A kena 418, failover ke tier B, sukses.
    await getCurrentFundingRateNative("BTCUSDT");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bannedUrl = String(fetchMock.mock.calls[0][0]);

    // Call 2: tier yang kena ban HARUS di-skip, bukan dicoba lagi.
    await getCurrentFundingRateNative("ETHUSDT");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const thirdUrl = String(fetchMock.mock.calls[2][0]);
    expect(new URL(thirdUrl).origin).not.toBe(new URL(bannedUrl).origin);
  });

  it("throws an explicit cooldown error instead of hammering when every tier is banned", async () => {
    setProxyConfig("https://primary.example", "s1", "https://secondary.example", "s2", false);
    const banned = () => jsonResponse({ code: -1003, msg: "IP banned until 9999999999999." }, 418);
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(banned()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentFundingRateNative("BTCUSDT")).rejects.toThrow(BinanceProxyError);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBe(2); // dua relay dicoba sekali masing-masing

    // Call kedua tidak boleh menyentuh jaringan sama sekali.
    await expect(getCurrentFundingRateNative("ETHUSDT")).rejects.toThrow(/cooldown/i);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it("records cooldown from Retry-After when the body carries no `banned until`", () => {
    const now = 1_000_000;
    recordTierCooldown("relay-x", now + 30_000, now);
    expect(isTierCoolingDown("relay-x", now + 29_000)).toBe(true);
    expect(isTierCoolingDown("relay-x", now + 31_000)).toBe(false);
  });

  it("never shortens an existing cooldown", () => {
    const now = 1_000_000;
    recordTierCooldown("relay-y", now + 120_000, now);
    recordTierCooldown("relay-y", now + 5_000, now);
    expect(isTierCoolingDown("relay-y", now + 100_000)).toBe(true);
  });

  it("caps an absurd `banned until` at RELAY_COOLDOWN_MAX_MS", () => {
    const now = 1_000_000;
    recordTierCooldown("relay-z", now + 99 * 3600_000, now);
    expect(isTierCoolingDown("relay-z", now + RELAY_COOLDOWN_MAX_MS - 1)).toBe(true);
    expect(isTierCoolingDown("relay-z", now + RELAY_COOLDOWN_MAX_MS + 1)).toBe(false);
  });
});
