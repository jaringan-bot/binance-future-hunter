// Self-throttle count-based sliding window buat call ke proxy Binance --
// proxy Vercel itu 1 IP shared, kalau kebanyakan call bisa kena rate limit
// Binance beneran (weight-based, 1200-2400/menit tergantung endpoint).
// SENGAJA count-based (bukan weight-based per-endpoint, itu butuh tabel
// weight per path, di luar scope).
//
// Dinaikkan dari 200 -> 780/menit (2026-08-20) bersamaan dengan perluasan
// SNAPSHOT_WATCHLIST 10->50 pair (shared.ts). Perhitungan worst-case:
// - Cron 5-menit: 50 pair x ~11 call/symbol = ~550 call.
// - WALL_SCAN_CRON (cron TERPISAH, tiap 1 menit, 1 call/symbol via
//   getOrderBookDepth): 50 call/menit.
// - Pada menit kelipatan 5, kedua cron bisa trigger di window yang sama
//   (Cloudflare tidak menjamin urutan/spacing antar Cron Trigger berbeda) --
//   worst case realistis: 550 + 50 = ~600 call dalam 60 detik.
// - 780 memberi buffer ~30% di atas worst-case 600 yang sudah diketahui.
// Batas ini TETAP jauh di bawah limit asli Binance (2400/menit IP-based) --
// rasio buffer turun dari ~12x (200 vs 2400) jadi ~3.1x (780 vs 2400),
// masih buffer wajar, bukan mepet ke limit asli.
//
// KETERBATASAN JUJUR: worker ini STATELESS per-request (lihat komentar di
// src/index.ts) -- counter module-level di sini efektif SELAMA isolate
// yang sama dipakai ulang buat request beruntun (umum di Cloudflare, tapi
// BUKAN jaminan keras cross-isolate/cross-request). Ini proteksi
// best-effort, BUKAN hard global rate limiter.
const WINDOW_MS = 60_000;
// Exported so rateLimiter.test.ts asserts against this value instead of a
// hardcoded copy -- a hardcoded copy is what let the test silently desync
// from this constant when it was raised 200 -> 780 (see below).
export const MAX_REQUESTS_PER_WINDOW = 780;

let timestamps: number[] = [];

export class RateLimitError extends Error {
  constructor(count: number) {
    super(
      `Self-throttle: ${count} request ke proxy Binance dalam 60 detik terakhir (limit internal ${MAX_REQUESTS_PER_WINDOW}/menit) -- tunggu sebentar sebelum lanjut. Ini proteksi best-effort per-isolate, bukan penghitung global yang presisi.`,
    );
    this.name = "RateLimitError";
  }
}

// Dipanggil di awal callProxy() (binanceProxyClient.ts) SEBELUM coba
// primary/secondary endpoint -- cuma Binance, bukan Bybit/OKX/Hyperliquid
// (masing-masing punya limit & IP sendiri, gak lewat proxy shared).
export function checkAndRecordRequest(now: number = Date.now()): void {
  timestamps = timestamps.filter((t) => now - t < WINDOW_MS);
  if (timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    throw new RateLimitError(timestamps.length);
  }
  timestamps.push(now);
}

export function resetRateLimiter(): void {
  timestamps = [];
}
