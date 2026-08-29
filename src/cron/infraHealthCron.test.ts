// infraHealthCron -- three infra-health checks that piggyback on existing
// cron ticks (see src/index.ts). Distinct from heartbeatCron.ts, which only
// watches the entry-alert Telegram pipeline:
//  - checkStreamGatewayHealth: VPS stream gateway WS to Binance down / stale
//  - checkMarketSnapshotFreshness: the */5 basis+MM snapshot cron stopped
//  - checkD1Capacity: the two unpruned D1 tables crossed a row-count ceiling
// Each alerts at most once per cooldown window (KV-gated), same pattern as
// checkEntryAlertCronFreshness.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as d1Client from "../d1Client.js";
import * as kvConfig from "../kvConfig.js";
import * as streamGateway from "../streamGatewayClient.js";
import * as telegram from "../telegram.js";
import {
  checkStreamGatewayHealth,
  checkMarketSnapshotFreshness,
  checkD1Capacity,
  STREAM_GATEWAY_STALE_THRESHOLD_MS,
  MARKET_SNAPSHOT_STALE_THRESHOLD_MS,
  INFRA_NOTIFY_COOLDOWN_MS,
  D1_ROW_COUNT_ALERT_THRESHOLD,
  D1_CAPACITY_COOLDOWN_MS,
} from "./infraHealthCron.js";

vi.mock("../d1Client.js", () => ({
  getLatestMarketSnapshotTimestamp: vi.fn(),
  countMarketSnapshotRows: vi.fn(),
  countSignalHistoryRows: vi.fn(),
}));
vi.mock("../kvConfig.js", () => ({ getJson: vi.fn(), putJson: vi.fn() }));
vi.mock("../streamGatewayClient.js", () => ({ fetchStreamHealth: vi.fn() }));
vi.mock("../telegram.js", () => ({ sendTelegramAlert: vi.fn() }));

const ENV = { TELEGRAM_BOT_TOKEN: "abc", TELEGRAM_CHAT_ID: "999" };
const NOW = 100_000_000;

const healthy = {
  ok: true,
  connectedSince: NOW - 3_600_000,
  lastMessageAgeMs: 200,
  reconnectCount: 0,
  lastError: null,
};

