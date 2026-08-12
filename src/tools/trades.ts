import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtPrice, fmtTime } from "../format.js";
import { symbolSchema, FUTURES_DATA_PERIOD_ENUM, errorResult } from "../shared.js";
import { computeCvdFromTrades, truncateRows } from "../toolHelpers.js";

export function registerTradesTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // AGGREGATE TRADES / CVD GRANULAR
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_agg_trades",
    {
      title: "Aggregate Trades (untuk CVD Granular)",
      description:
        "Mengambil trade individual terbaru (aggregate trades) LANGSUNG dari Binance lewat proxy relay, termasuk apakah masing- " +
        "masing trade adalah buy atau sell aggressor (taker). Berbeda dari binance_get_taker_volume_ratio yang teragregasi per-jam, " +
        "ini granular per-trade — cocok untuk mendeteksi absorption (harga stagnan tapi volume besar masuk searah, indikasi entitas " +
        "besar menyerap likuiditas tanpa menggerakkan harga secara signifikan) atau lonjakan agresi mendadak. " +
        "PENTING: limit maksimal dibatasi ketat karena ini data granular, tidak cocok untuk analisis periode panjang — gunakan " +
        "binance_get_taker_volume_ratio untuk gambaran periode lebih panjang.",
      inputSchema: {
        symbol: symbolSchema,
        limit: z.number().int().min(1).max(200).default(50).describe("Jumlah trade terakhir yang diambil, maksimal 200."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit }) => {
      try {
        const trades = await binanceProxy.getAggTrades(symbol, limit);
        if (trades.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data trade untuk ${symbol}.` }] };
        }

        const { buyVolume, sellVolume, buyPct, cvd } = computeCvdFromTrades(trades);

        const recent = trades.slice(-15);
        const rows = recent
          .map((t) => {
            const side = t.m ? "SELL (taker)" : "BUY (taker)";
            return `| ${fmtTime(t.T)} | ${fmtPrice(parseFloat(t.p))} | ${fmtNum(parseFloat(t.q), 4)} | ${side} |`;
          })
          .join("\n");

        const text = [
          `# Aggregate Trades — ${symbol} (${trades.length} trade terakhir)`,
          ``,
          `**CVD window ini**: ${cvd >= 0 ? "+" : ""}${fmtNum(cvd, 4)} (Buy: ${fmtNum(buyVolume, 4)} / Sell: ${fmtNum(sellVolume, 4)})`,
          `**Dominasi**: ${buyPct.toFixed(1)}% BUY vs ${(100 - buyPct).toFixed(1)}% SELL`,
          ``,
          `## ${recent.length} Trade Terakhir`,
          `| Waktu | Harga | Quantity | Sisi |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_CVD positif = tekanan beli agresif dominan di window ini. CVD negatif = tekanan jual agresif dominan. Window ini sangat pendek (${trades.length} trade) — untuk gambaran lebih luas, kombinasikan dengan binance_get_taker_volume_ratio._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, cvd, buyVolume, sellVolume, buyPct },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  server.registerTool(
    "binance_get_taker_volume_ratio",
    {
      title: "Taker Buy/Sell Volume Ratio",
      description:
        "Mengambil rasio volume taker buy vs sell — proxy tekanan beli/jual AGRESIF (market order), berbeda dari long/short ratio " +
        "yang berbasis posisi terbuka (LANGSUNG dari Binance native takerlongshortRatio, bukan lagi diturunkan manual dari volume " +
        "candlestick Coinalyze — source of truth). Berguna sebagai konfirmasi tambahan: apakah tekanan eksekusi market saat ini " +
        "condong beli atau jual.",
      inputSchema: {
        symbol: symbolSchema,
        period: z.enum(FUTURES_DATA_PERIOD_ENUM).default("15m"),
        limit: z.number().int().min(1).max(500).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const points = await binanceProxy.getTakerLongShortRatioNative(symbol, period, limit);
        if (points.length === 0) {
          return {
            content: [{ type: "text", text: `Tidak ada data taker volume untuk ${symbol}.` }],
          };
        }
        const ratios = points.map((p) => parseFloat(p.buySellRatio));
        const ratio = ratios[ratios.length - 1];
        const bias = ratio > 1.05 ? "BUY dominan" : ratio < 0.95 ? "SELL dominan" : "seimbang";

        const { shown, totalCount, truncated } = truncateRows(points);
        const rows = shown
          .map((p) => `| ${fmtTime(p.timestamp)} | ${fmtNum(parseFloat(p.buySellRatio), 4)} |`)
          .join("\n");

        const text = [
          `# Taker Buy/Sell Ratio — ${symbol} (period: ${period})`,
          ``,
          `**Rasio terkini**: ${fmtNum(ratio, 4)} → tekanan ${bias}`,
          `(ratio > 1 = volume buy lebih besar dari sell, < 1 = sebaliknya)`,
          ``,
          truncated ? `_Menampilkan ${shown.length} terakhir dari ${totalCount} total._` : ``,
          `| Waktu | Buy/Sell Ratio |`,
          `|---|---|`,
          rows,
          ``,
          `_Data LANGSUNG dari Binance native (takerlongshortRatio) — buySellRatio dihitung resmi oleh Binance, bukan derivasi manual dari candlestick._`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
