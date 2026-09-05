#!/usr/bin/env node
// FALSIFIKASI skor ranking Tier-1 (scoreTier1Signals, src/pipelineEngine.ts)
// terhadap outcome nyata di pipeline_decision_log.
//
// INI BUKAN KALIBRATOR. Tujuannya kebalikan dari
// scripts/calibrate-ranking-weights.mjs: bukan mencari bobot yang paling
// cocok, melainkan MENGUJI apakah struktur skornya layak dikalibrasi sama
// sekali. Kalibrasi hanya menyembuhkan estimation error (parameter meleset
// pada struktur yang benar); ia tidak menyembuhkan specification error
// (label salah, bentuk fungsi salah, fitur berkorelasi dianggap independen).
// Menambah data pada model yang salah spesifikasi cuma menghasilkan angka
// salah yang lebih presisi -- dan lebih berbahaya, karena angka hasil fit
// kehilangan penanda "BELUM DIKALIBRASI" yang membuatnya bisa digugat.
//
// Tiap hipotesis di bawah punya KRITERIA BUNUH yang dievaluasi otomatis dan
// dicetak sebagai VERDICT. Hipotesis yang tidak terbunuh maupun terkonfirmasi
// dicetak "TIDAK KONKLUSIF" -- bukan didiamkan, karena diam akan dibaca
// sebagai dukungan.
//
// Rencana lengkap + temuan T1-T11:
//   docs/superpowers/plans/2026-09-05-falsifikasi-ranking-score.md
//
// ── Cara pakai ──────────────────────────────────────────────────────────
// Dataset di-export MANUAL (script ini TIDAK menyentuh D1/kredensial --
// pemisahan yang sama dengan calibrate-ranking-weights.mjs):
//
//   npx wrangler d1 execute binance-future-hunter-db --remote --json \
//     --command "SELECT run_at, symbol, decision, ranking_score,
//       hard_screen_passed, mm_component, smart_money_component,
//       regime_component, buy_pressure_component, mm_adverse_component,
//       lower_price, upper_price, stop_loss,
//       forward_return_4h, forward_return_24h, sl_touched_24h
//       FROM pipeline_decision_log
//       WHERE run_at < 1788522720000" > .tmp-falsifikasi/dataset.json
//
//   node scripts/falsify-ranking-score.mjs .tmp-falsifikasi/dataset.json
//
// `run_at < 1788522720000` = pra-deploy Stage 3 (2026-09-04 11:52 UTC).
// Batas itu WAJIB: `mm_component` bersemantik BEDA di kedua sisinya, dan
// assertSingleMmSemantics() (di-reuse dari calibrate-ranking-weights.mjs)
// akan menolak dataset campuran.
//
// NOL dependency npm baru -- Node built-in saja, sama seperti skrip tetangga.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
// Di-REUSE apa adanya, bukan disalin: dua fungsi ini sudah menangani envelope
// `wrangler d1 execute --json` dan penjagaan semantik mm. Menyalinnya berarti
// dua definisi yang bisa menyimpang diam-diam.
import { unwrapDataset, assertSingleMmSemantics } from "./calibrate-ranking-weights.mjs";

export const COMPONENT_KEYS = ["mm", "smartMoney", "regime", "buyPressure"];

const FIELD_ALIASES = {
  mm: ["mm", "mmComponent", "mm_component"],
  smartMoney: ["smartMoney", "smartMoneyComponent", "smart_money_component"],
  regime: ["regime", "regimeComponent", "regime_component"],
  buyPressure: ["buyPressure", "buyPressureComponent", "buy_pressure_component"],
  score: ["rankingScore", "ranking_score", "score"],
  decision: ["decision"],
  lower: ["lowerPrice", "lower_price"],
  upper: ["upperPrice", "upper_price"],
  stopLoss: ["stopLoss", "stop_loss"],
  slTouched: ["slTouched24h", "sl_touched_24h"],
  ret4h: ["forwardReturn4h", "forward_return_4h"],
  ret24h: ["forwardReturn24h", "forward_return_24h"],
  runAt: ["runAt", "run_at"],
};

// Ambang pemisah skor untuk uji dua kelompok. 40 dipakai (bukan 55) karena
// bucket gte_55 hanya berisi 4 baris dari 23.881 -- lihat T1. Uji dua
// kelompok pada n=4 tidak punya daya statistik apa pun.
export const SCORE_SPLIT = 40;
// 4 komponen x 2 metrik = 8 uji simultan. Bonferroni pada alpha 0.05.
export const BONFERRONI_TESTS = 8;
export const BONFERRONI_Z = 2.734; // dua sisi, alpha/8 = 0.00625

