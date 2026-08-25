import { describe, it, expect, vi, afterEach } from "vitest";
import { getOkxOrderBookDepth } from "./okxClient.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("getOkxOrderBookDepth", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("strips liquidatedOrders/numOrders down to [price, size] pairs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          code: "0",
          msg: "",
          data: [{ bids: [["100", "1", "0", "2"]], asks: [["101", "2", "0", "3"]] }],
        }),
      ),
    );
    const depth = await getOkxOrderBookDepth("BTC-USDT-SWAP", 50);
    expect(depth).toEqual({ bids: [["100", "1"]], asks: [["101", "2"]] });
  });

  it("throws when instrument has no order book data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ code: "0", msg: "", data: [] })));
    await expect(getOkxOrderBookDepth("BAD-USDT-SWAP", 50)).rejects.toThrow("tidak ditemukan di OKX order book");
  });
});
