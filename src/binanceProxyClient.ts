// Sumber data Binance Futures LANGSUNG (bukan lewat Coinalyze), dipanggil
// lewat proxy relay di Vercel (lihat folder proxy/ di repo ini).
//
// KENAPA PERLU PROXY: worker Cloudflare ini diblokir total oleh WAF Binance
// (403 di semua endpoint fapi.binance.com, termasuk /fapi/v1/ping paling
// dasar — sudah dites & dikonfirmasi). Vercel di region Singapura (sin1)
// tidak kena block WAF itu DAN tidak kena geo-restriction Binance (yang
// memblokir region US/iad1, region default Vercel).
//
// Proxy ini expose 3 data yang TIDAK tersedia di Coinalyze:
// - Order book depth (bid/ask real-time dengan size per level)
// - Top-trader long/short ratio (breakdown akun TOP TRADER, terpisah dari
//   retail/global account — ini yang Coinalyze TIDAK punya, cuma versi
//   blended semua trader)
// - Aggregate trades (untuk hitung CVD granular per-trade, bukan per-jam)
//
// Lihat proxy/README.md untuk detail whitelist path yang diizinkan proxy ini.

const PROXY_ALLOWED_PATHS = new Set([
  "/fapi/v1/depth",
  "/fapi/v1/aggTrades",
  "/futures/data/topLongShortAccountRatio",
  "/futures/data/topLongShortPositionRatio",
  "/futures/data/globalLongShortAccountRatio",
]);

let proxyUrl: string | undefined;
let proxySecret: string | undefined;

export function setProxyConfig(url: string | undefined, secret: string | undefined) {
  proxyUrl = url;
  proxySecret = secret;
}

export class BinanceProxyError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "BinanceProxyError";
  }
}

async function callProxy<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  if (!path.startsWith("/") || !PROXY_ALLOWED_PATHS.has(path)) {
    throw new BinanceProxyError(
      `Path '${path}' tidak ada di whitelist proxy. Cek PROXY_ALLOWED_PATHS di binanceProxyClient.ts.`,
      undefined,
      path,
    );
  }
  if (!proxyUrl || !proxySecret) {
    throw new BinanceProxyError(
      "PROXY_URL atau PROXY_SECRET belum diset di worker. Jalankan `wrangler secret put PROXY_URL` dan `wrangler secret put PROXY_SECRET`.",
      undefined,
      path,
    );
  }

  const url = new URL(`${proxyUrl}/api/binance`);
  url.searchParams.set("path", path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { "x-proxy-secret": proxySecret, Accept: "application/json" },
    });
  } catch (err) {
    throw new BinanceProxyError(
      `Gagal menghubungi proxy Vercel: ${(err as Error).message}. Cek apakah PROXY_URL benar dan proxy sedang aktif.`,
      undefined,
      path,
    );
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new BinanceProxyError(
      `Proxy/Binance error HTTP ${response.status}: ${bodyText.slice(0, 300)}. ` +
        (response.status === 401
          ? "Cek PROXY_SECRET cocok antara worker dan Vercel."
          : "Cek symbol/parameter, atau kemungkinan geo-restriction Binance."),
      response.status,
      path,
    );
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new BinanceProxyError(
      `Response proxy bukan JSON valid: ${bodyText.slice(0, 300)}`,
      response.status,
      path,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// ORDER BOOK DEPTH
// ─────────────────────────────────────────────────────────────
export interface OrderBookDepth {
  lastUpdateId: number;
  E: number; // event time
  T: number; // transaction time
  bids: [string, string][]; // [price, quantity]
  asks: [string, string][];
}

export async function getOrderBookDepth(symbol: string, limit: number): Promise<OrderBookDepth> {
  return callProxy<OrderBookDepth>("/fapi/v1/depth", { symbol: symbol.toUpperCase(), limit });
}

// ─────────────────────────────────────────────────────────────
// TOP-TRADER LONG/SHORT RATIO — breakdown akun top trader,
// TERPISAH dari data blended Coinalyze.
// ─────────────────────────────────────────────────────────────
export interface TopTraderRatioPoint {
  symbol: string;
  longAccount: string;
  longShortRatio: string;
  shortAccount: string;
  timestamp: number;
}

export async function getTopTraderAccountRatio(
  symbol: string,
  period: string,
  limit: number,
): Promise<TopTraderRatioPoint[]> {
  return callProxy<TopTraderRatioPoint[]>("/futures/data/topLongShortAccountRatio", {
    symbol: symbol.toUpperCase(),
    period,
    limit,
  });
}

export interface TopTraderPositionRatioPoint {
  symbol: string;
  longAccount: string;
  longShortRatio: string;
  shortAccount: string;
  timestamp: number;
}

export async function getTopTraderPositionRatio(
  symbol: string,
  period: string,
  limit: number,
): Promise<TopTraderPositionRatioPoint[]> {
  return callProxy<TopTraderPositionRatioPoint[]>("/futures/data/topLongShortPositionRatio", {
    symbol: symbol.toUpperCase(),
    period,
    limit,
  });
}

export interface GlobalAccountRatioPoint {
  symbol: string;
  longAccount: string;
  longShortRatio: string;
  shortAccount: string;
  timestamp: number;
}

export async function getGlobalAccountRatio(
  symbol: string,
  period: string,
  limit: number,
): Promise<GlobalAccountRatioPoint[]> {
  return callProxy<GlobalAccountRatioPoint[]>("/futures/data/globalLongShortAccountRatio", {
    symbol: symbol.toUpperCase(),
    period,
    limit,
  });
}

// ─────────────────────────────────────────────────────────────
// AGGREGATE TRADES — untuk CVD granular per-trade
// ─────────────────────────────────────────────────────────────
export interface AggTrade {
  a: number; // aggregate trade id
  p: string; // price
  q: string; // quantity
  f: number; // first trade id
  l: number; // last trade id
  T: number; // timestamp
  m: boolean; // was the buyer the maker? true = sell-side aggressor, false = buy-side aggressor
}

export async function getAggTrades(symbol: string, limit: number): Promise<AggTrade[]> {
  return callProxy<AggTrade[]>("/fapi/v1/aggTrades", { symbol: symbol.toUpperCase(), limit });
}
