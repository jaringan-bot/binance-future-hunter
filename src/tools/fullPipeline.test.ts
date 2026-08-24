import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFullPipelineTools } from "./fullPipeline.js";
import * as binanceProxy from "../binanceProxyClient.js";
import type { KlineTuple } from "../binanceProxyClient.js";

// ─────────────────────────────────────────────────────────────
// Mock binanceProxyClient.js -- diresolve ke MODUL YANG SAMA oleh
// fullPipeline.ts (`../binanceProxyClient.js`), marketContext.ts
// (`./binanceProxyClient.js`, dipakai fetchMarketContext yang di-reuse
// UNMODIFIED oleh fullPipeline.ts), dan binanceFetcher.ts (getFuturesExchangeInfo,
// dipakai calculateGridRisk lewat fetchSymbolTradingRules) -- semua fungsi
// yang disentuh SATU pun dari 3 modul itu HARUS ada di sini.
// ─────────────────────────────────────────────────────────────
vi.mock("../binanceProxyClient.js", () => ({
  getTicker24hrNative: vi.fn(),
  getCurrentFundingRateNative: vi.fn(),
  getKlinesNative: vi.fn(),
  getOpenInterestNative: vi.fn(),
  getOpenInterestHistNative: vi.fn(),
  getAggTrades: vi.fn(),
  getTopTraderPositionRatio: vi.fn(),
  getGlobalAccountRatio: vi.fn(),
  getOrderBookDepth: vi.fn(),
  getSpotPrice: vi.fn(),
  getFuturesExchangeInfo: vi.fn(),
}));

type PipelineToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};
type PipelineToolHandler = (args: Record<string, unknown>) => Promise<PipelineToolResult>;

function tupleAt(i: number, close: number, volume = 100): KlineTuple {
  const open = close;
  const high = close + 0.3;
  const low = close - 0.3;
  return [
    i * 3_600_000,
    open.toFixed(4),
    high.toFixed(4),
    low.toFixed(4),
    close.toFixed(4),
    String(volume),
    i * 3_600_000 + 3_599_999,
    "0",
    10,
    "0",
    "0",
    "0",
  ] as unknown as KlineTuple;
}

/** Klines flat (drift kecil) -- tidak memicu BREAKOUT (vol/volume spike rendah). */
function makeFlatKlines(count: number, base = 100): KlineTuple[] {
  return Array.from({ length: count }, (_, i) => tupleAt(i, base + i * 0.01));
}

/** Klines dengan lonjakan volatilitas+volume ekstrem di 10 candle terakhir -- memicu BREAKOUT. */
function makeBreakoutKlines(count: number): KlineTuple[] {
  return Array.from({ length: count }, (_, i) => {
    const recent = i >= count - 10;
    if (!recent) return tupleAt(i, 100 + (i % 2 === 0 ? 0.05 : -0.05), 100);
    const close = i % 2 === 0 ? 70 : 130;
    const volume = i === count - 1 ? 100_000 : 5_000;
    return tupleAt(i, close, volume);
  });
}

function makeExchangeInfo(symbol: string) {
  return {
    symbols: [
      {
        symbol,
        filters: [
          { filterType: "LOT_SIZE" as const, minQty: "0.001", stepSize: "0.001" },
          { filterType: "MIN_NOTIONAL" as const, notional: "5" },
        ],
      },
    ],
  };
}

function makeOrderBook(bidQty: number, askQty: number) {
  return {
    lastUpdateId: 1,
    E: 0,
    T: 0,
    bids: Array.from({ length: 50 }, (_, i) => [String(100 - i * 0.01), String(bidQty)] as [string, string]),
    asks: Array.from({ length: 50 }, (_, i) => [String(100 + i * 0.01), String(askQty)] as [string, string]),
  };
}

