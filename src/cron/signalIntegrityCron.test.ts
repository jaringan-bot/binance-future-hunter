import { describe, it, expect, vi, beforeEach } from "vitest";
import * as d1Client from "../d1Client.js";
import * as kvConfig from "../kvConfig.js";
import * as notify from "../notify.js";
import {
  checkOutcomeBackfillHealth,
  checkScoreDiscriminatingPower,
  SIGNAL_INTEGRITY_COOLDOWN_MS,
  MATURED_AFTER_MS,
  MAX_OUTCOME_ATTEMPTS,
} from "./signalIntegrityCron.js";
import { SCORE_BUCKETS } from "../pipelineDecisionLog.js";
import type { PipelineDecisionAggregateGroup } from "../d1Client.js";

vi.mock("../d1Client.js", () => ({
  queryOutcomeBackfillHealth: vi.fn(),
  queryPipelineDecisionAggregates: vi.fn(),
}));
vi.mock("../kvConfig.js", () => ({ getJson: vi.fn(), putJson: vi.fn() }));
vi.mock("../notify.js", () => ({ dispatchNotification: vi.fn() }));

const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" };
const NOW = 1_800_000_000_000;

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

beforeEach(() => {
  vi.mocked(d1Client.queryOutcomeBackfillHealth).mockReset();
  vi.mocked(d1Client.queryPipelineDecisionAggregates).mockReset();
  vi.mocked(kvConfig.getJson).mockReset().mockResolvedValue(null);
  vi.mocked(kvConfig.putJson).mockReset().mockResolvedValue(undefined);
  vi.mocked(notify.dispatchNotification).mockReset().mockResolvedValue(undefined);
});

describe("checkOutcomeBackfillHealth", () => {
  it("mengirim notifikasi dan mencatat cooldown saat backfill macet", async () => {
    vi.mocked(d1Client.queryOutcomeBackfillHealth).mockResolvedValue({
      pendingMatured: 5000,
      recentBackfilled: 100,
      recentGridNull: 5,
    });

    await checkOutcomeBackfillHealth(env, NOW);

    expect(notify.dispatchNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify.dispatchNotification).mock.calls[0][1]).toMatch(/STALLED/);
    expect(kvConfig.putJson).toHaveBeenCalledWith("signal_integrity:backfill", { at: NOW }, expect.anything());
  });

  it("meneruskan ambang kematangan dan batas percobaan yang benar ke query", async () => {
    // Kalau MATURED_AFTER_MS di sini menyimpang dari READY_AFTER_MS milik
    // cron backfill, monitor akan menghitung baris yang BELUM waktunya
    // sebagai backlog dan berteriak palsu tiap hari.
    vi.mocked(d1Client.queryOutcomeBackfillHealth).mockResolvedValue({
      pendingMatured: 0,
      recentBackfilled: 1000,
      recentGridNull: 10,
    });

    await checkOutcomeBackfillHealth(env, NOW);

    expect(d1Client.queryOutcomeBackfillHealth).toHaveBeenCalledWith(
      expect.objectContaining({ maturedBefore: NOW - MATURED_AFTER_MS, maxAttempts: MAX_OUTCOME_ATTEMPTS }),
    );
  });

  it("DIAM saat sehat", async () => {
    vi.mocked(d1Client.queryOutcomeBackfillHealth).mockResolvedValue({
      pendingMatured: 2,
      recentBackfilled: 1000,
      recentGridNull: 40,
    });

    await checkOutcomeBackfillHealth(env, NOW);

    expect(notify.dispatchNotification).not.toHaveBeenCalled();
    expect(kvConfig.putJson).not.toHaveBeenCalled();
  });

  it("menahan notifikasi kedua di dalam cooldown, TAPI tetap menjalankan query", async () => {
    vi.mocked(d1Client.queryOutcomeBackfillHealth).mockResolvedValue({
      pendingMatured: 5000,
      recentBackfilled: 100,
      recentGridNull: 5,
    });
    vi.mocked(kvConfig.getJson).mockResolvedValue({ at: NOW - SIGNAL_INTEGRITY_COOLDOWN_MS + 1 });

    await checkOutcomeBackfillHealth(env, NOW);

    // Cooldown menahan PESAN, bukan pemeriksaan -- verdict tetap masuk log.
    expect(d1Client.queryOutcomeBackfillHealth).toHaveBeenCalledTimes(1);
    expect(notify.dispatchNotification).not.toHaveBeenCalled();
  });

  it("mengirim lagi setelah cooldown lewat", async () => {
    vi.mocked(d1Client.queryOutcomeBackfillHealth).mockResolvedValue({
      pendingMatured: 5000,
      recentBackfilled: 100,
      recentGridNull: 5,
    });
    vi.mocked(kvConfig.getJson).mockResolvedValue({ at: NOW - SIGNAL_INTEGRITY_COOLDOWN_MS - 1 });

    await checkOutcomeBackfillHealth(env, NOW);

    expect(notify.dispatchNotification).toHaveBeenCalledTimes(1);
  });
});

