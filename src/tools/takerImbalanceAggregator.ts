// taker_imbalance_aggregator -- pure calculation, TIDAK fetch dari Binance
// sendiri. trades diinjeksi caller (mis. hasil binance_get_agg_trades /
// binance_get_spot_agg_trades sebelumnya), sama pola Option A dengan
// analyze_cvd_divergence dan filter_block_trades. Reuse computeCvdFromTrades
// (toolHelpers.ts) buat buy/sell qty + buyPct, biar konvensi field m
// (buyer-maker -> sell-taker) SATU tempat, gak reimplement.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolSchema, aggTradeSchema, errorResultWithCode } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { computeCvdFromTrades } from "../toolHelpers.js";
import type { AggTrade } from "../binanceProxyClient.js";

// KEPUTUSAN DESAIN: lookback_trades (jumlah trade tetap), BUKAN
// window_seconds (durasi waktu tetap). Order flow crypto gak merata
// sepanjang waktu -- window waktu tetap nangkep ribuan trade pas
// volatilitas/news (whale/MM signal ke-dilusi noise retail) tapi cuma 1-2
// trade pas sepi (rasio imbalance gak bermakna statistik). Jumlah trade
// tetap jaga ukuran sample -- makanya reliabilitas -- konstan berapapun
// tingkat aktivitas market. Ini mirror persis masalah yang udah kebukti
// empirik di probe CVD (analyze_cvd_divergence): DOGEUSDT N rendah di
// window waktu tetap ngasih spread yang gak monoton/gak reliable
// dibanding BTCUSDT N tinggi.
export interface TakerImbalanceResult {
  buyQty: number;
  sellQty: number;
  totalQty: number;
  buyPct: number; // 0-100, konvensi SAMA dengan computeCvdFromTrades/analyze_cvd_divergence
  imbalanceScore: number; // -1..1, = cvd/totalQty (versi ternormalisasi dari cvd yang sama)
  tradesUsed: number;
  oldestTradeTime: number;
  newestTradeTime: number;
  lookbackSpanSeconds: number;
  stale: boolean;
  errorCode?: "EMPTY_TRADES" | "INVALID_TRADE_DATA" | "INSUFFICIENT_TRADES" | "TRADES_NOT_CHRONOLOGICAL";
}

const EMPTY: Omit<TakerImbalanceResult, "errorCode"> = {
  buyQty: 0,
  sellQty: 0,
  totalQty: 0,
  buyPct: 0,
  imbalanceScore: 0,
  tradesUsed: 0,
  oldestTradeTime: 0,
  newestTradeTime: 0,
  lookbackSpanSeconds: 0,
  stale: false,
};

function isValidTrade(t: AggTrade): boolean {
  return Number.isFinite(parseFloat(t.q)) && Number.isFinite(t.T);
}

// Precondition sama kayak analyze_cvd_divergence (T field ordering): trades
// HARUS chronological (non-decreasing T), format native Binance. Beda dari
// CVD -- di sini bukan cuma soal fair comparison, tapi trades.slice(-N)
// buat ambil N trade PALING BARU cuma valid kalau array beneran urut waktu
// naik. Kalau kebalik/acak, "N trade terakhir" secara array-index bisa jadi
// N trade PALING LAMA -- keliru diam-diam, makanya di-reject keras, bukan
// di-sort ulang sendiri (silent-fix bisa nutupin bug di sisi caller).
function isChronological(trades: AggTrade[]): boolean {
  for (let i = 1; i < trades.length; i++) {
    if (trades[i].T < trades[i - 1].T) return false;
  }
  return true;
}

export function computeTakerImbalance(trades: AggTrade[], lookbackTrades: number, maxLookbackSeconds: number): TakerImbalanceResult {
  if (trades.length === 0) {
    return { ...EMPTY, errorCode: "EMPTY_TRADES" };
  }

  if (!trades.every(isValidTrade)) {
    return { ...EMPTY, errorCode: "INVALID_TRADE_DATA" };
  }

  if (!isChronological(trades)) {
    return { ...EMPTY, errorCode: "TRADES_NOT_CHRONOLOGICAL" };
  }

  if (trades.length < lookbackTrades) {
    return { ...EMPTY, tradesUsed: trades.length, errorCode: "INSUFFICIENT_TRADES" };
  }

  const window = trades.slice(-lookbackTrades);
  const summary = computeCvdFromTrades(window);

  const oldestTradeTime = window[0].T;
  const newestTradeTime = window[window.length - 1].T;
  const lookbackSpanSeconds = (newestTradeTime - oldestTradeTime) / 1000;
  const stale = lookbackSpanSeconds > maxLookbackSeconds;
  const imbalanceScore = summary.totalVolume > 0 ? summary.cvd / summary.totalVolume : 0;

  return {
    buyQty: summary.buyVolume,
    sellQty: summary.sellVolume,
    totalQty: summary.totalVolume,
    buyPct: summary.buyPct,
    imbalanceScore,
    tradesUsed: window.length,
    oldestTradeTime,
    newestTradeTime,
    lookbackSpanSeconds,
    stale,
  };
}

