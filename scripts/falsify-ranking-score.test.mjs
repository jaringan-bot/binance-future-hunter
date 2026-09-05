import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseRows,
  deriveGeometry,
  mean,
  stddev,
  twoProportionZ,
  rankAverage,
  spearman,
  splitIntoQuantileGroups,
  mantelHaenszelOddsRatio,
  testH1,
  testH2,
  testH3,
  testH4,
  testH5,
  runAll,
  readJsonFile,
  COMPONENT_KEYS,
  SCORE_SPLIT,
  BONFERRONI_Z,
} from "./falsify-ranking-score.mjs";

// ── helpers fixture ────────────────────────────────────────────────────
function row(overrides = {}) {
  return {
    run_at: 1788000000000,
    symbol: "BTCUSDT",
    decision: "WATCH",
    ranking_score: 35,
    mm_component: 10,
    smart_money_component: 50,
    regime_component: 30,
    buy_pressure_component: 50,
    lower_price: 100,
    upper_price: 110,
    stop_loss: 95,
    forward_return_24h: 0.01,
    sl_touched_24h: 0,
    ...overrides,
  };
}

/** n baris identik, `touched` di antaranya kena SL. */
function block(n, touched, overrides) {
  return Array.from({ length: n }, (_, i) => row({ ...overrides, sl_touched_24h: i < touched ? 1 : 0 }));
}

describe("statistik dasar", () => {
  it("twoProportionZ menghitung z yang benar dan null saat kelompok kosong", () => {
    // 50/100 vs 75/100 -> SE = sqrt(.25/100 + .1875/100) = 0.0661
    const r = twoProportionZ(50, 100, 75, 100);
    expect(r.pA).toBeCloseTo(0.5, 10);
    expect(r.pB).toBeCloseTo(0.75, 10);
    expect(r.z).toBeCloseTo(0.25 / Math.sqrt(0.25 / 100 + 0.1875 / 100), 6);
    expect(twoProportionZ(0, 0, 5, 10)).toBeNull();
    // SE nol (kedua proporsi 0) -> null, BUKAN Infinity/NaN yang diam-diam
    // lolos ke output sebagai "signifikan".
    expect(twoProportionZ(0, 10, 0, 10)).toBeNull();
  });

  it("rankAverage merata-ratakan peringkat nilai kembar", () => {
    expect(rankAverage([10, 20, 30])).toEqual([1, 2, 3]);
    // dua nilai 20 menempati peringkat 2 dan 3 -> keduanya 2.5
    expect(rankAverage([10, 20, 20, 40])).toEqual([1, 2.5, 2.5, 4]);
  });

  it("spearman: +1 monotonik naik, -1 turun, null kalau satu sisi konstan", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
    // monotonik tapi tidak linear -> Spearman tetap 1 (inilah alasan memakai
    // Spearman, bukan Pearson: yang diuji urutan, bukan bentuk).
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it("splitIntoQuantileGroups membagi rata dan membuang nilai non-finite", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ v: i }));
    const groups = splitIntoQuantileGroups(items, (x) => x.v, 10);
    expect(groups).toHaveLength(10);
    expect(groups.every((g) => g.length === 10)).toBe(true);
    expect(groups[0][0].v).toBe(0);
    expect(groups.at(-1).at(-1).v).toBe(99);

    const withJunk = [{ v: 1 }, { v: NaN }, { v: 2 }, { v: undefined }];
    const g2 = splitIntoQuantileGroups(withJunk, (x) => x.v, 2);
    expect(g2.flat()).toHaveLength(2);
  });

  it("mantelHaenszelOddsRatio = 1 tanpa asosiasi, > 1 saat kelompok tinggi lebih sering kena", () => {
    // rate identik di kedua kelompok -> OR tepat 1
    expect(mantelHaenszelOddsRatio([{ a: 10, b: 10, c: 10, d: 10 }])).toBeCloseTo(1, 10);
    // tinggi 20/40 vs rendah 10/40 -> OR = (20*30)/(20*10) = 3
    expect(mantelHaenszelOddsRatio([{ a: 20, b: 20, c: 10, d: 30 }])).toBeCloseTo(3, 10);
    expect(mantelHaenszelOddsRatio([{ a: 0, b: 0, c: 0, d: 0 }])).toBeNull();
  });

  it("mean/stddev: stddev butuh minimal 2 titik", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9], 5)).toBeCloseTo(2.138, 3);
    expect(Number.isNaN(stddev([1]))).toBe(true);
  });
});

