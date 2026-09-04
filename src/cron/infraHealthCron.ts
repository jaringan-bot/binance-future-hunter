// Infra-health checks -- piggyback on existing cron ticks (see src/index.ts).
//
// DISTINCT from heartbeatCron.ts: that file only watches the entry-alert
// Telegram pipeline ("no TRADE/WATCH in 8h -- market quiet or backend down?").
// This file watches the parts nothing else notices:
//
//  1. checkStreamGatewayHealth  -- the VPS whale-stream-gateway WebSocket to
//     Binance is down / its buffer stale / the gateway unreachable. The
//     real-time liquidation tools degrade silently otherwise (health endpoint
//     exists at :8081/health but nothing polls it).
//  2. checkMarketSnapshotFreshness -- the */5 basis+MM snapshot cron stopped
//     writing rows (every symbol failing, or the tick Cancel'd platform-side).
//     checkHeartbeat() only sees the entry-alert path, not this one.
//  3. checkD1Capacity -- market_snapshots + signal_history are pruned at 90
//     days; alert if combined rows still cross the ceiling (prune lag / backlog).
//  4. checkRelayHealth -- poll each configured REST relay's /health directly.
//     checkMarketSnapshotFreshness only catches "the relay chain is down"
//     indirectly and 20 min late; and it CANNOT see a secondary relay
//     (PROXY_URL_2) dying silently while the primary keeps snapshots flowing
//     -- which quietly puts all Binance egress back on one IP (418 -1003 risk).
//
// Each alert is KV-gated to at most one message per cooldown window, same
// pattern as checkEntryAlertCronFreshness. now is injectable for tests.
import * as d1Client from "../d1Client.js";
import * as kvConfig from "../kvConfig.js";
import * as streamGateway from "../streamGatewayClient.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { dispatchNotification, type NotifyEnv } from "../notify.js";

// Shared cooldown for the two "something is broken right now" checks (stream
// gateway, snapshot cron) -- match checkEntryAlertCronFreshness: max 1
// notification/hour while the condition persists, KV entry self-expires in 24h.
export const INFRA_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;
const NOTIFY_KV_TTL_SECONDS = 24 * 60 * 60;

interface NotifyState {
  at: number;
}

async function withinCooldown(key: string, now: number, cooldownMs: number): Promise<boolean> {
  const last = await kvConfig.getJson<NotifyState>(key);
  return last != null && now - last.at < cooldownMs;
}

async function recordNotified(key: string, now: number, ttlSeconds: number): Promise<void> {
  await kvConfig.putJson(key, { at: now } satisfies NotifyState, { expirationTtl: ttlSeconds });
}

// ─────────────────────────────────────────────────────────────
// 1. Stream gateway health
// ─────────────────────────────────────────────────────────────

// A healthy gateway sees market-wide forceOrder messages roughly every second
// (many symbols), so lastMessageAgeMs is normally sub-second. 5 minutes idle
// means the WebSocket is effectively dead even if it has not reported a
// disconnect yet -- same value as STALE_MS in streamGatewayClient.ts.
export const STREAM_GATEWAY_STALE_THRESHOLD_MS = 5 * 60 * 1000;
const STREAM_GATEWAY_KV_KEY = "infra_stream_gateway_stale_last_notified_at";

export async function checkStreamGatewayHealth(env: NotifyEnv, now: number = Date.now()): Promise<void> {
  let problem: string | null = null;

  try {
    const health = await streamGateway.fetchStreamHealth();
    if (!health.ok || health.connectedSince == null) {
      problem = "WebSocket ke Binance putus (belum reconnect)";
    } else if (health.lastMessageAgeMs != null && health.lastMessageAgeMs > STREAM_GATEWAY_STALE_THRESHOLD_MS) {
      problem = `buffer basi -- tidak ada pesan stream selama ${Math.round(health.lastMessageAgeMs / 1000)}s`;
    }
  } catch (err) {
    problem = `tidak bisa dihubungi: ${(err as Error)?.message ?? String(err)}`;
  }

  if (problem == null) return;
  if (await withinCooldown(STREAM_GATEWAY_KV_KEY, now, INFRA_NOTIFY_COOLDOWN_MS)) return;

  await dispatchNotification(
    env,
    `🚨 *Stream Gateway*: ${problem}. Likuidasi real-time (\`binance_get_realtime_liquidations\`, proxy stop-hunt di \`binance_detect_mm_activity\`) kemungkinan degrade. Cek VPS \`:8081/health\` + systemd \`whale-stream-gateway\`.`,
  );
  await recordNotified(STREAM_GATEWAY_KV_KEY, now, NOTIFY_KV_TTL_SECONDS);
}

