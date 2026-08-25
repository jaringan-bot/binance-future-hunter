import { describe, it, expect, vi, afterEach } from "vitest";
import * as binanceProxy from "./binanceProxyClient.js";
import { getTop200UsdtPerpetualWatchlist } from "./entryWatchlist.js";

vi.mock("./binanceProxyClient.js", () => ({
  getFuturesExchangeInfo: vi.fn(),
  getAllTicker24hrNative: vi.fn(),
}));

describe("getTop200UsdtPerpetualWatchlist", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps only TRADING USDT-margined PERPETUAL symbols, ranked by 24h quote volume descending", async () => {
    vi.mocked(binanceProxy.getFuturesExchangeInfo).mockResolvedValue({
      symbols: [
        { symbol: "BTCUSDT", filters: [], status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT" },
        { symbol: "ETHUSDT", filters: [], status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT" },
        // delisted -- must be excluded even though it has a high quote volume below
        { symbol: "OLDUSDT", filters: [], status: "SETTLING", contractType: "PERPETUAL", quoteAsset: "USDT" },
        // quarterly delivery contract, not perpetual -- must be excluded
        { symbol: "BTCUSDT_260327", filters: [], status: "TRADING", contractType: "CURRENT_QUARTER", quoteAsset: "USDT" },
        // USDC-margined -- must be excluded
        { symbol: "BTCUSDC", filters: [], status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDC" },
      ],
    } as never);
    vi.mocked(binanceProxy.getAllTicker24hrNative).mockResolvedValue([
      { symbol: "BTCUSDT", quoteVolume: "500" } as never,
      { symbol: "ETHUSDT", quoteVolume: "1000" } as never,
      { symbol: "OLDUSDT", quoteVolume: "999999" } as never,
      { symbol: "BTCUSDT_260327", quoteVolume: "999999" } as never,
      { symbol: "BTCUSDC", quoteVolume: "999999" } as never,
    ]);

    const result = await getTop200UsdtPerpetualWatchlist();

    expect(result).toEqual(["ETHUSDT", "BTCUSDT"]);
  });

  it("caps the result at 200 symbols even when more are eligible", async () => {
    const symbols = Array.from({ length: 250 }, (_, i) => ({
      symbol: `SYM${i}USDT`,
      filters: [],
      status: "TRADING",
      contractType: "PERPETUAL",
      quoteAsset: "USDT",
    }));
    vi.mocked(binanceProxy.getFuturesExchangeInfo).mockResolvedValue({ symbols } as never);
    vi.mocked(binanceProxy.getAllTicker24hrNative).mockResolvedValue(
      symbols.map((s, i) => ({ symbol: s.symbol, quoteVolume: String(250 - i) }) as never),
    );

    const result = await getTop200UsdtPerpetualWatchlist();

    expect(result).toHaveLength(200);
    expect(result[0]).toBe("SYM0USDT");
  });
});
