import { describe, it, expect } from "vitest";
import {
  sigmoid,
  mean,
  stddev,
  standardizeColumns,
  fitLogisticRegression,
  rawSpaceCoefficients,
  normalizeWeights,
  rankAuc,
  winRateAtTopFraction,
  weightedScore,
  unwrapDataset,
  parseDataset,
  calibrate,
  assertSingleMmSemantics,
  EXISTING_WEIGHTS,
  FEATURE_KEYS,
} from "./calibrate-ranking-weights.mjs";

describe("sigmoid", () => {
  it("is 0.5 at 0 and monotonic / bounded", () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10);
    expect(sigmoid(50)).toBeGreaterThan(0.999);
    expect(sigmoid(-50)).toBeLessThan(0.001);
    expect(sigmoid(2)).toBeGreaterThan(sigmoid(1));
  });
});

describe("mean / stddev", () => {
  it("computes population stats", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(stddev([2, 2, 2])).toBe(0);
    expect(stddev([0, 2])).toBeCloseTo(1, 10);
  });
});

describe("standardizeColumns", () => {
  it("z-scores each column and leaves zero-variance columns at 0", () => {
    const { z, stats } = standardizeColumns([
      [0, 5],
      [2, 5],
    ]);
    expect(stats[0].std).toBeCloseTo(1, 10);
    expect(stats[1].std).toBe(0);
    expect(z[0][0]).toBeCloseTo(-1, 10);
    expect(z[1][0]).toBeCloseTo(1, 10);
    expect(z[0][1]).toBe(0);
  });
});

describe("fitLogisticRegression", () => {
  it("recovers a positive coefficient on a linearly separable feature", () => {
    // fitur tunggal: negatif -> label 0, positif -> label 1
    const X = [];
    const y = [];
    for (let i = -20; i <= 20; i++) {
      if (i === 0) continue;
      X.push([i / 10]);
      y.push(i > 0 ? 1 : 0);
    }
    const { weights, intercept } = fitLogisticRegression(X, y, { iterations: 3000, lr: 0.5 });
    expect(weights[0]).toBeGreaterThan(1);
    expect(Math.abs(intercept)).toBeLessThan(0.5);
  });

  it("throws on an empty dataset", () => {
    expect(() => fitLogisticRegression([], [])).toThrow();
  });
});

describe("rawSpaceCoefficients", () => {
  it("divides standardized weights by column std", () => {
    const raw = rawSpaceCoefficients([2, 0.5], [{ std: 4 }, { std: 0 }]);
    expect(raw[0]).toBeCloseTo(0.5, 10);
    expect(raw[1]).toBe(0);
  });
});

