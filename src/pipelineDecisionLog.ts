// Mapper murni: SymbolPipelineResult -> row compact pipeline_decision_log.
// TIDAK fetch, TIDAK tulis D1 -- supaya unit-test tanpa mock proxy.
import type { PipelineDecision, SymbolPipelineResult } from "./tools/fullPipeline.js";

export const PIPELINE_DECISION_LOG_SOURCES = ["entry_alert", "manual", "dropstab"] as const;
export type PipelineDecisionLogSource = (typeof PIPELINE_DECISION_LOG_SOURCES)[number];

export type ScoreBucket = (typeof SCORE_BUCKETS)[number];

export interface PipelineDecisionLogRow {
  runAt: number;
  symbol: string;
  source: PipelineDecisionLogSource;
  sourceRef: string | null;
  decision: PipelineDecision | string;
  rankingScore: number;
  /** 4 sub-skor komponen ranking (0-100), migration 0014. null kalau hard
   *  screen gagal sebelum scoreTier1Signals() -- null != 0. */
  mmComponent: number | null;
  /** K6 (migration 0015): sub-skor MM yang menaikkan risiko. */
  mmAdverseComponent: number | null;
  smartMoneyComponent: number | null;
  regimeComponent: number | null;
  buyPressureComponent: number | null;
  hardScreenPassed: boolean;
  hardScreenReasons: string[];
  quoteVolumeUsd: number | null;
  fundingRate: number | null;
  regime1h: string | null;
  regime4h: string | null;
  gridRiskStatus: string | null;
  lowerPrice: number | null;
  upperPrice: number | null;
  stopLoss: number | null;
}

// Batas bucket skor -- SATU sumber kebenaran. scoreBucket() (jalur TS,
// dipakai backtest detail) dan scoreBucketSqlCase() (jalur agregat SQL,
// Stage 4.1) DITURUNKAN dari konstanta yang sama supaya tidak bisa
// menghasilkan bucket berbeda untuk skor yang sama.
//
// ─────────────────────────────────────────────────────────────
// T8 (2026-09-05) -- BATAS 50 DITAMBAHKAN.
//
// CACAT LAMA: bucket-nya lt_40 / 40_55 / gte_55, sementara gate yang
// SEBENARNYA menentukan apa yang sampai ke manusia adalah
// `isGridAlertWorthy()` di entryAlertCron.ts -- ia mengirim alert WATCH pada
// rankingScore >= 50. Batas 50 itu berada persis di TENGAH bucket "40_55",
// jadi tidak ada satu pun analisis yang pernah mengukur apa yang terjadi di
// seberangnya. Backtest melaporkan angka untuk pita yang tidak dipakai
// siapa pun mengambil keputusan.
//
// SCORE_BUCKET_DISPATCH_MIN WAJIB sama dengan WATCH_MIN_ALERT_SCORE
// (entryAlertCron.ts). Keduanya tidak di-import silang -- pipelineDecisionLog
// sengaja tetap bebas dependensi ke layer cron -- jadi invariannya ditegakkan
// oleh TEST (pipelineDecisionLog.test.ts), bukan oleh tipe. Kalau gate
// dispatch digeser sendirian, test itu merah.
//
// Label bucket DITURUNKAN dari angkanya lewat template literal di bawah,
// bukan ditulis tangan. Komentar lama di sini memperingatkan "kalau
// threshold diubah, label wajib ikut diubah, kalau tidak output akan
// berbohong tentang isi bucket-nya" -- sekarang label itu TIDAK BISA lagi
// berbohong, karena ia dihasilkan dari konstanta yang sama.
// ─────────────────────────────────────────────────────────────
export const SCORE_BUCKET_MID_MIN = 40;
export const SCORE_BUCKET_DISPATCH_MIN = 50;
export const SCORE_BUCKET_HIGH_MIN = 55;

