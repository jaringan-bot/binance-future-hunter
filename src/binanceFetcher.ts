export interface BinanceMarketData {
  predictedFundingRate: number;
  openInterest: number;
  orderBookBidDepthSL: number;
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
