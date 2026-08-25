import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fullPipeline from "../tools/fullPipeline.js";
import * as d1Client from "../d1Client.js";
import * as telegram from "../telegram.js";
import * as entryWatchlist from "../entryWatchlist.js";
import { checkEntryAlertForSymbol, runEntryAlertCheck, ENTRY_ALERT_PACING_DELAY_MS } from "./entryAlertCron.js";
import type { SymbolPipelineResult } from "../tools/fullPipeline.js";
import * as pacing from "../pacing.js";

vi.mock("../tools/fullPipeline.js", () => ({ runPipelineForSymbol: vi.fn() }));
vi.mock("../d1Client.js", () => ({ getEntryAlertState: vi.fn(), upsertEntryAlertState: vi.fn() }));
vi.mock("../telegram.js", () => ({ sendTelegramAlert: vi.fn() }));
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
  return { ...tradeResult(symbol), decision: "WATCH" } as SymbolPipelineResult;
}

function noTradeResult(symbol: string): SymbolPipelineResult {
  return { ...tradeResult(symbol), decision: "NO_TRADE" } as SymbolPipelineResult;
}

function erroredResult(symbol: string, message: string): SymbolPipelineResult {
  return { ...noTradeResult(symbol), error: message } as SymbolPipelineResult;
}

function lowScoreWatchResult(symbol: string, gridRiskStatus: "SAFE" | "MODERATE" | "HIGH_RISK" | "REJECT" = "MODERATE"): SymbolPipelineResult {
  return {
    ...tradeResult(symbol),
    decision: "WATCH",
    rankingScore: 30,
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
    expect(message).toContain("BULLISH_ACCUMULATION · SM Bias BULLISH vs Retail CROWDED_SHORT");
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

  it("does not alert when WATCH is driven by a low ranking score (below 55) and grid risk is not HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(lowScoreWatchResult("BTCUSDT", "MODERATE"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "WATCH", lastAlertAt: null });
  });

  it("still alerts on WATCH with a low ranking score when grid risk is HIGH_RISK", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(lowScoreWatchResult("BTCUSDT", "HIGH_RISK"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "WATCH", lastAlertAt: 1_000_000 });
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
});
