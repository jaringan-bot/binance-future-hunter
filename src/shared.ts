// Konstanta, schema, dan helper murni yang dipakai bareng di seluruh module
// src/tools/*.ts. Dipisah dari server.ts supaya createServer() cuma jadi
// wiring tipis (register semua tool module), bukan file 2000+ baris.
import { z } from "zod";
import * as coinalyze from "./coinalyzeClient.js";
import * as binanceProxy from "./binanceProxyClient.js";

// Watchlist yang di-snapshot Cron Trigger tiap 5 menit ke D1 (basis+funding+OI
// di market_snapshots, 6 skor sinyal MM di signal_history -- lihat scheduled()
// handler di src/index.ts + migrations/0001_init.sql).
//
// DIPERLUAS dari 10 -> 50 pair (2026-08-20), berdasarkan market cap. Analisis
// kapasitas sebelum perluasan:
// - D1 (5 juta write/hari): 50 pair x 7 write/symbol x 288 run/hari = 100.800
//   write/hari, 2% dari kuota -- BUKAN bottleneck.
// - Rate limiter proxy internal (rateLimiter.ts): worst-case 50 pair x ~11
//   call/symbol (cron 5-menit) + 50 call (WALL_SCAN_CRON, tiap 1 menit,
//   bertepatan di menit kelipatan 5) = ~600 call/menit -- MELEBIHI limit lama
//   200/menit, makanya MAX_REQUESTS_PER_WINDOW dinaikkan ke 780 bersamaan
//   dengan perubahan ini (lihat rateLimiter.ts untuk detail perhitungan).
//   Tetap jauh di bawah limit asli Binance (2400/menit IP-based, weight
//   bervariasi per endpoint).
// - Vercel Hobby Active CPU (4 jam/bulan, diverifikasi dari dashboard usage
//   riil, BUKAN dari artikel pihak ketiga): 10 pair terpakai ~35 menit/bulan
//   (~15% kuota) -- proyeksi linear 50 pair ~175 menit (~73% kuota). Aman,
//   tapi headroom tidak longgar -- monitor usage Vercel kalau traffic lain
//   ikut naik.
//
// Semua 50 simbol divalidasi PENUH (50/50) listing aktif di Binance Futures
// via binance_get_funding_rate (native premiumIndex) sebelum ditambahkan --
// tidak ada "Invalid symbol" untuk simbol manapun di daftar final. Kalau
// salah satu di-delist Binance di masa depan, cron akan log error per-symbol
// (try/catch sudah ada di scheduled() handler, satu symbol gagal tidak
// menggagalkan yang lain) -- tapi symbol yang delisted tetap perlu dihapus
// manual dari daftar ini saat diketahui, supaya tidak terus gagal tiap
// siklus tanpa guna.
export const SNAPSHOT_WATCHLIST = [
  // --- 10 pair asli (sudah ada sebelumnya) ---
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "LTCUSDT",
  // --- 40 tambahan, urutan market cap (per 2026-08-20, tervalidasi 50/50 ke Binance Futures) ---
  "TRXUSDT",
  "SUIUSDT",
  "HYPEUSDT",
  "ZECUSDT",
  "NEARUSDT",
  "UNIUSDT",
  "BCHUSDT",
  "TAOUSDT",
  "WLDUSDT",
  "AAVEUSDT",
  "XMRUSDT",
  "ONDOUSDT",
  "FILUSDT",
  "XLMUSDT",
  "DOTUSDT",
  "ENAUSDT",
  "1000PEPEUSDT",
  "PUMPUSDT",
  "ASTERUSDT",
  "WLFIUSDT",
  "PAXGUSDT",
  "TRUMPUSDT",
  "XAUTUSDT",
  "ETCUSDT",
  "ATOMUSDT",
  "ICPUSDT",
  "APTUSDT",
  "ARBUSDT",
  "OPUSDT",
  "INJUSDT",
  "SEIUSDT",
  "RUNEUSDT",
  "TIAUSDT",
  "STXUSDT",
  "IMXUSDT",
  "GALAUSDT",
  "SANDUSDT",
  "MANAUSDT",
  "FTMUSDT", // funding 0.0000% saat validasi -- volume kemungkinan tipis, monitor
  "ALGOUSDT",
] as const;

export const PERIOD_ENUM = [
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "1d",
] as const;

// Coinalyze tidak punya interval "3m" atau "8h" — dua itu di-drop dari enum ini.
// (Binance native klines/fundingRate mendukung superset ini juga, jadi tetap
// aman dipakai untuk kedua sumber.)
export const KLINE_INTERVAL_ENUM = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "1d",
] as const;

// Semua endpoint /futures/data/* Binance (topLongShortAccountRatio,
// topLongShortPositionRatio, globalLongShortAccountRatio, openInterestHist,
// takerlongshortRatio) cuma support subset period ini (beda dari Coinalyze
// yang lebih fleksibel untuk endpoint yang masih dia sumberi).
export const FUTURES_DATA_PERIOD_ENUM = [
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "1d",
] as const;

