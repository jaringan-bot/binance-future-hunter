// OFFLINE backtest 3 formula ranking pre-filter Wave 1 terhadap ground truth
// hard-screen riil (log [hardscreen] dari 1 tick produksi) + snapshot pasar
// (funding / priceChange24h / quoteVolume dari fapi.binance.com yang di-fetch
// dekat waktu tick yang sama).
//
// EKSPERIMEN SAJA -- tidak mengimpor / tidak mengubah src/entryRanking.ts
// maupun file produksi apa pun. Tidak deploy.
//
// Pakai:
//   node scripts/backtest-ranking.mjs <hardscreen_log> <snap_t24.json> <snap_pidx.json>
//
// Output: matriks ke stdout + JSON ke <cwd>/backtest-ranking-result.json
import { readFileSync, writeFileSync } from "node:fs";

const [, , logPath, t24Path, pidxPath] = process.argv;
if (!logPath || !t24Path || !pidxPath) {
  console.error("usage: node scripts/backtest-ranking.mjs <hardscreen_log> <snap_t24.json> <snap_pidx.json>");
  process.exit(1);
}

// ── 1. Ground truth: parse baris [hardscreen] pair=X result=PASS|REJECT tags=a|b
const gt = new Map(); // symbol -> { result, tags: [] }
for (const line of readFileSync(logPath, "utf8").split("\n")) {
  const m = line.match(/\[hardscreen\] pair=(\S+?) result=(PASS|REJECT)(?: tags=(\S+))?/);
  if (!m) continue;
  gt.set(m[1], { result: m[2], tags: m[3] ? m[3].replace(/\.\.\.$/, "").split("|") : [] });
}

// ── 2. Snapshot pasar
const t24 = new Map(JSON.parse(readFileSync(t24Path, "utf8")).map((t) => [t.symbol, t]));
const pidx = new Map(JSON.parse(readFileSync(pidxPath, "utf8")).map((p) => [p.symbol, p]));

// ── 3. Replay set = pair yang punya GROUND TRUTH + data snapshot lengkap
const rows = [];
for (const [symbol, g] of gt) {
  const t = t24.get(symbol);
  const p = pidx.get(symbol);
  if (!t || !p) continue;
  const fundingAbs = Math.abs(parseFloat(p.lastFundingRate));
  const pcAbs = Math.abs(parseFloat(t.priceChangePercent));
  const qv = parseFloat(t.quoteVolume);
  if (![fundingAbs, pcAbs, qv].every(Number.isFinite)) continue;
  rows.push({ symbol, result: g.result, tags: g.tags, fundingAbs, pcAbs, qv });
}

const TIER1 = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];

// ── helpers ────────────────────────────────────────────────────────────
function percentileRank(values) {
  const n = values.length;
  if (n <= 1) return values.map(() => 0);
  return values.map((v) => values.reduce((a, o) => a + (o < v ? 1 : 0), 0) / (n - 1));
}
function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function clamp0(x) {
  return x > 0 ? x : 0;
}

const fundingSorted = [...rows.map((r) => r.fundingAbs)].sort((a, b) => a - b);
const pcSorted = [...rows.map((r) => r.pcAbs)].sort((a, b) => a - b);
const logQv = rows.map((r) => Math.log10(Math.max(r.qv, 1)));
const logQvMin = Math.min(...logQv), logQvMax = Math.max(...logQv);

// ── FORMULA 1: baseline (extremity tinggi) -- copy src/entryRanking.ts ──
function scoreF1() {
  const fp = percentileRank(rows.map((r) => r.fundingAbs));
  const mp = percentileRank(rows.map((r) => r.pcAbs));
  return rows.map((_, i) => 0.5 * fp[i] + 0.5 * mp[i]);
}
// ── FORMULA 2: min extremity (kebalikan F1) ────────────────────────────
function scoreF2() {
  const fp = percentileRank(rows.map((r) => r.fundingAbs));
  const mp = percentileRank(rows.map((r) => r.pcAbs));
  return rows.map((_, i) => 0.5 * (1 - fp[i]) + 0.5 * (1 - mp[i]));
}
// ── FORMULA 3: cheap grid score ────────────────────────────────────────
// score = volNorm * clamp(1 - |pc|/thrP, 0) * clamp(1 - |funding|/thrF, 0)
// volNorm = min-max dari log10(quoteVolume) -> [0,1]. Log karena quoteVolume
// membentang beberapa orde (jutaan s/d miliaran USD); min-max supaya jadi
// faktor pengali [0,1] yang setara dengan dua faktor lain. Pair yang MELEBIHI
// threshold price/funding dapat faktor 0 -> skor 0 (di-clamp, bukan negatif).
function scoreF3(thrP, thrF) {
  return rows.map((r, i) => {
    const volNorm = logQvMax > logQvMin ? (logQv[i] - logQvMin) / (logQvMax - logQvMin) : 1;
    return volNorm * clamp0(1 - r.pcAbs / thrP) * clamp0(1 - r.fundingAbs / thrF);
  });
}

