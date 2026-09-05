import { describe, it, expect } from "vitest";
import {
  twoProportionZ,
  evaluateBackfillHealth,
  evaluateDiscriminatingPower,
  isAlertworthy,
  PENDING_BACKLOG_ALERT,
  MIN_BACKFILL_SAMPLE,
  GRID_NULL_ALERT_RATE,
  MIN_BUCKET_SAMPLE,
  SEPARATION_Z,
} from "./signalIntegrity.js";
import { SCORE_BUCKETS } from "./pipelineDecisionLog.js";
import type { PipelineDecisionAggregateGroup } from "./d1Client.js";

function grp(key: string, gridKnown: number, gridExited: number): PipelineDecisionAggregateGroup {
  return {
    key,
    sampleSize: gridKnown,
    winCount: 0,
    avgGrossReturn: 0,
    minGrossReturn: 0,
    maxGrossReturn: 0,
    slHits: 0,
    slKnown: 0,
    gridExited,
    gridExitedBelow: gridExited,
    gridKnown,
    avgTimeInRangePct: null,
    avgCrossingRate: null,
  };
}

describe("twoProportionZ", () => {
  // ── FIXTURE REFERENSI BERSAMA ────────────────────────────────────────
  // Angka yang SAMA dipatok di scripts/falsify-ranking-score.test.mjs.
  // twoProportionZ ada dua kali (TS untuk Worker, mjs untuk skrip offline)
  // karena batas TS/mjs; ini yang membuat keduanya tidak bisa menyimpang
  // diam-diam. Kalau salah satu implementasi bergeser, salah satu suite
  // merah. JANGAN ubah angka ini di satu file saja.
  it("cocok dengan fixture referensi bersama (50/100 vs 75/100)", () => {
    const r = twoProportionZ(50, 100, 75, 100)!;
    expect(r.pA).toBeCloseTo(0.5, 12);
    expect(r.pB).toBeCloseTo(0.75, 12);
    expect(r.z).toBeCloseTo(3.7796447300922726, 10);
  });

  it("null saat kelompok kosong atau SE nol", () => {
    expect(twoProportionZ(0, 0, 5, 10)).toBeNull();
    // Kedua proporsi 0 -> SE nol. null, BUKAN Infinity/NaN yang diam-diam
    // lolos ke verdict sebagai "signifikan".
    expect(twoProportionZ(0, 10, 0, 10)).toBeNull();
  });

  it("tandanya positif saat kelompok KEDUA lebih tinggi", () => {
    // Arah adalah seluruh isi verdict INVERTED vs OK -- kalau tandanya
    // terbalik, monitor akan melaporkan skor sehat justru saat ia rusak.
    expect(twoProportionZ(10, 100, 30, 100)!.z).toBeGreaterThan(0);
    expect(twoProportionZ(30, 100, 10, 100)!.z).toBeLessThan(0);
  });
});

describe("evaluateBackfillHealth", () => {
  it("STALLED saat backlog matang melewati ambang", () => {
    const r = evaluateBackfillHealth({
      pendingMatured: PENDING_BACKLOG_ALERT,
      recentBackfilled: 1000,
      recentGridNull: 10,
    });
    expect(r.verdict).toBe("STALLED");
    expect(isAlertworthy(r.verdict)).toBe(true);
  });

  it("backlog diperiksa SEBELUM fraksi NULL", () => {
    // Kalau aliran berhenti, fraksi NULL dihitung atas baris lama dan tidak
    // memberi tahu apa pun tentang keadaan sekarang. STALLED harus menang.
    const r = evaluateBackfillHealth({
      pendingMatured: PENDING_BACKLOG_ALERT + 1,
      recentBackfilled: 1000,
      recentGridNull: 1000, // juga memenuhi GRID_COLUMNS_DEAD
    });
    expect(r.verdict).toBe("STALLED");
  });

  it("GRID_COLUMNS_DEAD saat kolom grid praktis tidak pernah terisi", () => {
    const r = evaluateBackfillHealth({ pendingMatured: 0, recentBackfilled: 200, recentGridNull: 200 });
    expect(r.verdict).toBe("GRID_COLUMNS_DEAD");
    expect(r.gridNullRate).toBe(1);
    // Pesannya harus menyebut penyebab konkret, bukan cuma "ada yang salah".
    expect(r.detail).toMatch(/lower_price/);
  });

  it("OK saat fraksi NULL wajar -- kolom grid memang NULL untuk baris tanpa bound", () => {
    // ~5% baris historis tidak punya bound grid; itu normal, bukan kerusakan.
    const r = evaluateBackfillHealth({ pendingMatured: 3, recentBackfilled: 1000, recentGridNull: 50 });
    expect(r.verdict).toBe("OK");
    expect(isAlertworthy(r.verdict)).toBe(false);
  });

  it("INSUFFICIENT_SAMPLE di bawah ambang sampel, dan itu BUKAN alert", () => {
    const r = evaluateBackfillHealth({
      pendingMatured: 0,
      recentBackfilled: MIN_BACKFILL_SAMPLE - 1,
      recentGridNull: MIN_BACKFILL_SAMPLE - 1, // 100% NULL, tapi n terlalu kecil
    });
    expect(r.verdict).toBe("INSUFFICIENT_SAMPLE");
    expect(r.gridNullRate).toBeNull();
    expect(isAlertworthy(r.verdict)).toBe(false);
  });

  it("ambang NULL adalah >=, bukan >", () => {
    const n = 1000;
    const atThreshold = Math.round(n * GRID_NULL_ALERT_RATE);
    expect(evaluateBackfillHealth({ pendingMatured: 0, recentBackfilled: n, recentGridNull: atThreshold }).verdict).toBe(
      "GRID_COLUMNS_DEAD",
    );
    expect(
      evaluateBackfillHealth({ pendingMatured: 0, recentBackfilled: n, recentGridNull: atThreshold - 1 }).verdict,
    ).toBe("OK");
  });
});

