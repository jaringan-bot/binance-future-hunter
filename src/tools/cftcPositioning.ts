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
import { getCftcPositioning, computeCftcTrend, type CftcPositioningReport } from "../cftcClient.js";
import { queryCftcPositioningHistory } from "../d1Client.js";
import { errorResult } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtNum, fmtPct } from "../format.js";
import { z } from "zod";

const MAX_TREND_WEEKS = 26;

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

  registerSafeTool(
    server,
    "cme_get_institutional_positioning_trend",
    {
      title: "Trend Positioning Institusional CME (Multi-Minggu, dari Histori Lokal)",
      description:
        "Rate-of-change Leveraged Funds/Asset Managers CME (BTC/ETH) lintas beberapa minggu, dihitung dari histori " +
        "lokal yang disimpan cron (cftc_positioning_history, D1) -- BEDA dari `cme_get_institutional_positioning` " +
        "yang cuma kasih WoW dari API CFTC langsung (1 minggu). PENTING: data baru mulai terkumpul sejak fitur ini " +
        "dirilis (BUKAN backfill retroaktif) -- window awal bakal pendek (sedikit minggu) sampai histori terkumpul " +
        "cukup. Direction (RISING/FALLING/FLAT) pakai deadband 2 poin persentase, HEURISTIK belum dikalibrasi " +
        "statistik -- sama seperti threshold lain di repo ini.",
      inputSchema: {
        coin: z.enum(["BTC", "ETH"]).describe("Coin CME yang didukung saat ini: BTC atau ETH."),
        weeks: z
          .number()
          .int()
          .min(2)
          .max(MAX_TREND_WEEKS)
          .default(8)
          .describe(`Jumlah laporan mingguan terbaru yang dipakai buat window trend (2-${MAX_TREND_WEEKS}, default 8).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ coin, weeks }) => {
      try {
        const history = await queryCftcPositioningHistory(coin, weeks);
        const trend = computeCftcTrend(history.map((h) => ({ reportDate: h.reportDate, openInterest: h.openInterest, levNetPct: h.levNetPct, amNetPct: h.amNetPct })));

        if (trend.weeksAvailable === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Belum ada histori CFTC tersimpan untuk coin ini -- cron snapshot (piggyback HEARTBEAT_CRON, 3x/hari) " +
                  "baru mulai ngisi cftc_positioning_history sejak fitur ini di-deploy. Coba lagi setelah minimal 1 " +
                  "laporan mingguan CFTC baru terlewat, atau pakai `cme_get_institutional_positioning` untuk snapshot terkini.",
              },
            ],
          };
        }

        const builder = new ToolResponseBuilder()
          .header(`CME Institutional Positioning Trend -- ${coin}`)
          .row("Laporan Tersedia", `${trend.weeksAvailable} minggu`)
          .row("Periode", `${trend.oldest?.reportDate} → ${trend.latest?.reportDate}`)
          .row("Leveraged Funds Net % OI (terkini)", fmtPct(trend.latest?.levNetPct ?? 0, 2))
          .row("Perubahan Net % (window)", `${(trend.levNetPctChange ?? 0).toFixed(2)} poin`)
          .row("Asset Managers Perubahan Net % (window)", `${(trend.amNetPctChange ?? 0).toFixed(2)} poin`)
          .row("Direction (Leveraged Funds)", trend.direction)
          .note(
            "Direction dari deadband 2 poin persentase (heuristik, belum dikalibrasi). Histori baru mulai terkumpul " +
              "sejak fitur ini dirilis -- window pendek berarti confidence rendah, jangan simpulkan trend jangka " +
              "panjang dari sedikit minggu data.",
          )
          .struct("trend", trend);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