export function registerTakerImbalanceAggregatorTools(server: McpServer): void {
  registerSafeTool(
    server,
    "taker_imbalance_aggregator",
    {
      title: "Taker Imbalance Aggregator (Event-Domain Sampling)",
      description:
        "Hitung rasio taker buy vs taker sell dari N trade PALING BARU (lookback_trades, bukan window waktu tetap) " +
        "dari agg-trades yang di-supply caller (BUKAN fetch sendiri -- pass hasil binance_get_agg_trades / " +
        "binance_get_spot_agg_trades). Event-domain sampling (jumlah trade tetap) dipilih ketimbang time-domain " +
        "(durasi tetap) supaya ukuran sample -- dan reliabilitas statistik -- konsisten di kondisi market rame " +
        "maupun sepi; lihat komentar kode buat rasional lengkap dan link ke probe CVD yang buktiin masalah ini.",
      inputSchema: {
        symbol: symbolSchema.optional().describe("Label header saja -- kalkulasinya sendiri symbol-agnostic."),
        trades: z
          .array(aggTradeSchema)
          .max(5000)
          .describe("Agg-trades URUT WAKTU NAIK (T non-decreasing), format native Binance (binance_get_agg_trades / binance_get_spot_agg_trades)."),
        lookbackTrades: z
          .number()
          .int()
          .positive()
          .default(500)
          .describe(
            "Jumlah trade PALING BARU yang dipakai (event-domain, bukan durasi waktu). Default 500 -- BELUM ADA " +
              "VALIDASI EMPIRIK buat angka spesifik ini (beda dari window 60-menit analyze_cvd_divergence yang " +
              "sudah diprobe 5 ronde). 500 dipilih sebagai angka bulat order-of-magnitude yang lebih kecil dari N " +
              "30-menit TERKECIL yang teramati di probe CVD buat pair kurang likuid (DOGEUSDT ~1770-5821 trade/window, " +
              "lihat docs/mm_detection_framework.md) -- supaya kemungkinan besar tetap fillable bahkan di pair " +
              "less-liquid, BUKAN hasil analisis statistik soal N optimal buat kualitas sinyal imbalance. Butuh probe " +
              "series sendiri sebelum dianggap tervalidasi, sama seperti asumsi DOGEUSDT-class di CVD.",
          ),
        maxLookbackSeconds: z
          .number()
          .positive()
          .default(3600)
          .describe(
            "Ambang staleness (detik) -- kalau rentang waktu buat ngumpulin lookbackTrades (trade terbaru dikurangi " +
              "trade terlama di window) MELEBIHI ini, hasil di-flag stale=true (bukan reject keras -- tetap dihitung, " +
              "tapi ditandai low-confidence). Default 3600 (60 menit) REUSE angka window terluas yang SUDAH divalidasi " +
              "empirik di probe CVD analyze_cvd_divergence (fenomena sama: taker order flow) -- BUKAN angka yang " +
              "diprobe khusus buat tool ini, cuma ceiling yang masuk akal by analogi.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ symbol, trades, lookbackTrades, maxLookbackSeconds }) => {
      const result = computeTakerImbalance(trades, lookbackTrades, maxLookbackSeconds);

      if (result.errorCode) {
        const messages: Record<string, string> = {
          EMPTY_TRADES: `Array trades kosong${symbol ? ` untuk ${symbol}` : ""}.`,
          INVALID_TRADE_DATA: `Ada trade dengan field q atau T tidak valid (NaN)${symbol ? ` untuk ${symbol}` : ""} -- payload ditolak, bukan di-skip diam-diam.`,
          TRADES_NOT_CHRONOLOGICAL: `Array trades TIDAK urut waktu naik (T non-decreasing)${symbol ? ` untuk ${symbol}` : ""} -- slice(-lookbackTrades) gak valid dipakai buat ambil trade "paling baru".`,
          INSUFFICIENT_TRADES: `Trade tersedia (${result.tradesUsed}) kurang dari lookbackTrades yang diminta${symbol ? ` untuk ${symbol}` : ""} -- gak dihitung pakai N lebih kecil diam-diam.`,
        };
        return errorResultWithCode(result.errorCode, messages[result.errorCode], { symbol, tradesAvailable: result.tradesUsed });
      }

      const builder = new ToolResponseBuilder()
        .header(`Taker Imbalance${symbol ? ` — ${symbol}` : ""}`)
        .row("Trades Used (lookback)", String(result.tradesUsed))
        .row("Buy Qty", result.buyQty.toFixed(4))
        .row("Sell Qty", result.sellQty.toFixed(4))
        .row("Buy %", `${result.buyPct.toFixed(2)}%`)
        .row("Imbalance Score (-1..1)", result.imbalanceScore.toFixed(4))
        .row("Lookback Span", `${result.lookbackSpanSeconds.toFixed(1)}s`);

      if (result.stale) {
        builder.warning(
          `Lookback span (${result.lookbackSpanSeconds.toFixed(1)}s) MELEBIHI maxLookbackSeconds (${maxLookbackSeconds}s) -- ` +
            `market kemungkinan sepi/illiquid, hasil low-confidence (bukan invalid, cuma perlu N trade lebih banyak waktu buat kejadian).`,
        );
      }

      builder
        .struct("symbol", symbol)
        .struct("tradesUsed", result.tradesUsed)
        .struct("buyQty", result.buyQty)
        .struct("sellQty", result.sellQty)
        .struct("totalQty", result.totalQty)
        .struct("buyPct", result.buyPct)
        .struct("imbalanceScore", result.imbalanceScore)
        .struct("oldestTradeTime", result.oldestTradeTime)
        .struct("newestTradeTime", result.newestTradeTime)
        .struct("lookbackSpanSeconds", result.lookbackSpanSeconds)
        .struct("stale", result.stale);

      return builder.build();
    },
  );
}
