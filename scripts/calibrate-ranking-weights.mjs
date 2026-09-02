#!/usr/bin/env node
// OFFLINE kalibrasi bobot 4-komponen ranking Tier-1 (scoreTier1Signals di
// src/pipelineEngine.ts) terhadap outcome nyata (forward return) dari
// pipeline_decision_log.
//
// EKSPERIMEN SAJA -- script ini TIDAK mengimpor, TIDAK menjalankan, dan
// TIDAK mengubah src/pipelineEngine.ts (atau file produksi manapun). Sama
// disiplin dengan scripts/backtest-ranking.mjs: log/dataset adalah bahan
// uji, bukan input optimizer yang auto-apply. Output cuma tabel usulan
// buat REVIEW MANUAL.
//
// TIDAK ADA dependency npm baru -- cuma Node built-in (fs). Logistic
// regression di sini ditulis tangan (gradient descent), bukan library ML.
//
// ── Kenapa dataset di-pass sebagai FILE, bukan di-fetch di sini ──────────
// Script ini SENGAJA tidak nyentuh D1/kredensial. Kamu export dataset-nya
// manual:
//
//   npx wrangler d1 execute binance-future-hunter-db --remote --json \
//     --command "SELECT mm_component, smart_money_component,
//       regime_component, buy_pressure_component, forward_return_4h
//       FROM pipeline_decision_log
//       WHERE forward_return_4h IS NOT NULL
//         AND mm_component IS NOT NULL" > dataset.json
//
// lalu:
//
//   node scripts/calibrate-ranking-weights.mjs dataset.json
//
// Kolom `mm_component` / `smart_money_component` / `regime_component` /
// `buy_pressure_component` = migration 0014 (diisi saat row ditulis dari
// scoreTier1Signals().components). Row SEBELUM 0014, dan row yang gagal
// hard screen sebelum sampai scoreTier1Signals(), punya kolom ini NULL --
// makanya filter `mm_component IS NOT NULL` di query di atas.
//
// Script ini SENGAJA tetap terima JSON export manual, TIDAK auto-connect
// ke D1 -- pemisahan kredensial disengaja. Dia agnostik terhadap ASAL
// angka: cuma butuh 4 fitur (0-100) + 1 outcome per row.
//
// ── Bentuk row yang diterima (nama field fleksibel) ─────────────────────
//   fitur   : mm|mmComponent|mm_component,
//             smartMoney|sm|smart_money_component,
//             regime|regimeComponent|regime_component,
//             buyPressure|bp|buy_pressure_component
//             -- skala 0-100 (sama seperti komponen di scoreTier1Signals)
//   outcome : label (0/1) KALAU ada; kalau tidak, diturunkan dari
//             return field (default forwardReturn / forward_return_4h /
//             forward_return_1h / forward_return_24h) dengan aturan
//             win = return > --label-threshold (default 0).
//
// Wrapper `wrangler d1 execute --json` membungkus hasil sebagai
//   [{ results: [ ...rows ], success: true, meta: {...} }]
// script ini otomatis meng-unwrap bentuk itu, atau menerima array row
// polos, atau { rows: [...] }.
//
// ── Usage ──────────────────────────────────────────────────────────────
//   node scripts/calibrate-ranking-weights.mjs <dataset.json> [opsi]
//
//   --label-threshold=<n>   ambang win dari return (default 0)
//   --return-field=<name>   nama field return (default auto-detect)
//   --iterations=<n>        langkah gradient descent (default 8000)
//   --lr=<n>                learning rate (default 0.3)
//   --l2=<n>                koefisien regularisasi L2 (default 0.0)
//   --select-frac=<n>       fraksi top-skor buat proyeksi win-rate (default 0.33)
//   --min-rows=<n>          di bawah ini -> warning confidence rendah (default 40)
//   --out=<path>            file hasil JSON (default calibrate-ranking-weights-result.json)
//
// Output: tabel bobot usulan vs 35/30/20/15 existing + proyeksi delta
// win-rate & AUC ke stdout, plus JSON ke --out. TIDAK auto-apply.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ── Bobot terpasang saat ini (scoreTier1Signals, src/pipelineEngine.ts) ──
export const EXISTING_WEIGHTS = { mm: 0.35, smartMoney: 0.3, regime: 0.2, buyPressure: 0.15 };
export const FEATURE_KEYS = ["mm", "smartMoney", "regime", "buyPressure"];

