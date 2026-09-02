# whale-binance-proxy — standalone relay

Replacement for the retired Vercel relay (`../proxy/`), which Vercel paused
for commercial use on a Hobby plan. Same contract, same path whitelist, but
runs anywhere: **zero dependencies, single file of logic (`handler.mjs`).**

The binance-future-hunter Cloudflare Worker is WAF-blocked by Binance (403 on every
endpoint). It needs a relay on a host whose egress IP is:

- **not** Binance-WAF-blocked (Cloudflare Workers IPs are), and
- **not** in a Binance geo-restricted region (avoid `us-*` / `iad1` — pick
  **Singapore** or **Tokyo**; the old Vercel deploy ran in `sin1`).

## Contract

```
GET /api/binance?path=<binance-path>&market=<futures|spot>&<other-params>
Header: x-proxy-secret: <PROXY_SECRET>       # required
Header: x-binance-api-key: <key>             # optional, signed endpoints only
```

`GET /health` → `{"ok":true}` with no auth (for platform probes).

Set `PROXY_SECRET` on the host to a random string:
`openssl rand -hex 32`.

## Files

| File | For |
|---|---|
| `handler.mjs` | The relay logic. Web-standard `Request`→`Response`. Imported by the others. |
| `server.mjs` | Node `node:http` entrypoint (VPS, Docker, Fly, Render, Koyeb). |
| `deno.mjs` | Deno Deploy entrypoint. |
| `Dockerfile` | Node 22 alpine image, no build step. |
| `fly.toml` | Fly.io config, region `sin`. |
| `whale-binance-proxy.service` | systemd unit for a VPS. |

## Deploy — pick one

### A. VPS in Singapore (~$5/mo) — most reliable, recommended

DigitalOcean SGP1 / Vultr Singapore / AWS Lightsail SG. Install Node 18+,
then follow the header comment in `whale-binance-proxy.service`. Front it
with Caddy (auto-TLS) or a Cloudflare Tunnel to `:8080`.

Bonus: the same box gives a static IP that also unblocks
`leverage-bracket-mcp`.

### B. Fly.io — free allowance, region `sin`

```sh
fly launch --no-deploy --copy-config --name whale-binance-proxy
fly secrets set PROXY_SECRET=$(openssl rand -hex 32)
fly deploy
curl -s https://whale-binance-proxy.fly.dev/health
```

### C. Deno Deploy — $0, try first

New project → link this repo → set **entrypoint** to
`proxy-standalone/deno.mjs` → add env var `PROXY_SECRET`. Pick an Asia
region if offered. Then verify Binance is reachable (Deno Deploy runs partly
on GCP — WAF outcome is not guaranteed):

```sh
curl -s "https://<project>.deno.dev/api/binance?path=/fapi/v1/ping" \
  -H "x-proxy-secret: <secret>"
# expect: {}   (Binance ping). A 403 body = WAF-blocked, use A or B.
```

### D. Render — free web service, Singapore region

New Web Service → this repo, root dir `proxy-standalone` → Runtime **Docker**
→ region **Singapore** → env var `PROXY_SECRET`. Health check path
`/health`. Note: free instances cold-start (~50s) after idle.

### E. Docker anywhere

```sh
docker build -t whale-binance-proxy .
docker run -p 8080:8080 -e PROXY_SECRET=xxxx whale-binance-proxy
```

## Wire it into the Worker

From the `binance-future-hunter` repo root:

```sh
# make this relay the primary:
npx wrangler secret put PROXY_URL       # https://<your-host>   (no trailing slash, no /api/binance)
npx wrangler secret put PROXY_SECRET    # the value you generated above

# OR keep the current primary and add this as automatic failover:
npx wrangler secret put PROXY_URL_2
npx wrangler secret put PROXY_SECRET_2
```

`PROXY_URL` is the origin only — the Worker appends `/api/binance` itself.

Deploy the Worker (branch `fix/proxy-402-failover` adds HTTP 402 to the
failover set, so a paused primary now rolls to the secondary automatically):

```sh
npx wrangler deploy
```

## Verify end to end

```sh
curl -s "https://<your-host>/api/binance?path=/fapi/v1/ticker/price&symbol=BTCUSDT" \
  -H "x-proxy-secret: <secret>"
# {"symbol":"BTCUSDT","price":"..."}
```

Then from the MCP: `binance_get_price_ticker BTCUSDT` should return a price
instead of `HTTP 402`.
