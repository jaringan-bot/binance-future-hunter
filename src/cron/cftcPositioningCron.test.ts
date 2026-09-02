import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { snapshotCftcPositioning } from "./cftcPositioningCron.js";
import { setD1Database } from "../d1Client.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function rawRow() {
  return {
    contract_market_name: "BITCOIN",
    report_date_as_yyyy_mm_dd: "2026-08-18T00:00:00.000",
    open_interest_all: "21760",
    lev_money_positions_long: "4488",
    lev_money_positions_short: "11927",
    change_in_lev_money_long: "-509",
    change_in_lev_money_short: "-122",
    asset_mgr_positions_long: "4531",
    asset_mgr_positions_short: "1799",
    change_in_asset_mgr_long: "-210",
    change_in_asset_mgr_short: "-708",
  };
}

class FakeStatement {
  args: unknown[] = [];
  constructor(private db: { rows: unknown[] }) {}
  bind(...args: unknown[]): FakeStatement {
    const bound = new FakeStatement(this.db);
    bound.args = args;
    return bound;
  }
  async run(): Promise<{ success: true }> {
    this.db.rows.push(this.args);
    return { success: true };
  }
}

class FakeD1 {
  rows: unknown[] = [];
  prepare(): FakeStatement {
    return new FakeStatement(this);
  }
}

describe("snapshotCftcPositioning", () => {
  let fake: FakeD1;

  beforeEach(() => {
    fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);
  });

  afterEach(() => {
    setD1Database(undefined);
    vi.unstubAllGlobals();
  });

  it("fetches the latest CFTC report and inserts one row into cftc_positioning_history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([rawRow()])));

    await snapshotCftcPositioning("BTC");

    expect(fake.rows).toHaveLength(1);
    const [coin, reportDate, openInterest] = fake.rows[0] as [string, string, number];
    expect(coin).toBe("BTC");
    expect(reportDate).toBe("2026-08-18"); // sliced to date-only (10 chars)
    expect(openInterest).toBe(21760);
  });
});
