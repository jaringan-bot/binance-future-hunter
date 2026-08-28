import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRealtimeStreamTools } from "./realtimeStream.js";
import * as gw from "../streamGatewayClient.js";

vi.mock("../streamGatewayClient.js", () => ({
  fetchLiquidations: vi.fn(),
  fetchContractEvents: vi.fn(),
  StreamGatewayError: class StreamGatewayError extends Error {},
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

  it("registers both tools", () => {
    expect(handlers.has("binance_get_realtime_liquidations")).toBe(true);
    expect(handlers.has("binance_get_contract_events")).toBe(true);
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

  it("liquidations: a gateway error becomes an error result, not a throw", async () => {
    vi.mocked(gw.fetchLiquidations).mockRejectedValueOnce(new gw.StreamGatewayError("HTTP 502"));
    const r = await call("binance_get_realtime_liquidations", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("502");
  });

  it("contract events: returns parsed rows", async () => {
    const r = await call("binance_get_contract_events", {});
    const sc = r.structuredContent!;
    expect((sc.events as Array<Record<string, unknown>>)[0].symbol).toBe("NEWUSDT");
    expect((sc.events as Array<Record<string, unknown>>)[0].contractStatus).toBe("TRADING");
  });
});
