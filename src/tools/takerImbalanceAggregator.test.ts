import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AggTrade } from "../binanceProxyClient.js";
import { computeTakerImbalance, registerTakerImbalanceAggregatorTools } from "./takerImbalanceAggregator.js";

function trade(overrides: Partial<AggTrade> = {}): AggTrade {
  return { a: 1, p: "100", q: "1", f: 1, l: 1, T: 0, m: false, ...overrides };
}

// buyFraction of trades m=false (buy-taker), rest m=true (sell-taker).
// T spaced evenly startT..endT, ascending (chronological, native Binance order).
function makeTrades(count: number, buyFraction: number, startT: number, endT: number): AggTrade[] {
  const buyCount = Math.round(count * buyFraction);
  return Array.from({ length: count }, (_, i) => {
    const T = count > 1 ? startT + Math.round(((endT - startT) * i) / (count - 1)) : startT;
    return trade({ a: i, T, m: i >= buyCount });
  });
}

describe("computeTakerImbalance", () => {
  it("returns EMPTY_TRADES when array is empty", () => {
    const result = computeTakerImbalance([], 100, 3600);
    expect(result.errorCode).toBe("EMPTY_TRADES");
  });

  it("classifies near-zero imbalance for a balanced trade set", () => {
    const trades = makeTrades(200, 0.5, 0, 60_000);
    const result = computeTakerImbalance(trades, 200, 3600);
    expect(result.errorCode).toBeUndefined();
    expect(result.imbalanceScore).toBeCloseTo(0, 5);
    expect(result.buyPct).toBeCloseTo(50, 5);
  });

  it("classifies imbalanceScore near 1 for a fully one-sided (all buy) trade set", () => {
    const trades = makeTrades(200, 1, 0, 60_000);
    const result = computeTakerImbalance(trades, 200, 3600);
    expect(result.errorCode).toBeUndefined();
    expect(result.imbalanceScore).toBeCloseTo(1, 5);
    expect(result.buyPct).toBeCloseTo(100, 5);
  });

  it("classifies imbalanceScore near -1 for a fully one-sided (all sell) trade set", () => {
    const trades = makeTrades(200, 0, 0, 60_000);
    const result = computeTakerImbalance(trades, 200, 3600);
    expect(result.errorCode).toBeUndefined();
    expect(result.imbalanceScore).toBeCloseTo(-1, 5);
    expect(result.buyPct).toBeCloseTo(0, 5);
  });

  it("returns INSUFFICIENT_TRADES when fewer trades are available than lookbackTrades, without silently computing on fewer", () => {
    const trades = makeTrades(50, 0.5, 0, 10_000);
    const result = computeTakerImbalance(trades, 100, 3600);
    expect(result.errorCode).toBe("INSUFFICIENT_TRADES");
    expect(result.tradesUsed).toBe(50);
  });

  it("returns INVALID_TRADE_DATA for a malformed payload (non-numeric qty)", () => {
    const trades = [trade({ T: 0, q: "1" }), trade({ T: 1000, q: "not-a-number" }), trade({ T: 2000, q: "1" })];
    const result = computeTakerImbalance(trades, 3, 3600);
    expect(result.errorCode).toBe("INVALID_TRADE_DATA");
  });

  it("returns TRADES_NOT_CHRONOLOGICAL when T is not non-decreasing", () => {
    const trades = [trade({ T: 5000 }), trade({ T: 1000 }), trade({ T: 3000 })];
    const result = computeTakerImbalance(trades, 3, 3600);
    expect(result.errorCode).toBe("TRADES_NOT_CHRONOLOGICAL");
  });

  it("does NOT flag stale when the lookback span is within maxLookbackSeconds", () => {
    const trades = makeTrades(100, 0.5, 0, 30_000); // 30s span
    const result = computeTakerImbalance(trades, 100, 3600);
    expect(result.errorCode).toBeUndefined();
    expect(result.stale).toBe(false);
  });

  it("flags stale when the lookback span exceeds maxLookbackSeconds", () => {
    const trades = makeTrades(100, 0.5, 0, 7_200_000); // 7200s span
    const result = computeTakerImbalance(trades, 100, 3600);
    expect(result.errorCode).toBeUndefined();
    expect(result.stale).toBe(true);
  });

  it("maps m=true to sell-taker and m=false to buy-taker (same convention as computeCvdFromTrades)", () => {
    const trades = [
      trade({ a: 1, T: 0, q: "10", m: false }), // buy-taker
      trade({ a: 2, T: 1000, q: "3", m: true }), // sell-taker
    ];
    const result = computeTakerImbalance(trades, 2, 3600);
    expect(result.errorCode).toBeUndefined();
    expect(result.buyQty).toBe(10);
    expect(result.sellQty).toBe(3);
  });

  it("uses only the last lookbackTrades entries (event-domain slice), not the whole array", () => {
    // First 100 trades fully sell (m=true), last 50 fully buy (m=false).
    const sellTrades = makeTrades(100, 0, 0, 99_000);
    const buyTrades = makeTrades(50, 1, 100_000, 149_000);
    const trades = [...sellTrades, ...buyTrades];
    const result = computeTakerImbalance(trades, 50, 3600);
    expect(result.errorCode).toBeUndefined();
    expect(result.tradesUsed).toBe(50);
    expect(result.imbalanceScore).toBeCloseTo(1, 5);
  });
});

type TakerImbalanceToolResult = {
  isError?: boolean;
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
};
type TakerImbalanceToolHandler = (args: {
  symbol?: string;
  trades: AggTrade[];
  lookbackTrades: number;
  maxLookbackSeconds: number;
}) => Promise<TakerImbalanceToolResult>;

describe("taker_imbalance_aggregator tool handler", () => {
  let handler: TakerImbalanceToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as TakerImbalanceToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerTakerImbalanceAggregatorTools(fakeServer);
  });

  it("defaults lookbackTrades to 500 and maxLookbackSeconds to 3600 when not provided", () => {
    const args = z.object(inputSchema).parse({ trades: [] }) as Parameters<TakerImbalanceToolHandler>[0];
    expect(args.lookbackTrades).toBe(500);
    expect(args.maxLookbackSeconds).toBe(3600);
  });

  it("surfaces INSUFFICIENT_TRADES as isError with errorCode", async () => {
    const trades = makeTrades(10, 0.5, 0, 10_000);
    const args = z.object(inputSchema).parse({ trades, lookbackTrades: 100 }) as Parameters<TakerImbalanceToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.errorCode).toBe("INSUFFICIENT_TRADES");
  });

  it("returns a normal (non-error) result with stale=false for a well-formed balanced payload", async () => {
    const trades = makeTrades(50, 0.5, 0, 10_000);
    const args = z.object(inputSchema).parse({ trades, lookbackTrades: 50 }) as Parameters<TakerImbalanceToolHandler>[0];

    const result = await handler(args);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.stale).toBe(false);
  });
});
