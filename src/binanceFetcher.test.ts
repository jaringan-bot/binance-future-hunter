import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSymbolTradingRules } from "./binanceFetcher.js";

const getFuturesExchangeInfoMock = vi.fn();

vi.mock("./binanceProxyClient.js", () => ({
  getFuturesExchangeInfo: (symbol: string) => getFuturesExchangeInfoMock(symbol),
}));

function exchangeInfoBody(minQty: string, stepSize: string, minNotional: string) {
  return {
    symbols: [
      {
        symbol: "TRBUSDT",
        filters: [
          { filterType: "LOT_SIZE", minQty, maxQty: "10000", stepSize },
          { filterType: "MIN_NOTIONAL", notional: minNotional },
        ],
      },
    ],
  };
}

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
    getFuturesExchangeInfoMock.mockResolvedValue(exchangeInfoBody("0.1", "0.1", "5"));

    await fetchSymbolTradingRules("trbusdt");

    expect(getFuturesExchangeInfoMock).toHaveBeenCalledWith("TRBUSDT");
    expect(globalFetchMock).not.toHaveBeenCalled();
  });

  it("parses LOT_SIZE and MIN_NOTIONAL filters into {minQty, stepSize, minNotional}", async () => {
    getFuturesExchangeInfoMock.mockResolvedValue(exchangeInfoBody("0.1", "0.1", "5"));

    const result = await fetchSymbolTradingRules("TRBUSDT");

    expect(result).toEqual({ minQty: 0.1, stepSize: 0.1, minNotional: 5 });
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
