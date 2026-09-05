import { describe, it, expect } from "vitest";
import {
  didStopLossTouch,
  scoreBucket,
  scoreBucketSqlCase,
  SCORE_BUCKET_MID_MIN,
  SCORE_BUCKET_DISPATCH_MIN,
  SCORE_BUCKET_HIGH_MIN,
  SCORE_BUCKETS,
  toPipelineDecisionLogRow,
} from "./pipelineDecisionLog.js";
import type { SymbolPipelineResult } from "./tools/fullPipeline.js";

function result(partial: Partial<SymbolPipelineResult> & Pick<SymbolPipelineResult, "symbol" | "decision">): SymbolPipelineResult {
  return {
    rankingScore: 0,
    hardScreen: {
      passed: false,
      reasons: ["vol"],
      quoteVolumeUsd: 1_000_000,
      fundingRate: 0.0001,
      regime1h: "RANGING",
      regime4h: "TRENDING_DOWN",
    },
    reasoning: [],
    ...partial,
  } as SymbolPipelineResult;
}

describe("scoreBucket", () => {
  it("memisah di ambang terpasang 40 / 50 / 55", () => {
    expect(scoreBucket(39.9)).toBe("lt_40");
    expect(scoreBucket(40)).toBe("40_50");
    expect(scoreBucket(49.9)).toBe("40_50");
    expect(scoreBucket(50)).toBe("50_55");
    expect(scoreBucket(54.9)).toBe("50_55");
    expect(scoreBucket(55)).toBe("gte_55");
    expect(scoreBucket(80)).toBe("gte_55");
  });

  // ── T8 (2026-09-05) ───────────────────────────────────────────────────
  it("INVARIAN: batas bucket dispatch == gate alert yang sebenarnya", async () => {
    // Ini test paling penting di file ini, dan alasannya bukan soal angka.
    //
    // Sebelum T8, bucket-nya lt_40 / 40_55 / gte_55 sementara alert WATCH
    // benar-benar dikirim pada skor >= 50 (isGridAlertWorthy). Batas 50 itu
    // duduk di TENGAH bucket "40_55", jadi setiap analisis backtest selama
    // berminggu-minggu melaporkan angka untuk pita yang tidak dipakai siapa
    // pun mengambil keputusan -- dan tidak ada satu pun test yang bisa
    // menyadarinya, karena kedua angka itu hidup di file berbeda tanpa
    // hubungan apa pun.
    //
    // pipelineDecisionLog.ts SENGAJA tidak meng-import layer cron (mapper
    // murni tidak boleh bergantung ke cron), jadi invariannya tidak bisa
    // ditegakkan tipe. Import dinamis di TEST adalah tempat yang benar:
    // produksi tetap bebas dependensi, tapi keduanya tidak bisa lagi
    // bergeser sendiri-sendiri tanpa suite merah.
    const { WATCH_MIN_ALERT_SCORE } = await import("./cron/entryAlertCron.js");
    expect(SCORE_BUCKET_DISPATCH_MIN).toBe(WATCH_MIN_ALERT_SCORE);

    // Dan konsekuensinya yang sebenarnya dipakai: skor tepat di gate harus
    // jatuh di AWAL bucket-nya sendiri, bukan tenggelam di tengah bucket lain.
    expect(scoreBucket(WATCH_MIN_ALERT_SCORE)).toBe("50_55");
    expect(scoreBucket(WATCH_MIN_ALERT_SCORE - 0.01)).toBe("40_50");
  });

  it("label bucket DITURUNKAN dari ambangnya, tidak ditulis tangan", () => {
    // Komentar lama di pipelineDecisionLog.ts memperingatkan "kalau threshold
    // diubah, label wajib ikut diubah -- kalau tidak output akan berbohong
    // tentang isi bucket-nya". Sekarang label dihasilkan dari konstanta yang
    // sama, jadi ia TIDAK BISA berbohong. Test ini mengunci sifat itu.
    expect(SCORE_BUCKETS).toEqual([
      `lt_${SCORE_BUCKET_MID_MIN}`,
      `${SCORE_BUCKET_MID_MIN}_${SCORE_BUCKET_DISPATCH_MIN}`,
      `${SCORE_BUCKET_DISPATCH_MIN}_${SCORE_BUCKET_HIGH_MIN}`,
      `gte_${SCORE_BUCKET_HIGH_MIN}`,
    ]);
    // Urutan menaik, tanpa celah maupun tumpang tindih.
    expect(SCORE_BUCKET_MID_MIN).toBeLessThan(SCORE_BUCKET_DISPATCH_MIN);
    expect(SCORE_BUCKET_DISPATCH_MIN).toBeLessThan(SCORE_BUCKET_HIGH_MIN);
  });
});

describe("didStopLossTouch", () => {
  it("returns null when stopLoss is missing or lows are empty", () => {
    expect(didStopLossTouch([10, 9], null)).toBeNull();
    expect(didStopLossTouch([], 9)).toBeNull();
    expect(didStopLossTouch([10], Number.NaN)).toBeNull();
  });

  it("is true when any low is at or below stopLoss", () => {
    expect(didStopLossTouch([10.2, 9.5, 10.1], 9.5)).toBe(true);
    expect(didStopLossTouch([10.2, 9.4], 9.5)).toBe(true);
  });

  it("is false when every low stays above stopLoss", () => {
    expect(didStopLossTouch([10.2, 9.6], 9.5)).toBe(false);
  });
});

