// Client Hyperliquid public API (DEX perpetual, on-chain) -- TIDAK butuh
// proxy relay, sudah dites langsung dari edge Cloudflare: 200 OK, gak ada
// block. API-nya JSON-RPC style (POST /info dengan {type: "..."}), beda
// paradigma dari REST query-param CEX biasa. metaAndAssetCtxs balikin 2
// array PARALEL (universe[i] <-> assetCtxs[i], index sama = asset sama).
import { fetchWithRetry } from "./retry.js";
import { cachedFetch } from "./cache.js";
import type { CrossExchangeFundingRate } from "./bybitClient.js";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const CACHE_TTL_SECONDS = 5;

interface HyperliquidUniverseAsset {
  name: string;
  isDelisted?: boolean;
}

interface HyperliquidAssetCtx {
  funding: string;
  markPx: string;
}

type HyperliquidMetaAndAssetCtxs = [{ universe: HyperliquidUniverseAsset[] }, HyperliquidAssetCtx[]];

export async function getHyperliquidFundingRate(baseAsset: string): Promise<CrossExchangeFundingRate> {
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

  return { fundingRate: parseFloat(ctx.funding), lastPrice: parseFloat(ctx.markPx) };
}
