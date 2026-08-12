// Self-throttle count-based sliding window buat call ke proxy Binance --
// proxy Vercel itu 1 IP shared, kalau kebanyakan call bisa kena rate limit
// Binance beneran (weight-based, 1200-2400/menit tergantung endpoint).
// SENGAJA count-based (bukan weight-based per-endpoint, itu butuh tabel
// weight per path, di luar scope). Threshold 200/menit jauh di bawah limit
// weight Binance -- buffer besar karena kita gak ngitung weight asli.
//
// KETERBATASAN JUJUR: worker ini STATELESS per-request (lihat komentar di
// src/index.ts) -- counter module-level di sini efektif SELAMA isolate
// yang sama dipakai ulang buat request beruntun (umum di Cloudflare, tapi
// BUKAN jaminan keras cross-isolate/cross-request). Ini proteksi
// best-effort, BUKAN hard global rate limiter.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 200;

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
