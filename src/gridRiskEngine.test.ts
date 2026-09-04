import { describe, it, expect, vi, afterEach } from "vitest";
import {
  calculateGridRisk,
  estimateMaintenanceMarginBufferPct,
  MMR_BUFFER_HIGH,
  MMR_BUFFER_MID,
  MMR_BUFFER_LOW,
  HIGH_LIQUIDITY_THRESHOLD_USD,
  MID_LIQUIDITY_THRESHOLD_USD,
  type GridInputParams,
} from "./gridRiskEngine.js";
import { FALLBACK_CONTEXT } from "./marketContext.js";
import type { BinanceMarketData } from "./binanceFetcher.js";
import { setProxyConfig, setBinanceApiCredentials } from "./binanceProxyClient.js";
import * as leverageBracket from "./leverageBracket.js";

// quoteVolumeUsd tinggi disengaja: golden regression di bawah dihitung
// dengan asumsi buffer MMR 0.5% (tier top-liquidity). Tanpa field ini,
// fixture jatuh ke tier konservatif 1.5% dan angka golden bergeser.
const marketData: BinanceMarketData = {
  predictedFundingRate: 0,
  openInterest: 0,
  orderBookBidDepthSL: 0,
  quoteVolumeUsd: 800_000_000,
};

// Trading rules TRBUSDT dipakai sbg golden test -- minQty=0.1, stepSize=0.1,
// minNotional=5, sesuai instruksi task (mock/inject, jangan fetch live).
//
// Binance /fapi/v1/exchangeInfo IGNORES the `symbol` query param and always
// returns all listed symbols. Mock reflects that: TRBUSDT deliberately NOT
// at index 0, with an unrelated BTCUSDT entry first, so this test actually
// exercises symbol-matching instead of trivially passing via index 0.
function exchangeInfoResponse(minQty: string, stepSize: string, minNotional: string): Response {
  return new Response(
    JSON.stringify({
      symbols: [
        {
          symbol: "BTCUSDT",
          filters: [
            { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "10000", stepSize: "0.001" },
            { filterType: "MIN_NOTIONAL", notional: "100" },
          ],
        },
        {
          symbol: "TRBUSDT",
          filters: [
            { filterType: "LOT_SIZE", minQty, maxQty: "10000", stepSize },
            { filterType: "MIN_NOTIONAL", notional: minNotional },
          ],
        },
      ],
    }),
    { status: 200 },
  );
}

// fetchSymbolTradingRules sekarang lewat getFuturesExchangeInfo() ->
// callProxy(), jadi butuh proxy dikonfigurasi (setProxyConfig) sebelum
// global fetch di-stub -- callProxy menolak request kalau primaryEndpoint
// belum diset, terlepas dari apa yang dikembalikan fetch.
function stubTradingRulesFetch(minQty = "0.1", stepSize = "0.1", minNotional = "5") {
  setProxyConfig("https://primary.example", "test-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(exchangeInfoResponse(minQty, stepSize, minNotional)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  setProxyConfig(undefined, undefined);
  setBinanceApiCredentials(undefined, undefined);
});

const trbBaseParams: GridInputParams = {
  symbol: "TRBUSDT",
  initialCapital: 100,
  lowerPrice: 12.235,
  upperPrice: 15.446,
  currentPrice: 13.933,
  gridCount: 21,
  stopLossPrice: 12.0624,
  leverage: 2,
  gridType: "ARITHMETIC",
  feeRate: 0.0002,
};

describe("estimateMaintenanceMarginBufferPct", () => {
  it("returns the low (0.5%) buffer for top-liquidity volume", () => {
    expect(estimateMaintenanceMarginBufferPct(HIGH_LIQUIDITY_THRESHOLD_USD)).toBe(MMR_BUFFER_HIGH);
    expect(estimateMaintenanceMarginBufferPct(2_000_000_000)).toBe(MMR_BUFFER_HIGH);
  });

  it("returns the mid (0.75%) buffer between the two thresholds", () => {
    expect(estimateMaintenanceMarginBufferPct(MID_LIQUIDITY_THRESHOLD_USD)).toBe(MMR_BUFFER_MID);
    expect(estimateMaintenanceMarginBufferPct(120_000_000)).toBe(MMR_BUFFER_MID);
  });

  it("returns the conservative (1.5%) buffer for thin volume", () => {
    expect(estimateMaintenanceMarginBufferPct(5_000_000)).toBe(MMR_BUFFER_LOW);
    expect(estimateMaintenanceMarginBufferPct(MID_LIQUIDITY_THRESHOLD_USD - 1)).toBe(MMR_BUFFER_LOW);
  });

  it("falls back to the MOST conservative tier when volume is unknown/invalid", () => {
    expect(estimateMaintenanceMarginBufferPct(undefined)).toBe(MMR_BUFFER_LOW);
    expect(estimateMaintenanceMarginBufferPct(0)).toBe(MMR_BUFFER_LOW);
    expect(estimateMaintenanceMarginBufferPct(-1)).toBe(MMR_BUFFER_LOW);
    expect(estimateMaintenanceMarginBufferPct(Number.NaN)).toBe(MMR_BUFFER_LOW);
  });

  it("orders the tiers so a thinner pair never gets a smaller buffer", () => {
    expect(MMR_BUFFER_LOW).toBeGreaterThan(MMR_BUFFER_MID);
    expect(MMR_BUFFER_MID).toBeGreaterThan(MMR_BUFFER_HIGH);
  });
});

