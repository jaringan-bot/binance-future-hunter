import { describe, it, expect, vi, afterEach } from "vitest";
import * as binanceProxy from "./binanceProxyClient.js";
import {
  getTopUsdtPerpetualWatchlist,
  selectUsdtPerpetualWatchlist,
  ENTRY_WATCHLIST_SIZE,
} from "./entryWatchlist.js";

vi.mock("./binanceProxyClient.js", () => ({
  getFuturesExchangeInfo: vi.fn(),
  getAllTicker24hrNative: vi.fn(),
}));

describe("selectUsdtPerpetualWatchlist (pure, no fetch)", () => {
  it("filters to TRADING USDT PERPETUAL and ranks by quote volume desc, capped at size", () => {
    const symbols = [
      { symbol: "BTCUSDT", filters: [], status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT" },
      { symbol: "ETHUSDT", filters: [], status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT" },
      { symbol: "OLDUSDT", filters: [], status: "SETTLING", contractType: "PERPETUAL", quoteAsset: "USDT" },
      { symbol: "BTCUSDC", filters: [], status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDC" },
    ];
    const tickers = [
      { symbol: "BTCUSDT", quoteVolume: "500" },
      { symbol: "ETHUSDT", quoteVolume: "1000" },
      { symbol: "OLDUSDT", quoteVolume: "999999" },
      { symbol: "BTCUSDC", quoteVolume: "999999" },
    ];
    expect(selectUsdtPerpetualWatchlist(symbols as never, tickers as never, 10)).toEqual(["ETHUSDT", "BTCUSDT"]);
  });
});

describe("getTopUsdtPerpetualWatchlist", () => {
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

    const result = await getTopUsdtPerpetualWatchlist();

    expect(result).toEqual(["ETHUSDT", "BTCUSDT"]);
  });

  it("caps the result at ENTRY_WATCHLIST_SIZE symbols even when more are eligible", async () => {
    const total = ENTRY_WATCHLIST_SIZE + 50;
    const symbols = Array.from({ length: total }, (_, i) => ({
      symbol: `SYM${i}USDT`,
      filters: [],
      status: "TRADING",
      contractType: "PERPETUAL",
      quoteAsset: "USDT",
    }));
    vi.mocked(binanceProxy.getFuturesExchangeInfo).mockResolvedValue({ symbols } as never);
    vi.mocked(binanceProxy.getAllTicker24hrNative).mockResolvedValue(
      symbols.map((s, i) => ({ symbol: s.symbol, quoteVolume: String(total - i) }) as never),
    );

    const result = await getTopUsdtPerpetualWatchlist();

    expect(result).toHaveLength(ENTRY_WATCHLIST_SIZE);
    expect(result[0]).toBe("SYM0USDT");
  });
});
