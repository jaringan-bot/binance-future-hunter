import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fullPipeline from "../tools/fullPipeline.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";
import * as telegram from "../telegram.js";
import * as kvConfig from "../kvConfig.js";
import { checkEntryAlertForSymbol, runEntryAlertCheck, ENTRY_ALERT_PACING_DELAY_MS } from "./entryAlertCron.js";
import type { SymbolPipelineResult, TriplePipelineResult } from "../tools/fullPipeline.js";
import type { DcaHeadResult } from "../dcaPipelineEngine.js";
import type { TraditionalFuturesResult } from "./traditionalPipelineEngine.js";
import type { DcaSmartMoneyResult, DcaSmDecision } from "./dcaSmartMoneyAdapter.js";
import * as pacing from "../pacing.js";

vi.mock("../tools/fullPipeline.js", () => ({ runTriplePipelineForSymbol: vi.fn() }));
vi.mock("../binanceProxyClient.js", () => ({
  getAllTicker24hrNative: vi.fn(),
  getBulkFundingRatesNative: vi.fn(),
  getFuturesExchangeInfo: vi.fn(),
}));
vi.mock("../d1Client.js", () => ({
  getEntryAlertState: vi.fn(),
  upsertEntryAlertState: vi.fn(),
  insertEntryAlertRunLog: vi.fn(),
  insertEntryAlertSkipLog: vi.fn().mockResolvedValue(undefined),
  getDcaActivePlan: vi.fn().mockResolvedValue(null),
  upsertDcaActivePlan: vi.fn().mockResolvedValue(undefined),
  deleteDcaActivePlan: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../kvConfig.js", () => ({ getJson: vi.fn().mockResolvedValue(null) }));
vi.mock("../telegram.js", async (importOriginal) => {
  // Real implementations, not mocked -- formatEntryAlert() / the tests below
  // assert on the actual escaping + traditional-futures block output. Only
  // sendTelegramAlert (the network call) is stubbed.
  const actual = await importOriginal<typeof import("../telegram.js")>();
  return { ...actual, sendTelegramAlert: vi.fn() };
});
// entryWatchlist SENGAJA tidak di-mock -- selectUsdtPerpetualWatchlist murni,
// dipakai apa adanya supaya dedup ticker24hr (1 fetch dipakai watchlist +
// prefetch) benar-benar teruji, bukan di-bypass mock.
vi.mock("../pacing.js", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

// Set mock exchangeInfo + ticker24hr supaya selectUsdtPerpetualWatchlist
// menghasilkan tepat `symbols` (urutan = ranking volume desc). ticker entry
// dilengkapi field minimum yang dipakai prefetch Map + hard-screen.
function mockWatchlist(symbols: string[]): void {
  vi.mocked(binanceProxy.getFuturesExchangeInfo).mockResolvedValue({
    symbols: symbols.map((s) => ({
      symbol: s,
      filters: [],
      status: "TRADING",
      contractType: "PERPETUAL",
      quoteAsset: "USDT",
    })),
  } as never);
  vi.mocked(binanceProxy.getAllTicker24hrNative).mockResolvedValue(
    symbols.map((s, i) => ({
      symbol: s,
      lastPrice: "1",
      priceChange: "0",
      priceChangePercent: "0",
      highPrice: "0",
      lowPrice: "0",
      volume: "0",
      quoteVolume: String(symbols.length - i),
    })) as never,
  );
}

function stubDca(symbol: string, decision: DcaHeadResult["decision"] = "DCA_NO_TRADE"): DcaHeadResult {
  return {
    symbol,
    decision,
    direction: decision === "DCA_NO_TRADE" ? null : "LONG",
    confidence: decision === "DCA_TRADE" ? 78 : decision === "DCA_WATCH" ? 58 : 0,
    volTier: 2,
    effGateAdx4h: 38,
    effCapAdx1d: 44,
    rejectReason: decision === "DCA_NO_TRADE" ? "dead_market" : null,
    reasoning: [],
  };
}

function stubDcaSm(decision: DcaSmDecision, over: Partial<DcaSmartMoneyResult> = {}): DcaSmartMoneyResult {
  return {
    decision,
    timingScore: decision === "DCA_TRADE" ? 80 : decision === "DCA_WATCH" ? 65 : 40,
    safetyScore: decision === "DCA_STOP" ? 10 : decision === "DCA_PAUSE_HARD" ? 40 : 60,
    intervalPct: 2,
    nextTriggerPrice: 98,
    pauseLevel: decision === "DCA_STOP" ? "STOP" : decision === "DCA_PAUSE_HARD" ? "PAUSE_HARD" : decision === "DCA_PAUSE_SOFT" ? "PAUSE_SOFT" : "NONE",
    pauseReason: decision === "DCA_PAUSE_SOFT" ? "Safety score 60 < 70" : decision === "DCA_PAUSE_HARD" ? "Safety score 40 < 50" : decision === "DCA_STOP" ? "Safety score 10 < 20" : null,
    entryCount: 0,
    maxEntries: 6,
    fundingPercentile: 40,
    oiVelocityPercentile: 50,
    scenarioCScore: 40,
    reasons: [],
    ...over,
  };
}

function stubTrad(decision: TraditionalFuturesResult["decision"] = "TRAD_NO_TRADE"): TraditionalFuturesResult {
  return {
    decision,
    scenario: decision === "TRAD_NO_TRADE" ? "NONE" : "MEAN_REVERSION",
    side: decision === "TRAD_NO_TRADE" ? null : "LONG",
    entry: decision === "TRAD_NO_TRADE" ? null : 100,
    stopLoss: decision === "TRAD_NO_TRADE" ? null : 95,
    takeProfit: decision === "TRAD_NO_TRADE" ? null : 115,
    takeProfit2: decision === "TRAD_NO_TRADE" ? null : 125,
    rr: decision === "TRAD_NO_TRADE" ? 0 : 3,
    slPct: decision === "TRAD_NO_TRADE" ? 0 : 5,
    recommendedLeverage: decision === "TRAD_NO_TRADE" ? 0 : 10,
    confidence: decision === "TRAD_NO_TRADE" ? 0 : 0.7,
    bracket: {} as never,
    sweep: {} as never,
    reasons: [],
    dataGaps: [],
  };
}

// Wrap a grid result into a TriplePipelineResult (DCA + Traditional stubbed
// NO_TRADE by default).
function dual(
  grid: SymbolPipelineResult,
  dcaDecision: DcaHeadResult["decision"] = "DCA_NO_TRADE",
  tradDecision: TraditionalFuturesResult["decision"] = "TRAD_NO_TRADE",
): TriplePipelineResult {
  return { grid, dca: stubDca(grid.symbol, dcaDecision), trad: stubTrad(tradDecision), dcaSm: null };
}

function tradeResult(symbol: string): SymbolPipelineResult {
  return {
    symbol,
    decision: "TRADE",
    rankingScore: 80,
    hardScreen: { passed: true, reasons: [], quoteVolumeUsd: 1, fundingRate: 0, regime1h: "RANGING", regime4h: "RANGING" },
    reasoning: [],
  } as unknown as SymbolPipelineResult;
}

function watchResult(symbol: string): SymbolPipelineResult {
  // rankingScore mid-band (40-54, bukan 80 dari tradeResult) -- WATCH nyata
  // dari decidePipelineOutcome gak pernah punya skor >=55 kecuali HIGH_RISK
  // (lihat isAlertWorthy di entryAlertCron.ts), jadi 80 gak realistis di sini.
  return { ...tradeResult(symbol), decision: "WATCH", rankingScore: 45 } as SymbolPipelineResult;
}

function noTradeResult(symbol: string): SymbolPipelineResult {
  return { ...tradeResult(symbol), decision: "NO_TRADE" } as SymbolPipelineResult;
}

function erroredResult(symbol: string, message: string): SymbolPipelineResult {
  return { ...noTradeResult(symbol), error: message } as SymbolPipelineResult;
}

function lowScoreWatchResult(
  symbol: string,
  gridRiskStatus: "SAFE" | "MODERATE" | "HIGH_RISK" | "REJECT" = "MODERATE",
  rankingScore = 30,
): SymbolPipelineResult {
  return {
    ...tradeResult(symbol),
    decision: "WATCH",
    rankingScore,
    risk: { chosenLeverage: 5, initialCapitalSolved: 100, evaluatedLeverages: [], gridRisk: { status: gridRiskStatus } },
  } as unknown as SymbolPipelineResult;
}

const ENV = { TELEGRAM_BOT_TOKEN: "abc", TELEGRAM_CHAT_ID: "999" };

describe("checkEntryAlertForSymbol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("formats the Telegram message with a rounded ranking score, adaptive-precision prices, and a status icon", async () => {
    const result = {
      ...tradeResult("ONDOUSDT"),
      decision: "WATCH",
      rankingScore: 35.78099949618541,
      risk: { chosenLeverage: 5, initialCapitalSolved: 100, evaluatedLeverages: [], gridRisk: { status: "HIGH_RISK" } },
      gridBotConfig: {
        lower: 0.35790218401913754,
        upper: 0.40649781598086243,
        gridCount: 18,
        gridType: "ARITHMETIC",
        leverage: 5,
        marginMode: "ISOLATED",
        stopLoss: 0.3434859054473654,
        takeProfit: 0.41379563196172486,
        marginModeCaveat: "",
      },
      tier1: {
        smartMoney: {
          condition: "BULLISH_ACCUMULATION",
          smartMoneyBias: "BULLISH",
          retailSentiment: "CROWDED_SHORT",
          confidenceScore: 72,
          divergenceScore: 0.6,
        },
        mm: { totalScore: 3, tier: "MODERATE", activeSignals: [] },
        obi: { depth5: 0, depth10: 0, depth20: 0 },
        cvd: { buyPct: 0, cvd: 0 },
        oi: { changePct: 0 },
        regime1h: { regime: "RANGING", confidence: 0.5, reason: "" },
        regime4h: { regime: "RANGING", confidence: 0.5, reason: "" },
      },
    } as unknown as SymbolPipelineResult;
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(result));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("ONDOUSDT", ENV, 1_000_000);

    const message = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(message).toContain("🟡");
    expect(message).toContain("Grid 35.8/100");
    expect(message).not.toContain("35.78099949618541");
    expect(message).toContain("0.357902");
    expect(message).not.toContain("0.35790218401913754");
    // Markdown-escaped (see escapeMarkdown test below) -- underscores in
    // enum values must never reach Telegram unescaped, regardless of parity.
    expect(message).toContain("BULLISH\\_ACCUMULATION · SM Bias BULLISH vs Retail CROWDED\\_SHORT");
  });

  it("escapes enum underscores so an odd-total combination can't break Telegram Markdown parsing", async () => {
    // LONG_LIQUIDATION_RISK (2 underscores) + CROWDED_LONG (1) = 3, ODD total --
    // this exact combination broke legacy "Markdown" parse_mode in production
    // (2026-08-27, "can't find end of the entity" HTTP 400) before escaping
    // was added. Asserting the raw values never appear unescaped proves the
    // fix, independent of which specific combination happens to show up.
    const result = {
      ...tradeResult("XRPUSDT"),
      tier1: {
        smartMoney: {
          condition: "LONG_LIQUIDATION_RISK",
          smartMoneyBias: "BEARISH",
          retailSentiment: "CROWDED_LONG",
          confidenceScore: 60,
          divergenceScore: -0.4,
        },
        mm: { totalScore: 2, tier: "MODERATE", activeSignals: [] },
        obi: { depth5: 0, depth10: 0, depth20: 0 },
        cvd: { buyPct: 0, cvd: 0 },
        oi: { changePct: 0 },
        regime1h: { regime: "RANGING", confidence: 0.5, reason: "" },
        regime4h: { regime: "RANGING", confidence: 0.5, reason: "" },
      },
    } as unknown as SymbolPipelineResult;
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(result));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("XRPUSDT", ENV, 1_000_000);

    const message = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(message).not.toMatch(/LONG_LIQUIDATION_RISK|CROWDED_LONG/);
    expect(message).toContain("LONG\\_LIQUIDATION\\_RISK · SM Bias BEARISH vs Retail CROWDED\\_LONG");
  });

  it("sends a Telegram alert and stores TRADE state when a symbol transitions into TRADE", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(tradeResult("BTCUSDT")));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "TRADE/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });
  });

  it("does not re-alert when still TRADE and the cooldown has not expired", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(tradeResult("BTCUSDT")));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "TRADE/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });

    // 1 hour later -- inside the 4-hour cooldown
    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000 + 60 * 60 * 1000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "TRADE/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });
  });

  it("re-alerts when still TRADE and the cooldown has expired", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(tradeResult("BTCUSDT")));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "TRADE/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });

    // 5 hours later -- past the 4-hour cooldown
    const now = 1_000_000 + 5 * 60 * 60 * 1000;
    await checkEntryAlertForSymbol("BTCUSDT", ENV, now);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "TRADE/DCA_NO_TRADE/TRAD_NO_TRADE", lastAlertAt: now });
  });

  it("sends a Telegram alert and stores WATCH state when a symbol transitions into WATCH", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(watchResult("BTCUSDT")));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "WATCH/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });
  });

  it("does not re-alert when still WATCH and the cooldown has not expired", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(watchResult("BTCUSDT")));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "WATCH/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000 + 60 * 60 * 1000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "WATCH/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });
  });

  it("re-alerts when still WATCH and the cooldown has expired", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(watchResult("BTCUSDT")));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "WATCH/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });

    const now = 1_000_000 + 5 * 60 * 60 * 1000;
    await checkEntryAlertForSymbol("BTCUSDT", ENV, now);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "WATCH/DCA_NO_TRADE/TRAD_NO_TRADE", lastAlertAt: now });
  });

  it("alerts again on transition from WATCH to TRADE even inside the WATCH alert's cooldown", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(tradeResult("BTCUSDT")));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "WATCH/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });

    const now = 1_000_000 + 60 * 1000;
    await checkEntryAlertForSymbol("BTCUSDT", ENV, now);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "TRADE/DCA_NO_TRADE/TRAD_NO_TRADE", lastAlertAt: now });
  });

  it("does not alert when WATCH ranking score is below the 40 floor and grid risk is not HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(lowScoreWatchResult("BTCUSDT", "MODERATE")));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "WATCH/DCA_NO_TRADE/TRAD_NO_TRADE", lastAlertAt: null });
  });

  it("still alerts on WATCH below the 40 floor when grid risk is HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(lowScoreWatchResult("BTCUSDT", "HIGH_RISK")));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "WATCH/DCA_NO_TRADE/TRAD_NO_TRADE", lastAlertAt: 1_000_000 });
  });

  it("alerts on WATCH with a mid-band score (40-54) even without HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(lowScoreWatchResult("BTCUSDT", "MODERATE", 45)));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it("alerts at the exact 40 floor (inclusive) without HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(lowScoreWatchResult("BTCUSDT", "MODERATE", 40)));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it("does not alert just below the 40 floor (39.9) without HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(lowScoreWatchResult("BTCUSDT", "MODERATE", 39.9)));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("does not alert on WATCH at/above the TRADE threshold even without HIGH_RISK (shouldn't happen from the real pipeline, defensive)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(lowScoreWatchResult("BTCUSDT", "MODERATE", 60)));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("logs the internal pipeline error (e.g. rate-limit self-throttle) so it's visible in wrangler tail, without alerting", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(
      dual(erroredResult("BTCUSDT", "Self-throttle: 781 request ke proxy Binance dalam 60 detik terakhir (limit internal 780/menit)")),
    );
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("BTCUSDT"),
      expect.stringContaining("Self-throttle"),
    );
  });

  it("does not alert and just records state when the decision is NO_TRADE", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(noTradeResult("BTCUSDT")));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "NO_TRADE/DCA_NO_TRADE/TRAD_NO_TRADE", lastAlertAt: null });
  });

  it("alerts on a DCA-only worthy symbol (grid NO_TRADE) with the 🔵 marker and a DCA section", async () => {
    const g = { ...noTradeResult("SOLUSDT"), hardScreen: { passed: true, reasons: [], quoteVolumeUsd: 1, fundingRate: 0, regime1h: "TRENDING_UP", regime4h: "TRENDING_UP" } } as SymbolPipelineResult;
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue({
      grid: g,
      dca: {
        symbol: "SOLUSDT",
        decision: "DCA_TRADE",
        direction: "LONG",
        confidence: 78,
        volTier: 2,
        effGateAdx4h: 38,
        effCapAdx1d: 44,
        rejectReason: null,
        reasoning: [],
        dcaBotConfig: {
          direction: "LONG",
          priceDropStepPct: 1.2,
          priceDeviationMultiplier: 1.15,
          dcaOrderSizeMultiplier: 1,
          maxDcaOrders: 4,
          takeProfitPerRoundPct: 1.25,
          leverage: 5,
          baseOrderMarginUsd: 12,
          dcaOrderMarginUsd: 12,
          stopLossPrice: 168.2,
          stopLossPct: 6.8,
          estLiquidationPrice: 151,
          projectedMaxLossUsd: 17.9,
          totalAccumulationDistPct: 10.6,
          modalRefUsd: 200,
          marginModeCaveat: "",
        },
      },
      trad: stubTrad(),
      dcaSm: null,
    });
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("SOLUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(msg).toContain("🔵");
    expect(msg).toContain("DCA LAYAK ENTRY");
    expect(msg).toContain("Price drop step 1.2%");
    expect(msg).toContain("GRID: NO\\_TRADE");
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "SOLUSDT",
      lastDecision: "NO_TRADE/DCA_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });
  });

  it("fires again when the DCA head flips NO_TRADE->WATCH even though grid stayed TRADE inside its cooldown", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(tradeResult("BTCUSDT"), "DCA_WATCH"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "TRADE/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });

    // 1 hour later -- grid cooldown NOT expired, but composite changed
    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000 + 60 * 60 * 1000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "TRADE/DCA_WATCH/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000 + 60 * 60 * 1000,
    });
  });

  it("alerts on a TRADITIONAL-FUTURES-only worthy symbol (grid + DCA NO_TRADE) with ⚡ and a bracket section", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(noTradeResult("BTCUSDT"), "DCA_NO_TRADE", "TRAD_TRADE"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(msg).toContain("⚡");
    expect(msg).toContain("TRADITIONAL FUTURES");
    expect(msg).toContain("\\[SCENARIO: MEAN\\_REVERSION]");
    expect(msg).toMatch(/Take Profit 1/);
    expect(msg).toMatch(/R:R/);
    expect(msg).toMatch(/Est\. Loss/);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "NO_TRADE/DCA_NO_TRADE/TRAD_TRADE",
      lastAlertAt: 1_000_000,
    });
  });

  it("does NOT alert when the trad head is only TRAD_WATCH (grid/DCA also quiet)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(noTradeResult("BTCUSDT"), "DCA_NO_TRADE", "TRAD_WATCH"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "NO_TRADE/DCA_NO_TRADE/TRAD_WATCH",
      lastAlertAt: null,
    });
  });

  it("does NOT alert when dcaSm is DCA_PAUSE_SOFT (noise: timing<60 / safety<70 / S_C<25 / GRID_NO_TRADE)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue({
      grid: noTradeResult("BTCUSDT"),
      dca: stubDca("BTCUSDT", "DCA_WATCH"),
      trad: stubTrad(),
      dcaSm: stubDcaSm("DCA_PAUSE_SOFT"),
    });
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "NO_TRADE/DCA_PAUSE_SOFT/TRAD_NO_TRADE",
      lastAlertAt: null,
    });
  });

  it("does NOT re-alert PAUSE_SOFT after the 4h cooldown (no reminder spam)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue({
      grid: noTradeResult("BTCUSDT"),
      dca: stubDca("BTCUSDT", "DCA_WATCH"),
      trad: stubTrad(),
      dcaSm: stubDcaSm("DCA_PAUSE_SOFT"),
    });
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "NO_TRADE/DCA_PAUSE_SOFT/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000 + 5 * 60 * 60 * 1000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("does NOT put DCA PAUSE SOFT in a grid-TRADE alert (grid still fires, DCA slot stays silent)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue({
      grid: tradeResult("BTCUSDT"),
      dca: stubDca("BTCUSDT", "DCA_WATCH"),
      trad: stubTrad(),
      dcaSm: stubDcaSm("DCA_PAUSE_SOFT"),
    });
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(msg).toContain("GRID TRADE");
    expect(msg).not.toContain("DCA PAUSE SOFT");
    expect(msg).not.toContain("⏸️");
  });

  it("alerts when dcaSm leaves PAUSE_SOFT for DCA_TRADE (quality transition still fires)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue({
      grid: noTradeResult("ETHUSDT"),
      dca: stubDca("ETHUSDT", "DCA_TRADE"),
      trad: stubTrad(),
      dcaSm: stubDcaSm("DCA_TRADE"),
    });
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "ETHUSDT",
      lastDecision: "NO_TRADE/DCA_PAUSE_SOFT/TRAD_NO_TRADE",
      lastAlertAt: null,
    });

    await checkEntryAlertForSymbol("ETHUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(msg).toContain("DCA LAYAK ENTRY");
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "ETHUSDT",
      lastDecision: "NO_TRADE/DCA_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });
  });

  it("does NOT alert when dcaSm is DCA_PAUSE_HARD (safety freeze / long-squeeze / max entries)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue({
      grid: noTradeResult("SOLUSDT"),
      dca: stubDca("SOLUSDT", "DCA_WATCH"),
      trad: stubTrad(),
      dcaSm: stubDcaSm("DCA_PAUSE_HARD"),
    });
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("SOLUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "SOLUSDT",
      lastDecision: "NO_TRADE/DCA_PAUSE_HARD/TRAD_NO_TRADE",
      lastAlertAt: null,
    });
  });

  it("does NOT re-alert PAUSE_HARD after the 4h cooldown (no reminder spam)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue({
      grid: noTradeResult("SOLUSDT"),
      dca: stubDca("SOLUSDT", "DCA_WATCH"),
      trad: stubTrad(),
      dcaSm: stubDcaSm("DCA_PAUSE_HARD"),
    });
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "SOLUSDT",
      lastDecision: "NO_TRADE/DCA_PAUSE_HARD/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });

    await checkEntryAlertForSymbol("SOLUSDT", ENV, 1_000_000 + 5 * 60 * 60 * 1000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("does NOT put DCA PAUSE HARD in a grid-TRADE alert (grid still fires, DCA slot stays silent)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue({
      grid: tradeResult("SOLUSDT"),
      dca: stubDca("SOLUSDT", "DCA_WATCH"),
      trad: stubTrad(),
      dcaSm: stubDcaSm("DCA_PAUSE_HARD"),
    });
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("SOLUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(msg).toContain("GRID TRADE");
    expect(msg).not.toContain("DCA PAUSE HARD");
    expect(msg).not.toContain("🧊");
  });

  it("alerts when dcaSm leaves PAUSE_HARD for DCA_TRADE (quality transition still fires)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue({
      grid: noTradeResult("ETHUSDT"),
      dca: stubDca("ETHUSDT", "DCA_TRADE"),
      trad: stubTrad(),
      dcaSm: stubDcaSm("DCA_TRADE"),
    });
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "ETHUSDT",
      lastDecision: "NO_TRADE/DCA_PAUSE_HARD/TRAD_NO_TRADE",
      lastAlertAt: null,
    });

    await checkEntryAlertForSymbol("ETHUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1]).toContain("DCA LAYAK ENTRY");
  });

  it("still alerts on dcaSm DCA_STOP (plan invalidated)", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue({
      grid: noTradeResult("SOLUSDT"),
      dca: stubDca("SOLUSDT", "DCA_WATCH"),
      trad: stubTrad(),
      dcaSm: stubDcaSm("DCA_STOP"),
    });
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("SOLUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1]).toContain("DCA PLAN INVALIDATED");
  });

  it("re-alerts on a trad-head transition (TRAD_NO_TRADE -> TRAD_TRADE) even inside a prior cooldown", async () => {
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockResolvedValue(dual(tradeResult("BTCUSDT"), "DCA_NO_TRADE", "TRAD_TRADE"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "TRADE/DCA_NO_TRADE/TRAD_NO_TRADE",
      lastAlertAt: 1_000_000,
    });

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000 + 60 * 1000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "TRADE/DCA_NO_TRADE/TRAD_TRADE",
      lastAlertAt: 1_000_000 + 60 * 1000,
    });
  });
});

