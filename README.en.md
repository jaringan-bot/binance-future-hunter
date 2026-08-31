# WhaleScope MCP — Binance Futures Market Intelligence

[🇮🇩 Bahasa Indonesia](README.md) | 🇬🇧 English

MCP server that exposes public Binance USDS-M Futures data (funding rate,
open interest, long/short ratio, taker volume, candlesticks, order book,
volatility) plus a Binance Spot comparison layer (price, order book,
candlesticks, CVD) as tools callable by Claude. All data served is
**public, read-only** — no order placement/trading, no access to private
account data.

## Quick Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/osindo-dev/whalescope-mcp)

This button clones the repo and creates a Worker in your own Cloudflare
account, including **auto-provisioning a new KV namespace & D1 database**
(Cloudflare generates fresh `id`/`database_id` values for your account, no
manual creation needed). **Not fully zero-touch** — to be honest about
what's still manual: you STILL need to set secrets afterward (Cloudflare
can't guess values from external services) — see `.dev.vars.example` in
this repo for the full list, or
[Vercel Proxy setup](#setup-vercel-proxy-required-one-time) below.
`PROXY_URL`/`PROXY_SECRET` are REQUIRED (all 46 tools need them).

## Purpose

Provide a picture of Binance Futures market positioning — not just price,
but also *who* is holding what (retail vs top trader), *how crowded* the
leverage is, and *at what price* liquidity is stacked — directly inside a
conversation with Claude, without needing a separate exchange dashboard.

## Benefits

- **One door for many signals.** Funding rate, open interest, order book,
  and order flow — all through a single MCP connector, no tab-switching.
- **Distinguish retail from whale.** `binance_get_top_trader_ratio` gives a
  pure top-trader breakdown (separate from `binance_get_long_short_ratio`,
  which is blended) — useful for spotting divergence between retail and
  whale positioning.
- **Native Binance where it matters.** Price, funding rate, klines, order
  book — all through the native Binance path (not a third-party derivation),
  so precision holds up especially for smaller/less liquid pairs.
- **Free for personal use** — see the [Cost](#cost) section.

## Strengths

- 29 tools covering five analytical angles: directional market bias, key
  price areas (order book), execution confirmation (order flow/aggressor),
  Futures-vs-Spot comparison (leverage-driven vs real demand), and
  market-wide scanning (extreme funding rates across every pair, or
  comparing a metric across several pairs) — plus a composite tool
  (`binance_analyze_pair`) for a quick overview without many tool calls,
  and config/history tools (per-pair thresholds, basis time-series) backed
  by Workers KV.
- Read-only with respect to Binance market data — no order placement or
  trading. The one tool that writes state (`binance_set_pair_threshold`)
  only stores your own threshold preference in Workers KV; it never
  touches a Binance account or any third-party data.
- Transparent about each tool's limitations (see the section below), not
  glossed over as if all data were perfect.
- Infrastructure fits comfortably in free tiers (Cloudflare Workers +
  Vercel Hobby) for personal use — 100% Binance-native, no third-party
  aggregator dependency anymore.

## Weaknesses

- **Most tools are request/response.** Funding/OI/klines/order book/ratios are
  all snapshots or periodic history. Streaming data is limited to
  `binance_get_realtime_liquidations` + `binance_get_contract_events` (via the
  VPS stream gateway, below) — no tick-by-tick push for price / order book.
- **Liquidations: SAMPLED, not exhaustive.** Since 2026-08-28,
  `binance_get_realtime_liquidations` reads a 24h buffer from an always-on
  WebSocket (`!forceOrder@arr` via `dstream.binance.com`) held on an Oracle
  Singapore VPS (`stream-gateway/`, outside Cloudflare — the Worker itself is
  still WAF-blocked from Binance; `fstream.binance.com` is silently
  black-holed from the VPS IP, `dstream` carries the same feed). Binance
  throttles the stream to 1 event/symbol/second, so this is a sample. Still
  enough to confirm stop-hunt liquidation clusters in
  `binance_detect_mm_activity` (a 3rd, price-anchored, hunt-side proxy). No
  long liquidation history (24h buffer).
- **Initial setup needs a Vercel proxy** (required) — not plug-and-play,
  there's a one-time manual configuration step.
- No on-chain wallet data, and no data from exchanges other than Binance
  Futures USDS-M.

**Data sources: one path, 100% Binance native.**

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

As a consequence, this worker needs `PROXY_URL`/`PROXY_SECRET` (Vercel
proxy, required for all 46 tools) — see the Setup section below.

**Caching & state, no extra credentials needed.** Upstream responses
(funding rate, klines, OI, etc. — except order book & aggregate trades,
which need strict freshness) are cached in tiers (5 seconds to 1 hour
depending on the endpoint) via Cloudflare Workers' built-in Cache API, no
setup required. Per-pair custom thresholds are stored in Workers KV
(binding `CONFIG_KV`). Time-series data (basis+funding+OI, and
`binance_detect_mm_activity`'s 6 signal scores) is stored in D1 (binding
`DB`) — filled in automatically by a Cron Trigger every 5 minutes for a
fixed 50-pair watchlist (`SNAPSHOT_WATCHLIST` in `src/shared.ts`, ordered
by market cap, e.g. BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, etc.).

**Cross-exchange, no extra proxy needed.** `whalescope_compare_funding_across_exchanges`
accesses Bybit/OKX/Hyperliquid DIRECTLY from the worker (tested from real
Cloudflare edge, no WAF/geo-block like Binance) — no credentials or extra
setup needed for those 3 exchanges.

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
| `binance_analyze_pair` | Quick composite overview of one pair: funding, OI trend, top-trader trend, taker volume, order book, price bias — 6 tools at once in a single call | Binance native |
| `binance_compare_symbols` | Compare one metric (funding rate, 24h % change, OI, top-trader ratio, taker ratio) across 2-10 pairs at once, sorted from most extreme | Binance native |
| `binance_set_pair_threshold` | Set a custom funding/basis threshold per pair (overrides the ±0.03%/±0.05% default), stored in Workers KV | Workers KV |
| `binance_get_pair_threshold` | Check the custom threshold already set for a pair | Workers KV |
| `binance_get_basis_history` | Time-series basis+funding+OI history (Cron snapshot every 5 min to D1) — always available for the fixed 50-pair watchlist, best-effort for other frequently-queried pairs — detects "basis widens then reverts" without manual repeated checks | D1 + Cron Trigger |
| `binance_get_orderbook_delta` | 2 order book snapshots ~1-2 seconds apart, compares walls between them for REAL spoofing detection (a wall gone without price actually trading through that level) — unlike `binance_get_order_book_depth`, which is just 1 snapshot | Binance native |
| `binance_detect_mm_activity` | Score + tier (Weak/Moderate/Strong/Extreme) from 6 MM/whale signals at once (absorption, real 2-snapshot spoofing, symmetric stop-hunt + OI-drop proxy + trade-volume-concentration proxy, basis arbitrage, OI divergence, funding extreme) — replaces 5-6 manual tool calls. Stop-hunt is STILL without real liquidation data (permanently removed), see [Honest limitations](#honest-limitations-you-should-know) | Binance native |
| `binance_market_regime` | Classifies current market condition: TRENDING_UP/DOWN, RANGING, BREAKOUT, ACCUMULATION, DISTRIBUTION — uses ADX(14), OI trend, CVD, volatility/volume spike ratio | Binance native |
| `binance_backtest_signal` | Empirically validates `binance_detect_mm_activity` signals: win rate/avg return/max drawdown from D1 signal history (fixed watchlist), forward return computed on-demand from historical klines | D1 + Binance native |
| `whalescope_backtest_pipeline_decisions` | Tests stored `full_pipeline` decisions in `pipeline_decision_log` (entry-alert Phase 2 + `persist=true`): win rate / avg return / SL-touch by decision (TRADE/WATCH/NO_TRADE) and score bucket (`lt_40` / `40_55` / `gte_55`). Forward return is on-demand from klines — not a precomputed column, not weight auto-tuning | D1 + Binance native |
| `binance_analyze_smart_money` | Smart money (top trader) vs retail (global account) divergence score from 5 variables: top trader ratio, global account ratio, OI delta, funding rate, orderbook imbalance — condition LONG_LIQUIDATION_RISK/BULLISH_ACCUMULATION/SHORT_SQUEEZE_RISK/NEUTRAL + confidenceScore. Different from `binance_detect_mm_activity` (6 absorption/spoofing/stop-hunt/basis-arb signals) — narrowly focused on top-trader-vs-retail | Binance native |
| `whalescope_compare_funding_across_exchanges` | Compares funding rate, last price, open interest, and 24h change for one pair across Binance/Bybit/OKX/Hyperliquid, flags divergence — cross-confirms MM detection signals across venues. The only tool that is NOT Binance-only | Binance native + Bybit + OKX + Hyperliquid |
| `binance_get_tool_catalog` | Lists all tools with category/token-cost/use-case, filterable by category — check this before calling many individual tools. Name+description are auto-pulled from the tool registry (always accurate); category/token-cost stay manual | Semi-automatic |
| `binance_get_adl_risk` | Auto-Deleveraging risk rating (LOW/MEDIUM/HIGH) per pair, updated every 30 minutes | Binance native |
| `binance_get_insurance_fund_balance` | Historical snapshot of insurance fund balance per margin asset | Binance native |
| `binance_get_mark_price_klines` | Candlesticks from MARK PRICE (liquidation/funding reference), not the traded price | Binance native |
| `binance_get_index_price_klines` | Candlesticks from INDEX PRICE (blended across spot exchanges), the basis for premium index/funding | Binance native |
| `binance_get_premium_index_klines` | Candlesticks from PREMIUM INDEX (mark vs index price ratio), the main component of the funding rate | Binance native |
| `binance_get_continuous_klines` | Candlesticks for PERPETUAL/CURRENT_QUARTER/NEXT_QUARTER contracts per underlying pair | Binance native |
| `binance_get_quarterly_settlement_price` | Historical delivery/settlement price for quarterly contracts (not applicable to perpetuals) | Binance native |
| `binance_get_composite_index_info` | Base asset composition + weights for a composite index symbol (e.g. BTCDOMUSDT) | Binance native |
| `binance_get_index_constituents` | List of exchanges+prices+weights making up a pair's index price | Binance native |
| `whalescope_full_pipeline` | The FULL Futures Grid Bot decision chain (highest-level composite tool): hard screen → Tier-1 intelligence (smart money, MM composite, 1h+4h regime, order book) → Compass-equivalent grid bound calculation (ATR + swing high/low) → EXACT capital-solve against a loss budget (`risk_usd`) per leverage option → TRADE/WATCH/NO_TRADE decision + copy-paste-ready Grid Bot config, for 1-20 symbols at once. `persist=true` (optional) writes a compact row to `pipeline_decision_log` (`source=manual` or `dropstab` + `persist_ref` tab slug). HIGH token cost — see [`docs/full_pipeline_framework.md`](docs/full_pipeline_framework.md) (`docs/full_pipeline_framework.en.md` for the English mirror) | Binance native |

## The `detail` convention: summary vs full (token efficiency)

Every tool above that returns array/history data (klines, agg trades, order
book, open interest/funding/basis history, long-short &
top-trader ratio) has an optional `detail: "summary" | "full"` parameter,
defaulting to `"summary"`. This is the **only intentional default-behavior
change** in the 2026-08 token-efficiency update — not a parameter removal,
just a new default:

- `detail: "summary"` (default) — only derived metrics (bias, trend, CVD,
  dominance, etc. — whatever the tool already computes internally) + up to
  10 most recent data points. This is what you get if you don't send
  `detail` at all, INCLUDING for existing callers that don't know this
  param exists yet.
- `detail: "full"` — the full raw array/levels, identical to the
  pre-update behavior.

Composite tools (`binance_analyze_pair`, `binance_analyze_smart_money`,
`binance_detect_mm_activity`, `analyze_futures_grid_risk`,
`whalescope_full_pipeline`) were also tightened: text capped to ~8-12 lines,
`structuredContent` is now the primary payload with shorter/flatter keys,
empty (null/undefined) fields dropped. **No signal or metric was lost** —
everything stays reachable via `structuredContent` or `detail: "full"`.

Full details + renamed-field mapping:
[`docs/tool_response_reference.en.md`](docs/tool_response_reference.en.md).

## Analysis Framework: Market Maker & Whale Detection

No tool can see a market maker (MM)/whale's identity or specific position
directly — Binance's public data simply doesn't expose that. What this
framework does instead: read the **footprints** their activity leaves
behind by combining several of the tools above, then score how strongly
those patterns line up.

**Four signal categories detected:**

| Signal | Main tools | Example pattern |
|---|---|---|
| **Absorption** | order book depth, agg trades (futures & spot), open interest | CVD flat/rising while price stalls = sell pressure being absorbed (accumulation); sharp OI spike + sideways price = a large position just opened |
| **Spoofing** | order book depth, `binance_get_orderbook_delta` (2-snapshot) | A large wall appears then disappears before it's ever filled without price actually trading through it; spread suddenly widens then normalizes within seconds |
| **Stop hunt** | open interest, agg trades, klines | A long wick (either direction) + small body reversal candle, boosted by an OI-drop proxy + aggressive trade-price concentration proxy — still no real liquidation confirmation (permanently removed, see Weaknesses) |
| **Basis arbitrage** | spot price, funding rate, open interest | Spot-futures basis widens then quickly reverts; extreme funding + rising OI (suggests a short-futures/long-spot hedge) |

**Rule of thumb:** if **≥3 signals align** within the same timeframe, the
indication of MM activity is strong enough to act on — this is a checklist
heuristic (see the confidence tiers in the full document), **not** a
statistically calibrated probability.

Full document: [`docs/mm_detection_framework.en.md`](docs/mm_detection_framework.en.md)
(v4, final) — contains detailed criteria per signal, a step-by-step
workflow, a live checklist, and a tool → signal mapping.

## Framework: Full Pipeline Grid Bot (`whalescope_full_pipeline`)

The highest-level composite tool in this repo — runs the ENTIRE Futures
Grid Bot decision chain in a single tool call, for one or many symbols at
once (max 20 per call), replacing ~8 manual tool calls
(`binance_market_regime` ×2, `binance_analyze_smart_money`,
`binance_detect_mm_activity`, `binance_get_order_book_imbalance`,
`analyze_futures_grid_risk`, etc.) plus grid-bound math that previously had
no tool at all.

**Stages (2-wave fetch, reject-early):**

```
┌───────────────────────────────────────────────────────────────┐
│ WAVE 1 (all symbols, parallel): ticker24hr, funding, 1h+4h      │
│ klines, OI+history, agg trades, market context                  │
├───────────────────────────────────────────────────────────────┤
│ HARD SCREEN: tradable? volume >= minimum? |funding| <= max?     │
│ regime 1h/4h != BREAKOUT?                                       │
│   → FAIL = NO_TRADE, WAVE 2 IS NEVER CALLED                     │
├───────────────────────────────────────────────────────────────┤
│ WAVE 2 (survivors only, parallel): top-trader ratio, global     │
│ account ratio, 24-point OI history, depth-50 order book         │
├───────────────────────────────────────────────────────────────┤
│ TIER-1 SCORING: smart money divergence + 6 MM composite scores  │
│ + order book imbalance + CVD + regime → rankingScore 0-100      │
├───────────────────────────────────────────────────────────────┤
│ GRID BOUNDS (Compass-equivalent): ATR + swing high/low →        │
│ upper/lower/SL/TP/gridCount/gridType                             │
├───────────────────────────────────────────────────────────────┤
│ CAPITAL SOLVE: exact (not iterative) per leverage option, picks │
│ the highest leverage that's SAFE/MODERATE with safe liquidation │
├───────────────────────────────────────────────────────────────┤
│ DECISION: TRADE / WATCH / NO_TRADE + ready-to-use Grid Bot config│
└───────────────────────────────────────────────────────────────┘
```

Full document (stage-by-stage, worked example, Known Limitations):
[`docs/full_pipeline_framework.en.md`](docs/full_pipeline_framework.en.md).

### Empirical Validation Results

Every technical claim in this framework was validated directly against the
deployed worker (not assumed) before making it into the final version. A
few findings that corrected the original assumptions:

| Original claim | Validation result |
|---|---|
| <500ms polling for refresh-rate spoofing detection | ❌ Real latency is 298-898ms/call (avg ~485ms) through the worker→Vercel→Binance proxy chain — not reliable for that |
| Universal top-trader ratio divergence threshold (flat >15% or tiered 3-15%) | ❌ Never triggered — real movement across the 4 pairs tested (SOLUSDT, BNBUSDT, LINKUSDT, AVAXUSDT) over a 2-hour window was only 0.40-2.35 points, far below either threshold |
| Top-trader ratio historical retention "30-90 days" | ⚠️ Corrected — 90 days isn't available from Binance at all; 30 days only at coarse resolution (4h/1d), 15-minute resolution goes back only ~5 days |
| Calm-market conditions (BTCUSDT) don't over-trigger | ✅ Confirmed — score ~1-1.5/6 (Weak tier) during sideways market, no false alarms under normal conditions |

Full detail (including raw test data per claim): Section 10,
[`docs/mm_detection_framework.en.md`](docs/mm_detection_framework.en.md#10-empirical-validation).

## Honest limitations you should know

- **The long/short ratio (`binance_get_long_short_ratio`) is a BLENDED
  aggregate ratio**, not a separate breakdown of "global account (retail)"
  vs "top trader (whale)". For a pure top-trader breakdown, use
  `binance_get_top_trader_ratio` (already native Binance, separate from
  this tool).
- **Funding rate basis can be noisy for small/newly-listed pairs** —
  Binance's index price is a weighted average across several spot
  exchanges, and one of them can be illiquid for such pairs.
- **Order book depth (`binance_get_order_book_depth`) is a point-in-time
  snapshot** — a large wall can disappear within seconds (potential
  spoofing); don't over-interpret a single snapshot. For REAL spoofing
  detection (2-snapshot), use `binance_get_orderbook_delta` or
  `binance_detect_mm_activity` (see below).
- **The "top trader" threshold is not precisely published by Binance**,
  and the data is a periodic snapshot, not real-time tick-by-tick.
- OI history data (`binance_get_open_interest_history`) is limited by the
  retention of Binance's official endpoint
  (`/futures/data/openInterestHist`); check directly if you need a long
  range.
- No on-chain wallet data.
- **Liquidations are near-real-time + SAMPLED, with no long history.**
  `binance_get_realtime_liquidations` reads a 24h buffer from the VPS stream
  gateway (`!forceOrder@arr` via `dstream.binance.com` — `fstream.binance.com`
  is black-holed from the VPS IP). Binance throttles to 1 event/symbol/second
  → a sample, not every liquidation. No public market-wide REST endpoint for
  a historical backfill. The Cloudflare Worker itself still can't open a WS
  to Binance directly (WAF).
- **`binance_detect_mm_activity`: spoofing is now REAL 2-snapshot
  detection** (~1-2 seconds slower because of it, explicit 1500ms gap
  between the 2 fetches — see `binance_get_orderbook_delta`), no longer a
  1-snapshot heuristic. **Stop-hunt is now symmetric** (checks both upper
  AND lower wick, used to only check upper — a bug) **+ 2 independent
  proxies** (reuse existing fetches, no new calls): OI dropping >=2%
  coinciding with the wick candle, and/or aggressive trade volume >=30%
  concentrated right in the wick's price zone (from the last 100
  aggTrades, the same data already used for CVD). Confidence scales with
  how many proxies confirm: 0 active = base, 1 = higher, both at once =
  highest — STILL WITHOUT real liquidation-by-price data (permanent, see
  the point above). Stop-hunt confidence is still lower than the other
  signals in the same tool — noted in the evidence text of every
  response.
- **`binance_market_regime`: volatility/volume spike ratios are computed
  relative to the same fetch window** (last 10 candles vs the prior 10),
  not a long-term historical baseline.
- **D1 time-series (`market_snapshots`, read by `binance_get_basis_history`)
  is ALWAYS available for the fixed 50-pair watchlist, best-effort for
  other pairs** — a non-watchlist pair gets history once it's queried >=3
  times within ~24h AND ranks in the top-5 most-queried non-watchlist pairs
  (KV counter, `src/queryFrequency.ts`); the 5-minute cron only snapshots
  it once that condition is met. `signal_history` (read by
  `binance_backtest_signal`) remains watchlist-only, not extended.
- **Futures-only pairs (HYPEUSDT, 1000PEPEUSDT, PUMPUSDT, …) — `spot_price`
  & `basis` are NULL in `market_snapshots`** because they aren't listed on
  Binance Spot. Funding rate & Open Interest are still recorded normally;
  only the basis columns are empty for those pairs.
- **No pruning/retention for D1 rows yet** — rows grow unbounded over time
  (at 50 pairs, D1's free tier of 5M writes/day and 5GB storage has
  headroom for a long while, but this isn't a permanent solution).
- **The KV→D1 basis-history migration does NOT backfill old data** — basis
  history that was stored in Workers KV before this migration is gone; the
  24-hour window refills naturally a few hours after deploy.
- **`binance_backtest_signal`: forward returns are computed ON-DEMAND from
  historical klines** (nearest 1h candle close to the target time), NOT a
  simulation of real order execution — slippage/fees/partial fills aren't
  accounted for. Small sample sizes (under ~20 signals) mean low
  confidence — don't conclude a signal is "reliable" from little historical
  data (data only starts accumulating from when this feature was deployed,
  not retroactively).
- **`pipeline_decision_log` + `whalescope_backtest_pipeline_decisions`:**
  per-symbol Phase 2 entry-alert decisions (and `persist=true`) are stored
  compactly for 90 days. Forward return / SL-touch are computed on-demand
  from klines — **not** precomputed, **not** auto-tuning the 35/30/20/15
  weights or the 55 threshold. `entry_alert_skip_log` retention is 30 days.
  The initial formula is **frozen** during the test (24h peek is read-only;
  serious review at 14 days; do not retune until ≥20 TRADE with completed
  4h+24h returns across ≥3 distinct 4h regimes; 14 days of TRADE=0 **is**
  the result that 55 is too tight). Full protocol:
  [`docs/full_pipeline_framework.en.md` §12](docs/full_pipeline_framework.en.md).
- **`whalescope_compare_funding_across_exchanges`: Open Interest hasn't
  been cross-validated against live data** across the 4 exchanges (SHOULD
  be base-asset denominated on all of them, including OKX which uses the
  `oiCcy` field, but no direct check has been done yet — double-check if
  the numbers look off). Binance→other-exchange symbol mapping is
  best-effort (strips the USDT suffix) — a pair not listed on
  Bybit/OKX/Hyperliquid shows as "failed" on that row instead of failing
  the whole tool call.
- **The Binance-proxy rate-limit self-throttle is best-effort, NOT a hard
  global limiter** — an in-memory per-isolate counter
  (`src/rateLimiter.ts`), effective as long as the same isolate handles
  consecutive requests, but this worker is stateless per-request so it's
  not a hard cross-isolate guarantee. Threshold is 200 requests/minute,
  count-based (not weight-based per endpoint like Binance's actual limit).
- **`binance_get_tool_catalog` is semi-automatic** — name+description are
  ALWAYS accurate (pulled from the tool registry, never stale or missed).
  But category/token-cost/dependencies stay manual (`CATALOG_METADATA` in
  `src/tools/catalog.ts`) — a new tool not yet curated shows up with
  category `"uncategorized"`, still visible (never silently omitted) but
  not neatly categorized yet.
- **`binance_analyze_smart_money` uses FIXED thresholds** (not the result
  of per-pair statistical calibration) — see Section 4.2 & 12 of
  `docs/mm_detection_framework.en.md` for why absolute thresholds on the
  top-trader ratio need to be used carefully. Its `confidenceScore` output
  measures margin past threshold, NOT a calibrated statistical probability.

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

### Secondary / failover proxy (optional)

If the primary proxy hits a WAF block/rate-limit/5xx, the worker
automatically tries a secondary proxy — but only if one is configured.
Without it, behavior is identical to before (single proxy, error thrown
immediately on failure).

1. Deploy a SECOND Vercel instance from the same `proxy/` folder (a
   different region if you like, e.g. Hong Kong vs Singapore) with its own
   `PROXY_SECRET` (can differ from the primary).
2. Set two additional secrets:
   ```bash
   npx wrangler secret put PROXY_URL_2
   npx wrangler secret put PROXY_SECRET_2
   ```

Failover only triggers for errors related to tier health/credentials (401
wrong secret, 403 WAF block, 429 rate limit, 5xx) — not for genuine request
errors (400 bad symbol, 404), which would fail identically on any tier.
401 is INTENTIONALLY included (a change from the earlier version) because
each proxy tier has its OWN secret — a wrong primary secret doesn't mean
the secondary's is wrong too.

### Direct fallback (last-resort tier, automatically ON)

If primary AND secondary (if configured) both fail, the worker
automatically tries hitting `fapi.binance.com`/`api.binance.com` directly,
with no proxy at all, as a last resort. No setup needed (ON by default) --
set `DISABLE_DIRECT_FALLBACK=true` as a worker environment variable (a
plain var, not a secret) to turn it off. See the "DIRECT FALLBACK" comment
in `src/binanceProxyClient.ts` for details and an honest note on why this
tier will likely still hit the WAF block in current production conditions
(this Cloudflare Worker is ALREADY CONFIRMED to be blocked by Binance
directly) -- it's still useful for local `wrangler dev` (different IP pool
than the production Cloudflare edge) and as a safety net if the block
policy ever changes.

## Setup: Workers KV (required, one-time — if you fork/deploy this repo yourself)

The KV namespace `id` in this repo's `wrangler.toml` is tied to the
Cloudflare account that created it — if you fork/clone and deploy to your
own account, you must create a new namespace:

```bash
npx wrangler kv namespace create WHALESCOPE_CONFIG
```

Copy the resulting `id` into `[[kv_namespaces]]` in `wrangler.toml`,
replacing the old `id` value (leave the binding name as `CONFIG_KV` — the
worker code refers to that binding name, not the id). Without this,
`binance_set_pair_threshold` and `binance_get_pair_threshold` will fail
with a clear error ("CONFIG_KV belum ke-bind di worker").

## Setup: Workers D1 (required, one-time — if you fork/deploy this repo yourself)

Same as KV above, the D1 `database_id` in this repo's `wrangler.toml` is
tied to the Cloudflare account that created it. If you fork/deploy to your
own account:

```bash
npx wrangler d1 create whalescope-mcp-db
```

Copy the resulting `database_id` into `[[d1_databases]]` in
`wrangler.toml` (leave the binding as `DB`), then run the migration:

```bash
npx wrangler d1 migrations apply whalescope-mcp-db --remote
```

Without this, `binance_get_basis_history` and `binance_backtest_signal`
will fail with a clear error ("D1 database (binding DB) belum ke-bind di
worker"), and the basis+MM-signal Cron Trigger (every 5 min) will fail
silently each tick (logged to Workers Logs, doesn't break the `/mcp`
endpoint).

## Admin: Usage Log (OPTIONAL)

A public worker is easy to find (listed on the [MCP Server Registry](https://registry.modelcontextprotocol.io/))
-- so there's a small endpoint to see who's connecting. **This is NOT an
MCP tool** (deliberately a separate HTTP endpoint, never shows up in
`tools/list`) -- if it were a regular tool, ANYONE connected to this
server could see other visitors' IPs, which defeats the purpose.

1. Set the secret (without it, the endpoint always returns 403 -- the
   feature is off by default, safe):
   ```bash
   npx wrangler secret put ADMIN_SECRET
   ```
2. Access it:
   ```bash
   curl "https://<worker-url>/admin/usage?key=<ADMIN_SECRET>&hours=24"
   ```
   Returns JSON: total requests, distinct IP count, top 20 IPs (with
   country + count), and the last 20 raw requests. Default window is 24
   hours, adjustable via `hours`.

Data is stored in D1 (`request_log`), auto-pruned every Cron tick for
rows older than 30 days (unlike `market_snapshots`/`signal_history`,
this table isn't bounded by the fixed watchlist, so it can grow if there's
real outside traffic).

## Monitoring & Alerting

This backend has several silent failure points (Vercel/VPS proxy down, stream
gateway WS dropped, Cron Trigger Cancel'd platform-side). What exists today
all goes through **Telegram** (needs `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
set — otherwise alerts only reach Workers Logs):

| Check | Cron | Alerts when |
|---|---|---|
| `checkHeartbeat` (`heartbeatCron.ts`) | 3×/day | 8h with zero TRADE/WATCH signals — one message distinguishing "quiet market + backend healthy" vs ">30% of pairs failing each tick = backend problem" vs "no data = cron dead" |
| `checkEntryAlertCronFreshness` (`heartbeatCron.ts`) | piggybacks `*/5` | no entry-alert tick COMPLETED within 40 min (detects platform-Cancel'd ticks) — 1h cooldown |
| `checkStreamGatewayHealth` (`infraHealthCron.ts`) | piggybacks `*/5` | VPS stream gateway `:8081/health` unreachable, WS to Binance down, or buffer stale >5 min — 1h cooldown |
| `checkMarketSnapshotFreshness` (`infraHealthCron.ts`) | piggybacks `*/5` | zero new `market_snapshots` rows in 20 min (the `*/5` snapshot cron stopped writing) — 1h cooldown |
| `checkD1Capacity` (`infraHealthCron.ts`) | 3×/day (piggybacks `HEARTBEAT_CRON`) | `market_snapshots` + `signal_history` (the two unpruned tables) combined past 5M rows — 24h cooldown |

All checks are KV-gated (at most one alert per cooldown while the condition
persists), safe to run every 5 minutes.

**Still missing** (dashboard work, not code):

- **External uptime monitor** on the worker `/` + relay `https://<vps>/health`
  — UptimeRobot / Cloudflare Health Checks (free, 5-min). Fastest way to catch
  a total VPS/relay outage; the internal checks above are only a lagging
  backstop.
- **Cloudflare notification** for Workers error-rate spikes / CPU-limit hits —
  observability (`[observability] enabled = true`) only collects data, no
  alerting rule.

## Security: DNS Rebinding Protection (OPTIONAL)

The `/mcp` endpoint validates the `Origin` header before processing a
request -- by default it allows `https://claude.ai`/`https://claude.com`
(and requests with NO `Origin` header at all, which covers the majority of
server-to-server MCP clients, including how this worker is actually used
as a custom connector). Requests with a disallowed `Origin` are rejected
with 403. This replaces the SDK's built-in options
(`enableDnsRebindingProtection`/`allowedHosts`/`allowedOrigins`), which are
`@deprecated` in `@modelcontextprotocol/sdk` -- the SDK now recommends
external middleware, which is what this is.

If you have your own web app that needs to call `/mcp` directly from the
browser, add its origin:
```bash
npx wrangler secret put ALLOWED_ORIGINS
# example value: https://your-app.com,https://staging.your-app.com
```
(comma-separated, spaces after commas are fine too -- auto-trimmed.)

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

### Example Usage

Once the connector is active, just ask in normal conversation — Claude
decides which tool(s) to call, and how many times, based on the question:

- *"What's BTCUSDT's funding rate right now, any sign of crowding?"* →
  `binance_get_funding_rate`
- *"Which pair has the most extreme funding rate across the whole market
  right now?"* → `binance_scan_funding_extremes`
- *"Give me a full overview of ETHUSDT — funding, OI, order book, price
  bias"* → `binance_analyze_pair` (composite, 1 call instead of 6 separate
  ones)
- *"Any signs of market maker activity in SOLUSDT lately?"* → a combination
  of tools (order book, agg trades, OI, liquidation, klines) following the
  [Analysis Framework](#analysis-framework-market-maker--whale-detection)
  above — just name the pair, Claude runs the detection workflow
- *"Compare the funding rate of BTC, ETH, SOL, and BNB"* →
  `binance_compare_symbols`
- *"Is it worth opening a Futures Grid Bot on BTCUSDT and ETHUSDT right now,
  $20 loss budget?"* → `whalescope_full_pipeline` (highest-level composite,
  1 call runs hard screen → Tier-1 intel → grid bounds → risk sizing →
  TRADE/WATCH/NO_TRADE decision + copy-paste-ready Grid Bot config for both
  pairs at once)

Since every tool is read-only, it's safe to ask anything about market data
without risking triggering an order/trade — this worker has no such
capability at all.

## Manual testing before registering with Claude (recommended)

`npm test` (vitest) + `npm run typecheck` are the automated checks in this
repo — but both only cover pure logic (scoring functions, D1/KV wrappers,
tool handlers via a fake `McpServer`), NOT the real Workers `fetch`/
`scheduled` handlers (no `@cloudflare/vitest-pool-workers` setup). New/
changed tools still need manual verification via `wrangler dev` + curl
JSON-RPC for that.

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
proxy path works.

## Audit & Results

### Token Efficiency

MCP tool responses go straight into Claude's context window — unlike a
normal REST API, where response size is comparatively free. This repo used
to have a few tools that quietly wasted tokens; they've since been fixed
and verified against the live worker (2026-08-12):

| Finding | Before | After |
|---|---|---|
| `binance_get_klines`/`spot_klines` — `structuredContent.candles` always included the full array | ~14,400 tokens at `limit=500` (57.7KB), up to ~43,000 tokens at the max limit of 1500 | Opt-in via the `includeCandles` parameter (default `false`) — default returns only a summary (bias, swing high/low, last 15 candles) |
| 6 history tools (OI history, long/short ratio, top trader ratio, funding rate history, taker volume ratio, liquidation history) — unbounded text table rows | 20-29KB (~5,000-7,250 tokens) per call at `limit=500` | Truncated to the last 15 rows in text — summary stats (avg/trend/dominance) are still computed from the FULL fetched set, not just what's displayed |
| The 5 longest tool descriptions (funding_rate, top_trader_ratio, spot_price, klines, spot_klines) | 16,869 characters total | 15,671 characters (~7%, ~300 tokens saved on the one-time tool-list load per session) |
| `binance_scan_funding_extremes` — `structuredContent.crowdedLong/crowdedShort` duplicated the array already shown in the text table | ~2.9KB at `limit=50` (max) | Just `topSymbolLong`/`topSymbolShort` (the single most extreme symbol per side) — the full ranked list stays in the text table |

Re-verify anytime:

```bash
npm run token-audit
```

Calls the deployed worker directly, measures tool schema size, response
size across `limit` scales, and an "Information Density Ratio" (data vs.
boilerplate) for a few representative tools, plus a simulated realistic
multi-turn conversation. Not part of `npm test`/CI (hits the live worker +
Binance through it) — used manually to check the token impact of
tool description or response format changes. Token estimation uses a
chars/4 heuristic (no publicly published Claude tokenizer package exists),
so the numbers are approximate — useful for relative comparison
(before vs. after a change), not exact token counts.

### Security

- **Symbol input validation.** `symbolSchema` (used by every tool that
  takes a `symbol` parameter) is capped at 20 characters and only accepts
  `[A-Z0-9_]`. There was previously no bound — since the symbol is used
  directly as part of Workers KV keys (`threshold:${symbol}`,
  `basis_history:${symbol}`), unbounded input risked exceeding KV's
  512-byte key limit or injecting characters (colons, newlines) that could
  corrupt key construction. The 20-character bound was validated against
  real data (the longest symbol on Binance Futures today is 17 characters),
  and the regex deliberately allows underscores so dated/quarterly
  contracts (e.g. `BTCUSDT_260925`) stay valid.
- **Read-only with respect to accounts.** No tool places orders or trades,
  or accesses private account data — the one tool that writes state
  (`binance_set_pair_threshold`) only stores a threshold preference in the
  worker's own Workers KV.
- **Credentials always go through Wrangler secrets**, never hardcoded or
  committed to `wrangler.toml`/git — see the explicit warning in the
  [Vercel Proxy setup](#setup-vercel-proxy-required-one-time) section about
  setting secrets safely.
- This repo was manually scanned to confirm no real API key, secret, or
  credential is committed anywhere — only placeholders/examples (e.g. the
  proxy URL `whale-pearl.vercel.app` in the setup docs is an example name,
  not a real endpoint).

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
