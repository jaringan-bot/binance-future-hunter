import { describe, it, expect } from "vitest";
import { isAuthorized } from "./adminUsage.js";

describe("isAuthorized", () => {
  it("denies when ADMIN_SECRET is not configured, regardless of what's provided", () => {
    expect(isAuthorized("anything", undefined)).toBe(false);
    expect(isAuthorized(null, undefined)).toBe(false);
  });

  it("denies when no key is provided", () => {
    expect(isAuthorized(null, "s3cret")).toBe(false);
  });

  it("denies when the provided key doesn't match", () => {
    expect(isAuthorized("wrong", "s3cret")).toBe(false);
  });

  it("allows when the provided key matches exactly", () => {
    expect(isAuthorized("s3cret", "s3cret")).toBe(true);
  });

  it("is case-sensitive (no loose matching)", () => {
    expect(isAuthorized("S3CRET", "s3cret")).toBe(false);
  });

  it("denies an empty-string key even if ADMIN_SECRET is also empty", () => {
    expect(isAuthorized("", "")).toBe(false);
  });
});
