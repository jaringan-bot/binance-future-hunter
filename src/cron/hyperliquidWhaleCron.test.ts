import { describe, it, expect, vi, afterEach } from "vitest";
import { snapshotWhaleWallet } from "./hyperliquidWhaleCron.js";
import * as hyperliquidClient from "../hyperliquidClient.js";
import { setD1Database } from "../d1Client.js";

// Fake D1 minimal -- pola sama wallTrackingCron.test.ts, cuma exercise INSERT.
class FakeStatement {
  private args: unknown[] = [];
  constructor(private rows: Record<string, unknown>[]) {}
  bind(...args: unknown[]): FakeStatement {
    const s = new FakeStatement(this.rows);
    s.args = args;
    return s;
  }
  async run() {
    const [walletAddress, coin, capturedAt, side, size, entryPrice, leverage] = this.args;
    this.rows.push({ walletAddress, coin, capturedAt, side, size, entryPrice, leverage });
    return { success: true };
  }
}
class FakeD1 {
  rows: Record<string, unknown>[] = [];
  prepare() {
    return new FakeStatement(this.rows);
  }
  async batch(statements: FakeStatement[]) {
    return Promise.all(statements.map((s) => s.run()));
  }
}

describe("snapshotWhaleWallet", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setD1Database(undefined);
  });

  it("fetches positions and inserts one row per open position", async () => {
    const fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);

    vi.spyOn(hyperliquidClient, "getUserClearinghouseState").mockResolvedValue([
      { coin: "BTC", side: "long", size: 1.5, entryPrice: 64000, leverage: 10 },
      { coin: "ETH", side: "short", size: 3.2, entryPrice: 3000, leverage: 5 },
    ]);

    await snapshotWhaleWallet("0xabc");

    expect(hyperliquidClient.getUserClearinghouseState).toHaveBeenCalledWith("0xabc");
    expect(fake.rows).toHaveLength(2);
    expect(fake.rows[0]).toMatchObject({ walletAddress: "0xabc", coin: "BTC", side: "long", size: 1.5 });
    expect(fake.rows[1]).toMatchObject({ walletAddress: "0xabc", coin: "ETH", side: "short", size: 3.2 });
  });

  it("inserts nothing when wallet has no open positions", async () => {
    const fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);

    vi.spyOn(hyperliquidClient, "getUserClearinghouseState").mockResolvedValue([]);

    await snapshotWhaleWallet("0xempty");
    expect(fake.rows).toHaveLength(0);
  });
});
