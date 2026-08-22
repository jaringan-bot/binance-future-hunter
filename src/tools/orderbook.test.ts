import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOrderbookTools } from "./orderbook.js";
import * as binanceProxy from "../binanceProxyClient.js";
import type { OrderBookDepth } from "../binanceProxyClient.js";

vi.mock("../binanceProxyClient.js", () => ({
  getOrderBookDepth: vi.fn(),
}));

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function makeOrderBook(levels: number): OrderBookDepth {
  return {
    lastUpdateId: 1,
    E: 0,
    T: 0,
    bids: Array.from({ length: levels }, (_, i) => [String(100 - i), String(1 + i)] as [string, string]),
    asks: Array.from({ length: levels }, (_, i) => [String(101 + i), String(1 + i)] as [string, string]),
  };
}

describe("binance_get_order_book_depth detail param (summary vs full)", () => {
  let handlers: Map<string, { handler: ToolHandler; inputSchema: Record<string, z.ZodTypeAny> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(binanceProxy.getOrderBookDepth).mockResolvedValue(makeOrderBook(50));

    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        handlers.set(name, { handler: cb as ToolHandler, inputSchema: config.inputSchema ?? {} });
        return {};
      },
    } as unknown as McpServer;

    registerOrderbookTools(fakeServer);
  });

  function call(name: string, args: Record<string, unknown>) {
    const entry = handlers.get(name);
    if (!entry) throw new Error(`tool ${name} not registered`);
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("defaults to summary: no raw bids/asks array, only best bid/ask + spread", async () => {
    const result = await call("binance_get_order_book_depth", { symbol: "BTCUSDT", limit: 50 });

    const sc = result.structuredContent!;
    expect(sc.bids).toBeUndefined();
    expect(sc.asks).toBeUndefined();
    expect(sc.bestBid).toBeDefined();
    expect(sc.bestAsk).toBeDefined();
    expect(sc.spreadPct).toBeDefined();
  });

  it('detail: "full" returns the complete bids/asks arrays up to `limit`', async () => {
    const result = await call("binance_get_order_book_depth", { symbol: "BTCUSDT", limit: 50, detail: "full" });

    const sc = result.structuredContent!;
    expect(Array.isArray(sc.bids)).toBe(true);
    expect(Array.isArray(sc.asks)).toBe(true);
    expect((sc.bids as unknown[]).length).toBe(50);
    expect((sc.asks as unknown[]).length).toBe(50);
  });
});
