// KV-backed global risk switch + daily-loss circuit breaker.
// Hanya mem-gate jalur cron entry-alert (Telegram). Tool MCP
// whalescope_full_pipeline tetap callable -- pause/mute tidak
// menyentuh path on-demand.
//
// Keys (CONFIG_KV):
//   state:daily_loss_circuit  -- { count, total_loss, window_start, last_notified_at? }
//   state:macro_risk_circuit  -- { active, reason?, at?, last_notified_at? }
//
// Daily trip: count >= 3 ATAU total_loss >= 60 dalam window ~24 jam
// (KV expirationTtl 25 jam, jadi window roll-off otomatis).
// Macro: active === true -> cron skip Phase 2 (deep pipeline).

import * as kvConfig from "../kvConfig.js";

export const DAILY_LOSS_KEY = "state:daily_loss_circuit";
export const MACRO_RISK_KEY = "state:macro_risk_circuit";

export const DAILY_LOSS_COUNT_LIMIT = 3;
export const DAILY_LOSS_USD_LIMIT = 60;
export const CIRCUIT_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;
export const DAILY_LOSS_TTL_SECONDS = 25 * 60 * 60;

export interface DailyLossCircuitState {
  count: number;
  total_loss: number;
  window_start: number;
  last_notified_at?: number;
}

export interface MacroRiskCircuitState {
  active: boolean;
  reason?: string;
  at?: number;
  last_notified_at?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export async function getDailyLossCircuit(): Promise<DailyLossCircuitState | null> {
  try {
    const raw = await kvConfig.getJson<unknown>(DAILY_LOSS_KEY);
    if (!isRecord(raw)) return null;
    if (typeof raw.count !== "number" || typeof raw.total_loss !== "number") return null;
    if (typeof raw.window_start !== "number") return null;
    return {
      count: raw.count,
      total_loss: raw.total_loss,
      window_start: raw.window_start,
      last_notified_at: typeof raw.last_notified_at === "number" ? raw.last_notified_at : undefined,
    };
  } catch {
    return null;
  }
}

export async function getMacroRiskCircuit(): Promise<MacroRiskCircuitState | null> {
  try {
    const raw = await kvConfig.getJson<unknown>(MACRO_RISK_KEY);
    if (!isRecord(raw)) return null;
    if (typeof raw.active !== "boolean") return null;
    return {
      active: raw.active,
      reason: typeof raw.reason === "string" ? raw.reason : undefined,
      at: typeof raw.at === "number" ? raw.at : undefined,
      last_notified_at: typeof raw.last_notified_at === "number" ? raw.last_notified_at : undefined,
    };
  } catch {
    return null;
  }
}

export function isDailyLossTripped(state: DailyLossCircuitState | null): boolean {
  if (!state) return false;
  return state.count >= DAILY_LOSS_COUNT_LIMIT || state.total_loss >= DAILY_LOSS_USD_LIMIT;
}

export async function isMacroRiskActive(): Promise<boolean> {
  const state = await getMacroRiskCircuit();
  return state?.active === true;
}

export async function isDailyLossCircuitOpen(): Promise<boolean> {
  return isDailyLossTripped(await getDailyLossCircuit());
}

export async function recordTradeAlert(
  riskUsd: number,
  heads: number,
  now: number = Date.now(),
): Promise<DailyLossCircuitState | null> {
  if (heads <= 0 || !Number.isFinite(riskUsd) || riskUsd < 0) {
    return getDailyLossCircuit();
  }
  try {
    const existing = await getDailyLossCircuit();
    const next: DailyLossCircuitState = {
      count: (existing?.count ?? 0) + heads,
      total_loss: (existing?.total_loss ?? 0) + riskUsd * heads,
      window_start: existing?.window_start ?? now,
      last_notified_at: existing?.last_notified_at,
    };
    await kvConfig.putJson(DAILY_LOSS_KEY, next, { expirationTtl: DAILY_LOSS_TTL_SECONDS });
    return next;
  } catch (err) {
    console.error("[risk-circuit] gagal recordTradeAlert:", (err as Error)?.message ?? String(err));
    return null;
  }
}

export function shouldNotifyDailyLoss(state: DailyLossCircuitState | null, now: number): boolean {
  if (!isDailyLossTripped(state)) return false;
  if (state?.last_notified_at != null && now - state.last_notified_at < CIRCUIT_NOTIFY_COOLDOWN_MS) {
    return false;
  }
  return true;
}

export async function markDailyLossNotified(now: number = Date.now()): Promise<void> {
  try {
    const existing = (await getDailyLossCircuit()) ?? { count: 0, total_loss: 0, window_start: now };
    existing.last_notified_at = now;
    await kvConfig.putJson(DAILY_LOSS_KEY, existing, { expirationTtl: DAILY_LOSS_TTL_SECONDS });
  } catch (err) {
    console.error("[risk-circuit] gagal markDailyLossNotified:", (err as Error)?.message ?? String(err));
  }
}

export function shouldNotifyMacro(state: MacroRiskCircuitState | null, now: number): boolean {
  if (!state?.active) return false;
  if (state.last_notified_at != null && now - state.last_notified_at < CIRCUIT_NOTIFY_COOLDOWN_MS) {
    return false;
  }
  return true;
}

export async function markMacroNotified(now: number = Date.now()): Promise<void> {
  try {
    const existing = await getMacroRiskCircuit();
    if (!existing) return;
    existing.last_notified_at = now;
    await kvConfig.putJson(MACRO_RISK_KEY, existing);
  } catch (err) {
    console.error("[risk-circuit] gagal markMacroNotified:", (err as Error)?.message ?? String(err));
  }
}

export async function setMacroRisk(
  active: boolean,
  reason?: string,
  now: number = Date.now(),
): Promise<MacroRiskCircuitState> {
  const next: MacroRiskCircuitState = { active, reason, at: now };
  await kvConfig.putJson(MACRO_RISK_KEY, next);
  return next;
}

export async function resetDailyLoss(now: number = Date.now()): Promise<DailyLossCircuitState> {
  const next: DailyLossCircuitState = { count: 0, total_loss: 0, window_start: now };
  await kvConfig.putJson(DAILY_LOSS_KEY, next, { expirationTtl: DAILY_LOSS_TTL_SECONDS });
  return next;
}
