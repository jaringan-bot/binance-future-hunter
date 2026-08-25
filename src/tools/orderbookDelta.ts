import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import * as binanceProxy from "../binanceProxyClient.js";
import type { OrderBookDepth } from "../binanceProxyClient.js";
import { fmtNum, fmtPrice } from "../format.js";
import { symbolSchema, errorResult, detailParam } from "../shared.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { findWallCandidates } from "../cron/wallTrackingCron.js";

// Wall dianggap SPOOFED kalau qty menyusut >70% antar 2 snapshot TANPA
// harga crossing level itu (definisi sama dengan wall_tracking cron, lihat
// findWallCandidates di src/cron/wallTrackingCron.ts).
const WALL_VANISH_THRESHOLD_PCT = -70;
const DEFAULT_DELAY_MS = 1500;
const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 5000;

interface WallDelta {
  side: "bid" | "ask";
  price: number;
  qty1: number;
  qty2: number;
  changePct: number;
  priceCrossed: boolean;
  status: "PRICE_MOVED_THROUGH" | "SPOOFED" | "HELD";
}

interface OrderBookDelta {
  wallDeltas: WallDelta[];
  bestBid1: number;
  bestAsk1: number;
  bestBid2: number;
  bestAsk2: number;
  spreadPct1: number;
  spreadPct2: number;
}

function compareOrderBookSnapshots(snap1: OrderBookDepth, snap2: OrderBookDepth): OrderBookDelta {
  const bidWalls1 = findWallCandidates(snap1.bids).map((w) => ({ ...w, side: "bid" as const }));
  const askWalls1 = findWallCandidates(snap1.asks).map((w) => ({ ...w, side: "ask" as const }));
  const bidMap2 = new Map(snap2.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]));
  const askMap2 = new Map(snap2.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]));
  const bestBid1 = snap1.bids[0] ? parseFloat(snap1.bids[0][0]) : 0;
  const bestAsk1 = snap1.asks[0] ? parseFloat(snap1.asks[0][0]) : 0;
  const bestBid2 = snap2.bids[0] ? parseFloat(snap2.bids[0][0]) : 0;
  const bestAsk2 = snap2.asks[0] ? parseFloat(snap2.asks[0][0]) : 0;

  const wallDeltas: WallDelta[] = [...bidWalls1, ...askWalls1].map((w) => {
    const qty2 = (w.side === "bid" ? bidMap2 : askMap2).get(w.price) ?? 0;
    const changePct = w.qty > 0 ? ((qty2 - w.qty) / w.qty) * 100 : 0;
    const priceCrossed = w.side === "bid" ? bestAsk2 > 0 && bestAsk2 <= w.price : bestBid2 > 0 && bestBid2 >= w.price;
    const status: WallDelta["status"] = priceCrossed
      ? "PRICE_MOVED_THROUGH"
      : changePct <= WALL_VANISH_THRESHOLD_PCT
        ? "SPOOFED"
        : "HELD";
    return { side: w.side, price: w.price, qty1: w.qty, qty2, changePct, priceCrossed, status };
  });

  const spreadPct1 = bestBid1 > 0 ? ((bestAsk1 - bestBid1) / bestBid1) * 100 : 0;
  const spreadPct2 = bestBid2 > 0 ? ((bestAsk2 - bestBid2) / bestBid2) * 100 : 0;

  return { wallDeltas, bestBid1, bestAsk1, bestBid2, bestAsk2, spreadPct1, spreadPct2 };
}

async function fetchOrderBookDelta(
  symbol: string,
  limit = 20,
  delayMs = DEFAULT_DELAY_MS,
): Promise<OrderBookDelta> {
  const snap1 = await binanceProxy.getOrderBookDepth(symbol, limit);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const snap2 = await binanceProxy.getOrderBookDepth(symbol, limit);
  return compareOrderBookSnapshots(snap1, snap2);
}

