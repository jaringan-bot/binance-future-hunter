import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KlineTuple } from "../binanceProxyClient.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";
import {
  aggregateGroupToStats,
  aggregateGroupsToStats,
  sumAggregateGroups,
  evaluateGridOutcome,
  summarizeGridOutcomes,
  gridRatesByScoreBucket,
  emptyBucket,
  evaluateDecisionForward,
  registerPipelineDecisionBacktestTools,
} from "./pipelineDecisionBacktest.js";
import { SCORE_BUCKETS, type PipelineDecisionLogRow } from "../pipelineDecisionLog.js";
import type { PipelineDecisionAggregateGroup, PipelineDecisionAggregates } from "../d1Client.js";

vi.mock("../binanceProxyClient.js", () => ({
  getKlinesNative: vi.fn(),
}));
vi.mock("../d1Client.js", () => ({
  queryPipelineDecisionLog: vi.fn(),
  queryPipelineDecisionAggregates: vi.fn(),
}));

function group(partial: Partial<PipelineDecisionAggregateGroup> & { key: string }): PipelineDecisionAggregateGroup {
  return {
    sampleSize: 0,
    winCount: 0,
    avgGrossReturn: 0,
    minGrossReturn: 0,
    maxGrossReturn: 0,
    slHits: 0,
    slKnown: 0,
    gridExited: 0,
    gridExitedBelow: 0,
    gridKnown: 0,
    avgTimeInRangePct: null,
    avgCrossingRate: null,
    ...partial,
  };
}

function aggregates(partial: Partial<PipelineDecisionAggregates> = {}): PipelineDecisionAggregates {
  return {
    rowsInRange: 0,
    rowsWithOutcome: 0,
    oldestRunAt: null,
    newestRunAt: null,
    byDecision: [],
    byScoreBucket: [],
    ...partial,
  };
}

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function candle(close: number, low: number): KlineTuple {
  return [0, String(close), String(close + 1), String(low), String(close), "1", 1, "1", 1, "1", "1", "0"];
}

describe("evaluateDecisionForward", () => {
  it("returns null for empty or invalid candles", () => {
    expect(evaluateDecisionForward([], 10)).toBeNull();
    expect(evaluateDecisionForward([candle(0, 0)], 10)).toBeNull();
  });

  it("uses first close as entry and last close as exit", () => {
    const fwd = evaluateDecisionForward([candle(100, 99), candle(104, 98)], 90);
    expect(fwd).toMatchObject({
      entryPrice: 100,
      exitPrice: 104,
      forwardReturn: 0.04,
      slTouch: false,
    });
  });

  it("flags SL-touch when a low crosses stopLoss", () => {
    const fwd = evaluateDecisionForward([candle(100, 99), candle(101, 94)], 95);
    expect(fwd?.slTouch).toBe(true);
    expect(fwd?.forwardReturn).toBeCloseTo(0.01);
  });
});

