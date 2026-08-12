// Client OKX public API -- TIDAK butuh proxy relay, sudah dites langsung
// dari edge Cloudflare: 200 OK, gak ada WAF/geo-block. OKX pisah funding
// rate dan ticker (last price) di 2 endpoint beda -- Bybit/Hyperliquid
// dapat keduanya dalam 1 call.
import { fetchWithRetry } from "./retry.js";
import { cachedFetch } from "./cache.js";
import type { CrossExchangeFundingRate } from "./bybitClient.js";

const CACHE_TTL_SECONDS = 5;

interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

interface OkxFundingRateData {
  instId: string;
  fundingRate: string;
}

interface OkxTickerData {
  instId: string;
  last: string;
}

async function okxGet<T>(url: string): Promise<T[]> {
  const response = await cachedFetch(url, { headers: { Accept: "application/json" } }, CACHE_TTL_SECONDS, fetchWithRetry);
  if (!response.ok) {
    throw new Error(`OKX HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as OkxResponse<T>;
  if (data.code !== "0") {
    throw new Error(`OKX API error (code ${data.code}): ${data.msg}`);
  }
  return data.data;
}

export async function getOkxFundingRate(instId: string): Promise<CrossExchangeFundingRate> {
  const [fundingList, tickerList] = await Promise.all([
    okxGet<OkxFundingRateData>(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`),
    okxGet<OkxTickerData>(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`),
  ]);

  const funding = fundingList[0];
  const ticker = tickerList[0];
  if (!funding || !ticker) {
    throw new Error(`Instrument ${instId} tidak ditemukan di OKX.`);
  }

  return { fundingRate: parseFloat(funding.fundingRate), lastPrice: parseFloat(ticker.last) };
}
