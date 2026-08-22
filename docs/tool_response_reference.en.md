# Tool Response Reference: `detail` & Compact Composite Output

This document explains two tool-response convention changes (2026-08) made
purely for token efficiency, with NO loss of reachable data:

1. A `detail: "summary" | "full"` parameter on every array/history-shaped tool.
2. A leaner, flatter `structuredContent` shape on 5 composite tools.

No Zod parameter name was removed or renamed in this change — every addition
is optional with a new default. This is the **only** intentional
default-behavior change: existing callers that don't pass `detail` now get a
more compact response (not a full array) than before.

## 1. The `detail` parameter

Added (optional, defaults to `"summary"`) to every tool that previously (or
potentially) returned a long candle/trade/level/history array:

| Tool | `summary` (default) | `full` |
|---|---|---|
| `binance_get_klines` / `binance_get_spot_klines` | summary (bias, swing high/low, last) + last 5 candles | full candle array (same as `includeCandles: true`, kept for compatibility) |
| `binance_get_mark_price_klines`, `_index_price_klines`, `_premium_index_klines`, `_continuous_klines` | summary + last 5 candles | full candle array |
| `binance_get_quarterly_settlement_price` | last 10 settlements | all settlements |
| `binance_get_agg_trades` / `binance_get_spot_agg_trades` | CVD + summary (no raw trades) | full raw trade array |
| `binance_get_taker_volume_ratio` | latest ratio + last <=10 points | all points per `limit` |
| `binance_get_order_book_depth` / `binance_get_spot_order_book` | best bid/ask + spread (no raw levels) | full bids/asks array per `limit` |
| `binance_get_open_interest_history` | trend + last <=10 points | all points per `limit` |
| `binance_get_funding_rate_history` | average + trend + last <=10 points | all points per `limit` |
| `binance_get_liquidation_history` | totals + dominance + last <=10 points | all points per `limit` |
| `binance_get_basis_history` | current/avg/range + last <=10 snapshots | all snapshots within `hours` |
| `binance_get_long_short_ratio` / `binance_get_top_trader_ratio` | snapshot + trend + last <=10 points | all points per `limit` |

The markdown text table stays capped to the last 10-15 rows in both modes —
`detail: "full"` only affects `structuredContent`, not text table length (so
text stays human-readable even for a large `limit`).

**Why not just use a smaller `limit`?** `limit` controls how much data is
*fetched* from Binance/Coinalyze (all of it is used to compute averages/
trends), while `detail` controls how much of that already-fetched data is
sent back to Claude. They're independent: `limit: 500, detail: "summary"`
still computes the trend from 500 points, but only returns the summary +
last 10 points.

## 2. Compact composite output (§B/§D)

The 5 composite tools (`binance_analyze_pair`, `binance_analyze_smart_money`,
`binance_detect_mm_activity`, `analyze_futures_grid_risk`,
`whalescope_full_pipeline`) were tightened:

- **Markdown text** capped to roughly 8-12 lines; reasoning/evidence limited
  to active/relevant signals only (max ~6 bullets) — no more per-signal or
  per-symbol subheader + table + full evidence block.
- **`structuredContent`** is now the primary payload: shorter, flatter keys,
  null/undefined fields dropped (`dropNulls()`, `src/shared.ts`), and
  decision fields (`status`, `decision`, `tier`, `condition`) promoted to
  the top level.
- **No signal or metric was removed** — everything that used to be narrated
  at length in the text is still present in `structuredContent`, just no
  longer written out as prose.

### Renamed fields

If you parse these tools' `structuredContent` programmatically (not just
read the text), here's what changed name:

**`binance_analyze_pair`**

| Old | New |
|---|---|
| `fundingRate` | `funding` |
| `oiChangePct` | `oiChg` |
| `topTraderLatest` | `ttPct` |
| `topTraderTrend` | `ttTrend` |
| `takerLatest` | `takerRatio` |
| `changePct` | `chg` |
| `swingHigh` / `swingLow` / `lastClose` | `high` / `low` / `last` |

**`binance_analyze_smart_money`**

| Old | New |
|---|---|
| `smartMoneyBias` | `smBias` |
| `retailSentiment` | `retail` |
| `confidenceScore` | `confidence` |
| `divergenceScore` | `divScore` |
| `divergenceAnalysis` | `reason` |
| `signals` (7 raw variables) | `raw` |

**`analyze_futures_grid_risk`** — `metrics`/`market`/`context`/`anomalies`
keep their existing structure (not renamed, but `context`/`anomalies` are
now null-stripped); `status`, `circuitBreakerTriggered`, and
`circuitBreakerReason` (previously nested under `circuit_breaker.*`) are now
also promoted to the top level as first-class decision fields.

**`binance_detect_mm_activity`** and **`whalescope_full_pipeline`** —
`structuredContent` field names/shape are UNCHANGED (only the text output
was trimmed), so any existing programmatic integration needs no changes.

## Recommendations

- If you (or Claude) only need the conclusion/decision → leave `detail` at
  its `"summary"` default, this is the most token-efficient path.
- If you need to process raw data programmatically (custom backtests,
  calculations outside this tool) → set `detail: "full"` explicitly on the
  calls that need it.
- For each signal's analytical limitations (not response size), see
  [`docs/mm_detection_framework.en.md`](mm_detection_framework.en.md) and
  [`docs/full_pipeline_framework.en.md`](full_pipeline_framework.en.md).
