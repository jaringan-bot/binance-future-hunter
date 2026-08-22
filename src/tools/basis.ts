import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtPct, fmtPrice, fmtTime, trendDirection } from "../format.js";
import {
  symbolSchema,
  FUTURES_DATA_PERIOD_ENUM,
  CONTRACT_TYPE_ENUM,
  errorResult,
  detailParam,
} from "../shared.js";
import { truncateRows } from "../toolHelpers.js";

/**
 * binance_get_basis — histori basis resmi Binance (index vs futures).
 *
 * BEDA dari binance_get_basis_history:
 * - Tool ini = GET /futures/data/basis (native, semua pair, period 5m–1d)
 * - binance_get_basis_history = snapshot D1 cron futures-vs-spot (watchlist tetap saja)
 */
export function registerBasisTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_get_basis",
    {
      title: "Histori Basis Native (Index vs Futures)",
      description:
        "Histori basis resmi Binance (GET /futures/data/basis): selisih futures price vs index price per period " +
        "(5m–1d). Source of truth untuk premium/discount historis — beda dari binance_get_basis_history yang " +
        "pakai snapshot D1 cron futures-vs-spot (hanya watchlist tetap). Cocok deteksi premium ekstrem, " +
        "mean-reversion basis, dan konfirmasi funding lag. Default ringkas (avg/range/tren + <=10 poin); " +
        "`detail: \"full\"` untuk semua poin sesuai limit.",
      inputSchema: {
        symbol: symbolSchema.describe(
          "Pair futures, contoh BTCUSDT. Dikirim ke Binance sebagai param `pair`.",
        ),
        contractType: z
          .enum(CONTRACT_TYPE_ENUM)
          .default("PERPETUAL")
          .describe("Tipe kontrak: PERPETUAL (default), CURRENT_QUARTER, NEXT_QUARTER"),
        period: z
          .enum(FUTURES_DATA_PERIOD_ENUM)
          .default("1h")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(30)
          .describe("Jumlah data poin (max 500, default 30)"),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, contractType, period, limit, detail }) => {
      try {
        const points = await binanceProxy.getBasisNative(symbol, contractType, period, limit);
        if (!points || points.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Tidak ada data basis untuk ${symbol} (${contractType}, period ${period}). ` +
                  `Pastikan pair terdaftar di Binance USDS-M Futures.`,
              },
            ],
          };
        }

        const rates = points.map((p) => parseFloat(p.basisRate));
        const bases = points.map((p) => parseFloat(p.basis));
        const currentRate = rates[rates.length - 1];
        const currentBasis = bases[bases.length - 1];
        const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
        const maxRate = Math.max(...rates);
        const minRate = Math.min(...rates);
        const direction = trendDirection(rates);
        const last = points[points.length - 1];

        // Heuristik: basis rate di luar ±0.05% sering relevan untuk crowding/premium
        const BASIS_RATE_THRESHOLD = 0.0005;
        const interpretation =
          currentRate >= BASIS_RATE_THRESHOLD
            ? "PREMIUM (futures di atas index — sentimen long agresif / funding cenderung positif)"
            : currentRate <= -BASIS_RATE_THRESHOLD
              ? "DISCOUNT (futures di bawah index — sentimen short agresif / funding cenderung negatif)"
              : "NETRAL (basis dekat index)";

        const { shown, totalCount, truncated } = truncateRows(points);
        const rows = shown
          .map(
            (p) =>
              `| ${fmtTime(p.timestamp)} | ${fmtPct(parseFloat(p.basisRate), 4)} | ${fmtPrice(parseFloat(p.basis))} | ${fmtPrice(parseFloat(p.futuresPrice))} | ${fmtPrice(parseFloat(p.indexPrice))} |`,
          )
          .join("\n");

        const text = [
          `# Basis Native (Index vs Futures) — ${symbol}`,
          ``,
          `- Contract: ${contractType} | Period: ${period} | Poin: ${points.length}`,
          `- Basis Rate terkini: ${fmtPct(currentRate, 4)}`,
          `- Basis (abs) terkini: ${fmtPrice(currentBasis)}`,
          `- Futures / Index: ${fmtPrice(parseFloat(last.futuresPrice))} / ${fmtPrice(parseFloat(last.indexPrice))}`,
          `- Rata-rata basis rate window: ${fmtPct(avgRate, 4)}`,
          `- Range rate: ${fmtPct(minRate, 4)} s/d ${fmtPct(maxRate, 4)}`,
          `- Tren rate: ${direction}`,
          ``,
          `**Interpretasi**: ${interpretation}`,
          ``,
          truncated
            ? `_Menampilkan ${shown.length} terakhir dari ${totalCount} total (avg/tren dihitung dari semua)._`
            : ``,
          `| Waktu | Basis Rate | Basis | Futures | Index |`,
          `|---|---|---|---|---|`,
          rows,
          ``,
          `_Data LANGSUNG dari Binance GET /futures/data/basis. Beda dari binance_get_basis_history ` +
            `(snapshot D1 futures-vs-spot, watchlist tetap saja). Threshold interpretasi ±0.05% basis rate ` +
            `(sama default basis di binance_get_funding_rate)._`,
        ]
          .filter((line) => line !== "")
          .join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            contractType,
            period,
            currentBasisRate: currentRate,
            currentBasis,
            avgBasisRate: avgRate,
            minBasisRate: minRate,
            maxBasisRate: maxRate,
            direction,
            interpretation,
            pointCount: points.length,
            ...(detail === "full" ? { points } : { recent: points.slice(-10) }),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
