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

// Candle set with real high/low swings (unlike makeKlines' fixed +1/-1 range)
// so computeATR() on the daily klines produces a non-trivial ATR for the
// fallback proxy scenarios below.
function makeSwingKlines(count: number): KlineTuple[] {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + (i % 2 === 0 ? 3 : -3);
    const open = base;
    const close = base + (i % 2 === 0 ? 1.5 : -1.5);
    const high = Math.max(open, close) + 2;
    const low = Math.min(open, close) - 2;
    return [
      i * 86_400_000,
      open.toFixed(2),
      high.toFixed(2),
      low.toFixed(2),
      close.toFixed(2),
      String(1000 + i),
      i * 86_400_000 + 86_399_999,
      "0",
      10,
      "0",
      "0",
      "0",
    ] as unknown as KlineTuple;
  });
}

describe("binance_get_realized_volatility", () => {
  let handlers: Map<string, { handler: ToolHandler; inputSchema: Record<string, z.ZodTypeAny> }>;

  function setup(klines1hCount: number) {
    vi.clearAllMocks();
    vi.mocked(binanceProxy.getKlinesNative).mockImplementation(async (_symbol, interval) => {
      if (interval === "1h") return makeKlines(klines1hCount);
      if (interval === "1d") return makeSwingKlines(20);
      return makeKlines(96); // 15m
    });

    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        handlers.set(name, { handler: cb as ToolHandler, inputSchema: config.inputSchema ?? {} });
        return {};
      },
    } as unknown as McpServer;

    registerPriceTools(fakeServer);
  }

  function call(name: string, args: Record<string, unknown>) {
    const entry = handlers.get(name);
    if (!entry) throw new Error(`tool ${name} not registered`);
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("uses log-return RV as primary when 1h history is sufficient (>= 24 candles)", async () => {
    setup(30);
    const result = await call("binance_get_realized_volatility", { symbol: "BTCUSDT" });
    const sc = result.structuredContent!;

    expect(sc.primary_method).toBe("log_return_1h");
    expect(sc.is_fallback_used).toBe(false);
    expect(sc.rv_logreturn_ann).not.toBeNull();
    expect(sc.rv_range_proxy_ann).toBeGreaterThan(0);
    expect([1, 2, 3]).toContain(sc.assigned_tier);
    expect([1.0, 1.25, 1.6]).toContain(sc.tier_multiplier);
  });

  it("falls back to the ATR-range proxy, sqrt(365)-annualized, when 1h history is missing", async () => {
    setup(5); // below MIN_1H_CANDLES_FOR_RV (24)
    const result = await call("binance_get_realized_volatility", { symbol: "BTCUSDT" });
    const sc = result.structuredContent!;

    expect(sc.primary_method).toBe("atr_range_fallback");
    expect(sc.is_fallback_used).toBe(true);
    expect(sc.rv_logreturn_ann).toBeNull();

    const proxy = sc.rv_range_proxy_ann as number;
    // Sanity: the swing candles produce a raw daily ATR/price ratio well under
    // 0.10; the fallback must annualize it (x sqrt(365) x 0.8), landing it in
    // the ~0.30-1.50 range that's actually comparable to the 60%/120% tier
    // thresholds -- not the ~0.03-0.08 raw-ratio range from the old bug.
    expect(proxy).toBeGreaterThan(0.1);
    expect(proxy).toBeLessThan(3);

    const { tier, multiplier } = { tier: sc.assigned_tier, multiplier: sc.tier_multiplier };
    const expectedTier = proxy < 0.6 ? 1 : proxy < 1.2 ? 2 : 3;
    const expectedMultiplier = expectedTier === 1 ? 1.0 : expectedTier === 2 ? 1.25 : 1.6;
    expect(tier).toBe(expectedTier);
    expect(multiplier).toBe(expectedMultiplier);
  });
});
