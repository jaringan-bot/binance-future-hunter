# whale-binance-proxy

A small relay proxy on Vercel for fetching Binance Futures API data
directly, used as an alternate path because the Cloudflare Worker
(`whale.jaringan.dev` at the root of this repo) is fully blocked by
Binance's WAF (HTTP 403 on every endpoint, including `/fapi/v1/ping`).

Originally only used for a few endpoints (depth, aggTrades, top-trader
ratio). Since funding rate & klines were migrated from Coinalyze to native
Binance (fixing a price-precision/funding-scale bug for small pairs), this
proxy became the main path for most tools in the worker — see the root
repo's README for the full list of tools by data source.

## Why it's separate from the main worker

This is a SEPARATE FOLDER (`proxy/`) inside the same repo, but deployed as
its own Vercel project — not part of the Cloudflare Worker. Cloudflare
Workers and Vercel are two different hosting platforms with different IP
pools; an endpoint blocked on one platform is sometimes not blocked on the
other.

## Deploy setup

1. In the Vercel dashboard, create a new project from the
   `osindo-dev/whale` repo, set **Root Directory** to `proxy` (not the repo
   root).
2. Set the environment variable `PROXY_SECRET` to a random string you
   generate yourself (e.g. `openssl rand -hex 32`). DO NOT commit this
   value to git.
3. Deploy. Vercel will give you a URL like
   `https://whale-binance-proxy.vercel.app`.
4. Save this URL + `PROXY_SECRET` for use in the Cloudflare worker (via
   `wrangler secret put`), so the worker can call this proxy.

## Endpoint

```
GET /api/binance?path=<binance-path>&market=<futures|spot>&<other-params>
Header: x-proxy-secret: <PROXY_SECRET>
```

`market` is optional, defaults to `futures`. Set it to `spot` to relay to
the Binance Spot API (`api.binance.com`) instead of Futures
(`fapi.binance.com`) — used for the real futures-vs-spot basis (see
`binance_get_spot_price` in the worker).

Example:
```bash
curl -s "https://whale-binance-proxy.vercel.app/api/binance?path=/fapi/v1/ping" \
  -H "x-proxy-secret: <your-secret>"

curl -s "https://whale-binance-proxy.vercel.app/api/binance?path=/api/v3/ticker/price&market=spot&symbol=BTCUSDT" \
  -H "x-proxy-secret: <your-secret>"
```

## Allowed paths (whitelist)

The whitelist is split per market (see `ALLOWED_PATHS_BY_MARKET` in
`api/binance.ts`), so futures and spot paths don't get mixed up.

**`market=futures`** (default):
- `/fapi/v1/ping` — connectivity baseline
- `/fapi/v1/depth` — order book depth
- `/fapi/v1/aggTrades` — aggregate trades (for granular CVD)
- `/fapi/v1/fundingRate` — funding rate history (settled)
- `/fapi/v1/premiumIndex` — current funding rate + mark/index price (basis)
- `/fapi/v1/klines` — OHLCV candlesticks (also used by multi-timeframe bias
  & realized volatility)
- `/fapi/v1/ticker/24hr` — official 24-hour statistics
- `/fapi/v1/openInterest` — open interest snapshot
- `/futures/data/topLongShortAccountRatio` — top-trader ratio (account)
- `/futures/data/topLongShortPositionRatio` — top-trader ratio (position)
- `/futures/data/globalLongShortAccountRatio` — global ratio (all accounts)
- `/futures/data/openInterestHist` — open interest trend
- `/futures/data/takerlongshortRatio` — taker buy/sell volume ratio

**`market=spot`**:
- `/api/v3/ticker/price` — current spot price (used by `binance_get_spot_price`)
- `/api/v3/ticker/24hr` — spot 24-hour statistics (used by `binance_get_spot_ticker_24hr`)
- `/api/v3/ticker/bookTicker` — real-time best bid/ask (used by `binance_get_spot_book_ticker`)
- `/api/v3/depth` — spot order book (used by `binance_get_spot_order_book`)
- `/api/v3/klines` — spot candlesticks (used by `binance_get_spot_klines`)
- `/api/v3/aggTrades` — spot aggregate trades / real CVD (used by `binance_get_spot_agg_trades`)
- `/api/v3/avgPrice` — spot moving average price (used by `binance_get_spot_avg_price`)
- `/api/v3/exchangeInfo` — pair metadata & listing status (used by `binance_check_spot_listing`)

To add a new path, edit the relevant market's whitelist in
`ALLOWED_PATHS_BY_MARKET` (`api/binance.ts`) — DO NOT open up a generic
proxy without a whitelist, so this proxy can't become a backdoor for
fetching any Binance endpoint (including trading/private endpoints that
require an API key, which must NOT go through a public proxy like this).