const FIELD_ALIASES = {
  mm: ["mm", "mmComponent", "mm_component"],
  smartMoney: ["smartMoney", "sm", "smartMoneyComponent", "smart_money_component"],
  regime: ["regime", "regimeComponent", "regime_component"],
  buyPressure: ["buyPressure", "bp", "buyPressureComponent", "buy_pressure_component"],
};
const RETURN_FIELD_CANDIDATES = ["forwardReturn", "forward_return_4h", "forward_return_1h", "forward_return_24h", "return"];

// ── helpers matematika ─────────────────────────────────────────────────
export function sigmoid(z) {
  // numerically stable
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stddev(xs, mu = mean(xs)) {
  if (xs.length <= 1) return 0;
  const v = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

/** Standarisasi kolom-per-kolom (z-score). Kolom dgn std 0 -> semua 0. */
export function standardizeColumns(rows) {
  const n = rows[0]?.length ?? 0;
  const stats = [];
  for (let j = 0; j < n; j++) {
    const col = rows.map((r) => r[j]);
    const mu = mean(col);
    const sd = stddev(col, mu);
    stats.push({ mean: mu, std: sd });
  }
  const z = rows.map((r) => r.map((v, j) => (stats[j].std > 0 ? (v - stats[j].mean) / stats[j].std : 0)));
  return { z, stats };
}

/**
 * Logistic regression via batch gradient descent (ditulis tangan).
 * X: matrix fitur SUDAH terstandarisasi. y: array 0/1.
 * return: { weights (per fitur, ruang terstandarisasi), intercept, loss, iterations }
 */
export function fitLogisticRegression(X, y, opts = {}) {
  const { iterations = 8000, lr = 0.3, l2 = 0 } = opts;
  const m = X.length;
  const n = X[0]?.length ?? 0;
  if (m === 0 || n === 0) throw new Error("fitLogisticRegression: dataset kosong");

  let w = new Array(n).fill(0);
  let b = 0;
  let loss = NaN;

  for (let it = 0; it < iterations; it++) {
    const gradW = new Array(n).fill(0);
    let gradB = 0;
    let lossAcc = 0;
    for (let i = 0; i < m; i++) {
      const xi = X[i];
      let z = b;
      for (let j = 0; j < n; j++) z += w[j] * xi[j];
      const p = sigmoid(z);
      const err = p - y[i];
      for (let j = 0; j < n; j++) gradW[j] += err * xi[j];
      gradB += err;
      const eps = 1e-12;
      lossAcc += -(y[i] * Math.log(p + eps) + (1 - y[i]) * Math.log(1 - p + eps));
    }
    for (let j = 0; j < n; j++) {
      const g = gradW[j] / m + l2 * w[j];
      w[j] -= lr * g;
    }
    b -= lr * (gradB / m);
    loss = lossAcc / m + (l2 / 2) * w.reduce((a, v) => a + v * v, 0);
  }
  return { weights: w, intercept: b, loss, iterations };
}

/**
 * Terjemahkan koefisien ruang-terstandarisasi -> koefisien ruang fitur
 * mentah (0-100): w_raw_j = w_std_j / std_j.
 */
export function rawSpaceCoefficients(stdWeights, stats) {
  return stdWeights.map((w, j) => (stats[j].std > 0 ? w / stats[j].std : 0));
}

/**
 * Bobot usulan yang SEBANDING dengan 35/30/20/15: clamp koefisien negatif
 * ke 0 (bobot negatif tidak punya arti di formula "skor lebih tinggi =
 * lebih baik"), lalu normalisasi jumlah = 1. negativeFlags menandai fitur
 * yang koefisien mentahnya < 0 (artinya: di dataset ini, komponen itu
 * justru berkorelasi dengan LOSS -- info penting buat reviewer).
 */
export function normalizeWeights(rawCoefs) {
  const clamped = rawCoefs.map((c) => (c > 0 ? c : 0));
  const sum = clamped.reduce((a, b) => a + b, 0);
  const negativeFlags = rawCoefs.map((c) => c < 0);
  if (sum === 0) {
    // semua non-positif -> tidak ada usulan yang masuk akal, fallback rata.
    return { weights: rawCoefs.map(() => 1 / rawCoefs.length), negativeFlags, degenerate: true };
  }
  return { weights: clamped.map((c) => c / sum), negativeFlags, degenerate: false };
}

/** AUC (Mann-Whitney): P(skor_win > skor_loss), tie = 0.5. Threshold-free. */
export function rankAuc(scores, labels) {
  const pos = [];
  const neg = [];
  for (let i = 0; i < scores.length; i++) (labels[i] === 1 ? pos : neg).push(scores[i]);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Win-rate dari fraksi top-skor (mis. top 33%). */
export function winRateAtTopFraction(scores, labels, frac) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  const k = Math.max(1, Math.round(scores.length * frac));
  const top = idx.slice(0, k);
  const wins = top.reduce((a, i) => a + (labels[i] === 1 ? 1 : 0), 0);
  return { winRate: wins / k, k, wins };
}

export function weightedScore(featureRow, weights) {
  return FEATURE_KEYS.reduce((acc, key, j) => acc + featureRow[j] * weights[j], 0);
}

// ── parsing dataset ────────────────────────────────────────────────────
function pickField(obj, aliases) {
  for (const a of aliases) {
    if (obj[a] !== undefined && obj[a] !== null && obj[a] !== "") return Number(obj[a]);
  }
  return undefined;
}

export function unwrapDataset(raw) {
  if (Array.isArray(raw)) {
    // bentuk `wrangler d1 execute --json`: [{ results: [...] }]
    if (raw.length > 0 && raw[0] && Array.isArray(raw[0].results)) {
      return raw.flatMap((chunk) => chunk.results ?? []);
    }
    return raw;
  }
  if (raw && Array.isArray(raw.results)) return raw.results;
  if (raw && Array.isArray(raw.rows)) return raw.rows;
  throw new Error("format dataset tidak dikenal (butuh array row, {rows:[...]}, atau {results:[...]})");
}

export function parseDataset(rawRows, opts = {}) {
  const { labelThreshold = 0, returnField } = opts;
  const rows = [];
  let dropped = 0;
  let detectedReturnField = returnField ?? null;

  for (const r of rawRows) {
    const feats = FEATURE_KEYS.map((k) => pickField(r, FIELD_ALIASES[k]));
    if (feats.some((v) => v === undefined || !Number.isFinite(v))) {
      dropped++;
      continue;
    }

    let label;
    if (r.label !== undefined && r.label !== null && r.label !== "") {
      label = Number(r.label) > 0 ? 1 : 0;
    } else {
      let rv;
      if (detectedReturnField) {
        rv = Number(r[detectedReturnField]);
      } else {
        for (const cand of RETURN_FIELD_CANDIDATES) {
          if (r[cand] !== undefined && r[cand] !== null && r[cand] !== "") {
            rv = Number(r[cand]);
            detectedReturnField = cand;
            break;
          }
        }
      }
      if (rv === undefined || !Number.isFinite(rv)) {
        dropped++;
        continue;
      }
      label = rv > labelThreshold ? 1 : 0;
    }
    rows.push({ features: feats, label });
  }
  return { rows, dropped, returnField: detectedReturnField };
}

// ── orchestration (dipakai CLI, di-export biar bisa dites) ──────────────
export function calibrate(rawRows, opts = {}) {
  const {
    labelThreshold = 0,
    returnField,
    iterations = 8000,
    lr = 0.3,
    l2 = 0,
    selectFrac = 0.33,
  } = opts;

  const parsed = parseDataset(rawRows, { labelThreshold, returnField });
  const { rows } = parsed;
  if (rows.length === 0) throw new Error("tidak ada row valid setelah parsing");

  const posCount = rows.filter((r) => r.label === 1).length;
  const negCount = rows.length - posCount;
  if (posCount === 0 || negCount === 0) {
    throw new Error(
      `label degenerate (win=${posCount}, loss=${negCount}) -- tidak bisa fit. Cek --label-threshold / --return-field.`,
    );
  }

  const X = rows.map((r) => r.features);
  const y = rows.map((r) => r.label);
  const { z, stats } = standardizeColumns(X);
  const fit = fitLogisticRegression(z, y, { iterations, lr, l2 });
  const rawCoefs = rawSpaceCoefficients(fit.weights, stats);
  const proposed = normalizeWeights(rawCoefs);

  const existingVec = FEATURE_KEYS.map((k) => EXISTING_WEIGHTS[k]);
  const existingScores = X.map((f) => weightedScore(f, existingVec));
  const proposedScores = X.map((f) => weightedScore(f, proposed.weights));

  const baseWinRate = posCount / rows.length;
  const existingTop = winRateAtTopFraction(existingScores, y, selectFrac);
  const proposedTop = winRateAtTopFraction(proposedScores, y, selectFrac);
  const existingAuc = rankAuc(existingScores, y);
  const proposedAuc = rankAuc(proposedScores, y);

  return {
    sampleSize: rows.length,
    posCount,
    negCount,
    baseWinRate,
    returnField: parsed.returnField,
    dropped: parsed.dropped,
    labelThreshold,
    fit: { intercept: fit.intercept, loss: fit.loss, iterations: fit.iterations, stdWeights: fit.weights },
    stats,
    rawCoefficients: Object.fromEntries(FEATURE_KEYS.map((k, j) => [k, rawCoefs[j]])),
    existingWeights: EXISTING_WEIGHTS,
    proposedWeights: Object.fromEntries(FEATURE_KEYS.map((k, j) => [k, proposed.weights[j]])),
    proposedNegativeFlags: Object.fromEntries(FEATURE_KEYS.map((k, j) => [k, proposed.negativeFlags[j]])),
    proposedDegenerate: proposed.degenerate,
    projection: {
      selectFrac,
      selectedCount: existingTop.k,
      existingTopWinRate: existingTop.winRate,
      proposedTopWinRate: proposedTop.winRate,
      deltaTopWinRate: proposedTop.winRate - existingTop.winRate,
      existingAuc,
      proposedAuc,
      deltaAuc: existingAuc != null && proposedAuc != null ? proposedAuc - existingAuc : null,
    },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else positional.push(a);
  }
  return { positional, flags };
}

function fmtPct(n) {
  return n == null ? "-" : `${(n * 100).toFixed(1)}%`;
}
function fmtW(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const datasetPath = positional[0];
  if (!datasetPath) {
    console.error("usage: node scripts/calibrate-ranking-weights.mjs <dataset.json> [--label-threshold=0] [--return-field=name] [--iterations=8000] [--lr=0.3] [--l2=0] [--select-frac=0.33] [--min-rows=40] [--out=path]");
    process.exit(1);
  }

  const opts = {
    labelThreshold: flags["label-threshold"] !== undefined ? Number(flags["label-threshold"]) : 0,
    returnField: flags["return-field"],
    iterations: flags.iterations !== undefined ? Number(flags.iterations) : 8000,
    lr: flags.lr !== undefined ? Number(flags.lr) : 0.3,
    l2: flags.l2 !== undefined ? Number(flags.l2) : 0,
    selectFrac: flags["select-frac"] !== undefined ? Number(flags["select-frac"]) : 0.33,
  };
  const minRows = flags["min-rows"] !== undefined ? Number(flags["min-rows"]) : 40;
  const outPath = flags.out ?? "calibrate-ranking-weights-result.json";

  let raw;
  try {
    raw = JSON.parse(readFileSync(datasetPath, "utf8"));
  } catch (err) {
    console.error(`gagal baca/parse ${datasetPath}: ${err.message}`);
    process.exit(1);
  }

  let rawRows;
  try {
    rawRows = unwrapDataset(raw);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let result;
  try {
    result = calibrate(rawRows, opts);
  } catch (err) {
    console.error(`kalibrasi gagal: ${err.message}`);
    process.exit(1);
  }

  // ── output ───────────────────────────────────────────────────────────
  const p = result.projection;
  console.log("═".repeat(74));
  console.log("KALIBRASI BOBOT RANKING TIER-1 — OFFLINE, EKSPERIMEN, TIDAK AUTO-APPLY");
  console.log("═".repeat(74));
  console.log(`dataset            : ${datasetPath}`);
  console.log(`row valid          : ${result.sampleSize} (win ${result.posCount} / loss ${result.negCount}, base win-rate ${fmtPct(result.baseWinRate)})`);
  console.log(`row di-drop         : ${result.dropped} (fitur/outcome tidak lengkap)`);
  console.log(`outcome field      : ${result.returnField ?? "label (eksplisit)"}  | ambang win: return > ${result.labelThreshold}`);
  console.log(`GD                 : ${result.fit.iterations} iter, final log-loss ${result.fit.loss.toFixed(4)}`);
  if (result.sampleSize < minRows) {
    console.log(`\n⚠  SAMPLE KECIL (<${minRows}). Confidence RENDAH -- jangan ganti bobot produksi dari hasil ini saja.`);
  }
  if (result.proposedDegenerate) {
    console.log("\n⚠  Semua koefisien logistic non-positif -> usulan fallback ke bobot rata. Cek dataset/label.");
  }

  console.log("\n" + "─".repeat(74));
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("komponen", 16) + pad("existing", 12) + pad("usulan", 12) + pad("Δ", 12) + "koef. logistic (ruang mentah)");
  console.log("─".repeat(74));
  for (const k of FEATURE_KEYS) {
    const ex = result.existingWeights[k];
    const pr = result.proposedWeights[k];
    const flag = result.proposedNegativeFlags[k] ? "  ⚠ negatif (korelasi LOSS)" : "";
    console.log(
      pad(k, 16) +
        pad(fmtW(ex), 12) +
        pad(fmtW(pr), 12) +
        pad(`${pr - ex >= 0 ? "+" : ""}${((pr - ex) * 100).toFixed(1)}pp`, 12) +
        result.rawCoefficients[k].toFixed(5) +
        flag,
    );
  }

  console.log("\n" + "─".repeat(74));
  console.log("PROYEKSI (dataset yang sama -- IN-SAMPLE, bukan holdout; treat sebagai batas atas optimis)");
  console.log("─".repeat(74));
  console.log(`seleksi top ${(p.selectFrac * 100).toFixed(0)}% skor (${p.selectedCount} row):`);
  console.log(`  win-rate existing  : ${fmtPct(p.existingTopWinRate)}`);
  console.log(`  win-rate usulan    : ${fmtPct(p.proposedTopWinRate)}`);
  console.log(`  Δ win-rate         : ${p.deltaTopWinRate >= 0 ? "+" : ""}${(p.deltaTopWinRate * 100).toFixed(1)}pp`);
  console.log(`AUC (threshold-free, seluruh dataset):`);
  console.log(`  AUC existing       : ${p.existingAuc == null ? "-" : p.existingAuc.toFixed(4)}`);
  console.log(`  AUC usulan         : ${p.proposedAuc == null ? "-" : p.proposedAuc.toFixed(4)}`);
  console.log(`  Δ AUC              : ${p.deltaAuc == null ? "-" : (p.deltaAuc >= 0 ? "+" : "") + p.deltaAuc.toFixed(4)}`);

  console.log("\n" + "═".repeat(74));
  console.log("Ini USULAN buat review manual. TIDAK ada file produksi yang diubah.");
  console.log("Kalau mau adopsi: edit angka 0.35/0.30/0.20/0.15 di scoreTier1Signals()");
  console.log("(src/pipelineEngine.ts) sendiri, lalu jalankan npm test + shadow-mode dulu.");
  console.log("═".repeat(74));

  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n-> ${outPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
