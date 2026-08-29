import { describe, it, expect, vi, afterEach } from "vitest";
import { sendTelegramAlert, escapeMarkdown, formatTraditionalFuturesAlert } from "./telegram.js";
import type { TraditionalFuturesResult } from "./cron/traditionalPipelineEngine.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("sendTelegramAlert", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs the text to the Telegram sendMessage API with the configured chat_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await sendTelegramAlert({ TELEGRAM_BOT_TOKEN: "abc123", TELEGRAM_CHAT_ID: "999" }, "BTCUSDT masuk TRADE");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.telegram.org/botabc123/sendMessage");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ chat_id: "999", text: "BTCUSDT masuk TRADE", parse_mode: "Markdown" });
  });

  it("logs and skips the request when TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendTelegramAlert({}, "BTCUSDT masuk TRADE");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("logs but does not throw when Telegram responds with a non-OK status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: false, description: "bad chat id" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendTelegramAlert({ TELEGRAM_BOT_TOKEN: "abc123", TELEGRAM_CHAT_ID: "999" }, "BTCUSDT masuk TRADE"),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("logs but does not throw when fetch itself rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendTelegramAlert({ TELEGRAM_BOT_TOKEN: "abc123", TELEGRAM_CHAT_ID: "999" }, "BTCUSDT masuk TRADE"),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("escapeMarkdown", () => {
  it("escapes underscores so odd-count enum combinations can't break legacy Markdown parsing", () => {
    // Real values seen live (2026-08-27) that broke sendMessage before this fix:
    // MarketStructureCondition/RetailSentiment enum values interpolated raw.
    expect(escapeMarkdown("BULLISH_ACCUMULATION")).toBe("BULLISH\\_ACCUMULATION");
    expect(escapeMarkdown("LONG_LIQUIDATION_RISK")).toBe("LONG\\_LIQUIDATION\\_RISK");
    expect(escapeMarkdown("SHORT_SQUEEZE_RISK")).toBe("SHORT\\_SQUEEZE\\_RISK");
    expect(escapeMarkdown("CROWDED_LONG")).toBe("CROWDED\\_LONG");
    expect(escapeMarkdown("CROWDED_SHORT")).toBe("CROWDED\\_SHORT");
  });

  it("escapes *, `, and [ in addition to _", () => {
    expect(escapeMarkdown("a*b`c[d_e")).toBe("a\\*b\\`c\\[d\\_e");
  });

  it("leaves plain text (no Markdown-special characters) unchanged", () => {
    expect(escapeMarkdown("NEUTRAL")).toBe("NEUTRAL");
    expect(escapeMarkdown("BTCUSDT")).toBe("BTCUSDT");
    expect(escapeMarkdown("ISOLATED")).toBe("ISOLATED");
  });
});

function tradResult(o: Partial<TraditionalFuturesResult> = {}): TraditionalFuturesResult {
  return {
    decision: "TRAD_TRADE",
    scenario: "MEAN_REVERSION",
    side: "LONG",
    entry: 100,
    stopLoss: 95,
    takeProfit: 115,
    takeProfit2: 125,
    rr: 3,
    slPct: 5,
    recommendedLeverage: 10,
    confidence: 0.72,
    bracket: {} as never,
    sweep: {} as never,
    reasons: ["MEAN_REVERSION LONG: RR 3.00, SL 5.00%, rec. leverage 10x (Isolated)."],
    dataGaps: [],
    ...o,
  };
}

describe("formatTraditionalFuturesAlert", () => {
  it("renders the ⚡ TRADITIONAL FUTURES header with the escaped symbol and scenario", () => {
    const msg = formatTraditionalFuturesAlert("BTC_USDT", tradResult());
    expect(msg).toContain("⚡");
    expect(msg).toContain("TRADITIONAL FUTURES");
    expect(msg).toContain("*BTC\\_USDT*");
    expect(msg).toContain("MEAN\\_REVERSION");
  });

  it("shows direction, Isolated, and confidence as a whole percentage", () => {
    const msg = formatTraditionalFuturesAlert("BTCUSDT", tradResult({ side: "SHORT", confidence: 0.72 }));
    expect(msg).toMatch(/SHORT/);
    expect(msg).toMatch(/Isolated/i);
    expect(msg).toContain("72%");
  });

  it("renders the full bracket: entry, SL (price & %), TP1, TP2, and R:R", () => {
    const msg = formatTraditionalFuturesAlert(
      "BTCUSDT",
      tradResult({ entry: 100, stopLoss: 95, takeProfit: 115, takeProfit2: 125, rr: 3, slPct: 5 }),
    );
    expect(msg).toMatch(/Entry/i);
    expect(msg).toMatch(/Stop Loss[^\n]*95/);
    expect(msg).toMatch(/5\.00%/);
    expect(msg).toMatch(/TP1[^\n]*115/);
    expect(msg).toMatch(/TP2[^\n]*125/);
    expect(msg).toMatch(/R:R[^\n]*3\.00/);
  });

  it("shows the recommended isolated leverage", () => {
    const msg = formatTraditionalFuturesAlert("BTCUSDT", tradResult({ recommendedLeverage: 12 }));
    expect(msg).toMatch(/12x/);
  });

  it("lists reasons and surfaces dataGaps when present", () => {
    const msg = formatTraditionalFuturesAlert(
      "BTCUSDT",
      tradResult({
        scenario: "TREND_BREAKOUT",
        reasons: ["TREND_BREAKOUT LONG: RR 2.00"],
        dataGaps: ["Data liquidation (allForceOrders) kosong/gagal -- verdict berbasis OI velocity + CVD absorption saja."],
      }),
    );
    expect(msg).toContain("TREND\\_BREAKOUT LONG");
    expect(msg).toMatch(/liquidation/i);
  });

  it("escapes every Markdown-special character coming from dynamic strings", () => {
    const msg = formatTraditionalFuturesAlert("BTCUSDT", tradResult({ scenario: "TREND_BREAKOUT", reasons: ["a_b*c`d[e"] }));
    expect(msg).toContain("TREND\\_BREAKOUT");
    expect(msg).toContain("a\\_b\\*c\\`d\\[e");
    // no bare underscore survives from the enum/reason interpolation
    expect(msg).not.toMatch(/[^\\]_[A-Z]/);
  });
});
