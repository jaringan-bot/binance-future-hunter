// infraHealthCron -- three infra-health checks that piggyback on existing
// cron ticks (see src/index.ts). Distinct from heartbeatCron.ts, which only
// watches the entry-alert Telegram pipeline:
//  - checkStreamGatewayHealth: VPS stream gateway WS to Binance down / stale
//  - checkMarketSnapshotFreshness: the */5 basis+MM snapshot cron stopped
//  - checkD1Capacity: market_snapshots + signal_history crossed a row-count ceiling
// Each alerts at most once per cooldown window (KV-gated), same pattern as
// checkEntryAlertCronFreshness.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as d1Client from "../d1Client.js";
import * as kvConfig from "../kvConfig.js";
import * as streamGateway from "../streamGatewayClient.js";
import * as binanceProxy from "../binanceProxyClient.js";
import * as telegram from "../telegram.js";
import {
  checkStreamGatewayHealth,
  checkMarketSnapshotFreshness,
  checkD1Capacity,
  checkRelayHealth,
  checkWorkerPublicHealth,
  STREAM_GATEWAY_STALE_THRESHOLD_MS,
  MARKET_SNAPSHOT_STALE_THRESHOLD_MS,
  INFRA_NOTIFY_COOLDOWN_MS,
  D1_ROW_COUNT_ALERT_THRESHOLD,
  D1_CAPACITY_COOLDOWN_MS,
  WORKER_PUBLIC_FAIL_STREAK,
} from "./infraHealthCron.js";

vi.mock("../d1Client.js", () => ({
  getLatestMarketSnapshotTimestamp: vi.fn(),
  countMarketSnapshotRows: vi.fn(),
  countSignalHistoryRows: vi.fn(),
}));
vi.mock("../kvConfig.js", () => ({ getJson: vi.fn(), putJson: vi.fn() }));
vi.mock("../streamGatewayClient.js", () => ({ fetchStreamHealth: vi.fn() }));
vi.mock("../binanceProxyClient.js", () => ({ getRelayEndpoints: vi.fn() }));
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

describe("checkRelayHealth", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // fresh Response per call — a Response body stream can only be read once,
  // and checkRelayHealth probes each relay with its own fetch.
  const okBody = () => Promise.resolve(new Response(JSON.stringify({ ok: true, service: "x" }), { status: 200 }));

  it("does nothing when no relay is configured", async () => {
    vi.mocked(binanceProxy.getRelayEndpoints).mockReturnValue([]);
    await checkRelayHealth(ENV, NOW);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("stays silent when every configured relay's /health returns {ok:true}", async () => {
    vi.mocked(binanceProxy.getRelayEndpoints).mockReturnValue([
      { label: "primary", url: "https://a.example" },
      { label: "secondary", url: "https://b.example" },
    ]);
    fetchMock.mockImplementation(() => okBody());
    await checkRelayHealth(ENV, NOW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://a.example/health");
    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("alerts and names the down relay, noting failover still holds when another is up", async () => {
    vi.mocked(binanceProxy.getRelayEndpoints).mockReturnValue([
      { label: "primary", url: "https://a.example" },
      { label: "secondary", url: "https://b.example" },
    ]);
    fetchMock.mockImplementation((u: string) =>
      String(u).includes("b.example") ? Promise.resolve(new Response("nope", { status: 502 })) : okBody(),
    );
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkRelayHealth(ENV, NOW);

    const msg = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1] as string;
    expect(msg).toContain("REST Relay");
    expect(msg).toContain("secondary (HTTP 502)");
    expect(msg).toMatch(/1 relay lain masih jalan|weight Binance per-IP/i);
  });

  it("uses the 'total outage' wording when every relay is down", async () => {
    vi.mocked(binanceProxy.getRelayEndpoints).mockReturnValue([
      { label: "primary", url: "https://a.example" },
      { label: "secondary", url: "https://b.example" },
    ]);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkRelayHealth(ENV, NOW);

    const msg = vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1] as string;
    expect(msg).toMatch(/SEMUA relay down/i);
    expect(msg).toContain("primary (ECONNREFUSED)");
  });

  it("treats a 200 with a non-{ok:true} body as down", async () => {
    vi.mocked(binanceProxy.getRelayEndpoints).mockReturnValue([{ label: "primary", url: "https://a.example" }]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "degraded" }), { status: 200 }));
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkRelayHealth(ENV, NOW);

    expect((vi.mocked(telegram.sendTelegramAlert).mock.calls[0][1] as string)).toContain("body bukan {ok:true}");
  });

  it("does not re-alert within the cooldown window", async () => {
    vi.mocked(binanceProxy.getRelayEndpoints).mockReturnValue([{ label: "primary", url: "https://a.example" }]);
    fetchMock.mockResolvedValue(new Response("x", { status: 503 }));
    vi.mocked(kvConfig.getJson).mockResolvedValue({ at: NOW - (INFRA_NOTIFY_COOLDOWN_MS - 60_000) });

    await checkRelayHealth(ENV, NOW);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("records a KV notice after alerting", async () => {
    vi.mocked(binanceProxy.getRelayEndpoints).mockReturnValue([{ label: "primary", url: "https://a.example" }]);
    fetchMock.mockResolvedValue(new Response("x", { status: 503 }));
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);

    await checkRelayHealth(ENV, NOW);

    expect(kvConfig.putJson).toHaveBeenCalledWith(
      "infra_relay_health_last_notified_at",
      { at: NOW },
      { expirationTtl: 24 * 60 * 60 },
    );
  });
});

