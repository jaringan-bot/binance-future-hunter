import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerNativeExtrasTools } from "./nativeExtras.js";
import * as binanceProxy from "../binanceProxyClient.js";
import type { FuturesExchangeInfoResponse, FundingInfoEntry } from "../binanceProxyClient.js";

vi.mock("../binanceProxyClient.js", () => ({
  getFuturesExchangeInfo: vi.fn(),
  getRecentTrades: vi.fn(),
  getBookTicker: vi.fn(),
  getPriceTicker: vi.fn(),
  getFundingInfo: vi.fn(),
  getRpiDepth: vi.fn(),
  getTradingSchedule: vi.fn(),
  getAllForceOrders: vi.fn(),
}));

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function makeExchangeInfo(): FuturesExchangeInfoResponse {
  return {
    symbols: [
      { symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", filters: [] },
      { symbol: "ETHUSDT", status: "TRADING", contractType: "PERPETUAL", filters: [] },
    ],
  };
}

function makeFundingInfo(): FundingInfoEntry[] {
  return [
    { symbol: "GTCUSDT", fundingIntervalHours: 8, adjustedFundingRateCap: "0.02", adjustedFundingRateFloor: "-0.02" },
    { symbol: "LPTUSDT", fundingIntervalHours: 4, adjustedFundingRateCap: "0.02", adjustedFundingRateFloor: "-0.02" },
  ];
}

describe("nativeExtras -- server-side symbol filter bugs (Binance ignores ?symbol=)", () => {
  let handlers: Map<string, { handler: ToolHandler; inputSchema: Record<string, z.ZodTypeAny> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(binanceProxy.getFuturesExchangeInfo).mockResolvedValue(makeExchangeInfo());
    vi.mocked(binanceProxy.getFundingInfo).mockResolvedValue(makeFundingInfo());

    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        handlers.set(name, { handler: cb as ToolHandler, inputSchema: config.inputSchema ?? {} });
        return {};
      },
    } as unknown as McpServer;

    registerNativeExtrasTools(fakeServer);
  });

  function call(name: string, args: Record<string, unknown>) {
    const entry = handlers.get(name);
    if (!entry) throw new Error(`tool ${name} not registered`);
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("binance_get_exchange_info filters down to the requested symbol even though the API returns all pairs", async () => {
    const result = await call("binance_get_exchange_info", { symbol: "BTCUSDT" });
    expect(result.content[0].text).toContain("BTCUSDT");
    expect(result.content[0].text).not.toContain("ETHUSDT");
    expect(result.structuredContent?.count).toBe(1);
  });

  it("binance_get_exchange_info returns everything when no symbol is given", async () => {
    const result = await call("binance_get_exchange_info", {});
    expect(result.content[0].text).toContain("BTCUSDT");
    expect(result.content[0].text).toContain("ETHUSDT");
  });

  it("binance_get_funding_info filters down to the requested symbol even though the API returns all overrides", async () => {
    const result = await call("binance_get_funding_info", { symbol: "GTCUSDT" });
    expect(result.content[0].text).toContain("GTCUSDT");
    expect(result.content[0].text).not.toContain("LPTUSDT");
    expect(result.structuredContent?.count).toBe(1);
  });

  it("binance_get_funding_info reports default funding (not an error) when the symbol has no custom override", async () => {
    const result = await call("binance_get_funding_info", { symbol: "BTCUSDT" });
    expect(result.content[0].text).toContain("default");
    expect(result.content[0].text).not.toContain("GTCUSDT");
  });

  it("binance_get_rpi_depth clamps an off-grid limit before calling the client", async () => {
    vi.mocked(binanceProxy.getRpiDepth).mockResolvedValue({
      lastUpdateId: 1,
      E: 0,
      T: 0,
      bids: [["100", "1"]],
      asks: [["101", "1"]],
    });
    await call("binance_get_rpi_depth", { symbol: "BTCUSDT", limit: 15 });
    expect(binanceProxy.getRpiDepth).toHaveBeenCalledWith("BTCUSDT", 10);
  });

  it("binance_get_rpi_depth returns unavailable (not isError) on Binance -4021", async () => {
    vi.mocked(binanceProxy.getRpiDepth).mockRejectedValue(
      new Error('Proxy/Binance error HTTP 400: {"code":-4021,"msg":"not valid depth limit"}'),
    );
    const result = await call("binance_get_rpi_depth", { symbol: "BTCUSDT" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.unavailable).toBe(true);
    expect(result.structuredContent?.limit).toBe(100);
    expect(result.content[0].text).toMatch(/tidak tersedia|RPI/i);
  });

  it("binance_get_all_force_orders degrades on HTML 404 instead of crashing", async () => {
    vi.mocked(binanceProxy.getAllForceOrders).mockRejectedValue(
      new Error("Proxy/Binance error HTTP 404: <!DOCTYPE html><title>404 Not Found</title>"),
    );
    const result = await call("binance_get_all_force_orders", { symbol: "BTCUSDT" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.degraded).toBe(true);
    expect(result.structuredContent?.count).toBe(0);
    expect(result.content[0].text).not.toMatch(/<!DOCTYPE/i);
  });
});
