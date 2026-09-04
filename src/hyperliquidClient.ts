// Client Hyperliquid public API (DEX perpetual, on-chain) -- TIDAK butuh
// proxy relay, sudah dites langsung dari edge Cloudflare: 200 OK, gak ada
// block. API-nya JSON-RPC style (POST /info dengan {type: "..."}), beda
// paradigma dari REST query-param CEX biasa. metaAndAssetCtxs balikin 2
// array PARALEL (universe[i] <-> assetCtxs[i], index sama = asset sama).
import { fetchWithRetry } from "./retry.js";
import { cachedFetch } from "./cache.js";
import type { CrossExchangeMarketData } from "./bybitClient.js";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const CACHE_TTL_SECONDS = 5;
// Posisi wallet gak berubah secepat funding/OI -- cache lebih pendek dari
// interval polling cron (15 menit) cuma buat hindari duplicate fetch kalau
// beberapa address di-query dalam satu tick yang sama, bukan buat freshness.
const CLEARINGHOUSE_CACHE_TTL_SECONDS = 30;

interface HyperliquidUniverseAsset {
  name: string;
  isDelisted?: boolean;
}

interface HyperliquidAssetCtx {
  funding: string;
  markPx: string;
  openInterest: string;
  prevDayPx: string;
}

type HyperliquidMetaAndAssetCtxs = [{ universe: HyperliquidUniverseAsset[] }, HyperliquidAssetCtx[]];

export async function getHyperliquidMarketData(baseAsset: string): Promise<CrossExchangeMarketData> {
  const response = await cachedFetch(
    HYPERLIQUID_INFO_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    },
    CACHE_TTL_SECONDS,
    fetchWithRetry,
  );

  if (!response.ok) {
    throw new Error(`Hyperliquid HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const [meta, assetCtxs] = (await response.json()) as HyperliquidMetaAndAssetCtxs;
  const index = meta.universe.findIndex((a) => a.name === baseAsset && !a.isDelisted);
  if (index === -1) {
    throw new Error(`Asset ${baseAsset} tidak ditemukan (atau sudah delisted) di Hyperliquid.`);
  }

  const ctx = assetCtxs[index];
  if (!ctx) {
    throw new Error(`Hyperliquid tidak balikin assetCtx untuk index asset ${baseAsset} (response berubah?).`);
  }

  const markPx = parseFloat(ctx.markPx);
  const prevDayPx = parseFloat(ctx.prevDayPx);
  const change24hPct = prevDayPx !== 0 ? (markPx - prevDayPx) / prevDayPx : 0;

  return {
    fundingRate: parseFloat(ctx.funding),
    lastPrice: markPx,
    openInterest: parseFloat(ctx.openInterest),
    change24hPct,
  };
}

// clearinghouseState -- posisi perp on-chain SATU wallet address. Beda dari
// metaAndAssetCtxs (semua asset, gak butuh address), ini butuh address
// spesifik dan balikin SEMUA posisi terbuka wallet itu (lintas coin), bukan
// difilter per-coin di request. Caller (cron/tool) yang filter per-coin.
interface HyperliquidRawPosition {
  coin: string;
  szi: string; // signed size: positif = long, negatif = short
  entryPx: string;
  leverage: { value: number; type: "isolated" | "cross" };
}

interface HyperliquidClearinghouseResponse {
  assetPositions: { position: HyperliquidRawPosition; type: string }[];
  marginSummary?: {
    accountValue?: string;
    totalNtlPos?: string;
    totalRawUsd?: string;
    totalMarginUsed?: string;
  };
  withdrawable?: string;
}

export interface HyperliquidPosition {
  coin: string;
  side: "long" | "short";
  size: number; // absolut, selalu positif -- arah sudah dipindah ke `side`
  entryPrice: number | null;
  leverage: number | null;
}

export interface HyperliquidClearinghouseSnapshot {
  address: string;
  accountValue: number | null;
  withdrawable: number | null;
  totalMarginUsed: number | null;
  positions: HyperliquidPosition[];
}

function parsePositions(data: HyperliquidClearinghouseResponse): HyperliquidPosition[] {
  return (data.assetPositions ?? [])
    .map(({ position }): HyperliquidPosition | null => {
      const szi = parseFloat(position.szi);
      if (szi === 0 || Number.isNaN(szi)) return null;
      const entryPx = parseFloat(position.entryPx);
      return {
        coin: position.coin,
        side: szi > 0 ? "long" : "short",
        size: Math.abs(szi),
        entryPrice: Number.isNaN(entryPx) ? null : entryPx,
        leverage: position.leverage?.value ?? null,
      };
    })
    .filter((p): p is HyperliquidPosition => p !== null);
}

function parseOptionalFloat(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchClearinghouse(address: string): Promise<HyperliquidClearinghouseResponse> {
  const response = await cachedFetch(
    HYPERLIQUID_INFO_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address }),
    },
    CLEARINGHOUSE_CACHE_TTL_SECONDS,
    fetchWithRetry,
  );

  if (!response.ok) {
    throw new Error(`Hyperliquid HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  return (await response.json()) as HyperliquidClearinghouseResponse;
}

export async function getUserClearinghouseState(address: string): Promise<HyperliquidPosition[]> {
  return parsePositions(await fetchClearinghouse(address));
}

/** Snapshot untuk validasi kandidat whale -- posisi + equity ringkas (marginSummary). */
export async function getUserClearinghouseSnapshot(address: string): Promise<HyperliquidClearinghouseSnapshot> {
  const data = await fetchClearinghouse(address);
  return {
    address,
    accountValue: parseOptionalFloat(data.marginSummary?.accountValue),
    withdrawable: parseOptionalFloat(data.withdrawable),
    totalMarginUsed: parseOptionalFloat(data.marginSummary?.totalMarginUsed),
    positions: parsePositions(data),
  };
}
