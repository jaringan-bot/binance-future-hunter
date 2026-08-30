import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSafeTool } from "../toolWrapper.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtTime } from "../format.js";
import { symbolSchema, errorResult, asArray } from "../shared.js";

export function registerRiskTools(server: McpServer): void {
  // ─────────────────────────────────────────────────────────────
  // ADL RISK
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_adl_risk",
    {
      title: "ADL Risk Rating",
      description:
        "Rating risiko Auto-Deleveraging (ADL) LOW/MEDIUM/HIGH per pair (agregat level symbol, bukan posisi kamu), " +
        "LANGSUNG dari Binance native. PENTING: di-update tiap 30 MENIT, bukan real-time -- konteks risiko umum, " +
        "bukan keputusan eksekusi presisi detik.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getAdlRiskNative(symbol);
        const text = [
          `# ADL Risk Rating — ${data.symbol}`,
          ``,
          `- Rating: **${data.adlRisk}**`,
          `- Update Time: ${fmtTime(data.updateTime)}`,
          ``,
          `_Rating LOW/MEDIUM/HIGH, diupdate tiap 30 menit dari sisi Binance (agregat level symbol, bukan per posisi). ` +
            `Gunakan bersama \`binance_get_insurance_fund_balance\` untuk konteks tambahan seberapa besar buffer insurance fund menutup potensi ADL._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol: data.symbol, adlRisk: data.adlRisk, updateTime: data.updateTime },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // INSURANCE FUND BALANCE
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_insurance_fund_balance",
    {
      title: "Insurance Fund Balance Snapshot",
      description:
        "Mengambil snapshot saldo insurance fund Binance Futures per asset margin (LANGSUNG dari Binance native, " +
        "endpoint publik). Insurance fund yang tebal = buffer lebih besar buat nutup liquidation yang gak ke-cover " +
        "posisi trader (ngurangin kemungkinan ADL nge-trigger ke trader lain). " +
        "PENTING: ini SNAPSHOT HISTORIS periodik, BUKAN saldo live/real-time -- gunakan buat konteks kesehatan " +
        "sistem jangka menengah-panjang, bukan sinyal jangka pendek.",
      inputSchema: {
        symbol: symbolSchema.optional().describe("Filter symbol tertentu -- opsional, kosongkan untuk semua asset margin."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getInsuranceFundBalanceNative(symbol);
        const assets = asArray<binanceProxy.InsuranceFundAsset>(data?.assets);
        const symbols = asArray<string>(data?.symbols);
        const rows = assets
          .map((a) => `| ${a.asset} | ${a.marginBalance} | ${fmtTime(a.updateTime)} |`)
          .join("\n");
        const emptyNote =
          assets.length === 0
            ? `_Tidak ada baris insurance fund${symbol ? ` untuk ${symbol}` : " (payload kosong / tanpa filter symbol)"}. Bukan crash — endpoint bisa balikin object tanpa \`assets\`._`
            : `_Gunakan bersama \`binance_get_adl_risk\` untuk konteks lengkap risiko ADL di pair kamu._`;
        const text = [
          `# Insurance Fund Balance${symbol ? ` — ${symbol}` : ""}`,
          ``,
          `Symbols tercakup: ${symbols.length ? symbols.join(", ") : "(tidak ada)"}`,
          ``,
          `| Asset | Margin Balance | Update Time |`,
          `|---|---|---|`,
          rows || `| _kosong_ | - | - |`,
          ``,
          emptyNote,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { symbols, assets },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