export const SCORE_BUCKETS = [
  `lt_${SCORE_BUCKET_MID_MIN}`,
  `${SCORE_BUCKET_MID_MIN}_${SCORE_BUCKET_DISPATCH_MIN}`,
  `${SCORE_BUCKET_DISPATCH_MIN}_${SCORE_BUCKET_HIGH_MIN}`,
  `gte_${SCORE_BUCKET_HIGH_MIN}`,
] as const;

export function scoreBucket(rankingScore: number): ScoreBucket {
  if (rankingScore >= SCORE_BUCKET_HIGH_MIN) return SCORE_BUCKETS[3];
  if (rankingScore >= SCORE_BUCKET_DISPATCH_MIN) return SCORE_BUCKETS[2];
  if (rankingScore >= SCORE_BUCKET_MID_MIN) return SCORE_BUCKETS[1];
  return SCORE_BUCKETS[0];
}

/**
 * Ekspresi SQL CASE yang memberi bucket IDENTIK dengan scoreBucket().
 * Dipakai queryPipelineDecisionAggregates() supaya agregasi bisa dilakukan
 * di SQL atas SELURUH rentang, bukan atas 80 baris terbaru.
 *
 * `column` adalah nama kolom milik KODE (bukan input user) -- di-assert
 * identifier polos supaya tidak ada jalur interpolasi yang bisa
 * disalahgunakan kalau nanti ada caller lain.
 */
export function scoreBucketSqlCase(column = "ranking_score"): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`scoreBucketSqlCase: nama kolom tidak valid: ${column}`);
  }
  return (
    `CASE WHEN ${column} >= ${SCORE_BUCKET_HIGH_MIN} THEN '${SCORE_BUCKETS[3]}' ` +
    `WHEN ${column} >= ${SCORE_BUCKET_DISPATCH_MIN} THEN '${SCORE_BUCKETS[2]}' ` +
    `WHEN ${column} >= ${SCORE_BUCKET_MID_MIN} THEN '${SCORE_BUCKETS[1]}' ` +
    `ELSE '${SCORE_BUCKETS[0]}' END`
  );
}

export function toPipelineDecisionLogRow(
  result: SymbolPipelineResult,
  runAt: number,
  source: PipelineDecisionLogSource,
  sourceRef?: string | null,
): PipelineDecisionLogRow {
  const hs = result.hardScreen;
  const rc = result.rankingComponents;
  return {
    runAt,
    symbol: result.symbol.toUpperCase(),
    source,
    sourceRef: sourceRef?.trim() ? sourceRef.trim() : null,
    decision: result.decision,
    rankingScore: result.rankingScore,
    mmComponent: rc ? rc.mm : null,
    mmAdverseComponent: rc ? rc.mmAdverse : null,
    smartMoneyComponent: rc ? rc.smartMoney : null,
    regimeComponent: rc ? rc.regime : null,
    buyPressureComponent: rc ? rc.buyPressure : null,
    hardScreenPassed: hs?.passed ?? false,
    hardScreenReasons: hs?.reasons ?? [],
    quoteVolumeUsd: Number.isFinite(hs?.quoteVolumeUsd) ? hs.quoteVolumeUsd : null,
    fundingRate: Number.isFinite(hs?.fundingRate) ? hs.fundingRate : null,
    regime1h: hs?.regime1h ?? null,
    regime4h: hs?.regime4h ?? null,
    gridRiskStatus: result.risk?.gridRisk?.status ?? null,
    lowerPrice: result.gridBotConfig?.lower ?? result.gridSetup?.lowerPrice ?? null,
    upperPrice: result.gridBotConfig?.upper ?? result.gridSetup?.upperPrice ?? null,
    stopLoss: result.gridBotConfig?.stopLoss ?? result.gridSetup?.stopLossPrice ?? null,
  };
}

/** true kalau ada candle dengan low <= stopLoss di jendela [runAt, runAt+windowMs]. */
export function didStopLossTouch(lows: number[], stopLoss: number | null): boolean | null {
  if (stopLoss == null || !Number.isFinite(stopLoss) || lows.length === 0) return null;
  return lows.some((low) => Number.isFinite(low) && low <= stopLoss);
}
