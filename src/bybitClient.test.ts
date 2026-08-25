import { describe, it, expect, vi, afterEach } from "vitest";
import { getBybitOrderBookDepth } from "./bybitClient.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("getBybitOrderBookDepth", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps result.b/result.a to bids/asks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          retCode: 0,
          retMsg: "OK",
          result: { b: [["100", "1"]], a: [["101", "2"]] },
        }),
      ),
    );
    const depth = await getBybitOrderBookDepth("BTCUSDT", 50);
    expect(depth).toEqual({ bids: [["100", "1"]], asks: [["101", "2"]] });
  });

  it("throws on non-zero retCode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ retCode: 10001, retMsg: "invalid symbol", result: { b: [], a: [] } })),
    );
    await expect(getBybitOrderBookDepth("BADUSDT", 50)).rejects.toThrow("Bybit API error");
  });
});