describe("evaluateDiscriminatingPower", () => {
  const [lt40, mid, dispatch, high] = SCORE_BUCKETS;

  it("INVERTED saat skor tinggi lebih sering jebol", () => {
    // Pola persis temuan 2026-09-05: 2% vs 8%.
    const r = evaluateDiscriminatingPower([
      grp(lt40, 5000, 100),
      grp(mid, 1000, 20),
      grp(dispatch, 500, 40),
      grp(high, 100, 8),
    ]);
    expect(r.verdict).toBe("INVERTED");
    expect(r.z).toBeGreaterThan(SEPARATION_Z);
    expect(r.lowExitRate).toBeCloseTo(0.02, 10);
    expect(r.highExitRate).toBeCloseTo(0.08, 10);
    expect(isAlertworthy(r.verdict)).toBe(true);
  });

  it("OK saat skor tinggi lebih JARANG jebol", () => {
    const r = evaluateDiscriminatingPower([
      grp(lt40, 5000, 400),
      grp(mid, 1000, 80),
      grp(dispatch, 500, 10),
      grp(high, 100, 2),
    ]);
    expect(r.verdict).toBe("OK");
    expect(r.z).toBeLessThan(-SEPARATION_Z);
    expect(isAlertworthy(r.verdict)).toBe(false);
  });

  it("NO_SEPARATION saat kedua sisi sama saja", () => {
    const r = evaluateDiscriminatingPower([
      grp(lt40, 5000, 250),
      grp(mid, 1000, 50),
      grp(dispatch, 500, 25),
      grp(high, 100, 5),
    ]);
    expect(r.verdict).toBe("NO_SEPARATION");
    expect(Math.abs(r.z!)).toBeLessThan(SEPARATION_Z);
    // Skor yang tidak memisahkan apa pun TETAP layak dilaporkan -- itu
    // kegagalan diam yang sama berbahayanya dengan inversi.
    expect(isAlertworthy(r.verdict)).toBe(true);
  });

  it("INSUFFICIENT_SAMPLE saat salah satu sisi kurang, dan itu BUKAN alert", () => {
    const r = evaluateDiscriminatingPower([
      grp(lt40, 5000, 100),
      grp(mid, 1000, 20),
      grp(dispatch, MIN_BUCKET_SAMPLE - 1, 50), // sisi tinggi tipis
    ]);
    expect(r.verdict).toBe("INSUFFICIENT_SAMPLE");
    expect(isAlertworthy(r.verdict)).toBe(false);
    // Tetap melaporkan angkanya supaya "monitor jalan tapi datanya belum
    // cukup" bisa dibedakan dari "monitor tidak jalan".
    expect(r.lowKnown).toBe(6000);
    expect(r.highKnown).toBe(MIN_BUCKET_SAMPLE - 1);
  });

  it("membelah TEPAT di gate dispatch, bukan di ambang TRADE 55", () => {
    // Bucket 50_55 HARUS masuk sisi TINGGI. Kalau ia salah masuk sisi rendah
    // (mis. pemisahnya dipindah ke 55), symbol yang benar-benar di-alert-kan
    // justru tidak ikut dinilai -- monitor akan mengukur pita yang tidak
    // dikirim ke siapa pun, cacat yang sama dengan T8.
    const r = evaluateDiscriminatingPower([
      grp(lt40, 1000, 0),
      grp(mid, 1000, 0),
      grp(dispatch, 1000, 1000), // seluruh sisi tinggi jebol
      grp(high, 100, 100),
    ]);
    expect(r.lowKnown).toBe(2000);
    expect(r.highKnown).toBe(1100);
    expect(r.highExitRate).toBe(1);
    expect(r.lowExitRate).toBe(0);
  });

  it("bucket yang tidak muncul di agregat dianggap nol, bukan crash", () => {
    const r = evaluateDiscriminatingPower([grp(lt40, 5000, 100), grp(dispatch, 500, 40)]);
    expect(r.lowKnown).toBe(5000);
    expect(r.highKnown).toBe(500);
    expect(r.verdict).toBe("INVERTED");
  });

  it("agregat kosong -> INSUFFICIENT_SAMPLE, bukan pembagian nol", () => {
    const r = evaluateDiscriminatingPower([]);
    expect(r.verdict).toBe("INSUFFICIENT_SAMPLE");
    expect(r.lowExitRate).toBeNull();
    expect(r.z).toBeNull();
  });
});
