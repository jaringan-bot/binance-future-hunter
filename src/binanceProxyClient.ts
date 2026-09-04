// Sumber data Binance Futures LANGSUNG (bukan lewat Coinalyze), dipanggil
// lewat proxy relay di Vercel (lihat folder proxy/ di repo ini).
//
// KENAPA PERLU PROXY: worker Cloudflare ini diblokir total oleh WAF Binance
// (403 di semua endpoint fapi.binance.com, termasuk /fapi/v1/ping paling
// dasar — sudah dites & dikonfirmasi). Vercel di region Singapura (sin1)
// tidak kena block WAF itu DAN tidak kena geo-restriction Binance (yang
// memblokir region US/iad1, region default Vercel).

import { fetchWithRetry } from "./retry.js";
import { withCache } from "./cache.js";
import { checkAndRecordRequest } from "./rateLimiter.js";
import { signBinanceParams } from "./binanceHmac.js";

const NO_CACHE_PATHS = new Set([
  "/fapi/v1/depth",
  "/fapi/v1/aggTrades",
  "/fapi/v1/trades",
  "/fapi/v1/rpiDepth",
  "/fapi/v1/allForceOrders",
  "/api/v3/depth",
  "/api/v3/aggTrades",
]);

const SHORT_CACHE_PATHS = new Set([
  "/fapi/v1/premiumIndex",
  "/fapi/v1/openInterest",
  "/fapi/v1/ticker/24hr",
  "/fapi/v1/ticker/bookTicker",
  "/fapi/v2/ticker/price",
  "/api/v3/ticker/price",
  "/api/v3/ticker/24hr",
  "/api/v3/ticker",
  "/api/v3/ticker/bookTicker",
  "/fapi/v1/symbolAdlRisk",
  "/fapi/v1/insuranceBalance",
]);
const SHORT_CACHE_TTL_SECONDS = 5;

const MEDIUM_CACHE_PATHS = new Set([
  "/fapi/v1/klines",
  "/api/v3/klines",
  "/api/v3/avgPrice",
  "/fapi/v1/markPriceKlines",
  "/fapi/v1/indexPriceKlines",
  "/fapi/v1/premiumIndexKlines",
  "/fapi/v1/continuousKlines",
  "/fapi/v1/fundingInfo",
]);
const MEDIUM_CACHE_TTL_SECONDS = 60;

const LONG_CACHE_PATHS = new Set([
  "/fapi/v1/fundingRate",
  "/futures/data/topLongShortAccountRatio",
  "/futures/data/topLongShortPositionRatio",
  "/futures/data/globalLongShortAccountRatio",
  "/futures/data/openInterestHist",
  "/futures/data/takerlongshortRatio",
  "/futures/data/delivery-price",
  "/futures/data/basis",
  "/fapi/v1/tradingSchedule",
]);
const LONG_CACHE_TTL_SECONDS = 300;

const STATIC_CACHE_PATHS = new Set([
  "/api/v3/exchangeInfo",
  "/fapi/v1/exchangeInfo",
  "/fapi/v1/indexInfo",
  "/fapi/v1/constituents",
]);
const STATIC_CACHE_TTL_SECONDS = 3600;

function cacheTtlForPath(path: string): number {
  if (NO_CACHE_PATHS.has(path)) return 0;
  if (SHORT_CACHE_PATHS.has(path)) return SHORT_CACHE_TTL_SECONDS;
  if (MEDIUM_CACHE_PATHS.has(path)) return MEDIUM_CACHE_TTL_SECONDS;
  if (LONG_CACHE_PATHS.has(path)) return LONG_CACHE_TTL_SECONDS;
  if (STATIC_CACHE_PATHS.has(path)) return STATIC_CACHE_TTL_SECONDS;
  return SHORT_CACHE_TTL_SECONDS;
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
  "/futures/data/basis",
  "/api/v3/ticker/price",
  "/api/v3/ticker/24hr",
  "/api/v3/ticker",
  "/api/v3/ticker/bookTicker",
  "/api/v3/depth",
  "/api/v3/klines",
  "/api/v3/aggTrades",
  "/api/v3/avgPrice",
  "/api/v3/exchangeInfo",
  "/fapi/v1/symbolAdlRisk",
  "/fapi/v1/insuranceBalance",
  "/fapi/v1/markPriceKlines",
  "/fapi/v1/indexPriceKlines",
  "/fapi/v1/premiumIndexKlines",
  "/fapi/v1/indexInfo",
  "/fapi/v1/continuousKlines",
  "/futures/data/delivery-price",
  "/fapi/v1/constituents",
  "/fapi/v1/exchangeInfo",
  // NEW native extras
  "/fapi/v1/trades",
  "/fapi/v1/ticker/bookTicker",
  "/fapi/v2/ticker/price",
  "/fapi/v1/fundingInfo",
  "/fapi/v1/rpiDepth",
  "/fapi/v1/tradingSchedule",
  "/fapi/v1/allForceOrders",
  // SIGNED USER_DATA — needs BINANCE_API_KEY + HMAC via callProxySigned
  "/fapi/v1/leverageBracket",
]);

