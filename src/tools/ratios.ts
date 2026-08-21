import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtTime, trendDirection } from "../format.js";
import { symbolSchema, FUTURES_DATA_PERIOD_ENUM, errorResult, detailParam } from "../shared.js";
import { truncateRows } from "../toolHelpers.js";

export function registerRatiosTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // LONG/SHORT RATIO
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_long_short_ratio",
    {
      title: "Long/Short Ratio",
      description:
        "Rasio posisi long vs short agregat (semua akun/global) + tren, LANGSUNG dari Binance native " +
        "globalLongShortAccountRatio. Ratio > 1 = lebih banyak/besar posisi long. KETERBATASAN: rasio BLENDED, bukan " +
        "breakdown top-trader (pakai binance_get_top_trader_ratio untuk itu). Default ringkas (snapshot + tren + " +
        "<=10 poin terbaru); `detail: \"full\"` untuk histori lengkap.",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(FUTURES_DATA_PERIOD_ENUM)
          .default("15m")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(10).describe("Jumlah data poin terakhir"),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit, detail }) => {
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
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            longPct: latestLongPct,
            shortPct: latestShortPct,
            ratio: latestRatio,
            bias,
            direction,
            ...(detail === "full" ? { points } : { recent: shown }),
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
  registerSafeTool(
    server,
    "binance_get_top_trader_ratio",
    {
      title: "Top-Trader Long/Short Ratio (Breakdown Murni)",
      description:
        "Rasio long/short KHUSUS TOP TRADER, terpisah dari retail, LANGSUNG dari Binance (bukan Coinalyze). " +
        "mode='account' = breakdown jumlah akun; mode='position' = breakdown size posisi (lebih relevan buat modal " +
        "besar). KETERBATASAN: threshold 'top trader' tidak dipublikasikan Binance; bandingkan RELATIF ke histori " +
        "pendek pair sendiri, jangan pakai threshold absolut universal (docs/mm_detection_framework.md Section 4.2). " +
        "Default ringkas (snapshot + tren + <=10 poin terbaru); `detail: \"full\"` untuk histori lengkap.",
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
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, mode, period, limit, detail }) => {
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
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            mode,
            longPct,
            shortPct,
            ratio,
            bias,
            direction,
            ...(detail === "full" ? { points } : { recent: shown }),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
