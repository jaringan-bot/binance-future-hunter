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
  return (await res.json()) as T;
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
