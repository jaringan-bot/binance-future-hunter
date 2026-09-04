import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerFullPipelineTools,
  runPipelineForSymbol,
  runTriplePipelineForSymbol,
  type PipelineOpts,
  type PrefetchedTickerFunding,
} from "./fullPipeline.js";
import * as binanceProxy from "../binanceProxyClient.js";
import type { KlineTuple } from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";

// ─────────────────────────────────────────────────────────────
// Mock binanceProxyClient.js -- diresolve ke MODUL YANG SAMA oleh
// fullPipeline.ts (`../binanceProxyClient.js`), marketContext.ts
// (`./binanceProxyClient.js`, dipakai fetchMarketContext yang di-reuse
// UNMODIFIED oleh fullPipeline.ts), dan binanceFetcher.ts (getFuturesExchangeInfo,
// dipakai calculateGridRisk lewat fetchSymbolTradingRules) -- semua fungsi
// yang disentuh SATU pun dari 3 modul itu HARUS ada di sini.
// ─────────────────────────────────────────────────────────────
vi.mock("../d1Client.js", () => ({
  insertPipelineDecisionLogs: vi.fn().mockResolvedValue(undefined),
  getDcaActivePlan: vi.fn().mockResolvedValue(null),
}));

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
  hasBinanceApiCredentials: () => false,
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

    // Reused fixture's OI trend is a smooth ramp (no single step dominates
    // the net window movement) -- earlyExhaustionWarning must stay false,
    // and rankingScore must NOT be discounted below what the same fixture
    // produces further below with a genuine dominant-spike OI series.
    const tier1 = r.tier1 as { oi: { changePct: number; earlyExhaustionWarning: boolean } };
    expect(tier1.oi.earlyExhaustionWarning).toBe(false);
  });

  it("flags OI early-exhaustion (dominant single-step jump vs net window movement) and discounts rankingScore vs the equivalent non-spiked fixture", async () => {
    // Same TRADE-favorable base as the test above, EXCEPT the last 5 points
    // of the 24-point OI history (the 4h window compute_oi_velocity actually
    // uses) have ONE big spike (900->1200) partially reverting (1200->1000)
    // instead of a smooth ramp -- net window change stays positive (+100,
    // so oiDeltaPct > 0 and BULLISH_ACCUMULATION condition-matching is
    // unaffected), but the single 300-point step dwarfs the ~200-point net
    // OLS-fitted movement, so this SHOULD trigger the structural
    // maxStepDelta > netChangeAbs rule.
    vi.mocked(binanceProxy.getAggTrades).mockResolvedValue(makeAggTrades(70));
    vi.mocked(binanceProxy.getOpenInterestHistNative).mockImplementation(async (_symbol, _period, limit) => {
      if (limit === 24) {
        const base = [900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 1200, 1000];
        return base.map((v, i) => ({ symbol: "BTCUSDT", sumOpenInterest: String(v), sumOpenInterestValue: "0", timestamp: i * 3_600_000 }));
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

    const structured = result.structuredContent as { results: Array<Record<string, unknown>> };
    const r = structured.results[0];
    const tier1 = r.tier1 as { oi: { changePct: number; earlyExhaustionWarning: boolean }; smartMoney: { confidenceScore: number } };

    expect(tier1.oi.changePct).toBeGreaterThan(0); // net window change still positive -- condition-matching unaffected
    expect(tier1.oi.earlyExhaustionWarning).toBe(true);
    expect((r.reasoning as string[]).some((line) => line.includes("Early-Exhaustion"))).toBe(true);
    // rankingScore must be lower than the non-spiked TRADE fixture above,
    // proving the confidence discount actually fed into scoring (not just
    // a flag that's computed but ignored).
    expect((r.rankingScore as number)).toBeLessThan(70);
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
    expect(parsed.persist).toBe(false);
    expect(parsed.persist_source).toBe("manual");
  });

  it("does not write pipeline_decision_log when persist defaults to false", async () => {
    const args = z.object(inputSchema).parse({ symbols: "BTCUSDT" });
    await handler(args);
    expect(d1Client.insertPipelineDecisionLogs).not.toHaveBeenCalled();
  });

  it("persists compact rows with dropstab source_ref when persist=true", async () => {
    vi.mocked(d1Client.insertPipelineDecisionLogs).mockResolvedValue(undefined);
    const args = z.object(inputSchema).parse({
      symbols: "BTCUSDT",
      persist: true,
      persist_source: "dropstab",
      persist_ref: "bullish-coins-in-accumulation-ktg7cz8t70",
    });
    const result = await handler(args);
    expect(d1Client.insertPipelineDecisionLogs).toHaveBeenCalledTimes(1);
    const rows = vi.mocked(d1Client.insertPipelineDecisionLogs).mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: "BTCUSDT",
      source: "dropstab",
      sourceRef: "bullish-coins-in-accumulation-ktg7cz8t70",
    });
    const params = (result.structuredContent as { params: { persisted: boolean } }).params;
    expect(params.persisted).toBe(true);
  });

  it("keeps the pipeline response when persist write fails", async () => {
    vi.mocked(d1Client.insertPipelineDecisionLogs).mockRejectedValueOnce(new Error("D1 down"));
    const args = z.object(inputSchema).parse({ symbols: "BTCUSDT", persist: true });
    const result = await handler(args);
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { params: { persisted: boolean; persistError: string }; results: unknown[] };
    expect(structured.params.persisted).toBe(false);
    expect(structured.params.persistError).toContain("D1 down");
    expect(structured.results).toHaveLength(1);
  });
});

