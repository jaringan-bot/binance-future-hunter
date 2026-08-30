import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as kvConfig from "../kvConfig.js";
import {
  CIRCUIT_NOTIFY_COOLDOWN_MS,
  DAILY_LOSS_KEY,
  DAILY_LOSS_TTL_SECONDS,
  DAILY_LOSS_USD_LIMIT,
  MACRO_RISK_KEY,
  getDailyLossCircuit,
  getMacroRiskCircuit,
  isDailyLossCircuitOpen,
  isDailyLossTripped,
  isMacroRiskActive,
  markDailyLossNotified,
  markMacroNotified,
  recordTradeAlert,
  resetDailyLoss,
  setMacroRisk,
  shouldNotifyDailyLoss,
  shouldNotifyMacro,
} from "./riskCircuitBreaker.js";

vi.mock("../kvConfig.js", () => ({
  getJson: vi.fn().mockResolvedValue(null),
  putJson: vi.fn().mockResolvedValue(undefined),
}));

describe("riskCircuitBreaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(kvConfig.getJson).mockReset().mockResolvedValue(null);
    vi.mocked(kvConfig.putJson).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("treats missing / non-object KV values as not tripped and not active", async () => {
    vi.mocked(kvConfig.getJson).mockResolvedValue(2 as never);
    expect(await getDailyLossCircuit()).toBeNull();
    expect(await getMacroRiskCircuit()).toBeNull();
    expect(await isMacroRiskActive()).toBe(false);
    expect(await isDailyLossCircuitOpen()).toBe(false);
  });

  it("trips when count >= 3 or total_loss >= 60", () => {
    expect(isDailyLossTripped({ count: 2, total_loss: 40, window_start: 1 })).toBe(false);
    expect(isDailyLossTripped({ count: 3, total_loss: 40, window_start: 1 })).toBe(true);
    expect(isDailyLossTripped({ count: 1, total_loss: DAILY_LOSS_USD_LIMIT, window_start: 1 })).toBe(true);
  });

  it("recordTradeAlert increments count and total_loss by heads * riskUsd", async () => {
    vi.mocked(kvConfig.getJson).mockResolvedValue({ count: 1, total_loss: 20, window_start: 1000 });
    const next = await recordTradeAlert(20, 2, 2000);
    expect(next).toEqual({ count: 3, total_loss: 60, window_start: 1000 });
    expect(kvConfig.putJson).toHaveBeenCalledWith(
      DAILY_LOSS_KEY,
      { count: 3, total_loss: 60, window_start: 1000 },
      { expirationTtl: DAILY_LOSS_TTL_SECONDS },
    );
  });

  it("recordTradeAlert starts a window when KV is empty", async () => {
    const next = await recordTradeAlert(20, 1, 5_000);
    expect(next).toEqual({ count: 1, total_loss: 20, window_start: 5_000 });
  });

  it("recordTradeAlert fails open (returns null) when KV write throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(kvConfig.putJson).mockRejectedValue(new Error("kv down"));
    expect(await recordTradeAlert(20, 1, 1)).toBeNull();
  });

  it("shouldNotifyDailyLoss is true once tripped and outside the 1h cooldown", () => {
    const tripped = { count: 3, total_loss: 60, window_start: 1 };
    expect(shouldNotifyDailyLoss(tripped, 10_000)).toBe(true);
    expect(
      shouldNotifyDailyLoss({ ...tripped, last_notified_at: 10_000 - (CIRCUIT_NOTIFY_COOLDOWN_MS - 1) }, 10_000),
    ).toBe(false);
    expect(
      shouldNotifyDailyLoss({ ...tripped, last_notified_at: 10_000 - (CIRCUIT_NOTIFY_COOLDOWN_MS + 1) }, 10_000),
    ).toBe(true);
    expect(shouldNotifyDailyLoss({ count: 1, total_loss: 20, window_start: 1 }, 10_000)).toBe(false);
  });

  it("shouldNotifyMacro is true only while active and outside cooldown", () => {
    expect(shouldNotifyMacro({ active: true, at: 1 }, 10_000)).toBe(true);
    expect(shouldNotifyMacro({ active: false, at: 1 }, 10_000)).toBe(false);
    expect(
      shouldNotifyMacro({ active: true, last_notified_at: 10_000 - (CIRCUIT_NOTIFY_COOLDOWN_MS - 1) }, 10_000),
    ).toBe(false);
  });

  it("setMacroRisk / resetDailyLoss / mark* persist the expected KV keys", async () => {
    await setMacroRisk(true, "btc dump", 9_000);
    expect(kvConfig.putJson).toHaveBeenCalledWith(MACRO_RISK_KEY, { active: true, reason: "btc dump", at: 9_000 });

    await resetDailyLoss(8_000);
    expect(kvConfig.putJson).toHaveBeenCalledWith(
      DAILY_LOSS_KEY,
      { count: 0, total_loss: 0, window_start: 8_000 },
      { expirationTtl: DAILY_LOSS_TTL_SECONDS },
    );

    vi.mocked(kvConfig.getJson).mockImplementation(async (key: string) => {
      if (key === DAILY_LOSS_KEY) return { count: 3, total_loss: 60, window_start: 1 };
      if (key === MACRO_RISK_KEY) return { active: true, at: 1 };
      return null;
    });
    await markDailyLossNotified(12_000);
    expect(kvConfig.putJson).toHaveBeenCalledWith(
      DAILY_LOSS_KEY,
      { count: 3, total_loss: 60, window_start: 1, last_notified_at: 12_000 },
      { expirationTtl: DAILY_LOSS_TTL_SECONDS },
    );
    await markMacroNotified(12_000);
    expect(kvConfig.putJson).toHaveBeenCalledWith(MACRO_RISK_KEY, {
      active: true,
      at: 1,
      last_notified_at: 12_000,
    });
  });
});