interface ProxyEndpoint {
  url: string;
  secret: string;
}

interface CallProxyOptions {
  market?: "futures" | "spot";
  /** Forwarded as `x-binance-api-key` → proxy → `X-MBX-APIKEY`. */
  extraHeaders?: Record<string, string>;
  /** Skip Cache API — required for signed params (timestamp/signature). */
  bypassCache?: boolean;
}

let primaryEndpoint: ProxyEndpoint | undefined;
let secondaryEndpoint: ProxyEndpoint | undefined;
let directFallbackEnabled = true;
// Round-robin cursor: when BOTH relay endpoints are configured, alternate
// which one is tried first per call so Binance REST load splits ~50/50
// across the two egress IPs (each relay host has its own IP + its own
// Binance weight budget). The not-first one becomes the failover tier.
let roundRobinCursor = 0;

// Optional Binance account API key — only for SIGNED endpoints (leverageBracket).
// Set from Worker secrets; never logged.
let binanceApiKey: string | undefined;
let binanceApiSecret: string | undefined;

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
  roundRobinCursor = 0;
}

export function setBinanceApiCredentials(
  apiKey: string | undefined,
  apiSecret: string | undefined,
): void {
  if (apiKey && apiSecret) {
    binanceApiKey = apiKey;
    binanceApiSecret = apiSecret;
  } else {
    binanceApiKey = undefined;
    binanceApiSecret = undefined;
  }
}

export function hasBinanceApiCredentials(): boolean {
  return Boolean(binanceApiKey && binanceApiSecret);
}

/**
 * Configured relay endpoints (URL only, no secret) — for the infra-health
 * cron to poll each relay's `/health`. Order: primary, then secondary.
 */
export function getRelayEndpoints(): { label: "primary" | "secondary"; url: string }[] {
  const out: { label: "primary" | "secondary"; url: string }[] = [];
  if (primaryEndpoint) out.push({ label: "primary", url: primaryEndpoint.url });
  if (secondaryEndpoint) out.push({ label: "secondary", url: secondaryEndpoint.url });
  return out;
}

export class BinanceProxyError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly path?: string,
    // "parse" -- body-nya HTTP 200 tapi gagal JSON.parse. Kemungkinan race
    // di withCache() (clone()+Cache API di bawah beban concurrent), belum
    // dipastikan akar masalahnya, tapi retry cepat 1x (bypass cache, fetch
    // baru) menyembuhkan gejalanya di kebanyakan kasus -- lihat pemanggil
    // parseProxyResponse() di callProxyEndpoint/callProxyDirect.
    public readonly kind: "http" | "parse" = "http",
  ) {
    super(message);
    this.name = "BinanceProxyError";
  }
}

// 402: Vercel mengembalikan HTTP 402 di level platform (JSON
// {"error":{"code":"402","message":"Payment required"}}, TIDAK pernah
// datang dari api/binance.ts maupun Binance) ketika project relay
// dinonaktifkan karena spend-cap/billing. Ini kondisi endpoint-level, bukan
// symbol/param -- persis kasus yang harus failover ke secondary / direct,
// bukan langsung dilempar ke caller.
// 418: Binance IP weight-ban (`{"code":-1003,"msg":"...IP(x) banned until..."}`).
//   Endpoint-level on the relay's egress IP, not a symbol/param error -- the
//   other relay IP is very likely NOT banned, so fail over.
// 451: Binance geo-block ("Unavailable For Legal Reasons"). The standalone
//   relay on Deno Deploy free tier serves from MANY edge regions incl.
//   Binance-restricted ones (US) -- a given request may randomly land on a
//   bad edge and 451 while the next lands on Singapore and works. Failing
//   over to the other relay (a fixed good region) recovers it.
// 404: relay project/deployment HILANG (mis. Deno Deploy `DEPLOYMENT_NOT_FOUND`,
//   insiden 2026-08-28 -- deployment relay sekunder terhapus). 404 datang dari
//   PLATFORM relay, bukan dari Binance. Dulu 404 tidak di set ini ->
//   `isFailoverWorthy` false -> `throw` tanpa coba tier lain -> SELURUH tick
//   cron mati walau tier lain (primary VPS) sehat. Wajib failover.
const FAILOVER_STATUS = new Set([401, 402, 403, 404, 418, 429, 451, 500, 502, 503, 504]);

