import { describe, it, expect, beforeEach } from "vitest";
import { checkAndRecordRequest, resetRateLimiter, RateLimitError } from "./rateLimiter.js";

describe("checkAndRecordRequest", () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  it("allows requests under the limit", () => {
    for (let i = 0; i < 199; i++) {
      expect(() => checkAndRecordRequest(1000)).not.toThrow();
    }
  });

  it("throws once the 60s window hits the limit (200)", () => {
    for (let i = 0; i < 200; i++) {
      checkAndRecordRequest(1000);
    }
    expect(() => checkAndRecordRequest(1000)).toThrow(RateLimitError);
  });

  it("prunes timestamps older than the 60s window, allowing new requests", () => {
    for (let i = 0; i < 200; i++) {
      checkAndRecordRequest(1000);
    }
    expect(() => checkAndRecordRequest(1000)).toThrow(RateLimitError);

    // 61 seconds later, the old window is fully expired.
    expect(() => checkAndRecordRequest(1000 + 61_000)).not.toThrow();
  });

  it("only prunes expired entries, not the whole window (sliding, not fixed bucket)", () => {
    for (let i = 0; i < 100; i++) checkAndRecordRequest(0);
    for (let i = 0; i < 100; i++) checkAndRecordRequest(30_000);
    // At t=61000, the first 100 (from t=0) are >60s old and pruned, the 100 from t=30000 remain.
    expect(() => checkAndRecordRequest(61_000)).not.toThrow();
    // 101 requests now in-window (100 from t=30000 + 1 just added at t=61000);
    // 99 more successful calls brings it to exactly 200, the 200th call throws.
    for (let i = 0; i < 99; i++) checkAndRecordRequest(61_000);
    expect(() => checkAndRecordRequest(61_000)).toThrow(RateLimitError);
  });

  it("resetRateLimiter clears all recorded timestamps", () => {
    for (let i = 0; i < 200; i++) checkAndRecordRequest(1000);
    resetRateLimiter();
    expect(() => checkAndRecordRequest(1000)).not.toThrow();
  });
});
