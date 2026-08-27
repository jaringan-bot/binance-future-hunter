// checkHeartbeat (3x/hari, HEARTBEAT_CRON) -- kalau gak ada alert TRADE/WATCH
// sama sekali dalam window lookback, kirim 1 pesan Telegram yang jelasin
// kenapa: kondisi market (backend normal) atau kemungkinan backend
// bermasalah (error rate tinggi tiap tick entryAlertCron). Kalau ADA alert
// asli dalam window, diam saja -- user udah dapet sinyal.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as d1Client from "../d1Client.js";
import * as kvConfig from "../kvConfig.js";
import * as telegram from "../telegram.js";
import {
  checkHeartbeat,
  HEARTBEAT_LOOKBACK_MS,
  BACKEND_ISSUE_ERROR_RATE_THRESHOLD,
  checkEntryAlertCronFreshness,
  ENTRY_ALERT_STALE_THRESHOLD_MS,
  ENTRY_ALERT_STALE_ALERT_COOLDOWN_MS,
} from "./heartbeatCron.js";

vi.mock("../d1Client.js", () => ({
  countEntryAlertsSince: vi.fn(),
  getEntryAlertRunLogSummarySince: vi.fn(),
  getLatestEntryAlertRunLogTimestamp: vi.fn(),
}));
vi.mock("../kvConfig.js", () => ({ getJson: vi.fn(), putJson: vi.fn() }));
vi.mock("../telegram.js", () => ({ sendTelegramAlert: vi.fn() }));

const ENV = { TELEGRAM_BOT_TOKEN: "abc", TELEGRAM_CHAT_ID: "999" };
const NOW = 100_000_000;

describe("checkHeartbeat", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("passes the lookback cutoff (now - 8h) to both D1 queries", async () => {
    vi.mocked(d1Client.countEntryAlertsSince).mockResolvedValue(1);

    await checkHeartbeat(ENV, NOW);

    expect(d1Client.countEntryAlertsSince).toHaveBeenCalledWith(NOW - HEARTBEAT_LOOKBACK_MS);
  });

  it("stays silent when at least one real TRADE/WATCH alert fired in the lookback window", async () => {
    vi.mocked(d1Client.countEntryAlertsSince).mockResolvedValue(3);

    await checkHeartbeat(ENV, NOW);

    expect(d1Client.getEntryAlertRunLogSummarySince).not.toHaveBeenCalled();
    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("warns that the cron is probably not running at all when there are zero logged runs in the window", async () => {
    vi.mocked(d1Client.countEntryAlertsSince).mockResolvedValue(0);
    vi.mocked(d1Client.getEntryAlertRunLogSummarySince).mockResolvedValue({ total: 0, errors: 0 });

    await checkHeartbeat(ENV, NOW);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    const message = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(message).toContain("tidak ada data entry-alert");
  });

  it(`flags a likely backend issue when the error rate exceeds ${BACKEND_ISSUE_ERROR_RATE_THRESHOLD * 100}%`, async () => {
    vi.mocked(d1Client.countEntryAlertsSince).mockResolvedValue(0);
    vi.mocked(d1Client.getEntryAlertRunLogSummarySince).mockResolvedValue({ total: 1000, errors: 400 }); // 40%

    await checkHeartbeat(ENV, NOW);

    const message = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(message).toContain("masalah backend");
    expect(message).toContain("40%");
  });

  it("reports a quiet market (not a backend problem) when the error rate is at or below the threshold", async () => {
    vi.mocked(d1Client.countEntryAlertsSince).mockResolvedValue(0);
    vi.mocked(d1Client.getEntryAlertRunLogSummarySince).mockResolvedValue({ total: 1000, errors: 300 }); // exactly 30%

    await checkHeartbeat(ENV, NOW);

    const message = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(message).toContain("tidak ada pair yang memenuhi kriteria");
    expect(message).not.toContain("masalah backend");
  });
});

// checkEntryAlertCronFreshness (2026-08-27) -- gap detection, distinct from
// checkHeartbeat() above: fires based on "how long since the last COMPLETED
// tick", not on aggregate totals from completed ticks. Motivated by a real
// incident (2026-08-27) where entry-alert ticks got Cancel'd by the
// Cloudflare platform before ever writing a row -- invisible to
// checkHeartbeat()'s total/error-rate math, since there was nothing to sum.
describe("checkEntryAlertCronFreshness", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("stays silent when the most recent completed tick is within the stale threshold", async () => {
    vi.mocked(d1Client.getLatestEntryAlertRunLogTimestamp).mockResolvedValue(NOW - 10 * 60 * 1000); // 10 min ago

    await checkEntryAlertCronFreshness(ENV, NOW);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    expect(kvConfig.putJson).not.toHaveBeenCalled();
  });

  it("alerts and records a KV notice when no tick has completed within the stale threshold", async () => {
    vi.mocked(d1Client.getLatestEntryAlertRunLogTimestamp).mockResolvedValue(NOW - (ENTRY_ALERT_STALE_THRESHOLD_MS + 60_000));
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkEntryAlertCronFreshness(ENV, NOW);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
    const message = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(message).toContain("tidak ada tick yang SELESAI");
    expect(kvConfig.putJson).toHaveBeenCalledWith(
      "entry_alert_cron_stale_last_notified_at",
      { at: NOW },
      { expirationTtl: 24 * 60 * 60 },
    );
  });

  it("uses a distinct message when there has NEVER been any completed tick", async () => {
    vi.mocked(d1Client.getLatestEntryAlertRunLogTimestamp).mockResolvedValue(null);
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkEntryAlertCronFreshness(ENV, NOW);

    const message = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1];
    expect(message).toContain("belum PERNAH ada baris");
  });

  it("does not re-alert while still within the cooldown of a previous stale notice", async () => {
    vi.mocked(d1Client.getLatestEntryAlertRunLogTimestamp).mockResolvedValue(NOW - (ENTRY_ALERT_STALE_THRESHOLD_MS + 60_000));
    vi.mocked(kvConfig.getJson).mockResolvedValue({ at: NOW - (ENTRY_ALERT_STALE_ALERT_COOLDOWN_MS - 60_000) }); // notified just under 1h ago

    await checkEntryAlertCronFreshness(ENV, NOW);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("re-alerts once the cooldown of a previous stale notice has fully elapsed and the condition still persists", async () => {
    vi.mocked(d1Client.getLatestEntryAlertRunLogTimestamp).mockResolvedValue(NOW - (ENTRY_ALERT_STALE_THRESHOLD_MS + 60_000));
    vi.mocked(kvConfig.getJson).mockResolvedValue({ at: NOW - (ENTRY_ALERT_STALE_ALERT_COOLDOWN_MS + 60_000) }); // just over 1h ago

    await checkEntryAlertCronFreshness(ENV, NOW);

    expect(telegram.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });
});