describe("normalizeWeights", () => {
  it("clamps negatives to zero, normalizes to sum 1, flags negatives", () => {
    const { weights, negativeFlags, degenerate } = normalizeWeights([3, 1, -2, 0]);
    expect(weights[0]).toBeCloseTo(0.75, 10);
    expect(weights[1]).toBeCloseTo(0.25, 10);
    expect(weights[2]).toBe(0);
    expect(negativeFlags).toEqual([false, false, true, false]);
    expect(degenerate).toBe(false);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("falls back to an even split when every coefficient is non-positive", () => {
    const { weights, degenerate } = normalizeWeights([-1, -2, 0, -0.5]);
    expect(degenerate).toBe(true);
    expect(weights).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});

describe("rankAuc", () => {
  it("is 1.0 for a perfectly separating score and 0.5 for ties", () => {
    expect(rankAuc([1, 2, 3, 4], [0, 0, 1, 1])).toBe(1);
    expect(rankAuc([5, 5, 5, 5], [0, 1, 0, 1])).toBe(0.5);
    expect(rankAuc([1, 2], [1, 1])).toBeNull();
  });
});

describe("winRateAtTopFraction", () => {
  it("takes the top-k by score and reports their win rate", () => {
    const r = winRateAtTopFraction([10, 8, 6, 4, 2, 1], [1, 1, 0, 0, 0, 0], 0.5);
    expect(r.k).toBe(3);
    expect(r.wins).toBe(2);
    expect(r.winRate).toBeCloseTo(2 / 3, 10);
  });
});

describe("weightedScore", () => {
  it("dots the feature row with the weight vector", () => {
    const existingVec = FEATURE_KEYS.map((k) => EXISTING_WEIGHTS[k]);
    expect(weightedScore([100, 0, 0, 0], existingVec)).toBeCloseTo(35, 10);
    expect(weightedScore([100, 100, 100, 100], existingVec)).toBeCloseTo(100, 10);
  });
});

describe("unwrapDataset", () => {
  it("unwraps `wrangler d1 execute --json` shape", () => {
    const rows = unwrapDataset([{ results: [{ a: 1 }, { a: 2 }], success: true }]);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it("accepts a plain array and a {rows:[]} object", () => {
    expect(unwrapDataset([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(unwrapDataset({ rows: [{ b: 2 }] })).toEqual([{ b: 2 }]);
  });
  it("throws on an unknown shape", () => {
    expect(() => unwrapDataset({ nope: true })).toThrow();
  });
});

describe("parseDataset", () => {
  it("reads aliased feature fields and derives a label from a return field", () => {
    const { rows, dropped, returnField } = parseDataset([
      { mm_component: 60, smart_money_component: 40, regime_component: 20, buy_pressure_component: 55, forward_return_4h: 0.02 },
      { mm_component: 10, smart_money_component: 5, regime_component: 2, buy_pressure_component: 8, forward_return_4h: -0.01 },
    ]);
    expect(dropped).toBe(0);
    expect(returnField).toBe("forward_return_4h");
    expect(rows[0].label).toBe(1);
    expect(rows[1].label).toBe(0);
    expect(rows[0].features).toEqual([60, 40, 20, 55]);
  });

  it("prefers an explicit label and drops rows with missing features", () => {
    const { rows, dropped } = parseDataset([
      { mm: 1, sm: 2, regime: 3, bp: 4, label: 1, forwardReturn: -0.5 },
      { mm: 1, sm: 2, regime: 3 /* bp missing */, label: 0 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe(1); // explicit label wins over negative return
    expect(dropped).toBe(1);
  });

  it("honours a custom label threshold", () => {
    const { rows } = parseDataset(
      [{ mm: 1, sm: 1, regime: 1, bp: 1, forwardReturn: 0.005 }],
      { labelThreshold: 0.01 },
    );
    expect(rows[0].label).toBe(0);
  });
});

// ── end-to-end: dataset di mana `mm` yang paling prediktif ──────────────
function syntheticRows(n) {
  // deterministic PRNG (mulberry32)
  let s = 0x2545f491;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rows = [];
  for (let i = 0; i < n; i++) {
    const mm = rnd() * 100;
    const smartMoney = rnd() * 100;
    const regime = rnd() * 100;
    const buyPressure = rnd() * 100;
    // label didorong KUAT oleh mm, sedikit noise
    const p = sigmoid((mm - 50) / 12 + (rnd() - 0.5) * 0.4);
    rows.push({
      mm_component: mm,
      smart_money_component: smartMoney,
      regime_component: regime,
      buy_pressure_component: buyPressure,
      forward_return_4h: p > 0.5 ? 0.01 + rnd() * 0.02 : -0.01 - rnd() * 0.02,
    });
  }
  return rows;
}

describe("calibrate (end-to-end)", () => {
  it("proposes the largest weight on the genuinely predictive component and beats the fixed weights on AUC", () => {
    const result = calibrate(syntheticRows(400), { iterations: 4000, lr: 0.4 });

    expect(result.sampleSize).toBe(400);
    expect(result.posCount + result.negCount).toBe(400);

    // mm harus jadi bobot usulan terbesar
    const w = result.proposedWeights;
    expect(w.mm).toBeGreaterThan(w.smartMoney);
    expect(w.mm).toBeGreaterThan(w.regime);
    expect(w.mm).toBeGreaterThan(w.buyPressure);

    // bobot usulan menjumlah ke 1
    const sum = FEATURE_KEYS.reduce((a, k) => a + w[k], 0);
    expect(sum).toBeCloseTo(1, 8);

    // AUC usulan >= AUC existing (fitur mm mendapat bobot lebih besar)
    expect(result.projection.proposedAuc).toBeGreaterThanOrEqual(result.projection.existingAuc);
    expect(result.projection.deltaTopWinRate).toBeGreaterThanOrEqual(0);

    // existing weights tidak berubah
    expect(result.existingWeights).toEqual(EXISTING_WEIGHTS);
  });

  it("throws when the label column is degenerate", () => {
    const rows = [
      { mm: 1, sm: 2, regime: 3, bp: 4, forwardReturn: 0.01 },
      { mm: 5, sm: 6, regime: 7, bp: 8, forwardReturn: 0.02 },
    ];
    expect(() => calibrate(rows)).toThrow(/degenerate/);
  });
});

// Stage 4.5 prasyarat: dataset yang mencampur baris pra- dan pasca-migration
// 0015 memberi satu bobot untuk DUA besaran berbeda di kolom mm_component.
// Hasilnya tampak wajar tapi tidak berarti -- karena itu ditolak keras.
describe("assertSingleMmSemantics", () => {
  const post = { mm_component: 40, mm_adverse_component: 10, smart_money_component: 50, regime_component: 60, buy_pressure_component: 45, forward_return_4h: 0.01 };
  const pre = { mm_component: 70, smart_money_component: 50, regime_component: 60, buy_pressure_component: 45, forward_return_4h: 0.01 };

  it("accepts a dataset that is entirely post-0015", () => {
    expect(assertSingleMmSemantics([post, post])).toEqual({ withAdverse: 2, withoutAdverse: 0 });
  });

  it("accepts a dataset that is entirely pre-0015", () => {
    expect(assertSingleMmSemantics([pre, pre])).toEqual({ withAdverse: 0, withoutAdverse: 2 });
  });

  it("REJECTS a mixed dataset and names the fix", () => {
    expect(() => assertSingleMmSemantics([pre, post])).toThrow(/mm_adverse_component IS NOT NULL/);
  });

  it("treats an explicit NULL mm_adverse_component as pre-0015, not as zero", () => {
    // NULL != "nilainya 0" -- migration 0015 menyatakan ini eksplisit.
    expect(() => assertSingleMmSemantics([{ ...post, mm_adverse_component: null }, post])).toThrow(/mencampur/);
  });

  it("is enforced by parseDataset, not only callable on its own", () => {
    // Guard yang cuma bisa dipanggil manual bukan guard. Ini memastikan
    // jalur yang BENAR-BENAR dipakai CLI ikut menolak.
    expect(() => parseDataset([pre, post])).toThrow(/mencampur/);
  });
});
