import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  it("preserves input order in the output array regardless of completion order", async () => {
    const items = [30, 10, 20, 5, 25];
    const results = await mapWithConcurrency(items, 3, async (ms) => {
      await delay(ms);
      return ms;
    });
    expect(results).toEqual(items);
  });

  it("never exceeds the requested concurrency limit", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(items, 3, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight -= 1;
      return item;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it("processes all items even when limit exceeds item count", async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrency(items, 8, async (item) => item * 2);
    expect(results).toEqual([2, 4, 6]);
  });

  it("returns an empty array for an empty input without hanging", async () => {
    const results = await mapWithConcurrency<number, number>([], 5, async (item) => item);
    expect(results).toEqual([]);
  });

  it("handles limit=1 as fully sequential execution", async () => {
    const order: number[] = [];
    const items = [1, 2, 3, 4];
    await mapWithConcurrency(items, 1, async (item) => {
      order.push(item);
      await delay(1);
      return item;
    });
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("propagates a rejection from fn (per-item try/catch is the caller's responsibility)", async () => {
    const items = [1, 2, 3];
    await expect(
      mapWithConcurrency(items, 2, async (item) => {
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
  });
});
