# Full Pipeline Framework — `whalescope_full_pipeline`

[🇮🇩 Bahasa Indonesia](full_pipeline_framework.md) | 🇬🇧 English

> Full documentation for WhaleScope MCP's highest-level composite tool: a
> single tool call that runs the entire Binance Futures Grid Bot decision
> chain -- hard screen, Tier-1 intelligence, grid bound calculation, risk
> sizing, and the final decision -- for one or many symbols at once.

---

## Table of Contents

1. [Why This Tool Exists](#1-why-this-tool-exists)
2. [Architecture: Pure Engine + Thin Wrapper](#2-architecture-pure-engine--thin-wrapper)
3. [2-Wave Fetch Flow (Reject Early)](#3-2-wave-fetch-flow-reject-early)
4. [Stage 1: Hard Screen](#4-stage-1-hard-screen)
5. [Stage 2: Tier-1 Intelligence & Ranking Score](#5-stage-2-tier-1-intelligence--ranking-score)
6. [Stage 3: Grid Bounds (Compass-Equivalent)](#6-stage-3-grid-bounds-compass-equivalent)
7. [Stage 4: Capital Solve & Leverage Selection](#7-stage-4-capital-solve--leverage-selection)
8. [Stage 5: Final Decision](#8-stage-5-final-decision)
9. [Tool → Signal Mapping](#9-tool--signal-mapping)
10. [Worked Example](#10-worked-example)
11. [Known Limitations](#11-known-limitations)
12. [Decision log & formula tests](#12-decision-log--formula-tests-2026-08-31)

---

## 1. Why This Tool Exists

Before this tool, a trader who wanted to set up a Binance Futures Grid Bot
had to manually chain ~8 separate tool calls (`binance_market_regime`
twice, for 1h and 4h, `binance_analyze_smart_money`,
`binance_detect_mm_activity`, `binance_get_order_book_imbalance`,
`analyze_futures_grid_risk`, etc.), then compute grid parameters
(upper/lower/gridCount/stopLoss/takeProfit) BY HAND -- **not one** of the
previous 44 tools produced those numbers from scratch. `whalescope_full_pipeline`
merges that entire decision chain into a single tool call, per symbol
(multiple symbols at once, up to 20), and returns a ranked results table
plus copy-paste-ready Grid Bot parameters.

**What this tool does NOT do:**

- Doesn't execute any orders. Default is still screening-only;
  `persist=true` only writes a compact D1 row (`pipeline_decision_log`),
  not an order.
- Doesn't reverse-engineer Binance's Compass feature (not public) -- grid
  bounds are computed with an ATR + swing-high/low heuristic, clearly
  documented as APPROXIMATE (Section 6).
- Doesn't guarantee profit -- this is a screening + sizing tool, not alpha.

---

## 2. Architecture: Pure Engine + Thin Wrapper

Following the `smartMoneyAnalysis.ts` + `smartMoney.ts` pattern already
used elsewhere in this repo:

| Layer | File | Contents |
|---|---|---|
| Pure engine (grid bounds) | `src/gridBoundEngine.ts` | `computeATR()`, `computeGridBounds()` -- pure numbers-in/numbers-out, no fetching |
| Pure engine (screening/scoring/decision) | `src/pipelineEngine.ts` | `evaluateHardScreen()`, `scoreTier1Signals()`, `scaleCapitalForTargetLoss()`, `decidePipelineOutcome()` |
| Concurrency helper | `src/concurrency.ts` | `mapWithConcurrency()` -- worker-pool for processing many symbols in parallel, bounded by `concurrency` |
| Thin MCP wrapper | `src/tools/fullPipeline.ts` | Zod schema, 2-wave fetch orchestration, calls pure engines + other tools' pure functions DIRECTLY (not an MCP roundtrip), builds output |

**No logic from the other 44 tools is duplicated.** Pure functions reused
directly (TypeScript imports, not MCP tool calls): `classifyRegime`
(`marketRegime.ts`), `analyzeSmartMoneyDivergence`
(`smartMoneyAnalysis.ts`), the 6 MM scorers (`detectMmActivity.ts`),
`calculateGridRisk` (`gridRiskEngine.ts`), `fetchMarketContext`
(`marketContext.ts`), plus shared helpers (`computeCvdFromTrades`,
`summarizeKlines`, `calculateADX`, `errorResult`, `ToolResponseBuilder`).

---

## 3. 2-Wave Fetch Flow (Reject Early)

```
┌─────────────────────────────────────────────────────────────────┐
│ WAVE 1 (parallel, ALL symbols):                                   │
│   ticker24hr · funding rate · 1h klines (limit=max(lookback,40)) │
│   4h klines (limit=40) · open interest + 1h history (limit=2)    │
│   agg trades (limit=100) · fetchMarketContext()                   │
├─────────────────────────────────────────────────────────────────┤
│   -> compute regime1h, regime4h (classifyRegime)                  │
│   -> evaluateHardScreen(): tradable? volume >= minimum?           │
│      |funding| <= maximum? regime 1h/4h != BREAKOUT?              │
│                                                                     │
│      FAIL? ────────────► NO_TRADE, WAVE 2 IS NEVER CALLED         │
│                          (this is "reject early" -- a symbol       │
│                          that's clearly unfit never burdens the    │
│                          proxy with any Wave-2 fetch at all)       │
├─────────────────────────────────────────────────────────────────┤
│ WAVE 2 (parallel, SURVIVORS ONLY):                                 │
│   top-trader position ratio · global account ratio                │
│   24-point open interest history · depth-50 order book            │
│   custom threshold (Workers KV) · spot price (for MM basis)       │
├─────────────────────────────────────────────────────────────────┤
│   -> analyzeSmartMoneyDivergence()                                 │
│   -> 6 pure MM scores (absorption/spoofing/stopHunt/basisArb/      │
│      oiDivergence/fundingExtreme)                                  │
│   -> scoreTier1Signals() -> rankingScore 0-100                     │
│   -> computeGridBounds() (from Wave-1 1h klines)                   │
│   -> leverage loop (descending): exact capital-solve via           │
│      calculateGridRisk() 2x per leverage (reference + final)       │
│   -> decidePipelineOutcome() -> TRADE / WATCH / NO_TRADE           │
└─────────────────────────────────────────────────────────────────┘
```

**The depth-50 order book is reused 3x** (not fetched 3 separate times):
OBI-5/10/20, `orderBookBidDepthSL` for grid-risk, and the orderbook
imbalance input for smart money divergence. One
`getOrderBookDepth(symbol, 50)` call per symbol, not three.

---

## 4. Stage 1: Hard Screen

`evaluateHardScreen()` (`src/pipelineEngine.ts`) checks 4 conditions and
collects **ALL** failing reasons (not just the first one found), so a
rejected symbol's output stays fully transparent about why:

| Condition | Data source | Default threshold |
|---|---|---|
| **Tradable** | Derived from the Wave-1 `ticker24hr` fetch -- fetch failure, or an invalid `lastPrice`/`quoteVolume` | — |
| **Minimum volume** | `quoteVolume` from ticker24hr | `min_quote_volume_usd`, default $5,000,000 |
| **Non-extreme funding** | `lastFundingRate` from `premiumIndex` | `max_abs_funding_rate`, default 0.0005 (0.05%) |
| **Not a BREAKOUT regime** | `classifyRegime()` for 1h AND 4h (independent) | — |

A symbol that fails even ONE of the 4 conditions above is immediately
returned as `NO_TRADE` with `reasoning` containing every failing reason,
and **Wave 2 is never called for that symbol**.

---

## 5. Stage 2: Tier-1 Intelligence & Ranking Score

`scoreTier1Signals()` combines 4 components into a single `rankingScore`
0-100 (used to sort multi-symbol results), with explicit documented
weights (not the result of statistical calibration):

| Component | Weight | Source |
|---|---|---|
| MM composite score (0-6 from `detectMmActivity.ts`'s 6 signals) | 35% | absorption, spoofing, stopHunt, basisArb, oiDivergence, fundingExtreme |
| Smart money vs retail direction | 30% | `analyzeSmartMoneyDivergence()` -- BULLISH_ACCUMULATION boosts, LONG_LIQUIDATION_RISK acts as a warning, SHORT_SQUEEZE_RISK at half weight, NEUTRAL is neutral |
| Regime favorability (1h+4h average) | 20% | RANGING is most ideal for grid trading, ACCUMULATION/DISTRIBUTION decent, TRENDING is riskiest |
| Buy pressure (depth-20 OBI + CVD) | 15% | This tool only supports LONG grids, so higher buy pressure = more favorable |

`TRADE_RANKING_SCORE_THRESHOLD = 55` -- used by `decidePipelineOutcome()`
in Stage 5.

---

## 6. Stage 3: Grid Bounds (Compass-Equivalent)

`computeGridBounds()` (`src/gridBoundEngine.ts`) computes ALL grid
parameters from Wave-1's 1h candles + current price, purely heuristic (not
a reverse-engineering of Binance's non-public Compass feature):

1. **HH/LL** = swing high/low over the last `lookback_bars` 1h candles.
2. **Upper/Lower** = HH/LL +/- an `ATR × atr_mult` buffer on each side.
3. **Stop Loss** = Lower − `ATR × sl_extra_atr`, widened further by
   `sl_pct_buffer`% below that.
4. **Take Profit** = Upper + `ATR × (tp_atr_mult ?? atr_mult)` (symmetric
   default).
5. **Grid Type**: `rangePercentage > 20%` → GEOMETRIC, else → ARITHMETIC --
   EXACTLY the same threshold as the `gridTypeMismatch` check in
   `gridRiskEngine.ts`, so grids this pipeline constructs always come back
   `gridTypeMismatch=false` when re-analyzed.
6. **Grid Count**: a heuristic targeting ~0.75% step width, clamped to
   [10, 150] -- **not histogram-optimized**, see Section 11.

ATR is computed via Wilder smoothing in `computeATR()`, built on top of
`computeTrueRange()` extracted from `calculateADX()`
(`src/toolHelpers.ts`) -- one source of truth for true range, shared by
both ADX and ATR.

---

## 7. Stage 4: Capital Solve & Leverage Selection

`calculateGridRisk()` (`src/gridRiskEngine.ts`) is linear in
`initialCapital` for a fixed price/grid/leverage/SL -- the capital solve is
**exact, not iterative**:

1. First run with `REFERENCE_CAPITAL = $1000` → read
   `slippageStressedLoss`.
2. `solvedInitialCapital = (risk_usd / slippageStressedLoss) × 1000`.
3. Second run with `solvedInitialCapital` → accurate final metrics.

This is repeated for every option in `max_leverage_options` (default
`[3, 5, 10]`), **descending** -- the HIGHEST leverage whose status is
SAFE/MODERATE AND whose liquidation is safely below the stop-loss is
chosen. **Every leverage evaluated is recorded** in
`risk.evaluatedLeverages[]` for transparency, not just the chosen one --
including ones that REJECT (e.g. failing Binance's minNotional at a small
solved capital).

`BinanceMarketData` for `calculateGridRisk()` is **self-assembled** from
data already fetched in Wave 1/Wave 2 (funding, OI, order book) --
**NOT** by calling `fetchBinanceMarketData()` (`binanceFetcher.ts`), which
hits `fapi.binance.com` directly and is blocked by Binance's WAF.

---

## 8. Stage 5: Final Decision

`decidePipelineOutcome()` combines the results of the previous 3 stages:

| Condition | Decision |
|---|---|
| Hard screen failed | `NO_TRADE` |
| Every evaluated leverage REJECTs | `NO_TRADE` |
| Chosen leverage's status is HIGH_RISK | `WATCH` |
| Chosen leverage SAFE/MODERATE, `rankingScore >= 55` | `TRADE` |
| Chosen leverage SAFE/MODERATE, `rankingScore < 55` | `WATCH` |

---

## 9. Tool → Signal Mapping

| Pipeline stage | Pure function reused | Source file |
|---|---|---|
| 1h/4h regime | `classifyRegime()` | `src/tools/marketRegime.ts` |
| Smart money divergence | `analyzeSmartMoneyDivergence()` | `src/smartMoneyAnalysis.ts` |
| 6 MM composite scores | `calculateAbsorptionScore`, `calculateSpoofingScore`, `calculateStopHuntScore`, `calculateBasisArbScore`, `calculateOiDivergenceScore`, `calculateFundingExtremeScore`, `classifyTier` | `src/tools/detectMmActivity.ts` |
| Grid risk per leverage | `calculateGridRisk()` | `src/gridRiskEngine.ts` |
| Regime/squeeze context for stress multiplier | `fetchMarketContext()` | `src/marketContext.ts` |
| CVD, kline summary, ADX, true range | `computeCvdFromTrades`, `summarizeKlines`, `calculateADX`, `computeTrueRange` | `src/toolHelpers.ts` |
| Grid bounds | `computeATR()`, `computeGridBounds()` | `src/gridBoundEngine.ts` (new) |
| Screening/scoring/decision/capital-solve | `evaluateHardScreen`, `scoreTier1Signals`, `scaleCapitalForTargetLoss`, `decidePipelineOutcome` | `src/pipelineEngine.ts` (new) |

---

## 10. Worked Example

Hypothetical symbol `EXAMPLEUSDT`, `risk_usd=20`, everything else default:

1. **Wave 1**: 24h quoteVolume $12,000,000 (passes the $5,000,000
   threshold), funding 0.0001 (passes the 0.0005 threshold),
   regime1h=RANGING (confidence 0.7), regime4h=ACCUMULATION (confidence
   0.6) -- neither is BREAKOUT → **hard screen passes**, continue to Wave
   2.
2. **Wave 2**: smart money BULLISH_ACCUMULATION (confidence 66), MM
   composite score 2.1/6, depth-20 OBI 62% bid, CVD buy 65% →
   `rankingScore ≈ 61.4` (above the 55 threshold).
3. **Grid bounds**: HH=104, LL=96, ATR=2 → upper=106, lower=94,
   rangePercentage≈12.8% → ARITHMETIC, gridCount≈17, stopLoss≈90.1,
   takeProfit≈108.
4. **Capital solve**: leverage 10x → reference run (capital $1000)
   `slippageStressedLoss=$83.2` → `solvedInitialCapital = (20/83.2)×1000 ≈
   $240.4` → final run status SAFE, liquidationPrice=85.3 (safely below the
   90.1 stop-loss) → **10x leverage chosen**.
5. **Decision**: hard screen passed + SAFE status + rankingScore 61.4
   (≥55) → **TRADE**. `gridBotConfig`: Lower 94 / Upper 106 / N 17 /
   ARITHMETIC / 10x / ISOLATED / SL 90.1 / TP 108.

_(The numbers above are illustrative, to walk through the computation flow
-- NOT the result of a live Binance query.)_

---

## 11. Known Limitations

1. **Grid Count is a heuristic, not histogram-optimized.** Targets ~0.75%
   step width, clamped to [10, 150] -- a documented, simple approach, not
   the result of backtesting/optimizing against historical price
   distribution.
2. **Margin mode is not modeled in the risk math.** `GridInputParams`
   (`gridRiskEngine.ts`) has no margin-mode field -- all liquidation/risk
   calculations are APPROXIMATE, isolated-margin-style, regardless of the
   requested `margin_mode` (ISOLATED or CROSSED). For real CROSSED margin,
   liquidation depends on the account's TOTAL balance, not just the
   capital allocated to this grid -- every result carries a
   `gridBotConfig.marginModeCaveat` string explaining this explicitly.
3. **Absolute volume filter, not a percentile.** `min_quote_volume_usd` is
   an ABSOLUTE threshold ($5,000,000 default), a rough approximation of a
   "bottom 20%" cutoff -- NO new bulk-ticker/percentile fetcher was added
   for this tool (out of scope for this task).
4. **MM basis-arbitrage always uses the simple threshold, never the D1
   z-score.** The watchlist-history z-score branch in
   `calculateBasisArbScore` (`detectMmActivity.ts`) is DELIBERATELY
   skipped (`basisZScore` is always `undefined`) -- an MVP simplification,
   consistent across every symbol (watchlist or not).
5. **"Tradable" is derived from ticker24hr, not an official listing
   status.** `FuturesExchangeInfoSymbol` in this codebase doesn't expose a
   `status` field (unlike its Spot counterpart) -- a separate exchangeInfo
   fetch just to check listing would add a call outside the 2-wave design.
   Instead, "not tradable" is derived from the `ticker24hr` fetch already
   made in Wave 1 (fetch failure, or an invalid `lastPrice`/`quoteVolume`)
   -- a cheap proxy, not Binance's official listing status.
6. **The 4h regime reuses Wave-1 OI/CVD, not a second timeframe-specific
   fetch.** The genuinely 4h-specific part (ADX, volatility-spike,
   volume-spike from 4h candles) is computed independently from 1h. But
   the `oiChangePct`/`cvdBuyPct` fed into `classifyRegime()` for the 4h
   regime REUSE the same values used for the 1h regime (from the same
   Wave-1 OI-history/agg-trades fetch) -- NOT a second, timeframe-specific
   OI/CVD fetch. This differs from calling `binance_market_regime` twice
   manually (each of which independently re-fetches its own OI/CVD). This
   is a deliberate efficiency gain from being ONE composite tool call, not
   a bug -- but the result is NOT 100% identical to two separate
   `binance_market_regime` calls.
7. **`getTopTraderPositionRatio` can be called twice per symbol that
   passes the hard screen.** `fetchMarketContext()` (Wave 1, called for
   EVERY symbol by design) already calls this endpoint internally for its
   own `GridContextualRisk`; Wave 2 calls it again independently for
   `analyzeSmartMoneyDivergence()`, so the smart-money signal doesn't
   silently degrade if `fetchMarketContext()` hits its own 1.5-second
   timeout. This small duplicate call is DELIBERATE (reliability over
   saving one call), documented here for honesty about the trade-off.
8. **`rankingScore` and the TRADE/WATCH threshold (55) are explicit,
   documented choices, not the result of statistical calibration** --
   same as other thresholds in this codebase (`smartMoneyAnalysis.ts`,
   `detectMmActivity.ts`). `pipeline_decision_log` +
   `whalescope_backtest_pipeline_decisions` exist so this threshold can be
   tested going forward; the log does **not** auto-tune weights.
9. **HIGH token cost.** A single call can trigger over a dozen proxy
   fetches per symbol (more for symbols that pass the hard screen) -- use
   this for final decisions, not initial exploration.

---

## 12. Decision log & formula tests (2026-08-31)

`pipeline_decision_log` (migration 0011) stores one compact row per symbol
after entry-alert Phase 2 (always) and after `whalescope_full_pipeline`
when `persist=true`.

- **Stored:** `run_at`, symbol, `source` (`entry_alert` | `manual` |
  `dropstab`), `source_ref` (Dropstab tab slug / label), decision,
  `ranking_score`, hard-screen pass + reasons, volume, funding, 1h/4h
  regime, `grid_risk_status`, lower/upper/SL. Hard-screen rejects are
  still logged (grid bounds may be null).
- **Not stored:** `forward_return_*`. Computed on-demand by
  `whalescope_backtest_pipeline_decisions` from 1h klines (same pattern as
  `binance_backtest_signal`): win rate / avg return / SL-touch, bucketed
  by decision and score (`lt_40` / `40_55` / `gte_55`).
- **Not done:** auto-tuning the 35/30/20/15 ranking weights or the 55
  threshold. The log is test material, not an optimizer input.
- **Retention:** 90 days (same as `market_snapshots` / `signal_history`).
  `entry_alert_skip_log` extended 7 → 30 days for F3 audits.
- **No second heavy cron.** Persist rides the entry-alert tick that
  already paid for `full_pipeline`.

### Test protocol (agreed 2026-08-31)

The initial formula is **frozen** for the test. It is the installed
hypothesis, not a claim that it is already correct.

| Parameter | Installed value |
|---|---|
| Ranking weights (MM / smart money / regime / buy pressure) | 35 / 30 / 20 / 15 |
| TRADE threshold | 55 |
| Minimum 24h quote volume | $5,000,000 |
| Max \|funding\| | 0.05% (`0.0005`) |

Rules:

1. **Do not change** the weights, the 55 threshold, or the hard-screen
   values above until the protocol below is met. A zero-TRADE risk-off day
   is neither proof the formula is broken nor proof it is right.
2. **24-hour peek** (reading the log / `whalescope_backtest_pipeline_decisions`)
   is allowed — read-only, no number changes.
3. **Serious review at 14 days** — first window to decide whether the gate
   is too tight. 30/90 days are D1 retention, not a reason to delay reading.
4. **Do not retune** until there are **≥20 TRADE** rows with both **4h and
   24h** forward returns complete, across **≥3 distinct 4h regimes**.
5. If **TRADE is still 0 after 14 days**, that **is the test result** (55 is
   too tight for the observed market) — only then discuss loosening. Not a
   rewrite on day one.

*Created: 2026-08-22, alongside the `whalescope_full_pipeline` release.*
*Updated 2026-08-31: pipeline_decision_log + on-demand backtest (§12).*
*Updated 2026-08-31: freeze formula-test protocol (weights/55) until sample is enough.*
