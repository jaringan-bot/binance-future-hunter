// Client OKX public API -- TIDAK butuh proxy relay, sudah dites langsung
// dari edge Cloudflare: 200 OK, gak ada WAF/geo-block. OKX pisah funding
// rate, ticker (last price + 24h change), dan open interest di 3 endpoint
// beda -- Bybit/Hyperliquid dapat semuanya dalam 1 call.
import { fetchWithRetry } from "./retry.js";
import { cachedFetch } from "./cache.js";
import type { CrossExchangeMarketData, OrderBookLevels } from "./bybitClient.js";

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
  open24h: string;
}

interface OkxOpenInterestData {
  instId: string;
  oi: string; // dalam CONTRACT, beda skala dari base-asset -- lihat oiCcy
  oiCcy: string; // dalam base-asset (BTC dst) -- sepadan sama satuan Binance/Bybit/Hyperliquid
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

export async function getOkxMarketData(instId: string): Promise<CrossExchangeMarketData> {
  const [fundingList, tickerList, oiList] = await Promise.all([
    okxGet<OkxFundingRateData>(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`),
    okxGet<OkxTickerData>(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`),
    okxGet<OkxOpenInterestData>(`https://www.okx.com/api/v5/public/open-interest?instId=${encodeURIComponent(instId)}`),
  ]);

  const funding = fundingList[0];
  const ticker = tickerList[0];
  const oi = oiList[0];
  if (!funding || !ticker || !oi) {
    throw new Error(`Instrument ${instId} tidak ditemukan di OKX (funding/ticker/OI tidak lengkap).`);
  }

  const last = parseFloat(ticker.last);
  const open24h = parseFloat(ticker.open24h);
  const change24hPct = open24h !== 0 ? (last - open24h) / open24h : 0;

  return {
    fundingRate: parseFloat(funding.fundingRate),
    lastPrice: last,
    openInterest: parseFloat(oi.oiCcy), // base-asset, bukan oi (contract) -- sepadan sama exchange lain
    change24hPct,
  };
}

// OKX books: level = [price, size, liquidatedOrders, numOrders] -- cuma
// price+size yang dipakai (2 elemen pertama), sama shape [string,string]
// dengan bids/asks Binance/Bybit.
interface OkxOrderBookData {
  bids: [string, string, string, string][];
  asks: [string, string, string, string][];
}

export async function getOkxOrderBookDepth(instId: string, size: number): Promise<OrderBookLevels> {
  const [book] = await okxGet<OkxOrderBookData>(
    `https://www.okx.com/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=${size}`,
  );
  if (!book) {
    throw new Error(`Instrument ${instId} tidak ditemukan di OKX order book.`);
  }
  return {
    bids: book.bids.map(([p, q]) => [p, q]),
    asks: book.asks.map(([p, q]) => [p, q]),
  };
}
