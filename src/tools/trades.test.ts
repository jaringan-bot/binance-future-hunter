import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTradesTools } from "./trades.js";
import * as binanceProxy from "../binanceProxyClient.js";
import type { AggTrade } from "../binanceProxyClient.js";

vi.mock("../binanceProxyClient.js", () => ({
  getAggTrades: vi.fn(),
  getTakerLongShortRatioNative: vi.fn(),
}));

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function makeTrades(count: number): AggTrade[] {
  return Array.from({ length: count }, (_, i) => ({
    a: i,
    p: (100 + i * 0.01).toFixed(2),
    q: "1.5",
    f: i,
    l: i,
    T: i * 1000,
    m: i % 2 === 0,
  }));
}

describe("binance_get_agg_trades detail param (summary vs full)", () => {
  let handlers: Map<string, { handler: ToolHandler; inputSchema: Record<string, z.ZodTypeAny> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(binanceProxy.getAggTrades).mockResolvedValue(makeTrades(30));

    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        handlers.set(name, { handler: cb as ToolHandler, inputSchema: config.inputSchema ?? {} });
        return {};
      },
    } as unknown as McpServer;

    registerTradesTools(fakeServer);
  });

  function call(name: string, args: Record<string, unknown>) {
    const entry = handlers.get(name);
    if (!entry) throw new Error(`tool ${name} not registered`);
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("defaults to summary: no raw trades array, only CVD/summary fields", async () => {
    const result = await call("binance_get_agg_trades", { symbol: "BTCUSDT", limit: 30 });

    const sc = result.structuredContent!;
    expect(sc.trades).toBeUndefined();
    expect(sc.cvd).toBeDefined();
    expect(sc.buyPct).toBeDefined();
  });

  it('detail: "full" returns the complete raw trade array', async () => {
    const result = await call("binance_get_agg_trades", { symbol: "BTCUSDT", limit: 30, detail: "full" });

    const sc = result.structuredContent!;
    expect(Array.isArray(sc.trades)).toBe(true);
    expect((sc.trades as unknown[]).length).toBe(30);
  });
});
