// Mapper murni: SymbolPipelineResult -> row compact pipeline_decision_log.
// TIDAK fetch, TIDAK tulis D1 -- supaya unit-test tanpa mock proxy.
import type { PipelineDecision, SymbolPipelineResult } from "./tools/fullPipeline.js";

export const PIPELINE_DECISION_LOG_SOURCES = ["entry_alert", "manual", "dropstab"] as const;
export type PipelineDecisionLogSource = (typeof PIPELINE_DECISION_LOG_SOURCES)[number];

export type ScoreBucket = "lt_40" | "40_55" | "gte_55";

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
// CATATAN: label bucket ("40_55", "gte_55") MENGKODEKAN angka di bawah.
// Kalau threshold diubah, label wajib ikut diubah -- kalau tidak, output
// akan berbohong tentang isi bucket-nya.
export const SCORE_BUCKET_MID_MIN = 40;
export const SCORE_BUCKET_HIGH_MIN = 55;

export function scoreBucket(rankingScore: number): ScoreBucket {
  if (rankingScore >= SCORE_BUCKET_HIGH_MIN) return "gte_55";
  if (rankingScore >= SCORE_BUCKET_MID_MIN) return "40_55";
  return "lt_40";
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
    `CASE WHEN ${column} >= ${SCORE_BUCKET_HIGH_MIN} THEN 'gte_55' ` +
    `WHEN ${column} >= ${SCORE_BUCKET_MID_MIN} THEN '40_55' ELSE 'lt_40' END`
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
