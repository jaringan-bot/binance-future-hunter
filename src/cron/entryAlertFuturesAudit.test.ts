// AUDIT DRY-RUN (2026-08-29) -- bukti terstruktur untuk investigasi
// "Futures alert tidak pernah fire" pada pipeline entry-alert (triple head:
// GRID / DCA / Traditional Futures).
//
// Berisi 3 bagian:
//   1. Engine Traditional Futures: membuktikan candle-budget off-by-2
//      (pipeline fetch 50 candle 1h untuk lookbackBars=50, engine butuh 52)
//      -> selalu TRAD_NO_TRADE "Candle tidak cukup".
//   2. Engine dengan candle cukup + skenario breakout -> TRAD_TRADE (bukti
//      logic-nya SEHAT, cuma kekurangan data).
//   3. Dispatcher reach: checkEntryAlertForSymbol dengan runTriplePipeline
//      di-stub -> GRID/DCA/Futures masing-masing mencapai sendTelegramAlert.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateTraditionalFuturesEntry } from "./traditionalPipelineEngine.js";
import { computeCvdFromTrades, type KlineCandle } from "../toolHelpers.js";

// ── Helper: candle datar (high 105 / low 100), tidak membentuk sweep ──
function flatCandles(n: number): KlineCandle[] {
  const base = 1_700_000_000_000;
  return Array.from({ length: n }, (_, i) => ({
    openTime: base + i * 3_600_000,
    open: 104,
    high: 105,
    low: 100,
    close: 104,
    volume: 1000,
  }));
}

const EMPTY_CVD = computeCvdFromTrades([]);

// Wave1 dasar untuk skenario TREND_BREAKOUT (regime BREAKOUT, ADX>25, bias
// BULLISH) -- activePrice 110 di atas priorSwingLow 100 -> risk 10, RR 2.0.
function breakoutWave1(candleCount: number, lookbackBars: number) {
  return {
    activePrice: 110,
    candles: flatCandles(candleCount),
    atr14: 1,
    adx14: 30,
    regime: "BREAKOUT" as const,
    bias: "BULLISH" as const,
    activeCvd: EMPTY_CVD,
    priorCvd: EMPTY_CVD,
    oiVelocity: null,
    lookbackBars,
  };
}

describe("AUDIT 1 — Traditional Futures candle budget (root cause)", () => {
  it("pipeline-equivalent input (50 candles, lookbackBars=50) -> TRAD_NO_TRADE karena candle kurang", () => {
    // Persis kondisi runPipelineInternal: klineLimit = max(lookbackBars,40) = 50,
    // DEFAULT_PIPELINE_OPTS.lookbackBars (entryAlertCron) = 50.
    const res = evaluateTraditionalFuturesEntry(breakoutWave1(50, 50), { liquidations: null });
    expect(res.decision).toBe("TRAD_NO_TRADE");
    expect(res.reasons.join(" ")).toMatch(/Candle tidak cukup/i);
    // Butuh 52, dapat 50 -> off-by-2.
    expect(res.reasons.join(" ")).toMatch(/butuh minimal 52, dapat 50/i);
  });

  it("candle cukup (52) tapi skenario breakout valid -> TRAD_TRADE (engine sehat)", () => {
    const res = evaluateTraditionalFuturesEntry(breakoutWave1(52, 50), { liquidations: null });
    expect(res.decision).toBe("TRAD_TRADE");
    expect(res.scenario).toBe("TREND_BREAKOUT");
    expect(res.side).toBe("LONG");
    expect(res.rr).toBeGreaterThanOrEqual(1.5);
  });

  it("threshold boundary: 51 candle masih kurang, 52 baru cukup", () => {
    expect(evaluateTraditionalFuturesEntry(breakoutWave1(51, 50), { liquidations: null }).decision).toBe("TRAD_NO_TRADE");
    expect(evaluateTraditionalFuturesEntry(breakoutWave1(52, 50), { liquidations: null }).decision).toBe("TRAD_TRADE");
  });
});

// ── AUDIT 3 — dispatcher reach (stub triple pipeline) ──
vi.mock("../tools/fullPipeline.js", () => ({
  runTriplePipelineForSymbol: vi.fn(),
}));
vi.mock("../telegram.js", () => ({
  sendTelegramAlert: vi.fn().mockResolvedValue(undefined),
  escapeMarkdown: (t: string) => t,
  formatTraditionalFuturesAlert: () => "TRAD_ALERT_BLOCK",
}));
vi.mock("../d1Client.js", () => ({
  getEntryAlertState: vi.fn().mockResolvedValue(null),
  upsertEntryAlertState: vi.fn().mockResolvedValue(undefined),
}));

import { checkEntryAlertForSymbol } from "./entryAlertCron.js";
import { runTriplePipelineForSymbol } from "../tools/fullPipeline.js";
import { sendTelegramAlert } from "../telegram.js";

const ENV = { TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "y" } as never;

