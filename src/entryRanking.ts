// Pre-filter Wave 1 entry-alert -- dari watchlist penuh (250 pair,
// entryWatchlist.ts) ambil TOP-N pair paling "layak dianalisis dalam",
// SISANYA di-skip total (tidak masuk hard-screen maupun Wave 1/2 yang mahal).
//
// SINYAL RANKING -- ketiganya SUDAH tersedia gratis dari bulk fetch per tick
// (getAllTicker24hrNative + getBulkFundingRatesNative), nol subrequest tambahan:
//   - quoteVolumeUsd     = quoteVolume 24h (ticker24hr)
//   - fundingAbs         = |lastFundingRate| (premiumIndex)
//   - |priceChangePct24h|= |priceChangePercent| 24 jam (ticker24hr)
//
// FORMULA "F3 cheap grid score":
//
//   volNorm  = (log10(quoteVolumeUsd) - min) / (max - min)   -- min-max lintas tick
//   thrP     = persentil-90 |priceChangePct24h| lintas tick
//   thrF     = persentil-90 |fundingAbs| lintas tick
//   score    = volNorm
//              * clamp(1 - |priceChangePct24h| / thrP, 0, 1)
//              * clamp(1 - |fundingAbs|        / thrF, 0, 1)
//
// Sort desc, tie-break by symbol ascending (deterministik), ambil top-n.
//
// ALASAN: F3 adalah aproksimasi MURAH dari hasil hard-screen itu sendiri.
// Backtest (scripts/backtest-ranking.mjs, di-replay ke ground truth
// [hardscreen] tick 11:07 UTC 2026-08-28) menunjukkan formula lama
// ("extremity tinggi": 0.5*pct(funding) + 0.5*pct(|priceChange|)) PASS rate
// top-N cuma 0.70-0.79 -- LEBIH BURUK dari hard-screen 0.84 yang di-feed-nya --
// dan membuang BTC/ETH/SOL/BNB sepenuhnya. F3 p90: PASS 1.00, tier-1 4/4 di
// rank #1-#10. Grid bot butuh regime tenang + pair likuid, bukan blow-off.
//
// KETERBATASAN: F3 mengoptimalkan "lolos hard-screen -> masuk Wave 2", BUKAN
// "menghasilkan alert TRADE/WATCH". Threshold p90 dihitung PER TICK dari
// populasi watchlist saat itu (adaptif ke kondisi pasar), bukan konstanta.
// Setiap pair yang di-skip DICATAT (entryAlertCron.ts -> D1 entry_alert_skip_log)
// buat audit apakah ada setup bagus yang kelewat.

export const DEFAULT_ENTRY_TOP_N = 40;

export interface EntryRankingInput {
  symbol: string;
  quoteVolumeUsd: number;
  fundingAbs: number;
  priceChangePct24h: number;
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const i = (sortedAsc.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ─────────────────────────────────────────────────────────────
// G6 (2026-09-04, Stage 2) -- SATU PRE-FILTER, TIGA HEAD DENGAN KEBUTUHAN
// BERLAWANAN.
//
// F3 di atas memilih pair paling likuid dan paling TIDAK bergerak, dengan
// funding paling netral. Untuk grid bot itu benar. Tapi Phase 1 ini
// menggerbangi KETIGA head, dan dua head lain butuh kebalikannya:
//   - head DCA hidup dari funding EKSTREM (short/long squeeze boost)
//   - head Traditional hidup dari sweep / breakout, yaitu pergerakan besar
// Jadi 310 dari 350 pair yang dibuang tiap tick justru memuat kandidat
// terbaik untuk dua head itu, dan keduanya nyaris tidak pernah kebagian
// symbol yang cocok.
//
// PERBAIKAN: kuota dibagi -- sebagian besar tetap F3 (grid), sisanya diambil
// dari skor EXTREMITY (kebalikan F3: gerakan + funding paling ekstrem, tetap
// disaring likuiditas supaya bukan sampah tak-tradable). TOTAL TIDAK BERUBAH,
// jadi nol tambahan subrequest dan nol perubahan wall-clock.
//
// Rasio 0.75/0.25 BELUM DIKALIBRASI -- dipilih supaya grid (produk utama
// saat ini) tetap dominan sambil memberi dua head lain pijakan. Bisa
// di-tune lewat KV tanpa redeploy (entry_alert:extremity_frac).
// ─────────────────────────────────────────────────────────────
export const DEFAULT_EXTREMITY_FRACTION = 0.25;

/**
 * Skor "extremity": kebalikan F3 pada dua faktor gerak/funding, TAPI tetap
 * mengalikan volNorm -- pair tidak likuid tidak boleh menang cuma karena
 * funding-nya liar (di sana funding ekstrem justru sering artefak).
 */
function extremityScore(volNorm: number, pcNorm: number, fNorm: number): number {
  return volNorm * Math.max(pcNorm, fNorm);
}

/**
 * Kembalikan symbol TOP-`n` menurut F3. Kalau `n` >= jumlah kandidat,
 * kembalikan semua (tetap terurut).
 */
export function rankEntryCandidates(candidates: EntryRankingInput[], n: number): string[] {
  if (candidates.length === 0) return [];
  if (candidates.length === 1) return [candidates[0].symbol];

  const pcAbs = candidates.map((c) => Math.abs(c.priceChangePct24h));
  const fAbs = candidates.map((c) => Math.abs(c.fundingAbs));
  const logQv = candidates.map((c) => Math.log10(Math.max(c.quoteVolumeUsd, 1)));

  const pcSorted = [...pcAbs].sort((a, b) => a - b);
  const fSorted = [...fAbs].sort((a, b) => a - b);
  const thrP = quantile(pcSorted, 0.9);
  const thrF = quantile(fSorted, 0.9);
  // Faktor discriminating cuma kalau ada SEBARAN nyata (p90 jauh di atas p10).
  // Kalau nggak (pasar sangat datar / data seragam), faktor jadi netral (1)
  // dan ranking jatuh ke volume + tie-break -- bukan alphabetical collapse.
  const pcHasSpread = thrP > 0 && thrP > quantile(pcSorted, 0.1) * 1.5;
  const fHasSpread = thrF > 0 && thrF > quantile(fSorted, 0.1) * 1.5;

  const qvMin = Math.min(...logQv);
  const qvMax = Math.max(...logQv);
  const qvRange = qvMax - qvMin;

  const scored = candidates.map((c, i) => {
    const volNorm = qvRange > 0 ? (logQv[i] - qvMin) / qvRange : 1;
    const moveFactor = pcHasSpread ? clamp01(1 - pcAbs[i] / thrP) : 1;
    const fundingFactor = fHasSpread ? clamp01(1 - fAbs[i] / thrF) : 1;
    return { symbol: c.symbol, score: volNorm * moveFactor * fundingFactor };
  });

  scored.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));