// ─────────────────────────────────────────────────────────────
// 2. Market-snapshot cron freshness
// ─────────────────────────────────────────────────────────────

// Cron cadence is */5. 20 min = 4 missed ticks before alert -- tolerates a
// couple of platform blips without false-positives.
export const MARKET_SNAPSHOT_STALE_THRESHOLD_MS = 20 * 60 * 1000;
const MARKET_SNAPSHOT_KV_KEY = "infra_market_snapshot_stale_last_notified_at";

export async function checkMarketSnapshotFreshness(env: NotifyEnv, now: number = Date.now()): Promise<void> {
  const latest = await d1Client.getLatestMarketSnapshotTimestamp();
  const staleForMs = latest == null ? Infinity : now - latest;
  if (staleForMs <= MARKET_SNAPSHOT_STALE_THRESHOLD_MS) return;
  if (await withinCooldown(MARKET_SNAPSHOT_KV_KEY, now, INFRA_NOTIFY_COOLDOWN_MS)) return;

  const message =
    latest == null
      ? "🚨 *Snapshot Cron*: tabel `market_snapshots` masih kosong -- cron */5 kemungkinan belum pernah berhasil sejak deploy terakhir."
      : `🚨 *Snapshot Cron*: tidak ada baris \`market_snapshots\` baru dalam ${Math.round(
          staleForMs / 60000,
        )} menit terakhir (normalnya tiap 5). Proxy Binance mati atau tick di-Cancel platform -- cek Workers Logs / \`wrangler tail\`. \`binance_get_basis_history\` akan balik data tipis sampai pulih.`;

  await dispatchNotification(env, message);
  await recordNotified(MARKET_SNAPSHOT_KV_KEY, now, NOTIFY_KV_TTL_SECONDS);
}

// ─────────────────────────────────────────────────────────────
// 3. D1 capacity (90-day pruned tables -- backstop if prune lags)
// ─────────────────────────────────────────────────────────────

// market_snapshots + signal_history di-prune 90 hari di cron */5.
// Ambang 5 juta baris tetap sebagai backstop kalau prune gagal / backlog.
export const D1_ROW_COUNT_ALERT_THRESHOLD = 5_000_000;
export const D1_CAPACITY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const D1_CAPACITY_KV_KEY = "infra_d1_capacity_last_notified_at";
const D1_CAPACITY_KV_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function checkD1Capacity(env: NotifyEnv, now: number = Date.now()): Promise<void> {
  const [snapshotRows, signalRows] = await Promise.all([
    d1Client.countMarketSnapshotRows(),
    d1Client.countSignalHistoryRows(),
  ]);
  const total = snapshotRows + signalRows;
  if (total < D1_ROW_COUNT_ALERT_THRESHOLD) return;
  if (await withinCooldown(D1_CAPACITY_KV_KEY, now, D1_CAPACITY_COOLDOWN_MS)) return;

  await dispatchNotification(
    env,
    `⚠️ *D1 Capacity*: \`market_snapshots\` (${snapshotRows.toLocaleString("en-US")}) + \`signal_history\` (${signalRows.toLocaleString(
      "en-US",
    )}) = ${total.toLocaleString("en-US")} baris, lewat ambang ${D1_ROW_COUNT_ALERT_THRESHOLD.toLocaleString(
      "en-US",
    )}. Dua tabel ini sudah di-prune 90 hari -- cek apakah prune */5 gagal atau backlog sebelum kena limit D1.`,
  );
  await recordNotified(D1_CAPACITY_KV_KEY, now, D1_CAPACITY_KV_TTL_SECONDS);
}

// ─────────────────────────────────────────────────────────────
// 4. REST relay health (direct poll of each relay's /health)
// ─────────────────────────────────────────────────────────────

const RELAY_HEALTH_KV_KEY = "infra_relay_health_last_notified_at";
export const RELAY_HEALTH_TIMEOUT_MS = 5_000;

