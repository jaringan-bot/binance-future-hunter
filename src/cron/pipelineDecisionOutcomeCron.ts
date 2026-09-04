// Backfill forward_return_1h/4h/24h + sl_touched_24h ke pipeline_decision_log
// (migration 0013) -- dipanggil piggyback tick */5 (src/index.ts), pola sama
// housekeeping lain di tick itu (prune*, snapshotNonWatchlistBasis).
//
// REUSE PENUH evaluateDecisionForward() dari
// src/tools/pipelineDecisionBacktest.ts (bukan reimplementasi formula) --
// menjamin angka yang dipersist di sini IDENTIK dengan yang dihitung
// whalescope_backtest_pipeline_decisions kalau dipanggil on-demand untuk
// row yang sama, cuma beda kapan dihitungnya.
//
// SATU fetch klines 25-candle (cukup buat window 1h/4h/24h sekaligus, lihat
// KLINE_LIMIT di pipelineDecisionBacktest.ts: 1h->2, 4h->5, 24h->25 candle)
// per row, bukan 3 fetch terpisah -- slice array yang sama 3x.
import * as binanceProxy from "../binanceProxyClient.js";
import type { KlineTuple } from "../binanceProxyClient.js";
import {
  evaluateDecisionForward,
  FORWARD_INTERVAL,
  FORWARD_WINDOW_CANDLES,
  FORWARD_FULL_WINDOW_CANDLES,
  FORWARD_FULL_WINDOW_MS,
} from "../tools/pipelineDecisionBacktest.js";
import {
  queryPendingPipelineDecisionOutcomes,
  updatePipelineDecisionOutcome,
  bumpPipelineDecisionOutcomeAttempts,
  type PendingPipelineDecisionOutcomeRow,
} from "../d1Client.js";

// Window terpanjang (24h) harus sudah LEWAT sebelum row dianggap "siap" --
// +2h buffer di atas 24h biar candle terakhir yang dibutuhkan (index 24)
// sudah pasti closed di Binance saat fetch, bukan mepet real-time.
const READY_AFTER_MS = 26 * 3600 * 1000;
// Berhenti nyoba row yang gagal terus-menerus (symbol delisted, dst) setelah
// 14 hari -- row itu TETAP forward_return_24h NULL selamanya (bukan gagal
// tersembunyi), tapi gak lagi makan budget cron tiap tick. 90 hari retensi
// tabel ini jauh lebih panjang dari 14 hari, jadi row begini akhirnya
// ke-prune juga oleh pruneOldPipelineDecisionLog.
const GIVE_UP_AFTER_MS = 14 * 24 * 3600 * 1000;
// Dibatasi per tick (bukan semua pending sekaligus) -- pola sama
// entryAlertCron.ts, jaga budget rate-limiter internal (rateLimiter.ts)
// tetap wajar dibagi sama housekeeping lain di tick */5.
const MAX_ROWS_PER_TICK = 30;
// 4.3 (Stage 4): batas percobaan per BARIS. GIVE_UP_AFTER_MS di atas hanya
// membatasi UMUR baris, bukan berapa kali ia dipilih ulang -- selama 14 hari
// itu, >= MAX_ROWS_PER_TICK baris yang gagal permanen memakan SELURUH slot
// tiap tick dan tidak menyisakan apa pun untuk baris baru. Dengan penanda
// attempt, baris begitu keluar dari kandidat setelah beberapa percobaan.
//
// Nilai 5 dipilih supaya gangguan relay yang sebentar tidak menghabiskan
// jatah baris yang sebenarnya sehat: tick */5 -> 5 percobaan mencakup
// gangguan sampai ~25 menit, dan lihat juga guard "semua gagal transport"
// di bawah yang menahan penambahan attempt saat SELURUH tick gagal fetch.
// BELUM DIKALIBRASI -- angka pilihan, bukan hasil pengukuran.
const MAX_OUTCOME_ATTEMPTS = 5;
// B1/B2 (2026-09-04): window sekarang dihitung dalam candle 5m, bukan 1h --
// lihat komentar panjang di pipelineDecisionBacktest.ts. Konstanta di-import
// dari sana supaya tool on-demand dan cron ini TIDAK BISA lagi berbeda
// (klaim "angka IDENTIK" di header file ini dulu tidak benar untuk window
// 1h: tool menghasilkan 0 persis, cron menghasilkan return jam+1 -> jam+2).

