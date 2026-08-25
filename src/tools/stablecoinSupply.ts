// whalescope_get_stablecoin_supply -- total + per-chain supply USDT/USDC,
// delta 24h/7d (DefiLlama). Dipakai sbg "dry powder" indicator terpisah --
// mint besar sering mendahului fase akumulasi institusional. BELUM
// terhubung ke scoring matrix grid-entry/dca-entry (integrasi ke prompt
// scoring di luar scope, bisa dibahas terpisah).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStablecoinSupply, type StablecoinSupply } from "../stablecoinClient.js";
import { errorResult } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtNum, fmtPct } from "../format.js";
import { z } from "zod";

export function registerStablecoinSupplyTools(server: McpServer): void {
  registerSafeTool(
    server,
    "whalescope_get_stablecoin_supply",
    {
      title: "Supply Stablecoin (USDT/USDC, Dry Powder Indicator)",
      description:
        "Total + per-chain circulating supply USDT/USDC (DefiLlama), plus delta 24 jam & 7 hari -- 'dry powder' indicator, " +
        "mint besar sering mendahului fase akumulasi institusional. Data on-chain, gak bisa dipalsu kayak candle/orderbook.",
      inputSchema: { symbol: z.enum(["USDT", "USDC"]) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const supply: StablecoinSupply = await getStablecoinSupply(symbol);

        const builder = new ToolResponseBuilder()
          .header(`Stablecoin Supply -- ${supply.name} (${supply.symbol})`)
          .row("Total Circulating", `$${fmtNum(supply.circulating, 0)}`)
          .row("Perubahan 24 Jam", fmtPct(supply.changeDayPct, 3))
          .row("Perubahan 7 Hari", fmtPct(supply.changeWeekPct, 3))
          .subheader(`Top ${supply.topChains.length} Chain`)
          .table(
            ["Chain", "Circulating"],
            supply.topChains.map((c) => [c.chain, `$${fmtNum(c.circulating, 0)}`]),
          )
          .note("Mint (supply naik tajam) sering mendahului fase akumulasi -- dry powder siap dipakai beli. Burn (supply turun) bisa nunjuk redemption/risk-off.")
          .struct("supply", supply);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
