// Kirim alert ke Telegram (entryAlertCron.ts) lewat Bot API sendMessage.
// SENGAJA gak pernah throw -- kegagalan kirim (token belum di-set, Telegram
// down, chat_id salah) di-log doang, supaya satu symbol/tick gagal kirim
// alert TIDAK menggagalkan symbol lain atau cron snapshot utama.
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
