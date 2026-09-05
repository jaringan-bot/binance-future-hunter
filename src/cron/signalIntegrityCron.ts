// Monitor integritas SINYAL -- saudara src/cron/infraHealthCron.ts.
//
// infraHealthCron menjaga INFRASTRUKTUR (gateway VPS mati, relay down, cron
// snapshot berhenti nulis). File ini menjaga hal yang sama sekali berbeda dan
// selama ini tidak dijaga siapa pun: apakah SINYAL-nya masih berarti.
//
// Dua cek, keduanya pilihan user 2026-09-05:
//
//  1. checkOutcomeBackfillHealth -- backfill outcome berhenti mengalir, ATAU
//     kolom grid balik semua-NULL. Kegagalan senyap yang hampir menggigit
//     2026-09-05 saat deploy mendahului migration: error D1 di backfill cuma
//     di-log (index.ts membungkusnya `.catch()`), jadi tidak ada yang crash
//     dan satu-satunya gejala adalah angka yang tidak bertambah -- gejala
//     yang identik dengan "belum matang 26 jam".
//
//  2. checkScoreDiscriminatingPower -- skor ranking berhenti memisahkan grid
//     yang bertahan dari yang jebol, atau memisahkannya TERBALIK. Menemukan
//     ini secara manual butuh sehari penuh (export D1 + skrip falsifikasi +
//     uji mutasi). Sekarang ia memeriksa dirinya sendiri.
//
// LAPOR SAJA. Lihat catatan panjang di src/signalIntegrity.ts -- monitor ini
// sengaja TIDAK punya kewenangan menahan alert atau menyetel bobot.
//
// Pola KV-cooldown + dispatchNotification + `now` injectable diambil apa
// adanya dari infraHealthCron.ts.
import * as d1Client from "../d1Client.js";
import * as kvConfig from "../kvConfig.js";
import { dispatchNotification, type NotifyEnv } from "../notify.js";
import {
  evaluateBackfillHealth,
  evaluateDiscriminatingPower,
  isAlertworthy,
  SCORE_BUCKET_DISPATCH_MIN,
} from "../signalIntegrity.js";

// Kondisi di sini bergerak LAMBAT (hitungan hari), beda dari outage infra
// yang bisa pulih dalam menit. Cooldown 24 jam supaya satu masalah yang
// persisten tidak mengirim 3 pesan/hari mengikuti tick heartbeat.
export const SIGNAL_INTEGRITY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const NOTIFY_KV_TTL_SECONDS = 7 * 24 * 60 * 60;

const BACKFILL_KV_KEY = "signal_integrity:backfill";
const DISCRIMINATION_KV_KEY = "signal_integrity:discrimination";

/** Ambang kematangan outcome -- SAMA dengan READY_AFTER_MS di pipelineDecisionOutcomeCron. */
export const MATURED_AFTER_MS = 26 * 3600 * 1000;
/** Jendela "baru-baru ini" untuk fraksi NULL grid. */
export const RECENT_WINDOW_MS = 3 * 24 * 3600 * 1000;
/** Jendela evaluasi daya pisah skor. */
export const DISCRIMINATION_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Sama dengan MAX_OUTCOME_ATTEMPTS di pipelineDecisionOutcomeCron -- baris yang sudah menyerah bukan backlog. */
export const MAX_OUTCOME_ATTEMPTS = 5;

interface NotifyState {
  at: number;
}

async function withinCooldown(key: string, now: number): Promise<boolean> {
  const last = await kvConfig.getJson<NotifyState>(key);
  return last != null && now - last.at < SIGNAL_INTEGRITY_COOLDOWN_MS;
}

async function recordNotified(key: string, now: number): Promise<void> {
  await kvConfig.putJson(key, { at: now }, { expirationTtl: NOTIFY_KV_TTL_SECONDS });
}

export async function checkOutcomeBackfillHealth(env: NotifyEnv, now: number = Date.now()): Promise<void> {
  const counts = await d1Client.queryOutcomeBackfillHealth({
    maturedBefore: now - MATURED_AFTER_MS,
    recentSince: now - RECENT_WINDOW_MS,
    maxAttempts: MAX_OUTCOME_ATTEMPTS,
  });
  const result = evaluateBackfillHealth(counts);

  // Verdict SELALU di-log, termasuk OK dan INSUFFICIENT_SAMPLE. Notifikasi
  // yang di-cooldown bisa hilang; log tidak. Dan "monitor jalan tapi tidak
  // menemukan apa-apa" harus bisa dibedakan dari "monitor tidak jalan".
  console.log(`[signal-integrity] backfill: ${result.verdict} -- ${result.detail}`);
  if (!isAlertworthy(result.verdict)) return;
  if (await withinCooldown(BACKFILL_KV_KEY, now)) return;

  await dispatchNotification(
    env,
    `⚠️ Integritas sinyal — backfill outcome: ${result.verdict}\n\n${result.detail}\n\n` +
      "Selama ini berlangsung, SETIAP evaluasi skor (backtest, kalibrasi, monitor daya pisah) " +
      "berjalan di atas data yang berhenti tumbuh.",
  );
  await recordNotified(BACKFILL_KV_KEY, now);
}

export async function checkScoreDiscriminatingPower(env: NotifyEnv, now: number = Date.now()): Promise<void> {
  const aggregates = await d1Client.queryPipelineDecisionAggregates({
    startTime: now - DISCRIMINATION_WINDOW_MS,
    endTime: now,
    window: "24h",
    // Biaya eksekusi tidak relevan di sini: yang dipakai cuma kolom grid,
    // bukan win rate. 0 supaya tidak menyiratkan asumsi biaya apa pun.
    execCostRoundTrip: 0,
  });
  const result = evaluateDiscriminatingPower(aggregates.byScoreBucket);

  console.log(`[signal-integrity] daya pisah skor: ${result.verdict} -- ${result.detail}`);
  if (!isAlertworthy(result.verdict)) return;
  if (await withinCooldown(DISCRIMINATION_KV_KEY, now)) return;

  const header =
    result.verdict === "INVERTED"
      ? "🔻 Integritas sinyal — skor ranking TERBALIK"
      : "⚠️ Integritas sinyal — skor ranking tidak memisahkan";

  await dispatchNotification(
    env,
    `${header}\n\n${result.detail}\n\n` +
      `Pemisah: skor >= ${SCORE_BUCKET_DISPATCH_MIN} (gate alert WATCH) vs di bawahnya. ` +
      `Jendela ${DISCRIMINATION_WINDOW_MS / (24 * 3600 * 1000)} hari, metrik "keluar range" dari kolom grid (migration 0017).\n\n` +
      "Ini LAPORAN, bukan tindakan: tidak ada alert yang ditahan dan tidak ada bobot yang diubah. " +
      "Rujukan: docs/superpowers/plans/2026-09-05-falsifikasi-ranking-score.md",
  );
  await recordNotified(DISCRIMINATION_KV_KEY, now);
}
