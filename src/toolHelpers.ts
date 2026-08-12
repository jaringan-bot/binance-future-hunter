// Logika murni yang identik antara tool Futures dan versi Spot-nya
// (binance_get_agg_trades vs binance_get_spot_agg_trades, binance_get_klines
// vs binance_get_spot_klines, plus dipakai lagi di binance_analyze_pair).
// Diekstrak ke sini supaya perubahan bug/formula cukup di satu tempat, dan
// bisa di-unit-test terpisah dari 25 tool handler.
import type { AggTrade, KlineTuple } from "./binanceProxyClient.js";

export interface CvdSummary {
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  buyPct: number;
  cvd: number;
}

// m: true = buyer adalah maker -> artinya SELLER yang agresif (taker sell).
// m: false = buyer adalah taker -> artinya BUYER yang agresif (taker buy).
export function computeCvdFromTrades(trades: AggTrade[]): CvdSummary {
  let buyVolume = 0;
  let sellVolume = 0;
  for (const t of trades) {
    const qty = parseFloat(t.q);
    if (t.m) sellVolume += qty;
    else buyVolume += qty;
  }
  const totalVolume = buyVolume + sellVolume;
  const buyPct = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 0;
  const cvd = buyVolume - sellVolume; // Cumulative Volume Delta sederhana untuk window ini
  return { buyVolume, sellVolume, totalVolume, buyPct, cvd };
}

// Dipakai tool histori (open interest, long/short ratio, top trader ratio,
// funding rate history, taker volume ratio, liquidation history) buat batasi
// jumlah baris yang di-print ke teks -- tanpa ini, panggilan limit besar
// (misal 500 buat kalibrasi baseline ala docs/mm_detection_framework.md
// Section 4.2) bisa nge-dump puluhan KB tabel ke context Claude. Summary
// stats (avg/tren/dominance) tetap harus dihitung dari SEMUA data yang
// di-fetch (bukan cuma `shown`), cuma tampilan tabel yang dipotong.
export interface TruncatedRows<T> {
  shown: T[];
  totalCount: number;
  truncated: boolean;
}

export function truncateRows<T>(rows: T[], max = 15): TruncatedRows<T> {
  const totalCount = rows.length;
  const truncated = totalCount > max;
  const shown = truncated ? rows.slice(-max) : rows;
  return { shown, totalCount, truncated };
}

export type PriceBias = "BULLISH" | "BEARISH" | "SIDEWAYS";

export function classifyPriceBias(changePct: number): PriceBias {
  return changePct > 1 ? "BULLISH" : changePct < -1 ? "BEARISH" : "SIDEWAYS";
}

export interface KlineCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KlinesSummary {
  candles: KlineCandle[];
  closes: number[];
  firstClose: number;
  lastClose: number;
  changePct: number;
  bias: PriceBias;
  swingHigh: number;
  swingLow: number;
}

// Format Binance native: [openTime, open, high, low, close, volume, closeTime, ...]
export function summarizeKlines(raw: KlineTuple[]): KlinesSummary {
  const candles: KlineCandle[] = raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const firstClose = closes[0] ?? 0;
  const lastClose = closes[closes.length - 1] ?? 0;
  const changePct = closes.length >= 2 && firstClose !== 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;

  return {
    candles,
    closes,
    firstClose,
    lastClose,
    changePct,
    bias: classifyPriceBias(changePct),
    swingHigh: highs.length ? Math.max(...highs) : 0,
    swingLow: lows.length ? Math.min(...lows) : 0,
  };
}
