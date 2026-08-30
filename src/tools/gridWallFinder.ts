// gridWallFinder.ts -- Order Book Wall placement untuk Grid Bot Smart Money
// Adapter V2 (src/cron/gridSmartMoneyAdapter.ts). Menempatkan upper/lower bound
// grid pada KLUSTER WALL LIKUIDITAS TEBAL (institutional limit orders), BUKAN
// High/Low +- ATR statis.
//
// SPEC PENTING (revisi Phase 2): TIDAK ADA fallback ATR. Kalau tidak ada wall
// yang lolos threshold/constraint -> return null (caller memetakan ke
// GRID_NO_TRADE "No significant liquidity walls found").
//
// computeOrderBookWalls() = inti MURNI (testable tanpa fetch). findOrderBookWalls()
// = wrapper async: fetch depth (3-menit TTL cache) + validasi exchange_info.
import * as binanceProxy from "../binanceProxyClient.js";
import type { OrderBookDepth } from "../binanceProxyClient.js";

export const DEFAULT_MIN_WALL_MULTIPLE = 3.0; // Notional >= 3.0 * meanDepth ...
export const DEFAULT_ABS_FLOOR_USD = 100_000; // ... atau minimal $100k (mana yang lebih besar)
export const MIN_DISTANCE_PCT = 2.0; // wall paling dekat 2% dari harga
export const MAX_RANGE_CAP_PCT = 10.0; // window pencarian di-cap 10%
export const ATR_RANGE_MULT = 1.5; // window = 1.5 * ATR14%
export const MEAN_BAND_PCT = 10.0; // meanDepthNotional dihitung dari level dalam +-10%
export const TARGET_STEP_PCT = 0.75; // heuristik gridCount (sama dengan gridBoundEngine)
export const MAX_GRID_COUNT = 150;
export const DEPTH_CACHE_TTL_MS = 3 * 60 * 1000; // 3 menit
export const WALL_DEPTH_LIMIT = 1000; // depth dalam supaya jangkau +-10%

export interface OrderBookWall {
  price: number;
  qty: number;
  notionalUsd: number;
  distancePct: number; // jarak absolut dari currentPrice, persen
}

export interface GridWallResult {
  meanDepthNotional: number;
  wallThreshold: number;
  lowerBound: number;
  upperBound: number;
  lowerWall: OrderBookWall;
  upperWall: OrderBookWall;
  estimatedGridCount: number;
  searchRangePct: { lower: number; upper: number };
}

export interface GridWallOptions {
  /** ATR14 dalam PERSEN dari harga ((ATR/price)*100) -- window pencarian ATR-aware. */
  atr14Pct: number;
  minWallMultiple?: number;
  absFloorUsd?: number;
  tickSize?: number; // dari exchange_info: bound range harus >= tickSize
}

function toLevels(raw: [string, string][]): { price: number; qty: number; notional: number }[] {
  return raw
    .map(([p, q]) => {
      const price = parseFloat(p);
      const qty = parseFloat(q);
      return { price, qty, notional: price * qty };
    })
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.qty) && l.qty > 0);
}

/**
 * Inti murni: cari wall bid/ask tebal. Return null kalau salah satu sisi tidak
 * ada wall lolos threshold, atau constraint (gridCount/tickSize) gagal.
 */
