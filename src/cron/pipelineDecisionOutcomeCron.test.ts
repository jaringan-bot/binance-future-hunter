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

function candle(close: number, low: number): KlineTuple {
  return [0, String(close), String(close + 1), String(low), String(close), "1", 1, "1", 1, "1", "1", "0"];
}

// 25 candles closing steadily higher: candle i has close = 100 + i, low = close - 1.
function fullWindowCandles(): KlineTuple[] {
  return Array.from({ length: 25 }, (_, i) => candle(100 + i, 100 + i - 1));
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

  it("computes 1h/4h/24h forward return + SL-touch from ONE 25-candle fetch and persists it", async () => {
    vi.mocked(d1Client.queryPendingPipelineDecisionOutcomes).mockResolvedValue([
      { id: 42, runAt: 1_000_000, symbol: "BTCUSDT", stopLoss: 90 },
    ]);
    vi.mocked(binanceProxy.getKlinesNative).mockResolvedValue(fullWindowCandles());

    const result = await backfillPipelineDecisionOutcomes(2_000_000);

    expect(result).toEqual({ attempted: 1, updated: 1 });
    expect(binanceProxy.getKlinesNative).toHaveBeenCalledTimes(1); // one fetch, not three
    expect(binanceProxy.getKlinesNative).toHaveBeenCalledWith("BTCUSDT", "1h", 25, 1_000_000, expect.any(Number));

    expect(d1Client.updatePipelineDecisionOutcome).toHaveBeenCalledWith(42, {
      forwardReturn1h: (101 - 100) / 100,
      forwardReturn4h: (104 - 100) / 100,
      forwardReturn24h: (124 - 100) / 100,
      slTouched24h: false, // lows range 99..123, all above stopLoss=90
    });
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

  it("skips a row (leaves it pending) when fewer than 25 candles come back", async () => {
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
