// Client for the whale-stream-gateway HTTP read API (VPS-side, see
// stream-gateway/). Same host + secret as the Binance REST relay
// (PROXY_URL / PROXY_SECRET) — the gateway lives behind the same Caddy at
// /stream/*. Module-level config setter, same pattern as
// binanceProxyClient.setProxyConfig() / kvConfig.setKvNamespace().
//
// Unlike the REST relay there is NO failover tier: one gateway. If it is
// unreachable the real-time tools are unavailable and say so. If it is
// reachable but its buffer is stale, callers get the data plus a
// `degraded` flag — never a silent empty array.

import { withCache } from "./cache.js";

let baseUrl: string | undefined;
let secret: string | undefined;

export function setStreamGatewayConfig(url: string | undefined, sec: string | undefined): void {
  baseUrl = url ? url.replace(/\/+$/, "") : undefined;
  secret = sec || undefined;
}

export class StreamGatewayError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "StreamGatewayError";
  }
}

export interface StreamHealth {
  ok: boolean;
  connectedSince: number | null;
  lastMessageAgeMs: number | null;
  reconnectCount: number;
  lastError: string | null;
}

export interface LiquidationEvent {
  symbol: string;
  side: string;
  price: number;
  orig_qty: number;
  avg_price: number | null;
  notional_usd: number;
  order_status: string | null;
  event_time: number;
  trade_time: number;
}

export interface ContractEvent {
  symbol: string;
  pair: string | null;
  contract_type: string | null;
  contract_status: string | null;
  delivery_date: number | null;
  onboard_date: number | null;
  event_time: number;
  raw_json: string;
}

export interface StreamResult<T> {
  events: T[];
  meta: Record<string, unknown> & { streamHealth?: StreamHealth };
  degraded: boolean;
  degradedReason: string | null;
}

const STALE_MS = 300_000;

function assessDegradation(health: StreamHealth | undefined): string | null {
  if (!health) return "gateway did not report stream health";
  if (!health.ok || health.connectedSince == null) return "gateway WebSocket to Binance is down";
  if (health.lastMessageAgeMs != null && health.lastMessageAgeMs > STALE_MS) {
    return `buffer is stale — no stream message for ${Math.round(health.lastMessageAgeMs / 1000)}s`;
  }
  return null;
}

