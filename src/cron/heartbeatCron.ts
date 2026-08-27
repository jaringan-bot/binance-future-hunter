// Heartbeat entry-alert (Telegram) -- dijalankan HEARTBEAT_CRON (3x/hari,
// lihat src/index.ts + wrangler.toml: 00.00/08.00/16.00 UTC = 07.00/15.00/
// 23.00 WIB). Kalau gak ada alert TRADE/WATCH sama sekali dalam 8 jam
// terakhir, user gak bisa bedain "market emang sepi" dari "backend diam-diam
// mati" -- heartbeat ini isi kekosongan itu dengan 1 pesan yang jelasin
// kenapa, pakai tally dari entry_alert_run_log (diisi tiap tick
// entryAlertCron.ts, lihat runEntryAlertCheck).
import * as d1Client from "../d1Client.js";
import * as kvConfig from "../kvConfig.js";
import { sendTelegramAlert, type TelegramEnv } from "../telegram.js";

export const HEARTBEAT_LOOKBACK_MS = 8 * 60 * 60 * 1000;

// Di atas ambang ini (dari input user 2026-08-25), error rate tiap tick
// dianggap indikasi backend bermasalah, bukan cuma noise kecil.
export const BACKEND_ISSUE_ERROR_RATE_THRESHOLD = 0.3;

export async function checkHeartbeat(env: TelegramEnv, now: number = Date.now()): Promise<void> {
  const cutoff = now - HEARTBEAT_LOOKBACK_MS;
  const alertCount = await d1Client.countEntryAlertsSince(cutoff);
  if (alertCount > 0) return; // sudah ada sinyal asli, gak perlu heartbeat.

  const { total, errors } = await d1Client.getEntryAlertRunLogSummarySince(cutoff);

  if (total === 0) {
    await sendTelegramAlert(
      env,
      "⚠️ *Heartbeat*: tidak ada data entry-alert sama sekali dalam 8 jam terakhir -- entryAlertCron kemungkinan tidak jalan. Cek backend/Cron Trigger.",
    );
    return;
  }

  const errorRatePct = (errors / total) * 100;

  if (errorRatePct > BACKEND_ISSUE_ERROR_RATE_THRESHOLD * 100) {
    await sendTelegramAlert(
      env,
      `⚠️ *Heartbeat*: tidak ada sinyal TRADE/WATCH dalam 8 jam terakhir, DAN ${errorRatePct.toFixed(0)}% pair gagal diproses tiap tick -- kemungkinan ada masalah backend, bukan cuma kondisi market.`,
    );
    return;
  }

  await sendTelegramAlert(
    env,
    `ℹ️ *Heartbeat*: tidak ada sinyal TRADE/WATCH dalam 8 jam terakhir. Backend normal (error rate ${errorRatePct.toFixed(0)}%) -- tidak ada pair yang memenuhi kriteria TRADE/WATCH saat ini.`,
  );
}

// ─────────────────────────────────────────────────────────────
// checkEntryAlertCronFreshness (2026-08-27) -- gap detection, BEDA dari
// checkHeartbeat() di atas. checkHeartbeat() cuma pernah melihat data dari
// tick yang SELESAI (SUM/COUNT dari baris yang ada) -- kalau sebuah tick
// di-Cancel oleh platform Cloudflare SEBELUM sempat menulis baris
// entry_alert_run_log-nya sendiri, tick itu invisible ke checkHeartbeat(),
// dan karena HEARTBEAT_CRON cuma 3x/hari, gap besar bisa gak ketahuan
// berjam-jam. Fungsi ini sebaliknya cek "seberapa lama sejak tick TERAKHIR
// yang benar-benar selesai" -- gap detection langsung, dipanggil dari cron
// yang lebih sering (*/5, lihat index.ts) supaya kedeteksi dalam puluhan
// menit, bukan jam. Insiden nyata yang memicu ini: 2026-08-27, beberapa
// tick entry-alert ke-Cancel berturut-turut (kemungkinan CPU-time cap),
// >1 jam tanpa baris baru, tidak terdeteksi checkHeartbeat() manapun --
// lihat project_whalescope-mcp_status memory untuk detail insiden.
export const ENTRY_ALERT_STALE_THRESHOLD_MS = 40 * 60 * 1000; // ~2.6x cadence 15-menit -- toleransi 1 tick lambat/hilang sebelum alert, hindari false-positive dari satu tick yang cuma telat sedikit.
export const ENTRY_ALERT_STALE_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // jangan spam tiap 5 menit selagi kondisi stale persist -- maksimal 1 notifikasi/jam.
const ENTRY_ALERT_STALE_KV_KEY = "entry_alert_cron_stale_last_notified_at";

interface StaleNoticeState {
  at: number;
}

export async function checkEntryAlertCronFreshness(env: TelegramEnv, now: number = Date.now()): Promise<void> {
  const latest = await d1Client.getLatestEntryAlertRunLogTimestamp();
  const staleForMs = latest === null ? Infinity : now - latest;
  if (staleForMs <= ENTRY_ALERT_STALE_THRESHOLD_MS) return; // sehat, gak ada yang perlu dilaporkan.

  const lastNotified = await kvConfig.getJson<StaleNoticeState>(ENTRY_ALERT_STALE_KV_KEY);
  if (lastNotified && now - lastNotified.at < ENTRY_ALERT_STALE_ALERT_COOLDOWN_MS) return; // udah dikasih tau baru-baru ini, jangan spam.

  const message =
    latest === null
      ? "🚨 *Entry-Alert Cron*: belum PERNAH ada baris entry_alert_run_log tercatat -- entryAlertCron kemungkinan belum pernah selesai jalan sejak deploy terakhir."
      : `🚨 *Entry-Alert Cron*: tidak ada tick yang SELESAI dalam ${Math.round(staleForMs / 60000)} menit terakhir (normalnya tiap ~15 menit). Kemungkinan tick di-cancel platform Cloudflare (cek CPU-time cap) atau backend bermasalah -- cek Workers Logs / \`wrangler tail\` / D1 \`entry_alert_run_log\`.`;

  await sendTelegramAlert(env, message);
  await kvConfig.putJson(ENTRY_ALERT_STALE_KV_KEY, { at: now } satisfies StaleNoticeState, { expirationTtl: 24 * 60 * 60 });
}
