import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KlineTuple } from "../binanceProxyClient.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";
import { backfillPipelineDecisionOutcomes } from "./pipelineDecisionOutcomeCron.js";

vi.mock("../binanceProxyClient.js", () => ({
  getKlinesNative: vi.fn(),
}));
vi.mock("../d1Client.js", () => ({
  queryPendingPipelineDecisionOutcomes: vi.fn(),
  updatePipelineDecisionOutcome: vi.fn(),
}));

// [openTime, open, high, low, close, ...] -- `open` SENGAJA berbeda dari
// `close` supaya test benar-benar menguji bahwa entry diambil dari OPEN
// (tanpa look-ahead), bukan close. Fixture lama memakai open === close,
// jadi perbedaan itu tak terlihat.
function candle(open: number, close: number, low: number): KlineTuple {
  return [0, String(open), String(open + 1), String(low), String(close), "1", 1, "1", 1, "1", "1", "0"];
}

// B1/B2 (2026-09-04): window forward sekarang candle 5m, bukan 1h.
// 289 candle = 24 jam + 1 candle acuan. Candle i: open = 100 + i,
// close = open + 0.5, low = open - 1.
const FULL_WINDOW = 289;
function fullWindowCandles(): KlineTuple[] {
  return Array.from({ length: FULL_WINDOW }, (_, i) => candle(100 + i, 100 + i + 0.5, 100 + i - 1));
}

describe("backfillPipelineDecisionOutcomes", () => {
  beforeEach(() => {
    vi.mocked(binanceProxy.getKlinesNative).mockReset();
    vi.mocked(d1Client.queryPendingPipelineDecisionOutcomes).mockReset();
    vi.mocked(d1Client.updatePipelineDecisionOutcome).mockReset();
  });

  it("does nothing when there are no pending rows", async () => {
    vi.mocked(d1Client.queryPendingPipelineDecisionOutcomes).mockResolvedValue([]);
    const result = await backfillPipelineDecisionOutcomes(2_000_000);
    expect(result).toEqual({ attempted: 0, updated: 0 });
    expect(d1Client.updatePipelineDecisionOutcome).not.toHaveBeenCalled();
  });

  it("computes 1h/4h/24h forward return + SL-touch from ONE 5m-window fetch and persists it", async () => {
    vi.mocked(d1Client.queryPendingPipelineDecisionOutcomes).mockResolvedValue([
      { id: 42, runAt: 1_000_000, symbol: "BTCUSDT", stopLoss: 90 },
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue(fullWindowCandles());

    const result = await backfillPipelineDecisionOutcomes(2_000_000);

    expect(result).toEqual({ attempted: 1, updated: 1 });
    expect(binanceProxy.getKlinesNative).toHaveBeenCalledTimes(1); // one fetch, not three
    expect(binanceProxy.getKlinesNative).toHaveBeenCalledWith("BTCUSDT", "5m", FULL_WINDOW, 1_000_000, expect.any(Number));

    // entry = OPEN candle ke-0 = 100 (bukan close-nya, 100.5).
    // 1h  -> close candle ke-12  = 112.5
    // 4h  -> close candle ke-48  = 148.5
    // 24h -> close candle ke-288 = 388.5
    expect(d1Client.updatePipelineDecisionOutcome).toHaveBeenCalledWith(42, {
      forwardReturn1h: (112.5 - 100) / 100,
      forwardReturn4h: (148.5 - 100) / 100,
      forwardReturn24h: (388.5 - 100) / 100,
      slTouched24h: false, // low terendah 99, masih di atas stopLoss=90
    });
  });

  // REGRESSION GUARD B1 (2026-09-04). Window 1h DULU selalu menghasilkan
  // return 0 persis: `getKlinesNative(sym,"1h",2,runAt,runAt+1h)` dengan
  // runAt di menit :07 cuma mengembalikan SATU candle, lalu entry dan exit
  // dibaca dari candle yang sama. Setelah biaya eksekusi, setiap baris jadi
  // -0.12% dan win rate 0% -- backtest tidak pernah mengukur apa pun.
  it("produces a NON-zero, distinct 1h forward return (the old 1h window was always exactly 0)", async () => {
    vi.mocked(d1Client.queryPendingPipelineDecisionOutcomes).mockResolvedValue([
      { id: 7, runAt: 1_000_000, symbol: "BTCUSDT", stopLoss: null },
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue(fullWindowCandles());

    await backfillPipelineDecisionOutcomes(2_000_000);

    const persisted = vi.mocked(d1Client.updatePipelineDecisionOutcome).mock.calls[0][1];
    expect(persisted.forwardReturn1h).not.toBe(0);
    expect(persisted.forwardReturn1h).not.toBe(persisted.forwardReturn4h);
    expect(persisted.forwardReturn4h).not.toBe(persisted.forwardReturn24h);
  });

  it("skips a row (leaves it pending) when the klines fetch fails, without throwing", async () => {
    vi.mocked(d1Client.queryPendingPipelineDecisionOutcomes).mockResolvedValue([
      { id: 1, runAt: 1_000_000, symbol: "DELISTEDUSDT", stopLoss: null },
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockRejectedValue(new Error("Invalid symbol"));

    const result = await backfillPipelineDecisionOutcomes(2_000_000);
    expect(result).toEqual({ attempted: 1, updated: 0 });
    expect(d1Client.updatePipelineDecisionOutcome).not.toHaveBeenCalled();
  });

  it("skips a row (leaves it pending) when fewer than a full 5m window comes back", async () => {
    vi.mocked(d1Client.queryPendingPipelineDecisionOutcomes).mockResolvedValue([
      { id: 1, runAt: 1_000_000, symbol: "NEWUSDT", stopLoss: null },
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue(fullWindowCandles().slice(0, 10)); // gap/new listing

    const result = await backfillPipelineDecisionOutcomes(2_000_000);
    expect(result).toEqual({ attempted: 1, updated: 0 });
    expect(d1Client.updatePipelineDecisionOutcome).not.toHaveBeenCalled();
  });

  it("processes multiple pending rows independently", async () => {
    vi.mocked(d1Client.queryPendingPipelineDecisionOutcomes).mockResolvedValue([
      { id: 1, runAt: 1_000_000, symbol: "BTCUSDT", stopLoss: null },
      { id: 2, runAt: 1_100_000, symbol: "ETHUSDT", stopLoss: null },
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue(fullWindowCandles());

    const result = await backfillPipelineDecisionOutcomes(2_000_000);
    expect(result).toEqual({ attempted: 2, updated: 2 });
    expect(d1Client.updatePipelineDecisionOutcome).toHaveBeenCalledTimes(2);
  });
});
