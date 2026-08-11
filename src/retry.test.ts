import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry } from "./retry.js";

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

  it("retries on 429 then succeeds, backing off 500ms/1000ms/2000ms", async () => {
    const rateLimited = new Response("rate limited", { status: 429 });
    const ok = new Response("ok", { status: 200 });
    const fetchMock = vi.fn().mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("https://example.com");
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
