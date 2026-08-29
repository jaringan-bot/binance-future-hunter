import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLiquiditySweepTools } from "./liquiditySweep.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as paginator from "../aggTradesPaginator.js";
import type { KlineTuple, AggTrade } from "../binanceProxyClient.js";

vi.mock("../binanceProxyClient.js", () => ({
  getKlinesNative: vi.fn(),
  getOpenInterestHistNative: vi.fn(),
  getAllForceOrders: vi.fn(),
  BinanceProxyError: class BinanceProxyError extends Error {},
}));
vi.mock("../aggTradesPaginator.js", () => ({
  fetchAggTradesForWindow: vi.fn(),
}));

const INTERVAL_MS = 15 * 60_000;

// 24 candles; hRange/lRange over candles [3..22] (lookback 20, excludeLast 1)
// is roughly [118, 100]. Candle 23 (active) wicks to low 98 then closes 101.
function makeKlines(): KlineTuple[] {
  return Array.from({ length: 24 }, (_, i) => {
    const openTime = i * INTERVAL_MS;
    let high = 115 + (i % 3);
    let low = 101 + (i % 4);
    let close = 108;
    if (i === 23) {
      high = 107;
      low = 98; // sweeps below the isolated low (101)
      close = 106; // closes back above the isolated low -> reclaim
    }
    return [
      openTime,
      String(close),
      String(high),
      String(low),
      String(close),
      "1000",
      openTime + INTERVAL_MS - 1,
      "0",
      10,
      "0",
      "0",
      "0",
    ] as unknown as KlineTuple;
  });
}

function trade(T: number, q: string, m: boolean): AggTrade {
  return { a: T, p: "100", q, f: 1, l: 1, T, m };
}

// Prior candle (openTime 22*INTERVAL_MS): heavy taker SELL. Active candle
// (openTime 23*INTERVAL_MS): much lighter selling -> CVD absorption.
function makeTrades(): AggTrade[] {
  const priorOpen = 22 * INTERVAL_MS;
  const activeOpen = 23 * INTERVAL_MS;
  return [
    trade(priorOpen + 1000, "50", true),
    trade(priorOpen + 2000, "40", true),
    trade(activeOpen + 1000, "5", true),
    trade(activeOpen + 2000, "3", false),
  ];
}

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

describe("whalescope_detect_liquidity_sweep tool", () => {
  let handler: ToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue(makeKlines());
    vi.mocked(paginator.fetchAggTradesForWindow).mockResolvedValue({
      trades: makeTrades(),
      pagesUsed: 1,
      windowCoveredMs: INTERVAL_MS * 2,
      insufficientData: false,
    });
    vi.mocked(binanceProxy.getOpenInterestHistNative).mockResolvedValue([
      { symbol: "BTCUSDT", sumOpenInterest: "1000", sumOpenInterestValue: "0", timestamp: 0 },
      { symbol: "BTCUSDT", sumOpenInterest: "980", sumOpenInterestValue: "0", timestamp: INTERVAL_MS },
      { symbol: "BTCUSDT", sumOpenInterest: "930", sumOpenInterestValue: "0", timestamp: 2 * INTERVAL_MS },
      { symbol: "BTCUSDT", sumOpenInterest: "900", sumOpenInterestValue: "0", timestamp: 3 * INTERVAL_MS },
    ]);
    vi.mocked(binanceProxy.getAllForceOrders).mockResolvedValue([]);

    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as ToolHandler;
        return {};
      },
    } as unknown as McpServer;
    registerLiquiditySweepTools(fakeServer);
  });

  it("defaults interval to 15m and lookbackBars to 20", () => {
    const args = z.object(inputSchema).parse({ symbol: "BTCUSDT" }) as Record<string, unknown>;
    expect(args.interval).toBe("15m");
    expect(args.lookbackBars).toBe(20);
  });

  it("returns a structured sell-side sweep verdict for the mocked data", async () => {
    const args = z.object(inputSchema).parse({ symbol: "BTCUSDT" }) as Record<string, unknown>;
    const result = await handler(args);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.side).toBe("SELL_SIDE");
    expect(result.structuredContent?.isLiquiditySweep).toBe(true);
    expect(result.structuredContent?.direction).toBe("LONG");
  });

  it("still returns a valid verdict when allForceOrders throws (fault tolerant)", async () => {
    vi.mocked(binanceProxy.getAllForceOrders).mockRejectedValue(new Error("HTTP 418 banned"));
    const args = z.object(inputSchema).parse({ symbol: "BTCUSDT" }) as Record<string, unknown>;
    const result = await handler(args);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.isLiquiditySweep).toBe(true);
    const gaps = (result.structuredContent?.dataGaps ?? []) as string[];
    expect(gaps.join(" ")).toMatch(/liquidation/i);
  });

  it("surfaces an error when klines come back empty", async () => {
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue([]);
    const args = z.object(inputSchema).parse({ symbol: "BTCUSDT" }) as Record<string, unknown>;
    const result = await handler(args);
    expect(result.isError).toBe(true);
  });
});