describe("checkScoreDiscriminatingPower", () => {
  const [lt40, mid, dispatch, high] = SCORE_BUCKETS;

  function mockAggregates(groups: PipelineDecisionAggregateGroup[]) {
    vi.mocked(d1Client.queryPipelineDecisionAggregates).mockResolvedValue({
      rowsInRange: 0,
      rowsWithOutcome: 0,
      oldestRunAt: null,
      newestRunAt: null,
      byDecision: [],
      byScoreBucket: groups,
    });
  }

  it("berteriak saat skor TERBALIK, dengan header yang membedakannya", async () => {
    mockAggregates([grp(lt40, 5000, 100), grp(mid, 1000, 20), grp(dispatch, 500, 40), grp(high, 100, 8)]);

    await checkScoreDiscriminatingPower(env, NOW);

    const msg = vi.mocked(notify.dispatchNotification).mock.calls[0][1];
    expect(msg).toMatch(/TERBALIK/);
    // Pesannya WAJIB menyatakan ini laporan, bukan tindakan -- keputusan
    // user 2026-09-05 (lapor saja).
    expect(msg).toMatch(/LAPORAN, bukan tindakan/);
  });

  it("berteriak juga saat skor tidak memisahkan apa pun", async () => {
    mockAggregates([grp(lt40, 5000, 250), grp(mid, 1000, 50), grp(dispatch, 500, 25), grp(high, 100, 5)]);

    await checkScoreDiscriminatingPower(env, NOW);

    expect(vi.mocked(notify.dispatchNotification).mock.calls[0][1]).toMatch(/tidak memisahkan/);
  });

  it("DIAM saat skor bekerja sesuai harapan", async () => {
    mockAggregates([grp(lt40, 5000, 400), grp(mid, 1000, 80), grp(dispatch, 500, 10), grp(high, 100, 2)]);

    await checkScoreDiscriminatingPower(env, NOW);

    expect(notify.dispatchNotification).not.toHaveBeenCalled();
  });

  it("DIAM saat sampel belum cukup -- hari-hari awal setelah migration 0017", async () => {
    mockAggregates([grp(lt40, 5000, 100), grp(dispatch, 3, 3)]);

    await checkScoreDiscriminatingPower(env, NOW);

    expect(notify.dispatchNotification).not.toHaveBeenCalled();
    expect(kvConfig.putJson).not.toHaveBeenCalled();
  });

  it("memakai jendela 24h dan biaya eksekusi nol", async () => {
    // Cek ini cuma membaca kolom grid; biaya eksekusi tidak relevan dan
    // memasukkannya akan menyiratkan asumsi biaya yang tidak pernah dipakai.
    mockAggregates([]);

    await checkScoreDiscriminatingPower(env, NOW);

    expect(d1Client.queryPipelineDecisionAggregates).toHaveBeenCalledWith(
      expect.objectContaining({ window: "24h", execCostRoundTrip: 0, endTime: NOW }),
    );
  });
});
