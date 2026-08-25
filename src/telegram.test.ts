import { describe, it, expect, vi, afterEach } from "vitest";
import { sendTelegramAlert } from "./telegram.js";

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
