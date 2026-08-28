# whale-stream-gateway

Always-on consumer of two low-volume Binance USD-M Futures WebSocket
streams, buffering them into SQLite so the WAF-blocked `whalescope-mcp`
Cloudflare Worker can read near-real-time data over plain HTTP.

- `!forceOrder@arr` — market-wide forced liquidations (Binance throttles
  this server-side to at most one event per symbol per second, so the feed
  is **sampled**, not exhaustive).
- `!contractInfo` — contract lifecycle events (new listing, delisting,
  settlement, status changes).

**Not** in scope: per-symbol `@depth` / `@aggTrade`, `!markPrice@arr`, or
any on-demand subscription. Those are high-volume and deliberately left
out to keep the 1 GB VPS unloaded.

## Why a separate process

It runs as its own systemd unit next to `whale-binance-proxy` (the REST
relay). A WS bug or a memory leak here must not take down the relay that
60+ Worker tools depend on. `MemoryMax=256M` caps the blast radius.

## Files

| File | Role |
|---|---|
| `parse.mjs` | Pure parsers for the combined-stream envelope. Never throw. |
| `store.mjs` | `node:sqlite` — schema, insert (`INSERT OR IGNORE` dedupe), query, prune. |
| `ws-client.mjs` | One WS connection, capped exponential backoff, liveness watchdog. Time + socket impl injected for tests. |
| `server.mjs` | `node:http` read API on `127.0.0.1:8081`. `route()` is pure and unit-tested. |
| `index.mjs` | Wiring + 10-min prune timer + graceful shutdown. |
| `whale-stream-gateway.service` | systemd unit. |
| `install.sh` | Idempotent install/update, ASCII-only. Also patches Caddy. |

## HTTP API

Behind Caddy at `https://<host>/stream/*`. Auth: `x-proxy-secret` header
(the same value as the relay's `PROXY_SECRET` — reused, no new secret).

| Route | Params | Auth |
|---|---|---|
| `GET /stream/health` | — | none |
| `GET /stream/liquidations` | `symbol? sinceMs? minNotionalUsd? limit`(<=1000, def 100) | yes |
| `GET /stream/contract-events` | `symbol? sinceMs? limit`(<=500, def 50) | yes |

Data responses embed `meta.streamHealth` so a caller can tell a stale
buffer from a fresh one in a single request.

## Deploy

```sh
# Node 22+ required (node:sqlite). From this directory:
scp -i <key> *.mjs package.json whale-stream-gateway.service install.sh ubuntu@<vps>:/tmp/gw/
ssh -i <key> ubuntu@<vps> 'sudo bash /tmp/gw/install.sh'
```

`install.sh` reuses `PROXY_SECRET` from `/opt/whale-binance-proxy/.env`,
installs+enables the unit, and rewrites `/etc/caddy/Caddyfile` to route
`/stream/*` to `:8081` while everything else stays on the relay at `:8080`.

## Test

```sh
npm test   # node --test, zero dependency
```

## Retention

Prune runs every 10 min: liquidations older than 24 h or beyond 500 k
rows; contract events older than 30 days.