describe("aggregate group adapters (B3 / Stage 4.1)", () => {
  it("emptyBucket is the zero value", () => {
    expect(emptyBucket()).toEqual({ sampleSize: 0, winRate: 0, avgReturn: 0, slTouchRate: null, slTouchSample: 0 });
  });

  it("subtracts execution cost from the SQL gross average, not from win counting", () => {
    // SQL sudah menghitung `wins` dengan ambang gross > biaya, jadi adapter
    // TIDAK boleh mengurangi biaya lagi dari winRate -- cuma dari avgReturn.
    const stats = aggregateGroupToStats(
      group({ key: "TRADE", sampleSize: 4, winCount: 3, avgGrossReturn: 0.02, slHits: 1, slKnown: 2 }),
      0.0012,
    );
    expect(stats.sampleSize).toBe(4);
    expect(stats.winRate).toBeCloseTo(0.75, 10);
    expect(stats.avgReturn).toBeCloseTo(0.02 - 0.0012, 10);
    expect(stats.slTouchRate).toBeCloseTo(0.5, 10);
    expect(stats.slTouchSample).toBe(2);
  });

  it("reports slTouchRate null (not 0) when no row has a known SL outcome", () => {
    const stats = aggregateGroupToStats(group({ key: "WATCH", sampleSize: 3, slKnown: 0 }), 0);
    expect(stats.slTouchRate).toBeNull();
  });

  it("keys the record by group key", () => {
    const rec = aggregateGroupsToStats(
      [group({ key: "TRADE", sampleSize: 1 }), group({ key: "NO_TRADE", sampleSize: 2 })],
      0,
    );
    expect(Object.keys(rec).sort()).toEqual(["NO_TRADE", "TRADE"]);
    expect(rec.NO_TRADE.sampleSize).toBe(2);
  });

  it("sums groups with a SAMPLE-WEIGHTED mean, not a mean of means", () => {
    // Naive (0.10 + 0.00) / 2 = 0.05 akan salah; jawaban benar
    // (9*0.10 + 1*0.00) / 10 = 0.09.
    const total = sumAggregateGroups([
      group({ key: "TRADE", sampleSize: 9, winCount: 9, avgGrossReturn: 0.1, minGrossReturn: 0.05, maxGrossReturn: 0.2 }),
      group({ key: "WATCH", sampleSize: 1, winCount: 0, avgGrossReturn: 0, minGrossReturn: -0.3, maxGrossReturn: 0 }),
    ]);
    expect(total.sampleSize).toBe(10);
    expect(total.winCount).toBe(9);
    expect(total.avgGrossReturn).toBeCloseTo(0.09, 10);
    expect(total.minGrossReturn).toBeCloseTo(-0.3, 10);
    expect(total.maxGrossReturn).toBeCloseTo(0.2, 10);
  });

  it("ignores min/max of empty groups instead of dragging them to 0", () => {
    const total = sumAggregateGroups([
      group({ key: "TRADE", sampleSize: 2, avgGrossReturn: 0.1, minGrossReturn: 0.05, maxGrossReturn: 0.2 }),
      group({ key: "NO_TRADE", sampleSize: 0, minGrossReturn: 0, maxGrossReturn: 0 }),
    ]);
    expect(total.minGrossReturn).toBeCloseTo(0.05, 10);
    expect(total.maxGrossReturn).toBeCloseTo(0.2, 10);
  });

  // ── F3 (2026-09-05): metrik grid ikut diagregasi ───────────────────────
  it("menjumlah metrik grid dengan penyebutnya SENDIRI, bukan sampleSize", () => {
    // Grup A: 100 baris, tapi cuma 10 yang punya bound grid (90 NO_TRADE
    // tanpa bound -> kolom grid NULL). 5 dari 10 itu jebol.
    // Grup B: 10 baris, 10 terukur, 1 jebol.
    //
    // Jawaban BENAR: (5+1) / (10+10) = 30%.
    // Kalau penyebutnya sampleSize: 6 / 110 = 5,5% -- terlihat empat kali
    // lebih aman dari kenyataan, semata karena baris yang tidak punya grid
    // ikut dihitung sebagai "grid yang tidak jebol".
    const total = sumAggregateGroups([
      group({ key: "A", sampleSize: 100, gridExited: 5, gridExitedBelow: 4, gridKnown: 10, avgTimeInRangePct: 0.5, avgCrossingRate: 0.2 }),
      group({ key: "B", sampleSize: 10, gridExited: 1, gridExitedBelow: 1, gridKnown: 10, avgTimeInRangePct: 0.9, avgCrossingRate: 0.4 }),
    ]);
    expect(total.gridKnown).toBe(20);
    expect(total.gridExited).toBe(6);
    expect(total.gridExited / total.gridKnown).toBeCloseTo(0.3, 10);
    // Rata-rata dibobot gridKnown (10 vs 10 -> tepat di tengah), BUKAN
    // sampleSize (100 vs 10 -> akan condong ke 0,54).
    expect(total.avgTimeInRangePct).toBeCloseTo(0.7, 10);
    expect(total.avgCrossingRate).toBeCloseTo(0.3, 10);
  });

  it("melaporkan rata-rata grid null (bukan 0) saat tidak ada baris terukur", () => {
    const total = sumAggregateGroups([
      group({ key: "A", sampleSize: 50, gridKnown: 0, avgTimeInRangePct: null }),
      group({ key: "B", sampleSize: 20, gridKnown: 0, avgTimeInRangePct: null }),
    ]);
    expect(total.gridKnown).toBe(0);
    // null = tidak ada yang diukur. 0 akan terbaca "grid tidak pernah di
    // dalam range", klaim yang sama sekali berbeda.
    expect(total.avgTimeInRangePct).toBeNull();
    expect(total.avgCrossingRate).toBeNull();
  });

  it("returns zeros (not NaN) for an entirely empty set", () => {
    const total = sumAggregateGroups([]);
    expect(total).toMatchObject({ sampleSize: 0, avgGrossReturn: 0, minGrossReturn: 0, maxGrossReturn: 0 });
    expect(Number.isNaN(aggregateGroupToStats(total, 0.001).avgReturn)).toBe(false);
  });
});

