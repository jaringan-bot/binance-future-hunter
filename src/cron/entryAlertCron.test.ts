import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fullPipeline from "../tools/fullPipeline.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";
import * as telegram from "../telegram.js";
import * as entryWatchlist from "../entryWatchlist.js";
import { checkEntryAlertForSymbol, runEntryAlertCheck, ENTRY_ALERT_PACING_DELAY_MS } from "./entryAlertCron.js";
import type { SymbolPipelineResult } from "../tools/fullPipeline.js";
import * as pacing from "../pacing.js";

vi.mock("../tools/fullPipeline.js", () => ({ runPipelineForSymbol: vi.fn() }));
vi.mock("../binanceProxyClient.js", () => ({ getAllTicker24hrNative: vi.fn(), getBulkFundingRatesNative: vi.fn() }));
vi.mock("../d1Client.js", () => ({ getEntryAlertState: vi.fn(), upsertEntryAlertState: vi.fn(), insertEntryAlertRunLog: vi.fn() }));
vi.mock("../telegram.js", () => ({
  sendTelegramAlert: vi.fn(),
  // Real implementation, not mocked -- formatEntryAlert()'s escaping behavior
  // (and the tests asserting on its output below) needs the actual function,
  // only sendTelegramAlert (the network call) is stubbed.
  escapeMarkdown: (text: string) => text.replace(/([_*`[])/g, "\\$1"),
}));
vi.mock("../entryWatchlist.js", () => ({ getTopUsdtPerpetualWatchlist: vi.fn() }));
vi.mock("../pacing.js", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

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
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(result);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("ONDOUSDT", ENV, 1_000_000);

    const message = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(message).toContain("🟡");
    expect(message).toContain("Ranking score: 35.8");
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
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(result);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("XRPUSDT", ENV, 1_000_000);

    const message = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(message).not.toMatch(/LONG_LIQUIDATION_RISK|CROWDED_LONG/);
    expect(message).toContain("LONG\\_LIQUIDATION\\_RISK · SM Bias BEARISH vs Retail CROWDED\\_LONG");
  });

  it("sends a Telegram alert and stores TRADE state when a symbol transitions into TRADE", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(tradeResult("BTCUSDT"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "TRADE",
      lastAlertAt: 1_000_000,
    });
  });

  it("does not re-alert when still TRADE and the cooldown has not expired", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(tradeResult("BTCUSDT"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "TRADE",
      lastAlertAt: 1_000_000,
    });

    // 1 hour later -- inside the 4-hour cooldown
    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000 + 60 * 60 * 1000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "TRADE",
      lastAlertAt: 1_000_000,
    });
  });

  it("re-alerts when still TRADE and the cooldown has expired", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(tradeResult("BTCUSDT"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "TRADE",
      lastAlertAt: 1_000_000,
    });

    // 5 hours later -- past the 4-hour cooldown
    const now = 1_000_000 + 5 * 60 * 60 * 1000;
    await checkEntryAlertForSymbol("BTCUSDT", ENV, now);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "TRADE", lastAlertAt: now });
  });

  it("sends a Telegram alert and stores WATCH state when a symbol transitions into WATCH", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(watchResult("BTCUSDT"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "WATCH",
      lastAlertAt: 1_000_000,
    });
  });

  it("does not re-alert when still WATCH and the cooldown has not expired", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(watchResult("BTCUSDT"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "WATCH",
      lastAlertAt: 1_000_000,
    });

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000 + 60 * 60 * 1000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      lastDecision: "WATCH",
      lastAlertAt: 1_000_000,
    });
  });

  it("re-alerts when still WATCH and the cooldown has expired", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(watchResult("BTCUSDT"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "WATCH",
      lastAlertAt: 1_000_000,
    });

    const now = 1_000_000 + 5 * 60 * 60 * 1000;
    await checkEntryAlertForSymbol("BTCUSDT", ENV, now);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "WATCH", lastAlertAt: now });
  });

  it("alerts again on transition from WATCH to TRADE even inside the WATCH alert's cooldown", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(tradeResult("BTCUSDT"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue({
      symbol: "BTCUSDT",
      lastDecision: "WATCH",
      lastAlertAt: 1_000_000,
    });

    const now = 1_000_000 + 60 * 1000;
    await checkEntryAlertForSymbol("BTCUSDT", ENV, now);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "TRADE", lastAlertAt: now });
  });

  it("does not alert when WATCH ranking score is below the 40 floor and grid risk is not HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(lowScoreWatchResult("BTCUSDT", "MODERATE"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "WATCH", lastAlertAt: null });
  });

  it("still alerts on WATCH below the 40 floor when grid risk is HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(lowScoreWatchResult("BTCUSDT", "HIGH_RISK"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "WATCH", lastAlertAt: 1_000_000 });
  });

  it("alerts on WATCH with a mid-band score (40-54) even without HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(lowScoreWatchResult("BTCUSDT", "MODERATE", 45));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it("alerts at the exact 40 floor (inclusive) without HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(lowScoreWatchResult("BTCUSDT", "MODERATE", 40));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it("does not alert just below the 40 floor (39.9) without HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(lowScoreWatchResult("BTCUSDT", "MODERATE", 39.9));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("does not alert on WATCH at/above the TRADE threshold even without HIGH_RISK (shouldn't happen from the real pipeline, defensive)", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(lowScoreWatchResult("BTCUSDT", "MODERATE", 60));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("logs the internal pipeline error (e.g. rate-limit self-throttle) so it's visible in wrangler tail, without alerting", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(
      erroredResult("BTCUSDT", "Self-throttle: 781 request ke proxy Binance dalam 60 detik terakhir (limit internal 780/menit)"),
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
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(noTradeResult("BTCUSDT"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "NO_TRADE", lastAlertAt: null });
  });
});

describe("runEntryAlertCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Default: bulk fetch sukses tapi kosong -- test yang gak peduli soal
    // prefetched (mayoritas, karena runPipelineForSymbol di-mock total)
    // gak perlu setup ulang ini satu-satu.
    vi.mocked(binanceProxy.getAllTicker24hrNative).mockResolvedValue([]);
    vi.mocked(binanceProxy.getBulkFundingRatesNative).mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("isolates a per-symbol failure -- one rejecting pipeline call doesn't block the other symbol", async () => {
    vi.mocked(entryWatchlist.getTopUsdtPerpetualWatchlist).mockResolvedValue(["BTCUSDT", "ETHUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runPipelineForSymbol).mockImplementation(async (symbol: string) => {
      if (symbol === "BTCUSDT") throw new Error("pipeline blew up");
      return tradeResult(symbol);
    });

    await runEntryAlertCheck(ENV);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("paces each symbol with a delay so sustained throughput stays within the entry-alert rate budget", async () => {
    vi.mocked(entryWatchlist.getTopUsdtPerpetualWatchlist).mockResolvedValue(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runPipelineForSymbol).mockImplementation(async (symbol: string) => tradeResult(symbol));

    await runEntryAlertCheck(ENV);

    expect(pacing.sleep).toHaveBeenCalledTimes(3);
    expect(pacing.sleep).toHaveBeenCalledWith(ENTRY_ALERT_PACING_DELAY_MS);
  });

  it("records a run-log summary (total/errors/watch/trade tally) after processing the batch, so heartbeatCron can tell market-quiet from backend-broken", async () => {
    vi.mocked(entryWatchlist.getTopUsdtPerpetualWatchlist).mockResolvedValue([
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
      "ADAUSDT",
    ]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runPipelineForSymbol).mockImplementation(async (symbol: string) => {
      if (symbol === "BTCUSDT") return tradeResult(symbol); // TRADE, no error
      if (symbol === "ETHUSDT") return watchResult(symbol); // WATCH, no error
      if (symbol === "SOLUSDT") return erroredResult(symbol, "Self-throttle: ..."); // NO_TRADE, error
      throw new Error("pipeline blew up"); // ADAUSDT -- thrown, not returned as a result
    });

    await runEntryAlertCheck(ENV);

    expect(d1Client.insertEntryAlertRunLog).toHaveBeenCalledWith({
      runAt: expect.any(Number),
      total: 4,
      errors: 2, // SOLUSDT (result.error set) + ADAUSDT (thrown)
      watchCount: 1,
      tradeCount: 1,
    });
  });

  it("bulk-fetches ticker24hr + premiumIndex once and hands both as lookup Maps into every symbol's runPipelineForSymbol call", async () => {
    vi.mocked(entryWatchlist.getTopUsdtPerpetualWatchlist).mockResolvedValue(["BTCUSDT", "ETHUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(binanceProxy.getAllTicker24hrNative).mockResolvedValue([
      { symbol: "BTCUSDT", lastPrice: "60000", priceChange: "0", priceChangePercent: "0", highPrice: "0", lowPrice: "0", volume: "0", quoteVolume: "1000000000" },
      { symbol: "ETHUSDT", lastPrice: "3000", priceChange: "0", priceChangePercent: "0", highPrice: "0", lowPrice: "0", volume: "0", quoteVolume: "500000000" },
    ]);
    vi.mocked(binanceProxy.getBulkFundingRatesNative).mockResolvedValue([
      { symbol: "BTCUSDT", markPrice: "60000", indexPrice: "60000", estimatedSettlePrice: "60000", lastFundingRate: "0.0001", nextFundingTime: 0, interestRate: "0", time: 0 },
      { symbol: "ETHUSDT", markPrice: "3000", indexPrice: "3000", estimatedSettlePrice: "3000", lastFundingRate: "0.0002", nextFundingTime: 0, interestRate: "0", time: 0 },
    ]);
    vi.mocked(fullPipeline.runPipelineForSymbol).mockImplementation(async (symbol: string) => tradeResult(symbol));

    await runEntryAlertCheck(ENV);

    // getAllTicker24hrNative/getBulkFundingRatesNative -- 1 call TOTAL untuk
    // seluruh watchlist (bukan per symbol) -- inti dari task bulk-fetch ini.
    expect(binanceProxy.getAllTicker24hrNative).toHaveBeenCalledTimes(1);
    expect(binanceProxy.getBulkFundingRatesNative).toHaveBeenCalledTimes(1);

    for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
      expect(fullPipeline.runPipelineForSymbol).toHaveBeenCalledWith(
        symbol,
        expect.anything(),
        expect.objectContaining({
          ticker: expect.any(Map),
          funding: expect.any(Map),
        }),
      );
    }
    const [, , prefetchedArg] = vi.mocked(fullPipeline.runPipelineForSymbol).mock.calls[0];
    expect(prefetchedArg?.ticker.get("BTCUSDT")?.lastPrice).toBe("60000");
    expect(prefetchedArg?.funding.get("BTCUSDT")?.lastFundingRate).toBe("0.0001");
  });

  it("falls back to prefetched=undefined (per-symbol fetch inside runPipelineForSymbol) when the bulk fetch itself fails, without failing the whole tick", async () => {
    vi.mocked(entryWatchlist.getTopUsdtPerpetualWatchlist).mockResolvedValue(["BTCUSDT", "ETHUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(binanceProxy.getAllTicker24hrNative).mockRejectedValue(new Error("proxy 500"));
    vi.mocked(binanceProxy.getBulkFundingRatesNative).mockResolvedValue([]);
    vi.mocked(fullPipeline.runPipelineForSymbol).mockImplementation(async (symbol: string) => tradeResult(symbol));

    await runEntryAlertCheck(ENV);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("gagal bulk fetch"),
      expect.stringContaining("proxy 500"),
    );
    // Tick masih jalan penuh buat kedua symbol -- bulk-fetch gagal TIDAK
    // menggagalkan seluruh tick, cuma jatuh balik ke prefetched=undefined.
    expect(fullPipeline.runPipelineForSymbol).toHaveBeenCalledWith("BTCUSDT", expect.anything(), undefined);
    expect(fullPipeline.runPipelineForSymbol).toHaveBeenCalledWith("ETHUSDT", expect.anything(), undefined);
    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(2);
  });
});
