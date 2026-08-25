// cme_get_institutional_positioning -- laporan CFTC Commitment of Traders
// (Traders in Financial Futures) MINGGUAN buat kontrak CME Bitcoin/Ether.
// BUKAN real-time -- data lag beberapa hari (dirilis Jumat, per posisi
// Selasa), TIDAK ada basis vs Binance (real-time CME price butuh data
// vendor berbayar, di luar scope). Isinya positioning "Leveraged Funds"
// (paling deket "smart money spekulatif" institusional) + "Asset Managers"
// (dana lebih pasif). Nyaris nol retail noise -- kontrak CME cuma bisa
// diakses institusi/trader teregulasi, beda dari OI Binance yang campur
// retail+institusi.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCftcPositioning, type CftcPositioningReport } from "../cftcClient.js";
import { errorResult } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtNum, fmtPct } from "../format.js";
import { z } from "zod";

export function registerCftcPositioningTools(server: McpServer): void {
  registerSafeTool(
    server,
    "cme_get_institutional_positioning",
    {
      title: "Positioning Institusional CME (CFTC Commitment of Traders, Mingguan)",
      description:
        "Laporan CFTC Commitment of Traders (Traders in Financial Futures) MINGGUAN untuk kontrak CME Bitcoin/Ether -- " +
        "net long/short Leveraged Funds (paling deket 'smart money spekulatif' institusional) + Asset Managers, plus " +
        "perubahan vs minggu lalu. PENTING: data LAG beberapa hari (rilis Jumat, posisi per Selasa), BUKAN sinyal intraday -- " +
        "gak ada real-time basis vs Binance (butuh data vendor berbayar, di luar scope tool ini).",
      inputSchema: { coin: z.enum(["BTC", "ETH"]).describe("Coin CME yang didukung saat ini: BTC atau ETH.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ coin }) => {
      try {
        const report: CftcPositioningReport = await getCftcPositioning(coin);

        const builder = new ToolResponseBuilder()
          .header(`CME Institutional Positioning -- ${report.contractMarketName}`)
          .row("Tanggal Laporan", report.reportDate.slice(0, 10))
          .row("Open Interest", fmtNum(report.openInterest, 0))
          .subheader("Leveraged Funds (Smart Money Spekulatif)")
          .row("Long", fmtNum(report.leveragedFunds.long, 0))
          .row("Short", fmtNum(report.leveragedFunds.short, 0))
          .row("Net % OI", fmtPct(report.leveragedFunds.netPct, 2))
          .row("Perubahan Long WoW", fmtNum(report.leveragedFunds.changeLong, 0))
          .row("Perubahan Short WoW", fmtNum(report.leveragedFunds.changeShort, 0))
          .subheader("Asset Managers (Institusional Pasif)")
          .row("Long", fmtNum(report.assetManagers.long, 0))
          .row("Short", fmtNum(report.assetManagers.short, 0))
          .row("Net % OI", fmtPct(report.assetManagers.netPct, 2))
          .note(
            "Data mingguan (CFTC TFF report, rilis Jumat, posisi per Selasa) -- LAG, bukan real-time. " +
              "Leveraged Funds = kategori CFTC resmi (dana spekulatif/leverage), BUKAN 'Managed Money' (istilah itu dari " +
              "laporan Disaggregated komoditas fisik, dataset beda).",
          )
          .struct("report", report);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
