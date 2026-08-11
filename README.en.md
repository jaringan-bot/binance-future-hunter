# WhaleScope MCP — Binance Futures Market Intelligence

[🇮🇩 Bahasa Indonesia](README.md) | 🇬🇧 English

MCP server that exposes public Binance USDS-M Futures data (funding rate,
open interest, long/short ratio, taker volume, candlesticks, order book,
volatility) plus a Binance Spot comparison layer (price, order book,
candlesticks, CVD) as tools callable by Claude. All data served is
**public, read-only** — no order placement/trading, no access to private
account data.

## Purpose

Provide a picture of Binance Futures market positioning — not just price,
but also *who* is holding what (retail vs top trader), *how crowded* the
leverage is, and *at what price* liquidity is stacked — directly inside a
conversation with Claude, without needing a separate exchange dashboard.

## Benefits

- **One door for many signals.** Funding rate, open interest, order book,
  order flow, and liquidation history — all through a single MCP connector,
  no tab-switching.
- **Distinguish retail from whale.** `binance_get_top_trader_ratio` gives a
  pure top-trader breakdown (separate from `binance_get_long_short_ratio`,
  which is blended) — useful for spotting divergence between retail and
  whale positioning.
- **Native Binance where it matters.** Price, funding rate, klines, order
  book — all through the native Binance path (not a third-party derivation),
  so precision holds up especially for smaller/less liquid pairs.
