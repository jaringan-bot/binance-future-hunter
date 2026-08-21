import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtPrice, fmtTime } from "../format.js";
import { symbolSchema, FUTURES_DATA_PERIOD_ENUM, errorResult, detailParam } from "../shared.js";
import { computeCvdFromTrades, truncateRows } from "../toolHelpers.js";

export function registerTradesTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // AGGREGATE TRADES / CVD GRANULAR
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_agg_trades",
    {
      title: "Aggregate Trades (untuk CVD Granular)",
      description:
        "Trade individual terbaru (aggregate trades), granular per-trade, termasuk sisi buy/sell aggressor -- cocok " +
        "deteksi absorption (harga stagnan tapi volume besar searah) atau lonjakan agresi mendadak. Beda dari " +
        "binance_get_taker_volume_ratio (teragregasi per-jam). Limit maks 200, bukan untuk periode panjang. " +
        "Default ringkas (CVD + 15 trade terakhir di teks); `detail: \"full\"` untuk array trade mentah lengkap.",
      inputSchema: {
        symbol: symbolSchema,
        limit: z.number().int().min(1).max(200).default(50).describe("Jumlah trade terakhir yang diambil, maksimal 200."),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit, detail }) => {
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
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            cvd,
            buyVolume,
            sellVolume,
            buyPct,
            ...(detail === "full" ? { trades } : {}),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  registerSafeTool(
    server,
    "binance_get_taker_volume_ratio",
    {
      title: "Taker Buy/Sell Volume Ratio",
      description:
        "Rasio volume taker buy vs sell -- proxy tekanan beli/jual AGRESIF (market order), beda dari long/short " +
        "ratio yang berbasis posisi terbuka. LANGSUNG dari Binance native takerlongshortRatio. Default ringkas " +
        "(rasio terkini + <=10 poin terbaru); `detail: \"full\"` untuk histori lengkap sesuai `limit`.",
      inputSchema: {
        symbol: symbolSchema,
        period: z.enum(FUTURES_DATA_PERIOD_ENUM).default("15m"),
        limit: z.number().int().min(1).max(500).default(10),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit, detail }) => {
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
          truncated ? `_Menampilkan ${shown.length} terakhir dari ${totalCount}._` : ``,
          `| Waktu | Buy/Sell Ratio |`,
          `|---|---|`,
          rows,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            ratio,
            bias,
            ...(detail === "full" ? { points } : { recent: shown }),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
