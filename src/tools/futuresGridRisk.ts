import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { fetchBinanceMarketData } from "../binanceFetcher.js";
import { fetchMarketContext } from "../marketContext.js";
import { calculateGridRisk } from "../gridRiskEngine.js";

const gridRiskSchema = {
  symbol: z.string().trim().min(1).max(30).describe("Binance Futures symbol, e.g. BTCUSDT"),
  initialCapital: z.number().finite().positive().describe("Initial capital in USD"),
  lowerPrice: z.number().finite().positive().describe("Lower grid price"),
  upperPrice: z.number().finite().positive().describe("Upper grid price"),
  currentPrice: z.number().finite().positive().describe("Current market price"),
  gridCount: z.number().int().min(2).max(500).describe("Number of grid levels"),
  stopLossPrice: z.number().finite().positive().describe("Long-grid stop-loss price"),
  leverage: z.number().finite().positive().max(125).describe("Futures leverage"),
  gridType: z.enum(["ARITHMETIC", "GEOMETRIC"]).describe("Grid price distribution method"),
  feeRate: z.number().finite().min(0).max(0.1).default(0.0005).describe("Trading fee rate"),
};

export function registerFuturesGridRiskTool(server: McpServer): void {
  registerSafeTool(
    server,
    "analyze_futures_grid_risk",
    {
      title: "Analyze Futures Grid Risk",
      description:
        "Analyze Binance Futures long-grid risk with core grid math, Market Regime context, Top-Trader/OI squeeze risk, dynamic stress, and circuit-breaker decisions.",
      inputSchema: gridRiskSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const [marketData, contextualRisk] = await Promise.all([
          fetchBinanceMarketData(params.symbol, params.stopLossPrice),
          fetchMarketContext(params.symbol),
        ]);

        const analysis = calculateGridRisk(params, marketData, contextualRisk);
        const circuitBreakerTriggered = analysis.status === "REJECT";
        const circuitBreakerReason =
          analysis.rejectionReason ??
          analysis.decisionReason ??
          (analysis.minBreakevenCycles > 0
            ? `Do not close the bot before ${analysis.minBreakevenCycles} profitable cycles unless a risk circuit breaker is triggered.`
            : "No cycle threshold is available because the setup is not profitable.");

        const payload = {
          symbol: params.symbol.toUpperCase(),
          metrics: analysis,
          market: marketData,
          context: contextualRisk,
          anomalies: {
            gridTypeMismatch: analysis.gridTypeMismatch,
            marketRegimeUnavailable: !contextualRisk.contextAvailable,
            bearishBreakout:
              contextualRisk.marketRegime === "BREAKOUT" &&
              (contextualRisk.priceChangePct ?? 0) < 0,
            bullishBreakout:
              contextualRisk.marketRegime === "BREAKOUT" &&
              (contextualRisk.priceChangePct ?? 0) > 0,
            longSqueezeRisk: contextualRisk.longSqueezeRisk,
          },
          circuit_breaker: {
            triggered: circuitBreakerTriggered,
            status: analysis.status,
            minimumCycles: analysis.minBreakevenCycles,
            reason: circuitBreakerReason,
          },
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
          structuredContent: payload,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";

        return {
          content: [
            {
              type: "text",
              text: `Failed to analyze Futures Grid Risk: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
