# Vercel Hobby — Quota Notes & Formula

> **Status: THE VERCEL RELAY IS RETIRED.** This document is a reference note
> **in case Vercel is ever reconsidered** as a host for the Binance relay. It
> is not an active setup. The production relay today is the AWS VPS running
> `proxy-standalone/` (see
> [`proxy-standalone/README.md`](../proxy-standalone/README.md)).

## 0. The real blocker was NOT the quota

`proxy/` (Vercel) was abandoned **not** because the quota ran out, but because
the Hobby plan **forbids commercial use** — Vercel auto-pauses the project
itself. So:

- The quota formula below is relevant **ONLY** on a **paid plan (Pro)** or for
  a clearly non-commercial use case.
- **Do not** conclude "the quota fits → Hobby is safe." The constraint is the
  ToS, not the minute count.

## 1. The metric: Vercel Hobby "Active CPU"

- **Quota:** 4 hours/month = **240 minutes/month** (the *Active CPU* metric =
  compute time while the function is actually executing, NOT wall-clock).
- **Measured baseline** (verified from the **real** usage dashboard, not a
  third-party article — see `src/shared.ts:22-26`):
  **10 pairs (SNAPSHOT cron `*/5`) ≈ 35 minutes/month (~15% of quota).**

## 2. Formula

For the **SNAPSHOT cron `*/5`** workload (~11 calls/pair/run, 288 runs/day):

```
CPU_minutes_per_month ≈ N_pairs × 3.5
```

Derived from: 10 pairs = 35 minutes → **3.5 minutes / pair / month** (assuming
linearity).

As a percentage of quota:

```
%quota ≈ (N_pairs × 3.5) / 240 × 100
```

Ceiling (the limit before hitting 100% of quota):

```
N_pairs_max ≈ 240 / 3.5 ≈ 68 pairs
```

## 3. Examples

| N_pairs | CPU minutes/month | % of 240 |
|---|---|---|
| 10 | 35 | ~15% |
| 50 | 175 | ~73% |
| 68 | ~238 | ~99% (ceiling) |

At 50 pairs the headroom is **already not comfortable** (~73%) — that figure is
what the "monitor Vercel usage" note in `src/shared.ts` is based on.

## 4. Validity limits of the formula (READ BEFORE USING)

- **Only for the SNAPSHOT cron `*/5` workload** (~11 calls/pair). Does **NOT**
  include `entryAlertCron` (250–500 pairs, far heavier) — if entry-alert also
  ran on Vercel the quota would blow far sooner and this formula **does not
  apply**.
- **Linear extrapolation**, validated only at the measured points (10 & 50
  pairs). Cron overlap within the same window can make consumption
  **superlinear**.
- The `3.5 minutes/pair/month` figure is **specific** to the calls-per-pair
  configuration at that time. If the calls/pair, cron cadence, or region
  change → **re-measure the baseline**; do not reuse this constant blindly.
- "Active CPU" ≠ wall-clock. Do not mix it up with the cron wall-clock cap
  (a separate limit — see the `[limits]`/cron comments in `wrangler.toml` for
  the Cloudflare context, which is not Vercel).

## 5. When this document is relevant

- **Only** if there is a concrete plan to return to Vercel on a **paid plan**
  or for a non-commercial use case.
- For the Binance relay today: **use a VPS / Fly.io / Deno Deploy** (Singapore
  or Tokyo region) — see
  [`proxy-standalone/README.md`](../proxy-standalone/README.md). Vercel is a
  historical/retired path.
