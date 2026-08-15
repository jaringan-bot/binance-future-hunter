// Sumber data Binance Futures LANGSUNG (bukan lewat Coinalyze), dipanggil
// lewat proxy relay di Vercel (lihat folder proxy/ di repo ini).
//
// KENAPA PERLU PROXY: worker Cloudflare ini diblokir total oleh WAF Binance
// (403 di semua endpoint fapi.binance.com, termasuk /fapi/v1/ping paling
// dasar — sudah dites & dikonfirmasi). Vercel di region Singapura (sin1)
// tidak kena block WAF itu DAN tidak kena geo-restriction Binance (yang
// memblokir region US/iad1, region default Vercel).
//
// Proxy ini expose data yang TIDAK tersedia atau tidak akurat presisinya
// lewat Coinalyze:
// - Order book depth (bid/ask real-time dengan size per level)
// - Top-trader long/short ratio (breakdown akun TOP TRADER, terpisah dari
//   retail/global account — ini yang Coinalyze TIDAK punya, cuma versi
//   blended semua trader)
// - Aggregate trades (untuk hitung CVD granular per-trade, bukan per-jam)
// - Funding rate (history & terkini) dan klines/OHLCV — ditambahkan karena
//   Coinalyze terbukti salah skala untuk pair kecil (funding rate DODOXUSDT
//   dilaporkan -57% padahal Binance asli 0.005%) dan harga dibulatkan
//   terlalu kasar (2 desimal fixed, menghancurkan presisi pair < $1).
//   Binance native adalah source of truth untuk keduanya.
// - Open interest (snapshot & histori), long/short ratio blended (global
//   account), dan taker buy/sell volume ratio — dipindah dari Coinalyze
//   karena Binance punya endpoint publik resmi untuk ketiganya, jadi tidak
//   perlu lagi bergantung ke agregator pihak ketiga untuk data ini.
//
// Lihat proxy/README.md untuk detail whitelist path yang diizinkan proxy ini.

import { fetchWithRetry } from "./retry.js";
import { withCache } from "./cache.js";
import { checkAndRecordRequest } from "./rateLimiter.js";

// Path yang TIDAK di-cache sama sekali (ttl=0) -- order book & trade granular
// butuh freshness ketat, cache di sini bisa bikin sinyal spoofing/absorption
// jadi bias (lihat docs/mm_detection_framework.md Section 3, snapshot sesaat
// yang basi = analisis salah).
//
// Path lain di-cache TTL bertingkat berdasarkan seberapa cepat datanya
// berubah -- sebelumnya semua path non-order-book flat 5 detik, padahal
// funding rate history/topLongShortRatio dsb baru update per beberapa menit
// (funding settle tiap 4-8 jam), jadi flat 5s buang-buang round-trip ke
// proxy tanpa manfaat freshness nyata.
const NO_CACHE_PATHS = new Set(["/fapi/v1/depth", "/fapi/v1/aggTrades", "/api/v3/depth", "/api/v3/aggTrades"]);

// Snapshot cepat berubah (harga/mark price/OI terkini) -- tetap short TTL
// biar deteksi pergerakan sesaat gak ketinggalan jauh.
const SHORT_CACHE_PATHS = new Set([
  "/fapi/v1/premiumIndex",
  "/fapi/v1/openInterest",
  "/fapi/v1/ticker/24hr",
  "/api/v3/ticker/price",
  "/api/v3/ticker/24hr",
  "/api/v3/ticker/bookTicker",
]);
const SHORT_CACHE_TTL_SECONDS = 5;

// Candle & rata-rata bergerak -- berubah per interval, cache seukuran
// interval terkecil yang wajar (1 menit) masih aman.
const MEDIUM_CACHE_PATHS = new Set(["/fapi/v1/klines", "/api/v3/klines", "/api/v3/avgPrice"]);
const MEDIUM_CACHE_TTL_SECONDS = 60;

