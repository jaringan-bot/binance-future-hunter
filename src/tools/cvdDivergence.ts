// analyze_cvd_divergence -- pure calculation, TIDAK fetch dari Binance
// sendiri. spotTrades/futuresTrades diinjeksi caller (mis. hasil
// binance_get_agg_trades + binance_get_spot_agg_trades sebelumnya).
// Reuse computeCvdFromTrades (toolHelpers.ts) apa adanya untuk kedua leg --
// logic buy/sell-taker-via-field-m sudah diverifikasi ulang ke dokumentasi
// resmi Binance Futures & Spot (identik di kedua venue) sesi ini.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolSchema, aggTradeSchema, errorResultWithCode } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { computeCvdFromTrades, type CvdSummary } from "../toolHelpers.js";
import type { AggTrade } from "../binanceProxyClient.js";

export interface CvdDivergenceResult {
  spot: CvdSummary;
  futures: CvdSummary;
  divergence: number; // futures.buyPct - spot.buyPct, dalam poin persentase
  classification: "NEUTRAL" | "DIVERGENT";
  overlapRatio: number;
  errorCode?: "EMPTY_SPOT_TRADES" | "EMPTY_FUTURES_TRADES" | "MISALIGNED_WINDOWS";
}

function tradeSpan(trades: AggTrade[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const t of trades) {
    if (t.T < min) min = t.T;
    if (t.T > max) max = t.T;
  }
  return { min, max };
}

// NOTE (deviasi dari draft awal -- INI GANTI DEFINISI, BUKAN CUMA GANTI RUMUS):
// "avgMagnitude = (|spot.buyPct-50| + |futures.buyPct-50|)/2" gak stabil --
// kalau kedua buyPct sama-sama dekat 50%, avgMagnitude ikut mendekati nol,
// jadi rasio |divergence|/avgMagnitude malah BESAR walau divergence absolut
// kecil (kebalikan dari maksud "neutral"). Diganti perbandingan langsung:
// divergence (poin persentase buyPct) vs ambang neutralThresholdPct*100 --
// stabil di semua rentang buyPct.
//
// TAPI: 2 formula ini ngukur BESARAN BEDA SECARA UNIT -- versi lama itu
// rasio tanpa-dimensi relatif ke rata-rata magnitude CVD, versi baru ini
// selisih poin persentase proporsi buy/sell. neutralThresholdPct=0.05 yang
// SAMA gak otomatis berarti hal yang SAMA di kedua definisi. Nilai default
// 0.05 (5 poin persentase, mis. 52% vs 48% dianggap balanced) itu MASIH
// TEBAKAN, belum di-backtest ke data real -- klaim "arbitrer/belum
// divalidasi" sekarang berlaku dobel: bukan cuma angkanya, definisinya
// sendiri juga baru diganti tanpa validasi ulang. JANGAN pakai default ini
// buat keputusan trading nyata sebelum dicek terhadap histori pair yang
// relevan.
//
// UPDATE 2026-08-26 (probe #2-#5, lihat docs/mm_detection_framework.md):
// default DIGANTI ke 0.0536, TAPI validasinya TIMPANG antar pair:
//
// - BTCUSDT-class (N tinggi/likuid, ~17k-115k trades/window): TERVALIDASI
//   lewat 5 ronde probe window 5->60 menit. Spread divergence (noise murni
//   dari sampling window, BUKAN event decoupling spot-futures riil) turun
//   monoton 40.07 -> 23.66 -> 15.94 -> 7.98 -> 5.36 poin. 0.0536 = spread
//   penuh di window 60 menit (bukan setengah spread) -- dipilih FULL supaya
//   seluruh rentang divergence yang terbukti murni noise di sample ini
//   diklasifikasi NEUTRAL, cuma divergence yang MELEBIHI noise floor
//   ke-observasi yang di-flag DIVERGENT. Kekhawatiran trade-concentration
//   (top-3 trade dominasi CVD) sempat muncul di diagnosis awal tapi
//   terbukti ARTEFAK metrik (denominator net-CVD yang collapse ke 0 pas
//   flow balanced) -- metrik terkoreksi (top-3 notional / total notional)
//   nunjukin 0/24 leg BTCUSDT+DOGEUSDT ngelewatin 20% di window manapun.
// - DOGEUSDT-class (N rendah/less-liquid, ~1.7k-5.8k trades/window): window
//   60 menit DIADOPSI by EKSTRAPOLASI dari pola shrink BTCUSDT -- BELUM
//   diprobe independen di atas 30 menit (30-menit malah nunjukin spread
//   NAIK 18.20->24.40, non-monoton, beda arah dari BTCUSDT). Threshold
//   0.0536 yang sama juga BELUM divalidasi buat pair kelas ini. INI ASUMSI,
//   bukan hasil empirik -- revisit kalau sinyal divergence di pair
//   less-liquid terbukti gak reliable di praktik (mis. sering DIVERGENT
//   palsu atau kebalik dari price action).
export function computeCvdDivergence(
  spotTrades: AggTrade[],
  futuresTrades: AggTrade[],
  minOverlapRatio: number,
  neutralThresholdPct: number,
): CvdDivergenceResult {
  const empty: CvdSummary = { buyVolume: 0, sellVolume: 0, totalVolume: 0, buyPct: 0, cvd: 0 };

  if (spotTrades.length === 0) {
    return { spot: empty, futures: empty, divergence: 0, classification: "NEUTRAL", overlapRatio: 0, errorCode: "EMPTY_SPOT_TRADES" };
  }
  if (futuresTrades.length === 0) {
    return { spot: empty, futures: empty, divergence: 0, classification: "NEUTRAL", overlapRatio: 0, errorCode: "EMPTY_FUTURES_TRADES" };
  }

  const spotSpan = tradeSpan(spotTrades);
  const futuresSpan = tradeSpan(futuresTrades);
  const overlapStart = Math.max(spotSpan.min, futuresSpan.min);
  const overlapEnd = Math.min(spotSpan.max, futuresSpan.max);
  const overlapDuration = Math.max(0, overlapEnd - overlapStart);
  const spotDuration = spotSpan.max - spotSpan.min;
  const futuresDuration = futuresSpan.max - futuresSpan.min;
  const shorterSpan = Math.min(spotDuration, futuresDuration);
  const overlapRatio = shorterSpan > 0 ? overlapDuration / shorterSpan : overlapDuration >= 0 && overlapEnd >= overlapStart ? 1 : 0;

  if (overlapRatio < minOverlapRatio) {
    return { spot: empty, futures: empty, divergence: 0, classification: "NEUTRAL", overlapRatio, errorCode: "MISALIGNED_WINDOWS" };
  }

  const spot = computeCvdFromTrades(spotTrades);
  const futures = computeCvdFromTrades(futuresTrades);
  const divergence = futures.buyPct - spot.buyPct;
  const classification: "NEUTRAL" | "DIVERGENT" = Math.abs(divergence) < neutralThresholdPct * 100 ? "NEUTRAL" : "DIVERGENT";

  return { spot, futures, divergence, classification, overlapRatio };
}

