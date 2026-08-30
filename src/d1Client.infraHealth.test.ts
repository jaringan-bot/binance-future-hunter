// Test the infra-health read paths in d1Client.ts (latest market_snapshots
// timestamp + row counts on market_snapshots / signal_history). Same hand-rolled fake
// D1Database approach as d1Client.entryAlertRunLog.test.ts -- dispatch by
// matching the start of the SQL string.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setD1Database,
  getLatestMarketSnapshotTimestamp,
  countMarketSnapshotRows,
  countSignalHistoryRows,
} from "./d1Client.js";

class FakeStatement {
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}

  bind(): FakeStatement {
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.startsWith("SELECT MAX(timestamp) as latest FROM market_snapshots")) {
      const timestamps = this.db.marketSnapshotTimestamps;
      return { latest: timestamps.length ? Math.max(...timestamps) : null } as T;
    }
    if (this.sql.startsWith("SELECT COUNT(*) as count FROM market_snapshots")) {
      return { count: this.db.marketSnapshotTimestamps.length } as T;
    }
    if (this.sql.startsWith("SELECT COUNT(*) as count FROM signal_history")) {
      return { count: this.db.signalHistoryRowCount } as T;
    }
    throw new Error(`FakeStatement.first: unhandled SQL: ${this.sql}`);
  }
}

class FakeD1 {
  marketSnapshotTimestamps: number[] = [];
  signalHistoryRowCount = 0;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

describe("infra-health D1 read paths", () => {
  let fake: FakeD1;

  beforeEach(() => {
    fake = new FakeD1();
    setD1Database(fake as unknown as D1Database);
  });

  afterEach(() => {
    setD1Database(undefined);
  });

  it("getLatestMarketSnapshotTimestamp returns the most recent timestamp", async () => {
    fake.marketSnapshotTimestamps = [1000, 5000, 3000];

    expect(await getLatestMarketSnapshotTimestamp()).toBe(5000);
  });

  it("getLatestMarketSnapshotTimestamp returns null when the table is empty", async () => {
    expect(await getLatestMarketSnapshotTimestamp()).toBeNull();
  });

  it("countMarketSnapshotRows returns the row count", async () => {
    fake.marketSnapshotTimestamps = [1, 2, 3, 4];

    expect(await countMarketSnapshotRows()).toBe(4);
  });

  it("countSignalHistoryRows returns the row count", async () => {
    fake.signalHistoryRowCount = 12345;

    expect(await countSignalHistoryRows()).toBe(12345);
  });
});
