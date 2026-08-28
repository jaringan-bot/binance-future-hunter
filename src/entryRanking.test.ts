import { describe, it, expect } from "vitest";
import { rankEntryCandidates, DEFAULT_ENTRY_TOP_N, type EntryRankingInput } from "./entryRanking.js";

function mk(symbol: string, fundingAbs: number, priceChangePct: number): EntryRankingInput {
  return { symbol, fundingAbs, priceChangePct24h: priceChangePct };
}

describe("rankEntryCandidates", () => {
  it("ranks by combined percentile of |funding| and |priceChange24h|, extreme first", () => {
    const input = [
      mk("CALM", 0.00001, 0.2), // min on both axes
      mk("FUNDY", 0.0009, 5), // high funding, mid move
      mk("MOVER", 0.0002, 12), // mid funding, big move
      mk("BOTH", 0.001, 15), // max on both axes
    ];

    const ranked = rankEntryCandidates(input, 4);

    expect(ranked[0]).toBe("BOTH");
    expect(ranked[3]).toBe("CALM");
    expect(new Set(ranked)).toEqual(new Set(["CALM", "FUNDY", "MOVER", "BOTH"]));
  });

  it("keeps only the top N", () => {
    const input = Array.from({ length: 100 }, (_, i) => mk(`S${i}`, i / 100000, i));
    const ranked = rankEntryCandidates(input, 40);
    expect(ranked).toHaveLength(40);
    // Highest i = most extreme on both axes -> must be first.
    expect(ranked[0]).toBe("S99");
    expect(ranked).not.toContain("S0");
  });

  it("uses the sign-agnostic magnitude of priceChange (a -12% move ranks like +12%)", () => {
    const ranked = rankEntryCandidates(
      [mk("DUMP", 0.00001, -12), mk("FLAT", 0.00001, 0.1), mk("PUMP", 0.00001, 12)],
      2,
    );
    expect(ranked).toContain("DUMP");
    expect(ranked).toContain("PUMP");
    expect(ranked).not.toContain("FLAT");
  });

  it("returns every candidate when N exceeds the list size", () => {
    const ranked = rankEntryCandidates([mk("A", 0.001, 1), mk("B", 0.002, 2)], 40);
    expect(ranked).toHaveLength(2);
  });

  it("is deterministic and total-orders ties by symbol", () => {
    const input = [mk("BBB", 0.0001, 1), mk("AAA", 0.0001, 1), mk("CCC", 0.0001, 1)];
    expect(rankEntryCandidates(input, 3)).toEqual(rankEntryCandidates(input, 3));
    expect(rankEntryCandidates(input, 2)).toEqual(["AAA", "BBB"]);
  });

  it("exposes a conservative default N", () => {
    expect(DEFAULT_ENTRY_TOP_N).toBe(40);
  });
});
