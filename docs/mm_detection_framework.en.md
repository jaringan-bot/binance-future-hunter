# Market Maker Detection Framework

[🇮🇩 Bahasa Indonesia](mm_detection_framework.md) | 🇬🇧 English

> A framework for detecting market maker (MM) activity using WhaleScope MCP tools (Binance Futures + Spot).
> **Important note:** No tool can directly see an MM's identity or specific positions. This framework builds an activity profile from the footprints MMs leave in the market.

---

## Table of Contents

1. [Basic Principles](#1-basic-principles)
2. [Absorption Signals](#2-absorption-signals)
3. [Spoofing Signals](#3-spoofing-signals)
4. [Stop Hunt Signals](#4-stop-hunt-signals)
5. [Basis Arbitrage Signals](#5-basis-arbitrage-signals)
6. [Step-by-Step Detection Workflow](#6-step-by-step-detection-workflow)
7. [Live Checklist](#7-live-checklist)
8. [Tool → Signal Mapping](#8-tool--signal-mapping)
9. [Conclusion](#9-conclusion)
10. [Empirical Validation](#10-empirical-validation)
11. [Automated Scoring — binance_detect_mm_activity](#11-automated-scoring--binance_detect_mm_activity)
12. [Smart Money Divergence Score — binance_analyze_smart_money](#12-smart-money-divergence-score--binance_analyze_smart_money)

---

## 1. Basic Principles

| Capability | Can / Cannot |
|-----------|-------------|
| See MM *identity* | ❌ No |
| See MM's *specific positions* | ❌ No |
| Detect **activity footprints** (absorption, spoofing, stop hunt, basis arb) | ✅ Yes, by combining 3-4 tools |

**Rule of thumb:** If **≥3 signals align** within the same timeframe, the indication of MM activity is strong enough to act on (not a calibrated statistical probability — see Section 7).

**Step 0 — check listing before starting:** If you want to use Section 5 (basis arbitrage), call `binance_check_spot_listing` first. Many Futures pairs (especially new/small coins) are NOT listed on Binance Spot at all (real example: VELVETUSDT) — Section 5 simply doesn't apply to such pairs.

---

## 2. Absorption Signals

### 2.1 Order Book Absorption — *High Confidence*

**Tools used:**
- `binance_get_order_book_depth`
- `binance_get_agg_trades`
- `binance_get_open_interest`
- `binance_get_spot_agg_trades` (real CVD comparison)

**Detection criteria:**

| Signal | Interpretation |
|--------|-------------|
| **CVD flat/rising** but price stagnant | MM is absorbing sell pressure (accumulation) |
| **CVD dropping sharply** but price doesn't crash | MM is absorbing buy pressure (distribution) |
| **OI spiking SHARPLY** + sideways price | MM opening a large position (possibly hedging). A gradual rise over several hours (e.g. <1%/hour) is NOT this signal — that's normal market growth |
| **Large trade** at bid/ask without significant slippage | MM execution using liquidity that was already prepared |
| **Futures CVD and Spot CVD moving in opposite directions** for the same pair | Absorption specifically on the futures (leverage) side, not real spot supply/demand |

---

### 2.2 Taker Volume Divergence — *Medium Confidence*

**Tools used:**
- `binance_get_taker_volume_ratio`
- `binance_get_agg_trades`

**Detection criteria:**

| Signal | Interpretation |
|--------|-------------|
| **Taker buy/sell ratio ≈ 1.0** during high volatility | Market is being absorbed by limit orders (MM characteristic), not market orders |
| **Volume spike** but spread tightens | MM is tightening the market |

---

## 3. Spoofing Signals

### 3.1 Wall Pull / Spoofing — *High Confidence*

**Tools used:**
- `binance_get_order_book_depth`
- `binance_get_order_book_imbalance`

**Detection criteria:**

| Signal | Interpretation |
|--------|-------------|
| **Large walls appear then disappear** before being executed | Sign of layering/spoofing typical of MMs |
| **Extreme imbalance at depth 5-10** not followed by price movement | MM is holding the price |
| **Spread suddenly widens** then returns to normal within seconds | MM withdrawing liquidity |

---

### 3.2 Order Book Refresh Rate Anomaly — *Low Confidence*

**Tools used:**
- `binance_get_order_book_depth`

> ⚠️ **Technical limitation (validated):**
> - Per-call latency varies significantly: **298-898ms** (average ~485ms) through the worker→Vercel→Binance proxy chain.
> - 2 sequential calls total **~1,788ms** — right at the edge of "1-2 seconds," and can take longer under poor network conditions.
> - **Sequential polling to detect "refresh rate" is not reliable** — the latency variance is too large to distinguish market changes from network noise.

**Detection criteria (single snapshot only):**

| Signal | Interpretation |
|--------|-------------|
| **Single-snapshot anomaly**: a wall appears at an unusual level (far from mid-price) with disproportionate volume | Possible spoofing — needs confirmation from other signals (CVD, OI) |

> 💡 **Recommendation:** Don't build detection based on sequential snapshot comparison via a regular MCP tool call. Focus on single-snapshot analysis + cross-confirmation with other tools.

> ❌ **WebSocket: NOT AVAILABLE** in WhaleScope MCP. All 22 tools are discrete REST request/response. Real-time detection would require a separate stack outside this project.

---

## 4. Stop Hunt Signals

### 4.1 Liquidation Cluster (Time-based) Reversal — *High Confidence*

**Tools used:**
- `binance_get_liquidation_history`
- `binance_get_open_interest`
- `binance_get_klines`

> ⚠️ **Data limitation:** `binance_get_liquidation_history` returns `{symbol, totalLong, totalShort, dominance}` per time bucket, **with no price field at all**. You cannot directly map "a cluster at a psychological level."

**Detection criteria:**

| Signal | Tool | Interpretation |
|--------|------|-------------|
| **Liquidation spike** (totalLong/totalShort jumps compared to the previous window) | `liquidation_history` | A mass force-closure occurred on one side |
| **Long wick** on the candlestick in the same timeframe | `klines` | Price was briefly touched then reversed — manual mapping to the liquidation area |
| **OI drops sharply** after a liquidation spike | `open_interest` | MM took the opposite side after the hunt |
| **Price reverses** within 1-3 candles after the wick | `klines` | Confirms the stop hunt succeeded |

> **Price-mapping workflow:** Use `klines` to identify the wick/extreme price at the same time as a liquidation spike — cross-reference MANUALLY, this isn't automatic since liquidation history doesn't contain a price field.

---

### 4.2 Top Trader Divergence — *Medium Confidence*

**Tools used:**
- `binance_get_top_trader_ratio`
- `binance_get_long_short_ratio`

> ⚠️ **A universal threshold is not valid — validated with real data.** Both a flat threshold (>15%) and a liquidity-tiered one (3-15%) EQUALLY fail: the real movement of the top-trader ratio is far below both for every pair tested (2-hour window, 8×15m):
>
> | Pair | Actual range |
> |------|-------------|
> | SOLUSDT | 1.02 points |
> | BNBUSDT | 0.60 points |
> | LINKUSDT | 0.40 points |
> | AVAXUSDT | 2.35 points |
>
> **Any specific threshold number (flat or tiered) is a guess without data calibration — don't use it as-is.**

**Detection criteria (relative, per-pair approach):**

| Approach | How to use |
|-----------|-----------|
| **Historical percentile** | Calibrate a threshold from the pair's own historical data via `binance_get_top_trader_ratio`. **Validated limitation**: this Binance endpoint has a MAXIMUM retention of ~30-31 days (tested directly — period=4h and period=1d both cut off at the same date, ~30 days back, REGARDLESS of the `limit` parameter). For calibrating an INTRADAY (15-minute) delta, a realistic lookback is only **~5 days** (period=15m, limit=500 = the max number of points available). The "30-90 days" claim in a previous version was wrong — 90 days simply **isn't available at all** from Binance for this endpoint, and 30 days is only reachable at a coarse resolution (4h/1d) that loses intraday detail. |
| **Direction vs. magnitude** | For liquid pairs (BTC, ETH, SOL, BNB), focus on the **direction of movement** (top trader rising vs. falling) against price direction, rather than the absolute number. A 0.5-1 point change moving against price is already significant, based on the data above. |
| **Delta vs. blended** | Track the absolute difference between the top-trader ratio and the blended ratio over time. A drastic widening/narrowing RELATIVE to that pair's own short history (5 days @15m) → mismatch. |

> 💡 **Recommendation:** Don't use a universal threshold (flat or tiered) without historical calibration. Every pair has its own ratio-volatility "personality," and the history available from Binance is limited — from ~5 days (fine resolution) up to ~30 days (coarse resolution) — build your baseline within that constraint, not on a 90-day assumption.

---

## 5. Basis Arbitrage Signals

**Prerequisite**: run `binance_check_spot_listing` first — if the pair is futures-only, this section doesn't apply.

### 5.1 Spot-Futures Basis Arbitrage — *Medium Confidence*

**Tools used:**
- `binance_check_spot_listing` (prerequisite)
- `binance_get_spot_price`
- `binance_get_funding_rate`
- `binance_get_open_interest`
- `binance_get_spot_agg_trades` / `binance_get_agg_trades` (spot vs futures CVD comparison)

**Detection criteria:**

| Signal | Interpretation |
|--------|-------------|
| **Spot-futures basis widens** then reverts quickly | MM performing a basis trade/arbitrage |
| **Extremely positive funding rate + rising OI** | MM possibly shorting futures while buying spot (hedged) |
| **Futures CVD and Spot CVD move in opposite directions** | Leverage pressure and real demand aren't aligned |

> ⚠️ **Practical note:** `binance_get_spot_price` and `binance_get_funding_rate` only give a point-in-time SNAPSHOT — there's NO basis time-series history tool. Detecting "basis widens then reverts" must be done manually: call repeatedly and log the basis over time yourself.

---

### 5.2 Funding Rate Manipulation — *Low Confidence*

**Tools used:**
- `binance_get_funding_rate`
- `binance_get_funding_rate_history`

**Detection criteria:**

| Signal | Interpretation |
|--------|-------------|
| **Funding rate flips** from negative to extremely positive within 1-2 intervals | MM exploiting funding to push the opposing position |
| **Funding rate history** shows a repetitive pattern at certain hours | MM scheduled rebalancing |

---

## 6. Step-by-Step Detection Workflow

```
┌─────────────────────────────────────────────────────────────┐
│  STEP 0: Check spot listing (binance_check_spot_listing)      │
│  → If futures-only, skip Step 4 (basis arb N/A)                │
├─────────────────────────────────────────────────────────────┤
│  STEP 1: Check order book depth (single snapshot)               │
│  → Any unusual wall?                                            │
├─────────────────────────────────────────────────────────────┤
│  STEP 2: Cross-check agg trades + CVD (BOTH futures and spot)  │
│  → Is the wall being absorbed or pulled? Do futures/spot CVD    │
│    align?                                                        │
├─────────────────────────────────────────────────────────────┤
│  STEP 3: Check OI + funding                                     │
│  → Any SHARP (not gradual) change in the derivative?             │
├─────────────────────────────────────────────────────────────┤
│  STEP 4: Validate spot basis (skip if Step 0 = futures-only)    │
│  → Any arbitrage activity? (manual repeated snapshots)          │
├─────────────────────────────────────────────────────────────┤
│  STEP 5: Check liquidation history + klines                      │
│  → Does a liquidation spike align with a long wick at the same  │
│    time?                                                          │
├─────────────────────────────────────────────────────────────┤
│  STEP 6: Cross-check top trader ratio                            │
│  → Moving opposite to the blended ratio? (baseline from that     │
│    pair's own ~5-30 day history, NOT a universal threshold)      │
├─────────────────────────────────────────────────────────────┤
│  RULE: the more aligned signals, the stronger the indication     │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Live Checklist

- [ ] **Order book:** Unusual wall in a single snapshot
- [ ] **CVD:** Flat/diverging from price (futures and/or spot)
- [ ] **OI:** Rising/falling SHARPLY (spike, not gradual) without price following
- [ ] **Spot basis:** Widens then reverts (needs spot listing, checked manually, repeatedly)
- [ ] **Liquidation + klines:** Liquidation spike aligns with a long wick
- [ ] **Top trader:** Moving opposite to the blended ratio, relative to that pair's own baseline

### Confidence Tier (a checklist heuristic, NOT a calibrated statistical probability)

| Checked | Tier | Interpretation |
|---------|-----------|-------------|
| 0 | — | No data yet |
| 1-2 | Weak | Most likely retail noise |
| 3-4 | Moderate | Starting to be worth suspecting, but still needs context (Section 9) |
| 5-6 | Strong | Strong indication — still not definitive proof |

---

## 8. Tool → Signal Mapping

| Tool | Signal it can detect | Validated limitation |
|------|---------------------------|---------|
| `binance_check_spot_listing` | Prerequisite for Section 5 | — |
| `binance_get_order_book_depth` | Spoofing, absorption, liquidity withdrawal | 298-898ms latency/call, can't detect real-time refresh rate |
| `binance_get_order_book_imbalance` | Imbalance manipulation, price holding | Single snapshot, no history |
| `binance_get_agg_trades` | CVD divergence (futures), large trade execution | — |
| `binance_get_spot_agg_trades` | Real CVD (spot), leverage vs. real-demand comparison | — |
| `binance_get_open_interest` | Position building, post-liquidation recovery | — |
| `binance_get_taker_volume_ratio` | Limit order dominance (MM characteristic) | — |
| `binance_get_liquidation_history` | Liquidation spike by TIME | No price field — needs manual `klines` cross-check |
| `binance_get_top_trader_ratio` | Smart money vs. retail divergence | Small movements (<2.5 points/2h even for a "moderate" pair); ~30-day max historical retention (4h/1d), ~5 days at 15m resolution; Binance's own "top trader" threshold is unpublished |
| `binance_get_long_short_ratio` | Retail sentiment vs. price action | — |
| `binance_get_spot_price` | Basis arbitrage detection | Point-in-time snapshot, no basis time-series |
| `binance_get_funding_rate` | Funding manipulation, scheduled rebalancing | — |
| `binance_get_funding_rate_history` | Funding pattern analysis | — |
| `binance_get_klines` | Wick analysis, reversal confirmation, price mapping | — |
| `binance_detect_mm_activity` | ALL 6 signals above at once, automated + scored (see Section 11) | Spoofing & stop-hunt are 1-snapshot heuristics, lower confidence than the other 4 signals |
| `binance_backtest_signal` | Empirically validates `binance_detect_mm_activity`'s historical scores (win rate/avg return) | Forward return computed on-demand from klines, not a simulation of real execution; fixed 10-pair watchlist only |

---

## 9. Conclusion

This framework **does not prove** the presence of a market maker definitively — it computes a **score indicating MM activity** from the footprints they leave behind, not a statistically calibrated probability.

**Keys to success:**
1. **Don't rely on a single signal** — cross-check at least 3 tools.
2. **Watch the timeframe** — signals aligning within 5-15 minutes are stronger than within 1 hour.
3. **Market context matters** — MM signals are more valid during low volume/consolidation areas.
4. **False positives exist** — a news event or a large retail whale can trigger similar signals.
5. **Calibrate per pair** — top-trader ratio thresholds must be built from that pair's own historical data (~5-30 days, depending on resolution), not a universal number.
6. **Know the technical limitations** — 300-900ms latency/call, liquidation without price, limited top-trader ratio historical retention, real-time refresh-rate detection not feasible via REST tool calls, no WebSocket available.

---

## 10. Empirical Validation

All validated directly against the deployed worker (`whalescope-mcp.jaringan.dev`), 2026-08-11.

**#1 — Calm market conditions (BTCUSDT, ~16:00-16:50 UTC):**

| Signal | Data | Triggered? |
|--------|------|----------|
| Order book wall | Depth 5/10 balanced, depth 20 slightly bearish (34.59%) | ❌ |
| CVD vs. price | CVD +22.1 (99.9% buy), price flat 63,523-63,525 | ✅ Triggered |
| OI rising sharply | +0.65%/2h, gradual not a spike | ❌ |
| Spot-futures basis | -0.0322%, within the neutral range | ❌ |
| Top trader vs. blended | Blended rose 62.33%→62.70%, top trader fell 61.78%→61.59% (45 minutes) | ⚠️ Opposite direction, small magnitude |

Score ~1-1.5/6 → Weak tier. **A sensible result** — BTC was calm, the framework doesn't over-trigger under normal conditions.

**#2 — Order book latency:** 5 calls at 298/406/532/562/625ms + a 2-call sequential test at 898/890ms → range **298-898ms**, average ~485ms. Two sequential snapshots total ~1,788ms — marginal, not reliable for sub-second detection.

**#3 — Real top-trader ratio range (2 hours, 8×15m):** SOLUSDT 1.02 points, BNBUSDT 0.60 points, LINKUSDT 0.40 points, AVAXUSDT 2.35 points — all far below any universal threshold (flat 15% or tiered 3-15%).

**#4 — Top-trader ratio historical retention:** limit=500 at 15m/1h periods returns the full 500 points (5 days / 21 days), but the 4h period only returns 186 points (not 500) and the 1d period only 31 points — both cut off at the SAME date (~30-31 days back), confirming a hard retention limit from Binance itself, not something related to our tool's `limit` parameter.

**List of corrected claims from the original version:**

| Original claim | Status | Correction |
|-----------|--------|---------|
| Polling <500ms for refresh-rate spoofing | ❌ Removed | Latency 298-898ms, not reliable |
| Snapshot comparison every 1-2 seconds | ⚠️ Marginal | 2 sequential calls can hit 1.8s+, too much variance |
| WebSocket fallback "if available" | ❌ Removed | Not available in WhaleScope MCP (100% REST) |
| Divergence threshold >15% flat | ❌ Removed | Never triggers for any pair |
| Tiered threshold 3-15% by liquidity | ❌ Removed | Guessed numbers, every pair far below them |
| "Liquidation cluster at a psychological level" | ⚠️ Revised | No price field — needs manual `klines` cross-check |
| Historical percentile "30-90 days" | ⚠️ Revised | 90 days isn't available at all from Binance; 30 days only at coarse resolution (4h/1d), 5 days at 15m resolution |

---

## 11. Automated Scoring — `binance_detect_mm_activity`

Sections 1-8 above are the MANUAL workflow (combine 5-6 tool calls
yourself, read the tables, count how many signals align).
`binance_detect_mm_activity` (released 2026-08-12) automates that EXACT
workflow into 1 tool call: fetch 6 data sources via `Promise.all`, compute
a score per signal (0-1), sum to a 0-6 total, classify a tier.

**IMPORTANT — this is a DIFFERENT scoring system from the Section 7
checklist**, don't conflate them:

| | Section 7 (manual) | Section 11 (`binance_detect_mm_activity`) |
|---|---|---|
| Granularity | Yes/no checklist (0-6 discrete) | Continuous score per signal (0-1) |
| Signal count | 6 (order book, CVD, OI, basis, liquidation+klines, top trader) | 6 but DIFFERENT composition (see mapping below) |
| Tier | Weak(1-2)/Moderate(3-4)/Strong(5-6) | Weak(<2)/Moderate(<3.5)/Strong(<5)/Extreme(≥5) |
| Liquidation | Separate signal (Section 4.1, needs `binance_get_liquidation_history` + manual `klines`) | NOT used — stop-hunt comes from `klines` alone (see limitations below) |

### Automated signal → manual section mapping

| Signal (`src/tools/detectMmActivity.ts`) | Related section | Formula summary | Confidence |
|---|---|---|---|
| `absorption` | 2.1 Order Book Absorption | Dominant CVD buy% (>60%) + flat price (\|Δ\|<0.5%) + sharp OI increase (>3%) → score 0.7-1.0. CVD buy% (>55%) + falling price → 0.5 (weak). Otherwise → 0.1 | **Medium** — uses CVD+OI+price (official Binance data), BUT only a single klines snapshot window, not a spot-CVD cross-check like the manual Section 2.1 |
| `spoofing` | 3.1 Wall Pull / Spoofing | Spread >0.2% + largest wall >1% of 24h volume → 0.6. Otherwise → 0.1 | **Low** — only 1 order-book snapshot (not the 2 snapshots <3 seconds apart that Section 3.1 calls for; see Section 10 #2, proxy latency of 298-898ms makes that unreliable). A wall-vs-volume heuristic, NOT true spoofing detection |
| `stopHunt` | 4.1 Liquidation Cluster Reversal | Wick >70% of range + body <20% + reversal candle → 0.8. Wick >60% alone → 0.5. Otherwise → 0.1 | **Low** — from `klines` ALONE (wick+reversal), WITHOUT the `binance_get_liquidation_history` confirmation Section 4.1 calls for (liquidation history has no price field + Coinalyze is rate-limited, see Section 8) |
| `basisArb` | 5.1 Spot-Futures Basis Arbitrage | If the symbol has D1 history (fixed 10-pair watchlist): basis z-score >2 std dev + funding >0.05% → 0.9. Without history: basis >2x threshold → 0.7 (less accurate, noted in the evidence text), >threshold → 0.5. Otherwise → 0.1 | **Medium-High** for the 10-pair watchlist (has 24h D1 historical context), **Medium** for other pairs (static threshold, no distribution context) |
| `oiDivergence` | 2.1 (sharp OI increase) + 6.STEP3 | OI up >5% + flat price (\|Δ\|<1%) → 0.8. OI up >3% against price direction → 0.7. Otherwise → 0.1 | **Medium** — official Binance OI data, but only a 1-hour window (2 data points), not a long history |
| `fundingExtreme` | 5.2 Funding Rate Manipulation | Funding >3x threshold → 1.0, >2x → 0.8, >threshold → 0.6, below → proportional scale | **High** — funding rate straight from Binance (`premiumIndex`), the most reliable of these 6 signals |

**Default thresholds**: funding ±0.03% (0.0003), basis ±0.05% (0.0005) —
identical to the defaults used by `binance_get_funding_rate`/
`binance_get_spot_price`, overridable per pair via
`binance_set_pair_threshold` (Workers KV, also used automatically by
`binance_detect_mm_activity`).

**What's NOT included from the manual framework**: top-trader divergence
(Section 4.2) and taker volume divergence (Section 2.2) are NOT separate
signals in this automated version — out of scope for the original 6-signal
design (`whalescope_mcp_roadmap.md` Appendix A). A reasonable follow-up if
more scoring precision is wanted.

### Empirical validation — via `binance_backtest_signal`, no longer manual

Section 10 above (Empirical Validation) was done manually before
`binance_detect_mm_activity` existed — matching signals one by one against
real market conditions, a one-time pass. Now, every 5 minutes a Cron
Trigger snapshots the 6 scores above into D1 (`signal_history`, fixed
10-pair watchlist) with no manual testing needed —
`binance_backtest_signal` queries that history, computes the forward
return N hours after each active signal (score ≥0.6) triggered, and
aggregates win rate/avg return/max drawdown. This is CONTINUOUS empirical
validation, not a one-time snapshot like Section 10 — but data collection
only started on deploy date (2026-08-12), not retroactively, and small
early sample sizes mean low confidence (see the README's "Honest
limitations you should know").

---

## 12. Smart Money Divergence Score — `binance_analyze_smart_money`

A SECOND tool that automates part of this framework into a structured
score (alongside `binance_detect_mm_activity` in Section 11) — but its
focus is NARROWER and DIFFERENT: not the 6 absorption/spoofing/stop-hunt/
basis-arb/OI-divergence/funding-extreme signals, but specifically Section
4.2 (Top Trader Divergence) extended with OI delta, funding rate, and
orderbook imbalance as supporting context.

**IMPORTANT -- difference from Section 4.2:** Section 4.2 explicitly
concludes that absolute thresholds on the top-trader ratio are NOT VALID
without per-pair calibration (real-world movement is 0.4-2.35 points/2h,
far below any universal threshold ever tested). `binance_analyze_smart_money`
still uses fixed thresholds (`topTraderPositionRatio > 1.4`, `> 1.2`,
`< 0.95`; `globalAccountRatio > 1.8`, `< 0.8`; `fundingRate < -0.03%`) per
this tool's explicit spec -- this is NOT a new claim that absolute
thresholds are now validated. The tool's `confidenceScore` output
compensates by measuring margin past threshold + aligned supporting
signals (funding, orderbook), not a statistical probability. For
high-stakes decisions, still cross-check with Section 4.2's relative
approach (the pair's own historical percentile) or
`binance_detect_mm_activity` (Section 11, different signals -- cross-
confirmation is stronger than relying on one tool alone).

**4 detected conditions** (priority on overlap: liquidation risk >
accumulation > squeeze):

| Condition | Criteria |
|---|---|
| `LONG_LIQUIDATION_RISK` | Global account ratio > 1.8, top trader ratio < 0.95, OI rising |
| `BULLISH_ACCUMULATION` | Top trader ratio > 1.4, global account ratio < 0.8, OI rising |
| `SHORT_SQUEEZE_RISK` | Funding rate < -0.03%, top trader ratio > 1.2, price not bullish |
| `NEUTRAL` | None of the above combinations match |

See `src/smartMoneyAnalysis.ts` for the full scoring formula.

---

*Created: 2026-08-11*
*Version 4.0 (final) — every technical claim validated directly against live WhaleScope MCP data, including latency, endpoint historical limits, and the real-world movement of the top-trader ratio across pairs.*
*Section 11 added 2026-08-12: documents `binance_detect_mm_activity` (automated scoring) + `binance_backtest_signal` (continuous empirical validation).*
*Section 12 added 2026-08-15: documents `binance_analyze_smart_money` (Smart Money Divergence Score).*
