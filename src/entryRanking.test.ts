import { describe, it, expect } from "vitest";
import { rankEntryCandidates, DEFAULT_ENTRY_TOP_N, type EntryRankingInput } from "./entryRanking.js";

function mk(symbol: string, quoteVolumeUsd: number, fundingAbs: number, priceChangePct: number): EntryRankingInput {
  return { symbol, quoteVolumeUsd, fundingAbs, priceChangePct24h: priceChangePct };
}

describe("rankEntryCandidates (F3 cheap grid score)", () => {
  it("drops a pair from the top-N when |priceChange24h| exceeds the per-tick p90 threshold", () => {
    // Realistic spread: 20 pairs with |pc| ramping 0.5%..4.3%, funding varied,
    // volume varied + 1 blow-off at 80%. p90(|pc|) lands ~4% so the blow-off's
    // move factor clamps to 0 -> excluded despite huge volume.
    const bg = Array.from({ length: 20 }, (_, i) =>
      mk(`C${String(i).padStart(2, "0")}`, 5e8 + i * 5e7, 0.00003 + i * 2e-5, 0.5 + i * 0.2),
    );
    const input = [...bg, mk("BLOWOFF", 9e8, 0.00003, 80)];
    const ranked = rankEntryCandidates(input, 10);
    expect(ranked).not.toContain("BLOWOFF");
  });

  it("drops a pair from the top-N when |funding| exceeds the per-tick p90 threshold", () => {
    const bg = Array.from({ length: 20 }, (_, i) =>
      mk(`C${String(i).padStart(2, "0")}`, 5e8 + i * 5e7, 0.00003 + i * 3e-5, 2 + i * 0.1),
    );
    const input = [...bg, mk("FUNDY", 9e8, 0.02, 2)];
    const ranked = rankEntryCandidates(input, 10);
    expect(ranked).not.toContain("FUNDY");
  });

  it("keeps the liquid majors (high volume, low move, low funding) in the top-N -- the F1 regression", () => {
    // Majors: huge volume, tame move + funding. Alts: smaller volume, hotter.
    const majors = [
      mk("BTCUSDT", 13e9, 0.00005, 0.3),
      mk("ETHUSDT", 6e9, 0.00006, 1.1),
      mk("SOLUSDT", 4e9, 0.0001, 2.4),
      mk("BNBUSDT", 1e9, 0.00004, 0.8),
    ];
    const alts = Array.from({ length: 40 }, (_, i) =>
      mk(`ALT${i}`, 20e6 + i * 1e6, 0.0004 + i * 1e-5, 6 + i * 0.3),
    );
    const ranked = rankEntryCandidates([...alts, ...majors], 10);
    for (const m of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"]) {
      expect(ranked).toContain(m);
    }
  });

  it("uses the sign-agnostic magnitude of priceChange", () => {
    const base = Array.from({ length: 8 }, (_, i) => mk(`C${i}`, 1e9, 0.00001, 0.5 + i * 0.1));
    const dump = mk("DUMP", 1e9, 0.00001, -30);
    const pump = mk("PUMP", 1e9, 0.00001, 30);
    const ranked = rankEntryCandidates([...base, dump, pump], 8);
    expect(ranked).not.toContain("DUMP");
    expect(ranked).not.toContain("PUMP");
  });

  it("returns every candidate when N exceeds the list size", () => {
    const ranked = rankEntryCandidates([mk("A", 1e9, 0.001, 1), mk("B", 2e9, 0.002, 2)], 40);
    expect(ranked).toHaveLength(2);
  });

  it("is deterministic and total-orders ties by symbol ascending", () => {
    const input = [
      mk("BBB", 1e9, 0.0001, 1),
      mk("AAA", 1e9, 0.0001, 1),
      mk("CCC", 1e9, 0.0001, 1),
    ];
    expect(rankEntryCandidates(input, 3)).toEqual(rankEntryCandidates(input, 3));
    expect(rankEntryCandidates(input, 2)).toEqual(["AAA", "BBB"]);
  });

  it("handles an empty list and a single-item list", () => {
    expect(rankEntryCandidates([], 10)).toEqual([]);
    expect(rankEntryCandidates([mk("ONLY", 1e9, 0.0001, 1)], 10)).toEqual(["ONLY"]);
  });

  it("exposes a conservative default N", () => {
    expect(DEFAULT_ENTRY_TOP_N).toBe(40);
  });
});
