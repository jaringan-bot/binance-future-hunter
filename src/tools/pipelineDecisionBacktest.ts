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
import { applyExecutionCost, DEFAULT_FEE_BPS, DEFAULT_SLIPPAGE_BPS } from "./backtest.js";

// ─────────────────────────────────────────────────────────────
// B1 + B2 (2026-09-04, Stage 1 signal-integrity) -- FORWARD WINDOW DIHITUNG
// DALAM CANDLE 5m, BUKAN KLINES 1h BER-startTime SEMBARANG.
//
// CACAT LAMA:
//   getKlinesNative(sym, "1h", 2, runAt, runAt + 1h)
// `runAt` adalah waktu tick cron (menit :07/:22/:37/:52), BUKAN batas jam.
// Binance mengembalikan candle dengan openTime >= startTime, jadi rentang
// [12:07, 13:07] cuma memuat SATU candle (openTime 13:00). Lalu:
//   entry = close(candles[0]);  exit = close(candles[len-1]);
// -> entry dan exit adalah candle YANG SAMA -> forwardReturn = 0 PERSIS,
// untuk SETIAP baris. Setelah applyExecutionCost jadi -0.12% seragam:
// win rate 0%, avg return -0.12%, selamanya. Window "1h" tidak pernah
// mengukur apa pun.
// Window 4h/24h tidak nol, tapi salah dua kali: candle pertama baru buka
// s/d 1 jam SETELAH keputusan (melewatkan jam pertama -- jam paling
// informatif), dan jumlah candle-nya kurang satu (4 candle = 3 jam dilabeli
// "4h"; 24 candle = 23 jam dilabeli "24h").
//
// SEKARANG: satu fetch 5m, entry = OPEN candle pertama yang buka pada/di
// atas runAt (lag <=5 menit, dan open bukan close -> TANPA look-ahead:
// harga itu benar-benar bisa dieksekusi setelah keputusan), exit = close
// candle ke-N. Jumlah subrequest TIDAK berubah (tetap 1 per row, di-slice
// tiga kali).
// ─────────────────────────────────────────────────────────────
export const FORWARD_INTERVAL = "5m";
const CANDLES_PER_HOUR = 12;
export const FORWARD_WINDOW_CANDLES: Record<string, number> = {
  "1h": 1 * CANDLES_PER_HOUR, // 12
  "4h": 4 * CANDLES_PER_HOUR, // 48
  "24h": 24 * CANDLES_PER_HOUR, // 288
};
/** Window terpanjang + 1 candle acuan -- satu fetch melayani ketiga window. */
export const FORWARD_FULL_WINDOW_CANDLES = FORWARD_WINDOW_CANDLES["24h"] + 1; // 289
export const FORWARD_FULL_WINDOW_MS = 24 * 3_600_000 + 5 * 60_000;

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

/**
 * Forward return dari deret candle 5m yang dimulai pada/di atas `runAt`.
 *
 * `candles` HARUS berisi tepat window yang mau diukur (caller yang
 * meng-slice). Entry = OPEN candle pertama -- bukan close-nya: close candle
 * pertama sudah memuat pergerakan setelah keputusan, memakainya sebagai
 * entry adalah look-ahead halus yang membuat hasil terlihat lebih baik dari
 * kenyataan. Exit = close candle terakhir.
 *
 * Butuh >= 2 candle: dengan 1 candle, entry dan exit berasal dari lilin yang
 * sama dan hasilnya bukan "return 0", melainkan "tidak terukur". Itu persis
 * cacat B1 yang lama -- return null, jangan pura-pura 0.
 */