describe("parseRows & deriveGeometry", () => {
  it("membaca alias snake_case dan camelCase", () => {
    const { rows } = parseRows([row(), { rankingScore: 42, smartMoneyComponent: 60 }]);
    expect(rows).toHaveLength(2);
    expect(rows[0].score).toBe(35);
    expect(rows[0].smartMoney).toBe(50);
    expect(rows[1].score).toBe(42);
    expect(rows[1].smartMoney).toBe(60);
  });

  it("membuang baris tanpa ranking_score, TAPI menyimpan baris dengan kolom opsional kosong", () => {
    const { rows, dropped } = parseRows([row(), { symbol: "X" }, row({ stop_loss: null, sl_touched_24h: null })]);
    expect(dropped).toBe(1);
    expect(rows).toHaveLength(2);
    // Baris tanpa stop_loss TETAP masuk -- kalau ia ikut dibuang, uji yang
    // tidak butuh stop_loss (H3/H5) kehilangan sampel tanpa alasan.
    expect(rows[1].stopLoss).toBeUndefined();
    expect(rows[1].slTouched).toBeUndefined();
  });

  it("menolak dataset yang mencampur semantik mm (reuse assertSingleMmSemantics)", () => {
    expect(() => parseRows([row(), row({ mm_adverse_component: 12 })])).toThrow(/mencampur semantik mm_component/);
  });

  it("deriveGeometry menghitung lebar range & jarak SL relatif", () => {
    // lower 100, upper 110 -> 10% ; stop 95 -> gap 5%
    expect(deriveGeometry({ lower: 100, upper: 110, stopLoss: 95 })).toEqual({
      rangeWidthPct: 10,
      slGapPct: 5,
    });
    expect(deriveGeometry({ lower: 0, upper: 110, stopLoss: 95 }).slGapPct).toBeUndefined();
    expect(deriveGeometry({ lower: 100, upper: undefined, stopLoss: 95 }).rangeWidthPct).toBeUndefined();
  });
});

