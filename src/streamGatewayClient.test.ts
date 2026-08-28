import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setStreamGatewayConfig,
  fetchLiquidations,
  fetchContractEvents,
  fetchStreamHealth,
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
});
