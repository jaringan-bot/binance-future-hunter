import { describe, it, expect, afterEach } from "vitest";
import { getJson, putJson, listKeys, setKvNamespace, KvNotConfiguredError } from "./kvConfig.js";

// Minimal fake KVNamespace -- only get/put/list are used anywhere in this
// codebase, same "implement only what's exercised" convention as FakeD1 in
// wallTrackingCron.test.ts.
class FakeKv {
  store = new Map<string, string>();
  puts: { key: string; value: string; options?: { expirationTtl?: number } }[] = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, value, options });
  }

  async list(options: { prefix: string }) {
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(options.prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true, cacheStatus: null };
  }
}

describe("kvConfig", () => {
  afterEach(() => {
    setKvNamespace(undefined);
  });

  it("getJson returns null for a missing key", async () => {
    setKvNamespace(new FakeKv() as unknown as KVNamespace);
    expect(await getJson("missing")).toBeNull();
  });

  it("putJson then getJson round-trips a value", async () => {
    setKvNamespace(new FakeKv() as unknown as KVNamespace);
    await putJson("k", { a: 1 });
    expect(await getJson<{ a: number }>("k")).toEqual({ a: 1 });
  });

  it("putJson passes expirationTtl through to the KV binding when given", async () => {
    const fake = new FakeKv();
    setKvNamespace(fake as unknown as KVNamespace);
    await putJson("k", 42, { expirationTtl: 3600 });
    expect(fake.puts[0].options).toEqual({ expirationTtl: 3600 });
  });

  it("putJson without options doesn't pass an options object (backward compatible)", async () => {
    const fake = new FakeKv();
    setKvNamespace(fake as unknown as KVNamespace);
    await putJson("k", 42);
    expect(fake.puts[0].options).toBeUndefined();
  });

  it("listKeys returns key names matching the given prefix", async () => {
    const fake = new FakeKv();
    setKvNamespace(fake as unknown as KVNamespace);
    await putJson("basis_query_count:PEPEUSDT", 1);
    await putJson("basis_query_count:WIFUSDT", 1);
    await putJson("pairThreshold:BTCUSDT", 1);
    const keys = await listKeys("basis_query_count:");
    expect(keys.sort()).toEqual(["basis_query_count:PEPEUSDT", "basis_query_count:WIFUSDT"]);
  });

  it("listKeys returns an empty array when nothing matches", async () => {
    setKvNamespace(new FakeKv() as unknown as KVNamespace);
    expect(await listKeys("nope:")).toEqual([]);
  });

  it("throws KvNotConfiguredError when KV isn't bound", async () => {
    setKvNamespace(undefined);
    await expect(getJson("k")).rejects.toBeInstanceOf(KvNotConfiguredError);
  });
});
