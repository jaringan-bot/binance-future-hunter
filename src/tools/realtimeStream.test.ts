import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRealtimeStreamTools, wallThresholdForVolume } from "./realtimeStream.js";
import * as gw from "../streamGatewayClient.js";
import * as binanceProxy from "../binanceProxyClient.js";

vi.mock("../streamGatewayClient.js", () => ({
  fetchLiquidations: vi.fn(),
  fetchContractEvents: vi.fn(),
  watchOrderBook: vi.fn(),
  fetchDepthDiff: vi.fn(),
  StreamGatewayError: class StreamGatewayError extends Error {
    constructor(
      message: string,
      public readonly status?: number,
    ) {
      super(message);
      this.name = "StreamGatewayError";
    }
  },
}));
vi.mock("../binanceProxyClient.js", () => ({
  getTicker24hrNative: vi.fn(),
}));

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function mkLiqs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    symbol: i % 2 ? "ETHUSDT" : "BTCUSDT",
    side: i % 2 ? "BUY" : "SELL",
    price: 100 + i,
    orig_qty: 1 + i,
    avg_price: 100 + i,
    notional_usd: (100 + i) * (1 + i),
    order_status: "FILLED",
    event_time: 1000 + i,
    trade_time: 1000 + i,
  }));
}

describe("wallThresholdForVolume", () => {
  it("tiers by 24h quote volume, more permissive for thinner books", () => {
    expect(wallThresholdForVolume(30_000_000_000)).toBe(3_000_000); // mega BTC
    expect(wallThresholdForVolume(10_000_000_000)).toBe(3_000_000);
    expect(wallThresholdForVolume(5_000_000_000)).toBe(2_000_000); // ETH / quieter BTC
    expect(wallThresholdForVolume(2_000_000_000)).toBe(800_000); // SOL
    expect(wallThresholdForVolume(300_000_000)).toBe(350_000); // mid alt
    expect(wallThresholdForVolume(50_000_000)).toBe(150_000);
    expect(wallThresholdForVolume(5_000_000)).toBe(80_000); // micro
  });
  it("falls back to the old flat default for unknown/invalid volume", () => {
    expect(wallThresholdForVolume(undefined)).toBe(250_000);
    expect(wallThresholdForVolume(0)).toBe(250_000);
    expect(wallThresholdForVolume(Number.NaN)).toBe(250_000);
  });
  it("is monotonic — a thinner pair never gets a higher threshold", () => {
    const vols = [1e7, 5e7, 3e8, 2e9, 5e9, 1e10, 3e10];
    const thr = vols.map(wallThresholdForVolume);
    for (let i = 1; i < thr.length; i++) expect(thr[i]).toBeGreaterThanOrEqual(thr[i - 1]);
  });
});

