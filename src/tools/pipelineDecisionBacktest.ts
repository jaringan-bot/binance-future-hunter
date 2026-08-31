// whalescope_backtest_pipeline_decisions -- uji maju formula terpasang
// (threshold skor 55, hard screen vol/funding, keputusan TRADE/WATCH/NO_TRADE)
// dari row compact pipeline_decision_log. Forward return + SL-touch dihitung
// ON-DEMAND dari klines 1h (bukan kolom precompute). Pola sama dengan
// binance_backtest_signal: MAX_ROWS, close candle, bukan PnL grid riil.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as binanceProxy from "../binanceProxyClient.js";
import type { KlineTuple } from "../binanceProxyClient.js";
import { errorResult, parseTimeParam } from "../shared.js";
import { queryPipelineDecisionLog, type PipelineDecisionLogRow } from "../d1Client.js";
import { PIPELINE_DECISION_LOG_SOURCES, didStopLossTouch, scoreBucket, type ScoreBucket } from "../pipelineDecisionLog.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtTime } from "../format.js";

const FORWARD_WINDOW_MS: Record<string, number> = {
  "1h": 3_600_000,
  "4h": 14_400_000,
  "24h": 86_400_000,
};

const KLINE_LIMIT: Record<string, number> = {
  "1h": 2,
  "4h": 5,
  "24h": 25,
};

// Dibatasi supaya 1 tool call tidak jadi puluhan kline lookup. Ambil
// baris TERBARU dalam range (query sudah ORDER BY run_at DESC).
const DEFAULT_ROWS = 50;
const MAX_ROWS = 80;

export interface PipelineForwardResult {
  entryPrice: number;
  exitPrice: number;
  forwardReturn: number;
  slTouch: boolean | null;
}

export interface BucketStats {
  sampleSize: number;
  winRate: number;
  avgReturn: number;
  slTouchRate: number | null;
  slTouchSample: number;
}

export function evaluateDecisionForward(candles: KlineTuple[], stopLoss: number | null): PipelineForwardResult | null {
  if (candles.length === 0) return null;
  const entryPrice = parseFloat(candles[0][4]);
  const exitPrice = parseFloat(candles[candles.length - 1][4]);
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice === 0) return null;
  const lows = candles.map((c) => parseFloat(c[3]));
  return {
    entryPrice,
    exitPrice,
    forwardReturn: (exitPrice - entryPrice) / entryPrice,
    slTouch: didStopLossTouch(lows, stopLoss),
  };
}

export function emptyBucket(): BucketStats {
  return { sampleSize: 0, winRate: 0, avgReturn: 0, slTouchRate: null, slTouchSample: 0 };
}