// ── H1: inti dokumen ini -- kriteria bunuh HARUS bisa menyala dua arah ──
describe("testH1 — konfound jarak stop-loss", () => {
  /**
   * Kasus KONFOUND MURNI: di dalam tiap stratum jarak-SL, tingkat SL-touch
   * kedua kelompok skor IDENTIK. Inversi mentah muncul semata karena baris
   * skor tinggi menumpuk di jarak-SL rapat.
   *
   * Tiap gap punya total 40 baris supaya pembagian kuantil 5 kelompok jatuh
   * tepat di batas gap.
   */
  function confoundedRows() {
    const spec = [
      { gap: 1, high: 35, low: 5, rate: 0.6 },
      { gap: 2, high: 30, low: 10, rate: 0.4 },
      { gap: 3, high: 20, low: 20, rate: 0.3 },
      { gap: 4, high: 10, low: 30, rate: 0.2 },
      { gap: 5, high: 5, low: 35, rate: 0.0 },
    ];
    const out = [];
    for (const s of spec) {
      const geom = { lower_price: 100, upper_price: 110, stop_loss: 100 - s.gap };
      out.push(...block(s.high, Math.round(s.high * s.rate), { ...geom, ranking_score: 45 }));
      out.push(...block(s.low, Math.round(s.low * s.rate), { ...geom, ranking_score: 35 }));
    }
    return out;
  }

  it("menyatakan H1 BENAR saat inversi sepenuhnya dijelaskan jarak SL", () => {
    const { rows } = parseRows(confoundedRows());
    const r = testH1(rows, { strataCount: 5 });

    // Inversi mentah nyata dan besar: 41% vs 19%.
    expect(r.unadjusted.pA).toBeCloseTo(0.19, 10);
    expect(r.unadjusted.pB).toBeCloseTo(0.41, 10);
    expect(r.unadjusted.z).toBeGreaterThan(3);

    // ...tapi hilang total setelah distratifikasi.
    expect(r.mhOddsRatio).toBeCloseTo(1, 6);
    expect(r.verdict).toMatch(/H1 BENAR/);
    expect(r.verdict).toMatch(/T3\/T4 DICORET/);
  });

  it("menyatakan H1 GUGUR saat inversi bertahan di dalam tiap stratum", () => {
    // Jarak SL sama persis di kedua kelompok (konfound tidak punya jalan),
    // tapi skor tinggi tetap 40% vs 20% di SETIAP stratum.
    const out = [];
    for (const gap of [1, 2, 3, 4, 5]) {
      const geom = { lower_price: 100, upper_price: 110, stop_loss: 100 - gap };
      out.push(...block(20, 8, { ...geom, ranking_score: 45 }));
      out.push(...block(20, 4, { ...geom, ranking_score: 35 }));
    }
    const { rows } = parseRows(out);
    const r = testH1(rows, { strataCount: 5 });

    expect(r.gapDiffSd).toBeCloseTo(0, 6);
    expect(r.mhOddsRatio).toBeGreaterThan(2);
    expect(r.sameDirection).toBe(r.comparableStrata);
    expect(r.verdict).toMatch(/H1 GUGUR/);
    expect(r.verdict).toMatch(/T3\/T4 berdiri/);
  });

  it("memakai odds ratio Mantel-Haenszel, bukan cuma konsistensi arah", () => {
    // Kasus yang MEMISAHKAN dua syarat `survivesAdjustment`. Arah konsisten
    // di 4 dari 5 stratum (lolos syarat >= 0.6), TAPI stratum kelima
    // membalikkannya begitu kuat sehingga OR gabungan < 1.
    //
    // Tanpa suku OR, verdict akan salah menyatakan inversinya bertahan.
    // Tiap gap diberi 88 baris supaya pembagian kuantil jatuh tepat di
    // batas gap.
    const out = [];
    for (const gap of [1, 2, 3, 4]) {
      const geom = { lower_price: 100, upper_price: 110, stop_loss: 100 - gap };
      out.push(...block(44, 24, { ...geom, ranking_score: 45 }));
      out.push(...block(44, 20, { ...geom, ranking_score: 35 }));
    }
    const geom5 = { lower_price: 100, upper_price: 110, stop_loss: 95 };
    out.push(...block(44, 2, { ...geom5, ranking_score: 45 }));
    out.push(...block(44, 42, { ...geom5, ranking_score: 35 }));

    const { rows } = parseRows(out);
    const r = testH1(rows, { strataCount: 5 });

    expect(r.sameDirection).toBe(4);
    expect(r.comparableStrata).toBe(5);
    expect(r.mhOddsRatio).toBeLessThan(1);
    // OR < 1 harus menjatuhkan verdict meski arahnya konsisten 4/5.
    expect(r.verdict).toMatch(/H1 BENAR/);
  });

  it("menolak OR > 1 yang lahir dari SATU stratum menyimpang (guard homogenitas)", () => {
    // Cermin dari test sebelumnya: OR gabungan > 1, TAPI arahnya cuma
    // konsisten di 1 dari 5 stratum. Mantel-Haenszel mengandaikan efek yang
    // homogen antar stratum; kalau satu stratum menyetir seluruh angka,
    // OR gabungan menyesatkan dan tidak boleh dibaca sebagai "bertahan".
    const out = [];
    for (const gap of [1, 2, 3, 4]) {
      const geom = { lower_price: 100, upper_price: 110, stop_loss: 100 - gap };
      out.push(...block(44, 20, { ...geom, ranking_score: 45 }));
      out.push(...block(44, 24, { ...geom, ranking_score: 35 }));
    }
    const geom5 = { lower_price: 100, upper_price: 110, stop_loss: 95 };
    out.push(...block(44, 42, { ...geom5, ranking_score: 45 }));
    out.push(...block(44, 2, { ...geom5, ranking_score: 35 }));

    const { rows } = parseRows(out);
    const r = testH1(rows, { strataCount: 5 });

    expect(r.mhOddsRatio).toBeGreaterThan(1);
    expect(r.sameDirection).toBe(1);
    expect(r.comparableStrata).toBe(5);
    expect(r.verdict).toMatch(/H1 BENAR/);
  });

  it("menyatakan TIDAK KONKLUSIF saat konfound ADA dan efeknya juga bertahan", () => {
    // Kasus paling mungkin di data nyata, dan satu-satunya yang membuat
    // ambang 0.5 SD jadi penentu: jarak SL memang berbeda bermakna antar
    // kelompok skor (konfound nyata), TAPI di dalam tiap stratum skor tinggi
    // tetap lebih sering kena. Keduanya bercampur, jadi tidak boleh diklaim
    // sebagai temuan MAUPUN dibuang.
    const spec = [
      { gap: 1, high: 35, low: 5 },
      { gap: 2, high: 30, low: 10 },
      { gap: 3, high: 20, low: 20 },
      { gap: 4, high: 10, low: 30 },
      { gap: 5, high: 5, low: 35 },
    ];
    const out = [];
    for (const s of spec) {
      const geom = { lower_price: 100, upper_price: 110, stop_loss: 100 - s.gap };
      out.push(...block(s.high, Math.round(s.high * 0.6), { ...geom, ranking_score: 45 }));
      out.push(...block(s.low, Math.round(s.low * 0.2), { ...geom, ranking_score: 35 }));
    }
    const { rows } = parseRows(out);
    const r = testH1(rows, { strataCount: 5 });

    expect(Math.abs(r.gapDiffSd)).toBeGreaterThan(0.5); // konfound nyata
    expect(r.mhOddsRatio).toBeGreaterThan(1); // efek juga bertahan
    expect(r.sameDirection).toBe(5);
    expect(r.verdict).toMatch(/TIDAK KONKLUSIF/);
  });

  it("menolak menyimpulkan saat stratifikasi terlalu tipis", () => {
    // Cuma 2 nilai jarak SL, dan tiap nilai dihuni SATU kelompok skor saja.
    // Tidak ada stratum yang bisa membandingkan apa pun -- verdict harus
    // menolak, bukan diam-diam memakai stratum yang tersisa.
    const out = [
      ...block(50, 30, { lower_price: 100, upper_price: 110, stop_loss: 99, ranking_score: 45 }),
      ...block(50, 10, { lower_price: 100, upper_price: 110, stop_loss: 95, ranking_score: 35 }),
    ];
    const { rows } = parseRows(out);
    const r = testH1(rows, { strataCount: 5 });

    expect(r.stratificationOk).toBe(false);
    expect(r.verdict).toMatch(/TIDAK KONKLUSIF/);
    expect(r.verdict).toMatch(/stratifikasi terlalu tipis/);
  });

  it("mengembalikan null kalau tidak ada baris dengan SL + geometri", () => {
    const { rows } = parseRows([row({ sl_touched_24h: null, stop_loss: null })]);
    expect(testH1(rows)).toBeNull();
  });
});

