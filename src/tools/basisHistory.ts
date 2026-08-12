import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { fmtPct, fmtTime } from "../format.js";
import { errorResult } from "../shared.js";
import { getJson, putJson } from "../kvConfig.js";

// Watchlist yang di-snapshot Cron Trigger tiap 5 menit (lihat scheduled()
// handler di src/index.ts + [triggers] di wrangler.toml). Dipilih 3 pair
// paling likuid/sering dianalisis -- nambah symbol di sini nambah beban
// write KV (3 symbol x 288 snapshot/hari = 864 write/hari, di bawah limit
// 1.000 write/hari Free plan; tiap symbol tambahan nambah ~288 write/hari).
export const BASIS_HISTORY_WATCHLIST = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;

const MAX_POINTS = 288; // 24 jam @ interval 5 menit
const HISTORY_KEY_PREFIX = "basis_history:";

export interface BasisSnapshot {
  timestamp: number;
  spotPrice: number;
  markPrice: number;
  basis: number;
}

// Dipanggil dari scheduled() handler (src/index.ts) tiap Cron Trigger jalan.
export async function appendBasisSnapshot(symbol: string, point: BasisSnapshot): Promise<void> {
  const key = `${HISTORY_KEY_PREFIX}${symbol.toUpperCase()}`;
  const existing = (await getJson<BasisSnapshot[]>(key)) ?? [];
  const updated = [...existing, point].slice(-MAX_POINTS);
  await putJson(key, updated);
}

// Diekspor buat dipakai binance_detect_mm_activity (basis arbitrage
// z-score) -- tetap watchlist-only sama seperti tool binance_get_basis_history.
export async function readBasisHistory(symbol: string): Promise<BasisSnapshot[]> {
  return (await getJson<BasisSnapshot[]>(`${HISTORY_KEY_PREFIX}${symbol.toUpperCase()}`)) ?? [];
}

export function registerBasisHistoryTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_get_basis_history",
    {
      title: "Histori Basis Futures-vs-Spot (Time-Series)",
      description:
        "Baca histori basis futures-vs-spot dari snapshot Cron Trigger tiap 5 menit (BUKAN panggilan live seperti " +
        "binance_get_spot_price) -- dipakai untuk deteksi 'basis melebar lalu kembali dalam waktu singkat' " +
        "(docs/mm_detection_framework.md Section 5.1) yang sebelumnya harus dicek manual berkali-kali. " +
        `HANYA tersedia untuk watchlist tetap: ${BASIS_HISTORY_WATCHLIST.join(", ")} -- pair lain di luar itu tidak ` +
        "di-snapshot cron sama sekali. Data mulai terisi bertahap setelah worker pertama kali deploy dengan fitur " +
        "ini (butuh beberapa siklus 5 menit dulu sebelum histori berguna).",
      inputSchema: {
        symbol: z
          .enum(BASIS_HISTORY_WATCHLIST)
          .describe(`Symbol dari watchlist tetap: ${BASIS_HISTORY_WATCHLIST.join(", ")}`),
        hours: z
          .number()
          .int()
          .min(1)
          .max(24)
          .default(6)
          .describe("Rentang jam ke belakang yang mau dilihat, maksimal 24 (batas retensi snapshot)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, hours }) => {
      try {
        const all = await readBasisHistory(symbol);
        if (all.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Belum ada data histori basis untuk ${symbol}. Cron snapshot jalan tiap 5 menit -- kalau fitur ini baru di-deploy, tunggu beberapa siklus dulu sebelum histori berguna.`,
              },
            ],
          };
        }

        const cutoff = Date.now() - hours * 3600 * 1000;
        const points = all.filter((p) => p.timestamp >= cutoff);
        if (points.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Ada histori basis untuk ${symbol} tapi tidak ada data poin dalam ${hours} jam terakhir (data tertua tersimpan: ${fmtTime(all[0].timestamp)}).`,
              },
            ],
          };
        }

        const basisValues = points.map((p) => p.basis);
        const current = basisValues[basisValues.length - 1];
        const avg = basisValues.reduce((a, b) => a + b, 0) / basisValues.length;
        const max = Math.max(...basisValues);
        const min = Math.min(...basisValues);

        // Deteksi kasar "melebar lalu kembali": window ini pernah nyentuh
        // ekstrem (jauh dari rata-rata) tapi titik TERKINI udah balik deket
        // rata-rata window -- bukan bukti pasti, cuma indikasi buat ditelusuri lanjut.
        const maxDeviation = Math.max(Math.abs(max - avg), Math.abs(min - avg));
        const currentDeviation = Math.abs(current - avg);
        const revertedFromExtreme = maxDeviation > 0.0003 && currentDeviation < maxDeviation * 0.3;

        const recent = points.slice(-20);
        const rows = recent.map((p) => `| ${fmtTime(p.timestamp)} | ${fmtPct(p.basis, 4)} |`).join("\n");

        const text = [
          `# Histori Basis (Futures vs Spot) — ${symbol} (${hours} jam terakhir, ${points.length} snapshot)`,
          ``,
          `- Basis Terkini: ${fmtPct(current, 4)}`,
          `- Rata-rata Window: ${fmtPct(avg, 4)}`,
          `- Range: ${fmtPct(min, 4)} s/d ${fmtPct(max, 4)}`,
          ``,
          `**Indikasi**: ${revertedFromExtreme ? "Basis SEMPAT melebar jauh dari rata-rata lalu KEMBALI mendekat -- pola konsisten dengan basis arbitrage/hedging (docs/mm_detection_framework.md Section 5.1), tapi cross-check dulu dengan funding rate & OI di window waktu yang sama sebelum simpulkan." : "Belum ada pola 'melebar lalu kembali' yang jelas di window ini."}`,
          ``,
          `## ${recent.length} Snapshot Terakhir`,
          `| Waktu | Basis |`,
          `|---|---|`,
          rows,
          ``,
          `_Snapshot tiap 5 menit dari Cron Trigger, disimpan di Workers KV (maks ${MAX_POINTS} poin = 24 jam per symbol). Basis dihitung sama seperti binance_get_spot_price (mark price futures vs harga spot Binance)._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, hours, current, avg, min, max, revertedFromExtreme, pointCount: points.length },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
