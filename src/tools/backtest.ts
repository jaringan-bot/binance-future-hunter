// binance_backtest_signal — validasi empiris skor sinyal binance_detect_mm_activity
// yang di-snapshot Cron tiap 5 menit ke D1 (signal_history, lihat
// computeMmSignals di detectMmActivity.ts + scheduled() di index.ts).
//
// ADAPTASI dari desain awal (whalescope_mcp_roadmap.md Bagian 4.4.A):
// forward return DIHITUNG ON-DEMAND di sini dari klines historis (bukan
// di-precompute & disimpan kolom forward_return_* di D1) -- klines Binance
// gak ada batas retensi kayak OI history, jadi gak perlu cron kedua yang
// "isi ulang" kolom itu belakangan. Trade-off: tiap baris sinyal aktif
// butuh 2 kline lookup (entry + exit), jadi jumlah baris yang diproses
// DIBATASI (MAX_ROWS) supaya gak meledak jadi ratusan network call per
// tool call.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as binanceProxy from "../binanceProxyClient.js";
import { errorResult, parseTimeParam, SNAPSHOT_WATCHLIST } from "../shared.js";
import { querySignalHistory, type SignalHistoryRow } from "../d1Client.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtTime } from "../format.js";

const SIGNAL_TYPE_ENUM = [
  "absorption",
  "spoofing",
  "stopHunt",
  "basisArb",
  "oiDivergence",
  "fundingExtreme",
  "all",
] as const;

const FORWARD_WINDOW_MS: Record<string, number> = {
  "1h": 3_600_000,
  "4h": 14_400_000,
  "24h": 86_400_000,
};

// Threshold "sinyal aktif" sama persis dengan activeSignals di
// binance_detect_mm_activity -- cuma baris yang dianggap sinyal beneran
// yang divalidasi, bukan semua snapshot (kebanyakan snapshot skornya
// rendah/tidak aktif, gak relevan buat backtest).
const ACTIVE_SCORE_THRESHOLD = 0.6;

// Dibatasi supaya tool call gak melakukan ratusan kline lookup sekaligus
// (2 lookup per baris aktif). Ambil MAX_ROWS baris TERBARU dalam range.
const MAX_ROWS = 50;

export interface BacktestAggregate {
  winRate: number;
  avgReturn: number;
  maxDrawdown: number;
  sampleSize: number;
}

export function aggregateBacktestResults(rows: { forwardReturn: number }[]): BacktestAggregate {
  if (rows.length === 0) return { winRate: 0, avgReturn: 0, maxDrawdown: 0, sampleSize: 0 };

  const returns = rows.map((r) => r.forwardReturn);
  const winCount = returns.filter((r) => r > 0).length;
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const maxDrawdown = Math.min(...returns);

  return {
    winRate: winCount / returns.length,
    avgReturn,
    maxDrawdown,
    sampleSize: returns.length,
  };
}

async function priceNear(symbol: string, timestamp: number): Promise<number | null> {
  const candles = await binanceProxy.getKlinesNative(symbol, "1h", 1, timestamp, timestamp + 3_600_000);
  const candle = candles[0];
  return candle ? parseFloat(candle[4]) : null; // close
}