/** aggTrades dengan buyPct target (persen buy) dari 100 trade. */
function makeAggTrades(buyPct: number) {
  const buyCount = Math.round(buyPct);
  return Array.from({ length: 100 }, (_, i) => ({
    a: i,
    p: "100",
    q: "1",
    f: i,
    l: i,
    T: i,
    m: i >= buyCount, // m=true (sell) untuk sisa, m=false (buy) untuk buyCount pertama
  }));
}

function defaultMockSetup(): void {
  vi.mocked(binanceProxy.getTicker24hrNative).mockResolvedValue({
    symbol: "BTCUSDT",
    lastPrice: "100",
    priceChange: "0",
    priceChangePercent: "0",
    highPrice: "101",
    lowPrice: "99",
    volume: "100000",
    quoteVolume: "10000000",
  });
  vi.mocked(binanceProxy.getCurrentFundingRateNative).mockResolvedValue({
    symbol: "BTCUSDT",
    markPrice: "100",
    indexPrice: "100",
    estimatedSettlePrice: "100",
    lastFundingRate: "0.0001",
    nextFundingTime: 0,
    interestRate: "0.0001",
    time: 0,
  });
  vi.mocked(binanceProxy.getKlinesNative).mockImplementation(async (_symbol, _interval, limit) =>
    makeFlatKlines(limit),
  );
  vi.mocked(binanceProxy.getOpenInterestNative).mockResolvedValue({ symbol: "BTCUSDT", openInterest: "1000", time: 0 });
  vi.mocked(binanceProxy.getOpenInterestHistNative).mockImplementation(async (_symbol, _period, limit) => {
    if (limit === 24) {
      return Array.from({ length: 24 }, (_, i) => ({
        symbol: "BTCUSDT",
        sumOpenInterest: "1000",
        sumOpenInterestValue: "0",
        timestamp: i,
      }));
    }
    return [
      { symbol: "BTCUSDT", sumOpenInterest: "1000", sumOpenInterestValue: "0", timestamp: 0 },
      { symbol: "BTCUSDT", sumOpenInterest: "1000", sumOpenInterestValue: "0", timestamp: 1 },
    ];
  });
  vi.mocked(binanceProxy.getAggTrades).mockResolvedValue(makeAggTrades(50));
  vi.mocked(binanceProxy.getTopTraderPositionRatio).mockResolvedValue([
    { symbol: "BTCUSDT", longAccount: "0.5", longShortRatio: "1.0", shortAccount: "0.5", timestamp: 0 },
  ]);
  vi.mocked(binanceProxy.getGlobalAccountRatio).mockResolvedValue([
    { symbol: "BTCUSDT", longAccount: "0.5", longShortRatio: "1.0", shortAccount: "0.5", timestamp: 0 },
  ]);
  vi.mocked(binanceProxy.getOrderBookDepth).mockResolvedValue(makeOrderBook(5, 5));
  vi.mocked(binanceProxy.getSpotPrice).mockResolvedValue({ symbol: "BTCUSDT", price: "100" });
  vi.mocked(binanceProxy.getFuturesExchangeInfo).mockImplementation(async (symbol?: string) => makeExchangeInfo(symbol ?? "BTCUSDT"));
}

