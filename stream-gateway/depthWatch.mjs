// On-demand per-symbol order-book depth watcher (Task B / Stage 3).
//
// Opens a SHORT-LIVED WebSocket to Binance `<symbol>@depth@100ms` per
// requested symbol, keeps a COARSE local book (only levels whose notional
// crosses a tracking floor), and emits wall-lifecycle events:
// WALL_APPEARED / WALL_GREW / WALL_SHRANK / WALL_VANISHED.
//
// TTL-bounded: a watch auto-closes `ttlMs` after its last renewal, so an
// idle client never leaves a socket (and a slice of a 1GB VPS) hanging.
// `maxWatches` caps concurrent sockets+books.
//
// This is NOT a full L2 order book. Levels that never cross the tracking
// floor are dropped, so memory per symbol is bounded regardless of book
// depth. Binance diff-depth frames carry the ABSOLUTE quantity at each
// changed level (0 = removed), so tracking `book.set(price, qty)` per
// frame is the real size at that level -- no REST snapshot / sequence sync
// needed for a *lifecycle* feed (a wall that never ticks isn't a lifecycle
// event anyway; if it later moves we see it). A pre-existing wall may
// register one WALL_APPEARED the first time it ticks -- suppressed during a
// short warmup window; documented as a known edge in the MCP tool.

import { createWsClient } from "./ws-client.mjs";

export const DEFAULT_TTL_MS = 5 * 60_000;
export const MIN_TTL_MS = 30_000;
export const MAX_TTL_MS = 15 * 60_000;
// VPS 1GB: same class of constraint that cut WALL_SCAN_WATCHLIST 50->15
// (src/shared.ts). Each watch = 1 socket + 2 small Maps + an event ring.
export const DEFAULT_MAX_WATCHES = 8;
// Heuristik, BELUM dikalibrasi -- "a resting order worth >= this much USD
// at one price level is a wall". Override via ctor.
export const DEFAULT_WALL_MIN_NOTIONAL_USD = 250_000;
export const EVENT_BUFFER_PER_SYMBOL = 500;
export const DEFAULT_WARMUP_MS = 1_500;
// Track levels down to 50% of the wall threshold so we can watch one grow
// INTO a wall, not just snap into existence.
const TRACK_FLOOR_FRACTION = 0.5;
// While still a wall, only report a resize once qty moves >= 40%.
const RESIZE_MIN_RATIO = 0.4;

/**
 * Pure: classify a single price-level quantity change.
 * @returns {null | {type, notionalUsd, qty, changePct?}}
 */
export function classifyLevelTransition(prevQty, nextQty, price, wallMinNotionalUsd) {
  const prevNotional = prevQty * price;
  const nextNotional = nextQty * price;
  const wasWall = prevNotional >= wallMinNotionalUsd;
  const isWall = nextNotional >= wallMinNotionalUsd;

  if (!wasWall && isWall) {
    return { type: "WALL_APPEARED", notionalUsd: nextNotional, qty: nextQty };
  }
  if (wasWall && !isWall) {
    return { type: "WALL_VANISHED", notionalUsd: prevNotional, qty: nextQty };
  }
  if (wasWall && isWall) {
    const ratio = prevQty === 0 ? 1 : (nextQty - prevQty) / prevQty;
    if (ratio >= RESIZE_MIN_RATIO) {
      return { type: "WALL_GREW", notionalUsd: nextNotional, qty: nextQty, changePct: ratio };
    }
    if (ratio <= -RESIZE_MIN_RATIO) {
      return { type: "WALL_SHRANK", notionalUsd: nextNotional, qty: nextQty, changePct: ratio };
    }
  }
  return null;
}

export function depthWsUrl(base, symbol) {
  return `${base.replace(/\/+$/, "")}/${symbol.toLowerCase()}@depth@100ms`;
}

