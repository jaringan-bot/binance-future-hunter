import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFundingTools } from "./tools/funding.js";
import { registerOpenInterestTools } from "./tools/openInterest.js";
import { registerRatiosTools } from "./tools/ratios.js";
import { registerOrderbookTools } from "./tools/orderbook.js";
import { registerTradesTools } from "./tools/trades.js";
import { registerLiquidationTools } from "./tools/liquidation.js";
import { registerPriceTools } from "./tools/price.js";
import { registerSpotTools } from "./tools/spot.js";
import { registerCompositeTools } from "./tools/composite.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "whalescope-mcp",
    version: "1.0.0",
  });

  registerFundingTools(server);
  registerOpenInterestTools(server);
  registerRatiosTools(server);
  registerOrderbookTools(server);
  registerTradesTools(server);
  registerLiquidationTools(server);
  registerPriceTools(server);
  registerSpotTools(server);
  registerCompositeTools(server);

  return server;
}
