import { describe, it, expect, vi, afterEach } from "vitest";
import { sendTelegramAlert, escapeMarkdown } from "./telegram.js";

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
