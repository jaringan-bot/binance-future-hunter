import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setStreamGatewayConfig,
  fetchLiquidations,
  fetchContractEvents,
  fetchStreamHealth,
  watchOrderBook,
  fetchDepthDiff,
  StreamGatewayError,
} from "./streamGatewayClient.js";

const HEALTHY = {
  ok: true,
  connectedSince: 1000,
  lastMessageAgeMs: 2000,
  reconnectCount: 0,
  lastError: null,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("streamGatewayClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", undefined);
    setStreamGatewayConfig("https://relay.example", "sekret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the gateway origin + /stream path with the x-proxy-secret header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ events: [], meta: { count: 0, streamHealth: HEALTHY } }));
    await fetchLiquidations({ symbol: "BTCUSDT", limit: 20 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://relay.example/stream/liquidations?symbol=BTCUSDT&limit=20");
    expect((init.headers as Record<string, string>)["x-proxy-secret"]).toBe("sekret");
  });

  it("returns events + meta and degraded=false when the stream is fresh", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        events: [{ symbol: "BTCUSDT", notional_usd: 50000, trade_time: 5 }],
        meta: { count: 1, streamHealth: HEALTHY },
      }),
    );
    const r = await fetchLiquidations({});
    expect(r.events).toHaveLength(1);
    expect(r.degraded).toBe(false);
  });

  it("marks the result degraded (not empty) when the buffer is stale", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        events: [{ symbol: "BTCUSDT", notional_usd: 1, trade_time: 1 }],
        meta: { count: 1, streamHealth: { ...HEALTHY, lastMessageAgeMs: 999_999 } },
      }),
    );
    const r = await fetchLiquidations({});
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toMatch(/stale|degraded/i);
    expect(r.events).toHaveLength(1);
  });

  it("marks degraded when the gateway reports the WS is down", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ events: [], meta: { count: 0, streamHealth: { ...HEALTHY, ok: false, connectedSince: null } } }),
    );
    const r = await fetchLiquidations({});
    expect(r.degraded).toBe(true);
  });

  it("throws StreamGatewayError on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 502));
    await expect(fetchLiquidations({})).rejects.toBeInstanceOf(StreamGatewayError);
  });

  it("throws StreamGatewayError on a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(fetchContractEvents({})).rejects.toBeInstanceOf(StreamGatewayError);
  });

  it("throws StreamGatewayError when not configured", async () => {
    setStreamGatewayConfig(undefined, undefined);
    await expect(fetchStreamHealth()).rejects.toBeInstanceOf(StreamGatewayError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchContractEvents hits /stream/contract-events", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ events: [], meta: { count: 0, streamHealth: HEALTHY } }));
    await fetchContractEvents({ symbol: "NEWUSDT" });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://relay.example/stream/contract-events?symbol=NEWUSDT",
    );
  });

  // ── Task B: watchOrderBook (POST) + fetchDepthDiff ──────────────────

  it("watchOrderBook POSTs to /stream/watch with the symbol + secret", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, watching: true, symbol: "BTCUSDT", expiresAt: 9 }));
    const r = await watchOrderBook("btcusdt", 60000);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://relay.example/stream/watch");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ symbol: "BTCUSDT", ttlMs: 60000 });
    expect((init.headers as Record<string, string>)["x-proxy-secret"]).toBe("sekret");
    expect(r.ok).toBe(true);
  });

  it("watchOrderBook includes wallMinNotionalUsd in the body when given, omits it otherwise", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, watching: true, symbol: "BTCUSDT", wallMinNotionalUsd: 2_000_000 }));
    await watchOrderBook("BTCUSDT", undefined, 2_000_000);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ symbol: "BTCUSDT", wallMinNotionalUsd: 2_000_000 });

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await watchOrderBook("BTCUSDT");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ symbol: "BTCUSDT" });
  });

  it("watchOrderBook passes a non-2xx JSON body back as data (e.g. 429 max watches)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: "batas 8 watch bersamaan tercapai" }, 429));
    const r = await watchOrderBook("BTCUSDT");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/batas/);
  });

  it("watchOrderBook throws StreamGatewayError (not undefined) when the relay is unreachable / non-JSON", async () => {
    // SG-blocked relay: a plain-text error page, or an empty body
    fetchMock.mockResolvedValue(new Response("<html>522</html>", { status: 522 }));
    await expect(watchOrderBook("BTCUSDT")).rejects.toBeInstanceOf(StreamGatewayError);
  });

  it("watchOrderBook throws StreamGatewayError on a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("connection lost"));
    await expect(watchOrderBook("BTCUSDT")).rejects.toBeInstanceOf(StreamGatewayError);
  });

  it("watchOrderBook throws on 401/403 even with a JSON body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: "unauthorized" }, 401));
    await expect(watchOrderBook("BTCUSDT")).rejects.toMatchObject({ status: 401 });
  });

  it("fetchDepthDiff GETs /stream/depth-diff and flags watching:false as degraded", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ watching: false, symbol: "BTCUSDT", events: [], meta: { count: 0 } }));
    const r = await fetchDepthDiff("BTCUSDT", 100);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://relay.example/stream/depth-diff?symbol=BTCUSDT&sinceMs=100");
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toMatch(/watch/i);
  });

  it("fetchDepthDiff returns events + degraded=false for an active, fresh watch", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        watching: true,
        symbol: "BTCUSDT",
        expiresAt: 9,
        events: [{ seq: 1, ts: 5, side: "bid", price: 100, type: "WALL_APPEARED", qty: 3000, notionalUsd: 300000 }],
        meta: { count: 1, wsOk: true, lastMessageAgeMs: 200 },
      }),
    );
    const r = await fetchDepthDiff("BTCUSDT");
    expect(r.events).toHaveLength(1);
    expect(r.degraded).toBe(false);
  });

  it("fetchDepthDiff flags degraded when the per-symbol WS is not connected", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ watching: true, symbol: "BTCUSDT", events: [], meta: { count: 0, wsOk: false } }),
    );
    const r = await fetchDepthDiff("BTCUSDT");
    expect(r.degraded).toBe(true);
  });
});