// ── B4 / Stage 4.2: metrik grid-native ──────────────────────────────────
describe("evaluateGridOutcome", () => {
  // ohlc candle helper: harga sengaja dipisah supaya high/low benar-benar diuji.
  function ohlc(open: number, high: number, low: number, close: number): KlineTuple {
    return [0, String(open), String(high), String(low), String(close), "1", 1, "1", 1, "1", "1", "0"];
  }

  it("returns null when bounds are missing or degenerate", () => {
    expect(evaluateGridOutcome([ohlc(100, 101, 99, 100)], null, 110)).toBeNull();
    expect(evaluateGridOutcome([ohlc(100, 101, 99, 100)], 100, null)).toBeNull();
    expect(evaluateGridOutcome([ohlc(100, 101, 99, 100)], 110, 100)).toBeNull(); // upper <= lower
    expect(evaluateGridOutcome([], 100, 110)).toBeNull();
  });

  it("detects an upward range exit and reports time-in-range from closes", () => {
    const m = evaluateGridOutcome(
      [ohlc(105, 106, 104, 105), ohlc(105, 120, 104, 118), ohlc(118, 119, 117, 118)],
      100,
      110,
    );
    expect(m?.exitedRange).toBe(true);
    expect(m?.exitedAbove).toBe(true);
    expect(m?.exitedBelow).toBe(false);
    // hanya candle pertama yang close-nya di dalam [100, 110]
    expect(m?.candlesInRange).toBe(1);
    expect(m?.timeInRangePct).toBeCloseTo(1 / 3, 10);
  });

  it("detects a downward range exit", () => {
    const m = evaluateGridOutcome([ohlc(105, 106, 104, 105), ohlc(105, 106, 95, 98)], 100, 110);
    expect(m?.exitedBelow).toBe(true);
    expect(m?.exitedAbove).toBe(false);
    expect(m?.exitedRange).toBe(true);
  });

  // Order grid terisi di WICK, bukan di close. Candle yang menusuk upper
  // lalu balik ke dalam band SUDAH memicu jual di level teratas dan
  // meninggalkan posisi flat -- itu keluar range. Memakai `close` untuk
  // deteksi ini (mutasi yang sempat lolos suite) akan melaporkan "aman"
  // untuk candle yang sebenarnya sudah merusak grid.
  it("counts a wick that pierces the band and closes back inside as a range exit", () => {
    const above = evaluateGridOutcome([ohlc(105, 115, 104, 106)], 100, 110);
    expect(above?.exitedAbove).toBe(true);
    expect(above?.exitedRange).toBe(true);
    expect(above?.timeInRangePct).toBe(1); // close-nya memang masih di dalam

    const below = evaluateGridOutcome([ohlc(105, 106, 95, 104)], 100, 110);
    expect(below?.exitedBelow).toBe(true);
    expect(below?.exitedRange).toBe(true);
    expect(below?.timeInRangePct).toBe(1);
  });

  it("reports NO exit when price stays fully inside the band", () => {
    const m = evaluateGridOutcome([ohlc(105, 109, 101, 106), ohlc(106, 108, 102, 104)], 100, 110);
    expect(m?.exitedRange).toBe(false);
    expect(m?.timeInRangePct).toBe(1);
  });

  // Inti B4: return arah bisa MENANG sementara grid-nya justru rusak.
  it("flags a broken grid on a run that a directional return would score as a win", () => {
    const candles = [ohlc(100, 101, 99, 100), ohlc(100, 130, 100, 128), ohlc(128, 131, 127, 130)];
    const fwd = evaluateDecisionForward(candles, null);
    expect(fwd!.forwardReturn).toBeGreaterThan(0.2); // "menang" +30%
    const m = evaluateGridOutcome(candles, 100, 110);
    expect(m?.exitedAbove).toBe(true); // ...padahal grid keluar range ke atas
    expect(m?.timeInRangePct).toBeLessThan(0.5);
  });

  it("reconstructs gridCount/gridType from the bounds it was given", () => {
    // range 10% -> ARITHMETIC (<= 20%), gridCount = round(10 / 0.75) = 13
    const narrow = evaluateGridOutcome([ohlc(105, 106, 104, 105)], 100, 110);
    expect(narrow?.gridType).toBe("ARITHMETIC");
    expect(narrow?.gridCount).toBe(13);
    // range 50% -> GEOMETRIC (> 20%)
    const wide = evaluateGridOutcome([ohlc(120, 121, 119, 120)], 100, 150);
    expect(wide?.gridType).toBe("GEOMETRIC");
  });

  it("summarizes a set of outcomes and returns null on an empty set", () => {
    expect(summarizeGridOutcomes([])).toBeNull();
    const a = evaluateGridOutcome([ohlc(105, 106, 104, 105)], 100, 110)!;
    const b = evaluateGridOutcome([ohlc(105, 120, 104, 118)], 100, 110)!;
    const s = summarizeGridOutcomes([a, b])!;
    expect(s.sampleSize).toBe(2);
    expect(s.exitedRangeRate).toBeCloseTo(0.5, 10);
    expect(s.exitedAboveRate).toBeCloseTo(0.5, 10);
    expect(s.avgTimeInRangePct).toBeCloseTo(0.5, 10);
  });
});