describe("realtime stream tools", () => {
  let handlers: Map<string, { handler: ToolHandler; inputSchema: Record<string, z.ZodTypeAny> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gw.fetchLiquidations).mockResolvedValue({
      events: mkLiqs(20),
      meta: { count: 20, streamHealth: { ok: true, lastMessageAgeMs: 1000, connectedSince: 1, reconnectCount: 0, lastError: null } },
      degraded: false,
      degradedReason: null,
    });
    vi.mocked(gw.watchOrderBook).mockResolvedValue({
      ok: true,
      watching: true,
      symbol: "BTCUSDT",
      expiresAt: 1_700_000_300_000,
      renewed: false,
      wallMinNotionalUsd: 2_000_000,
    });
    vi.mocked(binanceProxy.getTicker24hrNative).mockResolvedValue({ quoteVolume: "30000000000" } as never);
    vi.mocked(gw.fetchDepthDiff).mockResolvedValue({
      watching: true,
      symbol: "BTCUSDT",
      expiresAt: 1_700_000_300_000,
      events: [
        { seq: 1, ts: 1_700_000_001_000, side: "bid", price: 100, type: "WALL_APPEARED", qty: 3000, notionalUsd: 300000 },
        { seq: 2, ts: 1_700_000_002_000, side: "ask", price: 110, type: "WALL_VANISHED", qty: 0, notionalUsd: 280000 },
      ],
      meta: { count: 2, wsOk: true },
      degraded: false,
      degradedReason: null,
    });
    vi.mocked(gw.fetchContractEvents).mockResolvedValue({
      events: [
        {
          symbol: "NEWUSDT", pair: "NEWUSDT", contract_type: "PERPETUAL", contract_status: "TRADING",
          delivery_date: 0, onboard_date: 1_700_000_000_000, event_time: 1_700_000_000_000, raw_json: "{}",
        },
      ],
      meta: { count: 1, streamHealth: { ok: true, lastMessageAgeMs: 1000, connectedSince: 1, reconnectCount: 0, lastError: null } },
      degraded: false,
      degradedReason: null,
    });

    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        handlers.set(name, { handler: cb as ToolHandler, inputSchema: config.inputSchema ?? {} });
        return {};
      },
    } as unknown as McpServer;
    registerRealtimeStreamTools(fakeServer);
  });

  function call(name: string, args: Record<string, unknown>) {
    const entry = handlers.get(name);
    if (!entry) throw new Error(`tool ${name} not registered`);
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("registers all three tools", () => {
    expect(handlers.has("binance_get_realtime_liquidations")).toBe(true);
    expect(handlers.has("binance_get_contract_events")).toBe(true);
    expect(handlers.has("binance_watch_orderbook_realtime")).toBe(true);
  });

  describe("binance_watch_orderbook_realtime", () => {
    it("arms/renews the watch then returns wall-lifecycle events", async () => {
      const r = await call("binance_watch_orderbook_realtime", { symbol: "BTCUSDT", ttlMs: 60000, sinceMs: 1 });
      // 3rd arg = volume-scaled threshold ($30B -> $3M mega tier)
      expect(gw.watchOrderBook).toHaveBeenCalledWith("BTCUSDT", 60000, 3_000_000);
      expect(gw.fetchDepthDiff).toHaveBeenCalledWith("BTCUSDT", 1);
      const sc = r.structuredContent!;
      expect(sc.armed).toBe(true);
      expect(sc.watching).toBe(true);
      expect(sc.eventCount).toBe(2);
      expect((sc.counts as Record<string, number>).WALL_APPEARED).toBe(1);
      expect((sc.counts as Record<string, number>).WALL_VANISHED).toBe(1);
      expect(sc.events).toBeUndefined();
      expect(Array.isArray(sc.recent)).toBe(true);
    });

    it("scales the wall threshold from 24h volume, and reports it", async () => {
      vi.mocked(binanceProxy.getTicker24hrNative).mockResolvedValueOnce({ quoteVolume: "150000000" } as never); // $150M -> $150k tier
      const r = await call("binance_watch_orderbook_realtime", { symbol: "ATOMUSDT" });
      expect(gw.watchOrderBook).toHaveBeenCalledWith("ATOMUSDT", undefined, 150_000);
      expect(r.structuredContent!.thresholdSource).toMatch(/volume-scaled/);
      expect(r.content[0].text).toMatch(/Ambang wall/);
    });

    it("an explicit wall_min_notional_usd overrides the volume scaling", async () => {
      const r = await call("binance_watch_orderbook_realtime", { symbol: "BTCUSDT", wall_min_notional_usd: 5_000_000 });
      expect(binanceProxy.getTicker24hrNative).not.toHaveBeenCalled();
      expect(gw.watchOrderBook).toHaveBeenCalledWith("BTCUSDT", undefined, 5_000_000);
      expect(r.structuredContent!.thresholdSource).toBe("explicit");
    });

    it("a failed ticker fetch falls back to the gateway default (undefined passed)", async () => {
      vi.mocked(binanceProxy.getTicker24hrNative).mockRejectedValueOnce(new Error("proxy down"));
      const r = await call("binance_watch_orderbook_realtime", { symbol: "BTCUSDT" });
      expect(gw.watchOrderBook).toHaveBeenCalledWith("BTCUSDT", undefined, undefined);
      expect(r.structuredContent!.thresholdSource).toBe("gateway-default");
      expect(r.isError).toBeUndefined();
    });

    it('detail:"full" includes the whole events array', async () => {
      const r = await call("binance_watch_orderbook_realtime", { symbol: "BTCUSDT", detail: "full" });
      expect((r.structuredContent!.events as unknown[]).length).toBe(2);
    });

    it("a first call that only arms the watch (no events yet) is not an error", async () => {
      vi.mocked(gw.watchOrderBook).mockResolvedValueOnce({ ok: true, watching: true, symbol: "BTCUSDT", expiresAt: 1, renewed: false });
      vi.mocked(gw.fetchDepthDiff).mockResolvedValueOnce({
        watching: true, symbol: "BTCUSDT", events: [], meta: { count: 0 }, degraded: false, degradedReason: null,
      });
      const r = await call("binance_watch_orderbook_realtime", { symbol: "BTCUSDT" });
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent!.eventCount).toBe(0);
      expect(r.content[0].text).toMatch(/diaktifkan/i);
    });

    it("max-watches (ok:false) degrades without isError", async () => {
      vi.mocked(gw.watchOrderBook).mockResolvedValueOnce({
        ok: false, error: "batas 8 watch bersamaan tercapai (VPS 1GB)", activeWatches: ["ETHUSDT"],
      });
      const r = await call("binance_watch_orderbook_realtime", { symbol: "BTCUSDT" });
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent!.degraded).toBe(true);
      expect(String(r.structuredContent!.degradedReason)).toMatch(/batas/);
      expect(gw.fetchDepthDiff).not.toHaveBeenCalled();
    });

    it("a StreamGatewayError (gateway not upgraded) degrades, not isError", async () => {
      vi.mocked(gw.watchOrderBook).mockRejectedValueOnce(new gw.StreamGatewayError("stream gateway HTTP 404", 404));
      const r = await call("binance_watch_orderbook_realtime", { symbol: "BTCUSDT" });
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent!.degraded).toBe(true);
      expect(r.structuredContent!.armed).toBe(false);
    });

    it("surfaces a degraded depth stream but still returns collected events", async () => {
      vi.mocked(gw.fetchDepthDiff).mockResolvedValueOnce({
        watching: true, symbol: "BTCUSDT", events: [
          { seq: 5, ts: 9, side: "bid", price: 1, type: "WALL_GREW", qty: 9, notionalUsd: 999999, changePct: 0.8 },
        ], meta: { count: 1 }, degraded: true, degradedReason: "tidak ada update depth ~45s",
      });
      const r = await call("binance_watch_orderbook_realtime", { symbol: "BTCUSDT" });
      expect(r.content[0].text.toLowerCase()).toContain("degraded");
      expect(r.structuredContent!.eventCount).toBe(1);
    });
  });

  it("liquidations: passes filters through to the gateway client", async () => {
    await call("binance_get_realtime_liquidations", { symbol: "BTCUSDT", limit: 50, minNotionalUsd: 10000 });
    expect(gw.fetchLiquidations).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BTCUSDT", limit: 50, minNotionalUsd: 10000 }),
    );
  });

  it("liquidations summary: aggregates without dumping the full array", async () => {
    const r = await call("binance_get_realtime_liquidations", {});
    const sc = r.structuredContent!;
    expect(sc.totalCount).toBe(20);
    expect(typeof sc.totalNotionalUsd).toBe("number");
    expect(sc.events).toBeUndefined();
    expect(Array.isArray(sc.recent)).toBe(true);
    expect((sc.recent as unknown[]).length).toBeLessThanOrEqual(15);
  });

  it('liquidations detail:"full" includes the whole array', async () => {
    const r = await call("binance_get_realtime_liquidations", { detail: "full" });
    expect((r.structuredContent!.events as unknown[]).length).toBe(20);
  });

  it("liquidations: surfaces a degraded-stream warning but still returns data", async () => {
    vi.mocked(gw.fetchLiquidations).mockResolvedValueOnce({
      events: mkLiqs(3),
      meta: {},
      degraded: true,
      degradedReason: "buffer is stale — no stream message for 800s",
    });
    const r = await call("binance_get_realtime_liquidations", {});
    expect(r.content[0].text.toLowerCase()).toContain("stale");
    expect((r.structuredContent!.recent as unknown[]).length).toBe(3);
    expect(r.structuredContent!.degraded).toBe(true);
  });

  it("liquidations: a gateway error degrades to an empty buffer, not isError", async () => {
    vi.mocked(gw.fetchLiquidations).mockRejectedValueOnce(new gw.StreamGatewayError("HTTP 502", 502));
    const r = await call("binance_get_realtime_liquidations", {});
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent!.degraded).toBe(true);
    expect(r.structuredContent!.totalCount).toBe(0);
    expect(String(r.structuredContent!.degradedReason)).toMatch(/502/);
  });

  it("liquidations: HTTP 401 degrades without isError", async () => {
    vi.mocked(gw.fetchLiquidations).mockRejectedValueOnce(new gw.StreamGatewayError("stream gateway HTTP 401", 401));
    const r = await call("binance_get_realtime_liquidations", {});
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent!.degraded).toBe(true);
    expect(String(r.structuredContent!.degradedReason)).toMatch(/401|PROXY_SECRET/);
  });

  it("contract events: HTTP 401 degrades without isError", async () => {
    vi.mocked(gw.fetchContractEvents).mockRejectedValueOnce(new gw.StreamGatewayError("stream gateway HTTP 401", 401));
    const r = await call("binance_get_contract_events", {});
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent!.degraded).toBe(true);
    expect(r.structuredContent!.count).toBe(0);
  });

  it("contract events: returns parsed rows", async () => {
    const r = await call("binance_get_contract_events", {});
    const sc = r.structuredContent!;
    expect((sc.events as Array<Record<string, unknown>>)[0].symbol).toBe("NEWUSDT");
    expect((sc.events as Array<Record<string, unknown>>)[0].contractStatus).toBe("TRADING");
  });
});
