import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as coinalyze from "../coinalyzeClient.js";
import { fmtNum, fmtTime } from "../format.js";
import { symbolSchema, PERIOD_ENUM, errorResult } from "../shared.js";

export function registerLiquidationTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // LIQUIDATION HISTORY
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_liquidation_history",
    {
      title: "Histori Liquidation",
      description:
        "Mengambil histori nilai liquidation (long dan short yang kena force-close) untuk sebuah pair Binance Futures " +
        "dalam rentang waktu tertentu (data via Coinalyze, sumber asli Binance). PENTING: ini data LAGGING/REAKTIF — " +
        "mencatat apa yang SUDAH terjadi, bukan sinyal arah ke depan. Long liquidation dominan = tekanan turun baru saja " +
        "menyapu posisi long (bisa berarti downtrend berlanjut ATAU seller sudah kehabisan tenaga — perlu konfirmasi " +
        "tambahan dari funding rate/OI/price action). Short liquidation dominan = kebalikannya untuk sisi atas. " +
        "Untuk deteksi stop hunt (docs/mm_detection_framework.md Section 4): PENTING, response ini TIDAK punya field " +
        "harga sama sekali (cuma total per window waktu) — cross-check manual dengan binance_get_klines di window waktu " +
        "yang sama untuk mapping ke level harga (wick candle).",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(PERIOD_ENUM)
          .default("1h")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(24).describe("Jumlah data poin histori yang diambil"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const bars = await coinalyze.getLiquidationHistory(symbol, period, limit);
        if (bars.length === 0) {
          return {
            content: [
              { type: "text", text: `Tidak ada data histori liquidation untuk ${symbol} pada period ${period}.` },
            ],
          };
        }

        const totalLong = bars.reduce((sum, b) => sum + b.l, 0);
        const totalShort = bars.reduce((sum, b) => sum + b.s, 0);
        const totalAll = totalLong + totalShort;
        const dominance =
          totalAll === 0
            ? "TIDAK ADA DATA"
            : totalLong > totalShort * 1.3
              ? "LONG DOMINAN (tekanan turun baru saja terjadi)"
              : totalShort > totalLong * 1.3
                ? "SHORT DOMINAN (tekanan naik baru saja terjadi)"
                : "SEIMBANG";

        const rows = bars
          .map((b) => `| ${fmtTime(b.t * 1000)} | ${fmtNum(b.l, 2)} | ${fmtNum(b.s, 2)} |`)
          .join("\n");

        const text = [
          `# Histori Liquidation — ${symbol} (period: ${period}, ${bars.length} data poin)`,
          ``,
          `**Total Long Liquidated**: ${fmtNum(totalLong, 2)}`,
          `**Total Short Liquidated**: ${fmtNum(totalShort, 2)}`,
          `**Dominasi window ini**: ${dominance}`,
          ``,
          `| Waktu | Long Liquidated | Short Liquidated |`,
          `|---|---|---|`,
          rows,
          ``,
          `_PENTING: data ini LAGGING (reaktif terhadap apa yang sudah terjadi), bukan sinyal arah ke depan. ` +
            `Jangan pakai sendirian untuk keputusan entry — kombinasikan dengan funding rate, OI trend, dan price action ` +
            `pada window waktu yang sama untuk interpretasi yang valid (misal: apakah ini akhir dari sebuah cascade, atau baru awal)._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, totalLong, totalShort, dominance },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