describe("testH2 — daya pisah univariat", () => {
  it("menyelamatkan komponen yang monotonik DAN lolos Bonferroni", () => {
    // mm naik 0..99; SL-touch naik monotonik per desil (8% -> 80%).
    const raw = [];
    for (let d = 0; d < 10; d++) {
      const touched = Math.round(100 * ((d + 1) * 0.08));
      for (let i = 0; i < 100; i++) {
        raw.push(row({ mm_component: d * 10 + (i % 10), sl_touched_24h: i < touched ? 1 : 0 }));
      }
    }
    const { rows } = parseRows(raw);
    const r = testH2(rows);
    expect(r.perComponent.mm.trendSl).toBeCloseTo(1, 6);
    expect(Math.abs(r.perComponent.mm.edgeSl.z)).toBeGreaterThan(BONFERRONI_Z);
    expect(r.perComponent.mm.saved).toBe(true);
    expect(r.savedKeys).toContain("mm");
    // Fixture ini naik: nilai mm naik -> SL-touch naik -> TERBALIK, bukan
    // "berguna apa adanya". Label harus mengatakannya.
    expect(r.perComponent.mm.adverseBySl).toBe(true);
    expect(r.perComponent.mm.inverted).toBe(true);
    expect(r.invertedKeys).toContain("mm");
    expect(r.usableKeys).not.toContain("mm");
    expect(r.verdict).toMatch(/TERBALIK/);
  });

  it("menandai komponen berdaya pisah dengan arah BENAR sebagai berguna", () => {
    // Cermin: nilai komponen naik -> SL-touch TURUN. Inilah satu-satunya
    // bentuk yang layak dipertahankan apa adanya.
    const rates = [0.8, 0.72, 0.64, 0.56, 0.48, 0.4, 0.32, 0.24, 0.16, 0.08];
    const raw = [];
    for (let d = 0; d < 10; d++) {
      const touched = Math.round(100 * rates[d]);
      for (let i = 0; i < 100; i++) {
        raw.push(row({ mm_component: d * 10 + (i % 10), sl_touched_24h: i < touched ? 1 : 0 }));
      }
    }
    const { rows } = parseRows(raw);
    const r = testH2(rows);
    expect(r.perComponent.mm.trendSl).toBeCloseTo(-1, 6);
    expect(r.perComponent.mm.adverseBySl).toBe(false);
    expect(r.perComponent.mm.inverted).toBe(false);
    expect(r.usableKeys).toContain("mm");
    expect(r.verdict).toMatch(/berguna apa adanya/);
    expect(r.allAdverse).toBe(false);
  });

  it("membuang komponen yang tidak monotonik meski selisih ujungnya besar", () => {
    // Zig-zag: desil 1 rendah, desil 10 tinggi, tapi di antaranya bolak-balik
    // -> selisih ujung besar, tren TIDAK monotonik. Kriteria bunuh menuntut
    // KEDUANYA, jadi komponen ini harus dibuang.
    const rates = [0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9];
    const raw = [];
    for (let d = 0; d < 10; d++) {
      const touched = Math.round(100 * rates[d]);
      for (let i = 0; i < 100; i++) {
        raw.push(row({ mm_component: d * 10 + (i % 10), sl_touched_24h: i < touched ? 1 : 0 }));
      }
    }
    const { rows } = parseRows(raw);
    const r = testH2(rows);
    expect(Math.abs(r.perComponent.mm.edgeSl.z)).toBeGreaterThan(BONFERRONI_Z);
    expect(Math.abs(r.perComponent.mm.trendSl)).toBeLessThan(0.7);
    expect(r.perComponent.mm.saved).toBe(false);
  });

  it("membuang tren monotonik yang tidak lolos Bonferroni (sampel kecil)", () => {
    // Tren monotonik hampir sempurna, TAPI cuma 5 baris per desil sehingga
    // selisih ujung (20% vs 80%) memberi |z| ~2.37 -- di bawah ambang
    // Bonferroni 2.734 untuk 8 uji simultan. Tanpa koreksi itu, pola
    // sebersih ini akan lolos dari 50 baris, dan itu justru cara paling umum
    // mengarang sinyal dari data sedikit.
    const rates = [0.2, 0.2, 0.4, 0.4, 0.4, 0.6, 0.6, 0.6, 0.8, 0.8];
    const raw = [];
    for (let d = 0; d < 10; d++) {
      const touched = Math.round(5 * rates[d]);
      for (let i = 0; i < 5; i++) {
        raw.push(row({ mm_component: d * 5 + i, sl_touched_24h: i < touched ? 1 : 0 }));
      }
    }
    const { rows } = parseRows(raw);
    const r = testH2(rows);

    expect(r.perComponent.mm.trendSl).toBeGreaterThan(0.9); // monotonik kuat
    expect(Math.abs(r.perComponent.mm.edgeSl.z)).toBeLessThan(2.734); // tapi tidak signifikan
    expect(r.perComponent.mm.saved).toBe(false);
    expect(r.verdict).toMatch(/H2 BERDIRI/);
  });

  it("menyatakan H2 BERDIRI kalau tidak ada komponen yang selamat", () => {
    const { rows } = parseRows(block(200, 60, {}));
    const r = testH2(rows);
    expect(r.savedKeys).toHaveLength(0);
    expect(r.verdict).toMatch(/H2 BERDIRI/);
  });
});

