// Cron snapshot posisi wallet whale Hyperliquid -- dipanggil dari
// scheduled() (index.ts) di Cron Trigger terpisah tiap 15 menit (posisi
// whale gak berubah secepat orderbook, gak perlu granularity 1-menit kayak
// wallTrackingCron.ts). Ekstrak jadi fungsi single-address (pola sama
// scanWallCandidates) supaya gampang diuji/dipanggil -- loop watchlist +
// try/catch per address dilakukan di index.ts, bukan di sini.
import { getUserClearinghouseState } from "../hyperliquidClient.js";
import { insertHyperliquidWhaleSnapshots, type HyperliquidWhaleSnapshotRow } from "../d1Client.js";

export async function snapshotWhaleWallet(address: string): Promise<void> {
  const positions = await getUserClearinghouseState(address);
  const capturedAt = Date.now();

  const rows: HyperliquidWhaleSnapshotRow[] = positions.map((p) => ({
    walletAddress: address,
    coin: p.coin,
    capturedAt,
    side: p.side,
    size: p.size,
    entryPrice: p.entryPrice,
    leverage: p.leverage,
  }));

  await insertHyperliquidWhaleSnapshots(rows);
}
