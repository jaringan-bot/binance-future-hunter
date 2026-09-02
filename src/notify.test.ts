import { describe, it, expect, vi, afterEach } from "vitest";
import {
  dispatchNotification,
  telegramChannel,
  discordChannel,
  genericWebhookChannel,
} from "./notify.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const FULL_ENV = {
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
  NOTIFY_WEBHOOK_URL: "https://hook.example/notify",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("channel.configured", () => {
  it("is true only when the channel's env is fully present", () => {
    expect(telegramChannel.configured({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" })).toBe(true);
    expect(telegramChannel.configured({ TELEGRAM_BOT_TOKEN: "t" })).toBe(false);
    expect(discordChannel.configured({ DISCORD_WEBHOOK_URL: "u" })).toBe(true);
    expect(discordChannel.configured({})).toBe(false);
    expect(genericWebhookChannel.configured({ NOTIFY_WEBHOOK_URL: "u" })).toBe(true);
    expect(genericWebhookChannel.configured({})).toBe(false);
  });
});

describe("dispatchNotification", () => {
  it("fans out to every configured channel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await dispatchNotification(FULL_ENV, "hello");

    // telegram + discord + generic webhook = 3 POSTs
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("https://api.telegram.org/bottok/sendMessage");
    expect(urls).toContain("https://discord.example/webhook");
    expect(urls).toContain("https://hook.example/notify");

    const discordBody = JSON.parse(
      fetchMock.mock.calls.find((c) => String(c[0]) === "https://discord.example/webhook")![1].body,
    );
    expect(discordBody).toEqual({ content: "hello" });
    const webhookBody = JSON.parse(
      fetchMock.mock.calls.find((c) => String(c[0]) === "https://hook.example/notify")![1].body,
    );
    expect(webhookBody).toEqual({ text: "hello" });
  });

  it("skips unconfigured channels (Telegram-only env -> one POST)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await dispatchNotification({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "42" }, "hi");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.telegram.org/bottok/sendMessage");
  });

  it("logs and no-ops when no channel is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await dispatchNotification({}, "nowhere");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("one failing channel does not stop the others and never throws", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("discord")) return Promise.reject(new Error("discord down"));
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(dispatchNotification(FULL_ENV, "resilient")).resolves.toBeUndefined();

    // all 3 still attempted
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // discord failure logged, but dispatch resolved
    expect(errorSpy).toHaveBeenCalled();
  });

  it("truncates Discord content to 2000 chars", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await dispatchNotification({ DISCORD_WEBHOOK_URL: "https://discord.example/webhook" }, "x".repeat(5000));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toHaveLength(2000);
  });

  it("a non-OK webhook status is logged, not thrown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "bad" }, 500));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      dispatchNotification({ NOTIFY_WEBHOOK_URL: "https://hook.example/notify" }, "boom"),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
