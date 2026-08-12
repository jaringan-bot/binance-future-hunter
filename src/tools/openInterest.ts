import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtTime, trendDirection } from "../format.js";
import { symbolSchema, FUTURES_DATA_PERIOD_ENUM, errorResult } from "../shared.js";
import { truncateRows } from "../toolHelpers.js";

export function registerOpenInterestTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // OPEN INTEREST
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_open_interest",
    {
      title: "Open Interest Saat Ini",
      description:
        "Mengambil Open Interest (total kontrak terbuka) TERKINI untuk sebuah pair (LANGSUNG dari Binance native, bukan lewat " +
        "Coinalyze — source of truth). " +
        "OI naik + harga naik = tren didukung entry baru (sehat). " +
        "OI turun + harga naik = short covering / posisi ditutup, bukan entry baru (kurang solid). " +
        "OI turun tajam = kemungkinan capitulation/liquidation massal.",
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
          `_Gunakan bersama \`binance_get_open_interest_history\` untuk melihat tren naik/turun, dan bandingkan dengan pergerakan harga untuk interpretasi yang benar (OI saja tanpa konteks harga bisa menyesatkan). Data LANGSUNG dari Binance native._`,
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


  server.registerTool(
    "binance_get_open_interest_history",
    {
      title: "Histori Tren Open Interest",
      description:
        "Mengambil histori Open Interest untuk melihat TREN naik/turun sepanjang waktu (bukan cuma snapshot), LANGSUNG dari " +
        "Binance native (bukan lewat Coinalyze — source of truth). Ini yang dibutuhkan untuk menjawab 'apakah OI sedang naik " +
        "atau turun hari ini'. Kombinasikan dengan data candlestick harga (binance_get_klines) pada periode yang sama untuk " +
        "interpretasi yang valid: OI naik + harga naik = trend genuinely didukung entry baru; OI turun + harga naik = short " +
        "covering (rally rapuh).",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(FUTURES_DATA_PERIOD_ENUM)
          .default("15m")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(30).describe("Jumlah data poin"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
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
          truncated ? `_Menampilkan ${shown.length} terakhir dari ${totalCount} total (tren di atas dihitung dari semua ${totalCount})._` : ``,
          `| Waktu | Open Interest |`,
          `|---|---|`,
          rows,
          ``,
          `_Langkah selanjutnya yang disarankan: panggil \`binance_get_klines\` pair & timeframe yang sama untuk cek apakah OI ${direction} ini terjadi bersamaan dengan harga naik atau turun — kombinasi keduanya yang menentukan interpretasi (entry baru vs covering vs capitulation). Data LANGSUNG dari Binance native._`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