export function registerCvdDivergenceTools(server: McpServer): void {
  registerSafeTool(
    server,
    "analyze_cvd_divergence",
    {
      title: "CVD Divergence Spot vs Futures",
      description:
        "Bandingkan Cumulative Volume Delta (taker buy - taker sell) antara Spot dan Futures dari agg-trades yang " +
        "di-supply caller (BUKAN fetch sendiri -- pass hasil binance_get_agg_trades + binance_get_spot_agg_trades). " +
        "Reject kalau window waktu kedua array gak cukup overlap (minOverlapRatio). " +
        "Rekomendasi window (empirikal, probe #2-#5 2026-08-26, lihat docs/mm_detection_framework.md): 60 menit " +
        "kontinu untuk pair likuid/N-tinggi (BTCUSDT-class, TERVALIDASI 5 ronde probe). Pair kurang likuid/N-rendah " +
        "(DOGEUSDT-class) pakai 60 menit by EKSTRAPOLASI, BELUM diprobe independen di atas 30 menit -- anggap asumsi.",
      inputSchema: {
        symbol: symbolSchema.optional().describe("Label header saja -- kalkulasi divergence-nya sendiri symbol-agnostic."),
        spotTrades: z.array(aggTradeSchema).max(5000).describe("Agg-trades Spot (binance_get_spot_agg_trades)."),
        futuresTrades: z.array(aggTradeSchema).max(5000).describe("Agg-trades Futures (binance_get_agg_trades)."),
        minOverlapRatio: z
          .number()
          .min(0)
          .max(1)
          .default(0.8)
          .describe("Minimum rasio overlap window waktu (T field) kedua array supaya dianggap sebanding, default 0.8."),
        neutralThresholdPct: z
          .number()
          .min(0)
          .default(0.0536)
          .describe(
            "Rasio (bukan literal persen) -- divergence buyPct di bawah ambang*100 poin persentase diklasifikasi NEUTRAL. " +
              "Default 0.0536 (5.36 poin persentase) = noise-floor spread empirik BTCUSDT window 60-menit (probe " +
              "#2-#5, 2026-08-26, lihat docs/mm_detection_framework.md) -- TERVALIDASI cuma untuk pair likuid/N-tinggi " +
              "sekelas BTCUSDT. Pair kurang likuid/N-rendah (DOGEUSDT-class) pakai default ini by EKSTRAPOLASI, BELUM " +
              "divalidasi independen -- backtest ulang sebelum dipakai buat keputusan trading nyata di pair itu.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ symbol, spotTrades, futuresTrades, minOverlapRatio, neutralThresholdPct }) => {
      const result = computeCvdDivergence(spotTrades, futuresTrades, minOverlapRatio, neutralThresholdPct);

      if (result.errorCode) {
        const messages: Record<string, string> = {
          EMPTY_SPOT_TRADES: `Array spotTrades kosong${symbol ? ` untuk ${symbol}` : ""}.`,
          EMPTY_FUTURES_TRADES: `Array futuresTrades kosong${symbol ? ` untuk ${symbol}` : ""}.`,
          MISALIGNED_WINDOWS: `Window waktu spotTrades dan futuresTrades gak cukup overlap (rasio ${result.overlapRatio.toFixed(2)} < ${minOverlapRatio}) -- gak bisa dibandingkan secara adil.`,
        };
        return errorResultWithCode(result.errorCode, messages[result.errorCode], { symbol, overlapRatio: result.overlapRatio });
      }

      const builder = new ToolResponseBuilder()
        .header(`CVD Divergence${symbol ? ` — ${symbol}` : ""}`)
        .row("Klasifikasi", result.classification)
        .row("Divergence (buyPct futures - spot)", `${result.divergence.toFixed(2)} poin`)
        .row("Overlap Ratio", result.overlapRatio.toFixed(2))
        .row("Spot Buy %", `${result.spot.buyPct.toFixed(1)}%`)
        .row("Futures Buy %", `${result.futures.buyPct.toFixed(1)}%`)
        .row("Spot CVD", result.spot.cvd.toFixed(4))
        .row("Futures CVD", result.futures.cvd.toFixed(4))
        .struct("symbol", symbol)
        .struct("classification", result.classification)
        .struct("divergence", result.divergence)
        .struct("overlapRatio", result.overlapRatio)
        .struct("spot", result.spot)
        .struct("futures", result.futures);

      return builder.build();
    },
  );
}
