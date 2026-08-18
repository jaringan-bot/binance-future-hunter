// binance_get_orderbook_wall_persistence -- baca histori wall_tracking (D1,
// diisi Cron 1-menit di src/cron/wallTrackingCron.ts) buat cek apakah wall
// kandidat di harga tertentu bertahan/menyusut/hilang dari waktu ke waktu.
// Pola D1-read-backed tool sama seperti basisHistory.ts (bukan live-fetch
// kayak orderbook.ts), makanya file terpisah + registrar sendiri.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { fmtNum, fmtTime } from "../format.js";
import { errorResult, SNAPSHOT_WATCHLIST } from "../shared.js";
import { queryWallPersistence, type WallPersistencePoint } from "../d1Client.js";

// Wall dianggap hilang kalau row terbaru dalam window lebih tua dari ini --
// artinya tick cron 1-menit terbaru (lebih dari 1 tick) gak lagi nangkep
// level ini sebagai wall kandidat (qty udah turun di bawah ambang 2x median).
const STALE_MS = 2 * 60 * 1000;
const SHRINK_THRESHOLD_PCT = -40;

export type WallStatus = "BERTAHAN" | "MENYUSUT" | "HILANG";

export function computeWallStatus(
  points: WallPersistencePoint[],
  now: number,
): { status: WallStatus; changePct: number | null } {
  const last = points[points.length - 1];
  const first = points[0];

  if (now - last.capturedAt > STALE_MS) {
    return { status: "HILANG", changePct: null };
  }

  const changePct = first.qty !== 0 ? ((last.qty - first.qty) / first.qty) * 100 : 0;
  if (changePct <= SHRINK_THRESHOLD_PCT) {
    return { status: "MENYUSUT", changePct };
  }
  return { status: "BERTAHAN", changePct };
}

function formatStatusLabel(result: { status: WallStatus; changePct: number | null }): string {
  if (result.status === "MENYUSUT") {
    return `MENYUSUT (${Math.abs(result.changePct ?? 0).toFixed(1)}%)`;
  }
  return result.status;
}

export function registerWallPersistenceTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_get_orderbook_wall_persistence",
    {
      title: "Order Book Wall Persistence",
      description:
        "Cek apakah wall kandidat di harga tertentu masih bertahan dibanding N menit lalu, menggunakan data historis " +
        "dari wall_tracking (diisi cron tiap 1 menit, watchlist tetap saja). PENTING: hanya tersedia untuk symbol " +
        "watchlist tetap BTCUSDT/ETHUSDT/SOLUSDT/BNBUSDT/XRPUSDT/DOGEUSDT/ADAUSDT/AVAXUSDT/LINKUSDT/LTCUSDT -- symbol " +
        "lain tidak punya histori tersimpan. Berguna untuk verifikasi sinyal absorption (wall bertahan saat harga " +
        "mendekat) dan deteksi spoofing (wall menyusut >40% dalam waktu singkat).",
      inputSchema: {
        symbol: z.enum(SNAPSHOT_WATCHLIST).describe(`Symbol dari watchlist tetap: ${SNAPSHOT_WATCHLIST.join(", ")}`),
        priceLevel: z.number().positive().describe("Harga wall yang mau dicek persistence-nya"),
        side: z.enum(["bid", "ask"]).describe("Sisi order book tempat wall berada"),
        lookbackMinutes: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(5)
          .describe("Rentang menit ke belakang yang mau dilihat (max 30)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, priceLevel, side, lookbackMinutes }) => {
      try {
        const points = await queryWallPersistence(symbol, side, priceLevel, lookbackMinutes);

        if (points.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "Tidak ada histori wall di harga ini pada window waktu tersebut -- kemungkinan wall baru terbentuk atau symbol di luar watchlist tetap.",
              },
            ],
          };
        }

        const now = Date.now();
        const result = computeWallStatus(points, now);

        const rows = points
          .map((p, i) => {
            const prev = points[i - 1];
            const change = prev && prev.qty !== 0 ? (((p.qty - prev.qty) / prev.qty) * 100).toFixed(1) + "%" : "-";
            return `| ${fmtTime(p.capturedAt)} | ${fmtNum(p.qty, 4)} | ${change} |`;
          })
          .join("\n");

        const text = [
          `# Wall Persistence — ${symbol} ${side} @ ${priceLevel}`,
          ``,
          `| Waktu | Size | Ubah vs snapshot sebelumnya |`,
          `|---|---|---|`,
          rows,
          ``,
          `Status: ${formatStatusLabel(result)}`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            side,
            priceLevel,
            lookbackMinutes,
            pointCount: points.length,
            status: result.status,
            changePct: result.changePct,
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
