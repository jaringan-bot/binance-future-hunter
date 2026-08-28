import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSpotTools } from "./spot.js";
import * as binanceProxy from "../binanceProxyClient.js";
import type { SpotRollingTicker } from "../binanceProxyClient.js";

vi.mock("../binanceProxyClient.js", () => ({
  getSpotRollingTicker: vi.fn(),
  BinanceProxyError: class BinanceProxyError extends Error {},
}));

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const SAMPLE: SpotRollingTicker = {
  symbol: "BTCUSDT",
  priceChange: "-1200.00000000",
  priceChangePercent: "-1.480",
  weightedAvgPrice: "80500.00000000",
  openPrice: "81000.00000000",
  highPrice: "81500.00000000",
  lowPrice: "79500.00000000",
  lastPrice: "79800.00000000",
  volume: "1234.56700000",
  quoteVolume: "99000000.00000000",
  openTime: 1787800000000,
  closeTime: 1787814400000,
  firstId: 100,
  lastId: 200,
  count: 101,
};

describe("binance_get_spot_rolling_ticker", () => {
  let handlers: Map<string, { handler: ToolHandler; inputSchema: Record<string, z.ZodTypeAny> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(binanceProxy.getSpotRollingTicker).mockResolvedValue(SAMPLE);

    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        handlers.set(name, { handler: cb as ToolHandler, inputSchema: config.inputSchema ?? {} });
        return {};
      },
    } as unknown as McpServer;

    registerSpotTools(fakeServer);
  });

  function call(name: string, args: Record<string, unknown>) {
    const entry = handlers.get(name);
    if (!entry) throw new Error(`tool ${name} not registered`);
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("registers the tool", () => {
    expect(handlers.has("binance_get_spot_rolling_ticker")).toBe(true);
  });

  it("defaults windowSize to 1h and passes it to the proxy", async () => {
    await call("binance_get_spot_rolling_ticker", { symbol: "BTCUSDT" });
    expect(binanceProxy.getSpotRollingTicker).toHaveBeenCalledWith("BTCUSDT", "1h");
  });

  it("passes an explicit windowSize through unchanged", async () => {
    await call("binance_get_spot_rolling_ticker", { symbol: "BTCUSDT", windowSize: "4h" });
    expect(binanceProxy.getSpotRollingTicker).toHaveBeenCalledWith("BTCUSDT", "4h");
  });

  it("returns derived change stats in structuredContent", async () => {
    const result = await call("binance_get_spot_rolling_ticker", { symbol: "BTCUSDT", windowSize: "4h" });
    const sc = result.structuredContent!;
    expect(sc.symbol).toBe("BTCUSDT");
    expect(sc.windowSize).toBe("4h");
    expect(sc.priceChangePercent).toBeCloseTo(-1.48, 2);
    expect(sc.lastPrice).toBeCloseTo(79800, 0);
    expect(sc.high).toBeCloseTo(81500, 0);
    expect(sc.low).toBeCloseTo(79500, 0);
    expect(result.content[0].text).toContain("BTCUSDT");
    expect(result.content[0].text).toContain("4h");
  });

  it("rejects a malformed windowSize", () => {
    expect(() => call("binance_get_spot_rolling_ticker", { symbol: "BTCUSDT", windowSize: "13x" })).toThrow();
  });

  it("surfaces upstream errors as an error result, not a throw", async () => {
    vi.mocked(binanceProxy.getSpotRollingTicker).mockRejectedValueOnce(new Error("boom"));
    const result = await call("binance_get_spot_rolling_ticker", { symbol: "BTCUSDT" });
    expect(result.content[0].text.toLowerCase()).toContain("error");
  });
});