// Histori funding & rasio futures/data/* -- Binance sendiri baru update
// data ini per beberapa menit (funding settle tiap 4-8 jam), 5 menit TTL
// gak bikin data basi buat kebutuhan analisis (bukan HFT).
const LONG_CACHE_PATHS = new Set([
  "/fapi/v1/fundingRate",
  "/futures/data/topLongShortAccountRatio",
  "/futures/data/topLongShortPositionRatio",
  "/futures/data/globalLongShortAccountRatio",
  "/futures/data/openInterestHist",
  "/futures/data/takerlongshortRatio",
]);
const LONG_CACHE_TTL_SECONDS = 300;

// Metadata listing/status pair -- praktis statis, jarang berubah dalam sehari.
const STATIC_CACHE_PATHS = new Set(["/api/v3/exchangeInfo"]);
const STATIC_CACHE_TTL_SECONDS = 3600;

function cacheTtlForPath(path: string): number {
  if (NO_CACHE_PATHS.has(path)) return 0;
  if (SHORT_CACHE_PATHS.has(path)) return SHORT_CACHE_TTL_SECONDS;
  if (MEDIUM_CACHE_PATHS.has(path)) return MEDIUM_CACHE_TTL_SECONDS;
  if (LONG_CACHE_PATHS.has(path)) return LONG_CACHE_TTL_SECONDS;
  if (STATIC_CACHE_PATHS.has(path)) return STATIC_CACHE_TTL_SECONDS;
  return SHORT_CACHE_TTL_SECONDS; // fallback aman kalau ada path baru belum dikategorikan
}

const PROXY_ALLOWED_PATHS = new Set([
  "/fapi/v1/depth",
  "/fapi/v1/aggTrades",
  "/fapi/v1/fundingRate",
  "/fapi/v1/premiumIndex",
  "/fapi/v1/klines",
  "/fapi/v1/ticker/24hr",
  "/fapi/v1/openInterest",
  "/futures/data/topLongShortAccountRatio",
  "/futures/data/topLongShortPositionRatio",
  "/futures/data/globalLongShortAccountRatio",
  "/futures/data/openInterestHist",
  "/futures/data/takerlongshortRatio",
  // Spot (lihat proxy/api/binance.ts market='spot') — dipakai untuk basis
  // futures-vs-spot riil, bukan cuma vs index price blended, plus data spot
  // pelengkap lain (24hr, book ticker, depth, klines, aggTrades, avgPrice,
  // exchangeInfo untuk cek status listing).
  "/api/v3/ticker/price",
  "/api/v3/ticker/24hr",
  "/api/v3/ticker/bookTicker",
  "/api/v3/depth",
  "/api/v3/klines",
  "/api/v3/aggTrades",
  "/api/v3/avgPrice",
  "/api/v3/exchangeInfo",
]);

interface ProxyEndpoint {
  url: string;
  secret: string;
}

let primaryEndpoint: ProxyEndpoint | undefined;
let secondaryEndpoint: ProxyEndpoint | undefined;
let directFallbackEnabled = true;

