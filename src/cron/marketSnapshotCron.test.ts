import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as binanceProxy from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";
import * as queryFrequency from "../queryFrequency.js";
import { snapshotBasisForSymbol, snapshotNonWatchlistBasis } from "./marketSnapshotCron.js";

vi.mock("../binanceProxyClient.js", () => ({
  getSpotPrice: vi.fn(),
  getCurrentFundingRateNative: vi.fn(),
  getOpenInterestNative: vi.fn(),
}));

vi.mock("../d1Client.js", () => ({
  insertMarketSnapshot: vi.fn(),
}));

vi.mock("../queryFrequency.js", () => ({
  getTopQueriedNonWatchlistSymbols: vi.fn(),
}));

describe("snapshotBasisForSymbol", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("fetches spot/funding/OI, computes basis, and inserts a market snapshot row", async () => {
    vi.mocked(binanceProxy.getSpotPrice).mockResolvedValue({ symbol: "PEPEUSDT", price: "100" } as never);
    vi.mocked(binanceProxy.getCurrentFundingRateNative).mockResolvedValue({
      symbol: "PEPEUSDT",
      markPrice: "100.5",
      lastFundingRate: "0.0001",
    } as never);
    vi.mocked(binanceProxy.getOpenInterestNative).mockResolvedValue({
      symbol: "PEPEUSDT",
      openInterest: "5000",
      time: 0,
    } as never);

    await snapshotBasisForSymbol("PEPEUSDT", 1234);

    expect(d1Client.insertMarketSnapshot).toHaveBeenCalledWith({
      symbol: "PEPEUSDT",
      timestamp: 1234,
      spotPrice: 100,
      markPrice: 100.5,
      basis: 0.005,
      fundingRate: 0.0001,
      openInterest: 5000,
    });
  });
});

describe("snapshotNonWatchlistBasis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("snapshots every symbol returned by getTopQueriedNonWatchlistSymbols", async () => {
    vi.mocked(queryFrequency.getTopQueriedNonWatchlistSymbols).mockResolvedValue([
      { symbol: "PEPEUSDT", count: 10 },
      { symbol: "WIFUSDT", count: 5 },
    ]);
    vi.mocked(binanceProxy.getSpotPrice).mockResolvedValue({ symbol: "X", price: "1" } as never);
    vi.mocked(binanceProxy.getCurrentFundingRateNative).mockResolvedValue({
      symbol: "X",
      markPrice: "1",
      lastFundingRate: "0",
    } as never);
    vi.mocked(binanceProxy.getOpenInterestNative).mockResolvedValue({ symbol: "X", openInterest: "1", time: 0 } as never);

    await snapshotNonWatchlistBasis();

    expect(d1Client.insertMarketSnapshot).toHaveBeenCalledTimes(2);
  });

  it("isolates a per-symbol failure -- one rejecting fetch doesn't block the other symbol", async () => {
    vi.mocked(queryFrequency.getTopQueriedNonWatchlistSymbols).mockResolvedValue([
      { symbol: "PEPEUSDT", count: 10 },
      { symbol: "WIFUSDT", count: 5 },
    ]);
    vi.mocked(binanceProxy.getSpotPrice).mockImplementation(async (symbol: string) => {
      if (symbol === "PEPEUSDT") throw new Error("proxy down");
      return { symbol, price: "1" } as never;
    });
    vi.mocked(binanceProxy.getCurrentFundingRateNative).mockResolvedValue({
      symbol: "X",
      markPrice: "1",
      lastFundingRate: "0",
    } as never);
    vi.mocked(binanceProxy.getOpenInterestNative).mockResolvedValue({ symbol: "X", openInterest: "1", time: 0 } as never);

    await snapshotNonWatchlistBasis();

    expect(d1Client.insertMarketSnapshot).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there are no frequently-queried non-watchlist symbols", async () => {
    vi.mocked(queryFrequency.getTopQueriedNonWatchlistSymbols).mockResolvedValue([]);
    await snapshotNonWatchlistBasis();
    expect(d1Client.insertMarketSnapshot).not.toHaveBeenCalled();
  });
});
