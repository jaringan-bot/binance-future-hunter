import { describe, it, expect } from "vitest";
import { selectEntryCandidates, rankEntryCandidates, DEFAULT_ENTRY_TOP_N, type EntryRankingInput } from "./entryRanking.js";

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

// ─────────────────────────────────────────────────────────────
// G6 (2026-09-04, Stage 2) -- kuota hybrid grid vs extremity.
// ─────────────────────────────────────────────────────────────
describe("selectEntryCandidates (G6 hybrid quota)", () => {
  // 20 pair likuid & tenang + 4 pair likuid tapi bergerak/funding ekstrem.
  function universe(): EntryRankingInput[] {
    const calm = Array.from({ length: 20 }, (_, i) => ({
      symbol: `CALM${String(i).padStart(2, "0")}USDT`,
      quoteVolumeUsd: 500_000_000 - i * 1_000_000,
      fundingAbs: 0.00001,
      priceChangePct24h: 0.1,
    }));
    const wild = [
      { symbol: "WILD1USDT", quoteVolumeUsd: 400_000_000, fundingAbs: 0.0009, priceChangePct24h: 18 },
      { symbol: "WILD2USDT", quoteVolumeUsd: 380_000_000, fundingAbs: 0.0008, priceChangePct24h: -16 },
      { symbol: "WILD3USDT", quoteVolumeUsd: 360_000_000, fundingAbs: 0.0007, priceChangePct24h: 14 },
      { symbol: "WILD4USDT", quoteVolumeUsd: 340_000_000, fundingAbs: 0.0006, priceChangePct24h: -12 },
    ];
    return [...calm, ...wild];
  }

  it("keeps the total EXACTLY n -- Phase 2 cost must not change", () => {
    const { selected } = selectEntryCandidates(universe(), 12, 0.25);
    expect(selected).toHaveLength(12);
    expect(new Set(selected).size).toBe(12); // no duplicates
  });

  it("REGRESSION: pure F3 discards every extreme pair; the hybrid keeps some", () => {
    const uni = universe();
    // Perilaku lama: F3 murni.
    const f3Only = rankEntryCandidates(uni, 12);
    expect(f3Only.some((s) => s.startsWith("WILD"))).toBe(false);

    // Perilaku baru: head DCA/Traditional akhirnya kebagian kandidatnya.
    const { selected, extremityPicks } = selectEntryCandidates(uni, 12, 0.25);
    expect(extremityPicks.length).toBeGreaterThan(0);
    expect(selected.some((s) => s.startsWith("WILD"))).toBe(true);
  });

  it("grid still gets the majority of the quota", () => {
    const { gridPicks, extremityPicks } = selectEntryCandidates(universe(), 12, 0.25);
    expect(gridPicks).toHaveLength(9);
    expect(extremityPicks).toHaveLength(3);
    expect(gridPicks.every((s) => s.startsWith("CALM"))).toBe(true);
  });

  it("fraction 0 reproduces the old pure-F3 behaviour exactly", () => {
    const uni = universe();
    const { selected } = selectEntryCandidates(uni, 12, 0);
    expect(selected).toEqual(rankEntryCandidates(uni, 12));
  });

  it("backfills from F3 when the market is too flat to fill the extremity quota", () => {
    // Semua pair identik -> tidak ada extremity nyata; total harus tetap n.
    const flat = Array.from({ length: 10 }, (_, i) => ({
      symbol: `FLAT${i}USDT`,
      quoteVolumeUsd: 100_000_000,
      fundingAbs: 0,
      priceChangePct24h: 0,
    }));
    const { selected } = selectEntryCandidates(flat, 6, 0.25);
    expect(selected).toHaveLength(6);
    expect(new Set(selected).size).toBe(6);
  });
});