interface RelayProbe {
  label: "primary" | "secondary";
  url: string;
  ok: boolean;
  detail: string;
}

async function probeRelay(label: "primary" | "secondary", url: string): Promise<RelayProbe> {
  const target = `${url.replace(/\/+$/, "")}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(target, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return { label, url, ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok === true
      ? { label, url, ok: true, detail: "ok" }
      : { label, url, ok: false, detail: "body bukan {ok:true}" };
  } catch (err) {
    const name = (err as Error)?.name;
    return { label, url, ok: false, detail: name === "AbortError" ? "timeout 5s" : ((err as Error)?.message ?? "unreachable") };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkRelayHealth(env: NotifyEnv, now: number = Date.now()): Promise<void> {
  const relays = binanceProxy.getRelayEndpoints();
  if (relays.length === 0) return; // PROXY_URL belum diset -- bukan urusan check ini

  const probes = await Promise.all(relays.map((r) => probeRelay(r.label, r.url)));
  const down = probes.filter((p) => !p.ok);
  if (down.length === 0) return;
  if (await withinCooldown(RELAY_HEALTH_KV_KEY, now, INFRA_NOTIFY_COOLDOWN_MS)) return;

  const stillUp = probes.length - down.length;
  const downList = down.map((d) => `${d.label} (${d.detail})`).join(", ");
  const tail =
    stillUp === 0
      ? "SEMUA relay down -- tool Binance-native (funding/OI/klines/order book/dst) akan gagal total. Cek VPS systemd `whale-binance-proxy` + Caddy + Cloudflare."
      : probes.length > 1
        ? `${stillUp} relay lain masih jalan (failover round-robin nutup request), TAPI weight Binance per-IP balik ke 1 IP -- rawan 418 -1003. Restart relay yang down (VPS systemd \`whale-binance-proxy\`).`
        : "Cek VPS systemd `whale-binance-proxy` + Caddy.";

  await dispatchNotification(env, `🚨 *REST Relay*: ${downList} DOWN. ${tail}`);
  await recordNotified(RELAY_HEALTH_KV_KEY, now, NOTIFY_KV_TTL_SECONDS);
}

// ─────────────────────────────────────────────────────────────
// 5. Bromo — worker public uptime (external HTTPS probe)
// ─────────────────────────────────────────────────────────────
// Poll the Worker origin from the cron isolate. This is NOT a third-party
// status page (UptimeRobot/Better Stack tetap opsional jangka panjang) --
// ini lapisan alert internal supaya Telegram dapat sinyal kalau workers.dev
// sendiri 5xx/unreachable, yang checkRelayHealth tidak lihat.

const WORKER_PUBLIC_KV_KEY = "bromo_worker_public_last_notified_at";
export const WORKER_PUBLIC_TIMEOUT_MS = 5_000;
export const DEFAULT_WORKER_PUBLIC_URL = "https://binance-future-hunter.jaringan.workers.dev/";

export async function checkWorkerPublicHealth(
  env: NotifyEnv & { WORKER_PUBLIC_URL?: string },
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = (env.WORKER_PUBLIC_URL?.trim() || DEFAULT_WORKER_PUBLIC_URL).replace(/\/?$/, "/");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_PUBLIC_TIMEOUT_MS);
  let problem: string | null = null;
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) {
      problem = `HTTP ${res.status}`;
    } else {
      const body = (await res.json().catch(() => null)) as { name?: string } | null;
      if (body?.name !== "binance-future-hunter") {
        problem = "body tidak mengandung name=binance-future-hunter";
      }
    }
  } catch (err) {
    const name = (err as Error)?.name;
    problem = name === "AbortError" ? "timeout 5s" : ((err as Error)?.message ?? "unreachable");
  } finally {
    clearTimeout(timer);
  }

  if (problem == null) return;
  if (await withinCooldown(WORKER_PUBLIC_KV_KEY, now, INFRA_NOTIFY_COOLDOWN_MS)) return;

  await dispatchNotification(
    env,
    `🚨 *Bromo*: Worker public \`${url}\` DOWN (${problem}). Cek Cloudflare Workers status + deploy terbaru. Relay/stream check terpisah.`,
  );
  await recordNotified(WORKER_PUBLIC_KV_KEY, now, NOTIFY_KV_TTL_SECONDS);
}
