// Market snapshot (basis futures-vs-spot + funding + OI) -> market_snapshots
// D1 -- diekstrak dari logic inline index.ts scheduled() (pola sama seperti
// scanWallCandidates/computeMmSignals) supaya testable + reusable dari 2
// tempat: watchlist tetap (index.ts, tiap symbol di SNAPSHOT_WATCHLIST) DAN
// pair non-watchlist yang sering di-query (snapshotNonWatchlistBasis, lihat
// src/queryFrequency.ts). Sengaja CUMA basis/OI/funding -- signal_history
// (computeMmSignals, buat binance_backtest_signal) TETAP watchlist-only,
// dan wall tracking (cron 1-menit terpisah) TIDAK disentuh sama sekali.
import * as binanceProxy from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";
import { getTopQueriedNonWatchlistSymbols } from "../queryFrequency.js";

export async function snapshotBasisForSymbol(symbol: string, timestamp: number): Promise<void> {
  const [spot, futures, oi] = await Promise.all([
    binanceProxy.getSpotPrice(symbol),
    binanceProxy.getCurrentFundingRateNative(symbol),
    binanceProxy.getOpenInterestNative(symbol),
  ]);
  const spotPrice = parseFloat(spot.price);
  const markPrice = parseFloat(futures.markPrice);
  const basis = (markPrice - spotPrice) / spotPrice;
  await d1Client.insertMarketSnapshot({
    symbol,
    timestamp,
    spotPrice,
    markPrice,
    basis,
    fundingRate: parseFloat(futures.lastFundingRate),
    openInterest: parseFloat(oi.openInterest),
  });
}

// Top-5 pair NON-watchlist paling sering di-query (KV counter) juga dapat
// basis snapshot -- satu symbol gagal TIDAK menggagalkan yang lain, sama
// pola try/catch per-symbol seperti loop watchlist di index.ts.
export async function snapshotNonWatchlistBasis(): Promise<void> {
  const top = await getTopQueriedNonWatchlistSymbols();
  const timestamp = Date.now();
  await Promise.all(
    top.map(async ({ symbol }) => {
      try {
        await snapshotBasisForSymbol(symbol, timestamp);
      } catch (err) {
        console.error(`[cron] gagal market snapshot non-watchlist ${symbol}:`, (err as Error)?.message ?? String(err));
      }
    }),
  );
}
