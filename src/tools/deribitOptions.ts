// binance_get_options_positioning -- skew put/call OI dari Deribit public API
// (BTC/ETH). Bukan sinyal Binance-native; sumber institusional options market
// yang hilang di stack futures-only. Agregasi murni di deribitClient -- tool
// ini thin wrapper. BELUM dikalibrasi; jangan fuse ke institutionalFlow dulu.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getOptionsSummary, computeOptionsPositioning } from "../deribitClient.js";
import { errorResult } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtNum } from "../format.js";

export function registerDeribitOptionsTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_get_options_positioning",
    {
      title: "Options Positioning Deribit (Put/Call OI, BTC/ETH)",
      description:
        "Agregat open interest put vs call di pasar options Deribit (BTC atau ETH) -- put/call ratio dari OI, " +
        "plus jumlah instrument. Sumber publik tanpa auth (bukan Binance). Put/call diinfer dari suffix " +
        "instrument_name (-P/-C); field option_type Deribit tidak dipakai (absen di response live). " +
        "PENTING: heuristik positioning, BELUM dikalibrasi -- bukan sinyal entry sendiri; " +
        "belum digabung ke binance_analyze_institutional_flow.",
      inputSchema: {
        coin: z.enum(["BTC", "ETH"]).describe("Underlying options Deribit yang didukung: BTC atau ETH."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ coin }) => {
      try {
        const instruments = await getOptionsSummary(coin);
        const positioning = computeOptionsPositioning(instruments, coin);

        const builder = new ToolResponseBuilder()
          .header(`Deribit Options Positioning -- ${coin}`)
          .row("Instrument (put+call)", fmtNum(positioning.instrumentCount, 0))
          .row("Calls", fmtNum(positioning.callCount, 0))
          .row("Puts", fmtNum(positioning.putCount, 0))
          .row("Total Call OI", fmtNum(positioning.totalCallOi, 1))
          .row("Total Put OI", fmtNum(positioning.totalPutOi, 1))
          .row(
            "Put/Call Ratio (OI)",
            positioning.putCallRatio === null ? "n/a (call OI = 0)" : positioning.putCallRatio.toFixed(3),
          )
          .row("Total Volume 24h", fmtNum(positioning.totalVolume, 1))
          .note(
            "Data publik Deribit (get_book_summary_by_currency, kind=option). Put/call dari suffix " +
              "instrument_name (-P/-C). Heuristik, belum dikalibrasi; tidak digabung ke skor institutional flow.",
          )
          .struct("positioning", positioning);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