function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  if (!baseUrl || !secret) {
    throw new StreamGatewayError(
      "PROXY_URL / PROXY_SECRET belum diset di worker — stream gateway tidak bisa dihubungi.",
    );
  }
  const url = new URL(`${baseUrl}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function getJson<T>(path: string, params: Record<string, string | number | undefined>, ttlSeconds: number): Promise<T> {
  const url = buildUrl(path, params);
  const produce = async () => {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "x-proxy-secret": secret as string, Accept: "application/json" } });
    } catch (err) {
      throw new StreamGatewayError(`stream gateway tidak bisa dihubungi: ${(err as Error)?.message ?? String(err)}`);
    }
    if (!res.ok) {
      throw new StreamGatewayError(`stream gateway HTTP ${res.status}`, res.status);
    }
    return res;
  };
  const res = ttlSeconds > 0 ? await withCache(url, ttlSeconds, produce) : await produce();
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  if (parsed == null || typeof parsed !== "object") {
    throw new StreamGatewayError("stream gateway balik respons kosong / non-JSON (relay tidak bisa dihubungi?)");
  }
  return parsed as T;
}

// POST — never cached (it mutates watch state on the gateway). A non-2xx
// with a valid JSON object body (e.g. 400 invalid symbol, 429 "batas ...
// watch") is passed back to the caller as data; anything without a usable
// object body — auth/server errors, an unreachable relay that yields a
// non-JSON error page, an empty/truncated response — throws
// StreamGatewayError so the tool degrades gracefully instead of seeing
// `undefined`.
async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const url = buildUrl(path, {});
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "x-proxy-secret": secret as string, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new StreamGatewayError(`stream gateway tidak bisa dihubungi: ${(err as Error)?.message ?? String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  if (
    res.status === 401 ||
    res.status === 403 ||
    res.status >= 500 ||
    parsed == null ||
    typeof parsed !== "object"
  ) {
    throw new StreamGatewayError(
      `stream gateway HTTP ${res.status}${parsed == null || typeof parsed !== "object" ? " (respons kosong / non-JSON — relay tidak bisa dihubungi?)" : ""}`,
      res.status,
    );
  }
  return parsed as T;
}

export async function fetchLiquidations(opts: {
  symbol?: string;
  sinceMs?: number;
  minNotionalUsd?: number;
  limit?: number;
}): Promise<StreamResult<LiquidationEvent>> {
  const body = await getJson<{ events: LiquidationEvent[]; meta: StreamResult<LiquidationEvent>["meta"] }>(
    "/stream/liquidations",
    {
      symbol: opts.symbol?.toUpperCase(),
      sinceMs: opts.sinceMs,
      minNotionalUsd: opts.minNotionalUsd,
      limit: opts.limit,
    },
    10,
  );
  const reason = assessDegradation(body.meta?.streamHealth);
  return { events: body.events ?? [], meta: body.meta ?? {}, degraded: reason != null, degradedReason: reason };
}

export async function fetchContractEvents(opts: {
  symbol?: string;
  sinceMs?: number;
  limit?: number;
}): Promise<StreamResult<ContractEvent>> {
  const body = await getJson<{ events: ContractEvent[]; meta: StreamResult<ContractEvent>["meta"] }>(
    "/stream/contract-events",
    { symbol: opts.symbol?.toUpperCase(), sinceMs: opts.sinceMs, limit: opts.limit },
    60,
  );
  const reason = assessDegradation(body.meta?.streamHealth);
  return { events: body.events ?? [], meta: body.meta ?? {}, degraded: reason != null, degradedReason: reason };
}

export async function fetchStreamHealth(): Promise<StreamHealth & Record<string, unknown>> {
  return getJson<StreamHealth & Record<string, unknown>>("/stream/health", {}, 0);
}

// ── Task B: on-demand per-symbol order-book depth watch ─────────────────

export interface WatchResult {
  ok: boolean;
  watching?: boolean;
  symbol?: string;
  expiresAt?: number;
  renewed?: boolean;
  /** Ambang wall efektif (USD) yang dipakai watch ini — locked ke nilai
   *  saat arming, tidak berubah waktu renew. */
  wallMinNotionalUsd?: number;
  error?: string;
  activeWatches?: string[];
}

export interface DepthDiffEvent {
  seq: number;
  ts: number;
  side: "bid" | "ask";
  price: number;
  type: "WALL_APPEARED" | "WALL_GREW" | "WALL_SHRANK" | "WALL_VANISHED";
  qty: number;
  notionalUsd: number;
  changePct?: number;
}

export interface DepthDiffResult {
  watching: boolean;
  symbol: string;
  expiresAt?: number;
  events: DepthDiffEvent[];
  meta: Record<string, unknown> & { count: number };
  degraded: boolean;
  degradedReason: string | null;
}

/**
 * Arm or renew a depth watch for `symbol`. TTL + wall threshold clamped
 * gateway-side. `wallMinNotionalUsd` only applies on the FIRST arm — a
 * renew keeps the original (gateway locks it).
 */
export async function watchOrderBook(
  symbol: string,
  ttlMs?: number,
  wallMinNotionalUsd?: number,
): Promise<WatchResult> {
  const body: Record<string, unknown> = { symbol: symbol.toUpperCase() };
  if (ttlMs != null) body.ttlMs = ttlMs;
  if (wallMinNotionalUsd != null) body.wallMinNotionalUsd = wallMinNotionalUsd;
  return postJson<WatchResult>("/stream/watch", body);
}

/** Wall-lifecycle events since `sinceMs`. `watching:false` => call watchOrderBook first. */
export async function fetchDepthDiff(symbol: string, sinceMs?: number): Promise<DepthDiffResult> {
  const body = await getJson<{
    watching: boolean;
    symbol: string;
    expiresAt?: number;
    events?: DepthDiffEvent[];
    meta?: Record<string, unknown> & { count: number; wsOk?: boolean; lastMessageAgeMs?: number | null };
  }>("/stream/depth-diff", { symbol: symbol.toUpperCase(), sinceMs }, 0);

  let degradedReason: string | null = null;
  if (!body.watching) {
    degradedReason = "tidak ada watch aktif untuk symbol ini — panggil watchOrderBook dulu";
  } else if (body.meta?.wsOk === false) {
    degradedReason = "gateway WebSocket ke Binance untuk symbol ini belum/tidak konek";
  } else if (
    typeof body.meta?.lastMessageAgeMs === "number" &&
    (body.meta.lastMessageAgeMs as number) > 30_000
  ) {
    degradedReason = `tidak ada update depth ~${Math.round((body.meta.lastMessageAgeMs as number) / 1000)}s`;
  }

  return {
    watching: body.watching,
    symbol: body.symbol,
    expiresAt: body.expiresAt,
    events: body.events ?? [],
    meta: body.meta ?? { count: 0 },
    degraded: degradedReason != null,
    degradedReason,
  };
}
