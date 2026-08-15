import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { fetchBinanceMarketData } from "../binanceFetcher.js";
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
        "Analyze Binance Futures long-grid risk using capital allocation, stop loss, dynamic liquidation, funding bleed, and stressed loss.",
      inputSchema: gridRiskSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const marketData = await fetchBinanceMarketData(
          params.symbol,
          params.stopLossPrice,
        );

        const analysis = calculateGridRisk(params, marketData);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  symbol: params.symbol.toUpperCase(),
                  metrics: analysis,
                  market: marketData,
                  circuit_breaker: {
                    triggered: analysis.status === "REJECT",
                    status: analysis.status,
                    reason: analysis.rejectionReason ?? null,
                  },
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            symbol: params.symbol.toUpperCase(),
            metrics: analysis,
            market: marketData,
            circuit_breaker: {
              triggered: analysis.status === "REJECT",
              status: analysis.status,
              reason: analysis.rejectionReason ?? null,
            },
          },
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