// Status di mana tier `direct` (Worker -> fapi.binance.com dari edge CF) tak
// bisa bantu: 418 = IP weight-ban, 451 = geo-block, 404 = relay hilang
// (direct cuma kena WAF 403 -> bikin error rancu). `direct` di-skip supaya
// status asli yang ke-surface.
const DIRECT_UNHELPFUL_STATUS = new Set([404, 418, 451]);

const DIRECT_BASE_BY_MARKET: Record<"futures" | "spot", string> = {
  futures: "https://fapi.binance.com",
  spot: "https://api.binance.com",
};

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
    throw new BinanceProxyError(`Response proxy bukan JSON valid: ${bodyText.slice(0, 300)}`, response.status, path, "parse");
  }
}

function isParseError(err: unknown): err is BinanceProxyError {
  return err instanceof BinanceProxyError && err.kind === "parse";
}

async function callProxyEndpoint<T>(
  endpoint: ProxyEndpoint,
  path: string,
  params: Record<string, string | number | undefined>,
  market: "futures" | "spot",
  options: CallProxyOptions = {},
): Promise<T> {
  const url = new URL(`${endpoint.url}/api/binance`);
  url.searchParams.set("path", path);
  if (market !== "futures") url.searchParams.set("market", market);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const authErrorHint = "Cek PROXY_SECRET cocok antara worker dan host proxy relay (primary maupun secondary).";
  const headers: Record<string, string> = {
    "x-proxy-secret": endpoint.secret,
    Accept: "application/json",
    ...options.extraHeaders,
  };
  const doFetch = () => fetchWithRetry(url.toString(), { headers });

  let response: Response;
  try {
    if (options.bypassCache) {
      response = await doFetch();
    } else {
      response = await withCache(buildCacheKeyUrl(path, params, market), cacheTtlForPath(path), doFetch);
    }
  } catch (err) {
    throw new BinanceProxyError(
      `Gagal menghubungi proxy relay: ${(err as Error).message}. Cek apakah PROXY_URL benar dan proxy sedang aktif.`,
      undefined,
      path,
    );
  }
  try {
    return await parseProxyResponse<T>(response, path, authErrorHint);
  } catch (err) {
    if (!isParseError(err) || options.bypassCache) throw err;
    // Body ke-corrupt padahal HTTP 200 -- kemungkinan race di withCache()
    // (clone()+Cache API di bawah beban concurrent), belum dipastikan akar
    // masalahnya. Retry 1x BYPASS cache sama sekali (fetch baru langsung),
    // supaya kalau yang corrupt itu entry cache-nya sendiri, retry gak
    // baca ulang entry rusak yang sama.
    let freshResponse: Response;
    try {
      freshResponse = await doFetch();
    } catch (fetchErr) {
      throw new BinanceProxyError(
        `Gagal menghubungi proxy relay: ${(fetchErr as Error).message}. Cek apakah PROXY_URL benar dan proxy sedang aktif.`,
        undefined,
        path,
      );
    }
    return await parseProxyResponse<T>(freshResponse, path, authErrorHint);
  }
}

