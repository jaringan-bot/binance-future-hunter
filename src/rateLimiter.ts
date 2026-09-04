// Self-throttle count-based sliding window buat call ke proxy Binance --
// proxy Vercel itu 1 IP shared, kalau kebanyakan call bisa kena rate limit
// Binance beneran (weight-based, 1200-2400/menit tergantung endpoint).
// SENGAJA count-based (bukan weight-based per-endpoint, itu butuh tabel
// weight per path, di luar scope).
//
// Dinaikkan dari 200 -> 780/menit (2026-08-20) bersamaan dengan perluasan
// SNAPSHOT_WATCHLIST 10->50 pair (shared.ts). Perhitungan worst-case saat itu:
// - Cron 5-menit: 50 pair x ~11 call/symbol = ~550 call.
// - WALL_SCAN_CRON (cron TERPISAH, tiap 1 menit, 1 call/symbol via
//   getOrderBookDepth): 50 call/menit.
// - Pada menit kelipatan 5, kedua cron bisa trigger di window yang sama
//   (Cloudflare tidak menjamin urutan/spacing antar Cron Trigger berbeda) --
//   worst case realistis: 550 + 50 = ~600 call dalam 60 detik.
// - 780 memberi buffer ~30% di atas worst-case 600 yang sudah diketahui.
//
// Dinaikkan lagi 780 -> 1800/menit (2026-08-25), setelah ENTRY_ALERT_CRON
// (entryAlertCron.ts, watchlist 400 pair naik dari 200) terbukti live lewat
// `wrangler tail` bikin 355/400 pair (89%) gagal 1 tick karena limiter 780
// SANGAT kekecilan buat beban barunya -- 780 itu gak pernah menghitung cron
// ini sama sekali. Perhitungan worst-case baru:
// - ENTRY_ALERT_CRON sendiri (setelah dipacing, lihat ENTRY_ALERT_PACING_DELAY_MS
//   di entryAlertCron.ts): ditarget ~1.100-1.200 call/menit, BUKAN burst
//   ~6.800 call (400 pair x sampai 17 call/symbol worst-case) dalam 60 detik --
//   itu sendiri sudah jauh ngelewatin limit asli Binance, gak ada limiter
//   internal yang bisa "menampungnya" dengan aman, satu-satunya cara aman
//   adalah menyebar bebannya, bukan menaikkan limiter sampai setinggi itu.
// - WALL_SCAN 50/menit (selalu tumpang tindih, tiap menit) + SNAPSHOT 550/menit
//   (kadang tumpang tindih, kelipatan 5 menit) tetap seperti sebelumnya.
// - Worst-case gabungan: ~1.200 + 50 + 550 = ~1.800 call/60 detik.
// Batas ini TETAP jauh di bawah limit asli Binance (2400/menit IP-based) --
// rasio buffer ~1.33x (1800 vs 2400). Lebih ketat dari rasio 780 vs 2400
// (~3.1x) karena beban real sekarang jauh lebih besar -- kalau butuh naikkan
// watchlist ENTRY_ALERT lebih jauh lagi, pertimbangkan turunkan target
// throughput entry-alert (naikkan ENTRY_ALERT_PACING_DELAY_MS) dulu sebelum
// naikkan angka ini lagi, supaya buffer ke limit asli Binance gak makin
// mepet.
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
// 1800 -> 1400 (2026-08-28): count-based limit 1800 x avg weight ~1.5 =
// ~2700 weight/menit, DI ATAS limit asli Binance 2400 weight/menit -- plus
// counter ini per-isolate best-effort (bukan global), jadi real cross-isolate
// bisa lebih tinggi lagi. IP VPS relay tunggal kena 418 -1003 weight-ban
// (2026-08-28, lihat [[project_whalescope_vps_ip_ratelimit]]). 1400 x ~1.5 =
// ~2100 weight -- buffer nyata ke 2400. Dipasangkan dengan ENTRY_WATCHLIST_SIZE
// 350->250 + pacing 5500ms supaya real load turun di bawah 1400 dan wall-clock
// tetap aman.
//
// 1400 -> 1800 (2026-09-03): relay IP kedua (PROXY_URL_2, Oracle) live --
// weight Binance round-robin ~50/50. Per-IP efektif ~900 count/menit (1800/2).
// 1800 x ~1.5 = ~2700 weight dibagi 2 IP = ~1350 weight/IP -- well under
// batas 2400/menit per-IP Binance. Dipasangkan ENTRY_WATCHLIST_SIZE 250->350.
export const MAX_REQUESTS_PER_WINDOW = 1800;

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
