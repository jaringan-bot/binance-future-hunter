// Client DefiLlama public stablecoins API -- gratis, no auth, no scrape
// (JSON resmi). TIDAK disimpan ke D1 -- endpoint DefiLlama sendiri sudah
// nyediain circulatingPrevDay/Week/Month (delta udah dihitung upstream),
// jadi gak perlu histori lokal buat "dry powder" indicator sesederhana ini.
import { fetchWithRetry } from "./retry.js";
import { cachedFetch } from "./cache.js";

const STABLECOINS_URL = "https://stablecoins.llama.fi/stablecoins?includePrices=true";
// Supply stablecoin gak berubah drastis intraday -- cache panjang, hemat
// fetch (satu call narik SEMUA stablecoin, gak perlu per-symbol).
const CACHE_TTL_SECONDS = 6 * 3600;
const TOP_CHAINS_LIMIT = 5;

interface PeggedAmount {
  peggedUSD: number;
}

interface StablecoinRawEntry {
  id: string;
  name: string;
  symbol: string;
  circulating: PeggedAmount;
  circulatingPrevDay: PeggedAmount;
  circulatingPrevWeek: PeggedAmount;
  chainCirculating: Record<string, { current: PeggedAmount }>;
}

interface StablecoinsResponse {
  peggedAssets: StablecoinRawEntry[];
}

export interface ChainSupply {
  chain: string;
  circulating: number;
}

export interface StablecoinSupply {
  id: string;
  symbol: string;
  name: string;
  circulating: number;
  circulatingPrevDay: number;
  circulatingPrevWeek: number;
  changeDayPct: number;
  changeWeekPct: number;
  topChains: ChainSupply[];
}

function pctChange(current: number, previous: number): number {
  return previous !== 0 ? (current - previous) / previous : 0;
}

export async function getStablecoinSupply(symbol: "USDT" | "USDC"): Promise<StablecoinSupply> {
  const response = await cachedFetch(
    STABLECOINS_URL,
    { headers: { Accept: "application/json" } },
    CACHE_TTL_SECONDS,
    fetchWithRetry,
  );
  if (!response.ok) {
    throw new Error(`DefiLlama HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = (await response.json()) as StablecoinsResponse;
  const entry = data.peggedAssets.find((a) => a.symbol === symbol);
  if (!entry) {
    throw new Error(`Stablecoin ${symbol} tidak ditemukan di response DefiLlama.`);
  }

  const topChains = Object.entries(entry.chainCirculating)
    .map(([chain, v]) => ({ chain, circulating: v.current.peggedUSD }))
    .sort((a, b) => b.circulating - a.circulating)
    .slice(0, TOP_CHAINS_LIMIT);

  return {
    id: entry.id,
    symbol: entry.symbol,
    name: entry.name,
    circulating: entry.circulating.peggedUSD,
    circulatingPrevDay: entry.circulatingPrevDay.peggedUSD,
    circulatingPrevWeek: entry.circulatingPrevWeek.peggedUSD,
    changeDayPct: pctChange(entry.circulating.peggedUSD, entry.circulatingPrevDay.peggedUSD),
    changeWeekPct: pctChange(entry.circulating.peggedUSD, entry.circulatingPrevWeek.peggedUSD),
    topChains,
  };
}