describe("gridRatesByScoreBucket (F3 -- metrik grid dari SQL)", () => {
  it("memakai gridKnown sebagai penyebut, BUKAN sampleSize", () => {
    // Bucket dengan 1000 baris tapi hanya 100 yang punya bound grid, 50 jebol.
    // Jawaban benar 50%. Kalau penyebutnya sampleSize -> 5%, yaitu sepuluh
    // kali lebih aman dari kenyataan semata karena baris tanpa grid ikut
    // dihitung sebagai "grid yang tidak jebol".
    const r = gridRatesByScoreBucket([
      group({ key: "lt_40", sampleSize: 1000, gridKnown: 100, gridExited: 50, gridExitedBelow: 40, avgTimeInRangePct: 0.8, avgCrossingRate: 0.3 }),
    ]);
    expect(r.lt_40).toEqual({
      known: 100,
      exitedRate: 0.5,
      exitedBelowRate: 0.4,
      avgTimeInRangePct: 0.8,
      avgCrossingRate: 0.3,
    });
  });

  it("null (bukan nol) untuk bucket tanpa baris terukur maupun yang absen", () => {
    // Membedakan "tidak diukur" dari "diukur, hasilnya 0%" adalah seluruh
    // alasan kolom 0017 nullable. Nol di sini akan terbaca sebagai "grid
    // tidak pernah jebol" untuk bucket yang sebenarnya kosong.
    const r = gridRatesByScoreBucket([
      group({ key: "lt_40", sampleSize: 500, gridKnown: 0, gridExited: 0 }),
    ]);
    expect(r.lt_40).toBeNull();
    expect(r["40_50"]).toBeNull();
    expect(r["50_55"]).toBeNull();
    expect(r.gte_55).toBeNull();
  });

  it("mengembalikan SEMUA bucket, termasuk yang tidak ada di agregat", () => {
    // Bucket yang hilang dari hasil GROUP BY harus tetap muncul sebagai null,
    // supaya konsumen tidak perlu menebak apakah bucket-nya kosong atau
    // querynya yang berubah.
    const r = gridRatesByScoreBucket([group({ key: "50_55", sampleSize: 60, gridKnown: 60, gridExited: 30 })]);
    expect(Object.keys(r).sort()).toEqual([...SCORE_BUCKETS].sort());
    expect(r["50_55"]?.exitedRate).toBeCloseTo(0.5, 10);
    expect(r.lt_40).toBeNull();
  });
});