async function callProxyDirect<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  market: "futures" | "spot",
  options: CallProxyOptions = {},
): Promise<T> {
  const url = new URL(`${DIRECT_BASE_BY_MARKET[market]}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const authErrorHint = "Kemungkinan WAF block Binance (lihat komentar DIRECT FALLBACK).";
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.extraHeaders,
  };
  // Direct tier: Binance expects X-MBX-APIKEY (proxy maps x-binance-api-key).
  if (options.extraHeaders?.["x-binance-api-key"]) {
    headers["X-MBX-APIKEY"] = options.extraHeaders["x-binance-api-key"];
  }
  const doFetch = () => fetchWithRetry(url.toString(), { headers });

  let response: Response;
  try {
    if (options.bypassCache) {
      response = await doFetch();
    } else {
      response = await withCache(buildCacheKeyUrl(path, params, market), cacheTtlForPath(path), doFetch);
    }
  } catch (err) {
    throw new BinanceProxyError(
      `Gagal menghubungi Binance langsung (direct fallback): ${(err as Error).message}.`,
      undefined,
      path,
    );
  }
  try {
    return await parseProxyResponse<T>(response, path, authErrorHint);
  } catch (err) {
    if (!isParseError(err) || options.bypassCache) throw err;
    let freshResponse: Response;
    try {
      freshResponse = await doFetch();
    } catch (fetchErr) {
      throw new BinanceProxyError(
        `Gagal menghubungi Binance langsung (direct fallback): ${(fetchErr as Error).message}.`,
        undefined,
        path,
      );
    }
    return await parseProxyResponse<T>(freshResponse, path, authErrorHint);
  }
}

interface ProxyTier {
  label: string;
  run: () => Promise<unknown>;
}

async function callProxy<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  marketOrOptions: "futures" | "spot" | CallProxyOptions = "futures",
  maybeOptions?: CallProxyOptions,
): Promise<T> {
  const options: CallProxyOptions =
    typeof marketOrOptions === "string"
      ? { market: marketOrOptions, ...maybeOptions }
      : marketOrOptions;
  const market = options.market ?? "futures";

  if (!path.startsWith("/") || !PROXY_ALLOWED_PATHS.has(path)) {
    throw new BinanceProxyError(
      `Path '${path}' tidak ada di whitelist proxy. Cek PROXY_ALLOWED_PATHS di binanceProxyClient.ts.`,
      undefined,
      path,
    );
  }
  if (!primaryEndpoint) {
    throw new BinanceProxyError(
      "PROXY_URL atau PROXY_SECRET belum diset di worker. Jalankan `wrangler secret put PROXY_URL` dan `wrangler secret put PROXY_SECRET`.",
      undefined,
      path,
    );
  }
  checkAndRecordRequest();
  const tiers: ProxyTier[] = [];
  if (secondaryEndpoint) {
    // Both configured -> round-robin the first-tried endpoint, the other is
    // the failover tier.
    const primaryFirst = roundRobinCursor++ % 2 === 0;
    const a = primaryFirst ? primaryEndpoint! : secondaryEndpoint;
    const b = primaryFirst ? secondaryEndpoint : primaryEndpoint!;
    const aLabel = primaryFirst ? "primary" : "secondary";
    const bLabel = primaryFirst ? "secondary" : "primary";
    tiers.push({ label: aLabel, run: () => callProxyEndpoint<T>(a, path, params, market, options) });
    tiers.push({ label: bLabel, run: () => callProxyEndpoint<T>(b, path, params, market, options) });
  } else {
    tiers.push({
      label: "primary",
      run: () => callProxyEndpoint<T>(primaryEndpoint!, path, params, market, options),
    });
  }
  if (directFallbackEnabled) {
    tiers.push({ label: "direct", run: () => callProxyDirect<T>(path, params, market, options) });
  }
  let lastErr: unknown;
  for (let i = 0; i < tiers.length; i++) {
    try {
      return (await tiers[i].run()) as T;
    } catch (err) {
      lastErr = err;
      const status = err instanceof BinanceProxyError ? err.status : undefined;
      const isFailoverWorthy = status === undefined || FAILOVER_STATUS.has(status);
      let nextTier = tiers[i + 1];
      if (status !== undefined && DIRECT_UNHELPFUL_STATUS.has(status) && nextTier?.label === "direct") {
        nextTier = undefined as unknown as ProxyTier;
      }
      if (!isFailoverWorthy || !nextTier) throw err;
      console.log(`[proxy-failover] ${tiers[i].label} gagal (${status ?? "network error"}), coba ${nextTier.label} untuk ${path}`);
    }
  }
  throw lastErr;
}

export interface OrderBookDepth {
  lastUpdateId: number;
  E: number;
  T: number;
  bids: [string, string][];
  asks: [string, string][];
}

export async function getOrderBookDepth(symbol: string, limit: number): Promise<OrderBookDepth> {
  return callProxy<OrderBookDepth>("/fapi/v1/depth", { symbol: symbol.toUpperCase(), limit });
}

export interface TopTraderRatioPoint {
  symbol: string;
  longAccount: string;
  longShortRatio: string;
  shortAccount: string;
  timestamp: number;
}

export async function getTopTraderAccountRatio(symbol: string, period: string, limit: number): Promise<TopTraderRatioPoint[]> {
  return callProxy<TopTraderRatioPoint[]>("/futures/data/topLongShortAccountRatio", { symbol: symbol.toUpperCase(), period, limit });
}

export interface TopTraderPositionRatioPoint {
  symbol: string;
  longAccount: string;
  longShortRatio: string;
  shortAccount: string;
  timestamp: number;
}

export async function getTopTraderPositionRatio(symbol: string, period: string, limit: number): Promise<TopTraderPositionRatioPoint[]> {
  return callProxy<TopTraderPositionRatioPoint[]>("/futures/data/topLongShortPositionRatio", { symbol: symbol.toUpperCase(), period, limit });
}

export interface GlobalAccountRatioPoint {
  symbol: string;
  longAccount: string;
  longShortRatio: string;
  shortAccount: string;
  timestamp: number;
}

export async function getGlobalAccountRatio(symbol: string, period: string, limit: number): Promise<GlobalAccountRatioPoint[]> {
  return callProxy<GlobalAccountRatioPoint[]>("/futures/data/globalLongShortAccountRatio", { symbol: symbol.toUpperCase(), period, limit });
}

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

export async function getOpenInterestHistNative(symbol: string, period: string, limit: number): Promise<OpenInterestHistPoint[]> {
  return callProxy<OpenInterestHistPoint[]>("/futures/data/openInterestHist", { symbol: symbol.toUpperCase(), period, limit });
}

export interface TakerLongShortRatioPoint {
  buySellRatio: string;
  buyVol: string;
  sellVol: string;
  timestamp: number;
}

export async function getTakerLongShortRatioNative(symbol: string, period: string, limit: number): Promise<TakerLongShortRatioPoint[]> {
  return callProxy<TakerLongShortRatioPoint[]>("/futures/data/takerlongshortRatio", { symbol: symbol.toUpperCase(), period, limit });
}

export interface AggTrade {
  a: number;
  p: string;
  q: string;
  f: number;
  l: number;
  T: number;
  m: boolean;
}

export async function getAggTrades(symbol: string, limit: number): Promise<AggTrade[]> {
  return callProxy<AggTrade[]>("/fapi/v1/aggTrades", { symbol: symbol.toUpperCase(), limit });
}

export interface FundingRateHistoryPoint {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
  markPrice: string;
}

export async function getFundingRateHistoryNative(symbol: string, limit: number): Promise<FundingRateHistoryPoint[]> {
  return callProxy<FundingRateHistoryPoint[]>("/fapi/v1/fundingRate", { symbol: symbol.toUpperCase(), limit });
}

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

export async function getBulkFundingRatesNative(): Promise<PremiumIndexPoint[]> {
  return callProxy<PremiumIndexPoint[]>("/fapi/v1/premiumIndex", {});
}

export type KlineTuple = [number, string, string, string, string, string, number, string, number, string, string, string];

export async function getKlinesNative(symbol: string, interval: string, limit: number, startTime?: number, endTime?: number): Promise<KlineTuple[]> {
  return callProxy<KlineTuple[]>("/fapi/v1/klines", { symbol: symbol.toUpperCase(), interval, limit, startTime, endTime });
}

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

// Tanpa `symbol` param, Binance balikin ticker 24h SEMUA pair sekaligus --
// dipakai entryWatchlist.ts buat rank top-N by 24h quote volume tanpa 500+
// call per-symbol.
export async function getAllTicker24hrNative(): Promise<Ticker24hr[]> {
  return callProxy<Ticker24hr[]>("/fapi/v1/ticker/24hr", {});
}

export interface SpotPrice { symbol: string; price: string; }
export async function getSpotPrice(symbol: string): Promise<SpotPrice> {
  return callProxy<SpotPrice>("/api/v3/ticker/price", { symbol: symbol.toUpperCase() }, "spot");
}

export interface SpotTicker24hr {
  symbol: string; priceChange: string; priceChangePercent: string; weightedAvgPrice: string;
  openPrice: string; highPrice: string; lowPrice: string; lastPrice: string;
  bidPrice: string; askPrice: string; volume: string; quoteVolume: string; count: number;
}
export async function getSpotTicker24hr(symbol: string): Promise<SpotTicker24hr> {
  return callProxy<SpotTicker24hr>("/api/v3/ticker/24hr", { symbol: symbol.toUpperCase() }, "spot");
}

export interface SpotRollingTicker {
  symbol: string; priceChange: string; priceChangePercent: string; weightedAvgPrice: string;
  openPrice: string; highPrice: string; lowPrice: string; lastPrice: string;
  volume: string; quoteVolume: string;
  openTime: number; closeTime: number; firstId: number; lastId: number; count: number;
}
// Rolling-window ticker (/api/v3/ticker) -- arbitrary windowSize 1m-7d,
// beda dari /api/v3/ticker/24hr yang fixed 24 jam. Buat baca momentum
// spot di jendela 1h/4h dsb.
export async function getSpotRollingTicker(symbol: string, windowSize: string): Promise<SpotRollingTicker> {
  return callProxy<SpotRollingTicker>("/api/v3/ticker", { symbol: symbol.toUpperCase(), windowSize }, "spot");
}

export interface SpotBookTicker { symbol: string; bidPrice: string; bidQty: string; askPrice: string; askQty: string; }
export async function getSpotBookTicker(symbol: string): Promise<SpotBookTicker> {
  return callProxy<SpotBookTicker>("/api/v3/ticker/bookTicker", { symbol: symbol.toUpperCase() }, "spot");
}

export interface SpotOrderBook { lastUpdateId: number; bids: [string, string][]; asks: [string, string][]; }
export async function getSpotOrderBook(symbol: string, limit: number): Promise<SpotOrderBook> {
  return callProxy<SpotOrderBook>("/api/v3/depth", { symbol: symbol.toUpperCase(), limit }, "spot");
}

export async function getSpotKlinesNative(symbol: string, interval: string, limit: number, startTime?: number, endTime?: number): Promise<KlineTuple[]> {
  return callProxy<KlineTuple[]>("/api/v3/klines", { symbol: symbol.toUpperCase(), interval, limit, startTime, endTime }, "spot");
}

export async function getSpotAggTrades(symbol: string, limit: number): Promise<AggTrade[]> {
  return callProxy<AggTrade[]>("/api/v3/aggTrades", { symbol: symbol.toUpperCase(), limit }, "spot");
}

// Ranged/paginated variants -- expose startTime/endTime/fromId (native
// Binance aggTrades params, already supported by the endpoint but not by
// the limit-only wrappers above). Dipakai aggTradesPaginator.ts buat
// paginate mundur nutupin window durasi tertentu (analyze_cvd_divergence),
// beda dari getAggTrades/getSpotAggTrades yang cuma ambil N trade terakhir
// tanpa jaminan durasi waktu.
export interface AggTradesRangeParams {
  startTime?: number;
  endTime?: number;
  fromId?: number;
  limit: number;
}

export async function getAggTradesRange(symbol: string, params: AggTradesRangeParams): Promise<AggTrade[]> {
  return callProxy<AggTrade[]>("/fapi/v1/aggTrades", { symbol: symbol.toUpperCase(), ...params });
}

export async function getSpotAggTradesRange(symbol: string, params: AggTradesRangeParams): Promise<AggTrade[]> {
  return callProxy<AggTrade[]>("/api/v3/aggTrades", { symbol: symbol.toUpperCase(), ...params }, "spot");
}

export interface SpotAvgPrice { mins: number; price: string; }
export async function getSpotAvgPrice(symbol: string): Promise<SpotAvgPrice> {
  return callProxy<SpotAvgPrice>("/api/v3/avgPrice", { symbol: symbol.toUpperCase() }, "spot");
}

export interface SpotSymbolInfo {
  symbol: string; status: string; baseAsset: string; quoteAsset: string; isSpotTradingAllowed: boolean;
}
interface SpotExchangeInfoResponse { symbols: SpotSymbolInfo[]; }
export async function getSpotExchangeInfo(symbol: string): Promise<SpotSymbolInfo | null> {
  const data = await callProxy<SpotExchangeInfoResponse>("/api/v3/exchangeInfo", { symbol: symbol.toUpperCase() }, "spot");
  return data.symbols[0] ?? null;
}

export interface FuturesLotSizeFilter { filterType: "LOT_SIZE"; minQty: string; stepSize: string; }
export interface FuturesMinNotionalFilter { filterType: "MIN_NOTIONAL"; notional: string; }
type FuturesSymbolFilter = FuturesLotSizeFilter | FuturesMinNotionalFilter | { filterType: string; [key: string]: unknown };
export interface FuturesExchangeInfoSymbol { symbol: string; filters: FuturesSymbolFilter[]; status?: string; contractType?: string; quoteAsset?: string; }
export interface FuturesExchangeInfoResponse { symbols: FuturesExchangeInfoSymbol[]; }
export async function getFuturesExchangeInfo(symbol?: string): Promise<FuturesExchangeInfoResponse> {
  return callProxy<FuturesExchangeInfoResponse>("/fapi/v1/exchangeInfo", symbol ? { symbol: symbol.toUpperCase() } : {});
}

export interface AdlRiskEntry { symbol: string; adlRisk: string; updateTime: number; }
export async function getAdlRiskNative(symbol: string): Promise<AdlRiskEntry> {
  return callProxy<AdlRiskEntry>("/fapi/v1/symbolAdlRisk", { symbol: symbol.toUpperCase() });
}

export interface InsuranceFundAsset { asset: string; marginBalance: string; updateTime: number; }
export interface InsuranceFundBalance { symbols: string[]; assets: InsuranceFundAsset[]; }
export async function getInsuranceFundBalanceNative(symbol?: string): Promise<InsuranceFundBalance> {
  const data = await callProxy<Partial<InsuranceFundBalance> | null>(
    "/fapi/v1/insuranceBalance",
    symbol ? { symbol: symbol.toUpperCase() } : {},
  );
  return {
    symbols: Array.isArray(data?.symbols) ? data.symbols : [],
    assets: Array.isArray(data?.assets) ? data.assets : [],
  };
}

export async function getMarkPriceKlinesNative(symbol: string, interval: string, limit: number, startTime?: number, endTime?: number): Promise<KlineTuple[]> {
  return callProxy<KlineTuple[]>("/fapi/v1/markPriceKlines", { symbol: symbol.toUpperCase(), interval, limit, startTime, endTime });
}
export async function getIndexPriceKlinesNative(pair: string, interval: string, limit: number, startTime?: number, endTime?: number): Promise<KlineTuple[]> {
  return callProxy<KlineTuple[]>("/fapi/v1/indexPriceKlines", { pair: pair.toUpperCase(), interval, limit, startTime, endTime });
}
export async function getPremiumIndexKlinesNative(symbol: string, interval: string, limit: number, startTime?: number, endTime?: number): Promise<KlineTuple[]> {
  return callProxy<KlineTuple[]>("/fapi/v1/premiumIndexKlines", { symbol: symbol.toUpperCase(), interval, limit, startTime, endTime });
}
export async function getContinuousKlinesNative(pair: string, contractType: string, interval: string, limit: number, startTime?: number, endTime?: number): Promise<KlineTuple[]> {
  return callProxy<KlineTuple[]>("/fapi/v1/continuousKlines", { pair: pair.toUpperCase(), contractType, interval, limit, startTime, endTime });
}

export interface CompositeIndexBaseAsset { baseAsset: string; quoteAsset: string; weightInQuantity: string; weightInPercentage: string; }
export interface CompositeIndexInfo { symbol: string; time: number; component: string; baseAssetList: CompositeIndexBaseAsset[]; }
export async function getCompositeIndexInfoNative(symbol?: string): Promise<CompositeIndexInfo[]> {
  const data = await callProxy<CompositeIndexInfo | CompositeIndexInfo[]>("/fapi/v1/indexInfo", symbol ? { symbol: symbol.toUpperCase() } : {});
  return Array.isArray(data) ? data : [data];
}

export interface DeliveryPriceEntry { deliveryTime: number; deliveryPrice: number; }
export async function getQuarterlySettlementPriceNative(pair: string): Promise<DeliveryPriceEntry[]> {
  return callProxy<DeliveryPriceEntry[]>("/futures/data/delivery-price", { pair: pair.toUpperCase() });
}

export interface IndexConstituent { exchange: string; symbol: string; price: string; weight: string; }
export interface IndexConstituentsResponse { symbol: string; time: number; constituents: IndexConstituent[]; }
export async function getIndexConstituentsNative(symbol: string): Promise<IndexConstituentsResponse> {
  return callProxy<IndexConstituentsResponse>("/fapi/v1/constituents", { symbol: symbol.toUpperCase() });
}

/** Histori basis resmi index vs futures (GET /futures/data/basis). */
export interface BasisPoint {
  indexPrice: string;
  contractType: string;
  basisRate: string;
  futuresPrice: string;
  annualizedBasisRate: string;
  basis: string;
  pair: string;
  timestamp: number;
}

export async function getBasisNative(
  pair: string,
  contractType: string,
  period: string,
  limit: number,
): Promise<BasisPoint[]> {
  return callProxy<BasisPoint[]>("/futures/data/basis", {
    pair: pair.toUpperCase(),
    contractType,
    period,
    limit,
  });
}

// === NEW NATIVE EXTRAS (2026-08-22) ===

export interface RecentTrade {
  id: number;
  price: string;
  qty: string;
  quoteQty: string;
  time: number;
  isBuyerMaker: boolean;
}

export async function getRecentTrades(symbol: string, limit: number): Promise<RecentTrade[]> {
  return callProxy<RecentTrade[]>("/fapi/v1/trades", { symbol: symbol.toUpperCase(), limit });
}

export interface BookTicker {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  time?: number;
}

export async function getBookTicker(symbol?: string): Promise<BookTicker | BookTicker[]> {
  return callProxy<BookTicker | BookTicker[]>("/fapi/v1/ticker/bookTicker", symbol ? { symbol: symbol.toUpperCase() } : {});
}

export interface PriceTicker {
  symbol: string;
  price: string;
  time?: number;
}

export async function getPriceTicker(symbol?: string): Promise<PriceTicker | PriceTicker[]> {
  return callProxy<PriceTicker | PriceTicker[]>("/fapi/v2/ticker/price", symbol ? { symbol: symbol.toUpperCase() } : {});
}

export interface FundingInfoEntry {
  symbol: string;
  adjustedFundingRateCap?: string;
  adjustedFundingRateFloor?: string;
  fundingIntervalHours?: number;
  interestRate?: string;
  [key: string]: unknown;
}

export async function getFundingInfo(symbol?: string): Promise<FundingInfoEntry | FundingInfoEntry[]> {
  return callProxy<FundingInfoEntry | FundingInfoEntry[]>("/fapi/v1/fundingInfo", symbol ? { symbol: symbol.toUpperCase() } : {});
}

export async function getRpiDepth(symbol: string, limit: number): Promise<OrderBookDepth> {
  return callProxy<OrderBookDepth>("/fapi/v1/rpiDepth", { symbol: symbol.toUpperCase(), limit });
}

export async function getTradingSchedule(): Promise<unknown[]> {
  return callProxy<unknown[]>("/fapi/v1/tradingSchedule", {});
}

export interface ForceOrder {
  symbol: string;
  price: string;
  origQty: string;
  executedQty?: string;
  averagePrice?: string;
  status: string;
  time: number;
  side: string;
  [key: string]: unknown;
}

export async function getAllForceOrders(params: {
  symbol?: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
}): Promise<ForceOrder[]> {
  const q: Record<string, string | number | undefined> = {
    limit: params.limit,
    startTime: params.startTime,
    endTime: params.endTime,
  };
  if (params.symbol) q.symbol = params.symbol.toUpperCase();
  return callProxy<ForceOrder[]>("/fapi/v1/allForceOrders", q);
}

/** Raw Binance leverage-bracket payload (one entry per symbol). */
export interface LeverageBracketResponse {
  symbol: string;
  brackets: Array<{
    bracket: number;
    initialLeverage: number;
    notionalCap: number;
    notionalFloor: number;
    maintMarginRatio: number;
    cum: number;
  }>;
}

/**
 * SIGNED USER_DATA — requires `setBinanceApiCredentials`. HMAC on Worker;
 * proxy only forwards `x-binance-api-key`. Weight: 1.
 */
export async function getLeverageBracket(symbol: string): Promise<LeverageBracketResponse[]> {
  if (!binanceApiKey || !binanceApiSecret) {
    throw new BinanceProxyError(
      "BINANCE_API_KEY / BINANCE_API_SECRET belum diset. Jalankan `wrangler secret put` untuk keduanya.",
      undefined,
      "/fapi/v1/leverageBracket",
    );
  }
  const unsigned = {
    symbol: symbol.toUpperCase(),
    timestamp: Date.now(),
    recvWindow: 5000,
  };
  const signed = await signBinanceParams(binanceApiSecret, unsigned);
  return callProxy<LeverageBracketResponse[]>("/fapi/v1/leverageBracket", signed, {
    bypassCache: true,
    extraHeaders: { "x-binance-api-key": binanceApiKey },
  });
}