export function computeOrderBookWalls(
  book: OrderBookDepth,
  currentPrice: number,
  opts: GridWallOptions,
): GridWallResult | null {
  if (!(currentPrice > 0)) return null;
  const minMult = opts.minWallMultiple ?? DEFAULT_MIN_WALL_MULTIPLE;
  const absFloor = opts.absFloorUsd ?? DEFAULT_ABS_FLOOR_USD;

  const bids = toLevels(book.bids ?? []);
  const asks = toLevels(book.asks ?? []);

  // meanDepthNotional dari level dalam +-10%.
  const inBand = [...bids, ...asks].filter(
    (l) => Math.abs((l.price - currentPrice) / currentPrice) * 100 <= MEAN_BAND_PCT,
  );
  if (inBand.length === 0) return null;
  const meanDepthNotional = inBand.reduce((s, l) => s + l.notional, 0) / inBand.length;
  const wallThreshold = Math.max(minMult * meanDepthNotional, absFloor);

  // Window pencarian ATR-aware: [2%, clamp(1.5*ATR%, 2, 10)].
  // lowerRange / upperRange dihitung terpisah per spec (saat ini formula sama).
  const lowerRange = Math.min(MAX_RANGE_CAP_PCT, Math.max(MIN_DISTANCE_PCT, ATR_RANGE_MULT * opts.atr14Pct));
  const upperRange = Math.min(MAX_RANGE_CAP_PCT, Math.max(MIN_DISTANCE_PCT, ATR_RANGE_MULT * opts.atr14Pct));

  const nearestWall = (
    levels: { price: number; qty: number; notional: number }[],
    dir: "below" | "above",
    rangeCap: number,
  ): OrderBookWall | null => {
    const cands = levels
      .filter((l) => (dir === "below" ? l.price < currentPrice : l.price > currentPrice))
      .map((l) => ({
        ...l,
        distancePct: (Math.abs(l.price - currentPrice) / currentPrice) * 100,
      }))
      .filter(
        (l) =>
          l.distancePct >= MIN_DISTANCE_PCT &&
          l.distancePct <= rangeCap &&
          l.notional >= wallThreshold,
      )
      .sort((a, b) => a.distancePct - b.distancePct);
    return cands.length
      ? {
          price: cands[0].price,
          qty: cands[0].qty,
          notionalUsd: cands[0].notional,
          distancePct: cands[0].distancePct,
        }
      : null;
  };

  const lowerWall = nearestWall(bids, "below", lowerRange);
  const upperWall = nearestWall(asks, "above", upperRange);
  if (!lowerWall || !upperWall) return null;

  const lowerBound = lowerWall.price;
  const upperBound = upperWall.price;

  // Constraint: range >= tickSize (kalau tersedia) & estimasi gridCount <= 150.
  if (opts.tickSize && opts.tickSize > 0 && upperBound - lowerBound < opts.tickSize) return null;
  const rangePercentage = ((upperBound - lowerBound) / lowerBound) * 100;
  const estimatedGridCount = Math.max(1, Math.round(rangePercentage / TARGET_STEP_PCT));
  if (estimatedGridCount > MAX_GRID_COUNT) return null;

  return {
    meanDepthNotional,
    wallThreshold,
    lowerBound,
    upperBound,
    lowerWall,
    upperWall,
    estimatedGridCount,
    searchRangePct: { lower: lowerRange, upper: upperRange },
  };
}

// ── Fetch wrapper dengan TTL cache 3 menit (hemat subrequest) ──
interface CachedBook {
  ts: number;
  book: OrderBookDepth;
}
const depthCache = new Map<string, CachedBook>();

/** Test-only: kosongkan cache depth. */
export function _clearWallFinderCache(): void {
  depthCache.clear();
}

async function getCachedDepth(symbol: string, now: number): Promise<OrderBookDepth> {
  const key = symbol.toUpperCase();
  const hit = depthCache.get(key);
  if (hit && now - hit.ts < DEPTH_CACHE_TTL_MS) return hit.book;
  const book = await binanceProxy.getOrderBookDepth(symbol, WALL_DEPTH_LIMIT);
  depthCache.set(key, { ts: now, book });
  return book;
}

function extractTickSize(symbolInfo: binanceProxy.FuturesExchangeInfoSymbol | undefined): number | undefined {
  const f = symbolInfo?.filters?.find((x) => x.filterType === "PRICE_FILTER") as
    | { tickSize?: string }
    | undefined;
  const t = f?.tickSize ? parseFloat(f.tickSize) : NaN;
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

/**
 * Async: fetch order book (cached 3 menit) + exchange_info (tickSize) lalu
 * jalankan computeOrderBookWalls. Return null kalau tidak ada wall / constraint gagal.
 *
 * `atr14Pct` diperlukan untuk ATR-aware search window (spec: 1.5 * ATR_14_pct,
 * di-clamp ke [2, 10]). Caller hitung dari ATR absolut / currentPrice * 100.
 */
export async function findOrderBookWalls(
  symbol: string,
  currentPrice: number,
  atr14Pct: number,
  now: number = Date.now(),
): Promise<GridWallResult | null> {
  const normalized = symbol.toUpperCase();
  const [book, exInfo] = await Promise.all([
    getCachedDepth(normalized, now),
    binanceProxy.getFuturesExchangeInfo(normalized).catch(() => null),
  ]);
  // /fapi/v1/exchangeInfo mengabaikan query `symbol` -- filter di client
  // (sama pola fetchSymbolTradingRules), JANGAN ambil symbols[0].
  const symbolInfo = exInfo?.symbols?.find((s) => s.symbol === normalized);
  const tickSize = extractTickSize(symbolInfo);
  return computeOrderBookWalls(book, currentPrice, { atr14Pct, tickSize });
}
