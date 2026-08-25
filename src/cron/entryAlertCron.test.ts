import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fullPipeline from "../tools/fullPipeline.js";
import * as d1Client from "../d1Client.js";
import * as telegram from "../telegram.js";
import * as entryWatchlist from "../entryWatchlist.js";
import { checkEntryAlertForSymbol, runEntryAlertCheck } from "./entryAlertCron.js";
import type { SymbolPipelineResult } from "../tools/fullPipeline.js";

vi.mock("../tools/fullPipeline.js", () => ({ runPipelineForSymbol: vi.fn() }));
vi.mock("../d1Client.js", () => ({ getEntryAlertState: vi.fn(), upsertEntryAlertState: vi.fn() }));
vi.mock("../telegram.js", () => ({ sendTelegramAlert: vi.fn() }));
vi.mock("../entryWatchlist.js", () => ({ getTop200UsdtPerpetualWatchlist: vi.fn() }));

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

const ENV = { TELEGRAM_BOT_TOKEN: "abc", TELEGRAM_CHAT_ID: "999" };

describe("checkEntryAlertForSymbol", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

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

  it("does not alert and just records state when the decision is not TRADE", async () => {
    vi.mocked(fullPipeline.runPipelineForSymbol).mockResolvedValue(watchResult("BTCUSDT"));
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);

    await checkEntryAlertForSymbol("BTCUSDT", ENV, 1_000_000);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(d1Client.upsertEntryAlertState).toHaveBeenCalledWith({ symbol: "BTCUSDT", lastDecision: "WATCH", lastAlertAt: null });
  });
});

describe("runEntryAlertCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("isolates a per-symbol failure -- one rejecting pipeline call doesn't block the other symbol", async () => {
    vi.mocked(entryWatchlist.getTop200UsdtPerpetualWatchlist).mockResolvedValue(["BTCUSDT", "ETHUSDT"]);
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(fullPipeline.runPipelineForSymbol).mockImplementation(async (symbol: string) => {
      if (symbol === "BTCUSDT") throw new Error("pipeline blew up");
      return tradeResult(symbol);
    });

    await runEntryAlertCheck(ENV);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
