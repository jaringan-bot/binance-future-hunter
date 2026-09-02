import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDashboardRequest, DASHBOARD_HTML } from "./dashboardApi.js";
import * as d1Client from "./d1Client.js";
import * as riskCircuit from "./engine/riskCircuitBreaker.js";

vi.mock("./d1Client.js", () => ({
  queryPipelineDecisionLog: vi.fn(),
  querySignalHistory: vi.fn(),
  queryHyperliquidWhaleRecentByCoin: vi.fn(),
}));
vi.mock("./engine/riskCircuitBreaker.js", () => ({
  getDailyLossCircuit: vi.fn(),
  getMacroRiskCircuit: vi.fn(),
}));

const ENV = { ADMIN_SECRET: "s3cr3t" };
const u = (path: string) => new URL("https://w.example" + path);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([]);
  vi.mocked(d1Client.querySignalHistory).mockResolvedValue([]);
  vi.mocked(d1Client.queryHyperliquidWhaleRecentByCoin).mockResolvedValue([]);
  vi.mocked(riskCircuit.getDailyLossCircuit).mockResolvedValue(null);
  vi.mocked(riskCircuit.getMacroRiskCircuit).mockResolvedValue(null);
});

describe("handleDashboardRequest — routing", () => {
  it("returns null for paths it does not own", async () => {
    expect(await handleDashboardRequest(u("/mcp"), ENV)).toBeNull();
    expect(await handleDashboardRequest(u("/admin/usage"), ENV)).toBeNull();
    expect(await handleDashboardRequest(u("/"), ENV)).toBeNull();
  });

  it("404s an unknown /api/dashboard/ subpath (still gated)", async () => {
    const res = await handleDashboardRequest(u("/api/dashboard/nope?key=s3cr3t"), ENV);
    expect(res?.status).toBe(404);
  });
});

describe("handleDashboardRequest — auth", () => {
  it("403s every dashboard path without a valid key", async () => {
    for (const p of [
      "/dashboard",
      "/api/dashboard/pipeline-decisions",
      "/api/dashboard/signals?symbol=BTCUSDT",
      "/api/dashboard/whales",
      "/api/dashboard/circuit-breaker",
    ]) {
      const res = await handleDashboardRequest(u(p), ENV);
      expect(res?.status).toBe(403);
    }
  });

  it("403s when ADMIN_SECRET is unset even if a key is supplied", async () => {
    const res = await handleDashboardRequest(u("/api/dashboard/circuit-breaker?key=whatever"), {});
    expect(res?.status).toBe(403);
  });

  it("does not touch D1 on an auth failure", async () => {
    await handleDashboardRequest(u("/api/dashboard/pipeline-decisions"), ENV);
    expect(d1Client.queryPipelineDecisionLog).not.toHaveBeenCalled();
  });
});

describe("handleDashboardRequest — data endpoints", () => {
  it("serves the HTML page at /dashboard with a valid key", async () => {
    const res = await handleDashboardRequest(u("/dashboard?key=s3cr3t"), ENV);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toContain("text/html");
    expect(await res?.text()).toBe(DASHBOARD_HTML);
  });

  it("pipeline-decisions passes a bounded window + limit to the existing query", async () => {
    vi.mocked(d1Client.queryPipelineDecisionLog).mockResolvedValue([
      { symbol: "BTCUSDT", decision: "TRADE" } as never,
    ]);
    const res = await handleDashboardRequest(u("/api/dashboard/pipeline-decisions?key=s3cr3t&hours=6&limit=5&symbol=btcusdt"), ENV);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as any;
    expect(body.count).toBe(1);
    const arg = vi.mocked(d1Client.queryPipelineDecisionLog).mock.calls[0][0];
    expect(arg.limit).toBe(5);
    expect(arg.symbol).toBe("btcusdt");
    expect(arg.endTime - arg.startTime).toBe(6 * 3_600_000);
  });

  it("signals requires a symbol param", async () => {
    const res = await handleDashboardRequest(u("/api/dashboard/signals?key=s3cr3t"), ENV);
    expect(res?.status).toBe(400);
    expect(d1Client.querySignalHistory).not.toHaveBeenCalled();
  });

  it("signals forwards symbol + type to querySignalHistory", async () => {
    await handleDashboardRequest(u("/api/dashboard/signals?key=s3cr3t&symbol=ethusdt&type=spoofing&hours=12"), ENV);
    const [sym, type] = vi.mocked(d1Client.querySignalHistory).mock.calls[0];
    expect(sym).toBe("ethusdt");
    expect(type).toBe("spoofing");
  });

  it("whales defaults the coin to BTC", async () => {
    await handleDashboardRequest(u("/api/dashboard/whales?key=s3cr3t"), ENV);
    expect(d1Client.queryHyperliquidWhaleRecentByCoin).toHaveBeenCalledWith("BTC");
  });

  it("circuit-breaker returns both KV states", async () => {
    vi.mocked(riskCircuit.getDailyLossCircuit).mockResolvedValue({ count: 2, total_loss: -40, window_start: 1 });
    const res = await handleDashboardRequest(u("/api/dashboard/circuit-breaker?key=s3cr3t"), ENV);
    const body = (await res?.json()) as any;
    expect(body.dailyLoss.count).toBe(2);
    expect(body.macro).toBeNull();
  });

  it("surfaces a query error as a 500 JSON body, not a throw", async () => {
    vi.mocked(d1Client.queryHyperliquidWhaleRecentByCoin).mockRejectedValue(new Error("d1 boom"));
    const res = await handleDashboardRequest(u("/api/dashboard/whales?key=s3cr3t&coin=eth"), ENV);
    expect(res?.status).toBe(500);
    expect(((await res?.json()) as any).error).toContain("d1 boom");
  });
});