function pickField(row, names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null) return row[n];
  }
  return undefined;
}

function num(v) {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ── parsing ────────────────────────────────────────────────────────────
/**
 * Ambil kolom yang dibutuhkan. Baris TANPA ranking_score di-drop (tidak bisa
 * dipakai uji apa pun); kolom lain boleh kosong dan uji yang membutuhkannya
 * akan menyaring sendiri -- supaya satu kolom hilang tidak membuang baris
 * dari SELURUH uji.
 */
export function parseRows(rawRows) {
  assertSingleMmSemantics(rawRows);
  const rows = [];
  let dropped = 0;
  for (const r of rawRows) {
    const score = num(pickField(r, FIELD_ALIASES.score));
    if (score === undefined) {
      dropped++;
      continue;
    }
    const slRaw = pickField(r, FIELD_ALIASES.slTouched);
    rows.push({
      score,
      decision: pickField(r, FIELD_ALIASES.decision) ?? null,
      runAt: num(pickField(r, FIELD_ALIASES.runAt)) ?? null,
      mm: num(pickField(r, FIELD_ALIASES.mm)),
      smartMoney: num(pickField(r, FIELD_ALIASES.smartMoney)),
      regime: num(pickField(r, FIELD_ALIASES.regime)),
      buyPressure: num(pickField(r, FIELD_ALIASES.buyPressure)),
      lower: num(pickField(r, FIELD_ALIASES.lower)),
      upper: num(pickField(r, FIELD_ALIASES.upper)),
      stopLoss: num(pickField(r, FIELD_ALIASES.stopLoss)),
      slTouched: slRaw === undefined || slRaw === null ? undefined : Number(slRaw) === 1,
      ret4h: num(pickField(r, FIELD_ALIASES.ret4h)),
      ret24h: num(pickField(r, FIELD_ALIASES.ret24h)),
    });
  }
  return { rows, dropped };
}

/**
 * Geometri grid dari kolom yang SUDAH dipersist -- inilah yang membuat uji
 * konfound H1 mungkin tanpa instrumentasi baru.
 *
 *   rangeWidthPct = lebar grid relatif  -> proxy volatilitas saat keputusan
 *                                          (bounds diturunkan dari ATR)
 *   slGapPct      = jarak stop-loss di BAWAH batas bawah grid, relatif
 *
 * slGapPct kecil = SL rapat = secara MEKANIS lebih mudah tersentuh, terlepas
 * dari mutu setup. Itu persis konfound yang harus disingkirkan sebelum
 * "skor tinggi -> SL-touch tinggi" boleh dibaca sebagai temuan.
 */
export function deriveGeometry(row) {
  const { lower, upper, stopLoss } = row;
  if (lower === undefined || lower <= 0) return { rangeWidthPct: undefined, slGapPct: undefined };
  const rangeWidthPct = upper === undefined ? undefined : ((upper - lower) / lower) * 100;
  const slGapPct = stopLoss === undefined ? undefined : ((lower - stopLoss) / lower) * 100;
  return { rangeWidthPct, slGapPct };
}

// ── statistik ──────────────────────────────────────────────────────────
export function mean(xs) {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stddev(xs, mu = mean(xs)) {
  if (xs.length < 2) return NaN;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1));
}

/**
 * Uji z dua proporsi. Mengembalikan null kalau salah satu kelompok kosong --
 * BUKAN 0, karena 0 akan terbaca sebagai "tidak ada perbedaan" padahal
 * artinya "tidak ada data".
 */
export function twoProportionZ(succA, nA, succB, nB) {
  if (nA <= 0 || nB <= 0) return null;
  const pA = succA / nA;
  const pB = succB / nB;
  const se = Math.sqrt((pA * (1 - pA)) / nA + (pB * (1 - pB)) / nB);
  if (!(se > 0)) return null;
  return { pA, pB, diff: pB - pA, se, z: (pB - pA) / se, nA, nB };
}