// secondaryUrl/secondarySecret OPSIONAL -- kalau tidak diset, tier kedua
// cuma di-skip. enableDirectFallback default true: kalau primary DAN
// secondary (kalau ada) gagal, coba langsung ke fapi.binance.com/
// api.binance.com TANPA proxy sama sekali sebagai last-resort -- lihat
// komentar DIRECT FALLBACK di bawah untuk kenapa ini masih berguna
// meskipun worker ini SUDAH TERBUKTI diblokir WAF Binance secara langsung.
export function setProxyConfig(
  url: string | undefined,
  secret: string | undefined,
  secondaryUrl?: string,
  secondarySecret?: string,
  enableDirectFallback = true,
) {
  primaryEndpoint = url && secret ? { url, secret } : undefined;
  secondaryEndpoint = secondaryUrl && secondarySecret ? { url: secondaryUrl, secret: secondarySecret } : undefined;
  directFallbackEnabled = enableDirectFallback;
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

// Status yang layak dicoba ulang ke tier BERIKUTNYA: 401 (secret salah --
// TIAP tier proxy punya secret SENDIRI, jadi primary salah bukan berarti
// secondary juga salah, beda kasus dari 400/404 di bawah), 403 (WAF block,
// kasus utama kenapa proxy ini ada), 429 (rate limit), 5xx (proxy/upstream
// lagi bermasalah). SENGAJA TIDAK termasuk 400/404 -- itu genuinely error
// request (symbol salah, path salah) yang bakal gagal identik di tier
// manapun, retry ke tier lain cuma buang latency tanpa peluang berhasil.
const FAILOVER_STATUS = new Set([401, 403, 429, 500, 502, 503, 504]);

// DIRECT FALLBACK -- tier terakhir, langsung ke Binance TANPA proxy sama
// sekali. CATATAN JUJUR: worker Cloudflare ini SUDAH TERBUKTI diblokir
// total oleh WAF Binance (403, lihat komentar file di atas) -- tier ini di
// kondisi produksi saat ini kemungkinan besar ikut kena 403. Tetap
// dipertahankan sebagai last-resort karena: (a) kalau kebijakan block
// Binance/Cloudflare berubah, tier ini otomatis pulih tanpa perlu redeploy;
// (b) `wrangler dev` lokal atau fork yang dijalankan dari runtime lain
// punya IP pool BEDA dari edge Cloudflare produksi, jadi bisa saja tidak
// kena block sama sekali (dikonfirmasi langsung: `wrangler dev` lokal
// BERHASIL narik data Binance lewat tier ini tanpa proxy dikonfigurasi
// sama sekali).
const DIRECT_BASE_BY_MARKET: Record<"futures" | "spot", string> = {
  futures: "https://fapi.binance.com",
  spot: "https://api.binance.com",
};

// Cache key TERPISAH dari URL fetch fisik -- satu logical request
// (path+params+market) bisa dilayani tier manapun (primary/secondary/
// direct), tapi harus tetap 1 cache entry supaya failover antar tier tidak
// memecah cache jadi entry-entry terpisah per tier (kehilangan hit rate).
function buildCacheKeyUrl(
  path: string,
  params: Record<string, string | number | undefined>,
  market: "futures" | "spot",
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  search.sort();
  return `https://whalescope-cache.internal${path}?market=${market}&${search.toString()}`;
}

// Parse response body bersama buat callProxyEndpoint & callProxyDirect --
// keduanya punya kontrak sama (JSON body, error 4xx/5xx dari upstream),
// cuma beda cara build URL/header request-nya.
async function parseProxyResponse<T>(response: Response, path: string, authErrorHint: string): Promise<T> {
  const bodyText = await response.text();
  if (!response.ok) {
    throw new BinanceProxyError(
      `Proxy/Binance error HTTP ${response.status}: ${bodyText.slice(0, 300)}. ` +
        (response.status === 401 ? authErrorHint : "Cek symbol/parameter, atau kemungkinan geo-restriction Binance."),
      response.status,
      path,
    );
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new BinanceProxyError(`Response proxy bukan JSON valid: ${bodyText.slice(0, 300)}`, response.status, path);
  }
}

async function callProxyEndpoint<T>(
  endpoint: ProxyEndpoint,
  path: string,
  params: Record<string, string | number | undefined>,
  market: "futures" | "spot",
): Promise<T> {
  const url = new URL(`${endpoint.url}/api/binance`);
  url.searchParams.set("path", path);
  if (market !== "futures") url.searchParams.set("market", market);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  let response: Response;
  try {
    response = await withCache(buildCacheKeyUrl(path, params, market), cacheTtlForPath(path), () =>
      fetchWithRetry(url.toString(), { headers: { "x-proxy-secret": endpoint.secret, Accept: "application/json" } }),
    );
  } catch (err) {
    throw new BinanceProxyError(
      `Gagal menghubungi proxy Vercel: ${(err as Error).message}. Cek apakah PROXY_URL benar dan proxy sedang aktif.`,
      undefined,
      path,
    );
  }

  return parseProxyResponse<T>(response, path, "Cek PROXY_SECRET cocok antara worker dan Vercel (primary maupun secondary).");
}

async function callProxyDirect<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  market: "futures" | "spot",
): Promise<T> {
  const url = new URL(`${DIRECT_BASE_BY_MARKET[market]}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await withCache(buildCacheKeyUrl(path, params, market), cacheTtlForPath(path), () =>
      fetchWithRetry(url.toString(), { headers: { Accept: "application/json" } }),
    );
  } catch (err) {
    throw new BinanceProxyError(
      `Gagal menghubungi Binance langsung (direct fallback): ${(err as Error).message}.`,
      undefined,
      path,
    );
  }

  return parseProxyResponse<T>(response, path, "Kemungkinan WAF block Binance (lihat komentar DIRECT FALLBACK).");
}

interface ProxyTier {
  label: string;
  run: () => Promise<unknown>;
}

async function callProxy<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  market: "futures" | "spot" = "futures",
): Promise<T> {
  if (!path.startsWith("/") || !PROXY_ALLOWED_PATHS.has(path)) {
    throw new BinanceProxyError(
      `Path '${path}' tidak ada di whitelist proxy. Cek PROXY_ALLOWED_PATHS di binanceProxyClient.ts.`,
      undefined,
      path,
    );
  }
  // Primary WAJIB dikonfigurasi -- direct fallback cuma dipakai SETELAH
  // primary (yang sudah dikonfigurasi) gagal, BUKAN pengganti setup proxy
  // sama sekali. Kalau tidak, error jadi kurang jelas untuk deployment
  // yang lupa set secret (lihat README "PROXY_URL atau PROXY_SECRET belum
  // diset" -- pesan itu wajib tetap muncul di kasus ini).
  if (!primaryEndpoint) {
    throw new BinanceProxyError(
      "PROXY_URL atau PROXY_SECRET belum diset di worker. Jalankan `wrangler secret put PROXY_URL` dan `wrangler secret put PROXY_SECRET`.",
      undefined,
      path,
    );
  }

  // Self-throttle SEBELUM nembak network -- lihat rateLimiter.ts buat detail
  // & keterbatasannya (best-effort per-isolate, bukan hard global limiter).
  checkAndRecordRequest();

  const tiers: ProxyTier[] = [
    { label: "primary", run: () => callProxyEndpoint<T>(primaryEndpoint!, path, params, market) },
  ];
  if (secondaryEndpoint) {
    const endpoint = secondaryEndpoint;
    tiers.push({ label: "secondary", run: () => callProxyEndpoint<T>(endpoint, path, params, market) });
  }
  if (directFallbackEnabled) {
    tiers.push({ label: "direct", run: () => callProxyDirect<T>(path, params, market) });
  }

  let lastErr: unknown;
  for (let i = 0; i < tiers.length; i++) {
    try {
      return (await tiers[i].run()) as T;
    } catch (err) {
      lastErr = err;
      const status = err instanceof BinanceProxyError ? err.status : undefined;
      const isFailoverWorthy = status === undefined || FAILOVER_STATUS.has(status);
      const nextTier = tiers[i + 1];
      if (!isFailoverWorthy || !nextTier) throw err;
      console.log(`[proxy-failover] ${tiers[i].label} gagal (${status ?? "network error"}), coba ${nextTier.label} untuk ${path}`);
    }
  }
  throw lastErr;
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
// OPEN INTEREST (NATIVE) — menggantikan Coinalyze untuk OI snapshot
// terkini dan histori. openInterest/sumOpenInterest sudah dalam satuan
// kontrak (base asset), tidak perlu konversi.
// ─────────────────────────────────────────────────────────────
export interface OpenInterestPoint {
  symbol: string;
  openInterest: string;
  time: number;
}

export async function getOpenInterestNative(symbol: string): Promise<OpenInterestPoint> {
  return callProxy<OpenInterestPoint>("/fapi/v1/openInterest", { symbol: symbol.toUpperCase() });
}

export interface OpenInterestHistPoint {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

export async function getOpenInterestHistNative(
  symbol: string,
  period: string,
  limit: number,
): Promise<OpenInterestHistPoint[]> {
  return callProxy<OpenInterestHistPoint[]>("/futures/data/openInterestHist", {
    symbol: symbol.toUpperCase(),
    period,
    limit,
  });
}

// ─────────────────────────────────────────────────────────────
// TAKER BUY/SELL VOLUME RATIO (NATIVE) — statistik resmi Binance,
// menggantikan pendekatan Coinalyze yang diturunkan manual dari volume
// candlestick. buySellRatio sudah dihitung Binance sendiri (buyVol/sellVol).
// ─────────────────────────────────────────────────────────────
export interface TakerLongShortRatioPoint {
  buySellRatio: string;
  buyVol: string;
  sellVol: string;
  timestamp: number;
}

export async function getTakerLongShortRatioNative(
  symbol: string,
  period: string,
  limit: number,
): Promise<TakerLongShortRatioPoint[]> {
  return callProxy<TakerLongShortRatioPoint[]>("/futures/data/takerlongshortRatio", {
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

// ─────────────────────────────────────────────────────────────
// FUNDING RATE (NATIVE) — menggantikan Coinalyze untuk sumber
// funding rate. Field "fundingRate" dari Binance sudah berupa
// desimal murni (contoh: "0.00010000" = 0.01%), TIDAK perlu
// diproses ulang skalanya di sini.
// ─────────────────────────────────────────────────────────────
export interface FundingRateHistoryPoint {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
  markPrice: string;
}

export async function getFundingRateHistoryNative(
  symbol: string,
  limit: number,
): Promise<FundingRateHistoryPoint[]> {
  return callProxy<FundingRateHistoryPoint[]>("/fapi/v1/fundingRate", {
    symbol: symbol.toUpperCase(),
    limit,
  });
}

// premiumIndex adalah endpoint Binance native untuk funding rate TERKINI
// (belum settled) + mark price + waktu funding berikutnya. Ini pengganti
// coinalyze.getCurrentFundingRate.
export interface PremiumIndexPoint {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  interestRate: string;
  time: number;
}

export async function getCurrentFundingRateNative(symbol: string): Promise<PremiumIndexPoint> {
  return callProxy<PremiumIndexPoint>("/fapi/v1/premiumIndex", { symbol: symbol.toUpperCase() });
}

// premiumIndex TANPA parameter symbol balikin SEMUA pair Futures sekaligus
// (862 pair dites langsung 2026-08-11) -- dipakai buat market scanner,
// jauh lebih murah daripada loop per-symbol.
export async function getBulkFundingRatesNative(): Promise<PremiumIndexPoint[]> {
  return callProxy<PremiumIndexPoint[]>("/fapi/v1/premiumIndex", {});
}

// ─────────────────────────────────────────────────────────────
// KLINES / CANDLESTICK (NATIVE) — menggantikan Coinalyze ohlcv-history
// untuk sumber harga. Format response Binance adalah array-of-array
// (bukan object), urutan field: [openTime, open, high, low, close,
// volume, closeTime, quoteAssetVolume, numberOfTrades,
// takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume, ignore].
// ─────────────────────────────────────────────────────────────
export type KlineTuple = [
  number, // openTime
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // closeTime
  string, // quoteAssetVolume
  number, // numberOfTrades
  string, // takerBuyBaseAssetVolume
  string, // takerBuyQuoteAssetVolume
  string, // ignore
];

export async function getKlinesNative(
  symbol: string,
  interval: string,
  limit: number,
  startTime?: number,
  endTime?: number,
): Promise<KlineTuple[]> {
  return callProxy<KlineTuple[]>("/fapi/v1/klines", {
    symbol: symbol.toUpperCase(),
    interval,
    limit,
    startTime,
    endTime,
  });
}

// ─────────────────────────────────────────────────────────────
// 24HR TICKER (NATIVE) — statistik 24 jam resmi Binance (rolling
// window asli), menggantikan pendekatan Coinalyze yang dihitung
// manual dari 24 candle 1 jam.
// ─────────────────────────────────────────────────────────────
export interface Ticker24hr {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
}

export async function getTicker24hrNative(symbol: string): Promise<Ticker24hr> {
  return callProxy<Ticker24hr>("/fapi/v1/ticker/24hr", { symbol: symbol.toUpperCase() });
}

// ─────────────────────────────────────────────────────────────
// SPOT PRICE — harga spot Binance (bukan Futures), dipakai untuk hitung
// basis futures-vs-spot riil. Kalau symbol tidak listed di Binance Spot
// (banyak pair futures-only kayak koin baru), Binance balas error yang
// diteruskan lewat BinanceProxyError.
// ─────────────────────────────────────────────────────────────
export interface SpotPrice {
  symbol: string;
  price: string;
}

export async function getSpotPrice(symbol: string): Promise<SpotPrice> {
  return callProxy<SpotPrice>("/api/v3/ticker/price", { symbol: symbol.toUpperCase() }, "spot");
}

// ─────────────────────────────────────────────────────────────
// SPOT 24HR TICKER — lebih kaya dari futures Ticker24hr: ada
// weightedAvgPrice (VWAP), openPrice, bidPrice/askPrice, dan count
// (jumlah trade dalam window).
// ─────────────────────────────────────────────────────────────
export interface SpotTicker24hr {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  lastPrice: string;
  bidPrice: string;
  askPrice: string;
  volume: string;
  quoteVolume: string;
  count: number;
}

export async function getSpotTicker24hr(symbol: string): Promise<SpotTicker24hr> {
  return callProxy<SpotTicker24hr>("/api/v3/ticker/24hr", { symbol: symbol.toUpperCase() }, "spot");
}

// ─────────────────────────────────────────────────────────────
// SPOT BOOK TICKER — best bid/ask real-time, lebih ringan dari full
// depth kalau cuma butuh spread sesaat.
// ─────────────────────────────────────────────────────────────
export interface SpotBookTicker {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
}

export async function getSpotBookTicker(symbol: string): Promise<SpotBookTicker> {
  return callProxy<SpotBookTicker>("/api/v3/ticker/bookTicker", { symbol: symbol.toUpperCase() }, "spot");
}

// ─────────────────────────────────────────────────────────────
// SPOT ORDER BOOK — sama konsepnya dengan OrderBookDepth futures, tapi
// response spot TIDAK punya field E/T (event/transaction time).
// ─────────────────────────────────────────────────────────────
export interface SpotOrderBook {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export async function getSpotOrderBook(symbol: string, limit: number): Promise<SpotOrderBook> {
  return callProxy<SpotOrderBook>("/api/v3/depth", { symbol: symbol.toUpperCase(), limit }, "spot");
}

// ─────────────────────────────────────────────────────────────
// SPOT KLINES & AGG TRADES — format response sama persis dengan versi
// Futures (array-of-array untuk klines, object array untuk aggTrades),
// jadi reuse tipe KlineTuple & AggTrade yang sudah ada di atas.
// ─────────────────────────────────────────────────────────────
export async function getSpotKlinesNative(
  symbol: string,
  interval: string,
  limit: number,
  startTime?: number,
  endTime?: number,
): Promise<KlineTuple[]> {
  return callProxy<KlineTuple[]>(
    "/api/v3/klines",
    { symbol: symbol.toUpperCase(), interval, limit, startTime, endTime },
    "spot",
  );
}

export async function getSpotAggTrades(symbol: string, limit: number): Promise<AggTrade[]> {
  return callProxy<AggTrade[]>("/api/v3/aggTrades", { symbol: symbol.toUpperCase(), limit }, "spot");
}

// ─────────────────────────────────────────────────────────────
// SPOT AVG PRICE — harga rata-rata bergerak (default window 5 menit
// dari sisi Binance, ditentukan oleh 'mins' pada response).
// ─────────────────────────────────────────────────────────────
export interface SpotAvgPrice {
  mins: number;
  price: string;
}

export async function getSpotAvgPrice(symbol: string): Promise<SpotAvgPrice> {
  return callProxy<SpotAvgPrice>("/api/v3/avgPrice", { symbol: symbol.toUpperCase() }, "spot");
}

// ─────────────────────────────────────────────────────────────
// SPOT EXCHANGE INFO (per-symbol) — buat cek apakah sebuah pair BENAR
// listed di Binance Spot dan status tradingnya, bukan cuma nebak dari
// error "Invalid symbol" di endpoint lain. Banyak pair Futures (terutama
// koin baru/kecil) TIDAK listed di Spot sama sekali.
// ─────────────────────────────────────────────────────────────
export interface SpotSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed: boolean;
}

interface SpotExchangeInfoResponse {
  symbols: SpotSymbolInfo[];
}

export async function getSpotExchangeInfo(symbol: string): Promise<SpotSymbolInfo | null> {
  const data = await callProxy<SpotExchangeInfoResponse>(
    "/api/v3/exchangeInfo",
    { symbol: symbol.toUpperCase() },
    "spot",
  );
  return data.symbols[0] ?? null;
}
