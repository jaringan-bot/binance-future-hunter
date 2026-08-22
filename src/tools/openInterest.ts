import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtTime, trendDirection } from "../format.js";
import { symbolSchema, FUTURES_DATA_PERIOD_ENUM, errorResult, detailParam } from "../shared.js";
import { truncateRows } from "../toolHelpers.js";

export function registerOpenInterestTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // OPEN INTEREST
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_open_interest",
    {
      title: "Open Interest Saat Ini",
      description:
        "Open Interest (total kontrak terbuka) TERKINI, LANGSUNG dari Binance native. OI naik + harga naik = tren " +
        "didukung entry baru. OI turun + harga naik = short covering. OI turun tajam = kemungkinan capitulation.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getOpenInterestNative(symbol);
        const openInterest = parseFloat(data.openInterest);
        const text = [
          `# Open Interest — ${symbol}`,
          ``,
          `- Open Interest: ${fmtNum(openInterest, 2)} kontrak`,
          `- Waktu: ${fmtTime(data.time)}`,
          ``,
          `_Gunakan bersama binance_get_open_interest_history untuk tren, bandingkan dengan harga._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, openInterest, time: data.time },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  registerSafeTool(
    server,
    "binance_get_open_interest_history",
    {
      title: "Histori Tren Open Interest",
      description:
        "Histori Open Interest untuk lihat TREN naik/turun, LANGSUNG dari Binance native. Kombinasikan dengan " +
        "binance_get_klines periode sama: OI naik + harga naik = entry baru; OI turun + harga naik = short covering " +
        "(rally rapuh). Default ringkas (tren + <=10 poin terbaru); `detail: \"full\"` untuk histori lengkap sesuai `limit`.",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(FUTURES_DATA_PERIOD_ENUM)
          .default("15m")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(30).describe("Jumlah data poin"),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit, detail }) => {
      try {
        const bars = await binanceProxy.getOpenInterestHistNative(symbol, period, limit);
        if (bars.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Tidak ada data histori OI untuk ${symbol} pada period ${period}. Pastikan symbol adalah pair USDT-margined yang valid.`,
              },
            ],
          };
        }
        const values = bars.map((b) => parseFloat(b.sumOpenInterest));
        const direction = trendDirection(values);
        const first = values[0];
        const last = values[values.length - 1];
        const changePct = first !== 0 ? ((last - first) / first) * 100 : 0;

        const { shown, totalCount, truncated } = truncateRows(bars);
        const rows = shown
          .map((b) => `| ${fmtTime(b.timestamp)} | ${fmtNum(parseFloat(b.sumOpenInterest), 2)} |`)
          .join("\n");

        const text = [
          `# Tren Open Interest — ${symbol} (period: ${period}, ${bars.length} data poin)`,
          ``,
          `**Tren keseluruhan window**: OI ${direction} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% dari awal ke akhir window)`,
          ``,
          truncated ? `_Menampilkan ${shown.length} terakhir dari ${totalCount} total (tren dihitung dari semua ${totalCount})._` : ``,
          `| Waktu | Open Interest |`,
          `|---|---|`,
          rows,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            period,
            direction,
            changePct,
            current: last,
            pointCount: bars.length,
            ...(detail === "full" ? { points: bars } : { recent: bars.slice(-10) }),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