/** Peringkat dengan rata-rata untuk nilai kembar (dibutuhkan Spearman). */
export function rankAverage(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Korelasi Spearman. Nilai kembar ditangani lewat rank rata-rata. */
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const rx = rankAverage(xs);
  const ry = rankAverage(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/**
 * Bagi ke `k` kelompok berukuran ~sama menurut `valueOf`. Memakai posisi
 * terurut, BUKAN lebar interval -- distribusi skor di repo ini bergerombol
 * (lihat H5), jadi bin lebar-sama bisa menghasilkan kelompok kosong.
 */
export function splitIntoQuantileGroups(items, valueOf, k) {
  const usable = items.filter((it) => Number.isFinite(valueOf(it)));
  if (usable.length === 0) return [];
  const sorted = [...usable].sort((a, b) => valueOf(a) - valueOf(b));
  const groups = [];
  for (let g = 0; g < k; g++) {
    const start = Math.floor((g * sorted.length) / k);
    const end = Math.floor(((g + 1) * sorted.length) / k);
    if (end > start) groups.push(sorted.slice(start, end));
  }
  return groups;
}

/**
 * Odds ratio Mantel-Haenszel: ringkasan satu angka atas beberapa strata,
 * dipakai H1 untuk menjawab "apakah asosiasi skor->SL-touch bertahan SETELAH
 * strata jarak-SL disamakan".
 *
 * Tiap stratum: a = skor tinggi & kena, b = skor tinggi & tidak,
 *               c = skor rendah & kena, d = skor rendah & tidak.
 * OR > 1 berarti skor tinggi punya odds lebih besar untuk kena SL.
 */
export function mantelHaenszelOddsRatio(strata) {
  let numer = 0;
  let denom = 0;
  for (const { a, b, c, d } of strata) {
    const n = a + b + c + d;
    if (n === 0) continue;
    numer += (a * d) / n;
    denom += (b * c) / n;
  }
  if (denom === 0) return null;
  return numer / denom;
}

// ── uji per hipotesis ──────────────────────────────────────────────────
/**
 * H1 -- inversi "skor tinggi -> SL-touch tinggi" adalah artefak jarak SL?
 *
 * Dua langkah:
 *  1. Apakah jarak SL memang berbeda lintas kelompok skor? (kalau tidak,
 *     konfoundnya tidak punya jalan untuk bekerja)
 *  2. Apakah inversinya BERTAHAN setelah distratifikasi per desil jarak SL?
 */
export function testH1(rows, { split = SCORE_SPLIT, strataCount = 10 } = {}) {
  const usable = rows
    .map((r) => ({ ...r, ...deriveGeometry(r) }))
    .filter((r) => r.slTouched !== undefined && Number.isFinite(r.slGapPct));
  if (usable.length === 0) return null;

  const low = usable.filter((r) => r.score < split);
  const high = usable.filter((r) => r.score >= split);

  const lowGap = low.map((r) => r.slGapPct);
  const highGap = high.map((r) => r.slGapPct);
  const pooledSd = stddev(usable.map((r) => r.slGapPct));
  const gapDiffSd =
    Number.isFinite(pooledSd) && pooledSd > 0 ? (mean(highGap) - mean(lowGap)) / pooledSd : NaN;

  const unadjusted = twoProportionZ(
    low.filter((r) => r.slTouched).length,
    low.length,
    high.filter((r) => r.slTouched).length,
    high.length,
  );

  const strata = splitIntoQuantileGroups(usable, (r) => r.slGapPct, strataCount).map((group) => {
    const gLow = group.filter((r) => r.score < split);
    const gHigh = group.filter((r) => r.score >= split);
    const a = gHigh.filter((r) => r.slTouched).length;
    const c = gLow.filter((r) => r.slTouched).length;
    return {
      n: group.length,
      meanGapPct: mean(group.map((r) => r.slGapPct)),
      a,
      b: gHigh.length - a,
      c,
      d: gLow.length - c,
      lowRate: gLow.length ? c / gLow.length : null,
      highRate: gHigh.length ? a / gHigh.length : null,
      z: twoProportionZ(c, gLow.length, a, gHigh.length),
    };
  });

  const mhOr = mantelHaenszelOddsRatio(strata);
  // Berapa stratum yang inversinya searah dengan temuan mentah (skor tinggi
  // lebih sering kena)? Konsistensi arah lebih informatif daripada satu
  // stratum yang kebetulan signifikan.
  const comparable = strata.filter((s) => s.lowRate !== null && s.highRate !== null);
  const sameDirection = comparable.filter((s) => s.highRate > s.lowRate).length;

  // Stratifikasi cuma bermakna kalau cukup banyak stratum memuat KEDUA
  // kelompok skor. Kalau jarak SL bergerombol (banyak nilai kembar),
  // pembagian kuantil bisa menghasilkan stratum berisi satu kelompok saja --
  // dan verdict apa pun di atas basis setipis itu akan percaya diri secara
  // palsu. Ini dicek DULUAN, sebelum kriteria bunuh mana pun.
  const MIN_COMPARABLE_STRATA = 3;
  const stratificationOk = comparable.length >= MIN_COMPARABLE_STRATA;

  // KRITERIA BUNUH (plan H1): H1 gugur kalau jarak SL TIDAK berbeda bermakna
  // lintas kelompok (< 0.5 SD) DAN inversinya bertahan setelah stratifikasi.
  const gapNegligible = Number.isFinite(gapDiffSd) && Math.abs(gapDiffSd) < 0.5;
  const survivesAdjustment = mhOr !== null && mhOr > 1 && comparable.length > 0 && sameDirection / comparable.length >= 0.6;
  let verdict;
  if (!stratificationOk) {
    verdict =
      `TIDAK KONKLUSIF — stratifikasi terlalu tipis (${comparable.length}/${strata.length} stratum punya kedua ` +
      `kelompok skor, minimum ${MIN_COMPARABLE_STRATA}). Kurangi strataCount atau perbesar sampel.`;
  } else if (gapNegligible && survivesAdjustment) verdict = "H1 GUGUR — inversi bertahan, T3/T4 berdiri";
  else if (!survivesAdjustment) verdict = "H1 BENAR — inversi hilang setelah dikoreksi, T3/T4 DICORET";
  else verdict = "TIDAK KONKLUSIF — jarak SL berbeda bermakna DAN inversi bertahan; konfound & efek bercampur";

  return {
    sampleSize: usable.length,
    lowCount: low.length,
    highCount: high.length,
    meanGapLowPct: mean(lowGap),
    meanGapHighPct: mean(highGap),
    gapDiffSd,
    meanRangeWidthLowPct: mean(low.map((r) => r.rangeWidthPct).filter(Number.isFinite)),
    meanRangeWidthHighPct: mean(high.map((r) => r.rangeWidthPct).filter(Number.isFinite)),
    unadjusted,
    strata,
    mhOddsRatio: mhOr,
    sameDirection,
    comparableStrata: comparable.length,
    stratificationOk,
    verdict,
  };
}

/**
 * H2 -- adakah SATU komponen yang punya daya pisah univariat, meski skor
 * gabungannya gagal? Monotonisitas diukur lewat Spearman antara indeks desil
 * dan tingkat kejadian -- selisih ujung-ke-ujung saja bisa besar karena satu
 * desil outlier.
 */
export function testH2(rows, { deciles = 10 } = {}) {
  const out = {};
  for (const key of COMPONENT_KEYS) {
    const withSl = rows.filter((r) => Number.isFinite(r[key]) && r.slTouched !== undefined);
    const withRet = rows.filter((r) => Number.isFinite(r[key]) && Number.isFinite(r.ret24h));

    const slGroups = splitIntoQuantileGroups(withSl, (r) => r[key], deciles).map((g, i) => ({
      decile: i + 1,
      n: g.length,
      meanValue: mean(g.map((r) => r[key])),
      rate: g.filter((r) => r.slTouched).length / g.length,
    }));
    const retGroups = splitIntoQuantileGroups(withRet, (r) => r[key], deciles).map((g, i) => ({
      decile: i + 1,
      n: g.length,
      meanValue: mean(g.map((r) => r[key])),
      rate: g.filter((r) => r.ret24h > 0).length / g.length,
    }));

    const edgeSl =
      slGroups.length >= 2
        ? twoProportionZ(
            Math.round(slGroups[0].rate * slGroups[0].n),
            slGroups[0].n,
            Math.round(slGroups.at(-1).rate * slGroups.at(-1).n),
            slGroups.at(-1).n,
          )
        : null;
    const edgeRet =
      retGroups.length >= 2
        ? twoProportionZ(
            Math.round(retGroups[0].rate * retGroups[0].n),
            retGroups[0].n,
            Math.round(retGroups.at(-1).rate * retGroups.at(-1).n),
            retGroups.at(-1).n,
          )
        : null;

    const trendSl = slGroups.length >= 3 ? spearman(slGroups.map((g) => g.decile), slGroups.map((g) => g.rate)) : null;
    const trendRet = retGroups.length >= 3 ? spearman(retGroups.map((g) => g.decile), retGroups.map((g) => g.rate)) : null;

    // KRITERIA BUNUH (plan H2): komponen DISELAMATKAN kalau tren monotonik
    // (|rho| >= 0.7) DAN selisih ujung lolos Bonferroni.
    const savedBySl = trendSl !== null && Math.abs(trendSl) >= 0.7 && edgeSl !== null && Math.abs(edgeSl.z) > BONFERRONI_Z;
    const savedByRet = trendRet !== null && Math.abs(trendRet) >= 0.7 && edgeRet !== null && Math.abs(edgeRet.z) > BONFERRONI_Z;

    // ARAH, bukan cuma kekuatan. Komponen yang berdaya pisah kuat TAPI
    // terbalik bukan komponen yang "berguna apa adanya" -- ia memprediksi
    // KEGAGALAN. Membiarkan label "SELAMAT" berdiri sendiri untuk kasus itu
    // akan terbaca sebagai pembenaran untuk mempertahankannya, padahal
    // implikasinya justru sebaliknya.
    //
    // trendSl > 0  : nilai komponen naik -> SL-touch naik -> ADVERSE
    // trendRet < 0 : nilai komponen naik -> win rate turun -> ADVERSE
    const adverseBySl = trendSl !== null && trendSl > 0;
    const adverseByRet = trendRet !== null && trendRet < 0;
    const saved = savedBySl || savedByRet;
    const savedVia = savedBySl ? "sl_touch" : savedByRet ? "win_rate_24h" : null;
    const inverted = saved && (savedBySl ? adverseBySl : adverseByRet);

    out[key] = {
      slDeciles: slGroups,
      retDeciles: retGroups,
      edgeSl,
      edgeRet,
      trendSl,
      trendRet,
      adverseBySl,
      adverseByRet,
      saved,
      savedVia,
      /** true = punya daya pisah, tapi TANDANYA TERBALIK dari yang diniatkan. */
      inverted,
    };
  }
  const savedKeys = COMPONENT_KEYS.filter((k) => out[k].saved);
  const invertedKeys = savedKeys.filter((k) => out[k].inverted);
  const usableKeys = savedKeys.filter((k) => !out[k].inverted);
  // Semua komponen menunjuk arah adverse yang sama = bukan kebetulan per
  // komponen, melainkan tanda bahwa ORIENTASI skornya yang terbalik.
  const allAdverse = COMPONENT_KEYS.every((k) => out[k].adverseBySl);

  let verdict;
  if (savedKeys.length === 0) verdict = "H2 BERDIRI — tidak ada komponen yang punya daya pisah univariat";
  else if (usableKeys.length === 0)
    verdict =
      `H2 GUGUR SEBAGIAN, TAPI TERBALIK — berdaya pisah: ${invertedKeys.join(", ")}; ` +
      "semuanya memprediksi KEGAGALAN, bukan keberhasilan";
  else verdict = `H2 GUGUR SEBAGIAN — berguna apa adanya: ${usableKeys.join(", ")}` + (invertedKeys.length ? `; terbalik: ${invertedKeys.join(", ")}` : "");

  return { perComponent: out, savedKeys, invertedKeys, usableKeys, allAdverse, verdict };
}

/** H3 -- kolinearitas antar komponen. */
export function testH3(rows) {
  const pairs = [];
  let maxAbs = 0;
  for (let i = 0; i < COMPONENT_KEYS.length; i++) {
    for (let j = i + 1; j < COMPONENT_KEYS.length; j++) {
      const a = COMPONENT_KEYS[i];
      const b = COMPONENT_KEYS[j];
      const both = rows.filter((r) => Number.isFinite(r[a]) && Number.isFinite(r[b]));
      const rho = spearman(both.map((r) => r[a]), both.map((r) => r[b]));
      if (rho !== null) maxAbs = Math.max(maxAbs, Math.abs(rho));
      pairs.push({ a, b, n: both.length, rho });
    }
  }
  // KRITERIA BUNUH (plan H3): semua |rho| < 0.3 -> H3 gugur.
  let verdict;
  if (maxAbs < 0.3) verdict = "H3 GUGUR — komponen cukup independen, weighted-sum bentuk yang sah";
  else if (maxAbs > 0.6) verdict = "H3 BERDIRI KUAT — ada pasangan |rho| > 0.6, bobotnya tidak identifiable";
  else verdict = "TIDAK KONKLUSIF — korelasi sedang (0.3-0.6)";
  return { pairs, maxAbs, verdict };
}

/** H4 -- apakah ambang dispatch 50 (entryAlertCron.ts:152) memisahkan? */
export function testH4(rows, { edges = [45, 50, 55] } = {}) {
  const labels = [`lt_${edges[0]}`];
  for (let i = 0; i < edges.length - 1; i++) labels.push(`${edges[i]}_${edges[i + 1]}`);
  labels.push(`gte_${edges.at(-1)}`);

  const bucketOf = (score) => {
    if (score < edges[0]) return labels[0];
    for (let i = 0; i < edges.length - 1; i++) {
      if (score >= edges[i] && score < edges[i + 1]) return labels[i + 1];
    }
    return labels.at(-1);
  };

  const buckets = labels.map((label) => {
    const inBucket = rows.filter((r) => bucketOf(r.score) === label);
    const withSl = inBucket.filter((r) => r.slTouched !== undefined);
    const withRet = inBucket.filter((r) => Number.isFinite(r.ret24h));
    return {
      label,
      n: inBucket.length,
      slN: withSl.length,
      slRate: withSl.length ? withSl.filter((r) => r.slTouched).length / withSl.length : null,
      retN: withRet.length,
      winRate: withRet.length ? withRet.filter((r) => r.ret24h > 0).length / withRet.length : null,
    };
  });

  // Diskontinuitas DI 50: bandingkan bucket tepat di bawah vs tepat di atas.
  const below = buckets.find((b) => b.label === `${edges[0]}_${edges[1]}`);
  const above = buckets.find((b) => b.label === `${edges[1]}_${edges[2]}`);
  const jump =
    below && above && below.slN > 0 && above.slN > 0
      ? twoProportionZ(
          Math.round(below.slRate * below.slN),
          below.slN,
          Math.round(above.slRate * above.slN),
          above.slN,
        )
      : null;

  return {
    buckets,
    jumpAt50: jump,
    verdict:
      jump === null
        ? "TIDAK KONKLUSIF — salah satu sisi ambang 50 kosong"
        : Math.abs(jump.z) > 2
          ? "H4 GUGUR — ada diskontinuitas nyata di 50"
          : "H4 BERDIRI — ambang 50 tidak memisahkan apa pun",
  };
}

/** H5 -- apakah distribusi skor bergerombol sehingga ambang sewenang-wenang? */
export function testH5(rows, { binSize = 1 } = {}) {
  const scores = rows.map((r) => r.score);
  const bins = new Map();
  for (const s of scores) {
    const b = Math.floor(s / binSize) * binSize;
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  const histogram = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([bin, count]) => ({ bin, count }));
  const distinctRounded = new Set(scores.map((s) => s.toFixed(2))).size;
  const sortedCounts = [...histogram].sort((a, b) => b.count - a.count);
  const top10Mass = sortedCounts.slice(0, 10).reduce((a, b) => a + b.count, 0) / scores.length;
  // Berapa bin yang dilewati sama sekali di dalam rentang terisi -- lubang
  // adalah tanda paling langsung bahwa menggeser ambang bisa tidak mengubah
  // apa pun.
  const minBin = histogram[0]?.bin ?? 0;
  const maxBin = histogram.at(-1)?.bin ?? 0;
  const spanBins = Math.round((maxBin - minBin) / binSize) + 1;
  const emptyBins = spanBins - histogram.length;

  return {
    sampleSize: scores.length,
    histogram,
    distinctRounded,
    top10Mass,
    spanBins,
    emptyBins,
    // KRITERIA BUNUH (plan H5): distribusi mulus -> H5 gugur.
    verdict:
      top10Mass < 0.5 && emptyBins === 0
        ? "H5 GUGUR — distribusi mulus, ambang bisa digeser bermakna"
        : `H5 BERDIRI — ${(top10Mass * 100).toFixed(0)}% massa di 10 bin, ${emptyBins} bin kosong`,
  };
}

/**
 * Baca JSON yang ditulis lewat redirect shell.
 *
 * PowerShell (jalur yang dipakai user repo ini) menulis `>` dengan BOM --
 * UTF-8-with-BOM, dan pada beberapa versi UTF-16LE. `JSON.parse` atas string
 * ber-BOM gagal dengan "Unexpected token" yang menunjuk ke karakter tak
 * terlihat di posisi 0, dan itu menyesatkan: yang salah encoding file, bukan
 * isinya. Ditangani di sini supaya export dari PowerShell maupun bash
 * sama-sama jalan tanpa langkah konversi manual.
 */
export function readJsonFile(path) {
  const buf = readFileSync(path);
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString("utf16le");
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    throw new Error(
      "file ber-encoding UTF-16BE, tidak didukung. Export ulang, atau konversi ke UTF-8 dulu.",
    );
  } else text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

export function runAll(rawRows) {
  const { rows, dropped } = parseRows(rawRows);
  return {
    sampleSize: rows.length,
    dropped,
    h1: testH1(rows),
    h2: testH2(rows),
    h3: testH3(rows),
    h4: testH4(rows),
    h5: testH5(rows),
  };
}

// ── CLI ────────────────────────────────────────────────────────────────
const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${(x * 100).toFixed(2)}%`);
const fx = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const line = (c = "─") => c.repeat(78);

function main() {
  const datasetPath = process.argv[2];
  if (!datasetPath) {
    console.error("pakai: node scripts/falsify-ranking-score.mjs <dataset.json>");
    console.error("(lihat header file ini untuk perintah export wrangler-nya)");
    process.exit(1);
  }

  const raw = readJsonFile(datasetPath);
  const rawRows = unwrapDataset(raw);
  const result = runAll(rawRows);

  console.log("═".repeat(78));
  console.log("FALSIFIKASI SKOR RANKING — OFFLINE, TIDAK ADA FILE PRODUKSI YANG DIUBAH");
  console.log("═".repeat(78));
  console.log(`dataset   : ${datasetPath}`);
  console.log(`row valid : ${result.sampleSize}  (di-drop ${result.dropped} — tanpa ranking_score)`);
  console.log(`pemisah   : skor < ${SCORE_SPLIT} vs >= ${SCORE_SPLIT}  (bukan 55 — bucket gte_55 cuma 4 baris, lihat T1)`);

  // ── H1 ──
  const h1 = result.h1;
  console.log(`\n${line("═")}\n[H1] Inversi SL-touch = artefak jarak stop-loss?  ← dijalankan pertama\n${line("═")}`);
  if (!h1) {
    console.log("tidak ada baris dengan sl_touched_24h + geometri grid — TIDAK KONKLUSIF");
  } else {
    console.log(`n = ${h1.sampleSize}  (skor rendah ${h1.lowCount} / tinggi ${h1.highCount})`);
    console.log(`\nJarak SL rata-rata (di bawah batas bawah grid):`);
    console.log(`  skor < ${SCORE_SPLIT} : ${fx(h1.meanGapLowPct)}%     lebar range ${fx(h1.meanRangeWidthLowPct)}%`);
    console.log(`  skor >= ${SCORE_SPLIT}: ${fx(h1.meanGapHighPct)}%     lebar range ${fx(h1.meanRangeWidthHighPct)}%`);
    console.log(`  selisih dalam SD gabungan: ${fx(h1.gapDiffSd, 3)}  (ambang konfound: |0.5|)`);
    if (h1.unadjusted) {
      console.log(
        `\nSL-touch TANPA koreksi: ${pct(h1.unadjusted.pA)} vs ${pct(h1.unadjusted.pB)}  z = ${fx(h1.unadjusted.z)}`,
      );
    }
    console.log(`\nSetelah distratifikasi per desil jarak SL:`);
    console.log(pad("desil", 7) + pad("gap%", 10) + pad("n", 8) + pad("SL rendah", 12) + pad("SL tinggi", 12) + "z");
    console.log(line());
    h1.strata.forEach((s, i) => {
      console.log(
        pad(i + 1, 7) +
          pad(fx(s.meanGapPct), 10) +
          pad(s.n, 8) +
          pad(pct(s.lowRate), 12) +
          pad(pct(s.highRate), 12) +
          (s.z ? fx(s.z) : "-"),
      );
    });
    console.log(`\nOdds ratio Mantel-Haenszel (terkoreksi jarak SL): ${fx(h1.mhOddsRatio, 3)}`);
    console.log(`Stratum yang arahnya konsisten: ${h1.sameDirection}/${h1.comparableStrata}`);
    console.log(`\n  VERDICT: ${h1.verdict}`);
  }

  // ── H2 ──
  console.log(`\n${line("═")}\n[H2] Adakah komponen dengan daya pisah univariat?\n${line("═")}`);
  console.log(`koreksi Bonferroni: ${BONFERRONI_TESTS} uji simultan → |z| > ${BONFERRONI_Z}\n`);
  console.log(pad("komponen", 14) + pad("tren SL (rho)", 15) + pad("z ujung SL", 13) + pad("tren win", 12) + pad("z ujung win", 13) + "status");
  console.log(line());
  for (const key of COMPONENT_KEYS) {
    const c = result.h2.perComponent[key];
    console.log(
      pad(key, 14) +
        pad(fx(c.trendSl, 3), 15) +
        pad(c.edgeSl ? fx(c.edgeSl.z) : "-", 13) +
        pad(fx(c.trendRet, 3), 12) +
        pad(c.edgeRet ? fx(c.edgeRet.z) : "-", 13) +
        (c.saved ? (c.inverted ? `TERBALIK (${c.savedVia})` : `BERGUNA (${c.savedVia})`) : "dibuang") +
        (c.adverseBySl ? "  ↑nilai → ↑SL-touch" : ""),
    );
  }
  if (result.h2.allAdverse) {
    console.log(
      "\n  ⚠  KEEMPAT komponen menunjuk arah adverse yang SAMA (nilai naik → SL-touch naik).",
    );
    console.log("     Itu bukan empat kebetulan terpisah — itu ORIENTASI skornya yang terbalik.");
  }
  console.log(`\n  VERDICT: ${result.h2.verdict}`);

  // ── H3 ──
  console.log(`\n${line("═")}\n[H3] Kolinearitas antar komponen (Spearman)\n${line("═")}`);
  for (const p of result.h3.pairs) {
    console.log(`  ${pad(`${p.a} × ${p.b}`, 32)} rho = ${pad(fx(p.rho, 3), 9)} (n=${p.n})`);
  }
  console.log(`\n  |rho| maksimum: ${fx(result.h3.maxAbs, 3)}`);
  console.log(`  VERDICT: ${result.h3.verdict}`);

  // ── H4 ──
  console.log(`\n${line("═")}\n[H4] Ambang dispatch 50 — apakah memisahkan?\n${line("═")}`);
  console.log(pad("bucket", 12) + pad("N", 9) + pad("SL-touch", 12) + pad("(n)", 9) + pad("win 24h", 11) + "(n)");
  console.log(line());
  for (const b of result.h4.buckets) {
    console.log(pad(b.label, 12) + pad(b.n, 9) + pad(pct(b.slRate), 12) + pad(b.slN, 9) + pad(pct(b.winRate), 11) + b.retN);
  }
  if (result.h4.jumpAt50) console.log(`\nlompatan SL-touch di ambang 50: z = ${fx(result.h4.jumpAt50.z)}`);
  console.log(`\n  VERDICT: ${result.h4.verdict}`);

  // ── H5 ──
  console.log(`\n${line("═")}\n[H5] Distribusi skor bergerombol?\n${line("═")}`);
  console.log(`nilai berbeda (2 desimal) : ${result.h5.distinctRounded} dari ${result.h5.sampleSize} baris`);
  console.log(`massa di 10 bin terpadat  : ${pct(result.h5.top10Mass)}`);
  console.log(`bin kosong dalam rentang  : ${result.h5.emptyBins} dari ${result.h5.spanBins}`);
  const top = [...result.h5.histogram].sort((a, b) => b.count - a.count).slice(0, 12).sort((a, b) => a.bin - b.bin);
  const maxCount = Math.max(...top.map((t) => t.count), 1);
  console.log(`\n12 bin terpadat:`);
  for (const t of top) {
    const bar = "█".repeat(Math.max(1, Math.round((t.count / maxCount) * 40)));
    console.log(`  ${pad(t.bin, 6)} ${pad(t.count, 8)} ${bar}`);
  }
  console.log(`\n  VERDICT: ${result.h5.verdict}`);

  console.log(`\n${"═".repeat(78)}`);
  console.log("Semua VERDICT di atas adalah hasil KRITERIA BUNUH yang ditulis lebih dulu");
  console.log("di plan, bukan tafsir sesudah melihat angka. Salin ke Bagian D plan file.");
  console.log("TIDAK ada bobot/ambang produksi yang diubah oleh skrip ini.");
  console.log("═".repeat(78));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
