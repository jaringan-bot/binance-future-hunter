// Binance combined-stream WebSocket client: one connection to
// !forceOrder@arr + !contractInfo, auto-reconnect with capped backoff, and
// a liveness watchdog. Connection concerns only — parsing / storage live
// elsewhere. Time and the WebSocket impl are injected so it is testable
// without real sockets or real waiting.

export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const STABLE_MS = 60_000;
const DEFAULT_LIVENESS_MS = 300_000;

export function createWsClient({
  url,
  WebSocketImpl = globalThis.WebSocket,
  onMessage,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
  livenessTimeoutMs = DEFAULT_LIVENESS_MS,
}) {
  let ws = null;
  let stopped = true;
  let backoffStep = 0;
  let reconnectTimer = null;
  let livenessTimer = null;

  let connectedSince = null;
  let lastConnectAt = null;
  let lastMessageAt = null;
  let reconnectCount = 0;
  let lastError = null;

  function clearLiveness() {
    if (livenessTimer) {
      cancel(livenessTimer);
      livenessTimer = null;
    }
  }

  function armLiveness() {
    clearLiveness();
    livenessTimer = schedule(() => {
      livenessTimer = null;
      lastError = "liveness timeout";
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      scheduleReconnect(); // in case the impl never fires 'close'
    }, livenessTimeoutMs);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    if (lastConnectAt != null && now() - lastConnectAt >= STABLE_MS) backoffStep = 0;
    const waitMs = BACKOFF_MS[Math.min(backoffStep, BACKOFF_MS.length - 1)];
    backoffStep += 1;
    reconnectCount += 1;
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect();
    }, waitMs);
  }

  function connect() {
    if (stopped) return;
    ws = new WebSocketImpl(url);

    ws.addEventListener("open", () => {
      connectedSince = now();
      lastConnectAt = now();
      lastError = null;
      armLiveness();
    });

    ws.addEventListener("message", (ev) => {
      lastMessageAt = now();
      armLiveness();
      try {
        onMessage(ev?.data);
      } catch (err) {
        lastError = err?.message ?? String(err);
      }
    });

    ws.addEventListener("error", (ev) => {
      lastError = ev?.message ?? "websocket error";
    });

    ws.addEventListener("close", () => {
      connectedSince = null;
      clearLiveness();
      scheduleReconnect();
    });
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) {
        cancel(reconnectTimer);
        reconnectTimer = null;
      }
      clearLiveness();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
    getHealth() {
      return {
        ok: connectedSince != null,
        connectedSince,
        lastMessageAgeMs: lastMessageAt == null ? null : now() - lastMessageAt,
        reconnectCount,
        lastError,
      };
    },
  };
}