export function createDepthWatcher(opts = {}) {
  const {
    wsUrlBase = "wss://fstream.binance.com/ws",
    WebSocketImpl = globalThis.WebSocket,
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (h) => clearTimeout(h),
    defaultTtlMs = DEFAULT_TTL_MS,
    maxWatches = DEFAULT_MAX_WATCHES,
    wallMinNotionalUsd = DEFAULT_WALL_MIN_NOTIONAL_USD,
    warmupMs = DEFAULT_WARMUP_MS,
    sweepIntervalMs = 15_000,
  } = opts;

  /** @type {Map<string, {ws, expiresAt, startedAt, lastMessageAt, bids: Map, asks: Map, events: any[]}>} */
  const watches = new Map();
  let sweepTimer = null;
  let seq = 0;

  function pushEvent(w, ev) {
    w.events.push(ev);
    const overflow = w.events.length - EVENT_BUFFER_PER_SYMBOL;
    if (overflow > 0) w.events.splice(0, overflow);
  }

  function applyLevels(w, side, levels, warming) {
    const book = side === "bid" ? w.bids : w.asks;
    for (const entry of levels) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const price = Number(entry[0]);
      const qty = Number(entry[1]);
      if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty < 0) continue;

      const prevQty = book.get(price) ?? 0;
      const t = classifyLevelTransition(prevQty, qty, price, wallMinNotionalUsd);
      // Warmup: don't spam WALL_APPEARED for walls that were already resting
      // when we connected. GREW/SHRANK/VANISHED need a prior tracked state,
      // which can't exist yet, so this only suppresses the connect burst.
      if (t && !(warming && t.type === "WALL_APPEARED")) {
        seq += 1;
        pushEvent(w, {
          seq,
          ts: now(),
          side,
          price,
          type: t.type,
          qty: t.qty,
          notionalUsd: Math.round(t.notionalUsd),
          ...(t.changePct !== undefined ? { changePct: Number(t.changePct.toFixed(3)) } : {}),
        });
      }

      if (qty * price >= wallMinNotionalUsd * TRACK_FLOOR_FRACTION) book.set(price, qty);
      else book.delete(price);
    }
  }

  function onMessage(w, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const d = msg && msg.data && typeof msg.data === "object" ? msg.data : msg;
    if (!d || d.e !== "depthUpdate") return;
    w.lastMessageAt = now();
    const warming = now() - w.startedAt < warmupMs;
    if (Array.isArray(d.b)) applyLevels(w, "bid", d.b, warming);
    if (Array.isArray(d.a)) applyLevels(w, "ask", d.a, warming);
  }

  function closeWatch(symbol) {
    const w = watches.get(symbol);
    if (!w) return;
    try {
      w.ws.stop();
    } catch {
      /* ignore */
    }
    watches.delete(symbol);
  }

  function ensureSweep() {
    if (sweepTimer) return;
    const tick = () => {
      sweepTimer = null;
      const t = now();
      for (const [sym, w] of [...watches]) {
        if (w.expiresAt <= t) closeWatch(sym);
      }
      if (watches.size > 0) sweepTimer = schedule(tick, sweepIntervalMs);
    };
    sweepTimer = schedule(tick, sweepIntervalMs);
  }

  function clampTtl(ttlMs) {
    const n = Number(ttlMs);
    if (!Number.isFinite(n) || n <= 0) return defaultTtlMs;
    return Math.min(Math.max(n, MIN_TTL_MS), MAX_TTL_MS);
  }

  return {
    /**
     * Start OR renew a watch. Renewing just extends the TTL. Returns
     * { ok:false, error } when the symbol is invalid or maxWatches is hit.
     */
    watch(symbol, ttlMs) {
      const sym = String(symbol ?? "").toUpperCase();
      if (!/^[A-Z0-9]{5,20}$/.test(sym)) {
        return { ok: false, error: "symbol tidak valid (harus [A-Z0-9]{5,20})" };
      }
      const ttl = clampTtl(ttlMs);
      const existing = watches.get(sym);
      if (existing) {
        existing.expiresAt = now() + ttl;
        return { ok: true, watching: true, symbol: sym, expiresAt: existing.expiresAt, renewed: true };
      }
      if (watches.size >= maxWatches) {
        return {
          ok: false,
          error: `batas ${maxWatches} watch bersamaan tercapai (VPS 1GB) — tunggu watch lain kedaluwarsa`,
          activeWatches: [...watches.keys()],
        };
      }
      const w = {
        expiresAt: now() + ttl,
        startedAt: now(),
        lastMessageAt: null,
        bids: new Map(),
        asks: new Map(),
        events: [],
      };
      w.ws = createWsClient({
        url: depthWsUrl(wsUrlBase, sym),
        WebSocketImpl,
        now,
        schedule,
        cancel,
        onMessage: (raw) => onMessage(w, raw),
      });
      watches.set(sym, w);
      w.ws.start();
      ensureSweep();
      return { ok: true, watching: true, symbol: sym, expiresAt: w.expiresAt, renewed: false };
    },

    /**
     * Wall-lifecycle events for `symbol` with ts > sinceMs. When no watch is
     * active returns { watching:false } (NOT a silent empty feed — the
     * caller is meant to (re)arm via watch()).
     */
    queryDepthDiff(symbol, sinceMs) {
      const sym = String(symbol ?? "").toUpperCase();
      const w = watches.get(sym);
      if (!w) return { watching: false, symbol: sym, events: [], meta: { count: 0 } };
      const since = Number(sinceMs) || 0;
      const events = w.events.filter((e) => e.ts > since);
      const h = w.ws.getHealth();
      return {
        watching: true,
        symbol: sym,
        expiresAt: w.expiresAt,
        events,
        meta: {
          count: events.length,
          latestSeq: w.events.length ? w.events[w.events.length - 1].seq : 0,
          trackedBidLevels: w.bids.size,
          trackedAskLevels: w.asks.size,
          wsOk: h.ok,
          lastMessageAgeMs: h.lastMessageAgeMs,
          wallMinNotionalUsd,
        },
      };
    },

    stats() {
      return {
        count: watches.size,
        maxWatches,
        activeWatches: [...watches.entries()].map(([sym, w]) => ({
          symbol: sym,
          expiresAt: w.expiresAt,
          events: w.events.length,
          wsOk: w.ws.getHealth().ok,
        })),
      };
    },

    stopAll() {
      for (const sym of [...watches.keys()]) closeWatch(sym);
      if (sweepTimer) {
        cancel(sweepTimer);
        sweepTimer = null;
      }
    },
  };
}
