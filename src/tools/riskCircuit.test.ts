import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRiskCircuitTools } from "./riskCircuit.js";
import * as engine from "../engine/riskCircuitBreaker.js";

vi.mock("../engine/riskCircuitBreaker.js", () => ({
  getDailyLossCircuit: vi.fn(),
  getMacroRiskCircuit: vi.fn(),
  isDailyLossTripped: vi.fn(),
  resetDailyLoss: vi.fn(),
  setMacroRisk: vi.fn(),
}));

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

describe("whalescope_risk_circuit", () => {
  let handlers: Map<string, { handler: ToolHandler; inputSchema: Record<string, z.ZodTypeAny> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(engine.getDailyLossCircuit).mockResolvedValue({
      count: 1,
      total_loss: 20,
      window_start: 1,
    });
    vi.mocked(engine.getMacroRiskCircuit).mockResolvedValue({ active: false });
    vi.mocked(engine.isDailyLossTripped).mockReturnValue(false);
    vi.mocked(engine.setMacroRisk).mockImplementation(async (active, reason) => ({
      active,
      reason,
      at: 2,
    }));
    vi.mocked(engine.resetDailyLoss).mockResolvedValue({ count: 0, total_loss: 0, window_start: 3 });

    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, cb: unknown) => {
        handlers.set(name, { handler: cb as ToolHandler, inputSchema: config.inputSchema ?? {} });
        return {};
      },
    } as unknown as McpServer;
    registerRiskCircuitTools(fakeServer);
  });

  function call(args: Record<string, unknown>) {
    const entry = handlers.get("whalescope_risk_circuit");
    if (!entry) throw new Error("tool not registered");
    const parsed = z.object(entry.inputSchema).parse(args);
    return entry.handler(parsed as Record<string, unknown>);
  }

  it("get returns default macro-off + daily counters", async () => {
    const result = await call({ action: "get" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Macro: off/i);
    expect(result.content[0].text).toMatch(/count 1/);
    expect(result.structuredContent?.dailyTripped).toBe(false);
  });

  it("set_macro then get reflects the new macro flag", async () => {
    const setResult = await call({ action: "set_macro", active: true, reason: "halt" });
    expect(engine.setMacroRisk).toHaveBeenCalledWith(true, "halt");
    expect(setResult.content[0].text).toMatch(/macro ON/i);

    vi.mocked(engine.getMacroRiskCircuit).mockResolvedValue({ active: true, reason: "halt" });
    const getResult = await call({ action: "get" });
    expect(getResult.content[0].text).toMatch(/ACTIVE/);
    expect(getResult.content[0].text).toContain("halt");
  });

  it("reset_daily zeroes the daily-loss counters", async () => {
    const result = await call({ action: "reset_daily" });
    expect(engine.resetDailyLoss).toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/di-reset/);
    const daily = result.structuredContent?.daily as { count: number; total_loss: number };
    expect(daily.count).toBe(0);
    expect(daily.total_loss).toBe(0);
  });
});