function logRow(partial: Partial<PipelineDecisionLogRow> = {}): PipelineDecisionLogRow {
  return {
    runAt: Date.parse("2026-08-20T00:00:00Z"),
    symbol: "BTCUSDT",
    source: "entry_alert",
    sourceRef: null,
    decision: "TRADE",
    rankingScore: 60,
    mmComponent: 55,
    mmAdverseComponent: 20,
    smartMoneyComponent: 50,
    regimeComponent: 60,
    buyPressureComponent: 45,
    hardScreenPassed: true,
    hardScreenReasons: [],
    quoteVolumeUsd: 9_000_000,
    fundingRate: 0.0001,
    regime1h: "RANGING",
    regime4h: "RANGING",
    gridRiskStatus: "SAFE",
    lowerPrice: 100,
    upperPrice: 110,
    stopLoss: 95,
    ...partial,
  };
}

describe("whalescope_backtest_pipeline_decisions tool handler", () => {
  let handler: ToolHandler;
  let inputSchema: Record<string, z.ZodTypeAny>;

  beforeEach(() => {
    vi.clearAllMocks();
    const fakeServer = {
      registerTool: (_name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        inputSchema = config.inputSchema ?? {};
        handler = cb as ToolHandler;
        return {};
      },
    } as unknown as McpServer;
    registerPipelineDecisionBacktestTools(fakeServer);
  });

  it("returns a friendly empty message when D1 has no rows in range", async () => {
    vi.mocked(d1Client.queryPipelineDecisionAggregates).mockResolvedValue(aggregates({ rowsInRange: 0 }));
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([]);
    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
    });
    const result = await handler(args);
    expect(result.content[0].text).toContain("Tidak ada row");
    expect(binanceProxy.getKlinesNative).not.toHaveBeenCalled();
  });

  // ── B3 REGRESSION GUARD (Stage 4.1) ───────────────────────────────────
  // CACAT LAMA: agregat dihitung di TypeScript atas <= 80 baris yang
  // di-fetch, jadi "backtest 30 hari" sebenarnya cuma melihat satu-dua tick
  // (~20 menit). Diverifikasi pada data live 2026-09-04: rentang 9 jam
  // mengembalikan 50 baris ber-run_at IDENTIK. Test ini mengunci bahwa
  // agregat datang dari SQL atas SELURUH rentang, bukan dari sampel detail.
  it("takes aggregates from SQL over the whole range, NOT from the fetched detail sample", async () => {
    vi.mocked(d1Client.queryPipelineDecisionAggregates).mockResolvedValue(
      aggregates({
        rowsInRange: 3840,
        rowsWithOutcome: 3600,
        byDecision: [
          group({ key: "TRADE", sampleSize: 120, winCount: 66, avgGrossReturn: 0.012, slHits: 10, slKnown: 100 }),
          group({ key: "WATCH", sampleSize: 3480, winCount: 1044, avgGrossReturn: -0.001, slHits: 300, slKnown: 3000 }),
        ],
        byScoreBucket: [
          group({ key: "gte_55", sampleSize: 120, winCount: 66, avgGrossReturn: 0.012 }),
          group({ key: "lt_40", sampleSize: 3480, winCount: 1044, avgGrossReturn: -0.001 }),
        ],
      }),
    );
    // Sampel detail cuma SATU baris -- kalau agregat masih diturunkan dari
    // sini, sampleSize-nya akan 1, bukan 3600.
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([
      logRow({ symbol: "BTCUSDT", decision: "TRADE", rankingScore: 60, stopLoss: 95 }),
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue([candle(100, 99), candle(103, 98)]);

    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
      forwardWindow: "4h",
    });
    const result = await handler(args);
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      rowsInRange: number;
      rowsWithOutcome: number;
      outcomeCoveragePct: number;
      detailSampleSize: number;
      overall: { sampleSize: number; winRate: number };
      byDecision: Record<string, { sampleSize: number; winRate: number }>;
      byScoreBucket: Record<string, { sampleSize: number }>;
    };

    expect(structured.rowsInRange).toBe(3840);
    expect(structured.rowsWithOutcome).toBe(3600);
    expect(structured.outcomeCoveragePct).toBeCloseTo((3600 / 3840) * 100, 6);
    expect(structured.detailSampleSize).toBe(1); // sampel detail TETAP kecil
    expect(structured.overall.sampleSize).toBe(3600); // ...agregatnya tidak
    expect(structured.byDecision.TRADE.sampleSize).toBe(120);
    expect(structured.byDecision.TRADE.winRate).toBeCloseTo(66 / 120, 10);
    expect(structured.byScoreBucket.gte_55.sampleSize).toBe(120);
    // Satu fetch untuk satu baris detail -- agregat NOL fetch klines.
    expect(binanceProxy.getKlinesNative).toHaveBeenCalledTimes(1);
  });

  it("passes the requested forwardWindow and exec cost down to the SQL aggregate", async () => {
    vi.mocked(d1Client.queryPipelineDecisionAggregates).mockResolvedValue(aggregates({ rowsInRange: 10 }));
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([]);
    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
      forwardWindow: "24h",
      fee_bps: 10,
      slippage_bps: 5,
    });
    await handler(args);
    expect(d1Client.queryPipelineDecisionAggregates).toHaveBeenCalledWith(
      expect.objectContaining({ window: "24h", execCostRoundTrip: 0.003 }),
    );
  });

  it("reports grid-native metrics from the detail sample", async () => {
    vi.mocked(d1Client.queryPipelineDecisionAggregates).mockResolvedValue(
      aggregates({ rowsInRange: 2, rowsWithOutcome: 2, byDecision: [group({ key: "TRADE", sampleSize: 2 })] }),
    );
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([
      logRow({ symbol: "BTCUSDT", lowerPrice: 100, upperPrice: 110, stopLoss: 95 }),
    ]);
    // candle kedua high 131 menembus upper 110 -> keluar range ke atas
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue([candle(105, 104), candle(130, 104)]);

    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
      forwardWindow: "4h",
    });
    const result = await handler(args);
    const structured = result.structuredContent as {
      gridOutcomeSummary: { sampleSize: number; exitedRangeRate: number; exitedAboveRate: number } | null;
      rows: { gridOutcome: { exitedAbove: boolean } | null }[];
    };
    expect(structured.gridOutcomeSummary?.sampleSize).toBe(1);
    expect(structured.gridOutcomeSummary?.exitedRangeRate).toBe(1);
    expect(structured.gridOutcomeSummary?.exitedAboveRate).toBe(1);
    expect(structured.rows[0].gridOutcome?.exitedAbove).toBe(true);
  });

  it("leaves gridOutcome null when the logged row has no bounds", async () => {
    vi.mocked(d1Client.queryPipelineDecisionAggregates).mockResolvedValue(
      aggregates({ rowsInRange: 1, rowsWithOutcome: 1, byDecision: [group({ key: "NO_TRADE", sampleSize: 1 })] }),
    );
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([
      logRow({ symbol: "BTCUSDT", lowerPrice: null, upperPrice: null, stopLoss: null }),
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue([candle(100, 99), candle(103, 98)]);

    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
    });
    const result = await handler(args);
    const structured = result.structuredContent as {
      gridOutcomeSummary: unknown;
      rows: { gridOutcome: unknown }[];
    };
    expect(structured.rows[0].gridOutcome).toBeNull();
    expect(structured.gridOutcomeSummary).toBeNull();
  });

  it("applies fee_bps + slippage_bps to forward returns before aggregating", async () => {
    // winCount 0: SQL sudah menerapkan ambang `gross > biaya` (30bps gross
    // < 50bps biaya), jadi agregat memang harus melaporkan 0 win.
    vi.mocked(d1Client.queryPipelineDecisionAggregates).mockResolvedValue(
      aggregates({
        rowsInRange: 1,
        rowsWithOutcome: 1,
        byDecision: [group({ key: "TRADE", sampleSize: 1, winCount: 0, avgGrossReturn: 0.003 })],
      }),
    );
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([
      logRow({ symbol: "BTCUSDT", decision: "TRADE", rankingScore: 60, stopLoss: 95 }),
    ]);
    // gross forward return = (100.3 - 100) / 100 = +0.003 (+30 bps)
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue([candle(100, 99), candle(100.3, 99)]);

    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
      forwardWindow: "4h",
      fee_bps: 20,
      slippage_bps: 5,
    });
    const result = await handler(args);
    const structured = result.structuredContent as {
      feeBps: number;
      slippageBps: number;
      execCostRoundTrip: number;
      overall: { winRate: number; avgReturn: number };
      byDecision: Record<string, { winRate: number }>;
      rows: { grossReturn: number; forwardReturn: number }[];
    };

    // round-trip cost = 2 * (20 + 5) / 10000 = 0.005 (50 bps) > 30 bps gross
    expect(structured.feeBps).toBe(20);
    expect(structured.slippageBps).toBe(5);
    expect(structured.execCostRoundTrip).toBeCloseTo(0.005, 10);
    expect(structured.rows[0].grossReturn).toBeCloseTo(0.003, 10);
    expect(structured.rows[0].forwardReturn).toBeCloseTo(0.003 - 0.005, 10);
    // gross win flips to a net loss
    expect(structured.overall.winRate).toBe(0);
    expect(structured.byDecision.TRADE.winRate).toBe(0);
  });

  it("defaults fee/slippage to the Binance-taker approximation", async () => {
    vi.mocked(d1Client.queryPipelineDecisionAggregates).mockResolvedValue(
      aggregates({ rowsInRange: 1, rowsWithOutcome: 1, byDecision: [group({ key: "TRADE", sampleSize: 1 })] }),
    );
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([
      logRow({ symbol: "BTCUSDT", decision: "TRADE", rankingScore: 60, stopLoss: 95 }),
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue([candle(100, 99), candle(105, 99)]);

    const args = z.object(inputSchema).parse({
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-31T00:00:00Z",
    });
    const result = await handler(args);
    const structured = result.structuredContent as { execCostRoundTrip: number; rows: { forwardReturn: number }[] };
    // default = 2 * (4 + 2) / 10000 = 0.0012
    expect(structured.execCostRoundTrip).toBeCloseTo(0.0012, 10);
    expect(structured.rows[0].forwardReturn).toBeCloseTo(0.05 - 0.0012, 10);
  });
});
