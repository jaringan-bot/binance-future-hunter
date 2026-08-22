import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPriceTools } from "./price.js";
import * as binanceProxy from "../binanceProxyClient.js";
import type { KlineTuple } from "../binanceProxyClient.js";

vi.mock("../binanceProxyClient.js", () => ({
  getKlinesNative: vi.fn(),
}));

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function makeKlines(count: number): KlineTuple[] {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + i * 0.1;
    return [
      i * 3_600_000,
      open.toFixed(2),
      (open + 1).toFixed(2),
      (open - 1).toFixed(2),
      (open + 0.5).toFixed(2),
      String(1000 + i),
      i * 3_600_000 + 3_599_999,
      "0",
      10,
      "0",
      "0",
      "0",
    ] as unknown as KlineTuple;
  });
}

// registerPriceTools() registers many tools on the same fake server -- this
// map captures every handler+inputSchema by name so a single beforeEach can
// serve tests for any of them without re-registering per test.
describe("binance_get_klines detail param (summary vs full)", () => {
  let handlers: Map<string, { handler: ToolHandler; inputSchema: Record<string, z.ZodTypeAny> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue(makeKlines(20));

    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        handlers.set(name, { handler: cb as ToolHandler, inputSchema: config.inputSchema ?? {} });
        return {};
      },
    } as unknown as McpServer;

    registerPriceTools(fakeServer);
  });

  function call(name: string, args: Record<string, unknown>) {
    const entry = handlers.get(name);
    if (!entry) throw new Error(`tool ${name} not registered`);
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("defaults to summary: no full candle array, only a short `recent` slice", async () => {
    const result = await call("binance_get_klines", { symbol: "BTCUSDT", interval: "1h", limit: 20 });

    expect(result.structuredContent).toBeDefined();
    const sc = result.structuredContent!;
    expect(sc.candles).toBeUndefined();
    expect(Array.isArray(sc.recent)).toBe(true);
    expect((sc.recent as unknown[]).length).toBeLessThanOrEqual(5);
    // Summary metrics must still be present.
    expect(sc.bias).toBeDefined();
    expect(sc.swingHigh).toBeDefined();
    expect(sc.swingLow).toBeDefined();
  });

  it('detail: "full" returns the complete candle array', async () => {
    const result = await call("binance_get_klines", { symbol: "BTCUSDT", interval: "1h", limit: 20, detail: "full" });

    const sc = result.structuredContent!;
    expect(Array.isArray(sc.candles)).toBe(true);
    expect((sc.candles as unknown[]).length).toBe(20);
    expect(sc.recent).toBeUndefined();
  });

  it("legacy includeCandles: true still triggers the full array (backward compatibility)", async () => {
    const result = await call("binance_get_klines", {
      symbol: "BTCUSDT",
      interval: "1h",
      limit: 20,
      includeCandles: true,
    });

    const sc = result.structuredContent!;
    expect(Array.isArray(sc.candles)).toBe(true);
    expect((sc.candles as unknown[]).length).toBe(20);
  });
});
