// Cron scan wall kandidat -- dipanggil dari scheduled() (index.ts) di Cron
// Trigger terpisah tiap 1 menit (beda dari cron mm_activity/market_snapshots
// yang tiap 5 menit). Ekstrak jadi fungsi terpisah (pola sama seperti
// computeMmSignals di detectMmActivity.ts) supaya gampang diuji/dipanggil.
//
// Ambang 2x median DI SINI cuma buat storage/tracking (supaya cukup data
// buat deteksi persistence) -- BUKAN ambang 3x yang dipakai keputusan
// trading di tempat lain (docs/mm_detection_framework.md).
import * as binanceProxy from "../binanceProxyClient.js";
import { insertWallCandidates, type WallCandidateRow } from "../d1Client.js";

// Nama eksplisit "STORAGE" (bukan cuma WALL_MEDIAN_MULTIPLIER) supaya tidak
// tertukar dengan DEFAULT_MIN_WALL_MULTIPLE (3.0) di gridWallFinder.ts --
// keduanya BUKAN varian dari formula yang sama (2x median-qty-per-sisi di
// sini vs 3x mean-notional-in-price-band di sana), jadi tidak "diselaraskan"
// jadi satu angka, cuma diberi nama yang tidak ambigu.
const WALL_STORAGE_MEDIAN_MULTIPLIER = 2;
const ORDER_BOOK_DEPTH_LIMIT = 20;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Cari level dengan qty >= 2x median qty dalam satu sisi (bid atau ask --
// caller panggil terpisah per sisi, skala size bid vs ask bisa beda jauh).
export function findWallCandidates(
  levels: [string, string][],
): { price: number; qty: number; medianRatio: number }[] {
  const qtys = levels.map(([, q]) => parseFloat(q));
  const med = median(qtys);
  if (med === 0) return [];

  return levels
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .filter((l) => l.qty >= WALL_STORAGE_MEDIAN_MULTIPLIER * med)
    .map((l) => ({ ...l, medianRatio: l.qty / med }));
}

export async function scanWallCandidates(symbol: string): Promise<void> {
  const depth = await binanceProxy.getOrderBookDepth(symbol, ORDER_BOOK_DEPTH_LIMIT);
  const capturedAt = Date.now();

  const bidCandidates = findWallCandidates(depth.bids);
  const askCandidates = findWallCandidates(depth.asks);

  const rows: WallCandidateRow[] = [
    ...bidCandidates.map((c) => ({ symbol, capturedAt, side: "bid" as const, ...c })),
    ...askCandidates.map((c) => ({ symbol, capturedAt, side: "ask" as const, ...c })),
  ];

  await insertWallCandidates(rows);
}
