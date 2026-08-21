import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtPrice, fmtTime } from "../format.js";
import { symbolSchema, errorResult, detailParam } from "../shared.js";

export function registerOrderbookTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // ORDER BOOK DEPTH
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_order_book_depth",
    {
      title: "Order Book Depth",
      description:
        "Snapshot order book (bid/ask) real-time -- lihat wall besar (potensi whale/spoofing), spread, likuiditas. " +
        "PENTING: snapshot SESAAT, wall besar bisa hilang dalam detik (bisa spoofing). Butuh minimal 3 sinyal align " +
        "sebelum simpulkan aktivitas MM (docs/mm_detection_framework.md). Default ringkas (top 10 + wall terbesar); " +
        "`detail: \"full\"` untuk semua level sampai `limit`.",
      inputSchema: {
        symbol: symbolSchema,
        limit: z
          .number()
          .int()
          .refine((v) => [5, 10, 20, 50, 100, 500, 1000].includes(v), {
            message: "limit harus salah satu dari: 5, 10, 20, 50, 100, 500, 1000 (sesuai batasan Binance API)",
          })
          .default(20)
          .describe("Jumlah level bid/ask yang diambil per sisi. Harus salah satu dari: 5, 10, 20, 50, 100, 500, 1000."),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit, detail }) => {
      try {
        const data = await binanceProxy.getOrderBookDepth(symbol, limit);

        const bidRows = data.bids
          .slice(0, 10)
          .map(([price, qty]) => `| ${fmtPrice(parseFloat(price))} | ${fmtNum(parseFloat(qty), 4)} |`)
          .join("\n");
        const askRows = data.asks
          .slice(0, 10)
          .map(([price, qty]) => `| ${fmtPrice(parseFloat(price))} | ${fmtNum(parseFloat(qty), 4)} |`)
          .join("\n");

        const bestBid = data.bids[0] ? parseFloat(data.bids[0][0]) : null;
        const bestAsk = data.asks[0] ? parseFloat(data.asks[0][0]) : null;
        const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
        const spreadPct = spread !== null && bestBid !== null ? (spread / bestBid) * 100 : null;

        // Cari level dengan quantity terbesar di masing-masing sisi (potensi wall).
        const largestBid = data.bids.reduce(
          (max, [p, q]) => (parseFloat(q) > parseFloat(max[1]) ? [p, q] : max),
          data.bids[0] ?? ["0", "0"],
        );
        const largestAsk = data.asks.reduce(
          (max, [p, q]) => (parseFloat(q) > parseFloat(max[1]) ? [p, q] : max),
          data.asks[0] ?? ["0", "0"],
        );

        const text = [
          `# Order Book Depth — ${symbol} (${limit} level per sisi)`,
          ``,
          `**Best Bid**: ${bestBid !== null ? fmtPrice(bestBid) : "N/A"} | **Best Ask**: ${bestAsk !== null ? fmtPrice(bestAsk) : "N/A"}`,
          `**Spread**: ${spread !== null ? fmtPrice(spread) : "N/A"} (${spreadPct !== null ? spreadPct.toFixed(4) : "N/A"}%)`,
          ``,
          `**Wall terbesar (Bid)**: harga ${fmtPrice(parseFloat(largestBid[0]))}, size ${fmtNum(parseFloat(largestBid[1]), 4)}`,
          `**Wall terbesar (Ask)**: harga ${fmtPrice(parseFloat(largestAsk[0]))}, size ${fmtNum(parseFloat(largestAsk[1]), 4)}`,
          ``,
          `## Top 10 Bids (harga tertinggi dulu)`,
          `| Harga | Quantity |`,
          `|---|---|`,
          bidRows,
          ``,
          `## Top 10 Asks (harga terendah dulu)`,
          `| Harga | Quantity |`,
          `|---|---|`,
          askRows,
          ``,
          `_Snapshot sesaat (waktu server Binance: ${fmtTime(data.T)})._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            bestBid,
            bestAsk,
            spread,
            spreadPct,
            ...(detail === "full" ? { bids: data.bids, asks: data.asks } : {}),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  // ─────────────────────────────────────────────────────────────
  // ORDER BOOK IMBALANCE (OBI)
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_order_book_imbalance",
    {
      title: "Order Book Imbalance (OBI)",
      description:
        "Persentase imbalance volume Bid vs Ask kumulatif di 3 depth (5, 10, 20) sekaligus, plus label bias " +
        "(BULLISH/BEARISH/SEIMBANG) per depth. Beda dari binance_get_order_book_depth yang cuma snapshot mentah. " +
        "PENTING: snapshot SESAAT, jangan overinterpretasi.",
      inputSchema: {
        symbol: symbolSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getOrderBookDepth(symbol, 20);
        const depthLevels = [5, 10, 20] as const;

        const results = depthLevels.map((depth) => {
          const bidVol = data.bids
            .slice(0, depth)
            .reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
          const askVol = data.asks
            .slice(0, depth)
            .reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
          const totalVol = bidVol + askVol;

          if (totalVol === 0) {
            return { depth, bidVol, askVol, bidPct: null as number | null, bias: "TIDAK ADA DATA" };
          }

          const bidPct = (bidVol / totalVol) * 100;
          const bias = bidPct > 60 ? "BULLISH (bid dominan)" : bidPct < 40 ? "BEARISH (ask dominan)" : "SEIMBANG";
          return { depth, bidVol, askVol, bidPct, bias };
        });

        const rows = results
          .map(
            (r) =>
              `| ${r.depth} | ${fmtNum(r.bidVol, 4)} | ${fmtNum(r.askVol, 4)} | ${r.bidPct !== null ? r.bidPct.toFixed(2) + "%" : "N/A"} | ${r.bias} |`,
          )
          .join("\n");

        const bestBid = data.bids[0] ? parseFloat(data.bids[0][0]) : null;
        const bestAsk = data.asks[0] ? parseFloat(data.asks[0][0]) : null;

        const text = [
          `# Order Book Imbalance — ${symbol}`,
          ``,
          `**Best Bid**: ${bestBid !== null ? fmtPrice(bestBid) : "N/A"} | **Best Ask**: ${bestAsk !== null ? fmtPrice(bestAsk) : "N/A"}`,
          ``,
          `| Depth | Bid Volume | Ask Volume | Bid % | Bias |`,
          `|---|---|---|---|---|`,
          rows,
          ``,
          `_Snapshot sesaat (waktu server Binance: ${fmtTime(data.T)}). Volume dari raw base-asset quantity, bukan notional._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, levels: results },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
