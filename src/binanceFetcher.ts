import {
  getFuturesExchangeInfo,
  type FuturesLotSizeFilter,
  type FuturesMinNotionalFilter,
} from "./binanceProxyClient.js";

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

const BINANCE_FUTURES_API = "https://fapi.binance.com";
const REQUEST_TIMEOUT_MS = 5_000;

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

// Cloudflare Worker ini diblokir total oleh WAF Binance (lihat komentar di
// atas binanceProxyClient.ts), jadi trading rules diambil lewat
// getFuturesExchangeInfo() -> callProxy() (proxy Vercel), BUKAN fetch()
// langsung ke fapi.binance.com. Caching sudah otomatis ditangani callProxy()
// lewat STATIC_CACHE_PATHS di binanceProxyClient.ts -- tidak perlu
// withCache() tambahan di sini.
export async function fetchSymbolTradingRules(
  symbol: string,
): Promise<SymbolTradingRules | undefined> {
  const normalizedSymbol = symbol.trim().toUpperCase();

  try {
    // /fapi/v1/exchangeInfo MENGABAIKAN parameter query `symbol` -- Binance
    // selalu balikin SEMUA ~872 symbol di data.symbols[], terlepas dari
    // symbol yang diminta. Harus di-filter di sini; ambil index 0 (bug lama)
    // selalu ambil symbol pertama dalam array (BTCUSDT), bukan yang diminta.
    const data = await getFuturesExchangeInfo(normalizedSymbol);
    const symbolInfo = data.symbols?.find((entry) => entry.symbol === normalizedSymbol);
    if (!symbolInfo) return undefined;

    const lotSizeFilter = symbolInfo.filters.find(
      (filter): filter is FuturesLotSizeFilter => filter.filterType === "LOT_SIZE",
    );
    const minNotionalFilter = symbolInfo.filters.find(
      (filter): filter is FuturesMinNotionalFilter => filter.filterType === "MIN_NOTIONAL",
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
