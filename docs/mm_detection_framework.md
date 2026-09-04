# Market Maker Detection Framework

> A framework for detecting market maker (MM) activity using Binance Future Hunter tools (Binance Futures + Spot).
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

**`analyze_cvd_divergence` — window & threshold (empirical, probe #2-#5, 2026-08-26):**

| Pair class | Window | `neutralThresholdPct` | Status |
|---|---|---|---|
| Liquid/high-N (BTCUSDT-class, ~17k-115k trades/window) | 60-min continuous | 0.0536 (5.36 pts) | **Validated** — 5 probe rounds, 5→60 min; divergence spread shrank monotonically 40.07→23.66→15.94→7.98→5.36 points |
| Less-liquid/low-N (DOGEUSDT-class, ~1.7k-5.8k trades/window) | 60 min (adopted) | 0.0536 (same) | **Adopted assumption, NOT independently validated** — extrapolated from BTCUSDT's pattern; direct probing only reached 30 min, where spread INCREASED (18.20→24.40) instead of shrinking. Revisit if divergence signals on illiquid pairs prove unreliable in practice |

The trade-concentration concern raised during this probe series' diagnosis turned out to be a metric artifact (net-CVD denominator collapsing toward zero on balanced flow) — the corrected metric (top-3 notional ÷ total notional) showed 0/24 legs (BTCUSDT+DOGEUSDT, every width probed) exceeding 20%.

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

> ✅ **Update 2026-08-22: now automated via `binance_get_orderbook_delta`.** This tool takes 2 order book snapshots with an EXPLICIT gap (default 1500ms, configurable 500-5000ms) — not back-to-back polling — and compares walls (qty ≥2x same-side median) between them: a wall that disappears/shrinks >70% WITHOUT the opposite side actually trading through that price level = a real spoofing signal. Also used internally by `binance_detect_mm_activity` (see Section 11). See Section 3.2 for why this explicit gap avoids the latency-variance problem that previously ruled this approach out.

---

### 3.2 Order Book Refresh Rate Anomaly — *now Medium-High Confidence via `binance_get_orderbook_delta`*

**Tools used:**
- `binance_get_order_book_depth` (single snapshot, manual)
- `binance_get_orderbook_delta` (2-snapshot, automated — see below)
- `binance_watch_orderbook_realtime` (WS `@depth@100ms` sub-second, on-demand — see 3.2b)

> ⚠️ **Technical limitation (validated):**
> - Per-call latency varies significantly: **298-898ms** (average ~485ms) through the worker→Vercel→Binance proxy chain.
> - Because of that, detecting "refresh rate" via BACK-TO-BACK polling (no gap) is genuinely unreliable — the latency variance is too large to distinguish market changes from pure network-timing noise.

**Detection criteria (2-snapshot, via `binance_get_orderbook_delta`):**

| Signal | Interpretation |
|--------|-------------|
| **Wall disappears/shrinks >70%** between 2 snapshots WITHOUT the opposite side actually trading through that price level | Spoofing — the order was pulled, not executed |
| **Wall disappears AND the opposite side trades through that price level** | Genuine execution (price actually moved through the level), NOT spoofing |
| **Single-snapshot anomaly** (`binance_get_order_book_depth`): a wall at an unusual level, disproportionate volume | Possible spoofing — still needs confirmation from other signals if it's just 1 snapshot |

> 💡 **Why an EXPLICIT gap (default 1500ms) solves the latency-variance problem:** the earlier recommendation ("don't build detection on sequential snapshot comparison") assumed 2 calls made back-to-back with NO gap, where the 298-898ms latency variance made the actual time between snapshots unpredictable (could be 300ms, could be 900ms — a large relative difference). With an explicit 1500ms gap deliberately awaited BETWEEN the 2 fetches, the per-call latency variance (~600ms max) becomes small relative to the gap itself (~1500ms) — the time between snapshots stays consistently ~1.5-2 seconds, long enough to catch typical wall-pulling (usually seconds) but not just network noise. **Trade-off**: this tool is automatically ~1-2 seconds slower than the single-snapshot tools.

> ⚠️ **WebSocket: PARTIAL.** The VPS stream gateway holds `!forceOrder@arr` + `!contractInfo` always-on (→ `binance_get_realtime_liquidations`, `binance_get_contract_events`). Always-on per-symbol depth/aggTrade stays out of scope (too high-volume). What *is* available now: an **on-demand per-symbol depth watch** — see 3.2b.

### 3.2b Sub-Second Wall Lifecycle — `binance_watch_orderbook_realtime` (2026-09-02)

WebSocket `wss://fstream.binance.com/ws/<symbol>@depth@100ms` on the AWS
stream gateway (the `fstream` black-hole is Oracle-IP-specific and does not
apply to AWS depth — Krakatau spike, ~588 msg/60s). **On-demand, not
always-on:** the tool *arms* a watch for one symbol; the gateway opens a
single socket, keeps a COARSE book (only levels above a notional floor — to
bound memory on a 1GB VPS), and emits wall-lifecycle events:

| Event | Meaning |
|---|---|
| `WALL_APPEARED` | A level crosses the wall notional threshold |
| `WALL_GREW` / `WALL_SHRANK` | An existing wall changes qty ≥40% (still above threshold) |
| `WALL_VANISHED` | A wall drops below the threshold / qty 0 |

- **Wall threshold scales with 24h quote volume** (`wallThresholdForVolume`,
  `src/tools/realtimeStream.ts`) — heuristic, NOT calibrated: BTC/ETH
  (≥$5B/day) → $2M · SOL/top alt (≥$1B) → $800k · mid alt (≥$200M) → $350k ·
  (≥$20M) → $150k · else → $80k. The old flat $250k caught hundreds of
  transient levels on BTCUSDT (~$30B book) within seconds (verified live
  2026-09-02: 245 APPEARED / 233 VANISHED @ $250k in ~5s). Manual override:
  the `wall_min_notional_usd` param. The threshold is **locked** to the
  arming value (a renew won't change it — otherwise the coarse book goes
  inconsistent).
- **TTL-bounded** (default 5 min, max 15): with no renewal the watch dies,
  the socket closes, the slot frees.
- **Concurrent-watch cap** (default 8, `STREAM_DEPTH_MAX_WATCHES`) — same
  class of constraint that cut `WALL_SCAN_WATCHLIST` 50→15. Per-symbol event
  ring `EVENT_BUFFER_PER_SYMBOL=500`: on very liquid pairs the ring fills
  fast, so poll often (`sinceMs`) if you need the full history.
- **NOT a full L2 book** — a wall that never ticks won't show; a pre-existing
  wall may register one `WALL_APPEARED` on connect (a ~1.5s warmup
  suppresses most). This is a *lifecycle* feed, not a depth snapshot.
- Call pattern: the first call arms it (0 events); later calls pass
  `sinceMs` = last event ts for the new delta. Gateway endpoints:
  `POST /stream/watch`, `GET /stream/depth-diff?symbol=&sinceMs=`.

---

## 4. Stop Hunt Signals

### 4.1 Liquidation Cluster (Time-based) Reversal — **PERMANENTLY REMOVED (2026-08-22)**

> ⚠️ **This section no longer applies, and the status is FINAL — not "not built yet."** `binance_get_liquidation_history` (the only liquidation data source, via Coinalyze) was removed — Binance has no public market-wide REST endpoint for this, and the real-time WebSocket route (`!forceOrder@arr`) hits the same WAF block as `fapi.binance.com`, confirmed independently **3 times** (2026-08-11, 2026-08-12, and 2026-08-22) via real `wrangler deploy` spike tests, see
> [`docs/superpowers/specs/2026-08-11-realtime-liquidation-stream-design.md`](superpowers/specs/2026-08-11-realtime-liquidation-stream-design.md).
> The only fix (a paid always-on relay, ~$5-20/month, outside Cloudflare) **has been explicitly declined by the user** — real liquidation-by-price data will NOT be available in this project unless that decision changes. Don't suggest it again unless asked.
>
> **Update 2026-08-22 — permanent mitigation via 2 independent proxies:** the `stopHunt` signal in `binance_detect_mm_activity` now (1) checks the wick SYMMETRICALLY — upper wick (hunt of longs) AND lower wick (hunt of shorts); it used to only check the upper wick (a bug — downside stop-hunts were never detected), and (2) uses **2 independent forced-liquidation proxies**, each able to raise the confidence tier on its own (and both together raise it further):
> - **OI-drop proxy**: open interest drops ≥2% coinciding with that wick candle (REUSING the OI-history fetch already made for the `oiDivergence` signal, not a new fetch) — mass stop-outs reduce OI.
> - **Trade-volume concentration proxy** (new): from the last 100 aggTrades already fetched for CVD (REUSED, not a new fetch), checks whether AGGRESSIVE trade volume in the hunt's direction (sells for hunt-of-longs, buys for hunt-of-shorts) is ≥30% concentrated RIGHT in that wick candle's price zone (rather than spread across the whole range) — a proxy for "a large execution happened right at that level," from Binance's public trade data (not liquidation-tagged, but price-anchored).
>
> Tier: 0 proxies → 0.8/0.5 (base), 1 proxy → 0.9/0.6, both proxies → 0.95/0.65. Neither is **real liquidation data** — just a correlation (OI-drop + wick) or (trade concentration + wick), STILL WITHOUT confirmation from actual liquidation-by-price data (Binance doesn't expose which trades were liquidation-triggered). See Section 8/11 below.

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

> ⚠️ **Practical note:** `binance_get_spot_price` and `binance_get_funding_rate` only give a point-in-time SNAPSHOT — not a time-series. For history, use `binance_get_basis_history` (D1, 5-minute cron snapshot): ALWAYS available for the 50-pair fixed watchlist; for other pairs, best-effort — history starts accumulating once that pair is queried ≥3x within ~24h AND ranks in the top-5 most-queried non-watchlist pairs (see `src/queryFrequency.ts`). Outside that, it's still manual: call repeatedly and log the basis over time yourself.

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
│  STEP 1: Check order book depth (single snapshot), OR           │
│  binance_get_orderbook_delta (2-snapshot, real spoofing)         │
│  → Any unusual wall / wall gone without price crossing it?       │
├─────────────────────────────────────────────────────────────┤
│  STEP 2: Cross-check agg trades + CVD (BOTH futures and spot)  │
│  → Is the wall being absorbed or pulled? Do futures/spot CVD    │
│    align?                                                        │
├─────────────────────────────────────────────────────────────┤
│  STEP 3: Check OI + funding                                     │
│  → Any SHARP (not gradual) change in the derivative?             │
├─────────────────────────────────────────────────────────────┤
│  STEP 4: Validate spot basis (skip if Step 0 = futures-only)    │
│  → binance_get_basis_history (watchlist always, other pairs      │
│  best-effort) or manual repeated snapshots                       │
├─────────────────────────────────────────────────────────────┤
│  STEP 5: Klines (symmetric wick) + OI-drop proxy + aggressive   │
│  trade-price concentration, STILL NO real liquidation data       │
│  (permanently removed, WAF-blocked)                              │
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
- [ ] **Klines (was liquidation + klines):** Long wick + reversal, NO liquidation confirmation (tool removed)
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
| `binance_get_orderbook_delta` | Real spoofing via 2-snapshot delta (wall gone without price crossing it) | Adds ~1-2s latency/call (explicit 1500ms default gap between the 2 fetches) |
| `binance_get_agg_trades` | CVD divergence (futures), large trade execution | — |
| `binance_get_spot_agg_trades` | Real CVD (spot), leverage vs. real-demand comparison | — |
| `binance_get_open_interest` | Position building, post-liquidation recovery | — |
| `binance_get_taker_volume_ratio` | Limit order dominance (MM characteristic) | — |
| `binance_get_top_trader_ratio` | Smart money vs. retail divergence | Small movements (<2.5 points/2h even for a "moderate" pair); ~30-day max historical retention (4h/1d), ~5 days at 15m resolution; Binance's own "top trader" threshold is unpublished |
| `binance_get_long_short_ratio` | Retail sentiment vs. price action | — |
| `binance_get_spot_price` | Basis arbitrage detection | Point-in-time snapshot, no basis time-series |
| `binance_get_funding_rate` | Funding manipulation, scheduled rebalancing | — |
| `binance_get_funding_rate_history` | Funding pattern analysis | — |
| `binance_get_klines` | Wick analysis, reversal confirmation, price mapping | — |
| `binance_detect_mm_activity` | ALL 6 signals above at once, automated + scored (see Section 11) | Spoofing is now real 2-snapshot (~1-2s slower). Stop-hunt is symmetric + OI-drop proxy + aggressive trade-price concentration proxy, STILL no real liquidation data (permanently removed) |
| `binance_backtest_signal` | Empirically validates `binance_detect_mm_activity`'s historical scores (win rate/avg return) | Forward return computed on-demand from klines, not a simulation of real execution; fixed 50-pair watchlist only |

---

## 9. Conclusion

This framework **does not prove** the presence of a market maker definitively — it computes a **score indicating MM activity** from the footprints they leave behind, not a statistically calibrated probability.

**Keys to success:**
1. **Don't rely on a single signal** — cross-check at least 3 tools.
2. **Watch the timeframe** — signals aligning within 5-15 minutes are stronger than within 1 hour.
3. **Market context matters** — MM signals are more valid during low volume/consolidation areas.
4. **False positives exist** — a news event or a large retail whale can trigger similar signals.
5. **Calibrate per pair** — top-trader ratio thresholds must be built from that pair's own historical data (~5-30 days, depending on resolution), not a universal number.
6. **Know the technical limitations** — 300-900ms latency/call, no liquidation data at all (permanently removed, see Section 4.1; the OI-drop + trade-volume-concentration proxies are the best available mitigation), limited top-trader ratio historical retention. 2-snapshot spoofing (`binance_get_orderbook_delta`) adds ~1-2s latency; sub-second wall lifecycle is NOW available via `binance_watch_orderbook_realtime` (on-demand WS `@depth@100ms`, TTL-bounded — see Section 3.2b), but always-on per-symbol depth/aggTrade stays out of scope.

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
| WebSocket fallback "if available" | ❌ Removed | Not available in Binance Future Hunter (100% REST) |
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
| Liquidation | Section 4.1 — **permanently removed**, `binance_get_liquidation_history` no longer exists | NOT used — stop-hunt comes from `klines` (symmetric wick) + an OI-drop proxy + a trade-volume-concentration proxy (see limitations below) |

### Automated signal → manual section mapping

| Signal (`src/tools/detectMmActivity.ts`) | Related section | Formula summary | Confidence |
|---|---|---|---|
| `absorption` | 2.1 Order Book Absorption | Dominant CVD buy% (>60%) + flat price (\|Δ\|<0.5%) + sharp OI increase (>3%) → score 0.7-1.0. CVD buy% (>55%) + falling price → 0.5 (weak). Otherwise → 0.1 | **Medium** — uses CVD+OI+price (official Binance data), BUT only a single klines snapshot window, not a spot-CVD cross-check like the manual Section 2.1 |
| `spoofing` | 3.1 Wall Pull / Spoofing | 2 order-book snapshots ~1.5s apart (internal `binance_get_orderbook_delta`). A wall (qty ≥2x median) that disappears/shrinks >70% WITHOUT the opposite side trading through that price level → 0.9 (the LARGEST wall was spoofed) or 0.5 (a secondary wall). Otherwise → 0.1 | **High** (largest wall spoofed) / **Medium** (secondary wall) — now real 2-snapshot detection, no longer a 1-snapshot proxy (see Section 3.1/3.2, `src/tools/orderbookDelta.ts`) |
| `stopHunt` | 4.1 Liquidation Cluster Reversal (permanently removed) | Symmetric wick (upper=hunt of longs OR lower=hunt of shorts, used to be upper-only — a bug) >70% of range + body <20% + reversal in the wick's direction → 0.8, +0.05/active proxy (OI dropped ≥2%, and/or aggressive trade volume ≥30% concentrated in the wick zone) → 0.9 (1 proxy) / 0.95 (both). Wick >60% alone → 0.5, same +proxy pattern → 0.6/0.65. Otherwise → 0.1 | **Low-Medium** — from `klines` (symmetric wick) + 2 independent proxies (REUSES the existing OI-history & aggTrades fetches, no new calls), STILL WITHOUT confirmation from real liquidation-by-price data (permanently removed, see Section 4.1) |
| `basisArb` | 5.1 Spot-Futures Basis Arbitrage | If the symbol has D1 history (fixed 50-pair watchlist): basis z-score >2 std dev + funding >0.05% → 0.9. Without history: basis >2x threshold → 0.7 (less accurate, noted in the evidence text), >threshold → 0.5. Otherwise → 0.1 | **Medium-High** for the 50-pair watchlist (has 24h D1 historical context), **Medium** for other pairs (static threshold, no distribution context) |
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
50-pair watchlist) with no manual testing needed —
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
*Version 4.0 (final) — every technical claim validated directly against live Binance Future Hunter (formerly whalescope-mcp) data, including latency, endpoint historical limits, and the real-world movement of the top-trader ratio across pairs.*
*Section 11 added 2026-08-12: documents `binance_detect_mm_activity` (automated scoring) + `binance_backtest_signal` (continuous empirical validation).*
*Section 12 added 2026-08-15: documents `binance_analyze_smart_money` (Smart Money Divergence Score).*