describe("toPipelineDecisionLogRow", () => {
  it("maps a compact row including hard-screen reject (null grid bounds)", () => {
    const row = toPipelineDecisionLogRow(
      result({ symbol: "ontusdt", decision: "NO_TRADE", rankingScore: 12 }),
      1_700_000_000_000,
      "entry_alert",
    );
    expect(row).toMatchObject({
      runAt: 1_700_000_000_000,
      symbol: "ONTUSDT",
      source: "entry_alert",
      sourceRef: null,
      decision: "NO_TRADE",
      rankingScore: 12,
      hardScreenPassed: false,
      hardScreenReasons: ["vol"],
      quoteVolumeUsd: 1_000_000,
      fundingRate: 0.0001,
      regime1h: "RANGING",
      regime4h: "TRENDING_DOWN",
      gridRiskStatus: null,
      lowerPrice: null,
      upperPrice: null,
      stopLoss: null,
      // hard screen gagal -> rankingComponents undefined -> kolom NULL
      mmComponent: null,
      smartMoneyComponent: null,
      regimeComponent: null,
      buyPressureComponent: null,
    });
  });

  it("persists the 4 ranking sub-scores when present (migration 0014)", () => {
    const row = toPipelineDecisionLogRow(
      result({
        symbol: "SOLUSDT",
        decision: "TRADE",
        rankingScore: 62.4,
        rankingComponents: { mm: 70, mmAdverse: 25, smartMoney: 55, regime: 60, buyPressure: 50 },
      }),
      1,
      "manual",
    );
    expect(row.mmComponent).toBe(70);
    expect(row.mmAdverseComponent).toBe(25);
    expect(row.smartMoneyComponent).toBe(55);
    expect(row.regimeComponent).toBe(60);
    expect(row.buyPressureComponent).toBe(50);
  });

  it("prefers gridBotConfig bounds and keeps dropstab source_ref", () => {
    const row = toPipelineDecisionLogRow(
      result({
        symbol: "ATOMUSDT",
        decision: "WATCH",
        rankingScore: 40.5,
        hardScreen: {
          passed: true,
          reasons: [],
          quoteVolumeUsd: 9_000_000,
          fundingRate: 0.0002,
          regime1h: "RANGING",
          regime4h: "RANGING",
        },
        gridBotConfig: {
          lower: 4.1,
          upper: 4.8,
          gridCount: 20,
          gridType: "ARITHMETIC",
          leverage: 5,
          marginMode: "ISOLATED",
          stopLoss: 3.9,
          takeProfit: 5.0,
          marginModeCaveat: "",
        },
        risk: {
          chosenLeverage: 5,
          initialCapitalSolved: 80,
          evaluatedLeverages: [],
          gridRisk: { status: "MODERATE" } as never,
        },
      }),
      99,
      "dropstab",
      "  token-matang-9ugwlm9y9l  ",
    );
    expect(row.source).toBe("dropstab");
    expect(row.sourceRef).toBe("token-matang-9ugwlm9y9l");
    expect(row.lowerPrice).toBe(4.1);
    expect(row.upperPrice).toBe(4.8);
    expect(row.stopLoss).toBe(3.9);
    expect(row.gridRiskStatus).toBe("MODERATE");
    expect(row.hardScreenPassed).toBe(true);
  });

  it("falls back to gridSetup when gridBotConfig is absent", () => {
    const row = toPipelineDecisionLogRow(
      result({
        symbol: "BTCUSDT",
        decision: "TRADE",
        rankingScore: 60,
        gridSetup: { lowerPrice: 100, upperPrice: 120, stopLossPrice: 95 } as never,
      }),
      1,
      "manual",
      "",
    );
    expect(row.sourceRef).toBeNull();
    expect(row.lowerPrice).toBe(100);
    expect(row.upperPrice).toBe(120);
    expect(row.stopLoss).toBe(95);
  });
});

// Stage 4.1: bucket dipakai di DUA jalur -- scoreBucket() untuk sampel
// detail dan ekspresi SQL untuk agregat atas seluruh rentang. Kalau keduanya
// berbeda, satu skor bisa masuk bucket yang berlainan tergantung tabel mana
// yang dibaca, dan kalibrasi Stage 4.5 akan menimbang bucket yang salah.
describe("scoreBucketSqlCase", () => {
  it("encodes the SAME thresholds that scoreBucket() uses", () => {
    const sql = scoreBucketSqlCase("ranking_score");
    expect(sql).toContain(`ranking_score >= ${SCORE_BUCKET_HIGH_MIN}`);
    expect(sql).toContain(`ranking_score >= ${SCORE_BUCKET_MID_MIN}`);
    // Label WAJIB cocok dengan angkanya -- label yang mengkodekan 40/55
    // sementara ambangnya sudah bergeser adalah output yang berbohong.
    expect(SCORE_BUCKET_MID_MIN).toBe(40);
    expect(SCORE_BUCKET_HIGH_MIN).toBe(55);
    expect(scoreBucket(SCORE_BUCKET_HIGH_MIN)).toBe("gte_55");
    expect(scoreBucket(SCORE_BUCKET_MID_MIN)).toBe("40_50");
    expect(scoreBucket(SCORE_BUCKET_MID_MIN - 0.01)).toBe("lt_40");
  });

  it("emits every bucket label exactly once, in descending threshold order", () => {
    const sql = scoreBucketSqlCase();
    for (const label of SCORE_BUCKETS) {
      expect(sql.split(label)).toHaveLength(2);
    }
    expect(sql.indexOf("gte_55")).toBeLessThan(sql.indexOf("50_55"));
  });

  it("rejects a column name that is not a plain identifier", () => {
    expect(() => scoreBucketSqlCase("ranking_score; DROP TABLE x")).toThrow(/tidak valid/);
    expect(() => scoreBucketSqlCase("")).toThrow(/tidak valid/);
  });
});
