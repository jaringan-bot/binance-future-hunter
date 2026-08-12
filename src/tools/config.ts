import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { symbolSchema, errorResult } from "../shared.js";
import { getJson, putJson } from "../kvConfig.js";

export interface PairThreshold {
  fundingThreshold?: number;
  basisThreshold?: number;
}

const THRESHOLD_KEY_PREFIX = "threshold:";

// Dipakai binance_get_funding_rate & binance_get_spot_price buat cek
// override sebelum fallback ke default hardcoded (±0.0003/±0.0005).
// SENGAJA menelan error KV (misal CONFIG_KV belum ke-bind) alih-alih throw --
// tool funding rate/basis harus tetap jalan pakai default walau KV
// bermasalah, bukan ikut gagal total gara-gara fitur pelengkap ini.
export async function getPairThreshold(symbol: string): Promise<PairThreshold | null> {
  try {
    return await getJson<PairThreshold>(`${THRESHOLD_KEY_PREFIX}${symbol.toUpperCase()}`);
  } catch {
    return null;
  }
}

function fmtThresholdPct(v: number | undefined): string {
  return v === undefined ? "default" : `${(v * 100).toFixed(4)}%`;
}

export function registerConfigTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_set_pair_threshold",
    {
      title: "Set Threshold Custom per Pair",
      description:
        "Simpan threshold funding rate dan/atau basis custom untuk sebuah pair, menggantikan default hardcoded " +
        "(±0.03% funding, ±0.05% basis) yang dipakai binance_get_funding_rate dan binance_get_spot_price. Berguna " +
        "karena pair volatil (altcoin kecil) dan pair stabil (BTC/ETH) punya rentang funding/basis 'normal' yang " +
        "beda jauh -- threshold universal bisa false-positive di pair volatil atau kurang sensitif di pair stabil. " +
        "Disimpan permanen di Workers KV sampai di-overwrite. Kirim tanpa salah satu parameter (undefined) untuk " +
        "reset field itu balik ke default.",
      inputSchema: {
        symbol: symbolSchema,
        fundingThreshold: z
          .number()
          .positive()
          .optional()
          .describe("Threshold funding rate custom (desimal, misal 0.001 = 0.1%). Kosongkan untuk pakai default (0.0003)."),
        basisThreshold: z
          .number()
          .positive()
          .optional()
          .describe("Threshold basis custom (desimal, misal 0.001 = 0.1%). Kosongkan untuk pakai default (0.0005)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ symbol, fundingThreshold, basisThreshold }) => {
      try {
        const value: PairThreshold = { fundingThreshold, basisThreshold };
        await putJson(`${THRESHOLD_KEY_PREFIX}${symbol}`, value);

        const text = [
          `# Threshold Custom Disimpan — ${symbol}`,
          ``,
          `- Funding Threshold: ${fmtThresholdPct(fundingThreshold)}`,
          `- Basis Threshold: ${fmtThresholdPct(basisThreshold)}`,
          ``,
          `_Dipakai otomatis oleh binance_get_funding_rate dan binance_get_spot_price untuk pair ${symbol} mulai panggilan berikutnya. Field yang dikosongkan (undefined) balik pakai default global._`,
        ].join("\n");

        return { content: [{ type: "text", text }], structuredContent: { symbol, ...value } };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerSafeTool(
    server,
    "binance_get_pair_threshold",
    {
      title: "Cek Threshold Custom per Pair",
      description:
        "Cek apakah sebuah pair punya threshold funding/basis custom yang sudah di-set lewat " +
        "binance_set_pair_threshold, atau masih pakai default global.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const custom = await getPairThreshold(symbol);
        const text = custom
          ? [
              `# Threshold — ${symbol}`,
              ``,
              `- Funding Threshold: ${fmtThresholdPct(custom.fundingThreshold)}`,
              `- Basis Threshold: ${fmtThresholdPct(custom.basisThreshold)}`,
            ].join("\n")
          : `# Threshold — ${symbol}\n\nBelum ada threshold custom, pakai default global (funding ±0.03%, basis ±0.05%).`;

        return { content: [{ type: "text", text }], structuredContent: { symbol, custom } };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
