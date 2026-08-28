// Watchlist entry-alert (entryAlertCron.ts) -- DINAMIS, dihitung ulang tiap
// run dari data live Binance (bukan hardcode kayak SNAPSHOT_WATCHLIST) supaya
// otomatis nyesuain listing/delisting/naik-turun peringkat tanpa maintenance
// manual daftar simbol.
import * as binanceProxy from "./binanceProxyClient.js";

// Dinaikkan bertahap 200 -> 300 -> 400 -> 500 (2026-08-25) buat lihat perilaku
// riil (self-throttle proxy, CPU time) sebelum nambah pacing eksplisit --
// lihat [[project_whalescope-mcp_status]] soal budget rate-limiter 780/menit.
// 300 sukses penuh (303 row D1, gak keputus). Universe total USDT-M
// perpetual TRADING ~527 pair (dicek 2026-08-25), jadi 400 masih < separuh.
//
// Diturunkan 500 -> 350 (2026-08-28), akar masalah cron `Canceled`: sample
// live 500-pair (2026-08-27, wrangler tail) makan wallTime 12m13.5s (~81%
// dari cap wall-clock 15 menit Cron Trigger) -- BUKAN CPU-time (cuma 11.86s,
// ~40% dari cap 30 detik CPU) atau subrequest count (limits.subrequests
// sudah dinaikkan 20000, lihat wrangler.toml) yang jadi bottleneck, tapi
// throughput call-per-menit: budget rate-limiter internal (rateLimiter.ts,
// MAX_REQUESTS_PER_WINDOW 1800/menit shared semua cron) sudah nyaris habis
// di worst-case overlap (~1800/1800), jadi ENTRY_ALERT_PACING_DELAY_MS/
// CONCURRENCY di entryAlertCron.ts TIDAK bisa dipercepat lagi tanpa
// menaikkan limiter itu (dan itu sendiri mepet ke limit asli Binance
// 2400/menit). Satu-satunya lever aman buat nambah buffer wall-clock adalah
// mengurangi total pair (dan karenanya total call) per tick -- 350 dipilih
// user supaya balik ke buffer sehat (~57% cap wall-clock, estimasi
// proporsional ~8.5 menit), coverage turun dari 500 tapi masih di atas 400
// yang sebelumnya sukses penuh tanpa Canceled.
//
// 350 -> 250 (2026-08-28): setelah migrasi Vercel -> VPS relay, SEMUA call
// Binance egress dari 1 IP (dulu tersebar di IP pool Vercel). IP VPS kena
// Binance HTTP 418 -1003 weight-ban -- lihat
// [[project_whalescope_vps_ip_ratelimit]]. entry-alert (pair terbanyak) lever
// terbesar; 250 masih cover ~semua pair yang cukup likuid, sambil kasih
// buffer wall-clock + weight. Dipasangkan dengan MAX_REQUESTS_PER_WINDOW
// 1800->1400 (rateLimiter.ts) + pacing 4000->5500ms (entryAlertCron.ts).
// Mitigasi sementara -- solusi proper = relay IP kedua (PROXY_URL_2).
export const ENTRY_WATCHLIST_SIZE = 250;

export async function getTopUsdtPerpetualWatchlist(): Promise<string[]> {
  const [exchangeInfo, tickers] = await Promise.all([
    binanceProxy.getFuturesExchangeInfo(),
    binanceProxy.getAllTicker24hrNative(),
  ]);

  const eligible = new Set(
    exchangeInfo.symbols
      .filter((s) => s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT")
      .map((s) => s.symbol),
  );

  return tickers
    .filter((t) => eligible.has(t.symbol))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, ENTRY_WATCHLIST_SIZE)
    .map((t) => t.symbol);
}
