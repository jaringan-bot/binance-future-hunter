import { describe, it, expect, vi, afterEach } from "vitest";
import { withCache, cachedFetch } from "./cache.js";

describe("withCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls produce() directly when the Cache API is unavailable (e.g. outside Workers runtime)", async () => {
    vi.stubGlobal("caches", undefined);
    const produce = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await withCache("https://cache.internal/x", 5, produce);

    expect(await result.text()).toBe("ok");
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("calls produce() directly when ttlSeconds <= 0, even if the Cache API is available", async () => {
    const match = vi.fn();
    const put = vi.fn();
    vi.stubGlobal("caches", { default: { match, put } });
    const produce = vi.fn().mockResolvedValue(new Response("fresh", { status: 200 }));

    const result = await withCache("https://cache.internal/x", 0, produce);

    expect(await result.text()).toBe("fresh");
    expect(produce).toHaveBeenCalledTimes(1);
    expect(match).not.toHaveBeenCalled();
  });

  it("returns the cached response on a hit without calling produce()", async () => {
    const cachedResponse = new Response("cached", { status: 200 });
    const match = vi.fn().mockResolvedValue(cachedResponse);
    const put = vi.fn();
    vi.stubGlobal("caches", { default: { match, put } });
    const produce = vi.fn();

    const result = await withCache("https://cache.internal/x", 5, produce);

    expect(await result.text()).toBe("cached");
    expect(produce).not.toHaveBeenCalled();
  });

  it("stores a successful response under the given cache key on a miss", async () => {
    const match = vi.fn().mockResolvedValue(undefined);
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", { default: { match, put } });
    const produce = vi.fn().mockResolvedValue(new Response("new", { status: 200 }));

    const result = await withCache("https://cache.internal/x", 5, produce);

    expect(await result.text()).toBe("new");
    expect(put).toHaveBeenCalledTimes(1);
    const [cacheKeyArg] = put.mock.calls[0];
    expect(cacheKeyArg.url).toBe("https://cache.internal/x");
  });

  it("does NOT cache an error response", async () => {
    const match = vi.fn().mockResolvedValue(undefined);
    const put = vi.fn();
    vi.stubGlobal("caches", { default: { match, put } });
    const produce = vi.fn().mockResolvedValue(new Response("bad", { status: 500 }));

    await withCache("https://cache.internal/x", 5, produce);

    expect(put).not.toHaveBeenCalled();
  });
});

describe("cachedFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates to doFetch with the given url/init when caching is unavailable", async () => {
    vi.stubGlobal("caches", undefined);
    const doFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await cachedFetch("https://api.example.com/x", { headers: { a: "1" } }, 5, doFetch);

    expect(await result.text()).toBe("ok");
    expect(doFetch).toHaveBeenCalledWith("https://api.example.com/x", { headers: { a: "1" } });
  });
});
