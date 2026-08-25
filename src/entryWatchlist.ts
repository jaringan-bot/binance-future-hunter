// Watchlist entry-alert (entryAlertCron.ts) -- DINAMIS, dihitung ulang tiap
// run dari data live Binance (bukan hardcode kayak SNAPSHOT_WATCHLIST) supaya
// otomatis nyesuain listing/delisting/naik-turun peringkat tanpa maintenance
// manual daftar 200 baris.
import * as binanceProxy from "./binanceProxyClient.js";

export const ENTRY_WATCHLIST_SIZE = 200;

export async function getTop200UsdtPerpetualWatchlist(): Promise<string[]> {
  const [exchangeInfo, tickers] = await Promise.all([
    binanceProxy.getFuturesExchangeInfo(),
    binanceProxy.getAllTicker24hrNative(),
  ]);

  const eligible = new Set(
    exchangeInfo.symbols
      .filter((s) => s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT")
      .map((s) => s.symbol),
  );

  return tickers
    .filter((t) => eligible.has(t.symbol))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, ENTRY_WATCHLIST_SIZE)
    .map((t) => t.symbol);
}