export function evaluateDecisionForward(candles: KlineTuple[], stopLoss: number | null): PipelineForwardResult | null {
  if (candles.length < 2) return null;
  const entryPrice = parseFloat(candles[0][1]); // open
  const exitPrice = parseFloat(candles[candles.length - 1][4]); // close
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
        `Forward return dikurangi biaya eksekusi flat: fee_bps (default ${DEFAULT_FEE_BPS}) + slippage_bps (default ${DEFAULT_SLIPPAGE_BPS}), ` +
        "dikali 2 (entry+exit), sebelum win rate/avg return dihitung. Ini BUKAN replay order-book historis penuh -- market impact " +
        "per ukuran order & kedalaman book tidak dimodelkan (butuh depth snapshot historis, di luar scope). " +
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
        fee_bps: z
          .number()
          .min(0)
          .max(100)
          .default(DEFAULT_FEE_BPS)
          .describe(`Taker fee per sisi (bps). Default ${DEFAULT_FEE_BPS} (~0.04% Binance Futures). Dikurangi 2x dari tiap forward return (entry+exit).`),
        slippage_bps: z
          .number()
          .min(0)
          .max(500)
          .default(DEFAULT_SLIPPAGE_BPS)
          .describe(`Estimasi slippage/spread per sisi (bps). Default ${DEFAULT_SLIPPAGE_BPS}. Dikurangi 2x (entry+exit). Bukan hasil replay order-book historis.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ startTime, endTime, symbol, source, source_ref, forwardWindow, limit, fee_bps, slippage_bps }) => {
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

        const windowCandles = FORWARD_WINDOW_CANDLES[forwardWindow];
        const execCostRoundTrip = 2 * (fee_bps + slippage_bps) / 10_000;
        const evaluated: (PipelineDecisionLogRow &
          PipelineForwardResult & { grossReturn: number; scoreBucket: ScoreBucket })[] = [];

        for (const row of rows) {
          let candles: KlineTuple[] = [];
          try {
            // Selalu ambil window 5m PENUH (289 candle, 1 subrequest) lalu
            // slice -- sama seperti cron backfill, supaya angka on-demand di
            // sini IDENTIK dengan kolom forward_return_* yang dipersist.
            candles = await binanceProxy.getKlinesNative(
              row.symbol,
              FORWARD_INTERVAL,
              FORWARD_FULL_WINDOW_CANDLES,
              row.runAt,
              row.runAt + FORWARD_FULL_WINDOW_MS,
            );
          } catch {
            continue;
          }
          // +1: entry diambil dari OPEN candle ke-0, jadi window N jam butuh
          // N*12 candle SETELAH candle acuan itu tetap terhitung -- slice
          // (0, N+1) memberi open[0] .. close[N].
          const fwd = evaluateDecisionForward(candles.slice(0, windowCandles + 1), row.stopLoss);
          if (!fwd) continue;
          // evaluateDecisionForward TETAP mengembalikan gross (dipakai juga
          // oleh cron backfill yang mempersist angka mentah) -- biaya
          // eksekusi diterapkan di sini, di layer analisis, bukan di
          // fungsi/kolom yang dishare.
          evaluated.push({
            ...row,
            ...fwd,
            grossReturn: fwd.forwardReturn,
            forwardReturn: applyExecutionCost(fwd.forwardReturn, fee_bps, slippage_bps),
            scoreBucket: scoreBucket(row.rankingScore),
          });
        }

        const byDecision = aggregateKeyedRows(evaluated.map((r) => ({ key: String(r.decision), forwardReturn: r.forwardReturn, slTouch: r.slTouch })));
        const byScore = aggregateKeyedRows(evaluated.map((r) => ({ key: r.scoreBucket, forwardReturn: r.forwardReturn, slTouch: r.slTouch })));
        const overall = aggregateKeyedRows(evaluated.map((r) => ({ key: "all", forwardReturn: r.forwardReturn, slTouch: r.slTouch }))).all ?? emptyBucket();

        const builder = new ToolResponseBuilder()
          .header("Backtest Keputusan Pipeline")
          .row("Forward Window", forwardWindow)
          .row("Rows in range", String(rows.length))
          .row("Evaluated (punya klines)", `${evaluated.length}`)
          .row("Overall win rate (net)", overall.sampleSize ? `${(overall.winRate * 100).toFixed(1)}%` : "-")
          .row("Overall avg return (net)", overall.sampleSize ? fmtPct(overall.avgReturn) : "-")
          .row(
            "Overall SL-touch",
            overall.slTouchRate == null ? "-" : `${(overall.slTouchRate * 100).toFixed(1)}% (${overall.slTouchSample})`,
          )
          .row("Biaya eksekusi", `fee ${fee_bps}bps + slippage ${slippage_bps}bps per sisi -> ${(execCostRoundTrip * 100).toFixed(3)}% round-trip`)
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
            ["Waktu", "Symbol", "Keputusan", "Skor", `Gross ${forwardWindow}`, `Net ${forwardWindow}`, "SL"],
            evaluated.slice(0, 15).map((r) => [
              fmtTime(r.runAt),
              r.symbol,
              String(r.decision),
              r.rankingScore.toFixed(1),
              fmtPct(r.grossReturn),
              fmtPct(r.forwardReturn),
              r.slTouch == null ? "-" : r.slTouch ? "yes" : "no",
            ]),
          );
        }

        builder.note(
          "Forward return = (close akhir jendela − close candle pertama) / close pertama. Bukan PnL grid. " +
            `"Net" = sesudah dikurangi fee_bps+slippage_bps di entry & exit (flat ${(execCostRoundTrip * 100).toFixed(3)}% round-trip), ` +
            "BUKAN replay order-book historis -- market impact per ukuran order tidak dimodelkan. Sample <20 = confidence rendah. " +
            "Hasil ini TIDAK menulis ulang bobot ranking atau threshold 55.",
        );

        return builder
          .struct("forwardWindow", forwardWindow)
          .struct("feeBps", fee_bps)
          .struct("slippageBps", slippage_bps)
          .struct("execCostRoundTrip", execCostRoundTrip)
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
              grossReturn: r.grossReturn,
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