describe("checkWorkerPublicHealth (Bromo)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const okResponse = () =>
    new Response(JSON.stringify({ name: "binance-future-hunter" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  /** getJson dipanggil dua kali per run: state streak, lalu cooldown. */
  function mockKv(state: unknown, lastNotifiedAt: number | null = null) {
    vi.mocked(kvConfig.getJson).mockImplementation(async (key: string) =>
      key === "bromo_worker_public_state" ? state : lastNotifiedAt === null ? null : { at: lastNotifiedAt },
    );
  }

  it("TIDAK alert dari satu probe gagal -- itu blip, bukan outage", async () => {
    // Probe jalan tiap tick lima-menitan dengan timeout 5 detik. Satu blip
    // jaringan, cold start lambat, atau jendela propagasi deploy cukup untuk
    // membuatnya gagal sekali. Alert dari satu kegagalan melatih orang
    // mengabaikannya -- dan alert yang diabaikan sama tidak bergunanya dengan
    // alert yang tidak ada.
    vi.clearAllMocks();
    const fetchMock = vi.fn().mockResolvedValue(new Response("x", { status: 404 }));
    mockKv(null);

    await checkWorkerPublicHealth(ENV, NOW, fetchMock as unknown as typeof fetch);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    // Streak-nya DICATAT, supaya probe berikutnya tahu ini kegagalan kedua.
    expect(kvConfig.putJson).toHaveBeenCalledWith(
      "bromo_worker_public_state",
      { failStreak: 1, alerted: false },
      expect.anything(),
    );
  });

  it("alert pada kegagalan BERURUTAN yang ke-N", async () => {
    vi.clearAllMocks();
    const fetchMock = vi.fn().mockResolvedValue(new Response("x", { status: 503 }));
    mockKv({ failStreak: WORKER_PUBLIC_FAIL_STREAK - 1, alerted: false });

    await checkWorkerPublicHealth(ENV, NOW, fetchMock as unknown as typeof fetch);

    const msg = String(vi.mocked(telegram.sendTelegramAlert).mock.calls.at(-1)?.[1]);
    expect(msg).toContain("Bromo");
    expect(msg).toContain("DOWN");
    // Pesannya menyebut jumlah probe -- pembaca harus tahu ini bukan sekali gagal.
    expect(msg).toContain("berturut-turut");
    expect(kvConfig.putJson).toHaveBeenCalledWith(
      "bromo_worker_public_state",
      { failStreak: WORKER_PUBLIC_FAIL_STREAK, alerted: true },
      expect.anything(),
    );
  });

  it("mengirim PULIH saat sehat kembali sesudah pernah alert", async () => {
    // Tanpa ini, diam sesudah alert punya dua arti yang tidak bisa dibedakan:
    // sudah pulih, atau masih mati tapi sedang cooldown.
    vi.clearAllMocks();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    mockKv({ failStreak: 3, alerted: true });

    await checkWorkerPublicHealth(ENV, NOW, fetchMock as unknown as typeof fetch);

    expect(String(vi.mocked(telegram.sendTelegramAlert).mock.calls.at(-1)?.[1])).toContain("PULIH");
    expect(kvConfig.putJson).toHaveBeenCalledWith(
      "bromo_worker_public_state",
      { failStreak: 0, alerted: false },
      expect.anything(),
    );
  });

  it("PULIH terkirim MESKI masih cooldown -- cooldown menahan keluhan, bukan kabar baik", async () => {
    vi.clearAllMocks();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    mockKv({ failStreak: 3, alerted: true }, NOW - 1000);

    await checkWorkerPublicHealth(ENV, NOW, fetchMock as unknown as typeof fetch);

    expect(String(vi.mocked(telegram.sendTelegramAlert).mock.calls.at(-1)?.[1])).toContain("PULIH");
  });

  it("DIAM saat sehat dan memang tidak pernah alert", async () => {
    vi.clearAllMocks();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    mockKv(null);

    await checkWorkerPublicHealth(ENV, NOW, fetchMock as unknown as typeof fetch);

    expect(telegram.sendTelegramAlert).not.toHaveBeenCalled();
    // Tidak ada state yang perlu ditulis -- jangan boros write KV tiap 5 menit.
    expect(kvConfig.putJson).not.toHaveBeenCalled();
  });

  it("body yang bukan worker ini dihitung gagal, bukan sehat", async () => {
    // Route yang di-hijack proxy/parkir bisa balas 200 dengan body lain.
    vi.clearAllMocks();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: "sesuatu-yang-lain" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    mockKv({ failStreak: WORKER_PUBLIC_FAIL_STREAK - 1, alerted: false });

    await checkWorkerPublicHealth(ENV, NOW, fetchMock as unknown as typeof fetch);

    expect(String(vi.mocked(telegram.sendTelegramAlert).mock.calls.at(-1)?.[1])).toContain("body tidak mengandung");
  });
});