// Batasan divalidasi ke data riil (exchangeInfo Binance Futures, 2026-08-12):
// simbol terpanjang saat ini 17 char (CSOPSKHYNIX2LUSDT), jadi max 20 masih
// ada headroom. Regex sengaja izinin underscore -- kontrak quarterly/dated
// (misal BTCUSDT_260925) pakai underscore, bukan cuma alfanumerik murni.
// Tanpa batas ini, symbol dipakai langsung sebagai bagian KV key
// (`threshold:${symbol}`, `basis_history:${symbol}`) -- string sangat
// panjang bisa lewat limit key KV (512 byte) tanpa pesan error yang jelas.
export const symbolSchema = z
  .string()
  .toUpperCase()
  .min(1, "Symbol tidak boleh kosong")
  .max(20, "Symbol Binance Futures maksimal 20 karakter (simbol terpanjang saat ini 17 karakter)")
  .regex(/^[A-Z0-9_]+$/, "Symbol cuma boleh huruf, angka, dan underscore (contoh: BTCUSDT, BTCUSDT_260925)")
  .describe(
    "Simbol pair Binance Futures, contoh: BTCUSDT, ETHUSDT. Harus pair perpetual yang terdaftar di Binance USDS-M Futures.",
  );

// Pair underlying TANPA suffix margin-asset (mis. "BTCUSD", bukan "BTCUSDT")
// -- dipakai endpoint yang basisnya kontrak dated/continuous (indexPriceKlines,
// continuousKlines, delivery-price), beda dari symbolSchema yang untuk pair
// trading langsung. Regex sama longgarnya dengan symbolSchema (underscore
// diizinkan untuk notasi dated contract seperti BTCUSD_260925).
export const pairSchema = z
  .string()
  .toUpperCase()
  .min(1, "Pair tidak boleh kosong")
  .max(20, "Pair Binance Futures maksimal 20 karakter")
  .regex(/^[A-Z0-9_]+$/, "Pair cuma boleh huruf, angka, dan underscore (contoh: BTCUSD, BTCUSD_260925)")
  .describe(
    "Pair underlying Binance Futures TANPA suffix margin-asset, contoh: BTCUSD (bukan BTCUSDT). Dipakai untuk kontrak dated/continuous, beda dari symbol pair trading biasa.",
  );

// Tipe kontrak untuk continuousKlines -- PERPETUAL tidak punya expiry,
// CURRENT_QUARTER/NEXT_QUARTER adalah kontrak dated yang delivery tiap kuartal.
export const CONTRACT_TYPE_ENUM = ["PERPETUAL", "CURRENT_QUARTER", "NEXT_QUARTER"] as const;

// Parse ISO 8601 datetime string ke epoch ms. Dipakai untuk startTime/endTime
// klines (Futures & Spot) supaya backtest bisa narik histori jauh ke belakang,
// bukan cuma N candle terakhir.
export function parseTimeParam(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(
      `${label} tidak valid: "${value}" bukan format tanggal yang bisa di-parse. Gunakan ISO 8601, contoh: "2026-07-01T00:00:00Z".`,
    );
  }
  return ms;
}

// Konvensi bersama untuk semua tool array/history-shaped (klines, agg_trades,
// order_book_depth, open_interest_history, funding_rate_history, dst) --
// default "summary" (metrik turunan + <=5-10 poin terbaru, BUKAN array
// penuh), "full" balikin array/level mentah lengkap seperti behavior lama.
// Ini SATU-SATUNYA perubahan default-behavior yang disengaja di seluruh
// tool: nama param lama (mis. includeCandles) tetap ada, tidak dihapus/
// diganti nama -- lihat docs/tool_response_reference.md untuk daftar lengkap
// tool yang kena + cara balik ke perilaku lama (detail: "full").
export const detailParam = z
  .enum(["summary", "full"])
  .optional()
  .default("summary")
  .describe(
    "'summary' (default): metrik turunan + <=10 poin terbaru saja, HEMAT TOKEN. 'full': array/level mentah lengkap seperti sebelumnya. Lihat docs/tool_response_reference.md.",
  );

// Buang key bernilai null/undefined dari object structuredContent sebelum
// di-return -- dipakai tool composite (§B) supaya field yang gak relevan
// (mis. finalRun: null waktu leverage direject) gak ikut nge-bloat payload.
// Cuma shallow (1 level) -- struktur nested tetap dipertahankan apa adanya,
// caller yang panggil rekursif kalau perlu.
export function dropNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function errorResult(err: unknown) {
  const message =
    err instanceof coinalyze.CoinalyzeApiError
      ? err.message
      : err instanceof binanceProxy.BinanceProxyError
        ? err.message
        : `Terjadi error tak terduga: ${(err as Error)?.message ?? String(err)}`;
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

// RV = sqrt(mean(log_return^2)) * sqrt(periode/tahun) — realized volatility
// standar dari log-return close-to-close.
export function computeRealizedVolatility(
  closes: number[],
  periodsPerYear: number,
): { periodPct: number; annualizedPct: number } {
  if (closes.length < 2) return { periodPct: 0, annualizedPct: 0 };
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const sumSq = logReturns.reduce((acc, r) => acc + r * r, 0);
  const periodVol = Math.sqrt(sumSq / logReturns.length);
  const annualizedVol = periodVol * Math.sqrt(periodsPerYear);
  return { periodPct: periodVol * 100, annualizedPct: annualizedVol * 100 };
}
