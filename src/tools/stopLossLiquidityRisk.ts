// estimate_stop_loss_liquidity_risk -- pure calculation, TIDAK fetch dari
// Binance sendiri. bids/asks/openInterest diinjeksi caller. TIDAK sama
// dengan analyze_futures_grid_risk (futuresGridRisk.ts) -- itu engine grid-
// bot LONG-only lengkap (SAFE/MODERATE/HIGH_RISK/REJECT). Tool ini lebih
// sederhana: cuma depth-to-SL + OI, mendukung LONG dan SHORT, output
// LOW/HIGH_SLIPPAGE_RISK/HIGH_DATA_INCOMPLETE. Sengaja nama beda biar gak
// ketuker.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolSchema, depthLevelSchema } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtPrice } from "../format.js";
import { walkDepthToStopLoss, type PositionSide } from "../depthWalker.js";

// Never throws -- payload OI bisa angka mentah, string numerik, atau object
// dengan salah satu key openInterest/open_interest/sumOpenInterest/oi
// (2 nama field Binance native yang sudah dipakai di ~10 tempat lain di
// repo ini, plus 2 alias umum dari sumber lain). Shape lain -> 0.
export function extractOpenInterest(payload: unknown): number {
  if (typeof payload === "number") return Number.isFinite(payload) ? payload : 0;
  if (typeof payload === "string") {
    const n = parseFloat(payload);
    return Number.isFinite(n) ? n : 0;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    for (const key of ["openInterest", "open_interest", "sumOpenInterest", "oi"]) {
      const v = obj[key];
      const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

export type LiquidityRiskLevel = "LOW" | "HIGH_SLIPPAGE_RISK" | "HIGH_DATA_INCOMPLETE";

export interface LiquidityRiskResult {
  riskLevel: LiquidityRiskLevel;
  depthToStopLossNotionalUsd: number;
  openInterestExtracted: number;
  slWalkRejected: boolean;
}

export function estimateStopLossLiquidityRisk(
  positionSide: PositionSide,
  currentPrice: number,
  stopLossPrice: number,
  bids: [string, string][],
  asks: [string, string][],
  openInterestPayload: unknown,
  slippageThresholdUsd: number,
): LiquidityRiskResult {
  const oi = extractOpenInterest(openInterestPayload);
  const walk = walkDepthToStopLoss({ positionSide, currentPrice, stopLossPrice, bids, asks });

  let riskLevel: LiquidityRiskLevel;
  if (walk.rejected || oi === 0) {
    riskLevel = "HIGH_DATA_INCOMPLETE";
  } else if (walk.notionalUsd < slippageThresholdUsd) {
    riskLevel = "HIGH_SLIPPAGE_RISK";
  } else {
    riskLevel = "LOW";
  }

  return {
    riskLevel,
    depthToStopLossNotionalUsd: walk.notionalUsd,
    openInterestExtracted: oi,
    slWalkRejected: walk.rejected,
  };
}

export function registerStopLossLiquidityRiskTools(server: McpServer): void {
  registerSafeTool(
    server,
    "estimate_stop_loss_liquidity_risk",
    {
      title: "Estimasi Risiko Likuiditas Stop-Loss",
      description:
        "Cek apakah depth order book cukup buat nyerap SL tanpa slippage parah, plus validasi Open Interest -- " +
        "LOW/HIGH_SLIPPAGE_RISK/HIGH_DATA_INCOMPLETE. Mendukung LONG (jalan-kan bids turun) dan SHORT (jalan-kan asks " +
        "naik). Data diinjeksi caller (BUKAN fetch sendiri). BUKAN pengganti analyze_futures_grid_risk (engine grid-bot " +
        "lengkap yang sudah ada) -- ini cek likuiditas sederhana, cocok untuk kedua arah posisi.",
      inputSchema: {
        symbol: symbolSchema,
        positionSide: z.enum(["LONG", "SHORT"]),
        currentPrice: z.number().positive(),
        stopLossPrice: z.number().positive(),
        bids: z.array(depthLevelSchema).max(5000),
        asks: z.array(depthLevelSchema).max(5000),
        openInterest: z
          .union([z.number(), z.string(), z.record(z.unknown())])
          .describe("Payload OI mentah dari Binance (openInterest/sumOpenInterest string, atau angka)."),
        slippageThresholdUsd: z.number().positive().default(50_000).describe("Ambang notional depth-to-SL minimum, default $50k."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ symbol, positionSide, currentPrice, stopLossPrice, bids, asks, openInterest, slippageThresholdUsd }) => {
      const result = estimateStopLossLiquidityRisk(
        positionSide,
        currentPrice,
        stopLossPrice,
        bids,
        asks,
        openInterest,
        slippageThresholdUsd,
      );

      const builder = new ToolResponseBuilder()
        .header(`Stop-Loss Liquidity Risk — ${symbol} (${positionSide})`)
        .row("Risk Level", result.riskLevel)
        .row("Depth-to-SL Notional (USD)", fmtPrice(result.depthToStopLossNotionalUsd))
        .row("Open Interest", result.openInterestExtracted > 0 ? fmtPrice(result.openInterestExtracted) : "Tidak valid/tersedia")
        .row("Current / SL Price", `${fmtPrice(currentPrice)} / ${fmtPrice(stopLossPrice)}`);

      if (result.slWalkRejected) {
        builder.warning(
          `stopLossPrice tidak valid untuk posisi ${positionSide} (${
            positionSide === "LONG" ? "harus di bawah" : "harus di atas"
          } currentPrice) -- depth-to-SL tidak dihitung.`,
        );
      }

      builder
        .struct("symbol", symbol)
        .struct("positionSide", positionSide)
        .struct("riskLevel", result.riskLevel)
        .struct("depthToStopLossNotionalUsd", result.depthToStopLossNotionalUsd)
        .struct("openInterestExtracted", result.openInterestExtracted)
        .struct("slWalkRejected", result.slWalkRejected);

      return builder.build();
    },
  );
}
