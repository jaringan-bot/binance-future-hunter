// Cron snapshot laporan CFTC COT ke D1 (cftc_positioning_history) --
// dipanggil piggyback dari HEARTBEAT_CRON (3x/hari, src/index.ts) karena
// data CFTC sendiri cuma update mingguan (Jumat); insert idempotent (INSERT
// OR IGNORE + unique index coin+report_date di d1Client.ts) jadi ngecek
// lebih sering dari update-rate aslinya aman -- no-op kalau report_date
// belum ganti. Pola single-coin + try/catch per-coin di caller sama seperti
// scanWallCandidates/snapshotWhaleWallet.
import { getCftcPositioning, CFTC_CONTRACT_NAME } from "../cftcClient.js";
import { insertCftcPositioningSnapshot } from "../d1Client.js";

export async function snapshotCftcPositioning(coin: keyof typeof CFTC_CONTRACT_NAME): Promise<void> {
  const report = await getCftcPositioning(coin);
  await insertCftcPositioningSnapshot({
    coin,
    reportDate: report.reportDate.slice(0, 10),
    openInterest: report.openInterest,
    levLong: report.leveragedFunds.long,
    levShort: report.leveragedFunds.short,
    levNetPct: report.leveragedFunds.netPct,
    amLong: report.assetManagers.long,
    amShort: report.assetManagers.short,
    amNetPct: report.assetManagers.netPct,
    capturedAt: Date.now(),
  });
}