export async function backfillPipelineDecisionOutcomes(now: number = Date.now()): Promise<{
  attempted: number;
  updated: number;
  /** Baris yang penghitung percobaannya dinaikkan tick ini (4.3). */
  penalized: number;
}> {
  const pending: PendingPipelineDecisionOutcomeRow[] = await queryPendingPipelineDecisionOutcomes(
    now - READY_AFTER_MS,
    now - GIVE_UP_AFTER_MS,
    MAX_ROWS_PER_TICK,
    MAX_OUTCOME_ATTEMPTS,
  );

  let updated = 0;
  // Dua jenis kegagalan, DIBEDAKAN dengan sengaja:
  //  - transport: fetch ke relay/Binance melempar. Ini bisa jadi masalah
  //    INFRASTRUKTUR yang tidak ada hubungannya dengan baris itu sendiri.
  //  - data-shape: fetch berhasil tapi candle-nya kurang (symbol delisted,
  //    gap data, listing terlalu baru). Ini VONIS TENTANG BARIS ITU.
  // Data-shape SELALU menaikkan attempt. Transport hanya menaikkan attempt
  // kalau tidak SEMUA baris tick ini gagal transport -- kalau semuanya
  // gagal, itu tanda relay yang lagi down, dan menghukum 30 baris sehat
  // karenanya justru membuang data yang masih bisa di-backfill nanti.
  const failedTransport: number[] = [];
  const failedDataShape: number[] = [];
  for (const row of pending) {
    let candles: KlineTuple[] = [];
    try {
      candles = await binanceProxy.getKlinesNative(
        row.symbol,
        FORWARD_INTERVAL,
        FORWARD_FULL_WINDOW_CANDLES,
        row.runAt,
        row.runAt + FORWARD_FULL_WINDOW_MS,
      );
    } catch (err) {
      console.error(`[cron] gagal fetch klines backfill pipeline_decision_log id=${row.id} (${row.symbol}):`, (err as Error)?.message ?? String(err));
      failedTransport.push(row.id);
      continue;
    }

    if (candles.length < FORWARD_FULL_WINDOW_CANDLES) {
      // Candle belum cukup (< 289 candle 5m) -- symbol baru listing/gap data.
      // Coba lagi tick berikutnya (masih dalam GIVE_UP_AFTER_MS). PENTING:
      // evaluateDecisionForward() cuma menolak array < 2 candle, jadi tanpa
      // cek eksplisit di sini row bisa ke-persist dengan forwardReturn24h
      // yang sebenarnya cuma jarak N < 24 jam.
      failedDataShape.push(row.id);
      continue;
    }

    // slice(0, N+1): entry = open candle ke-0, exit = close candle ke-N.
    const fwd1h = evaluateDecisionForward(candles.slice(0, FORWARD_WINDOW_CANDLES["1h"] + 1), row.stopLoss);
    const fwd4h = evaluateDecisionForward(candles.slice(0, FORWARD_WINDOW_CANDLES["4h"] + 1), row.stopLoss);
    const fwd24h = evaluateDecisionForward(candles.slice(0, FORWARD_WINDOW_CANDLES["24h"] + 1), row.stopLoss);
    if (!fwd24h) {
      // Harusnya gak pernah kejadian setelah length check di atas. Kalau
      // toh terjadi (harga non-finite/nol di candle acuan), itu cacat DATA
      // baris ini, bukan transport -- hitung sebagai data-shape supaya tidak
      // jadi baris zombie yang dipilih ulang selamanya.
      failedDataShape.push(row.id);
      continue;
    }

    await updatePipelineDecisionOutcome(row.id, {
      forwardReturn1h: fwd1h?.forwardReturn ?? null,
      forwardReturn4h: fwd4h?.forwardReturn ?? null,
      forwardReturn24h: fwd24h.forwardReturn,
      slTouched24h: fwd24h.slTouch,
    });
    updated += 1;
  }

  // Guard "relay down": kalau SETIAP baris tick ini gagal transport dan
  // tidak ada satu pun yang berhasil, jangan hukum siapa-siapa.
  const totalTransportOutage =
    pending.length > 0 && failedTransport.length === pending.length && updated === 0;
  const toPenalize = totalTransportOutage ? failedDataShape : [...failedDataShape, ...failedTransport];
  if (totalTransportOutage) {
    console.error(
      `[cron] backfill outcome: SEMUA ${pending.length} baris gagal fetch -- ` +
        "relay/Binance kemungkinan down. outcome_attempts TIDAK dinaikkan.",
    );
  }
  await bumpPipelineDecisionOutcomeAttempts(toPenalize);

  return { attempted: pending.length, updated, penalized: toPenalize.length };
}
