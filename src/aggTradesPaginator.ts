// fetchAggTradesForWindow -- production port of the fetchAllAggTrades
// helper used throughout the CVD probe series (Probes #1-#5, 2026-08-26),
// which previously only existed in throwaway scratchpad scripts. Paginates
// /fapi/v1/aggTrades or /api/v3/aggTrades BACKWARD from "now" (via fromId
// continuation, same as the probes) until either the target window is
// fully covered or maxPages is hit.
//
// NOT wired into fullPipeline.ts, entryAlertCron.ts, or any skill file yet
// -- standalone, tested function only. Integration (and the real per-symbol
// cost this implies for the entry-alert cron) is a separate task, because
// the audit that led to building this found a genuine continuous 60-minute
// window on a liquid pair needs FAR more pages than a naive "2 extra
// fetches" estimate assumed (measured: BTCUSDT futures ~115 pages, spot
// ~82 pages for 60 minutes, Probe #5 h=0.1) -- see docs/mm_detection_framework.md.
import { getAggTradesRange, getSpotAggTradesRange, type AggTrade } from "./binanceProxyClient.js";
import { RateLimitError } from "./rateLimiter.js";

export interface PaginatedTradesResult {
  trades: AggTrade[];
  pagesUsed: number;
  windowCoveredMs: number;
  insufficientData: boolean;
}

// Backoff kalau kena RateLimitError (rateLimiter.ts throw SYNCHRONOUS,
// bukan auto-wait) -- limiter shared 1.800/menit dipakai bareng cron lain
// (snapshot, wall-scan), jadi paginator ini WAJIB nunggu giliran, BUKAN
// bypass checkAndRecordRequest() (yang otomatis kepanggil tiap callProxy()
// lewat getAggTradesRange/getSpotAggTradesRange -- gak ada jalan pintas di
// sini, paginator cuma manggil fungsi yang sama dipakai tool lain).
// 250ms x maks 5 retry = 1.25s total tunggu per page sebelum nyerah --
// cukup buat nunggu window 60 detik limiter bebas lagi tanpa bikin satu
// page nge-hang lama kalau limiter emang lagi penuh terus-menerus.
const RATE_LIMIT_BACKOFF_MS = 250;
const RATE_LIMIT_MAX_RETRIES = 5;

// Cap default: 150 halaman. BUKAN angka bulat sembarang -- 1.3x margin di
// atas jumlah halaman TERBANYAK yang benar-benar teramati di probe series
// (BTCUSDT futures, window 60 menit, Probe #5 h=0.1: 115 halaman; spot
// pair yang sama: 82 halaman). Rasio margin 1.3x SAMA dengan konvensi yang
// sudah dipakai rateLimiter.ts (780 = ~1.3x worst-case 600 saat itu) --
// bukan angka baru yang ditebak, reuse rasio yang sudah ada presedennya di
// repo ini. Pair yang butuh lebih dari 150 halaman buat nutupin 60 menit
// akan trigger insufficientData=true, BUKAN diam-diam balikin window
// parsial yang keliatan lengkap padahal enggak.
export const DEFAULT_MAX_PAGES = 150;

async function fetchPageWithBackoff(fetchFn: () => Promise<AggTrade[]>): Promise<AggTrade[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const page = await fetchFn();
      if (!Array.isArray(page)) {
        throw new Error(`Respons aggTrades bukan array (malformed): ${JSON.stringify(page).slice(0, 200)}`);
      }
      return page;
    } catch (err) {
      if (err instanceof RateLimitError && attempt < RATE_LIMIT_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Paginate aggTrades mundur dari `nowMs` sampai window `windowMinutes`
 * ke belakang ke-cover penuh, atau `maxPages` kehabisan duluan.
 *
 * Precondition/behavior sama persis dengan fetchAllAggTrades di probe
 * series: page pertama pakai startTime+endTime (limit 1000), page
 * berikutnya lanjut via fromId (limit 1000) sampai trade terakhir yang
 * kefetch >= endTime ATAU batch < 1000 (sudah sampai ujung histori
 * tersedia). HASIL TETAP chronological (ascending T) karena Binance native
 * ngembaliin urut naik dan fromId cuma nambah ke belakang array.
 *
 * Kalau maxPages kehabisan SEBELUM window ke-cover penuh, `insufficientData`
 * = true dan trades yang sudah kefetch tetap dikembalikan (BUKAN dibuang)
 * TAPI caller WAJIB cek flag ini dulu -- jangan pakai `trades`/`windowCoveredMs`
 * seolah itu window penuh yang diminta.
 */
export async function fetchAggTradesForWindow(
  symbol: string,
  market: "spot" | "futures",
  windowMinutes: number,
  maxPages: number = DEFAULT_MAX_PAGES,
  nowMs: number = Date.now(),
): Promise<PaginatedTradesResult> {
  const endTime = nowMs;
  const startTime = endTime - windowMinutes * 60_000;
  const fetchRange = market === "futures" ? getAggTradesRange : getSpotAggTradesRange;

  // `batch` = halaman MENTAH terakhir yang kefetch (bukan kumulatif) --
  // sinyal "mungkin masih ada lanjutannya" adalah batch.length === 1000
  // (halaman penuh), PERSIS logic fetchAllAggTrades di probe series. Cek
  // ini WAJIB pakai batch mentah, bukan trades.length kumulatif (trades
  // kumulatif abis di-filter inRange bisa < 1000 kelipatan meski batch
  // mentahnya penuh, atau sebaliknya -- keduanya BUKAN sinyal yang valid).
  let batch = await fetchPageWithBackoff(() => fetchRange(symbol, { startTime, endTime, limit: 1000 }));
  let trades: AggTrade[] = batch;
  let pagesUsed = 1;

  while (batch.length === 1000 && trades.length > 0 && trades[trades.length - 1].T < endTime) {
    if (pagesUsed >= maxPages) {
      return {
        trades,
        pagesUsed,
        windowCoveredMs: trades.length > 0 ? trades[trades.length - 1].T - trades[0].T : 0,
        insufficientData: true,
      };
    }

    const lastId = trades[trades.length - 1].a;
    batch = await fetchPageWithBackoff(() => fetchRange(symbol, { fromId: lastId + 1, limit: 1000 }));
    pagesUsed += 1;
    if (batch.length === 0) break;

    const inRange = batch.filter((t) => t.T <= endTime);
    trades = trades.concat(inRange);
    if (inRange.length < batch.length) break; // sudah lewat endTime -- window selesai secara alami
  }

  return {
    trades,
    pagesUsed,
    windowCoveredMs: trades.length > 0 ? trades[trades.length - 1].T - trades[0].T : 0,
    insufficientData: false,
  };
}
