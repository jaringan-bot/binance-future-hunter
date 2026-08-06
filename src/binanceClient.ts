// Semua endpoint di sini adalah endpoint PUBLIK Binance USDS-M Futures
// (fapi.binance.com). Tidak butuh API key karena hanya membaca data pasar,
// bukan data akun pribadi atau melakukan order.
//
// Dokumentasi resmi: https://developers.binance.com/docs/derivatives/usds-margined-futures

const BASE_URL = "https://fapi.binance.com";

// Opsional: kalau diset, dikirim sebagai header X-MBX-APIKEY. Endpoint di
// file ini semua publik (tidak butuh signing), tapi beberapa deployment
// Binance memperlakukan request ber-API-key lebih longgar di WAF-nya.
let apiKey: string | undefined;

export function setApiKey(key: string | undefined) {
  apiKey = key;
}

export class BinanceApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = "BinanceApiError";
  }
}

async function callBinance<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { "X-MBX-APIKEY": apiKey } : {}),
      },
    });
  } catch (err) {
    throw new BinanceApiError(
      `Gagal menghubungi Binance API: ${(err as Error).message}. Coba lagi sebentar lagi.`,
      undefined,
      path,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Binance error umum: -1121 = symbol tidak valid, 429/418 = rate limit.
    if (response.status === 429 || response.status === 418) {
      throw new BinanceApiError(
        `Rate limit Binance API tercapai (HTTP ${response.status}). Tunggu beberapa detik sebelum mencoba lagi.`,
        response.status,
        path,
      );
    }
    throw new BinanceApiError(
      `Binance API mengembalikan error HTTP ${response.status}: ${body || response.statusText}. Cek apakah symbol/parameter sudah benar.`,
      response.status,
      path,
    );
  }

  return response.json() as Promise<T>;
}

export interface PremiumIndexResponse {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  interestRate: string;
  time: number;
}

export interface FundingRateHistoryItem {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
  markPrice: string;
}

export interface OpenInterestResponse {
  symbol: string;
  openInterest: string;
  time: number;
}

export interface OpenInterestHistItem {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

export interface LongShortRatioItem {
  symbol: string;
  longShortRatio: string;
  longAccount: string;
  shortAccount: string;
  timestamp: number;
}

export interface TakerBuySellVolumeItem {
  buySellRatio: string;
  buyVol: string;
  sellVol: string;
  timestamp: string;
}

export interface KlineRaw
  extends Array<string | number> {
  0: number; // open time
  1: string; // open
  2: string; // high
  3: string; // low
  4: string; // close
  5: string; // volume
  6: number; // close time
  7: string; // quote asset volume
  8: number; // number of trades
  9: string; // taker buy base volume
  10: string; // taker buy quote volume
}

export interface Ticker24hr {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  lastPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
}

/** Harga mark price + funding rate saat ini (mendekati real-time). */
export function getPremiumIndex(symbol: string) {
  return callBinance<PremiumIndexResponse>("/fapi/v1/premiumIndex", { symbol });
}

/** Histori funding rate settlement (biasanya tiap 8 jam). */
export function getFundingRateHistory(symbol: string, limit = 30) {
  return callBinance<FundingRateHistoryItem[]>("/fapi/v1/fundingRate", {
    symbol,
    limit,
  });
}

/** Open Interest saat ini (snapshot terbaru). */
export function getOpenInterest(symbol: string) {
  return callBinance<OpenInterestResponse>("/fapi/v1/openInterest", { symbol });
}

/** Histori Open Interest untuk melihat tren naik/turun. period: 5m,15m,30m,1h,2h,4h,6h,12h,1d */
export function getOpenInterestHistory(
  symbol: string,
  period: string,
  limit = 30,
) {
  return callBinance<OpenInterestHistItem[]>("/futures/data/openInterestHist", {
    symbol,
    period,
    limit,
  });
}

/** Long/Short ratio akun GLOBAL (proxy retail keseluruhan). */
export function getGlobalLongShortRatio(
  symbol: string,
  period: string,
  limit = 30,
) {
  return callBinance<LongShortRatioItem[]>(
    "/futures/data/globalLongShortAccountRatio",
    { symbol, period, limit },
  );
}

/** Long/Short ratio akun TOP TRADER (proxy "smart money"/whale). */
export function getTopTraderAccountRatio(
  symbol: string,
  period: string,
  limit = 30,
) {
  return callBinance<LongShortRatioItem[]>(
    "/futures/data/topLongShortAccountRatio",
    { symbol, period, limit },
  );
}

/** Long/Short ratio POSISI (bukan akun) top trader — lebih akurat lihat size, bukan cuma jumlah akun. */
export function getTopTraderPositionRatio(
  symbol: string,
  period: string,
  limit = 30,
) {
  return callBinance<LongShortRatioItem[]>(
    "/futures/data/topLongShortPositionRatio",
    { symbol, period, limit },
  );
}

/** Rasio volume taker buy vs sell — proxy tekanan beli/jual agresif. */
export function getTakerBuySellVolume(
  symbol: string,
  period: string,
  limit = 30,
) {
  return callBinance<TakerBuySellVolumeItem[]>(
    "/futures/data/takerlongshortRatio",
    { symbol, period, limit },
  );
}

/** Candlestick data untuk analisis bias per-timeframe. */
export function getKlines(symbol: string, interval: string, limit = 100) {
  return callBinance<KlineRaw[]>("/fapi/v1/klines", { symbol, interval, limit });
}

/** Statistik 24 jam (harga, volume, perubahan %). */
export function getTicker24hr(symbol: string) {
  return callBinance<Ticker24hr>("/fapi/v1/ticker/24hr", { symbol });
}
