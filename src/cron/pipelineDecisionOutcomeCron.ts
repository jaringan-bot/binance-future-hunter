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
// B1/B2 (2026-09-04): window sekarang dihitung dalam candle 5m, bukan 1h --
// lihat komentar panjang di pipelineDecisionBacktest.ts. Konstanta di-import
// dari sana supaya tool on-demand dan cron ini TIDAK BISA lagi berbeda
// (klaim "angka IDENTIK" di header file ini dulu tidak benar untuk window
// 1h: tool menghasilkan 0 persis, cron menghasilkan return jam+1 -> jam+2).

export async function backfillPipelineDecisionOutcomes(now: number = Date.now()): Promise<{ attempted: number; updated: number }> {
  const pending: PendingPipelineDecisionOutcomeRow[] = await queryPendingPipelineDecisionOutcomes(
    now - READY_AFTER_MS,
    now - GIVE_UP_AFTER_MS,
    MAX_ROWS_PER_TICK,
  );

  let updated = 0;
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
      continue;
    }

    if (candles.length < FORWARD_FULL_WINDOW_CANDLES) {
      // Candle belum cukup (< 289 candle 5m) -- symbol baru listing/gap data.
      // Coba lagi tick berikutnya (masih dalam GIVE_UP_AFTER_MS). PENTING:
      // evaluateDecisionForward() cuma menolak array < 2 candle, jadi tanpa
      // cek eksplisit di sini row bisa ke-persist dengan forwardReturn24h
      // yang sebenarnya cuma jarak N < 24 jam.
      continue;
    }

    // slice(0, N+1): entry = open candle ke-0, exit = close candle ke-N.
    const fwd1h = evaluateDecisionForward(candles.slice(0, FORWARD_WINDOW_CANDLES["1h"] + 1), row.stopLoss);
    const fwd4h = evaluateDecisionForward(candles.slice(0, FORWARD_WINDOW_CANDLES["4h"] + 1), row.stopLoss);
    const fwd24h = evaluateDecisionForward(candles.slice(0, FORWARD_WINDOW_CANDLES["24h"] + 1), row.stopLoss);
    if (!fwd24h) continue; // harusnya gak pernah kejadian setelah length check di atas, jaga-jaga saja

    await updatePipelineDecisionOutcome(row.id, {
      forwardReturn1h: fwd1h?.forwardReturn ?? null,
      forwardReturn4h: fwd4h?.forwardReturn ?? null,
      forwardReturn24h: fwd24h.forwardReturn,
      slTouched24h: fwd24h.slTouch,
    });
    updated += 1;
  }

  return { attempted: pending.length, updated };
}