export function registerBacktestTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_backtest_signal",
    {
      title: "Backtest Sinyal MM Detection (Empiris)",
      description:
        "Validasi empiris sinyal binance_detect_mm_activity: ambil snapshot sinyal aktif (skor >=0.6) yang " +
        "tersimpan di D1 (diisi Cron tiap 5 menit untuk watchlist tetap) dalam rentang waktu tertentu, hitung " +
        "forward return (harga N jam setelah sinyal vs saat sinyal) per baris, lalu agregat win rate/avg " +
        "return/max drawdown. Forward return dihitung ON-DEMAND dari klines historis saat tool dipanggil (bukan " +
        `data pre-computed). Dibatasi maksimal ${MAX_ROWS} baris paling baru dalam range per panggilan (tiap baris ` +
        "butuh 2 kline lookup). HANYA symbol watchlist tetap yang punya histori sinyal tersimpan.",
      inputSchema: {
        symbol: z.enum(SNAPSHOT_WATCHLIST).describe(`Symbol dari watchlist tetap: ${SNAPSHOT_WATCHLIST.join(", ")}`),
        signalType: z.enum(SIGNAL_TYPE_ENUM).default("all").describe("Filter jenis sinyal, atau 'all' untuk semua"),
        startTime: z.string().describe('Waktu mulai, ISO 8601 (contoh "2026-08-01T00:00:00Z")'),
        endTime: z.string().describe('Waktu akhir, ISO 8601 (contoh "2026-08-12T00:00:00Z")'),
        forwardWindow: z
          .enum(["1h", "4h", "24h"])
          .default("4h")
          .describe("Jendela forward return yang dihitung setelah tiap sinyal trigger"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, signalType, startTime, endTime, forwardWindow }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        if (startMs === undefined || endMs === undefined || startMs >= endMs) {
          return errorResult(new Error("startTime harus lebih awal dari endTime, dan keduanya wajib diisi."));
        }

        const allRows = await querySignalHistory(symbol, signalType, startMs, endMs);
        const activeRows = allRows.filter((r) => r.score >= ACTIVE_SCORE_THRESHOLD).slice(-MAX_ROWS);

        if (activeRows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Tidak ada snapshot sinyal aktif (skor >=${ACTIVE_SCORE_THRESHOLD}) untuk ${symbol}${signalType !== "all" ? ` (${signalType})` : ""} dalam rentang waktu itu. Cek dulu rentang waktunya masuk akal (Cron baru mulai isi data setelah fitur ini deploy) atau coba symbol/signalType lain.`,
              },
            ],
          };
        }

        const windowMs = FORWARD_WINDOW_MS[forwardWindow];
        const withReturns: (SignalHistoryRow & { forwardReturn: number; entryPrice: number; exitPrice: number })[] = [];

        for (const row of activeRows) {
          const [entryPrice, exitPrice] = await Promise.all([
            priceNear(symbol, row.timestamp),
            priceNear(symbol, row.timestamp + windowMs),
          ]);
          if (entryPrice === null || exitPrice === null || entryPrice === 0) continue;
          withReturns.push({ ...row, entryPrice, exitPrice, forwardReturn: (exitPrice - entryPrice) / entryPrice });
        }

        const aggregate = aggregateBacktestResults(withReturns);

        const builder = new ToolResponseBuilder()
          .header(`Backtest Sinyal — ${symbol}${signalType !== "all" ? ` (${signalType})` : ""}`)
          .row("Forward Window", forwardWindow)
          .row("Sample Size", `${aggregate.sampleSize} sinyal aktif (dari ${activeRows.length} kandidat, ${allRows.length} total snapshot dalam range)`)
          .row("Win Rate", `${(aggregate.winRate * 100).toFixed(1)}%`)
          .row("Avg Forward Return", `${(aggregate.avgReturn * 100).toFixed(2)}%`)
          .row("Max Drawdown", `${(aggregate.maxDrawdown * 100).toFixed(2)}%`);

        if (withReturns.length > 0) {
          builder.table(
            ["Waktu", "Tipe", "Skor", `Return ${forwardWindow}`],
            withReturns
              .slice(-15)
              .map((r) => [fmtTime(r.timestamp), r.signalType, r.score.toFixed(2), `${(r.forwardReturn * 100).toFixed(2)}%`]),
          );
        }

        builder
          .note(
            `Sample size kecil (<20) berarti confidence rendah -- jangan simpulkan "sinyal ini reliable" dari sedikit data. Forward return dihitung dari close candle 1h terdekat ke waktu target, BUKAN eksekusi order riil (slippage/fee tidak dihitung).`,
          )
          .struct("symbol", symbol)
          .struct("signalType", signalType)
          .struct("forwardWindow", forwardWindow)
          .struct("aggregate", aggregate)
          .struct("candidateCount", activeRows.length)
          .struct("totalSnapshotsInRange", allRows.length);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
