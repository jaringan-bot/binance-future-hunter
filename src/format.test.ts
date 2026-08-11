import { describe, it, expect } from "vitest";
import { fmtNum, fmtPrice, fmtPct, fmtTime, trendDirection } from "./format.js";

describe("fmtNum", () => {
  it("formats a number string with default 4 decimals", () => {
    expect(fmtNum("1234.5678")).toBe("1,234.5678");
  });

  it("returns raw string for non-numeric input", () => {
    expect(fmtNum("not-a-number")).toBe("not-a-number");
  });

  it("respects custom decimals", () => {
    expect(fmtNum(1.23456, 2)).toBe("1.23");
  });
});

describe("fmtPrice", () => {
  it("uses 2 decimals for prices >= 100 (BTC-like)", () => {
    expect(fmtPrice(64104.19057721)).toBe("64,104.19");
  });

  it("uses up to 4 decimals for prices between 1 and 100 (no trailing-zero padding)", () => {
    expect(fmtPrice(1.887974)).toBe("1.888");
    expect(fmtPrice(1.8)).toBe("1.8");
  });

  it("uses 6 decimals for prices < 1 (DODOX-like, precision must survive)", () => {
    expect(fmtPrice(0.117)).toBe("0.117");
    expect(fmtPrice(0.1234567)).toBe("0.123457");
  });

  it("handles exactly zero (no trailing-zero padding)", () => {
    expect(fmtPrice(0)).toBe("0");
  });
});

describe("fmtPct", () => {
  it("converts a fraction to a percentage string", () => {
    expect(fmtPct(0.00007867, 4)).toBe("0.0079%");
  });

  it("handles negative values", () => {
    expect(fmtPct(-0.0005058, 4)).toBe("-0.0506%");
  });
});

describe("fmtTime", () => {
  it("formats epoch ms as UTC string", () => {
    expect(fmtTime(1786456196184)).toBe("2026-08-11 13:49:56 UTC");
  });
});

describe("trendDirection", () => {
  it("returns flat for fewer than 2 points", () => {
    expect(trendDirection([1])).toBe("flat");
    expect(trendDirection([])).toBe("flat");
  });

  it("detects naik when change exceeds +0.5%", () => {
    expect(trendDirection([100, 101])).toBe("naik");
  });

  it("detects turun when change exceeds -0.5%", () => {
    expect(trendDirection([100, 99])).toBe("turun");
  });

  it("stays flat within +-0.5% band", () => {
    expect(trendDirection([100, 100.2])).toBe("flat");
  });
});
