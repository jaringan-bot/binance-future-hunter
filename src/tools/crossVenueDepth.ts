// whalescope_compare_orderbook_depth -- snapshot REAL-TIME (bukan histori,
// gak butuh D1/cron) orderbook Binance+Bybit+OKX bareng, cek wall besar
// (findWallCandidates, sama fungsi & ambang 2x median dengan
// wallTrackingCron.ts) yang muncul di satu harga mirip di >=2 venue
// sekaligus. Thesis: koordinasi spoof wall di banyak exchange independen
// sekaligus jauh lebih mahal/susah daripada spoof di 1 venue -- wall yang
// cuma nongol 1 venue lebih layak dicurigai daripada yang konsisten lintas
// venue. Sengaja TANPA time-series/D1 (beda dari binance_get_orderbook_wall_persistence)
// -- sinyal "berapa venue corroborate SEKARANG" valid sebagai snapshot,
// gak butuh histori buat berguna.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { getBybitOrderBookDepth } from "../bybitClient.js";
import { getOkxOrderBookDepth } from "../okxClient.js";
import { findWallCandidates } from "../cron/wallTrackingCron.js";
import { toExchangeSymbol } from "../symbolMap.js";
import { symbolSchema, errorResult, detailParam } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtNum, fmtPrice } from "../format.js";

const DEPTH_LIMIT = 50;
// Toleransi lebih lebar dari wall_tracking (0.05%) -- harga antar EXCHANGE
// beda venue (bukan antar tick di venue yang sama), butuh band lebih lega
// buat nangkep wall di "harga yang mirip" tanpa jadi terlalu longgar.
const CROSS_VENUE_PRICE_TOLERANCE = 0.0015;

export interface VenueWallCandidate {
  venue: string;
  side: "bid" | "ask";
  price: number;
  qty: number;
  medianRatio: number;
}

export interface CrossVenueWall extends VenueWallCandidate {
  corroboratedBy: string[];
}

// Fungsi murni, testable tanpa network -- cek tiap wall kandidat venue
// tertentu punya pasangan (side sama, harga dalam toleransi) di venue lain.
export function findCrossVenueWalls(candidates: VenueWallCandidate[]): CrossVenueWall[] {
  return candidates.map((c) => {
    const corroboratedBy = candidates
      .filter(
        (other) =>
          other.venue !== c.venue &&
          other.side === c.side &&
          Math.abs(other.price - c.price) / c.price <= CROSS_VENUE_PRICE_TOLERANCE,
      )
      .map((other) => other.venue);
    return { ...c, corroboratedBy };
  });
}

// Exported buat di-reuse LANGSUNG oleh binance_analyze_institutional_flow
// (src/tools/institutionalFlow.ts) -- fetch+compute orchestration yang
// sebelumnya cuma inline di handler tool ini, diekstrak supaya gak
// diduplikasi (pola sama seperti fullPipeline.ts reuse fungsi tool lain).
export async function fetchCrossVenueWalls(
  symbol: string,
): Promise<{ walls: CrossVenueWall[]; statusRows: string[][] }> {
  const bybitSymbol = toExchangeSymbol(symbol, "bybit");
  const okxSymbol = toExchangeSymbol(symbol, "okx");

  const [binanceRes, bybitRes, okxRes] = await Promise.allSettled([
    binanceProxy.getOrderBookDepth(symbol, DEPTH_LIMIT),
    bybitSymbol
      ? getBybitOrderBookDepth(bybitSymbol, DEPTH_LIMIT)
      : Promise.reject(new Error("Gagal di-mapping ke format symbol Bybit.")),
    okxSymbol
      ? getOkxOrderBookDepth(okxSymbol, DEPTH_LIMIT)
      : Promise.reject(new Error("Symbol tidak berakhiran USDT -- gak bisa di-mapping ke format OKX.")),
  ]);

  const venues: { venue: string; result: PromiseSettledResult<{ bids: [string, string][]; asks: [string, string][] }> }[] = [
    { venue: "Binance", result: binanceRes },
    { venue: "Bybit", result: bybitRes },
    { venue: "OKX", result: okxRes },
  ];

  const candidates: VenueWallCandidate[] = [];
  const statusRows: string[][] = [];

  for (const { venue, result } of venues) {
    if (result.status === "fulfilled") {
      const { bids, asks } = result.value;
      const bidWalls = findWallCandidates(bids).map((w) => ({ venue, side: "bid" as const, ...w }));
      const askWalls = findWallCandidates(asks).map((w) => ({ venue, side: "ask" as const, ...w }));
      candidates.push(...bidWalls, ...askWalls);
      statusRows.push([venue, "ok", fmtNum(bidWalls.length + askWalls.length, 0)]);
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      statusRows.push([venue, `gagal: ${message}`, "-"]);
    }
  }

  return { walls: findCrossVenueWalls(candidates), statusRows };
}

export function registerCrossVenueDepthTools(server: McpServer): void {
  registerSafeTool(
    server,
    "whalescope_compare_orderbook_depth",
    {
      title: "Bandingkan Orderbook Depth Antar Exchange (Binance/Bybit/OKX)",
      description:
        "Snapshot real-time orderbook Binance/Bybit/OKX bareng, cari wall besar (qty >= 2x median sisi yang sama) dan cek " +
        "apakah wall di harga mirip muncul di >=2 exchange sekaligus (Cross-Venue Corroborated) vs cuma 1 (Single-Venue Only, " +
        "lebih rawan spoof). Gak nyimpen histori -- snapshot sesaat. Symbol format Binance (BTCUSDT), auto-mapped ke exchange lain.",
      inputSchema: { symbol: symbolSchema, detail: detailParam },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, detail }) => {
      try {
        const { walls, statusRows } = await fetchCrossVenueWalls(symbol);
        const corroborated = walls.filter((w) => w.corroboratedBy.length > 0);
        const singleVenueOnly = walls.filter((w) => w.corroboratedBy.length === 0);

        const builder = new ToolResponseBuilder()
          .header(`Cross-Venue Orderbook Depth -- ${symbol}`)
          .table(["Venue", "Status", "Wall Kandidat"], statusRows)
          .subheader("Ringkasan Wall")
          .row("Total Wall Kandidat", fmtNum(walls.length, 0))
          .row("Cross-Venue Corroborated", fmtNum(corroborated.length, 0))
          .row("Single-Venue Only", fmtNum(singleVenueOnly.length, 0));

        if (detail === "full" && walls.length > 0) {
          builder.subheader("Detail Wall").table(
            ["Venue", "Side", "Price", "Qty", "Median Ratio", "Corroborated By"],
            walls.map((w) => [w.venue, w.side, fmtPrice(w.price), fmtNum(w.qty, 4), fmtNum(w.medianRatio, 2), w.corroboratedBy.join(", ") || "-"]),
          );
        }

        builder.note(
          "Cross-Venue Corroborated = ada wall di harga mirip (toleransi 0.15%) di >=2 exchange sekaligus -- lebih kredibel. " +
            "Single-Venue Only = cuma 1 exchange, lebih rawan spoof/wash order lokal.",
        );

        builder.struct("symbol", symbol).struct("summary", {
          totalWalls: walls.length,
          corroboratedCount: corroborated.length,
          singleVenueOnlyCount: singleVenueOnly.length,
        });
        if (detail === "full") builder.struct("walls", walls);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
