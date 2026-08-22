import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpenInterestTools } from "./openInterest.js";
import * as binanceProxy from "../binanceProxyClient.js";
import type { OpenInterestHistPoint } from "../binanceProxyClient.js";

vi.mock("../binanceProxyClient.js", () => ({
  getOpenInterestNative: vi.fn(),
  getOpenInterestHistNative: vi.fn(),
}));

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function makeOiHistory(count: number): OpenInterestHistPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: "BTCUSDT",
    sumOpenInterest: String(1000 + i * 10),
    sumOpenInterestValue: "0",
    timestamp: i * 60_000,
  }));
}

describe("binance_get_open_interest_history detail param (summary vs full)", () => {
  let handlers: Map<string, { handler: ToolHandler; inputSchema: Record<string, z.ZodTypeAny> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(binanceProxy.getOpenInterestHistNative).mockResolvedValue(makeOiHistory(30));

    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        handlers.set(name, { handler: cb as ToolHandler, inputSchema: config.inputSchema ?? {} });
        return {};
      },
    } as unknown as McpServer;

    registerOpenInterestTools(fakeServer);
  });

  function call(name: string, args: Record<string, unknown>) {
    const entry = handlers.get(name);
    if (!entry) throw new Error(`tool ${name} not registered`);
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("defaults to summary: no full points array, only trend + <=10 recent points", async () => {
    const result = await call("binance_get_open_interest_history", { symbol: "BTCUSDT", period: "15m", limit: 30 });

    const sc = result.structuredContent!;
    expect(sc.points).toBeUndefined();
    expect(sc.direction).toBeDefined();
    expect(sc.changePct).toBeDefined();
    expect(Array.isArray(sc.recent)).toBe(true);
    expect((sc.recent as unknown[]).length).toBeLessThanOrEqual(10);
  });

  it('detail: "full" returns every fetched point', async () => {
    const result = await call("binance_get_open_interest_history", {
      symbol: "BTCUSDT",
      period: "15m",
      limit: 30,
      detail: "full",
    });

    const sc = result.structuredContent!;
    expect(Array.isArray(sc.points)).toBe(true);
    expect((sc.points as unknown[]).length).toBe(30);
    expect(sc.recent).toBeUndefined();
  });
});