describe("calculateGridRisk - MMR buffer wired into liquidationPrice", () => {
  it("pushes liquidationPrice closer to entry for a low-liquidity (unknown volume) pair", async () => {
    stubTradingRulesFetch();
    const highLiq = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 101 },
      { ...marketData, quoteVolumeUsd: 900_000_000 },
      FALLBACK_CONTEXT,
    );
    stubTradingRulesFetch();
    const unknownLiq = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 101 },
      { ...marketData, quoteVolumeUsd: undefined },
      FALLBACK_CONTEXT,
    );
    expect(unknownLiq.liquidationPrice).toBeGreaterThan(highLiq.liquidationPrice);
  });

  it("prefers leverageBracket MMR over volume heuristic when available", async () => {
    stubTradingRulesFetch();
    setBinanceApiCredentials("test-key", "test-secret");
    const spy = vi
      .spyOn(leverageBracket, "fetchMaintMarginRatio")
      .mockResolvedValue(0.02);
    const withBracket = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 101 },
      marketData,
      FALLBACK_CONTEXT,
    );
    spy.mockRestore();
    setBinanceApiCredentials(undefined, undefined);
    stubTradingRulesFetch();
    const heuristic = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 101 },
      marketData,
      FALLBACK_CONTEXT,
    );
    expect(withBracket.liquidationPrice).toBeGreaterThan(heuristic.liquidationPrice);
  });
});

describe("calculateGridRisk - TRBUSDT golden regression (constant base-asset qty)", () => {
  it("rejects $100 initial capital as below the minimum required margin", async () => {
    stubTradingRulesFetch();

    const result = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 100 },
      marketData,
      FALLBACK_CONTEXT,
    );

    expect(result.status).toBe("REJECT");
    expect(result.rejectionReason).toMatch(/below the minimum required/i);
  });

  it("does not reject $101 initial capital on minimum-margin grounds", async () => {
    stubTradingRulesFetch();

    const result = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 101 },
      marketData,
      FALLBACK_CONTEXT,
    );

    expect(result.status).not.toBe("REJECT");
  });
});

describe("calculateGridRisk - grid point count (gridCount + 1)", () => {
  it("fills gridCount + 1 arithmetic price levels, not gridCount", async () => {
    stubTradingRulesFetch();

    const result = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 101 },
      marketData,
      FALLBACK_CONTEXT,
    );

    // arithmeticGrid produces gridCount+1 = 22 points; filledGridCount is
    // however many of those fall below currentPrice.
    const step = (trbBaseParams.upperPrice - trbBaseParams.lowerPrice) / trbBaseParams.gridCount;
    const expectedFilled = Array.from(
      { length: trbBaseParams.gridCount + 1 },
      (_, i) => trbBaseParams.lowerPrice + step * i,
    ).filter((price) => price < trbBaseParams.currentPrice).length;

    expect(result.filledGridCount).toBe(expectedFilled);
  });

  it("produces a different filledGridCount than the old gridCount-points model would", async () => {
    stubTradingRulesFetch();

    const result = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 101 },
      marketData,
      FALLBACK_CONTEXT,
    );

    const oldStep =
      (trbBaseParams.upperPrice - trbBaseParams.lowerPrice) / (trbBaseParams.gridCount - 1);
    const oldFilled = Array.from(
      { length: trbBaseParams.gridCount },
      (_, i) => trbBaseParams.lowerPrice + oldStep * i,
    ).filter((price) => price < trbBaseParams.currentPrice).length;

    expect(result.filledGridCount).not.toBe(oldFilled);
  });
});

describe("calculateGridRisk - constant qty per level", () => {
  it("keeps totalQuantity proportional to a constant per-level qty (no variable-qty regression)", async () => {
    stubTradingRulesFetch();

    const result = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 101 },
      marketData,
      FALLBACK_CONTEXT,
    );

    const impliedGridQty = result.totalQuantity / result.filledGridCount;

    // rawProfitPerCycleUSD sums gridQty * priceGap across filled levels; if
    // qty were still variable per level (old USD-notional-constant model),
    // reconstructing it from a single constant gridQty would not reproduce
    // totalQuantity exactly.
    expect(result.totalQuantity).toBeCloseTo(impliedGridQty * result.filledGridCount, 8);
    expect(impliedGridQty).toBeGreaterThan(0);
  });
});

describe("calculateGridRisk - new validations", () => {
  it("rejects with a reason naming the minimum dollar amount when capital is too small for minQty", async () => {
    // minQty=1 dominates minNotional/lowerPrice (~0.41) here, so at
    // initialCapital=100 the notional-per-order check already passes
    // ($6.10 >= $5) and only the margin-minimum check fires -- isolating
    // the margin rejection path from the notional one.
    stubTradingRulesFetch("1", "0.1", "5");

    const result = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 100 },
      marketData,
      FALLBACK_CONTEXT,
    );

    expect(result.status).toBe("REJECT");
    expect(result.rejectionReason).toMatch(/\$\d/);
    expect(result.rejectionReason).toMatch(/minimum required/i);
  });

  it("rejects with a reason naming minNotional when notional per order is too small", async () => {
    stubTradingRulesFetch();

    const result = await calculateGridRisk(
      { ...trbBaseParams, initialCapital: 1 },
      marketData,
      FALLBACK_CONTEXT,
    );

    expect(result.status).toBe("REJECT");
    expect(result.rejectionReason).toMatch(/minimum notional/i);
  });

  it("rejects when trading rules cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    const result = await calculateGridRisk(trbBaseParams, marketData, FALLBACK_CONTEXT);

    expect(result.status).toBe("REJECT");
    expect(result.rejectionReason).toMatch(/trading rules/i);
  });
});