describe("testH3 — kolinearitas", () => {
  it("menandai pasangan yang berkorelasi sempurna sebagai tidak identifiable", () => {
    const raw = Array.from({ length: 100 }, (_, i) =>
      row({ mm_component: i, smart_money_component: i * 2, regime_component: 50, buy_pressure_component: 50 }),
    );
    const { rows } = parseRows(raw);
    const r = testH3(rows);
    expect(r.pairs).toHaveLength(6); // 4 komponen -> C(4,2)
    const pair = r.pairs.find((p) => p.a === "mm" && p.b === "smartMoney");
    expect(pair.rho).toBeCloseTo(1, 6);
    expect(r.maxAbs).toBeCloseTo(1, 6);
    expect(r.verdict).toMatch(/H3 BERDIRI KUAT/);
  });

  it("menyatakan H3 GUGUR saat semua |rho| < 0.3", () => {
    // mm naik, smartMoney bergerak dalam pola yang hampir tak berkorelasi
    // dengannya; dua komponen lain konstan (rho null, tidak menaikkan maxAbs).
    const raw = Array.from({ length: 120 }, (_, i) =>
      row({ mm_component: i, smart_money_component: (i * 37) % 11, regime_component: 50, buy_pressure_component: 50 }),
    );
    const { rows } = parseRows(raw);
    const r = testH3(rows);
    expect(r.maxAbs).toBeLessThan(0.3);
    expect(r.verdict).toMatch(/H3 GUGUR/);
  });
});

