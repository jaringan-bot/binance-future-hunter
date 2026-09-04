/**
 * Real maintenance-margin ratio from Binance `/fapi/v1/leverageBracket`
 * (SIGNED USER_DATA). Falls back to caller heuristic when credentials are
 * missing or the fetch fails — never blocks grid risk on bracket outage.
 */

import { getLeverageBracket, hasBinanceApiCredentials } from "./binanceProxyClient.js";

export interface LeverageBracketTier {
  bracket: number;
  initialLeverage: number;
  notionalCap: number;
  notionalFloor: number;
  maintMarginRatio: number;
  cum: number;
}

const BRACKET_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — brackets change rarely
const bracketCache = new Map<string, { expiresAt: number; tiers: LeverageBracketTier[] }>();

/** Test helper — clear in-memory bracket cache between cases. */
export function clearLeverageBracketCache(): void {
  bracketCache.clear();
}

/**
 * Pick the bracket tier for a position notional (USDT). Floors are inclusive;
 * caps exclusive except the last tier (inclusive). Oversized notional → last
 * (most conservative MMR).
 */
export function pickBracketForNotional(
  brackets: LeverageBracketTier[],
  notional: number,
): LeverageBracketTier | undefined {
  if (brackets.length === 0 || !Number.isFinite(notional) || notional < 0) {
    return undefined;
  }
  const sorted = [...brackets].sort((a, b) => a.notionalFloor - b.notionalFloor);
  for (let i = 0; i < sorted.length; i += 1) {
    const tier = sorted[i];
    const isLast = i === sorted.length - 1;
    if (
      notional >= tier.notionalFloor &&
      (isLast ? notional <= tier.notionalCap : notional < tier.notionalCap)
    ) {
      return tier;
    }
  }
  return sorted[sorted.length - 1];
}

function parseTiers(raw: unknown): LeverageBracketTier[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const entry = raw[0] as { brackets?: unknown };
  if (!Array.isArray(entry?.brackets)) return [];
  const out: LeverageBracketTier[] = [];
  for (const row of entry.brackets) {
    const r = row as Record<string, unknown>;
    const tier: LeverageBracketTier = {
      bracket: Number(r.bracket),
      initialLeverage: Number(r.initialLeverage),
      notionalCap: Number(r.notionalCap),
      notionalFloor: Number(r.notionalFloor),
      maintMarginRatio: Number(r.maintMarginRatio),
      cum: Number(r.cum),
    };
    if (
      Number.isFinite(tier.notionalFloor) &&
      Number.isFinite(tier.notionalCap) &&
      Number.isFinite(tier.maintMarginRatio) &&
      tier.maintMarginRatio > 0
    ) {
      out.push(tier);
    }
  }
  return out;
}

async function loadTiers(symbol: string): Promise<LeverageBracketTier[]> {
  const key = symbol.toUpperCase();
  const hit = bracketCache.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.tiers;

  const raw = await getLeverageBracket(key);
  const tiers = parseTiers(raw);
  if (tiers.length > 0) {
    bracketCache.set(key, { expiresAt: now + BRACKET_CACHE_TTL_MS, tiers });
  }
  return tiers;
}

/**
 * Returns real `maintMarginRatio` for `notionalUsd`, or `undefined` if
 * credentials missing / fetch failed / empty brackets (caller uses heuristic).
 */
export async function fetchMaintMarginRatio(
  symbol: string,
  notionalUsd: number,
): Promise<number | undefined> {
  if (!Number.isFinite(notionalUsd) || notionalUsd < 0) return undefined;
  try {
    // Missing export (partial test mocks) or unset secrets → heuristic.
    if (typeof hasBinanceApiCredentials === "function") {
      if (!hasBinanceApiCredentials()) return undefined;
    } else if (typeof getLeverageBracket !== "function") {
      return undefined;
    }
    const tiers = await loadTiers(symbol);
    const tier = pickBracketForNotional(tiers, notionalUsd);
    if (tier === undefined) return undefined;
    return tier.maintMarginRatio;
  } catch (err) {
    console.warn(
      `[leverageBracket] ${symbol}: ${(err as Error)?.message ?? String(err)} — using volume heuristic`,
    );
    return undefined;
  }
}
