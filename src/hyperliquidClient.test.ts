import { describe, it, expect, vi, afterEach } from "vitest";
import { getUserClearinghouseState } from "./hyperliquidClient.js";

// Belum ada precedent client-level fetch-mock test di repo ini (cek dulu --
// nativeExtras.test.ts/wallTrackingCron.test.ts mock MODULE client, bukan
// fetch mentah) -- vi.stubGlobal("fetch", ...) dipakai di sini, aman karena
// cachedFetch (cache.ts) bypass logic cache-nya sendiri kalau `caches`
// global gak ada (kondisi normal di environment test Node/vitest).
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("getUserClearinghouseState", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps signed szi to side + absolute size, filters zero-size positions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        assetPositions: [
          {
            position: { coin: "BTC", szi: "1.5", entryPx: "64000", leverage: { value: 10, type: "isolated" } },
            type: "oneWay",
          },
          {
            position: { coin: "ETH", szi: "-3.2", entryPx: "3000", leverage: { value: 5, type: "cross" } },
            type: "oneWay",
          },
          {
            position: { coin: "SOL", szi: "0", entryPx: "150", leverage: { value: 3, type: "cross" } },
            type: "oneWay",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const positions = await getUserClearinghouseState("0xabc");

    expect(positions).toHaveLength(2);
    expect(positions).toContainEqual({ coin: "BTC", side: "long", size: 1.5, entryPrice: 64000, leverage: 10 });
    expect(positions).toContainEqual({ coin: "ETH", side: "short", size: 3.2, entryPrice: 3000, leverage: 5 });

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("https://api.hyperliquid.xyz/info");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ type: "clearinghouseState", user: "0xabc" });
  });

  it("returns empty array when wallet has no open positions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ assetPositions: [] })));
    const positions = await getUserClearinghouseState("0xempty");
    expect(positions).toEqual([]);
  });

  it("throws on non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("server error", false, 500)));
    await expect(getUserClearinghouseState("0xbad")).rejects.toThrow("Hyperliquid HTTP 500");
  });
});
