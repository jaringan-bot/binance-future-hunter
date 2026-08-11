// Konstanta, schema, dan helper murni yang dipakai bareng di seluruh module
// src/tools/*.ts. Dipisah dari server.ts supaya createServer() cuma jadi
// wiring tipis (register semua tool module), bukan file 2000+ baris.
import { z } from "zod";
import * as coinalyze from "./coinalyzeClient.js";
import * as binanceProxy from "./binanceProxyClient.js";

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

export const symbolSchema = z
  .string()
  .toUpperCase()
  .describe(
    "Simbol pair Binance Futures, contoh: BTCUSDT, ETHUSDT. Harus pair perpetual yang terdaftar di Binance USDS-M Futures.",
  );

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