function calculateSpoofingScoreFromDelta(params: { wallDeltas: WallDelta[] }): { score: number; evidence: string } {
  const { wallDeltas } = params;
  if (wallDeltas.length === 0) {
    return {
      score: 0.1,
      evidence: "Tidak ada wall (qty >=2x median) di snapshot 1 -- tidak ada kandidat untuk dibandingkan lintas 2 snapshot.",
    };
  }
  const spoofed = wallDeltas.filter((w) => w.status === "SPOOFED");
  if (spoofed.length === 0) {
    return {
      score: 0.1,
      evidence: `${wallDeltas.length} wall terdeteksi di snapshot 1, semua BERTAHAN atau hilang karena harga benar-benar crossing level itu (eksekusi wajar) -- tidak ada indikasi spoofing 2-snapshot.`,
    };
  }
  const largestOverall = wallDeltas.reduce((a, b) => (b.qty1 > a.qty1 ? b : a));
  const largestSpoofed = spoofed.reduce((a, b) => (b.qty1 > a.qty1 ? b : a));
  const isDominantWall = largestSpoofed.price === largestOverall.price && largestSpoofed.side === largestOverall.side;
  const score = isDominantWall ? 0.9 : 0.5;
  return {
    score,
    evidence: `Wall ${largestSpoofed.side} di harga ${largestSpoofed.price} (qty ${fmtNum(largestSpoofed.qty1, 2)} -> ${fmtNum(largestSpoofed.qty2, 2)}, ${largestSpoofed.changePct.toFixed(1)}%) hilang/menyusut >70% TANPA harga crossing level itu -- indikasi spoofing 2-snapshot ${isDominantWall ? "pada wall TERBESAR yang terdeteksi (high confidence)." : "pada wall sekunder, bukan wall terbesar (moderate confidence)."}`,
  };
}

export function registerOrderbookDeltaTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_get_orderbook_delta",
    {
      title: "Orderbook 2-Snapshot Delta (Spoofing Riil)",
      description:
        "Ambil 2 snapshot order book ~1-2 detik terpisah (jeda default 1500ms), bandingkan wall (qty >=2x median sisi yang sama, definisi sama dengan wall_tracking cron) antar snapshot -- wall yang hilang/menyusut >70% TANPA harga crossing level itu = indikasi spoofing riil (beda dari binance_get_order_book_depth yang cuma 1 snapshot). Dipakai juga secara internal oleh binance_detect_mm_activity. PENTING: menambah latency ~1-2 detik per call karena 2 fetch berurutan + jeda.",
      inputSchema: {
        symbol: symbolSchema,
        limit: z
          .number()
          .int()
          .refine((v) => [5, 10, 20, 50, 100, 500, 1000].includes(v), {
            message: "limit harus salah satu dari: 5, 10, 20, 50, 100, 500, 1000 (sesuai batasan Binance API)",
          })
          .default(20)
          .describe("Jumlah level bid/ask per sisi per snapshot."),
        delayMs: z
          .number()
          .int()
          .min(MIN_DELAY_MS)
          .max(MAX_DELAY_MS)
          .default(DEFAULT_DELAY_MS)
          .describe(`Jeda antar 2 snapshot dalam ms, ${MIN_DELAY_MS}-${MAX_DELAY_MS}, default ${DEFAULT_DELAY_MS}.`),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit, delayMs, detail }) => {
      try {
        const delta = await fetchOrderBookDelta(symbol, limit, delayMs);
        const spoofing = calculateSpoofingScoreFromDelta({ wallDeltas: delta.wallDeltas });
        const spoofed = delta.wallDeltas.filter((w) => w.status === "SPOOFED");

        const builder = new ToolResponseBuilder()
          .header(`${symbol} — Orderbook Delta (${delayMs}ms terpisah)`)
          .row("Spread snapshot 1 -> 2", `${delta.spreadPct1.toFixed(4)}% -> ${delta.spreadPct2.toFixed(4)}%`)
          .row("Spoofing score", `${spoofing.score.toFixed(2)} -- ${spoofing.evidence}`);

        const shown = detail === "full" ? delta.wallDeltas : spoofed.length > 0 ? spoofed : delta.wallDeltas.slice(0, 5);
        if (shown.length > 0) {
          builder.table(
            ["Side", "Price", "Qty1", "Qty2", "Change%", "Status"],
            shown.map((w) => [w.side, fmtPrice(w.price), fmtNum(w.qty1, 2), fmtNum(w.qty2, 2), w.changePct.toFixed(1), w.status]),
          );
        } else {
          builder.row("Wall", "tidak ada wall (qty >=2x median) di snapshot 1");
        }

        builder
          .note("Snapshot sesaat x2 -- pola spoofing bisa berubah cepat, jangan overinterpretasi 1 pasang snapshot.")
          .struct("symbol", symbol)
          .struct("spoofingScore", spoofing.score)
          .struct("spoofingEvidence", spoofing.evidence)
          .struct("wallDeltas", detail === "full" ? delta.wallDeltas : shown);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
