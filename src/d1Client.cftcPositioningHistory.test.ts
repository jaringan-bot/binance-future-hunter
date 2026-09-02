// Test cftc_positioning_history read/write path in d1Client.ts -- same
// hand-rolled fake D1Database pattern as d1Client.wallTracking.test.ts (no
// miniflare/wrangler D1 harness wired into vitest in this repo).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setD1Database,
  insertCftcPositioningSnapshot,
  queryCftcPositioningHistory,
  type CftcPositioningHistoryRow,
} from "./d1Client.js";

interface FakeRow {
  coin: string;
  report_date: string;
  open_interest: number;
  lev_long: number;
  lev_short: number;
  lev_net_pct: number;
  am_long: number;
  am_short: number;
  am_net_pct: number;
  captured_at: number;
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    const bound = new FakeStatement(this.db, this.sql);
    bound.args = args;
    return bound;
  }

  async run(): Promise<{ success: true }> {
    if (this.sql.startsWith("INSERT OR IGNORE INTO cftc_positioning_history")) {
      const [coin, report_date, open_interest, lev_long, lev_short, lev_net_pct, am_long, am_short, am_net_pct, captured_at] =
        this.args as [string, string, number, number, number, number, number, number, number, number];
      // Mirror the real UNIQUE INDEX(coin, report_date) + INSERT OR IGNORE semantics.
      const exists = this.db.rows.some((r) => r.coin === coin && r.report_date === report_date);
      if (!exists) {
        this.db.rows.push({ coin, report_date, open_interest, lev_long, lev_short, lev_net_pct, am_long, am_short, am_net_pct, captured_at });
      }
      return { success: true };
    }
    throw new Error(`FakeStatement.run: unhandled SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM cftc_positioning_history WHERE coin")) {
      const [coin, limit] = this.args as [string, number];
      const results = this.db.rows
        .filter((r) => r.coin === coin)
        .sort((a, b) => b.report_date.localeCompare(a.report_date))
        .slice(0, limit)
        .sort((a, b) => a.report_date.localeCompare(b.report_date));
      return { results: results as T[] };
    }
    throw new Error(`FakeStatement.all: unhandled SQL: ${this.sql}`);
  }
}

class FakeD1 {
  rows: FakeRow[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

function row(overrides: Partial<CftcPositioningHistoryRow> = {}): CftcPositioningHistoryRow {
  return {
    coin: "BTC",
    reportDate: "2026-08-18",
    openInterest: 21760,
    levLong: 4488,
    levShort: 11927,
    levNetPct: (4488 - 11927) / 21760,
    amLong: 4531,
    amShort: 1799,
    amNetPct: (4531 - 1799) / 21760,
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("cftc_positioning_history D1 read/write path", () => {
  let fake: FakeD1;

  beforeEach(() => {
    fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);
  });

  afterEach(() => {
    setD1Database(undefined);
  });

  it("insertCftcPositioningSnapshot writes a row", async () => {
    await insertCftcPositioningSnapshot(row());
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({ coin: "BTC", report_date: "2026-08-18" });
  });

  it("insertCftcPositioningSnapshot is idempotent for the same (coin, report_date)", async () => {
    await insertCftcPositioningSnapshot(row());
    await insertCftcPositioningSnapshot(row({ openInterest: 99999 })); // same coin+date, different payload
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].open_interest).toBe(21760); // first write wins, second was ignored
  });

  it("queryCftcPositioningHistory returns the N most recent reports for a coin, ascending by date", async () => {
    await insertCftcPositioningSnapshot(row({ reportDate: "2026-07-28" }));
    await insertCftcPositioningSnapshot(row({ reportDate: "2026-08-04" }));
    await insertCftcPositioningSnapshot(row({ reportDate: "2026-08-11" }));
    await insertCftcPositioningSnapshot(row({ reportDate: "2026-08-18" }));
    await insertCftcPositioningSnapshot(row({ coin: "ETH", reportDate: "2026-08-18" })); // different coin, excluded

    const history = await queryCftcPositioningHistory("BTC", 3);
    expect(history.map((h) => h.reportDate)).toEqual(["2026-08-04", "2026-08-11", "2026-08-18"]);
  });

  it("queryCftcPositioningHistory returns an empty array when no history exists yet", async () => {
    const history = await queryCftcPositioningHistory("BTC", 8);
    expect(history).toEqual([]);
  });
});
