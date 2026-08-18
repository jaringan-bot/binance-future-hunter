import { describe, it, expect } from "vitest";
import { computeWallStatus } from "./wallPersistence.js";

const T0 = 1_000_000;
const MIN = 60_000;

describe("computeWallStatus", () => {
  it("BERTAHAN when qty stays roughly flat and last point is fresh", () => {
    const points = [
      { capturedAt: T0, qty: 100 },
      { capturedAt: T0 + MIN, qty: 98 },
      { capturedAt: T0 + 2 * MIN, qty: 95 },
    ];
    const now = T0 + 2 * MIN + 10_000;
    expect(computeWallStatus(points, now)).toEqual({ status: "BERTAHAN", changePct: -5 });
  });

  it("MENYUSUT when qty drops more than 40% first-to-last within the window", () => {
    const points = [
      { capturedAt: T0, qty: 100 },
      { capturedAt: T0 + MIN, qty: 70 },
      { capturedAt: T0 + 2 * MIN, qty: 50 },
    ];
    const now = T0 + 2 * MIN + 10_000;
    const result = computeWallStatus(points, now);
    expect(result.status).toBe("MENYUSUT");
    expect(result.changePct).toBe(-50);
  });

  it("HILANG when the most recent row is older than the staleness window (2 min)", () => {
    const points = [
      { capturedAt: T0, qty: 100 },
      { capturedAt: T0 + MIN, qty: 95 },
    ];
    // "now" is 3 minutes after the last row -- at least one scan tick missed it entirely.
    const now = T0 + MIN + 3 * MIN;
    const result = computeWallStatus(points, now);
    expect(result).toEqual({ status: "HILANG", changePct: null });
  });

  it("BERTAHAN on a single fresh point (no prior baseline to compare)", () => {
    const points = [{ capturedAt: T0, qty: 100 }];
    const now = T0 + 10_000;
    expect(computeWallStatus(points, now)).toEqual({ status: "BERTAHAN", changePct: 0 });
  });

  it("treats exactly -40% as MENYUSUT (boundary is inclusive)", () => {
    const points = [
      { capturedAt: T0, qty: 100 },
      { capturedAt: T0 + MIN, qty: 60 },
    ];
    const now = T0 + MIN + 10_000;
    const result = computeWallStatus(points, now);
    expect(result.status).toBe("MENYUSUT");
    expect(result.changePct).toBe(-40);
  });
});
