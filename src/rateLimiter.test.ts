import { describe, it, expect, beforeEach } from "vitest";
import { checkAndRecordRequest, resetRateLimiter, RateLimitError, MAX_REQUESTS_PER_WINDOW } from "./rateLimiter.js";

const M = MAX_REQUESTS_PER_WINDOW;

describe("checkAndRecordRequest", () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  it(`allows requests under the limit (${M})`, () => {
    for (let i = 0; i < M - 1; i++) {
      expect(() => checkAndRecordRequest(1000)).not.toThrow();
    }
  });

  it(`throws once the 60s window hits the limit (${M})`, () => {
    for (let i = 0; i < M; i++) {
      checkAndRecordRequest(1000);
    }
    expect(() => checkAndRecordRequest(1000)).toThrow(RateLimitError);
  });

  it("prunes timestamps older than the 60s window, allowing new requests", () => {
    for (let i = 0; i < M; i++) {
      checkAndRecordRequest(1000);
    }
    expect(() => checkAndRecordRequest(1000)).toThrow(RateLimitError);

    // 61 seconds later, the old window is fully expired.
    expect(() => checkAndRecordRequest(1000 + 61_000)).not.toThrow();
  });

  it("only prunes expired entries, not the whole window (sliding, not fixed bucket)", () => {
    for (let i = 0; i < M / 2; i++) checkAndRecordRequest(0);
    for (let i = 0; i < M / 2; i++) checkAndRecordRequest(30_000);
    // At t=61000, the first half (from t=0) are >60s old and pruned, the half from t=30000 remain.
    expect(() => checkAndRecordRequest(61_000)).not.toThrow();
    // M/2+1 requests now in-window (M/2 from t=30000 + 1 just added at t=61000);
    // M/2-1 more successful calls brings it to exactly M, the next call throws.
    for (let i = 0; i < M / 2 - 1; i++) checkAndRecordRequest(61_000);
    expect(() => checkAndRecordRequest(61_000)).toThrow(RateLimitError);
  });

  it("resetRateLimiter clears all recorded timestamps", () => {
    for (let i = 0; i < M; i++) checkAndRecordRequest(1000);
    resetRateLimiter();
    expect(() => checkAndRecordRequest(1000)).not.toThrow();
  });
});