  return scored.slice(0, Math.max(0, n)).map((s) => s.symbol);
}

/**
 * G6: pilih `n` symbol sebagai GABUNGAN dua tujuan yang berlawanan --
 * mayoritas F3 (kondisi tenang, untuk grid) + sisanya extremity (gerakan /
 * funding ekstrem, untuk head DCA & Traditional). Dedup dijaga, total
 * TETAP `n` sehingga biaya Phase 2 tidak berubah sama sekali.
 *
 * `extremityFraction` 0 -> perilaku identik rankEntryCandidates() lama.
 */
export function selectEntryCandidates(
  candidates: EntryRankingInput[],
  n: number,
  extremityFraction: number = DEFAULT_EXTREMITY_FRACTION,
): { selected: string[]; gridPicks: string[]; extremityPicks: string[] } {
  if (candidates.length === 0 || n <= 0) return { selected: [], gridPicks: [], extremityPicks: [] };

  const frac = Number.isFinite(extremityFraction) ? Math.min(Math.max(extremityFraction, 0), 1) : DEFAULT_EXTREMITY_FRACTION;
  const extremityQuota = Math.min(Math.floor(n * frac), n);
  const gridQuota = n - extremityQuota;

  const gridPicks = rankEntryCandidates(candidates, gridQuota);
  if (extremityQuota === 0) {
    return { selected: gridPicks, gridPicks, extremityPicks: [] };
  }

  // Normalisasi yang SAMA dengan F3 supaya dua skor sebanding.
  const pcAbs = candidates.map((c) => Math.abs(c.priceChangePct24h));
  const fAbs = candidates.map((c) => Math.abs(c.fundingAbs));
  const logQv = candidates.map((c) => Math.log10(Math.max(c.quoteVolumeUsd, 1)));
  const thrP = quantile([...pcAbs].sort((a, b) => a - b), 0.9);
  const thrF = quantile([...fAbs].sort((a, b) => a - b), 0.9);
  const qvMin = Math.min(...logQv);
  const qvMax = Math.max(...logQv);
  const qvRange = qvMax - qvMin;

  const taken = new Set(gridPicks);
  const extremityScored = candidates
    .map((c, i) => {
      const volNorm = qvRange > 0 ? (logQv[i] - qvMin) / qvRange : 1;
      const pcNorm = thrP > 0 ? clamp01(pcAbs[i] / thrP) : 0;
      const fNorm = thrF > 0 ? clamp01(fAbs[i] / thrF) : 0;
      return { symbol: c.symbol, score: extremityScore(volNorm, pcNorm, fNorm) };
    })
    .filter((s) => !taken.has(s.symbol) && s.score > 0)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));

  const extremityPicks = extremityScored.slice(0, extremityQuota).map((s) => s.symbol);

  // Kalau kuota extremity tidak terisi penuh (mis. pasar sangat datar,
  // semua skor 0), sisa slot dikembalikan ke F3 -- jangan sampai total
  // turun di bawah n dan coverage malah berkurang.
  const shortfall = extremityQuota - extremityPicks.length;
  const filler =
    shortfall > 0
      ? rankEntryCandidates(candidates, gridQuota + shortfall).filter((s) => !taken.has(s) && !extremityPicks.includes(s))
      : [];

  const selected = [...gridPicks, ...extremityPicks, ...filler.slice(0, shortfall)];
  return { selected, gridPicks, extremityPicks };
}
