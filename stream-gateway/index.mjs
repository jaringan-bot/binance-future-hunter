// whale-stream-gateway entrypoint. Wires: Binance combined-stream WS ->
// parse -> SQLite, plus a read-only HTTP API and a periodic prune.
//
// Run: node --experimental-sqlite --disable-warning=ExperimentalWarning index.mjs
// Env:
//   PROXY_SECRET           (required)  reused from the relay's .env
//   STREAM_GATEWAY_PORT    default 8081
//   STREAM_DB_PATH         default ./data.db
//   STREAM_WS_URL          default wss://fstream.binance.com/stream?streams=!forceOrder@arr/!contractInfo

import { createStore } from "./store.mjs";
import { createWsClient } from "./ws-client.mjs";
import { createServer } from "./server.mjs";
import { parseEnvelope } from "./parse.mjs";
import { createDepthWatcher } from "./depthWatch.mjs";

const PORT = Number(process.env.STREAM_GATEWAY_PORT) || 8081;
const DB_PATH = process.env.STREAM_DB_PATH || "./data.db";
// NOTE: fstream black-hole is IP-specific, NOT global:
// - Oracle SG (146.235.17.228, 2026-08-28): fstream upgrade OK, then silence.
// - AWS ap-southeast-1 (13.212.7.132, 2026-09-02 Krakatau spike): fstream
//   @depth@100ms per-symbol WORKS (~588 msg/60s); fstream @aggTrade still silent.
// Production VPS = AWS (svm-vps). Default below stays dstream for always-on
// !forceOrder@arr + !contractInfo (works from both IPs). Task B depthWatch
// should use fstream @depth@100ms on AWS. Overridable via STREAM_WS_URL.
const WS_URL =
  process.env.STREAM_WS_URL ||
  "wss://dstream.binance.com/stream?streams=!forceOrder@arr/!contractInfo";
// Per-symbol depth watch (Task B) uses fstream directly — the black-hole
// that forces dstream for the always-on feed is Oracle-IP-specific and does
// NOT apply to AWS @depth@100ms (Krakatau spike 2026-09-02).
const DEPTH_WS_BASE = process.env.STREAM_DEPTH_WS_BASE || "wss://fstream.binance.com/ws";
const DEPTH_MAX_WATCHES = Number(process.env.STREAM_DEPTH_MAX_WATCHES) || 8;
const SECRET = process.env.PROXY_SECRET;

const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const LIQ_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LIQ_MAX_ROWS = 500_000;
const CONTRACT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function log(...a) {
  console.log(new Date().toISOString(), "[gateway]", ...a);
}

if (!SECRET) {
  log("FATAL: PROXY_SECRET not set");
  process.exit(1);
}

const store = createStore(DB_PATH);
const stats = { malformedCount: 0, liqInserted: 0, contractInserted: 0 };

const ws = createWsClient({
  url: WS_URL,
  onMessage: (raw) => {
    const parsed = parseEnvelope(raw);
    try {
      if (parsed.kind === "liquidation") {
        if (store.insertLiquidation(parsed.record)) stats.liqInserted += 1;
      } else if (parsed.kind === "contract") {
        if (store.insertContractEvent(parsed.record)) {
          stats.contractInserted += 1;
          log("contractInfo", parsed.record.symbol, parsed.record.contract_status);
        }
      } else {
        stats.malformedCount += 1;
      }
    } catch (err) {
      stats.malformedCount += 1;
      log("insert error:", err?.message ?? err);
    }
  },
});

function health() {
  return { ...ws.getHealth(), malformedCount: stats.malformedCount };
}

const depthWatch = createDepthWatcher({
  wsUrlBase: DEPTH_WS_BASE,
  maxWatches: DEPTH_MAX_WATCHES,
});

const httpServer = createServer(() => ({ store, health: health(), secret: SECRET, depthWatch }));

const pruneTimer = setInterval(() => {
  try {
    const r = store.prune({
      liqMaxAgeMs: LIQ_MAX_AGE_MS,
      liqMaxRows: LIQ_MAX_ROWS,
      contractMaxAgeMs: CONTRACT_MAX_AGE_MS,
    });
    if (r.liquidations || r.contractEvents) log("pruned", JSON.stringify(r));
  } catch (err) {
    log("prune error:", err?.message ?? err);
  }
}, PRUNE_INTERVAL_MS);
pruneTimer.unref?.();

httpServer.listen(PORT, "127.0.0.1", () => {
  log(`listening on 127.0.0.1:${PORT}, db=${DB_PATH}`);
  ws.start();
  log("ws connecting to", WS_URL);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} — shutting down`);
  clearInterval(pruneTimer);
  ws.stop();
  depthWatch.stopAll();
  httpServer.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Log connection health once a minute so the journal shows life.
setInterval(() => {
  const h = health();
  const s = store.stats();
  log(
    `health ok=${h.ok} reconnects=${h.reconnectCount} lastMsgAge=${h.lastMessageAgeMs}ms ` +
      `liq=${s.liqRowCount} contracts=${s.contractRowCount} malformed=${h.malformedCount}`,
  );
}, 60_000).unref?.();
