import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AggTrade } from "../binanceProxyClient.js";
import { filterBlockTrades, isUsdQuotedSymbol, registerBlockTradesTools } from "./blockTrades.js";

function trade(overrides: Partial<AggTrade> = {}): AggTrade {
  return { a: 1, p: "100", q: "1", f: 1, l: 1, T: 0, m: false, ...overrides };
}

describe("isUsdQuotedSymbol", () => {
  it("returns true for USDT/USDC/BUSD/FDUSD/TUSD/USDP suffixed symbols", () => {
    expect(isUsdQuotedSymbol("BTCUSDT")).toBe(true);
    expect(isUsdQuotedSymbol("ETHUSDC")).toBe(true);
    expect(isUsdQuotedSymbol("BTCBUSD")).toBe(true);
    expect(isUsdQuotedSymbol("BTCFDUSD")).toBe(true);
    expect(isUsdQuotedSymbol("BTCTUSD")).toBe(true);
    expect(isUsdQuotedSymbol("BTCUSDP")).toBe(true);
  });

  it("returns false for a non-USD quote pair", () => {
    expect(isUsdQuotedSymbol("ETHBTC")).toBe(false);
  });
});

describe("filterBlockTrades", () => {
  it("returns EMPTY_TRADES when the trades array is empty", () => {
    const result = filterBlockTrades([], 100_000, 1.0);
    expect(result.errorCode).toBe("EMPTY_TRADES");
  });

  it("filters and buckets trades by USD notional threshold and m field", () => {
    const trades: AggTrade[] = [
      trade({ a: 1, p: "50000", q: "3", m: false }), // notional 150000, buy (taker buy)
      trade({ a: 2, p: "50000", q: "1", m: true }), // notional 50000, below threshold
      trade({ a: 3, p: "50000", q: "5", m: true }), // notional 250000, sell (taker sell)
    ];
    const result = filterBlockTrades(trades, 100_000, 1.0);

    expect(result.errorCode).toBeUndefined();
    expect(result.totalInputCount).toBe(3);
    expect(result.totalMatchedCount).toBe(2);
    expect(result.buyVolume).toBe(3);
    expect(result.sellVolume).toBe(5);
    expect(result.buyNotionalUsd).toBe(150000);
    expect(result.sellNotionalUsd).toBe(250000);
  });
});

type BlockTradesToolResult = {
  isError?: boolean;
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type BlockTradesToolHandler = (args: {
  symbol: string;
  trades: AggTrade[];
  minNotionalUsd: number;
  quoteUsdRate: number;
}) => Promise<BlockTradesToolResult>;

describe("filter_block_trades tool handler", () => {
  let handler: BlockTradesToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as BlockTradesToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerBlockTradesTools(fakeServer);
  });

  it("rejects a non-USD quote pair at the default quoteUsdRate", async () => {
    const args = z.object(inputSchema).parse({
      symbol: "ETHBTC",
      trades: [trade({ p: "10", q: "1000" })],
    }) as Parameters<BlockTradesToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe("NON_USD_QUOTE_PAIR_REQUIRES_CONVERSION_RATE");
  });

  it("allows a non-USD quote pair when an explicit non-default quoteUsdRate is supplied", async () => {
    const args = z.object(inputSchema).parse({
      symbol: "ETHBTC",
      trades: [trade({ p: "10", q: "1000" })],
      quoteUsdRate: 65000,
    }) as Parameters<BlockTradesToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBeFalsy();
  });

  it("passes through a USD-quoted symbol at the default rate", async () => {
    const args = z.object(inputSchema).parse({
      symbol: "BTCUSDT",
      trades: [trade({ p: "50000", q: "3", m: false })],
    }) as Parameters<BlockTradesToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.buyNotionalUsd).toBe(150000);
  });
});