function gridResult(decision: "TRADE" | "WATCH" | "NO_TRADE") {
  return {
    symbol: "BTCUSDT",
    decision,
    rankingScore: decision === "TRADE" ? 72 : 30,
    hardScreen: { passed: true, reasons: ["ok"], quoteVolumeUsd: 9e9, fundingRate: 0, regime1h: "BREAKOUT", regime4h: "BREAKOUT" },
    tier1: { smartMoney: { condition: "BULLISH_DIVERGENCE", smartMoneyBias: "LONG", retailSentiment: "SHORT", confidenceScore: 70, divergenceScore: 60 } },
    gridBotConfig:
      decision === "TRADE"
        ? { lower: 100, upper: 120, gridCount: 20, gridType: "ARITHMETIC", leverage: 5, marginMode: "ISOLATED", stopLoss: 95, takeProfit: 125, marginModeCaveat: "" }
        : undefined,
    reasoning: [],
  };
}

function dcaResult(decision: "DCA_TRADE" | "DCA_WATCH" | "DCA_NO_TRADE") {
  return {
    symbol: "BTCUSDT",
    decision,
    direction: "LONG",
    confidence: decision === "DCA_TRADE" ? 72 : 20,
    volTier: 2,
    effGateAdx4h: 30,
    effCapAdx1d: 35,
    rejectReason: decision === "DCA_NO_TRADE" ? "low confidence" : undefined,
    reasoning: [],
    dcaBotConfig:
      decision === "DCA_TRADE"
        ? { direction: "LONG", priceDropStepPct: 1.5, priceDeviationMultiplier: 1.2, maxDcaOrders: 5, takeProfitPerRoundPct: 1.2, leverage: 5, baseOrderMarginUsd: 40, modalRefUsd: 200, stopLossPct: 12, stopLossPrice: 88, estLiquidationPrice: 80, projectedMaxLossUsd: 24, totalAccumulationDistPct: 9 }
        : undefined,
  };
}

function tradResult(decision: "TRAD_TRADE" | "TRAD_WATCH" | "TRAD_NO_TRADE") {
  return {
    decision,
    scenario: decision === "TRAD_NO_TRADE" ? "NONE" : "TREND_BREAKOUT",
    side: "LONG",
    entry: 110,
    stopLoss: 100,
    takeProfit: 130,
    takeProfit2: 140,
    rr: 2.0,
    slPct: 9.09,
    recommendedLeverage: 9,
    confidence: 0.6,
    bracket: {} as never,
    sweep: {} as never,
    reasons: [],
    dataGaps: [],
  };
}

describe("AUDIT 3 — dispatcher reach per head", () => {
  beforeEach(() => {
    vi.mocked(sendTelegramAlert).mockClear();
  });

  it("GRID TRADE only -> alert terkirim (GRID block)", async () => {
    vi.mocked(runTriplePipelineForSymbol).mockResolvedValue({ grid: gridResult("TRADE"), dca: dcaResult("DCA_NO_TRADE"), trad: tradResult("TRAD_NO_TRADE") } as never);
    const out = await checkEntryAlertForSymbol("BTCUSDT", ENV, Date.now());
    expect(out.gridDecision).toBe("TRADE");
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTelegramAlert).mock.calls[0][1]).toMatch(/GRID TRADE/);
  });

  it("DCA_TRADE only -> alert terkirim (DCA block)", async () => {
    vi.mocked(runTriplePipelineForSymbol).mockResolvedValue({ grid: gridResult("NO_TRADE"), dca: dcaResult("DCA_TRADE"), trad: tradResult("TRAD_NO_TRADE") } as never);
    const out = await checkEntryAlertForSymbol("BTCUSDT", ENV, Date.now());
    expect(out.dcaDecision).toBe("DCA_TRADE");
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTelegramAlert).mock.calls[0][1]).toMatch(/DCA/);
  });

  it("FUTURES TRAD_TRADE only -> alert MENCAPAI dispatcher (⚡ + TRAD block)", async () => {
    vi.mocked(runTriplePipelineForSymbol).mockResolvedValue({ grid: gridResult("NO_TRADE"), dca: dcaResult("DCA_NO_TRADE"), trad: tradResult("TRAD_TRADE") } as never);
    const out = await checkEntryAlertForSymbol("BTCUSDT", ENV, Date.now());
    expect(out.tradDecision).toBe("TRAD_TRADE");
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(sendTelegramAlert).mock.calls[0][1];
    expect(payload).toMatch(/TRADITIONAL FUTURES/);
    expect(payload).toMatch(/TRAD_ALERT_BLOCK/);
  });

  it("FUTURES TRAD_WATCH -> TIDAK alert (isTradAlertWorthy hanya TRAD_TRADE)", async () => {
    vi.mocked(runTriplePipelineForSymbol).mockResolvedValue({ grid: gridResult("NO_TRADE"), dca: dcaResult("DCA_NO_TRADE"), trad: tradResult("TRAD_WATCH") } as never);
    await checkEntryAlertForSymbol("BTCUSDT", ENV, Date.now());
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("semua NO_TRADE -> tidak ada alert", async () => {
    vi.mocked(runTriplePipelineForSymbol).mockResolvedValue({ grid: gridResult("NO_TRADE"), dca: dcaResult("DCA_NO_TRADE"), trad: tradResult("TRAD_NO_TRADE") } as never);
    await checkEntryAlertForSymbol("BTCUSDT", ENV, Date.now());
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });
});
