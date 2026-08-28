import { describe, it, expect, vi, afterEach } from "vitest";
import * as binanceProxy from "./binanceProxyClient.js";
import { fetchMarketContext } from "./marketContext.js";

// Semua fungsi proxy di-stub THROW -- test ini membuktikan jalur
// prefetched-inputs TIDAK menyentuh proxy sama sekali.
vi.mock("./binanceProxyClient.js", () => {
  const boom = () => {
    throw new Error("proxy tidak boleh dipanggil di jalur prefetched");
  };
  return {
    getKlinesNative: vi.fn(boom),
    getOpenInterestNative: vi.fn(boom),
    getOpenInterestHistNative: vi.fn(boom),
    getAggTrades: vi.fn(boom),
    getTopTraderPositionRatio: vi.fn(boom),
  };
});

function synthKlines(n: number): binanceProxy.KlineTuple[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + i;
    return [
      1_700_000_000_000 + i * 3_600_000,
      String(base),
      String(base + 1),
      String(base - 1),
      String(base + 0.5),
      "1000",
      1_700_000_000_000 + i * 3_600_000 + 3_599_999,
      "100000",
      50,
      "500",
      "50000",
      "0",
    ] as binanceProxy.KlineTuple;
  });
}

describe("fetchMarketContext with prefetched inputs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("computes context from prefetched inputs without any proxy fetch", async () => {
    const result = await fetchMarketContext("BTCUSDT", {
      klines1h: synthKlines(40),
      oiCurrent: { openInterest: "1050", symbol: "BTCUSDT", time: 1 } as never,
      oiHist2: [{ sumOpenInterest: "1000" }, { sumOpenInterest: "1050" }] as never,
      aggTrades: [
        { p: "100.5", q: "5", m: false } as never,
        { p: "100.4", q: "3", m: true } as never,
      ],
      topTrader: [{ longAccount: "0.6", shortAccount: "0.4", longShortRatio: "1.5" } as never],
    });

    expect(result.contextAvailable).toBe(true);
    expect(binanceProxy.getKlinesNative).not.toHaveBeenCalled();
    expect(binanceProxy.getTopTraderPositionRatio).not.toHaveBeenCalled();
  });
});