function topN(scores, n) {
  return rows
    .map((r, i) => ({ symbol: r.symbol, score: scores[i] }))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, n)
    .map((x) => x.symbol);
}

const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
const overallPass = rows.filter((r) => r.result === "PASS").length / rows.length;

// F1 top-N sets (buat hitung "skip_log gap overlap")
const f1Scores = scoreF1();
const f1Top = { 40: new Set(topN(f1Scores, 40)), 60: new Set(topN(f1Scores, 60)), 80: new Set(topN(f1Scores, 80)) };

function evalCombo(label, selected, n) {
  const sel = selected.map((s) => bySymbol.get(s));
  const passN = sel.filter((r) => r.result === "PASS").length;
  const passRate = passN / sel.length;
  const rejectTags = {};
  for (const r of sel.filter((x) => x.result === "REJECT")) {
    for (const tag of r.tags) rejectTags[tag] = (rejectTags[tag] ?? 0) + 1;
  }
  const tier1 = TIER1.map((sym) => {
    const rank = selected.indexOf(sym);
    return { sym, in: rank >= 0, rank: rank >= 0 ? rank + 1 : null };
  });
  // gap overlap: pair yg TIDAK di F1 top-N tapi ADA di sini, dan PASS
  const gapPairs = selected.filter((s) => !f1Top[n].has(s));
  const gapPass = gapPairs.filter((s) => bySymbol.get(s).result === "PASS").length;
  return {
    label,
    n,
    passRate: +passRate.toFixed(3),
    passCount: `${passN}/${sel.length}`,
    rejectTags,
    tier1: tier1.map((t) => (t.in ? `${t.sym}#${t.rank}` : `${t.sym}:N`)).join(" "),
    tier1InCount: tier1.filter((t) => t.in).length,
    gapVsF1: `${gapPass}/${gapPairs.length} PASS`,
    worseThanHardScreen: passRate < overallPass - 0.05,
  };
}

const thrSets = {
  p75: { thrP: quantile(pcSorted, 0.75), thrF: quantile(fundingSorted, 0.75) },
  p60: { thrP: quantile(pcSorted, 0.6), thrF: quantile(fundingSorted, 0.6) },
  p90: { thrP: quantile(pcSorted, 0.9), thrF: quantile(fundingSorted, 0.9) },
};

const results = [];
for (const n of [40, 60, 80]) {
  results.push(evalCombo("F1 extremity-high", topN(f1Scores, n), n));
  results.push(evalCombo("F2 extremity-low", topN(scoreF2(), n), n));
  for (const [tk, { thrP, thrF }] of Object.entries(thrSets)) {
    results.push(evalCombo(`F3 grid ${tk}(pc<${thrP.toFixed(1)}%,f<${(thrF * 100).toFixed(3)}%)`, topN(scoreF3(thrP, thrF), n), n));
  }
}

// ── output ────────────────────────────────────────────────────────────
console.log(`replay set: ${rows.length} pair (punya ground truth [hardscreen] + snapshot)`);
console.log(`ground-truth overall hard-screen PASS rate: ${overallPass.toFixed(3)} (${rows.filter((r) => r.result === "PASS").length}/${rows.length})`);
console.log(`threshold sets: p75 pc=${thrSets.p75.thrP.toFixed(2)}% f=${(thrSets.p75.thrF * 100).toFixed(3)}% | p60 pc=${thrSets.p60.thrP.toFixed(2)}% f=${(thrSets.p60.thrF * 100).toFixed(3)}% | p90 pc=${thrSets.p90.thrP.toFixed(2)}% f=${(thrSets.p90.thrF * 100).toFixed(3)}%\n`);

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad("formula", 36) + pad("N", 4) + pad("PASS", 10) + pad("rate", 7) + pad("t1", 5) + pad("tier1 ranks", 46) + pad("gap-vs-F1", 13) + "reject tags / WARN",
);
console.log("-".repeat(160));
for (const r of results) {
  const warn = r.worseThanHardScreen ? "  <<< WORSE THAN HARD-SCREEN" : "";
  const tags = Object.entries(r.rejectTags).map(([k, v]) => `${k}:${v}`).join(",") || "-";
  console.log(
    pad(r.label, 36) + pad(r.n, 4) + pad(r.passCount, 10) + pad(r.passRate, 7) + pad(r.tier1InCount + "/4", 5) + pad(r.tier1, 46) + pad(r.gapVsF1, 13) + tags + warn,
  );
}

writeFileSync("backtest-ranking-result.json", JSON.stringify({ replaySize: rows.length, overallPass, thrSets, results }, null, 2));
console.log("\n-> backtest-ranking-result.json");
