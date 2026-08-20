import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSymbolTradingRules } from "./binanceFetcher.js";

const getFuturesExchangeInfoMock = vi.fn();

vi.mock("./binanceProxyClient.js", () => ({
  getFuturesExchangeInfo: (symbol: string) => getFuturesExchangeInfoMock(symbol),
}));

// Binance /fapi/v1/exchangeInfo IGNORES the `symbol` query param and always
// returns all ~872 listed symbols. This mock reflects that real shape --
// multiple symbols, with the one under test deliberately NOT at index 0 --
// so a regression back to `data.symbols?.[0]` fails loudly instead of
// accidentally passing the way it did with a single-element mock.
const mockExchangeInfoResponse = {
  symbols: [
    {
      symbol: "BTCUSDT",
      filters: [
        { filterType: "LOT_SIZE", minQty: "0.001", stepSize: "0.001" },
        { filterType: "MIN_NOTIONAL", notional: "100" },
      ],
    },
    {
      symbol: "ETHUSDT",
      filters: [
        { filterType: "LOT_SIZE", minQty: "0.001", stepSize: "0.001" },
        { filterType: "MIN_NOTIONAL", notional: "20" },
      ],
    },
    {
      symbol: "TRBUSDT",
      filters: [
        { filterType: "LOT_SIZE", minQty: "0.1", stepSize: "0.1" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    },
  ],
};

beforeEach(() => {
  getFuturesExchangeInfoMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSymbolTradingRules", () => {
  it("fetches via getFuturesExchangeInfo (the Vercel proxy path), never global fetch directly", async () => {
    const globalFetchMock = vi.fn();
    vi.stubGlobal("fetch", globalFetchMock);
    getFuturesExchangeInfoMock.mockResolvedValue(mockExchangeInfoResponse);

    await fetchSymbolTradingRules("trbusdt");

    expect(getFuturesExchangeInfoMock).toHaveBeenCalledWith("TRBUSDT");
    expect(globalFetchMock).not.toHaveBeenCalled();
  });

  it("matches the requested symbol's own filters, not whatever happens to be at index 0", async () => {
    getFuturesExchangeInfoMock.mockResolvedValue(mockExchangeInfoResponse);

    const result = await fetchSymbolTradingRules("TRBUSDT");

    expect(result).toEqual({ minQty: 0.1, stepSize: 0.1, minNotional: 5 });
  });

  it("does not return BTCUSDT's rules (index 0) when a different symbol is requested", async () => {
    getFuturesExchangeInfoMock.mockResolvedValue(mockExchangeInfoResponse);

    const result = await fetchSymbolTradingRules("TRBUSDT");

    expect(result).not.toEqual({ minQty: 0.001, stepSize: 0.001, minNotional: 100 });
  });

  it("returns undefined when the requested symbol is not present in the response at all", async () => {
    getFuturesExchangeInfoMock.mockResolvedValue(mockExchangeInfoResponse);

    const result = await fetchSymbolTradingRules("NOTREAL");

    expect(result).toBeUndefined();
  });

  it("returns undefined (not throw) when LOT_SIZE or MIN_NOTIONAL filter is missing", async () => {
    getFuturesExchangeInfoMock.mockResolvedValue({
      symbols: [{ symbol: "TRBUSDT", filters: [{ filterType: "LOT_SIZE", minQty: "0.1", stepSize: "0.1" }] }],
    });

    const result = await fetchSymbolTradingRules("TRBUSDT");

    expect(result).toBeUndefined();
  });

  it("returns undefined instead of bubbling the error when getFuturesExchangeInfo (proxy) rejects", async () => {
    getFuturesExchangeInfoMock.mockRejectedValue(new Error("proxy unreachable"));

    const result = await fetchSymbolTradingRules("TRBUSDT");

    expect(result).toBeUndefined();
  });
});
