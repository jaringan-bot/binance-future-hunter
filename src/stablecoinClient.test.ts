import { describe, it, expect, vi, afterEach } from "vitest";
import { getStablecoinSupply } from "./stablecoinClient.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function makeStablecoinsResponse() {
  return {
    peggedAssets: [
      {
        id: "1",
        name: "Tether",
        symbol: "USDT",
        circulating: { peggedUSD: 1000 },
        circulatingPrevDay: { peggedUSD: 950 },
        circulatingPrevWeek: { peggedUSD: 900 },
        chainCirculating: {
          Ethereum: { current: { peggedUSD: 600 } },
          Tron: { current: { peggedUSD: 300 } },
          Solana: { current: { peggedUSD: 100 } },
        },
      },
      {
        id: "2",
        name: "USD Coin",
        symbol: "USDC",
        circulating: { peggedUSD: 500 },
        circulatingPrevDay: { peggedUSD: 500 },
        circulatingPrevWeek: { peggedUSD: 500 },
        chainCirculating: { Ethereum: { current: { peggedUSD: 500 } } },
      },
    ],
  };
}

describe("getStablecoinSupply", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("computes day/week % change and sorts chains by circulating desc", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeStablecoinsResponse())));

    const supply = await getStablecoinSupply("USDT");

    expect(supply).toMatchObject({ id: "1", symbol: "USDT", circulating: 1000 });
    expect(supply.changeDayPct).toBeCloseTo((1000 - 950) / 950);
    expect(supply.changeWeekPct).toBeCloseTo((1000 - 900) / 900);
    expect(supply.topChains.map((c) => c.chain)).toEqual(["Ethereum", "Tron", "Solana"]);
  });

  it("returns zero % change when supply is flat", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeStablecoinsResponse())));
    const supply = await getStablecoinSupply("USDC");
    expect(supply.changeDayPct).toBe(0);
    expect(supply.changeWeekPct).toBe(0);
  });

  it("throws when the symbol is not present in the response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ peggedAssets: [] })));
    await expect(getStablecoinSupply("USDT")).rejects.toThrow("tidak ditemukan di response DefiLlama");
  });

  it("throws on non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("error", false, 503)));
    await expect(getStablecoinSupply("USDT")).rejects.toThrow("DefiLlama HTTP 503");
  });
});