describe("checkStreamGatewayHealth", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("stays silent when the gateway reports a healthy, connected, fresh stream", async () => {
    vi.mocked(streamGateway.fetchStreamHealth).mockResolvedValue(healthy);

    await checkStreamGatewayHealth(ENV, NOW);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("alerts when the gateway is reachable but its WebSocket to Binance is down", async () => {
    vi.mocked(streamGateway.fetchStreamHealth).mockResolvedValue({ ...healthy, ok: false, connectedSince: null });
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkStreamGatewayHealth(ENV, NOW);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1]).toContain("Stream Gateway");
  });

  it("alerts when the buffer is stale past the threshold even though the socket claims connected", async () => {
    vi.mocked(streamGateway.fetchStreamHealth).mockResolvedValue({
      ...healthy,
      lastMessageAgeMs: STREAM_GATEWAY_STALE_THRESHOLD_MS + 1000,
    });
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkStreamGatewayHealth(ENV, NOW);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it("alerts when the gateway itself is unreachable (fetchStreamHealth throws)", async () => {
    vi.mocked(streamGateway.fetchStreamHealth).mockRejectedValue(new Error("stream gateway HTTP 502"));
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkStreamGatewayHealth(ENV, NOW);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1]).toContain("502");
  });

  it("does not re-alert while still within the cooldown of a previous notice", async () => {
    vi.mocked(streamGateway.fetchStreamHealth).mockResolvedValue({ ...healthy, ok: false, connectedSince: null });
    vi.mocked(kvConfig.getJson).mockResolvedValue({ at: NOW - (INFRA_NOTIFY_COOLDOWN_MS - 60_000) });

    await checkStreamGatewayHealth(ENV, NOW);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("records a KV notice after alerting so the cooldown starts", async () => {
    vi.mocked(streamGateway.fetchStreamHealth).mockResolvedValue({ ...healthy, ok: false, connectedSince: null });
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkStreamGatewayHealth(ENV, NOW);

    expect(kvConfig.putJson).toHaveBeenCalledWith(
      "infra_stream_gateway_stale_last_notified_at",
      { at: NOW },
      { expirationTtl: 24 * 60 * 60 },
    );
  });
});

describe("checkMarketSnapshotFreshness", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("stays silent when the most recent snapshot is within the stale threshold", async () => {
    vi.mocked(d1Client.getLatestMarketSnapshotTimestamp).mockResolvedValue(NOW - 5 * 60 * 1000);

    await checkMarketSnapshotFreshness(ENV, NOW);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("alerts when no snapshot has landed within the stale threshold", async () => {
    vi.mocked(d1Client.getLatestMarketSnapshotTimestamp).mockResolvedValue(NOW - (MARKET_SNAPSHOT_STALE_THRESHOLD_MS + 60_000));
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkMarketSnapshotFreshness(ENV, NOW);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1]).toContain("Snapshot Cron");
  });

  it("uses a distinct message when the table has never had a row", async () => {
    vi.mocked(d1Client.getLatestMarketSnapshotTimestamp).mockResolvedValue(null);
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkMarketSnapshotFreshness(ENV, NOW);

    expect(vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1]).toContain("kosong");
  });

  it("does not re-alert while still within the cooldown of a previous notice", async () => {
    vi.mocked(d1Client.getLatestMarketSnapshotTimestamp).mockResolvedValue(NOW - (MARKET_SNAPSHOT_STALE_THRESHOLD_MS + 60_000));
    vi.mocked(kvConfig.getJson).mockResolvedValue({ at: NOW - (INFRA_NOTIFY_COOLDOWN_MS - 60_000) });

    await checkMarketSnapshotFreshness(ENV, NOW);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("records a KV notice after alerting", async () => {
    vi.mocked(d1Client.getLatestMarketSnapshotTimestamp).mockResolvedValue(NOW - (MARKET_SNAPSHOT_STALE_THRESHOLD_MS + 60_000));
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkMarketSnapshotFreshness(ENV, NOW);

    expect(kvConfig.putJson).toHaveBeenCalledWith(
      "infra_market_snapshot_stale_last_notified_at",
      { at: NOW },
      { expirationTtl: 24 * 60 * 60 },
    );
  });
});

describe("checkD1Capacity", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("stays silent when the combined row count is below the threshold", async () => {
    vi.mocked(d1Client.countMarketSnapshotRows).mockResolvedValue(1_000_000);
    vi.mocked(d1Client.countSignalHistoryRows).mockResolvedValue(2_000_000);

    await checkD1Capacity(ENV, NOW);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("alerts when the combined row count reaches the threshold", async () => {
    vi.mocked(d1Client.countMarketSnapshotRows).mockResolvedValue(D1_ROW_COUNT_ALERT_THRESHOLD);
    vi.mocked(d1Client.countSignalHistoryRows).mockResolvedValue(0);
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkD1Capacity(ENV, NOW);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1]).toContain("D1");
  });

  it("does not re-alert while within the 24h capacity cooldown", async () => {
    vi.mocked(d1Client.countMarketSnapshotRows).mockResolvedValue(D1_ROW_COUNT_ALERT_THRESHOLD);
    vi.mocked(d1Client.countSignalHistoryRows).mockResolvedValue(0);
    vi.mocked(kvConfig.getJson).mockResolvedValue({ at: NOW - (D1_CAPACITY_COOLDOWN_MS - 60_000) });

    await checkD1Capacity(ENV, NOW);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("records a KV notice after alerting", async () => {
    vi.mocked(d1Client.countMarketSnapshotRows).mockResolvedValue(D1_ROW_COUNT_ALERT_THRESHOLD + 123);
    vi.mocked(d1Client.countSignalHistoryRows).mockResolvedValue(0);
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkD1Capacity(ENV, NOW);

    expect(kvConfig.putJson).toHaveBeenCalledWith(
      "infra_d1_capacity_last_notified_at",
      { at: NOW },
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
  });
});