describe("runEntryAlertCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Default: premiumIndex sukses tapi kosong. exchangeInfo + ticker24hr
    // di-set per-test lewat mockWatchlist().
    vi.mocked(binanceProxy.getBulkFundingRatesNative).mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("isolates a per-symbol failure -- one rejecting pipeline call doesn't block the other symbol", async () => {
    mockWatchlist(["BTCUSDT", "ETHUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockImplementation(async (symbol: string) => {
      if (symbol === "BTCUSDT") throw new Error("pipeline blew up");
      return dual(tradeResult(symbol));
    });

    await runEntryAlertCheck(ENV);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("paces each symbol with a delay so sustained throughput stays within the entry-alert rate budget", async () => {
    mockWatchlist(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockImplementation(async (symbol: string) => dual(tradeResult(symbol)));

    await runEntryAlertCheck(ENV);

    expect(pacing.sleep).toHaveBeenCalledTimes(3);
    expect(pacing.sleep).toHaveBeenCalledWith(ENTRY_ALERT_PACING_DELAY_MS);
  });

  it("records a run-log summary (total/errors/watch/trade tally) after processing the batch, so heartbeatCron can tell market-quiet from backend-broken", async () => {
    mockWatchlist(["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockImplementation(async (symbol: string) => {
      if (symbol === "BTCUSDT") return dual(tradeResult(symbol)); // GRID TRADE, no error
      if (symbol === "ETHUSDT") return dual(watchResult(symbol), "DCA_WATCH"); // GRID WATCH + DCA WATCH
      if (symbol === "SOLUSDT") return dual(erroredResult(symbol, "Self-throttle: ...")); // error
      throw new Error("pipeline blew up"); // ADAUSDT -- thrown
    });

    await runEntryAlertCheck(ENV);

    expect(d1Client.insertEntryAlertRunLog).toHaveBeenCalledWith({
      runAt: expect.any(Number),
      total: 4,
      errors: 2, // SOLUSDT (grid.error set) + ADAUSDT (thrown)
      watchCount: 1, // ETHUSDT grid WATCH
      tradeCount: 1, // BTCUSDT grid TRADE
      dcaWatchCount: 1, // ETHUSDT dca WATCH
      dcaTradeCount: 0,
      tradWatchCount: 0, // all trad heads NO_TRADE in this fixture
      tradTradeCount: 0,
    });
  });

  it("logs AND persists the traditional-futures tally (trad_* columns, migration 0009) after the batch", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockWatchlist(["BTCUSDT", "ETHUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockImplementation(async (symbol: string) =>
      dual(noTradeResult(symbol), "DCA_NO_TRADE", symbol === "BTCUSDT" ? "TRAD_TRADE" : "TRAD_WATCH"),
    );

    await runEntryAlertCheck(ENV);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("trad tally: TRAD_TRADE=1 TRAD_WATCH=1"));
    // trad_* columns now persisted (migration 0009): BTCUSDT TRAD_TRADE + ETHUSDT TRAD_WATCH.
    expect(d1Client.insertEntryAlertRunLog).toHaveBeenCalledWith(
      expect.objectContaining({ tradTradeCount: 1, tradWatchCount: 1 }),
    );
  });

  it("fetches ticker24hr exactly once per tick -- the SAME response feeds watchlist selection and the prefetch Map (dedup, was 2 full fetches)", async () => {
    mockWatchlist(["BTCUSDT", "ETHUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockImplementation(async (symbol: string) => dual(tradeResult(symbol)));

    await runEntryAlertCheck(ENV);

    expect(binanceProxy.getFuturesExchangeInfo).toHaveBeenCalledTimes(1);
    expect(binanceProxy.getAllTicker24hrNative).toHaveBeenCalledTimes(1);
    expect(binanceProxy.getBulkFundingRatesNative).toHaveBeenCalledTimes(1);
  });

  it("bulk-fetches ticker24hr + premiumIndex once and hands both as lookup Maps into every symbol's runPipelineForSymbol call", async () => {
    vi.mocked(binanceProxy.getFuturesExchangeInfo).mockResolvedValue({
      symbols: [
        { symbol: "BTCUSDT", filters: [], status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT" },
        { symbol: "ETHUSDT", filters: [], status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT" },
      ],
    } as never);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(binanceProxy.getAllTicker24hrNative).mockResolvedValue([
      { symbol: "BTCUSDT", lastPrice: "60000", priceChange: "0", priceChangePercent: "0", highPrice: "0", lowPrice: "0", volume: "0", quoteVolume: "1000000000" },
      { symbol: "ETHUSDT", lastPrice: "3000", priceChange: "0", priceChangePercent: "0", highPrice: "0", lowPrice: "0", volume: "0", quoteVolume: "500000000" },
    ] as never);
    vi.mocked(binanceProxy.getBulkFundingRatesNative).mockResolvedValue([
      { symbol: "BTCUSDT", markPrice: "60000", indexPrice: "60000", estimatedSettlePrice: "60000", lastFundingRate: "0.0001", nextFundingTime: 0, interestRate: "0", time: 0 },
      { symbol: "ETHUSDT", markPrice: "3000", indexPrice: "3000", estimatedSettlePrice: "3000", lastFundingRate: "0.0002", nextFundingTime: 0, interestRate: "0", time: 0 },
    ]);
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockImplementation(async (symbol: string) => dual(tradeResult(symbol)));

    await runEntryAlertCheck(ENV);

    expect(binanceProxy.getAllTicker24hrNative).toHaveBeenCalledTimes(1);
    expect(binanceProxy.getBulkFundingRatesNative).toHaveBeenCalledTimes(1);

    for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
      expect(fullPipeline.runTriplePipelineForSymbol).toHaveBeenCalledWith(
        symbol,
        expect.anything(), // opts
        expect.objectContaining({ modalAvailableUsd: expect.any(Number) }), // dcaOpts
        expect.objectContaining({
          ticker: expect.any(Map),
          funding: expect.any(Map),
        }),
      );
    }
    const [, , , prefetchedArg] = vi.mocked(fullPipeline.runTriplePipelineForSymbol).mock.calls[0];
    expect(prefetchedArg?.ticker.get("BTCUSDT")?.lastPrice).toBe("60000");
    expect(prefetchedArg?.funding.get("BTCUSDT")?.lastFundingRate).toBe("0.0001");
  });

  it("processes only the top-N F3-ranked pairs (liquid + calm) and records the skipped symbol list to D1", async () => {
    mockWatchlist(["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"]);
    // F3 favours high volume + low |priceChange| + low |funding|.
    // AAA/BBB: big volume, tame. CCC: extreme funding. DDD: extreme move. EEE: thin volume.
    const tk = (symbol: string, quoteVolume: string, priceChangePercent: string) => ({
      symbol, lastPrice: "1", priceChange: "0", priceChangePercent,
      highPrice: "0", lowPrice: "0", volume: "0", quoteVolume,
    });
    vi.mocked(binanceProxy.getAllTicker24hrNative).mockResolvedValue([
      tk("AAAUSDT", "900000000", "1.2"),
      tk("BBBUSDT", "800000000", "2.0"),
      tk("CCCUSDT", "700000000", "2.5"),
      tk("DDDUSDT", "600000000", "45"),
      tk("EEEUSDT", "5000000", "1.0"),
    ] as never);
    vi.mocked(binanceProxy.getBulkFundingRatesNative).mockResolvedValue(
      [
        ["AAAUSDT", "0.00003"],
        ["BBBUSDT", "0.00004"],
        ["CCCUSDT", "0.009"],
        ["DDDUSDT", "0.00005"],
        ["EEEUSDT", "0.00002"],
      ].map(([symbol, r]) => ({
        symbol, markPrice: "1", indexPrice: "1", estimatedSettlePrice: "1",
        lastFundingRate: r, nextFundingTime: 0, interestRate: "0", time: 0,
      })) as never,
    );
    vi.mocked(kvConfig.getJson).mockResolvedValue(2); // top_n = 2
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockImplementation(async (symbol: string) => dual(noTradeResult(symbol)));

    await runEntryAlertCheck(ENV);

    const analysed = vi.mocked(fullPipeline.runTriplePipelineForSymbol).mock.calls.map((c) => c[0]).sort();
    expect(analysed).toEqual(["AAAUSDT", "BBBUSDT"]);

    expect(d1Client.insertEntryAlertSkipLog).toHaveBeenCalledWith({
      runAt: expect.any(Number),
      skippedSymbols: expect.arrayContaining(["CCCUSDT", "DDDUSDT", "EEEUSDT"]),
      topN: 2,
    });
    const [{ skippedSymbols }] = vi.mocked(d1Client.insertEntryAlertSkipLog).mock.calls[0];
    expect(skippedSymbols).toHaveLength(3);
  });

  it("skips the top-N pre-filter entirely (processes the full watchlist) when premiumIndex is unavailable -- no silent partial coverage", async () => {
    mockWatchlist(["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
    vi.mocked(binanceProxy.getBulkFundingRatesNative).mockRejectedValue(new Error("proxy 500"));
    vi.mocked(kvConfig.getJson).mockResolvedValue(1); // would be top_n=1 if pre-filter ran
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockImplementation(async (s: string) => dual(noTradeResult(s)));

    await runEntryAlertCheck(ENV);

    expect(vi.mocked(fullPipeline.runTriplePipelineForSymbol).mock.calls.map((c) => c[0]).sort()).toEqual([
      "AAAUSDT",
      "BBBUSDT",
      "CCCUSDT",
    ]);
    expect(d1Client.insertEntryAlertSkipLog).not.toHaveBeenCalled();
  });

  it("defaults top-N to 40 when the KV config key is unset", async () => {
    mockWatchlist(Array.from({ length: 60 }, (_, i) => `S${String(i).padStart(2, "0")}USDT`));
    vi.mocked(binanceProxy.getBulkFundingRatesNative).mockResolvedValue([]);
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockImplementation(async (s: string) => dual(noTradeResult(s)));

    await runEntryAlertCheck(ENV);

    expect(vi.mocked(fullPipeline.runTriplePipelineForSymbol).mock.calls).toHaveLength(40);
  });

  it("falls back to prefetched=undefined (per-symbol fetch inside runPipelineForSymbol) when premiumIndex bulk fetch fails, without failing the whole tick", async () => {
    mockWatchlist(["BTCUSDT", "ETHUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(binanceProxy.getBulkFundingRatesNative).mockRejectedValue(new Error("proxy 500"));
    vi.mocked(fullPipeline.runTriplePipelineForSymbol).mockImplementation(async (symbol: string) => dual(tradeResult(symbol)));

    await runEntryAlertCheck(ENV);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("gagal bulk fetch premiumIndex"),
      expect.stringContaining("proxy 500"),
    );
    // Tick masih jalan penuh buat kedua symbol -- premiumIndex gagal TIDAK
    // menggagalkan seluruh tick, cuma jatuh balik ke prefetched=undefined.
    expect(fullPipeline.runTriplePipelineForSymbol).toHaveBeenCalledWith("BTCUSDT", expect.anything(), expect.anything(), undefined);
    expect(fullPipeline.runTriplePipelineForSymbol).toHaveBeenCalledWith("ETHUSDT", expect.anything(), expect.anything(), undefined);
    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(2);
  });
});