describe("whalescope_full_pipeline tool handler", () => {
  let handler: PipelineToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    vi.clearAllMocks();
    defaultMockSetup();

    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as PipelineToolHandler;
        return {};
      },
    } as unknown as McpServer;

    registerFullPipelineTools(fakeServer);
  });

  it("produces a TRADE decision for a symbol with strongly favorable Tier-1 fixtures", async () => {
    // Setup: smart money BULLISH_ACCUMULATION kuat (top trader ratio tinggi,
    // global account ratio rendah, OI naik), MM absorption+oiDivergence
    // terpicu (OI naik tajam + harga flat + CVD buy dominan), order book dan
    // CVD bid/buy-heavy (70%) -- didesain supaya rankingScore >= 55 dan
    // grid risk SAFE/MODERATE di leverage rendah.
    vi.mocked(binanceProxy.getAggTrades).mockResolvedValue(makeAggTrades(70));
    vi.mocked(binanceProxy.getOpenInterestHistNative).mockImplementation(async (_symbol, _period, limit) => {
      if (limit === 24) {
        const base = [900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 920, 940, 960, 1000];
        return base.map((v, i) => ({ symbol: "BTCUSDT", sumOpenInterest: String(v), sumOpenInterestValue: "0", timestamp: i }));
      }
      return [
        { symbol: "BTCUSDT", sumOpenInterest: "950", sumOpenInterestValue: "0", timestamp: 0 },
        { symbol: "BTCUSDT", sumOpenInterest: "1000", sumOpenInterestValue: "0", timestamp: 1 },
      ];
    });
    vi.mocked(binanceProxy.getTopTraderPositionRatio).mockResolvedValue([
      { symbol: "BTCUSDT", longAccount: "0.6", longShortRatio: "1.6", shortAccount: "0.4", timestamp: 0 },
    ]);
    vi.mocked(binanceProxy.getGlobalAccountRatio).mockResolvedValue([
      { symbol: "BTCUSDT", longAccount: "0.4", longShortRatio: "0.6", shortAccount: "0.6", timestamp: 0 },
    ]);
    vi.mocked(binanceProxy.getOrderBookDepth).mockResolvedValue(makeOrderBook(7, 3));

    const args = z.object(inputSchema).parse({ symbols: "BTCUSDT" });
    const result = await handler(args);

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { results: Array<Record<string, unknown>> };
    expect(structured.results).toHaveLength(1);
    const r = structured.results[0];
    expect(r.symbol).toBe("BTCUSDT");
    expect((r.hardScreen as { passed: boolean }).passed).toBe(true);
    expect(r.decision).toBe("TRADE");

    const gridBotConfig = r.gridBotConfig as { lower: number; upper: number; leverage: number; stopLoss: number };
    expect(gridBotConfig.upper).toBeGreaterThan(gridBotConfig.lower);
    expect(gridBotConfig.lower).toBeGreaterThan(0);
    expect(gridBotConfig.stopLoss).toBeLessThan(gridBotConfig.lower);
    expect([3, 5, 10]).toContain(gridBotConfig.leverage);
  });

  it("short-circuits to NO_TRADE on hard-screen BREAKOUT rejection without calling Wave-2-only fetches", async () => {
    vi.mocked(binanceProxy.getKlinesNative).mockImplementation(async (_symbol, _interval, limit) => makeBreakoutKlines(limit));
    // oiChangePct = (oiCurrent - oiHist2[0]) / oiHist2[0] -- pakai oiCurrent
    // JAUH lebih tinggi dari titik histori pertama supaya oiChangePct > 3%
    // (salah satu dari 3 syarat classifyRegime's BREAKOUT, bareng volatility
    // & volume spike dari makeBreakoutKlines di atas).
    vi.mocked(binanceProxy.getOpenInterestNative).mockResolvedValue({ symbol: "BTCUSDT", openInterest: "1500", time: 0 });
    vi.mocked(binanceProxy.getOpenInterestHistNative).mockImplementation(async (_symbol, _period, limit) => {
      if (limit === 24) return [];
      return [
        { symbol: "BTCUSDT", sumOpenInterest: "1000", sumOpenInterestValue: "0", timestamp: 0 },
        { symbol: "BTCUSDT", sumOpenInterest: "1000", sumOpenInterestValue: "0", timestamp: 1 },
      ];
    });

    const args = z.object(inputSchema).parse({ symbols: "BTCUSDT" });
    const result = await handler(args);

    const structured = result.structuredContent as { results: Array<Record<string, unknown>> };
    const r = structured.results[0];
    expect(r.decision).toBe("NO_TRADE");
    expect((r.hardScreen as { passed: boolean }).passed).toBe(false);

    // Wave-2-ONLY fetches (tidak dipanggil fetchMarketContext di Wave 1) --
    // getTopTraderPositionRatio SENGAJA tidak diassert di sini karena
    // fetchMarketContext (dipanggil paralel di Wave 1 per desain) juga
    // memanggilnya secara independen, terlepas dari hasil hard-screen.
    expect(binanceProxy.getGlobalAccountRatio).not.toHaveBeenCalled();
    expect(binanceProxy.getOrderBookDepth).not.toHaveBeenCalled();
    expect(binanceProxy.getSpotPrice).not.toHaveBeenCalled();
    expect(binanceProxy.getOpenInterestHistNative).not.toHaveBeenCalledWith("BTCUSDT", "1h", 24);
  });

  it("short-circuits to NO_TRADE when |funding rate| exceeds max_abs_funding_rate, without Wave-2-only fetches", async () => {
    vi.mocked(binanceProxy.getCurrentFundingRateNative).mockResolvedValue({
      symbol: "BTCUSDT",
      markPrice: "100",
      indexPrice: "100",
      estimatedSettlePrice: "100",
      lastFundingRate: "0.001",
      nextFundingTime: 0,
      interestRate: "0.0001",
      time: 0,
    });

    const args = z.object(inputSchema).parse({ symbols: "BTCUSDT" });
    const result = await handler(args);

    const structured = result.structuredContent as { results: Array<Record<string, unknown>> };
    const r = structured.results[0];
    expect(r.decision).toBe("NO_TRADE");
    expect((r.hardScreen as { passed: boolean; reasons: string[] }).passed).toBe(false);
    expect((r.hardScreen as { reasons: string[] }).reasons.some((reason) => reason.includes("Funding"))).toBe(true);

    expect(binanceProxy.getGlobalAccountRatio).not.toHaveBeenCalled();
    expect(binanceProxy.getOrderBookDepth).not.toHaveBeenCalled();
    expect(binanceProxy.getOpenInterestHistNative).not.toHaveBeenCalledWith("BTCUSDT", "1h", 24);
  });

  it("isolates a per-symbol failure: other symbols in the same batch still succeed, and the tool call itself is not isError", async () => {
    vi.mocked(binanceProxy.getKlinesNative).mockImplementation(async (symbol, interval, limit) => {
      if (symbol === "AAAUSDT" && interval === "1h") {
        throw new Error("simulated network failure for AAAUSDT");
      }
      return makeFlatKlines(limit);
    });

    const args = z.object(inputSchema).parse({ symbols: ["AAAUSDT", "BBBUSDT"] });
    const result = await handler(args);

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { results: Array<Record<string, unknown>>; summary: Record<string, number> };
    expect(structured.results).toHaveLength(2);

    const failed = structured.results.find((r) => r.symbol === "AAAUSDT")!;
    const succeeded = structured.results.find((r) => r.symbol === "BBBUSDT")!;

    expect(failed.decision).toBe("NO_TRADE");
    expect(failed.error).toBeDefined();
    expect(typeof failed.error).toBe("string");

    expect(succeeded.error).toBeUndefined();
    expect((succeeded.hardScreen as { passed: boolean }).passed).toBe(true);
  });

  it("dedupes duplicate symbols and caps at the documented max via Zod", () => {
    const parsed = z.object(inputSchema).parse({ symbols: ["BTCUSDT", "btcusdt", "ETHUSDT"] });
    expect((parsed.symbols as string[]).sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("applies documented defaults when optional params are omitted", () => {
    const parsed = z.object(inputSchema).parse({ symbols: "BTCUSDT" }) as Record<string, unknown>;
    expect(parsed.risk_usd).toBe(20);
    expect(parsed.margin_mode).toBe("ISOLATED");
    expect(parsed.max_leverage_options).toEqual([3, 5, 10]);
    expect(parsed.concurrency).toBe(6);
  });
});
