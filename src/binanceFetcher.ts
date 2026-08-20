import { withCache } from "./cache.js";

export interface BinanceMarketData {
  predictedFundingRate: number;
  openInterest: number;
  orderBookBidDepthSL: number;
}

export interface SymbolTradingRules {
  minQty: number;
  stepSize: number;
  minNotional: number;
}

interface BinancePremiumIndexResponse {
  lastFundingRate: string;
}

interface BinanceOpenInterestResponse {
  openInterest: string;
}

interface BinanceDepthResponse {
  bids: Array<[string, string]>;
}

interface BinanceLotSizeFilter {
  filterType: "LOT_SIZE";
  minQty: string;
  stepSize: string;
}

interface BinanceMinNotionalFilter {
  filterType: "MIN_NOTIONAL";
  notional: string;
}

type BinanceSymbolFilter =
  | BinanceLotSizeFilter
  | BinanceMinNotionalFilter
  | { filterType: string; [key: string]: unknown };

interface BinanceExchangeInfoResponse {
  symbols?: Array<{ filters: BinanceSymbolFilter[] }>;
}

const BINANCE_FUTURES_API = "https://fapi.binance.com";
const REQUEST_TIMEOUT_MS = 5_000;
const TRADING_RULES_TTL_SECONDS = 3_600;

async function fetchJson<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(path, BINANCE_FUTURES_API);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Binance API returned HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function parseFiniteNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function fetchBinanceMarketData(
  symbol: string,
  stopLossPrice: number,
): Promise<BinanceMarketData> {
  const normalizedSymbol = symbol.trim().toUpperCase();

  const [funding, openInterest, depth] = await Promise.allSettled([
    fetchJson<BinancePremiumIndexResponse>("/fapi/v1/premiumIndex", {
      symbol: normalizedSymbol,
    }),
    fetchJson<BinanceOpenInterestResponse>("/fapi/v1/openInterest", {
      symbol: normalizedSymbol,
    }),
    fetchJson<BinanceDepthResponse>("/fapi/v1/depth", {
      symbol: normalizedSymbol,
      limit: "50",
    }),
  ]);

  const predictedFundingRate =
    funding.status === "fulfilled"
      ? parseFiniteNumber(funding.value.lastFundingRate)
      : 0;

  const openInterestValue =
    openInterest.status === "fulfilled"
      ? parseFiniteNumber(openInterest.value.openInterest)
      : 0;

  let orderBookBidDepthSL = 0;

  if (depth.status === "fulfilled" && Number.isFinite(stopLossPrice)) {
    for (const [priceString, quantityString] of depth.value.bids) {
      const price = parseFiniteNumber(priceString);
      const quantity = parseFiniteNumber(quantityString);

      if (price >= stopLossPrice && price > 0 && quantity > 0) {
        orderBookBidDepthSL += price * quantity;
      }
    }
  }

  return {
    predictedFundingRate,
    openInterest: openInterestValue,
    orderBookBidDepthSL,
  };
}

async function fetchExchangeInfoResponse(symbol: string): Promise<Response> {
  const url = new URL("/fapi/v1/exchangeInfo", BINANCE_FUTURES_API);
  url.searchParams.set("symbol", symbol);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Trading rules (min qty, step size, min notional) jarang berubah, jadi
// di-cache 1 jam lewat withCache() -- konsisten dgn pola cache.ts yang
// dipakai fetcher lain di file ini, hindari roundtrip exchangeInfo penuh
// tiap kali grid risk tool dipanggil untuk pair yang sama.
export async function fetchSymbolTradingRules(
  symbol: string,
): Promise<SymbolTradingRules | undefined> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const cacheKeyUrl = `https://cache.internal/fapi/v1/exchangeInfo?symbol=${normalizedSymbol}`;

  try {
    const response = await withCache(cacheKeyUrl, TRADING_RULES_TTL_SECONDS, () =>
      fetchExchangeInfoResponse(normalizedSymbol),
    );

    if (!response.ok) return undefined;

    const data = (await response.json()) as BinanceExchangeInfoResponse;
    const symbolInfo = data.symbols?.[0];
    if (!symbolInfo) return undefined;

    const lotSizeFilter = symbolInfo.filters.find(
      (filter): filter is BinanceLotSizeFilter => filter.filterType === "LOT_SIZE",
    );
    const minNotionalFilter = symbolInfo.filters.find(
      (filter): filter is BinanceMinNotionalFilter => filter.filterType === "MIN_NOTIONAL",
    );

    if (!lotSizeFilter || !minNotionalFilter) return undefined;

    const minQty = parseFiniteNumber(lotSizeFilter.minQty);
    const stepSize = parseFiniteNumber(lotSizeFilter.stepSize);
    const minNotional = parseFiniteNumber(minNotionalFilter.notional);

    if (minQty <= 0 || stepSize <= 0 || minNotional <= 0) return undefined;

    return { minQty, stepSize, minNotional };
  } catch {
    return undefined;
  }
}