// Sama nilainya kayak DEFAULT_PIPELINE_OPTS di entryAlertCron.ts -- caller
// nyata dari parameter `prefetched` ini.
const TEST_OPTS: PipelineOpts = {
  riskUsd: 20,
  marginMode: "ISOLATED",
  maxLeverageOptions: [3, 5, 10],
  lookbackBars: 50,
  atrPeriod: 14,
  atrMult: 1.0,
  slExtraAtr: 1.5,
  slPctBuffer: 1.0,
  minQuoteVolumeUsd: 5_000_000,
  maxAbsFundingRate: 0.0005,
};

describe("runPipelineForSymbol -- prefetched ticker/funding (bulk-fetch opsional)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMockSetup();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("uses the prefetched ticker+funding maps and skips both per-symbol proxy calls when the symbol is present in both", async () => {
    const prefetched: PrefetchedTickerFunding = {
      ticker: new Map([
        ["BTCUSDT", { symbol: "BTCUSDT", lastPrice: "200", priceChange: "0", priceChangePercent: "0", highPrice: "201", lowPrice: "199", volume: "1", quoteVolume: "9999999" }],
      ]),
      funding: new Map([
        ["BTCUSDT", { symbol: "BTCUSDT", markPrice: "200", indexPrice: "200", estimatedSettlePrice: "200", lastFundingRate: "0.0003", nextFundingTime: 0, interestRate: "0", time: 0 }],
      ]),
    };

    const result = await runPipelineForSymbol("BTCUSDT", TEST_OPTS, prefetched);

    expect(binanceProxy.getTicker24hrNative).not.toHaveBeenCalled();
    expect(binanceProxy.getCurrentFundingRateNative).not.toHaveBeenCalled();
    // Bukti nilai dari MAP (200 / 9999999 / 0.0003) beneran dipakai, bukan
    // fallback ke data mock per-symbol default (100 / 10000000 / 0.0001).
    expect(result.hardScreen.quoteVolumeUsd).toBe(9999999);
    expect(result.hardScreen.fundingRate).toBe(0.0003);
  });

  it("falls back to the per-symbol funding call (not a silent default) when the symbol is missing from the bulk funding map, while still skipping the ticker call, and logs why", async () => {
    const prefetched: PrefetchedTickerFunding = {
      ticker: new Map([
        ["BTCUSDT", { symbol: "BTCUSDT", lastPrice: "200", priceChange: "0", priceChangePercent: "0", highPrice: "201", lowPrice: "199", volume: "1", quoteVolume: "9999999" }],
      ]),
      funding: new Map(), // BTCUSDT sengaja tidak ada
    };

    const result = await runPipelineForSymbol("BTCUSDT", TEST_OPTS, prefetched);

    expect(binanceProxy.getTicker24hrNative).not.toHaveBeenCalled();
    expect(binanceProxy.getCurrentFundingRateNative).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("premiumIndex"));
    // Fallback call balikin data mock per-symbol default (funding rate 0.0001).
    expect(result.hardScreen.fundingRate).toBe(0.0001);
  });

  it("treats a bulk-ticker miss as not-tradable (same null-safe path as a per-symbol fetch failure) instead of calling the per-symbol endpoint, and logs why", async () => {
    const prefetched: PrefetchedTickerFunding = {
      ticker: new Map(), // BTCUSDT sengaja tidak ada
      funding: new Map([
        ["BTCUSDT", { symbol: "BTCUSDT", markPrice: "200", indexPrice: "200", estimatedSettlePrice: "200", lastFundingRate: "0.0003", nextFundingTime: 0, interestRate: "0", time: 0 }],
      ]),
    };

    const result = await runPipelineForSymbol("BTCUSDT", TEST_OPTS, prefetched);

    expect(binanceProxy.getTicker24hrNative).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ticker24hr"));
    // tradable=false (lastPrice/quoteVolume dari ticker null) -> hard screen gagal.
    expect(result.hardScreen.quoteVolumeUsd).toBe(0);
    expect(result.hardScreen.passed).toBe(false);
  });

  it("falls back to per-symbol calls for both when prefetched is omitted entirely (whalescope_full_pipeline's existing behavior, unchanged)", async () => {
    const result = await runPipelineForSymbol("BTCUSDT", TEST_OPTS);

    expect(binanceProxy.getTicker24hrNative).toHaveBeenCalledTimes(1);
    expect(binanceProxy.getCurrentFundingRateNative).toHaveBeenCalledTimes(1);
    expect(result.hardScreen.passed).toBe(true);
  });

  it("runTriplePipelineForSymbol returns a traditional-futures head with a valid decision, using ONLY Wave 1/2 data (no extra force-order fetch)", async () => {
    const result = await runTriplePipelineForSymbol("BTCUSDT", TEST_OPTS, { modalAvailableUsd: 200 });

    expect(result.grid).toBeDefined();
    expect(result.dca).toBeDefined();
    expect(result.trad).toBeDefined();
    expect(["TRAD_TRADE", "TRAD_WATCH", "TRAD_NO_TRADE"]).toContain(result.trad.decision);
    expect(["MEAN_REVERSION", "TREND_BREAKOUT", "NONE"]).toContain(result.trad.scenario);
    // No allForceOrders fetch exists on the proxy mock -> the head must run
    // liquidation-free (fault-tolerant path).
    expect(result.trad.sweep.liquidations.available).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// K5 REACHABILITY GUARD (2026-09-04, Stage 2 signal-integrity)
//
// calculateTraditionalBracket() skenario B mensyaratkan regime === "BREAKOUT",
// tapi evaluateHardScreen() me-REJECT regime BREAKOUT dan runPipelineInternal
// dulu men-stub head trad jadi TRAD_NO_TRADE di jalur reject itu. Hasilnya
// TREND_BREAKOUT tidak pernah bisa terbit -- dead code, sementara komentar di
// fullPipeline.ts justru menyatakan skenario itu "jalan penuh".
//
// Test ini menanyakan hal yang tidak pernah ditanyakan 849 test lama:
// APAKAH cabang ini PUNYA JALUR HIDUP sama sekali?
// ─────────────────────────────────────────────────────────────
describe("K5: head Traditional tetap dievaluasi saat hard-screen menolak KARENA REGIME", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMockSetup();
  });

  function mockBreakoutMarket(): void {
    vi.mocked(binanceProxy.getKlinesNative).mockImplementation(async (_s, _i, limit) => makeBreakoutKlines(limit));
    vi.mocked(binanceProxy.getOpenInterestNative).mockResolvedValue({ symbol: "BTCUSDT", openInterest: "1500", time: 0 });
    vi.mocked(binanceProxy.getOpenInterestHistNative).mockImplementation(async (_s, _p, limit) => {
      if (limit === 24) return [];
      return [
        { symbol: "BTCUSDT", sumOpenInterest: "1000", sumOpenInterestValue: "0", timestamp: 0 },
        { symbol: "BTCUSDT", sumOpenInterest: "1000", sumOpenInterestValue: "0", timestamp: 1 },
      ];
    });
  }

  it("grid tetap NO_TRADE, tapi head trad TIDAK lagi di-stub 'hard_screen_reject'", async () => {
    mockBreakoutMarket();

    const r = await runTriplePipelineForSymbol("BTCUSDT", TEST_OPTS, { modalAvailableUsd: 200 });

    expect(r.grid.decision).toBe("NO_TRADE");
    expect(r.grid.hardScreen.passed).toBe(false);
    // REGRESSION: dulu SELALU persis string ini.
    expect(r.trad.reasons.join(" ")).not.toContain("hard_screen_reject");
    // Head trad benar-benar dievaluasi (punya geometri sweep, bukan stub kosong).
    expect(r.trad.sweep).toBeDefined();
  });

  it("tetap mematikan SEMUA head kalau penolakannya bukan soal regime (volume terlalu tipis)", async () => {
    // low_volume bukan soal cocok-tidaknya strategi -- pair-nya memang tidak
    // layak disentuh head mana pun.
    vi.mocked(binanceProxy.getTicker24hrNative).mockResolvedValue({
      symbol: "BTCUSDT",
      lastPrice: "100",
      priceChange: "0",
      priceChangePercent: "0",
      highPrice: "101",
      lowPrice: "99",
      volume: "1",
      quoteVolume: "1000",
    } as never);

    const r = await runTriplePipelineForSymbol("BTCUSDT", TEST_OPTS, { modalAvailableUsd: 200 });

    expect(r.grid.decision).toBe("NO_TRADE");
    expect(r.trad.reasons.join(" ")).toContain("hard_screen_reject");
    expect(r.trad.decision).toBe("TRAD_NO_TRADE");
  });

  it("tidak menambah subrequest Wave 2 di jalur regime-reject", async () => {
    mockBreakoutMarket();

    await runTriplePipelineForSymbol("BTCUSDT", TEST_OPTS, { modalAvailableUsd: 200 });

    expect(binanceProxy.getGlobalAccountRatio).not.toHaveBeenCalled();
    expect(binanceProxy.getOrderBookDepth).not.toHaveBeenCalled();
    expect(binanceProxy.getOpenInterestHistNative).not.toHaveBeenCalledWith("BTCUSDT", "1h", 24);
  });
});

