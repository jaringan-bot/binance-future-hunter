import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import * as coinalyze from "../coinalyzeClient.js";
import { fmtNum, fmtTime } from "../format.js";
import { symbolSchema, PERIOD_ENUM, errorResult, detailParam } from "../shared.js";
import { truncateRows } from "../toolHelpers.js";

export function registerLiquidationTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // LIQUIDATION HISTORY
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_liquidation_history",
    {
      title: "Histori Liquidation",
      description:
        "Histori nilai liquidation (long/short force-close) per window waktu (via Coinalyze, sumber Binance). " +
        "PENTING: data LAGGING/REAKTIF (bukan sinyal arah ke depan), TIDAK punya field harga -- cross-check dengan " +
        "binance_get_klines untuk mapping ke level harga (docs/mm_detection_framework.md Section 4). Default " +
        "ringkas (total + dominance + <=10 poin terbaru); `detail: \"full\"` untuk histori lengkap.",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(PERIOD_ENUM)
          .default("1h")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(24).describe("Jumlah data poin histori yang diambil"),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit, detail }) => {
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

        const { shown, totalCount, truncated } = truncateRows(bars);
        const rows = shown
          .map((b) => `| ${fmtTime(b.t * 1000)} | ${fmtNum(b.l, 2)} | ${fmtNum(b.s, 2)} |`)
          .join("\n");

        const text = [
          `# Histori Liquidation — ${symbol} (period: ${period}, ${bars.length} data poin)`,
          ``,
          `**Total Long Liquidated**: ${fmtNum(totalLong, 2)}`,
          `**Total Short Liquidated**: ${fmtNum(totalShort, 2)}`,
          `**Dominasi window ini**: ${dominance}`,
          ``,
          truncated ? `_Menampilkan ${shown.length} terakhir dari ${totalCount} total (total long/short & dominasi di atas dihitung dari semua ${totalCount})._` : ``,
          `| Waktu | Long Liquidated | Short Liquidated |`,
          `|---|---|---|`,
          rows,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            totalLong,
            totalShort,
            dominance,
            pointCount: bars.length,
            ...(detail === "full" ? { points: bars } : { recent: shown }),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
