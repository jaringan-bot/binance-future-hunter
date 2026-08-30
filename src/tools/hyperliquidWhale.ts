// hyperliquid_get_whale_wallet_positions -- agregat posisi HYPERLIQUID_WHALE_WATCHLIST
// (shared.ts) untuk satu coin, dari snapshot cron 15-menit (hyperliquidWhaleCron.ts,
// D1 table hyperliquid_whale_snapshots). Beda dari whalescope_compare_funding_across_exchanges
// (yang narik data pasar agregat, gak identifiable per-wallet) -- ini jejak
// on-chain per address spesifik, gak bisa dipalsu/spoof kayak orderbook/candle.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryHyperliquidWhaleRecentByCoin, type HyperliquidWhaleSnapshotRow } from "../d1Client.js";
import { HYPERLIQUID_WHALE_WATCHLIST, errorResult, detailParam } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtNum, fmtPct } from "../format.js";
import { z } from "zod";

export type WhaleDeltaDirection = "new" | "flipped" | "accumulating" | "reducing" | "flat";

export interface WalletDelta {
  walletAddress: string;
  side: "long" | "short";
  latestSize: number;
  previousSize: number | null;
  deltaPct: number | null;
  direction: WhaleDeltaDirection;
}

// Ambang 5% -- di bawah ini dianggap noise (posisi gak "beneran" berubah),
// sama filosofi ambang median 2x di findWallCandidates (wallTrackingCron.ts):
// treshold eksplisit sederhana, bukan kalibrasi statistik.
const FLAT_THRESHOLD_PCT = 0.05;

// Fungsi murni, testable tanpa D1 -- kelompokkan baris per wallet (query
// D1 sudah urut wallet_address ASC, captured_at DESC, maks 2 baris/wallet),
// lalu hitung delta size + arah tiap wallet.
export function computeWhaleDeltas(rows: HyperliquidWhaleSnapshotRow[]): WalletDelta[] {
  const byWallet = new Map<string, HyperliquidWhaleSnapshotRow[]>();
  for (const row of rows) {
    const list = byWallet.get(row.walletAddress) ?? [];
    list.push(row);
    byWallet.set(row.walletAddress, list);
  }

  const deltas: WalletDelta[] = [];
  for (const [walletAddress, group] of byWallet) {
    const [latest, previous] = group;
    if (!latest) continue;

    if (!previous) {
      deltas.push({
        walletAddress,
        side: latest.side,
        latestSize: latest.size,
        previousSize: null,
        deltaPct: null,
        direction: "new",
      });
      continue;
    }

    if (previous.side !== latest.side) {
      deltas.push({
        walletAddress,
        side: latest.side,
        latestSize: latest.size,
        previousSize: previous.size,
        deltaPct: null,
        direction: "flipped",
      });
      continue;
    }

    const deltaPct = previous.size !== 0 ? (latest.size - previous.size) / previous.size : 0;
    const direction: WhaleDeltaDirection =
      deltaPct > FLAT_THRESHOLD_PCT ? "accumulating" : deltaPct < -FLAT_THRESHOLD_PCT ? "reducing" : "flat";

    deltas.push({ walletAddress, side: latest.side, latestSize: latest.size, previousSize: previous.size, deltaPct, direction });
  }

  return deltas;
}

export interface WhaleAggregate {
  coin: string;
  totalWallets: number;
  netLongWallets: number;
  netShortWallets: number;
  accumulatingCount: number;
  reducingCount: number;
  flippedCount: number;
  confidencePct: number; // % wallet net long ATAU net short, mana yang dominan
}

