import { describe, it, expect } from "vitest";
import { toExchangeSymbol } from "./symbolMap.js";

describe("toExchangeSymbol", () => {
  it("bybit uses the exact same format as Binance", () => {
    expect(toExchangeSymbol("BTCUSDT", "bybit")).toBe("BTCUSDT");
  });

  it("okx formats as BASE-USDT-SWAP", () => {
    expect(toExchangeSymbol("BTCUSDT", "okx")).toBe("BTC-USDT-SWAP");
    expect(toExchangeSymbol("ETHUSDT", "okx")).toBe("ETH-USDT-SWAP");
  });

  it("hyperliquid uses the base asset alone", () => {
    expect(toExchangeSymbol("BTCUSDT", "hyperliquid")).toBe("BTC");
  });

  it("uppercases lowercase input", () => {
    expect(toExchangeSymbol("btcusdt", "okx")).toBe("BTC-USDT-SWAP");
  });

  it("returns null for okx/hyperliquid when the symbol doesn't end in USDT", () => {
    expect(toExchangeSymbol("BTCUSDC", "okx")).toBeNull();
    expect(toExchangeSymbol("BTCUSDC", "hyperliquid")).toBeNull();
  });

  it("still passes non-USDT symbols through unchanged for bybit", () => {
    expect(toExchangeSymbol("BTCUSDC", "bybit")).toBe("BTCUSDC");
  });

  it("returns null when the base asset would be empty (symbol is just USDT)", () => {
    expect(toExchangeSymbol("USDT", "okx")).toBeNull();
    expect(toExchangeSymbol("USDT", "hyperliquid")).toBeNull();
  });
});
