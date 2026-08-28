// Pre-filter Wave 1 entry-alert (STEP 2a) -- dari watchlist penuh (250 pair,
// entryWatchlist.ts) ambil TOP-N pair paling "layak dianalisis dalam",
// SISANYA di-skip total (tidak masuk hard-screen maupun Wave 1/2 yang mahal).
//
// SINYAL RANKING -- dua-duanya SUDAH tersedia gratis dari bulk fetch per tick
// (getAllTicker24hrNative + getBulkFundingRatesNative), nol subrequest
// tambahan:
//   - fundingAbs        = |lastFundingRate| (premiumIndex)
//   - |priceChangePct24h|= |priceChangePercent| 24 jam (ticker24hr)
//
// ALASAN pilihan sinyal: pada sample instrumentasi [hardscreen] tick 11:07
// UTC 2026-08-28, 23 dari 29 reject hard-screen jatuh di funding_extreme (10)
// atau momentum/volatilitas (adx_spike 9 + regime_breakout 2) -- keduanya
// terbaca dari fundingAbs dan |priceChange24h|. Pair yang datar di kedua
// sumbu jarang menghasilkan sinyal smart-money / MM yang cukup buat TRADE/
// WATCH, jadi paling murah dibuang lebih dulu.
//
// FORMULA: skor = 0.5 * pct(fundingAbs) + 0.5 * pct(|priceChangePct24h|),
// di mana pct(x) = (jumlah pair dengan nilai < x) / (n - 1) -- percentile
// rank per tick, SCALE-FREE (fundingAbs ~1e-4 vs priceChange ~1e1, beda 4
// orde -- kombinasi linier mentah bakal didominasi priceChange). Bobot 0.5/
// 0.5: split reject di sample kira-kira imbang antara funding-extreme (10)
// dan momentum/volatilitas (11); belum ada bukti buat memiringkan salah satu
// -- ditinjau ulang setelah data skip-audit (entry_alert_skip_log) masuk.
// Tie di skor dipecah by symbol ascending supaya hasil deterministik.
//
// TRADE-OFF yang DISENGAJA & harus divalidasi: ranking "paling ekstrem dulu"
// bisa over-select pair yang justru akan DI-REJECT hard-screen (funding
// ekstrem / breakout) -- itu sebabnya N mulai konservatif (40, bukan 15-30)
// dan setiap pair yang di-skip DICATAT (entryAlertCron.ts -> D1) buat dicek
// apakah ada setup bagus yang kelewat.

export const DEFAULT_ENTRY_TOP_N = 40;

export interface EntryRankingInput {
  symbol: string;
  fundingAbs: number;
  priceChangePct24h: number;
}

function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 0);
  return values.map((v) => {
    const strictlyLess = values.reduce((acc, other) => acc + (other < v ? 1 : 0), 0);
    return strictlyLess / (n - 1);
  });
}

/**
 * Kembalikan symbol TOP-`n` (paling ekstrem dulu) menurut formula di atas.
 * Kalau `n` >= jumlah kandidat, kembalikan semua (tetap terurut).
 */
export function rankEntryCandidates(candidates: EntryRankingInput[], n: number): string[] {
  if (candidates.length === 0) return [];

  const fundingPct = percentileRanks(candidates.map((c) => c.fundingAbs));
  const movePct = percentileRanks(candidates.map((c) => Math.abs(c.priceChangePct24h)));

  const scored = candidates.map((c, i) => ({
    symbol: c.symbol,
    score: 0.5 * fundingPct[i] + 0.5 * movePct[i],
  }));

  scored.sort((a, b) => (b.score - a.score) || a.symbol.localeCompare(b.symbol));

  return scored.slice(0, Math.max(0, n)).map((s) => s.symbol);
}