export function aggregateWhaleDeltas(coin: string, deltas: WalletDelta[]): WhaleAggregate {
  const netLongWallets = deltas.filter((d) => d.side === "long").length;
  const netShortWallets = deltas.filter((d) => d.side === "short").length;
  const total = deltas.length;
  const dominant = Math.max(netLongWallets, netShortWallets);

  return {
    coin,
    totalWallets: total,
    netLongWallets,
    netShortWallets,
    accumulatingCount: deltas.filter((d) => d.direction === "accumulating").length,
    reducingCount: deltas.filter((d) => d.direction === "reducing").length,
    flippedCount: deltas.filter((d) => d.direction === "flipped").length,
    confidencePct: total > 0 ? dominant / total : 0,
  };
}

export function registerHyperliquidWhaleTools(server: McpServer): void {
  registerSafeTool(
    server,
    "hyperliquid_get_whale_wallet_positions",
    {
      title: "Posisi Whale Wallet Hyperliquid (On-Chain, per Coin)",
      description:
        "Agregat posisi wallet whale on-chain Hyperliquid (HYPERLIQUID_WHALE_WATCHLIST, curated manual) untuk satu coin -- " +
        "delta size vs snapshot 15 menit sebelumnya (akumulasi/reduksi/flip arah), plus confidence (persentase wallet searah). " +
        "Beda dari data candle/orderbook: ini posisi on-chain riil per address, gak bisa spoof. Kosong kalau watchlist belum diisi.",
      inputSchema: { coin: z.string().min(1).max(20).describe("Base asset Hyperliquid, contoh: BTC, ETH (bukan format pair BTCUSDT)."), detail: detailParam },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ coin, detail }) => {
      try {
        if (HYPERLIQUID_WHALE_WATCHLIST.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: [
                  `# Hyperliquid Whale Positions -- ${coin.toUpperCase()}`,
                  ``,
                  `Watchlist kosong — tidak ada wallet yang dikonfigurasi.`,
                  `Isi \`HYPERLIQUID_WHALE_WATCHLIST\` di src/shared.ts (atau secret JSON array saat deploy) sebelum tool ini punya data.`,
                ].join("\n"),
              },
            ],
            structuredContent: {
              coin: coin.toUpperCase(),
              watchlistConfigured: false,
              watchlistSize: 0,
            },
          };
        }

        const upperCoin = coin.toUpperCase();
        const rows = await queryHyperliquidWhaleRecentByCoin(upperCoin);
        const deltas = computeWhaleDeltas(rows);
        const aggregate = aggregateWhaleDeltas(upperCoin, deltas);

        const builder = new ToolResponseBuilder().header(`Hyperliquid Whale Positions -- ${upperCoin}`);

        if (aggregate.totalWallets === 0) {
          builder.note(
            `Belum ada snapshot posisi ${upperCoin} untuk wallet manapun di watchlist -- tunggu cron berikutnya (tiap 15 menit) atau coin ini memang gak dipegang wallet manapun di watchlist saat ini.`,
          );
        } else {
          builder
            .row("Total Wallet Dengan Posisi", fmtNum(aggregate.totalWallets, 0))
            .row("Net Long", fmtNum(aggregate.netLongWallets, 0))
            .row("Net Short", fmtNum(aggregate.netShortWallets, 0))
            .row("Akumulasi (>5%)", fmtNum(aggregate.accumulatingCount, 0))
            .row("Reduksi (>5%)", fmtNum(aggregate.reducingCount, 0))
            .row("Flip Arah", fmtNum(aggregate.flippedCount, 0))
            .row("Confidence (searah)", fmtPct(aggregate.confidencePct, 1));

          if (detail === "full") {
            builder.subheader("Detail per Wallet").table(
              ["Wallet", "Side", "Size Terbaru", "Delta", "Arah"],
              deltas.map((d) => [
                d.walletAddress,
                d.side,
                fmtNum(d.latestSize, 4),
                d.deltaPct === null ? "-" : fmtPct(d.deltaPct, 2),
                d.direction,
              ]),
            );
          }
        }

        builder.struct("coin", upperCoin).struct("aggregate", aggregate);
        if (detail === "full") builder.struct("deltas", deltas);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