export function aggregateKeyedRows(
  rows: { key: string; forwardReturn: number; slTouch: boolean | null }[],
): Record<string, BucketStats> {
  const groups = new Map<string, { returns: number[]; slHits: number; slKnown: number }>();
  for (const r of rows) {
    let g = groups.get(r.key);
    if (!g) {
      g = { returns: [], slHits: 0, slKnown: 0 };
      groups.set(r.key, g);
    }
    g.returns.push(r.forwardReturn);
    if (r.slTouch !== null) {
      g.slKnown += 1;
      if (r.slTouch) g.slHits += 1;
    }
  }
  const out: Record<string, BucketStats> = {};
  for (const [key, g] of groups) {
    const winCount = g.returns.filter((x) => x > 0).length;
    out[key] = {
      sampleSize: g.returns.length,
      winRate: g.returns.length ? winCount / g.returns.length : 0,
      avgReturn: g.returns.length ? g.returns.reduce((a, b) => a + b, 0) / g.returns.length : 0,
      slTouchRate: g.slKnown ? g.slHits / g.slKnown : null,
      slTouchSample: g.slKnown,
    };
  }
  return out;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function fmtBucketTable(buckets: Record<string, BucketStats>, keys: string[]): string[][] {
  return keys.map((key) => {
    const b = buckets[key] ?? emptyBucket();
    return [
      key,
      String(b.sampleSize),
      b.sampleSize ? `${(b.winRate * 100).toFixed(1)}%` : "-",
      b.sampleSize ? fmtPct(b.avgReturn) : "-",
      b.slTouchRate == null ? "-" : `${(b.slTouchRate * 100).toFixed(1)}% (${b.slTouchSample})`,
    ];
  });
}

export function registerPipelineDecisionBacktestTools(server: McpServer): void {
  registerSafeTool(
    server,
    "whalescope_backtest_pipeline_decisions",
    {
      title: "Backtest Keputusan Full Pipeline (On-Demand)",
      description:
        "Uji maju keputusan yang tersimpan di pipeline_decision_log (entry-alert Phase 2 + persist manual/Dropstab). " +
        "Hitung forward return harga (close 1h) dan apakah low menyentuh stop-loss dalam jendela 1h/4h/24h. " +
        "Agregat per keputusan (TRADE/WATCH/NO_TRADE) dan bucket skor (lt_40 / 40_55 / gte_55). " +
        `Forward return ON-DEMAND dari klines, bukan kolom precompute. Default ${DEFAULT_ROWS} row terbaru, maks ${MAX_ROWS}. ` +
        "Ini uji formula terpasang -- TIDAK mengubah bobot ranking atau threshold 55.",
      inputSchema: {
        startTime: z.string().describe('Waktu mulai, ISO 8601 (contoh "2026-08-01T00:00:00Z")'),
        endTime: z.string().describe('Waktu akhir, ISO 8601 (contoh "2026-08-31T00:00:00Z")'),
        symbol: z.string().optional().describe("Filter satu symbol (opsional). Kosong = semua symbol dalam range."),
        source: z
          .enum(["all", ...PIPELINE_DECISION_LOG_SOURCES])
          .default("all")
          .describe("Filter sumber log: entry_alert (cron), manual, dropstab, atau all."),
        source_ref: z.string().max(128).optional().describe("Filter source_ref (slug tab Dropstab / label eksperimen)."),
        forwardWindow: z
          .enum(["1h", "4h", "24h"])
          .default("4h")
          .describe("Jendela forward return + SL-touch setelah run_at."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(80)
          .default(DEFAULT_ROWS)
          .describe(`Jumlah row terbaru yang diuji (default ${DEFAULT_ROWS}, maks ${MAX_ROWS}). Tiap row 1 kline lookup.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ startTime, endTime, symbol, source, source_ref, forwardWindow, limit }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        if (startMs === undefined || endMs === undefined || startMs >= endMs) {
          return errorResult(new Error("startTime harus lebih awal dari endTime, dan keduanya wajib diisi."));
        }

        const rows = await queryPipelineDecisionLog({
          startTime: startMs,
          endTime: endMs,
          symbol,
          source: source === "all" ? undefined : source,
          sourceRef: source_ref,
          limit,
        });

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Tidak ada row pipeline_decision_log dalam rentang itu. Cron entry-alert baru mulai isi setelah deploy, " +
                  "atau persist=true di whalescope_full_pipeline belum pernah dipakai. Cek startTime/endTime/source.",
              },
            ],
          };
        }

        const windowMs = FORWARD_WINDOW_MS[forwardWindow];
        const klineLimit = KLINE_LIMIT[forwardWindow];
        const evaluated: (PipelineDecisionLogRow & PipelineForwardResult & { scoreBucket: ScoreBucket })[] = [];

        for (const row of rows) {
          let candles: KlineTuple[] = [];
          try {
            candles = await binanceProxy.getKlinesNative(row.symbol, "1h", klineLimit, row.runAt, row.runAt + windowMs);
          } catch {
            continue;
          }
          const fwd = evaluateDecisionForward(candles, row.stopLoss);
          if (!fwd) continue;
          evaluated.push({ ...row, ...fwd, scoreBucket: scoreBucket(row.rankingScore) });
        }

        const byDecision = aggregateKeyedRows(evaluated.map((r) => ({ key: String(r.decision), forwardReturn: r.forwardReturn, slTouch: r.slTouch })));
        const byScore = aggregateKeyedRows(evaluated.map((r) => ({ key: r.scoreBucket, forwardReturn: r.forwardReturn, slTouch: r.slTouch })));
        const overall = aggregateKeyedRows(evaluated.map((r) => ({ key: "all", forwardReturn: r.forwardReturn, slTouch: r.slTouch }))).all ?? emptyBucket();

        const builder = new ToolResponseBuilder()
          .header("Backtest Keputusan Pipeline")
          .row("Forward Window", forwardWindow)
          .row("Rows in range", String(rows.length))
          .row("Evaluated (punya klines)", `${evaluated.length}`)
          .row("Overall win rate", overall.sampleSize ? `${(overall.winRate * 100).toFixed(1)}%` : "-")
          .row("Overall avg return", overall.sampleSize ? fmtPct(overall.avgReturn) : "-")
          .row(
            "Overall SL-touch",
            overall.slTouchRate == null ? "-" : `${(overall.slTouchRate * 100).toFixed(1)}% (${overall.slTouchSample})`,
          )
          .subheader("Per keputusan")
          .table(
            ["Keputusan", "N", "Win rate", "Avg return", "SL-touch"],
            fmtBucketTable(byDecision, ["TRADE", "WATCH", "NO_TRADE"]),
          )
          .subheader("Per bucket skor")
          .table(
            ["Bucket", "N", "Win rate", "Avg return", "SL-touch"],
            fmtBucketTable(byScore, ["lt_40", "40_55", "gte_55"]),
          );

        if (evaluated.length > 0) {
          builder.table(
            ["Waktu", "Symbol", "Keputusan", "Skor", `Return ${forwardWindow}`, "SL"],
            evaluated.slice(0, 15).map((r) => [
              fmtTime(r.runAt),
              r.symbol,
              String(r.decision),
              r.rankingScore.toFixed(1),
              fmtPct(r.forwardReturn),
              r.slTouch == null ? "-" : r.slTouch ? "yes" : "no",
            ]),
          );
        }

        builder.note(
          "Forward return = (close akhir jendela − close candle pertama) / close pertama. Bukan PnL grid, " +
            "bukan eksekusi order (slippage/fee tidak dihitung). Sample <20 = confidence rendah. " +
            "Hasil ini TIDAK menulis ulang bobot ranking atau threshold 55.",
        );

        return builder
          .struct("forwardWindow", forwardWindow)
          .struct("rowCount", rows.length)
          .struct("evaluatedCount", evaluated.length)
          .struct("overall", overall)
          .struct("byDecision", byDecision)
          .struct("byScoreBucket", byScore)
          .struct(
            "rows",
            evaluated.slice(0, 15).map((r) => ({
              runAt: r.runAt,
              symbol: r.symbol,
              source: r.source,
              sourceRef: r.sourceRef,
              decision: r.decision,
              rankingScore: r.rankingScore,
              scoreBucket: r.scoreBucket,
              forwardReturn: r.forwardReturn,
              slTouch: r.slTouch,
              stopLoss: r.stopLoss,
            })),
          )
          .build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
