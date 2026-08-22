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

const NO_CACHE_PATHS = new Set(["/fapi/v1/depth", "/fapi/v1/aggTrades", "/api/v3/depth", "/api/v3/aggTrades"]);

const SHORT_CACHE_PATHS = new Set([
  "/fapi/v1/premiumIndex",
  "/fapi/v1/openInterest",
  "/fapi/v1/ticker/24hr",
  "/api/v3/ticker/price",
  "/api/v3/ticker/24hr",
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
]);

interface ProxyEndpoint {
  url: string;
  secret: string;
}

let primaryEndpoint: ProxyEndpoint | undefined;
let secondaryEndpoint: ProxyEndpoint | undefined;
let directFallbackEnabled = true;

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

const FAILOVER_STATUS = new Set([401, 403, 429, 500, 502, 503, 504]);

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
    if (value !== undefined) url.searchParams.set(key, String(value));
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
  if (!primaryEndpoint) {
    throw new BinanceProxyError(
      "PROXY_URL atau PROXY_SECRET belum diset di worker. Jalankan `wrangler secret put PROXY_URL` dan `wrangler secret put PROXY_SECRET`.",
      undefined,
      path,
    );
  }
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
export interface FuturesExchangeInfoSymbol { symbol: string; filters: FuturesSymbolFilter[]; }
export interface FuturesExchangeInfoResponse { symbols: FuturesExchangeInfoSymbol[]; }
export async function getFuturesExchangeInfo(symbol: string): Promise<FuturesExchangeInfoResponse> {
  return callProxy<FuturesExchangeInfoResponse>("/fapi/v1/exchangeInfo", { symbol: symbol.toUpperCase() });
}

export interface AdlRiskEntry { symbol: string; adlRisk: string; updateTime: number; }
export async function getAdlRiskNative(symbol: string): Promise<AdlRiskEntry> {
  return callProxy<AdlRiskEntry>("/fapi/v1/symbolAdlRisk", { symbol: symbol.toUpperCase() });
}

export interface InsuranceFundAsset { asset: string; marginBalance: string; updateTime: number; }
export interface InsuranceFundBalance { symbols: string[]; assets: InsuranceFundAsset[]; }
export async function getInsuranceFundBalanceNative(symbol?: string): Promise<InsuranceFundBalance> {
  return callProxy<InsuranceFundBalance>("/fapi/v1/insuranceBalance", symbol ? { symbol: symbol.toUpperCase() } : {});
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
