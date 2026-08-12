import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtTime, trendDirection } from "../format.js";
import { symbolSchema, FUTURES_DATA_PERIOD_ENUM, errorResult } from "../shared.js";
import { truncateRows } from "../toolHelpers.js";

export function registerRatiosTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // LONG/SHORT RATIO
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_long_short_ratio",
    {
      title: "Long/Short Ratio",
      description:
        "Mengambil rasio posisi long vs short agregat (semua akun/global) untuk sebuah pair Binance Futures, beserta tren dari " +
        "waktu ke waktu (LANGSUNG dari Binance native globalLongShortAccountRatio, bukan lewat Coinalyze — source of truth). " +
        "Ratio > 1 berarti lebih banyak/besar posisi long dibanding short. " +
        "KETERBATASAN: ini rasio agregat BLENDED, BUKAN breakdown terpisah retail-vs-top-trader — untuk breakdown top-trader " +
        "murni, pakai binance_get_top_trader_ratio.",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(FUTURES_DATA_PERIOD_ENUM)
          .default("15m")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(10).describe("Jumlah data poin terakhir"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const points = await binanceProxy.getGlobalAccountRatio(symbol, period, limit);
        if (points.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Data long/short ratio tidak tersedia untuk ${symbol}. Pastikan symbol adalah pair perpetual USDT-margined yang aktif.`,
              },
            ],
          };
        }

        const longPcts = points.map((p) => parseFloat(p.longAccount) * 100);
        const shortPcts = points.map((p) => parseFloat(p.shortAccount) * 100);
        const ratios = points.map((p) => parseFloat(p.longShortRatio));

        const latestLongPct = longPcts[longPcts.length - 1];
        const latestShortPct = shortPcts[shortPcts.length - 1];
        const latestRatio = ratios[ratios.length - 1];
        const bias = latestLongPct > 55 ? "LONG" : latestLongPct < 45 ? "SHORT" : "NETRAL";
        const direction = trendDirection(ratios);

        const { shown, totalCount, truncated } = truncateRows(points);
        const rows = shown
          .map(
            (p) =>
              `| ${fmtTime(p.timestamp)} | ${(parseFloat(p.longAccount) * 100).toFixed(2)}% | ${(parseFloat(p.shortAccount) * 100).toFixed(2)}% | ${fmtNum(parseFloat(p.longShortRatio), 4)} |`,
          )
          .join("\n");

        const text = [
          `# Long/Short Ratio — ${symbol} (period: ${period})`,
          ``,
          `## Snapshot Terkini`,
          `- **Long**: ${latestLongPct.toFixed(1)}% / **Short**: ${latestShortPct.toFixed(1)}% → ratio ${fmtNum(latestRatio, 4)} → bias ${bias}`,
          `**Tren**: ${direction}`,
          ``,
          `## Histori${truncated ? ` (${shown.length} terakhir dari ${totalCount} total; tren di atas dihitung dari semua ${totalCount})` : ""}`,
          `| Waktu | Long % | Short % | Ratio |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_Ini rasio agregat semua trader (blended), bukan breakdown top-trader/whale terpisah dari retail — pakai binance_get_top_trader_ratio untuk breakdown murni. Data LANGSUNG dari Binance native._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            longPct: latestLongPct,
            shortPct: latestShortPct,
            ratio: latestRatio,
            bias,
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  // ─────────────────────────────────────────────────────────────
  // TOP-TRADER LONG/SHORT RATIO — breakdown top trader murni,
  // langsung dari Binance lewat proxy Vercel, BUKAN blended seperti
  // binance_get_long_short_ratio di atas.
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_top_trader_ratio",
    {
      title: "Top-Trader Long/Short Ratio (Breakdown Murni)",
      description:
        "Rasio long/short KHUSUS TOP TRADER (posisi/margin terbesar di Binance Futures), TERPISAH dari retail — " +
        "LANGSUNG dari Binance (proxy relay, bukan Coinalyze), gak ter-blend akun kecil. Proxy lebih dekat ke 'whale " +
        "positioning' dibanding binance_get_long_short_ratio (blended). mode='account' = breakdown JUMLAH akun top " +
        "trader long vs short. mode='position' = breakdown SIZE POSISI (lebih relevan buat dominasi modal besar — " +
        "1 akun besar tetap terhitung 1 di mode='account' tapi bobotnya besar di mode='position'). " +
        "KETERBATASAN: threshold 'top trader' gak dipublikasikan Binance, data snapshot periodik (bukan tick-by-tick). " +
        "Untuk deteksi divergence smart-money vs retail (docs/mm_detection_framework.md Section 4.2): JANGAN pakai " +
        "threshold absolut universal (misal '15%') — tervalidasi data riil, pair likuid (BTC/ETH) cuma bergerak " +
        "<2.5 poin/2 jam. Bandingkan RELATIF ke histori pendek pair sendiri (~5-30 hari tergantung resolusi, retensi " +
        "Binance terbatas), fokus ARAH pergerakan berlawanan dari binance_get_long_short_ratio, bukan magnitude absolut.",
      inputSchema: {
        symbol: symbolSchema,
        mode: z
          .enum(["account", "position"])
          .default("account")
          .describe("'account' = breakdown jumlah akun top trader, 'position' = breakdown size posisi top trader"),
        period: z
          .enum(FUTURES_DATA_PERIOD_ENUM)
          .default("1h")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(10).describe("Jumlah data poin terakhir"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, mode, period, limit }) => {
      try {
        const points =
          mode === "position"
            ? await binanceProxy.getTopTraderPositionRatio(symbol, period, limit)
            : await binanceProxy.getTopTraderAccountRatio(symbol, period, limit);

        if (points.length === 0) {
          return {
            content: [
              { type: "text", text: `Tidak ada data top-trader ratio untuk ${symbol} (mode: ${mode}).` },
            ],
          };
        }

        const latest = points[points.length - 1];
        const longPct = parseFloat(latest.longAccount) * 100;
        const shortPct = parseFloat(latest.shortAccount) * 100;
        const ratio = parseFloat(latest.longShortRatio);
        const bias = longPct > 55 ? "LONG" : longPct < 45 ? "SHORT" : "NETRAL";
        const direction = trendDirection(points.map((p) => parseFloat(p.longShortRatio)));

        const { shown, totalCount, truncated } = truncateRows(points);
        const rows = shown
          .map(
            (p) =>
              `| ${fmtTime(p.timestamp)} | ${(parseFloat(p.longAccount) * 100).toFixed(2)}% | ${(parseFloat(p.shortAccount) * 100).toFixed(2)}% | ${fmtNum(parseFloat(p.longShortRatio), 4)} |`,
          )
          .join("\n");

        const modeLabel = mode === "position" ? "SIZE POSISI top trader" : "JUMLAH AKUN top trader";

        const text = [
          `# Top-Trader Long/Short Ratio — ${symbol} (mode: ${mode}, period: ${period})`,
          ``,
          `## Snapshot Terkini (berdasarkan ${modeLabel})`,
          `- **Long**: ${longPct.toFixed(2)}% / **Short**: ${shortPct.toFixed(2)}% → ratio ${fmtNum(ratio, 4)} → bias ${bias}`,
          `**Tren**: ${direction}`,
          ``,
          `## Histori${truncated ? ` (${shown.length} terakhir dari ${totalCount} total; tren di atas dihitung dari semua ${totalCount})` : ""}`,
          `| Waktu | Long % | Short % | Ratio |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_Data LANGSUNG dari Binance (bukan Coinalyze), khusus akun TOP TRADER — lebih dekat ke proxy whale dibanding binance_get_long_short_ratio yang blended semua trader. Threshold 'top trader' tidak dipublikasikan Binance secara pasti._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, mode, longPct, shortPct, ratio, bias },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