- **Free for personal use** — see the [Cost](#cost) section.

## Strengths

- 23 tools covering five analytical angles: directional market bias, key
  price areas (order book), execution confirmation (order flow/aggressor),
  Futures-vs-Spot comparison (leverage-driven vs real demand), and
  market-wide scanning (extreme funding rates across every pair at once).
- Purely read-only — no custodial risk or accidental trading.
- Transparent about each tool's limitations (see the section below), not
  glossed over as if all data were perfect.
- Infrastructure fits comfortably in free tiers (Cloudflare Workers +
  Vercel Hobby + Coinalyze free tier) for personal use.

## Weaknesses

- **Not a real-time stream.** Every tool is request/response (snapshot or
  periodic history) — no second-by-second push events (e.g. a fresh
  liquidation happening right now). Adding that would require extra
  infrastructure components currently out of this project's scope.
- **One tool still goes through a third-party aggregator** (Coinalyze, for
  liquidation history only) — see the
  [Limitations](#honest-limitations-you-should-know) section for details.
- **Initial setup needs a few credentials** (Coinalyze API key + Vercel
  proxy) — not plug-and-play, there's a one-time manual configuration step.
- **Coinalyze free-tier rate limit** (40 requests/minute per API key) could
  become a bottleneck under very heavy use.
- No on-chain wallet data, and no data from exchanges other than Binance
  Futures USDS-M.

**Data sources: two paths, depending on the tool.**

- **Native Binance, via a Vercel relay proxy.** Binance's domain
  (`fapi.binance.com`) blocks traffic from Cloudflare Workers at the WAF
  level (403, company-wide — tested directly from this worker, not an
  assumption). Vercel uses a different IP pool, so it doesn't hit the same
  block. The Cloudflare Worker relays through a small proxy in `proxy/`
  (a separate Vercel project, see `proxy/README.md`). This path serves
  funding rate (current & history), klines/OHLCV, multi-timeframe bias,
  realized volatility, 24h stats, order book depth, aggregate trades, open
  interest (current & history), long/short ratio (blended & top-trader),
  taker buy/sell volume ratio, and spot price (the proxy also relays to the
  Binance Spot API `api.binance.com` via the `market=spot` parameter, see
  `proxy/README.md`).
- **[Coinalyze](https://coinalyze.net)**, now only for the one tool not yet
  migrated to the native path: liquidation history
  (`binance_get_liquidation_history`). Coinalyze re-aggregates the same
  underlying data (the original source is still Binance), and its API is
  itself hosted on Cloudflare, so it doesn't hit the same block.

As a consequence, this worker needs **two sets of credentials**:
`COINALYZE_API_KEY` and `PROXY_URL`/`PROXY_SECRET` (Vercel proxy) — see the
Setup section below.

## What's provided

| Tool | Function | Source |
|---|---|---|
| `binance_get_funding_rate` | Current funding rate + basis (mark vs index price deviation) | Binance native |
| `binance_get_funding_rate_history` | Funding rate trend over time | Binance native |
| `binance_get_spot_price` | Binance spot price + real basis vs futures mark price (different from the basis above, which is vs index price). Clear error if the pair is futures-only (not listed on Spot) | Binance native (Spot) |
| `binance_scan_funding_extremes` | Scans funding rate across ALL Futures pairs at once (1 bulk call), returns the top pairs most crowded long/short | Binance native |
| `binance_get_open_interest` | Current OI snapshot | Binance native |
| `binance_get_open_interest_history` | OI trend up/down | Binance native |
| `binance_get_long_short_ratio` | Aggregate long vs short ratio (blended, all traders) + trend | Binance native |
| `binance_get_top_trader_ratio` | Long/short ratio for top traders ONLY (pure breakdown, by account or position size) | Binance native |
| `binance_get_order_book_depth` | Order book snapshot (bid/ask), spread, largest wall | Binance native |
| `binance_get_order_book_imbalance` | Bid vs ask volume imbalance at depth 5/10/20, with a bias label (BULLISH/BEARISH/BALANCED) | Binance native |
| `binance_get_agg_trades` | Granular individual trades (buy/sell aggressor) for absorption detection | Binance native |
| `binance_get_liquidation_history` | Liquidation history | Coinalyze |
| `binance_get_taker_volume_ratio` | Aggressive buy/sell pressure (taker volume), official Binance statistic | Binance native |
| `binance_get_klines` | OHLCV candlesticks per timeframe, supports `startTime`/`endTime` (deep history, for backtesting, up to 1500 candles/call) | Binance native |
| `binance_get_multi_timeframe_bias` | Bullish/Bearish/Sideways bias across 5 timeframes at once (1m/5m/15m/1h/1d) | Binance native |
| `binance_get_realized_volatility` | Historical realized volatility (15m/1h) from log-returns, for grid-width calibration | Binance native |
| `binance_get_24hr_ticker` | 24-hour statistics summary (official rolling window) | Binance native |
| `binance_get_spot_ticker_24hr` | Spot version of 24h stats (price, % change, VWAP, volume, trade count) — compare against the Futures version above | Binance native (Spot) |
| `binance_get_spot_book_ticker` | Real-time best bid/ask + qty on Spot, lighter than a full order book | Binance native (Spot) |
| `binance_get_spot_order_book` | Spot order book depth (bid/ask, spread, largest wall) | Binance native (Spot) |
| `binance_get_spot_klines` | Spot OHLCV candlesticks per timeframe, supports `startTime`/`endTime` (up to 1000 candles/call) | Binance native (Spot) |
| `binance_get_spot_agg_trades` | Granular individual Spot trades (real CVD, not leverage) | Binance native (Spot) |
| `binance_get_spot_avg_price` | Spot moving average price (a few-minute window, more stable than last-trade) | Binance native (Spot) |
| `binance_check_spot_listing` | Checks whether a pair is listed on Binance Spot + trading status — used before calling other Spot tools for a pair that isn't certain to be listed | Binance native (Spot) |

## Analysis Framework

[`docs/mm_detection_framework.en.md`](docs/mm_detection_framework.en.md) (v4,
final) — a framework for detecting market maker activity footprints
(absorption, spoofing, stop hunt, basis arbitrage) by combining several of
the tools above. Every technical claim was validated against live data
before making it into the final version — including polling latency
(298-898ms per call, so the original suggestion of "<500ms polling" isn't
feasible through a regular MCP tool call), the liquidation data's field set
(no price-level info, only per-time-window), top-trader ratio divergence
thresholds (both a fixed number and a liquidity-tiered version turned out
not to fit — the real movement of every pair tested was far below them),
and the actual historical retention limit of Binance's own top-trader ratio
endpoint (~30 days max, not 90 days as originally assumed).

## Honest limitations you should know

- **The long/short ratio (`binance_get_long_short_ratio`) is a BLENDED
  aggregate ratio**, not a separate breakdown of "global account (retail)"
  vs "top trader (whale)". For a pure top-trader breakdown, use
  `binance_get_top_trader_ratio` (already native Binance, separate from
  this tool).
- **Funding rate basis can be noisy for small/newly-listed pairs** —
  Binance's index price is a weighted average across several spot
  exchanges, and one of them can be illiquid for such pairs.
- **Order book depth is a point-in-time snapshot** — a large wall can
  disappear within seconds (potential spoofing); don't over-interpret a
  single snapshot.
- **The "top trader" threshold is not precisely published by Binance**,
  and the data is a periodic snapshot, not real-time tick-by-tick.
- OI history data (`binance_get_open_interest_history`) is limited by the
  retention of Binance's official endpoint
  (`/futures/data/openInterestHist`) — not as long as Coinalyze's previous
  history; check directly if you need a long range.
- No on-chain wallet data.
- Coinalyze free tier: rate limit of 40 requests/minute per API key — now
  only applies to `binance_get_liquidation_history`.

## Setup: Coinalyze API Key (required, one-time)

1. Sign up for free at https://coinalyze.net
2. Grab the API key from your account page
3. Set it as a worker secret (not in `wrangler.toml`, not hardcoded):
   ```bash
   npx wrangler secret put COINALYZE_API_KEY
   ```
   (paste the API key when prompted)

Without this secret, `binance_get_liquidation_history` (the only tool
sourced from Coinalyze, see the table above) will fail with a clear error
message ("COINALYZE_API_KEY belum diset").

## Setup: Vercel Proxy (required, one-time)

Tools labeled "Binance native" in the table above need a relay proxy on
Vercel, because the Cloudflare Worker is blocked directly by Binance's WAF.
Full deployment details are in `proxy/README.md` — in short:

1. Deploy the `proxy/` folder as a separate Vercel project (Root Directory =
   `proxy`), and set the env var `PROXY_SECRET` on Vercel (a random string
   you generate yourself, e.g. `openssl rand -hex 32`).
2. Set these two secrets on the Cloudflare worker:
   ```bash
   npx wrangler secret put PROXY_URL
   npx wrangler secret put PROXY_SECRET
   ```
   `PROXY_URL` = the Vercel project's URL (example:
   `https://whale-pearl.vercel.app`), `PROXY_SECRET` = the exact same
   string set on Vercel.

Without these two secrets, tools labeled "Binance native" will fail with a
clear error message ("PROXY_URL atau PROXY_SECRET belum diset di worker").

**Important**: never create a Cloudflare secret with the VALUE as the NAME
(e.g. running `wrangler secret put` and accidentally pasting the value at
the name prompt). `wrangler secret list` should only ever leak secret
*names*, never values — this mistake leaks the real value through a
command that's supposed to be safe.

## Setup: Automated Deploy (GitHub Actions → Cloudflare Workers)

This repo already has a workflow at `.github/workflows/deploy.yml` that
automatically runs `wrangler deploy` on every push to the `main` branch.

### Setup steps (one-time)

**1. Create a Cloudflare API Token**

1. Open https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use the **"Edit Cloudflare Workers"** template
4. Scope it to your account, then create the token
5. Copy the token shown (only displayed once)

**2. Add the token as a GitHub Secret**

1. Open this repo on GitHub → **Settings** → **Secrets and variables** →
   **Actions**
2. Click **New repository secret**
3. Name: `CLOUDFLARE_API_TOKEN`
4. Value: the token from step 1
5. Save

**3. Trigger a deploy**

Deploy runs automatically as soon as there's a new push to `main`. To
trigger manually without a new push, open the **Actions** tab on the
GitHub repo → select the "Deploy to Cloudflare Workers" workflow →
**Run workflow**.

**4. Check the deploy result**

Once the workflow finishes (check the Actions tab), the worker will be
live at:
```
https://whalescope-mcp.<your-cloudflare-subdomain>.workers.dev
```

Open that URL — it should show a JSON status of `"ok"`.

## Setup: Custom Domain (whalescope-mcp.jaringan.dev)

This **cannot** be done via GitHub Actions — it needs a one-time manual
step in the Cloudflare dashboard:

1. Open https://dash.cloudflare.com → select your account
2. Open **Workers & Pages** → select the `whalescope-mcp` worker
3. Open the **Settings** tab → **Domains & Routes**
4. Click **Add** → **Custom Domain**
5. Enter `whalescope-mcp.jaringan.dev`
6. Cloudflare will automatically create the needed DNS record **if** the
   `jaringan.dev` domain is already in the same account's Cloudflare zone.
   If that domain is registered under a different account/registrar,
   you'll need to add a CNAME record manually pointing to the target
   Cloudflare shows you.

Once the custom domain is active, the worker is reachable at
`https://whalescope-mcp.jaringan.dev` (no longer the `.workers.dev`
domain).

## Register as a Custom Connector in Claude

1. Open Claude (claude.ai) → **Settings** → **Connectors**
2. Choose **Add custom connector**
3. Enter the URL: `https://whalescope-mcp.jaringan.dev/mcp`
   (or `https://whalescope-mcp.<subdomain>.workers.dev/mcp` if you haven't
   set up the custom domain yet — note the `/mcp` path at the end, it's
   required)
4. Save, then enable the connector for whichever conversations you want

## Manual testing before registering with Claude (recommended)

There's no automated test suite in this repo — `npm run typecheck` is the
only automated check. New/changed tools are verified manually via
`wrangler dev` + curl JSON-RPC.

```bash
npm install
npx wrangler dev
```

In another terminal, an example for a Binance-native tool:
```bash
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "binance_get_funding_rate",
      "arguments": { "symbol": "BTCUSDT" }
    }
  }'
```

If this returns valid funding rate + basis data for BTCUSDT, the Vercel
proxy path works. For the Coinalyze path, change `name` to
`binance_get_liquidation_history` — if that also returns valid data, the
Coinalyze path works.

## Cost

- Cloudflare Workers: free tier of 100,000 requests/day — far more than
  enough for personal trading-analysis use.
- Vercel (proxy relay): the Hobby free tier covers millions of serverless
  function invocations/month — won't incur cost for personal use. Note:
  `PROXY_SECRET` must be kept confidential, since anyone who knows the URL
  + secret can use this proxy's quota on your behalf.

You will most likely never be charged on either platform for personal use.

## Disclaimer

**This project is open source and public** — the source code, architecture,
and documentation (including the analysis framework in `docs/`) can be
viewed, cloned, and modified by anyone through this GitHub repo. No private
account data is stored or processed — every tool is read-only against
Binance's public API.

- **Not financial advice.** All data and interpretations (funding rate, OI,
  order book, MM-detection framework, etc.) are informational — the output
  of processing public data, NOT trading recommendations. There is no
  guarantee of accuracy, completeness, or timeliness of the data — check
  [Honest limitations you should know](#honest-limitations-you-should-know)
  for each tool's specific limitations before making decisions based on
  this data.
- **User responsibility.** Anyone who deploys, uses, or modifies this
  worker is fully responsible for the outcomes and consequences of their
  own use of it — including any trading decisions made based on these
  tools' output.
- **Compliance with Binance API Terms of Use.** This worker calls
  Binance's public endpoints (Futures & Spot). Personal/non-commercial use
  aligns with Binance's generally applicable terms; commercial
  redistribution of data or large-scale use should be checked separately
  against the [Binance API Terms of Use](https://www.binance.com/en/terms)
  — outside this project's responsibility.
- **License: [MIT](LICENSE).** Free to use, modify, and redistribute
  (including for commercial purposes), as long as the copyright notice and
  MIT license text are included. The software is provided "as is", with
  no warranty of any kind — consistent with the disclaimer above.