describe("testH4 — ambang dispatch 50", () => {
  it("mendeteksi diskontinuitas nyata tepat di 50", () => {
    const raw = [
      ...block(300, 30, { ranking_score: 47 }), // 10%
      ...block(300, 150, { ranking_score: 52 }), // 50%
    ];
    const { rows } = parseRows(raw);
    const r = testH4(rows);
    expect(r.jumpAt50.z).toBeGreaterThan(2);
    expect(r.verdict).toMatch(/H4 GUGUR/);
  });

  it("menyatakan H4 BERDIRI saat kedua sisi ambang sama saja", () => {
    const raw = [...block(300, 60, { ranking_score: 47 }), ...block(300, 60, { ranking_score: 52 })];
    const { rows } = parseRows(raw);
    const r = testH4(rows);
    expect(Math.abs(r.jumpAt50.z)).toBeLessThan(2);
    expect(r.verdict).toMatch(/H4 BERDIRI/);
  });
});

describe("testH5 — pergerombolan distribusi skor", () => {
  it("menyatakan H5 BERDIRI saat skor cuma menempati sedikit nilai", () => {
    const raw = Array.from({ length: 300 }, (_, i) => row({ ranking_score: [30, 31, 32][i % 3] }));
    const { rows } = parseRows(raw);
    const r = testH5(rows);
    expect(r.distinctRounded).toBe(3);
    expect(r.top10Mass).toBeCloseTo(1, 6);
    expect(r.verdict).toMatch(/H5 BERDIRI/);
  });

  it("menyatakan H5 GUGUR saat distribusi tersebar tanpa lubang", () => {
    // 31 bin (30..60) terisi merata -> 10 bin terpadat cuma ~32% massa.
    const raw = [];
    for (let s = 30; s <= 60; s++) for (let i = 0; i < 10; i++) raw.push(row({ ranking_score: s + 0.5 }));
    const { rows } = parseRows(raw);
    const r = testH5(rows);
    expect(r.emptyBins).toBe(0);
    expect(r.top10Mass).toBeLessThan(0.5);
    expect(r.verdict).toMatch(/H5 GUGUR/);
  });
});

describe("readJsonFile — encoding dari redirect shell", () => {
  const tmp = join(tmpdir(), `falsify-enc-${process.pid}`);
  beforeAll(() => mkdirSync(tmp, { recursive: true }));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const payload = [{ results: [{ ranking_score: 42 }] }];

  it("membaca UTF-8 polos", () => {
    const p = join(tmp, "plain.json");
    writeFileSync(p, JSON.stringify(payload), "utf8");
    expect(readJsonFile(p)).toEqual(payload);
  });

  it("membaca UTF-8 ber-BOM (default redirect PowerShell)", () => {
    const p = join(tmp, "bom.json");
    writeFileSync(p, "﻿" + JSON.stringify(payload), "utf8");
    expect(readJsonFile(p)).toEqual(payload);
  });

  it("membaca UTF-16LE ber-BOM", () => {
    const p = join(tmp, "utf16.json");
    writeFileSync(p, Buffer.from("﻿" + JSON.stringify(payload), "utf16le"));
    expect(readJsonFile(p)).toEqual(payload);
  });

  it("memberi pesan yang jelas untuk UTF-16BE, bukan error JSON yang menyesatkan", () => {
    const p = join(tmp, "utf16be.json");
    const le = Buffer.from("﻿" + JSON.stringify(payload), "utf16le");
    expect(le.length % 2).toBe(0);
    // swap byte -> UTF-16BE
    for (let i = 0; i < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]];
    writeFileSync(p, le);
    expect(() => readJsonFile(p)).toThrow(/UTF-16BE/);
  });
});

describe("runAll", () => {
  it("menjalankan kelima hipotesis dan melaporkan jumlah baris", () => {
    const raw = [...block(100, 20, { ranking_score: 35 }), ...block(100, 40, { ranking_score: 45 })];
    const r = runAll(raw);
    expect(r.sampleSize).toBe(200);
    expect(r.dropped).toBe(0);
    for (const h of ["h1", "h2", "h3", "h4", "h5"]) expect(r[h]).toBeTruthy();
    expect(COMPONENT_KEYS).toHaveLength(4);
    expect(SCORE_SPLIT).toBe(40);
  });
});
