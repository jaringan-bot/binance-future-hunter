import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { fmtPct, fmtTime } from "../format.js";
import { errorResult, SNAPSHOT_WATCHLIST, detailParam } from "../shared.js";
import { queryMarketSnapshots } from "../d1Client.js";

export function registerBasisHistoryTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_get_basis_history",
    {
      title: "Histori Basis Futures-vs-Spot (Time-Series)",
      description:
        "Histori basis futures-vs-spot dari snapshot Cron tiap 5 menit (BUKAN live seperti binance_get_spot_price) -- " +
        "deteksi 'basis melebar lalu kembali' (docs/mm_detection_framework.md Section 5.1). HANYA tersedia untuk " +
        `watchlist tetap (${SNAPSHOT_WATCHLIST.length} pair). Default ringkas (current/avg/range + <=10 poin ` +
        "terbaru); `detail: \"full\"` untuk semua snapshot.",
      inputSchema: {
        symbol: z
          .enum(SNAPSHOT_WATCHLIST)
          .describe(`Symbol dari watchlist tetap: ${SNAPSHOT_WATCHLIST.join(", ")}`),
        hours: z
          .number()
          .int()
          .min(1)
          .max(24)
          .default(6)
          .describe("Rentang jam ke belakang yang mau dilihat"),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, hours, detail }) => {
      try {
        const points = await queryMarketSnapshots(symbol, hours);
        if (points.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Belum ada data histori basis untuk ${symbol} dalam ${hours} jam terakhir. Cron snapshot jalan tiap 5 menit -- kalau fitur ini baru di-deploy, tunggu beberapa siklus dulu sebelum histori berguna.`,
              },
            ],
          };
        }

        const basisValues = points.map((p) => p.basis ?? 0);
        const current = basisValues[basisValues.length - 1];
        const avg = basisValues.reduce((a, b) => a + b, 0) / basisValues.length;
        const max = Math.max(...basisValues);
        const min = Math.min(...basisValues);

        // Deteksi kasar "melebar lalu kembali": window ini pernah nyentuh
        // ekstrem (jauh dari rata-rata) tapi titik TERKINI udah balik deket
        // rata-rata window -- bukan bukti pasti, cuma indikasi buat ditelusuri lanjut.
        const maxDeviation = Math.max(Math.abs(max - avg), Math.abs(min - avg));
        const currentDeviation = Math.abs(current - avg);
        const revertedFromExtreme = maxDeviation > 0.0003 && currentDeviation < maxDeviation * 0.3;

        const recentN = detail === "full" ? points.length : 10;
        const recent = points.slice(-recentN);
        const rows = recent.map((p) => `| ${fmtTime(p.timestamp)} | ${fmtPct(p.basis ?? 0, 4)} |`).join("\n");

        const text = [
          `# Histori Basis (Futures vs Spot) — ${symbol} (${hours} jam terakhir, ${points.length} snapshot)`,
          ``,
          `- Basis Terkini: ${fmtPct(current, 4)}`,
          `- Rata-rata Window: ${fmtPct(avg, 4)}`,
          `- Range: ${fmtPct(min, 4)} s/d ${fmtPct(max, 4)}`,
          ``,
          `**Indikasi**: ${revertedFromExtreme ? "Basis SEMPAT melebar jauh dari rata-rata lalu KEMBALI mendekat (pola arbitrage/hedging, cross-check funding & OI)." : "Belum ada pola 'melebar lalu kembali' yang jelas."}`,
          ``,
          `## ${recent.length} Snapshot Terakhir`,
          `| Waktu | Basis |`,
          `|---|---|`,
          rows,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            hours,
            current,
            avg,
            min,
            max,
            revertedFromExtreme,
            pointCount: points.length,
            ...(detail === "full" ? { points } : { recent }),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
