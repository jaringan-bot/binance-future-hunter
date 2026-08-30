import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { errorResult } from "../shared.js";
import {
  getDailyLossCircuit,
  getMacroRiskCircuit,
  isDailyLossTripped,
  resetDailyLoss,
  setMacroRisk,
} from "../engine/riskCircuitBreaker.js";

export function registerRiskCircuitTools(server: McpServer): void {
  registerSafeTool(
    server,
    "whalescope_risk_circuit",
    {
      title: "Risk Circuit Breaker (ops)",
      description:
        "Baca atau ubah circuit breaker KV: daily-loss (count/total_loss, trip di 3 hit atau $60) dan macro-risk " +
        "(pause seluruh Phase 2 entry-alert cron). Tidak mengeksekusi order. action=get (default), set_macro, " +
        "atau reset_daily. Hanya mem-gate Telegram TRADE/entry cron, bukan whalescope_full_pipeline on-demand.",
      inputSchema: {
        action: z
          .enum(["get", "set_macro", "reset_daily"])
          .optional()
          .describe("get (default) = baca state; set_macro = nyala/mati pause makro; reset_daily = nolkan daily-loss."),
        active: z
          .boolean()
          .optional()
          .describe("Wajib untuk set_macro: true = pause entry cron, false = resume."),
        reason: z.string().optional().describe("Alasan opsional saat set_macro."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ action, active, reason }) => {
      try {
        const resolved = action ?? "get";
        if (resolved === "set_macro") {
          if (typeof active !== "boolean") {
            return errorResult(new Error("set_macro butuh parameter active (true/false)."));
          }
          const macro = await setMacroRisk(active, reason);
          const daily = await getDailyLossCircuit();
          const text = [
            `# Risk Circuit — macro ${macro.active ? "ON (entry cron paused)" : "OFF"}`,
            macro.reason ? `- Reason: ${macro.reason}` : "",
            `- Daily loss: count ${daily?.count ?? 0} · total_loss $${daily?.total_loss ?? 0} · tripped ${isDailyLossTripped(daily)}`,
          ]
            .filter(Boolean)
            .join("\n");
          return { content: [{ type: "text", text }], structuredContent: { action: resolved, macro, daily } };
        }
        if (resolved === "reset_daily") {
          const daily = await resetDailyLoss();
          const macro = await getMacroRiskCircuit();
          const text = `# Risk Circuit — daily loss di-reset (count=0, total_loss=0)\n- Macro active: ${macro?.active === true}`;
          return { content: [{ type: "text", text }], structuredContent: { action: resolved, daily, macro } };
        }
        const daily = await getDailyLossCircuit();
        const macro = await getMacroRiskCircuit();
        const tripped = isDailyLossTripped(daily);
        const text = [
          `# Risk Circuit`,
          `- Macro: ${macro?.active === true ? "ACTIVE" : "off"}${macro?.reason ? ` (${macro.reason})` : ""}`,
          `- Daily loss: count ${daily?.count ?? 0} · total_loss $${daily?.total_loss ?? 0} · tripped ${tripped}`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { action: resolved, daily, macro, dailyTripped: tripped },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
