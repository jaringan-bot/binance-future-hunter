// Client Bybit public API -- TIDAK butuh proxy relay (beda dari Binance),
// sudah dites langsung dari edge Cloudflare (wrangler dev --remote): 200 OK,
// gak ada WAF/geo-block. Funding rate + last price ada di SATU call yang
// sama (v5 tickers), gak perlu 2 request kayak OKX.
import { fetchWithRetry } from "./retry.js";
import { cachedFetch } from "./cache.js";

const BYBIT_TICKERS_URL = "https://api.bybit.com/v5/market/tickers";
const CACHE_TTL_SECONDS = 5; // sama kayak funding rate Binance -- snapshot cepat berubah

export interface CrossExchangeFundingRate {
  fundingRate: number;
  lastPrice: number;
}

interface BybitTickerResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: { symbol: string; lastPrice: string; fundingRate?: string }[];
  };
}

export async function getBybitFundingRate(symbol: string): Promise<CrossExchangeFundingRate> {
  const url = `${BYBIT_TICKERS_URL}?category=linear&symbol=${encodeURIComponent(symbol)}`;
  const response = await cachedFetch(url, { headers: { Accept: "application/json" } }, CACHE_TTL_SECONDS, fetchWithRetry);

  if (!response.ok) {
    throw new Error(`Bybit HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = (await response.json()) as BybitTickerResponse;
  if (data.retCode !== 0) {
    throw new Error(`Bybit API error (retCode ${data.retCode}): ${data.retMsg}`);
  }

  const ticker = data.result.list[0];
  if (!ticker) {
    throw new Error(`Symbol ${symbol} tidak ditemukan di Bybit linear perpetual.`);
  }
  if (ticker.fundingRate === undefined) {
    throw new Error(`Bybit tidak balikin fundingRate untuk ${symbol} (response berubah?).`);
  }

  return { fundingRate: parseFloat(ticker.fundingRate), lastPrice: parseFloat(ticker.lastPrice) };
}
