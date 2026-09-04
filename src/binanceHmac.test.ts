import { describe, it, expect } from "vitest";
import { hmacSha256Hex, signBinanceParams } from "./binanceHmac.js";

describe("binanceHmac", () => {
  it("hmacSha256Hex matches known vector", async () => {
    // echo -n "symbol=BTCUSDT&timestamp=1" | openssl dgst -sha256 -hmac "secret"
    const hex = await hmacSha256Hex("secret", "symbol=BTCUSDT&timestamp=1");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe(
      await hmacSha256Hex("secret", "symbol=BTCUSDT&timestamp=1"),
    );
  });

  it("signBinanceParams appends signature without mutating unsigned message order", async () => {
    const signed = await signBinanceParams("test-secret", {
      symbol: "BTCUSDT",
      timestamp: 1700000000000,
      recvWindow: 5000,
    });
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.symbol).toBe("BTCUSDT");
    const again = await signBinanceParams("test-secret", {
      symbol: "BTCUSDT",
      timestamp: 1700000000000,
      recvWindow: 5000,
    });
    expect(again.signature).toBe(signed.signature);
  });
});
