// estimate_slippage -- pure calculation, TIDAK fetch dari Binance sendiri.
// Order book depth (bids/asks) diinjeksi caller (mis. hasil binance_get_order_book_depth
// sebelumnya), bukan di-fetch tool ini -- lihat plan 2026-08-26 "5 pure-calc
// tools", arsitektur ini sengaja biar gak nambah beban proxy Vercel (sudah
// over-budget bulanan, lihat sesi yang sama).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolSchema, depthLevelSchema, errorResultWithCode } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtPrice, fmtPct } from "../format.js";
import { walkDepthForNotional } from "../depthWalker.js";

export function registerSlippageEstimatorTools(server: McpServer): void {
  registerSafeTool(
    server,
    "estimate_slippage",
    {
      title: "Estimasi Slippage Order Book",
      description:
        "Hitung avg fill price, slippage %, dan impact cost buat mengisi target notional USD dari order book " +
        "depth yang di-supply caller (BUKAN fetch sendiri -- pass bids/asks dari binance_get_order_book_depth). " +
        "BUY jalan-kan asks (naik), SELL jalan-kan bids (turun).",
      inputSchema: {
        symbol: symbolSchema,
        side: z.enum(["BUY", "SELL"]).describe("BUY = isi dari asks (naik), SELL = isi dari bids (turun)."),
        targetNotionalUsd: z.number().positive().describe("Target notional USD yang mau diisi."),
        bids: z.array(depthLevelSchema).max(5000).describe("Level bid [priceStr, qtyStr], urutan turun (best bid duluan)."),
        asks: z.array(depthLevelSchema).max(5000).describe("Level ask [priceStr, qtyStr], urutan naik (best ask duluan)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ symbol, side, targetNotionalUsd, bids, asks }) => {
      const depth = side === "BUY" ? asks : bids;
      const result = walkDepthForNotional({ side, targetNotionalUsd, depth });

      if (result.errorCode) {
        const messages: Record<string, string> = {
          EMPTY_DEPTH: `Depth ${side === "BUY" ? "asks" : "bids"} kosong untuk ${symbol} -- gak bisa hitung slippage.`,
          INVALID_BEST_PRICE: `Level pertama depth ${side === "BUY" ? "asks" : "bids"} punya harga tidak valid (nol/NaN) untuk ${symbol}.`,
          ZERO_FILL: `Semua level depth ${side === "BUY" ? "asks" : "bids"} punya qty nol untuk ${symbol} -- gak ada yang bisa diisi.`,
        };
        return errorResultWithCode(result.errorCode, messages[result.errorCode], { symbol, side });
      }

      const builder = new ToolResponseBuilder()
        .header(`Estimasi Slippage — ${symbol} (${side})`)
        .row("Best Price", fmtPrice(result.bestPrice))
        .row("Avg Fill Price", fmtPrice(result.avgFillPrice))
        .row("Slippage", fmtPct(result.slippagePct / 100))
        .row("Impact Cost (USD)", fmtPrice(result.impactCostUsd))
        .row("Notional Terisi (USD)", fmtPrice(result.filledNotionalUsd))
        .row("Partial Fill", result.partialFill ? "Ya -- depth habis sebelum target notional terisi penuh" : "Tidak")
        .struct("symbol", symbol)
        .struct("side", side)
        .struct("bestPrice", result.bestPrice)
        .struct("avgFillPrice", result.avgFillPrice)
        .struct("filledNotionalUsd", result.filledNotionalUsd)
        .struct("filledQty", result.filledQty)
        .struct("slippagePct", result.slippagePct)
        .struct("impactCostUsd", result.impactCostUsd)
        .struct("partialFill", result.partialFill);

      return builder.build();
    },
  );
}
