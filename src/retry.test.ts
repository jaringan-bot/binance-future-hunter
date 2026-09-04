import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry, parseRetryAfterMs } from "./retry.js";

describe("parseRetryAfterMs", () => {
  const now = Date.parse("2026-09-04T12:00:00Z");

  it("parses delta-seconds (the form Binance sends)", () => {
    const res = new Response("", { headers: { "retry-after": "30" } });
    expect(parseRetryAfterMs(res, now)).toBe(30_000);
  });

  it("parses an HTTP-date into a forward-looking delta", () => {
    const res = new Response("", { headers: { "retry-after": "Fri, 04 Sep 2026 12:00:45 GMT" } });
    expect(parseRetryAfterMs(res, now)).toBe(45_000);
  });

  it("returns undefined for a missing, blank, malformed, or already-past value", () => {
    expect(parseRetryAfterMs(new Response(""), now)).toBeUndefined();
    expect(parseRetryAfterMs(new Response("", { headers: { "retry-after": "   " } }), now)).toBeUndefined();
    expect(parseRetryAfterMs(new Response("", { headers: { "retry-after": "soon" } }), now)).toBeUndefined();
    expect(
      parseRetryAfterMs(new Response("", { headers: { "retry-after": "Fri, 04 Sep 2026 11:59:00 GMT" } }), now),
    ).toBeUndefined();
  });
});

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns immediately on a successful response, no retry", async () => {
    const ok = new Response("ok", { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(ok);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWithRetry("https://example.com");
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a client error like 400 (permanent, not transient)", async () => {
    const bad = new Response("bad request", { status: 400 });
    const fetchMock = vi.fn().mockResolvedValue(bad);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWithRetry("https://example.com");
    expect(result.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // REGRESSION GUARD (2026-09-04, Stage 1). Test ini DULU meng-assert
  // kebalikannya ("retries on 429 then succeeds") -- itulah yang mengunci
  // retry-storm: 429 retryable DI SINI x 429 failover-worthy di
  // binanceProxyClient.ts = sampai 12 request Binance per satu call, tepat
  // saat Binance menyuruh berhenti. Jangan kembalikan 429 ke
  // RETRYABLE_STATUS tanpa mengubah FAILOVER_STATUS juga.
  it("does NOT retry a 429 -- retrying a rate-limit is what escalates to an 418 IP ban", async () => {
    const rateLimited = new Response("rate limited", { status: 429 });
    const fetchMock = vi.fn().mockResolvedValue(rateLimited);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWithRetry("https://example.com");

    expect(result.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry an 418 IP weight-ban", async () => {
    const banned = new Response('{"code":-1003,"msg":"banned until 1751234567890"}', { status: 418 });
    const fetchMock = vi.fn().mockResolvedValue(banned);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWithRetry("https://example.com");

    expect(result.status).toBe(418);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors a short Retry-After on a retryable status instead of the fixed backoff", async () => {
    const unavailable = new Response("unavailable", { status: 503, headers: { "retry-after": "1" } });
    const ok = new Response("ok", { status: 200 });
    const fetchMock = vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("https://example.com");
    // Backoff biasa attempt-0 adalah 500ms; Retry-After minta 1000ms, jadi
    // pada 500ms belum boleh ada percobaan kedua.
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up immediately when Retry-After exceeds what is worth holding an invocation for", async () => {
    // 120 detik jauh di atas MAX_RETRY_AFTER_WAIT_MS -- menahan slot selama
    // itu memakan wall-clock cron. Kembalikan response supaya caller yang
    // mencatat cooldown per-relay.
    const unavailable = new Response("unavailable", { status: 503, headers: { "retry-after": "120" } });
    const fetchMock = vi.fn().mockResolvedValue(unavailable);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWithRetry("https://example.com");

    expect(result.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up and returns the last response after exhausting all retries on persistent 503", async () => {
    const unavailable = new Response("unavailable", { status: 503 });
    const fetchMock = vi.fn().mockResolvedValue(unavailable);
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("https://example.com");
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);
    const result = await promise;

    expect(result.status).toBe(503);
    // Initial attempt + 3 retries = 4 total calls.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries on a network error (fetch rejects) then succeeds", async () => {
    const ok = new Response("ok", { status: 200 });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("https://example.com");
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rethrows the network error after exhausting all retries", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("https://example.com");
    const expectation = expect(promise).rejects.toThrow("network down");
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
