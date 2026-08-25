// Heartbeat entry-alert (Telegram) -- dijalankan HEARTBEAT_CRON (3x/hari,
// lihat src/index.ts + wrangler.toml: 00.00/08.00/16.00 UTC = 07.00/15.00/
// 23.00 WIB). Kalau gak ada alert TRADE/WATCH sama sekali dalam 8 jam
// terakhir, user gak bisa bedain "market emang sepi" dari "backend diam-diam
// mati" -- heartbeat ini isi kekosongan itu dengan 1 pesan yang jelasin
// kenapa, pakai tally dari entry_alert_run_log (diisi tiap tick
// entryAlertCron.ts, lihat runEntryAlertCheck).
import * as d1Client from "../d1Client.js";
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
