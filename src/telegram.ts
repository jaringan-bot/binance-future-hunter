// Kirim alert ke Telegram (entryAlertCron.ts) lewat Bot API sendMessage.
// SENGAJA gak pernah throw -- kegagalan kirim (token belum di-set, Telegram
// down, chat_id salah) di-log doang, supaya satu symbol/tick gagal kirim
// alert TIDAK menggagalkan symbol lain atau cron snapshot utama.
import { fmtPrice } from "./format.js";
import type { TraditionalFuturesResult } from "./cron/traditionalPipelineEngine.js";
import type { SymbolPipelineResult } from "./tools/fullPipeline.js";
import type { DcaHeadResult } from "./dcaPipelineEngine.js";

export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

// Legacy Telegram "Markdown" parse_mode treats _ * ` [ as entity delimiters
// that must appear in balanced pairs across the WHOLE message. Enum-derived
// strings interpolated into alert text (e.g. MarketStructureCondition values
// like "LONG_LIQUIDATION_RISK", "BULLISH_ACCUMULATION") contain underscores,
// so depending on which combination of values shows up together, the total
// underscore count across the message can land on odd -- Telegram then
// rejects the whole send with "can't find end of the entity" (found live,
// 2026-08-27, RegimeCap investigation session -- see
// project_whalescope-mcp_status memory for the exact failing combinations).
// Escape every dynamic/enum-derived string before interpolating it into a
// parse_mode:"Markdown" message so no combination of values can ever break
// pairing again, regardless of what future enum values get added.
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*`[])/g, "\\$1");
}

// ─────────────────────────────────────────────────────────────
// formatTraditionalFuturesAlert -- blok pesan Markdown untuk sinyal
// "Traditional Futures" (Single Entry / Single SL / Single TP + R:R),
// dipakai formatEntryAlert (entryAlertCron.ts) saat trad.decision === "TRAD_TRADE".
// gridResult/dcaResult opsional -- cuma dipakai buat 1 baris konteks silang.
// SEMUA string dinamis/enum WAJIB lewat escapeMarkdown (parse_mode "Markdown"
// legacy butuh _ * ` [ berpasangan di seluruh pesan).
// ─────────────────────────────────────────────────────────────
export function formatTraditionalFuturesAlert(
  symbol: string,
  trad: TraditionalFuturesResult,
  gridResult?: SymbolPipelineResult,
  dcaResult?: DcaHeadResult,
): string {
  const dir = trad.side ?? "-";
  const confPct = Math.round(trad.confidence * 100);
  const entry = trad.entry ?? 0;
  const sl = trad.stopLoss ?? 0;
  const tp1 = trad.takeProfit ?? 0;
  const tp2 = trad.takeProfit2 ?? 0;
  // Isolated: SL hit loses (slPct% of notional) = (slPct * leverage)% of margin.
  const estLossPctOfMargin = trad.recommendedLeverage > 0 ? trad.slPct * trad.recommendedLeverage : 0;
  const riskMargin = trad.recommendedLeverage > 0 ? 100 / trad.recommendedLeverage : 0;

  const lines: string[] = [
    `⚡ *${escapeMarkdown(symbol)}* — TRADITIONAL FUTURES (${escapeMarkdown(`[SCENARIO: ${trad.scenario}]`)})`,
    `📊 Direction: ${escapeMarkdown(dir)} (Isolated) · Confidence: ${confPct}%`,
    "",
    "🎯 BRACKET",
    `   Entry Zone: ${fmtPrice(entry)}`,
    `   Stop Loss: ${fmtPrice(sl)} (${trad.slPct.toFixed(2)}%)`,
    `   Take Profit 1: ${fmtPrice(tp1)}`,
    `   Take Profit 2: ${fmtPrice(tp2)}`,
    `   R:R: ${trad.rr.toFixed(2)}`,
    `   Rec. Leverage (Isolated): ${trad.recommendedLeverage}x`,
    `   Est. Loss ~${estLossPctOfMargin.toFixed(1)}% isolated margin · Risk Margin ~${riskMargin.toFixed(1)}% notional`,
  ];

  if (gridResult || dcaResult) {
    lines.push(
      `   Konteks: Grid ${escapeMarkdown(gridResult?.decision ?? "-")} · DCA ${escapeMarkdown(dcaResult?.decision ?? "-")}`,
    );
  }

  if (trad.reasons.length > 0) {
    lines.push("", "📝 Alasan:");
    for (const reason of trad.reasons) lines.push(`   • ${escapeMarkdown(reason)}`);
  }
  if (trad.dataGaps.length > 0) {
    for (const gap of trad.dataGaps) lines.push(`   ⚠️ ${escapeMarkdown(gap)}`);
  }

  return lines.join("\n");
}

export async function sendTelegramAlert(env: TelegramEnv, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("[telegram] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID belum di-set, alert dilewati:", text);
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[telegram] gagal kirim alert (HTTP ${response.status}): ${body.slice(0, 300)}`);
    }
  } catch (err) {
    console.error("[telegram] gagal kirim alert:", (err as Error)?.message ?? String(err));
  }
}
