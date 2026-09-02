// Fan-out notifikasi ke banyak channel (Telegram + Discord + generic
// webhook). Generalisasi dari src/telegram.ts: Telegram TIDAK ditulis
// ulang -- TelegramChannel cuma membungkus sendTelegramAlert() supaya
// perilaku ke caller lama identik. Channel lain OPT-IN: kalau env var-nya
// kosong, channel itu di-skip diam-diam (pola sama Telegram sekarang:
// log + skip, TIDAK pernah throw, TIDAK menggagalkan cron).
import { sendTelegramAlert, type TelegramEnv } from "./telegram.js";

export interface NotifyEnv extends TelegramEnv {
  /** OPSIONAL -- Discord webhook URL (Server Settings -> Integrations ->
   *  Webhooks). Kosong = channel Discord di-skip. */
  DISCORD_WEBHOOK_URL?: string;
  /** OPSIONAL -- endpoint generic yang nerima POST JSON {text}. Kosong =
   *  di-skip. */
  NOTIFY_WEBHOOK_URL?: string;
}

export interface NotificationChannel {
  readonly name: string;
  /** true kalau channel ini punya konfigurasi lengkap di env. */
  configured(env: NotifyEnv): boolean;
  /** Kirim -- WAJIB tidak pernah throw (tangani error internal + log). */
  send(env: NotifyEnv, text: string): Promise<void>;
}

async function postJson(url: string, body: unknown, tag: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[notify:${tag}] gagal kirim (HTTP ${res.status}): ${detail.slice(0, 300)}`);
    }
  } catch (err) {
    console.error(`[notify:${tag}] gagal kirim:`, (err as Error)?.message ?? String(err));
  }
}

export const telegramChannel: NotificationChannel = {
  name: "telegram",
  configured: (env) => Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
  // Delegasi verbatim -- format/parse_mode/escaping tetap di telegram.ts.
  send: (env, text) => sendTelegramAlert(env, text),
};

export const discordChannel: NotificationChannel = {
  name: "discord",
  configured: (env) => Boolean(env.DISCORD_WEBHOOK_URL),
  async send(env, text) {
    if (!env.DISCORD_WEBHOOK_URL) return;
    // Discord: pesan Markdown Telegram di-kirim apa adanya (Discord render
    // sebagian besar mirip). content cap 2000 char.
    await postJson(env.DISCORD_WEBHOOK_URL, { content: text.slice(0, 2000) }, "discord");
  },
};

export const genericWebhookChannel: NotificationChannel = {
  name: "webhook",
  configured: (env) => Boolean(env.NOTIFY_WEBHOOK_URL),
  async send(env, text) {
    if (!env.NOTIFY_WEBHOOK_URL) return;
    await postJson(env.NOTIFY_WEBHOOK_URL, { text }, "webhook");
  },
};

export const NOTIFICATION_CHANNELS: NotificationChannel[] = [
  telegramChannel,
  discordChannel,
  genericWebhookChannel,
];

/**
 * Fan-out `text` ke SEMUA channel yang dikonfigurasi. Tidak pernah throw
 * (pola sendTelegramAlert): satu channel gagal / lambat tidak menggagalkan
 * yang lain atau cron pemanggil (Promise.allSettled). Channel tanpa
 * konfigurasi di-skip -- Telegram tetap channel de-facto kalau cuma itu
 * yang di-set.
 */
export async function dispatchNotification(env: NotifyEnv, text: string): Promise<void> {
  const active = NOTIFICATION_CHANNELS.filter((c) => c.configured(env));
  if (active.length === 0) {
    console.error("[notify] tidak ada channel notifikasi dikonfigurasi, pesan dilewati:", text);
    return;
  }
  const settled = await Promise.allSettled(active.map((c) => c.send(env, text)));
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      // Channel.send seharusnya menangkap error sendiri -- ini jaring
      // pengaman terakhir, jangan sampai bubble ke cron.
      console.error(`[notify] channel ${active[i].name} throw tak terduga:`, (r.reason as Error)?.message ?? String(r.reason));
    }
  });
}