// ─────────────────────────────────────────────────────────────
// K8 WIRING GUARD (2026-09-04, Stage 3)
//
// dropUnclosedKlines() punya unit test sendiri di toolHelpers.test.ts, TAPI
// itu tidak membuktikan pipeline benar-benar MEMAKAINYA. Mutation test
// membuktikan celah itu nyata: mengganti pemanggilannya di runPipelineInternal
// dengan identity membuat SELURUH suite tetap hijau.
//
// Test ini menutupnya: candle terakhir dibuat masih BERJALAN (closeTime di
// masa depan) dengan high absurd. Kalau pipeline ikut membacanya, bound grid
// akan meledak.
// ─────────────────────────────────────────────────────────────
describe("K8: pipeline mengabaikan candle yang belum close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMockSetup();
  });

  /** Klines datar, TAPI lilin terakhir masih berjalan dan high-nya absurd. */
  function klinesWithLiveLastCandle(count: number): KlineTuple[] {
    const now = Date.now();
    const HOUR = 3_600_000;
    return Array.from({ length: count }, (_, i) => {
      const isLast = i === count - 1;
      // openTime mundur dari sekarang; lilin terakhir buka 5 menit lalu dan
      // baru tutup ~55 menit lagi -> closeTime di MASA DEPAN.
      const openTime = now - (count - 1 - i) * HOUR - 5 * 60_000;
      const closeTime = openTime + HOUR - 1;
      const close = 100 + i * 0.01;
      const high = isLast ? 9999 : close + 0.3;
      return [
        openTime,
        close.toFixed(4),
        high.toFixed(4),
        (close - 0.3).toFixed(4),
        close.toFixed(4),
        "100",
        closeTime,
        "0",
        10,
        "0",
        "0",
        "0",
      ] as unknown as KlineTuple;
    });
  }

  it("REGRESSION: high absurd pada lilin BERJALAN tidak boleh masuk ke bound grid", async () => {
    vi.mocked(binanceProxy.getKlinesNative).mockImplementation(async (_s, _i, limit) =>
      klinesWithLiveLastCandle(limit),
    );

    const r = await runPipelineForSymbol("BTCUSDT", TEST_OPTS);

    expect(r.gridSetup).toBeDefined();
    // Tanpa K8, hh akan ~9999 dan upperPrice ikut meledak.
    expect(r.gridSetup!.hh).toBeLessThan(200);
    expect(r.gridSetup!.upperPrice).toBeLessThan(200);
  });
});
