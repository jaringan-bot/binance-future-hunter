import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { symbolSchema, errorResult, detailParam } from "../shared.js";
import { fmtNum, fmtPrice, fmtTime } from "../format.js";
import * as gw from "../streamGatewayClient.js";

const RECENT_LIMIT = 15;
const DEPTH_EVENT_LIMIT = 40;

// Binance throttles !forceOrder@arr to at most one event per symbol per
// second — this feed is a SAMPLE of liquidations, not every one. Said in
// every response so nobody over-reads a low count.
const SAMPLED_NOTE =
  "Catatan: stream !forceOrder@arr di-throttle Binance (maks 1 event/symbol/detik) — ini SAMPEL likuidasi, bukan semua.";

function gatewayDegradedReason(err: unknown): string {
  if (err instanceof gw.StreamGatewayError) {
    if (err.status === 401 || err.status === 403) {
      return `stream gateway HTTP ${err.status} — cek PROXY_SECRET di worker vs gateway.`;
    }
    return err.message || `stream gateway HTTP ${err.status ?? "error"}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerRealtimeStreamTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_get_realtime_liquidations",
    {
      title: "Likuidasi Real-Time (near-real-time, dari stream)",
      description:
        "Likuidasi paksa (forced liquidation) terbaru market-wide dari WebSocket stream Binance, di-buffer di gateway " +
        "VPS. Filter per symbol / minimal notional. Feed di-SAMPEL oleh Binance (maks 1/symbol/detik). Beda dari tool " +
        "REST lain: ini event yang BARU terjadi (detik-menit lalu), bukan snapshot periodik. Kalau gateway/stream " +
        "lagi bermasalah, tool tetap balikin data seadanya + flag 'degraded', bukan diam-diam kosong.",
      inputSchema: {
        symbol: symbolSchema.optional(),
        limit: z.number().int().min(1).max(1000).optional().default(100),
        minNotionalUsd: z.number().positive().optional(),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit, minNotionalUsd, detail }) => {
      try {
        const res = await gw.fetchLiquidations({ symbol, limit, minNotionalUsd });
        const evs = res.events;

        const totalNotional = evs.reduce((s, e) => s + (e.notional_usd || 0), 0);
        const buy = evs.filter((e) => e.side === "BUY");
        const sell = evs.filter((e) => e.side === "SELL");
        const buyNotional = buy.reduce((s, e) => s + e.notional_usd, 0);
        const sellNotional = sell.reduce((s, e) => s + e.notional_usd, 0);

        const bySymbol = new Map<string, { count: number; notional: number }>();
        for (const e of evs) {
          const cur = bySymbol.get(e.symbol) ?? { count: 0, notional: 0 };
          cur.count += 1;
          cur.notional += e.notional_usd;
          bySymbol.set(e.symbol, cur);
        }
        const topSymbols = [...bySymbol.entries()]
          .sort((a, b) => b[1].notional - a[1].notional)
          .slice(0, 5)
          .map(([sym, v]) => ({ symbol: sym, count: v.count, notionalUsd: v.notional }));
        const biggest = evs.reduce<(typeof evs)[number] | null>(
          (m, e) => (m == null || e.notional_usd > m.notional_usd ? e : m),
          null,
        );

        const header = symbol ? `# Likuidasi Real-Time — ${symbol}` : `# Likuidasi Real-Time — market-wide`;
        const lines = [header, ""];
        if (res.degraded) {
          lines.push(`⚠️ **STREAM DEGRADED**: ${res.degradedReason}. Data di bawah mungkin tidak lengkap / basi.`, "");
        }
        if (evs.length === 0) {
          lines.push("Belum ada event likuidasi di window buffer (atau filter terlalu ketat).", "", SAMPLED_NOTE);
        } else {
          lines.push(
            `- Event: ${evs.length} · Total notional ~$${fmtNum(totalNotional, 0)}`,
            `- Sisi: ${sell.length} SELL (long liquidated, ~$${fmtNum(sellNotional, 0)}) vs ${buy.length} BUY (short liquidated, ~$${fmtNum(buyNotional, 0)})`,
            biggest
              ? `- Terbesar: ${biggest.symbol} ${biggest.side} ${fmtNum(biggest.orig_qty, 3)} @ ${fmtPrice(biggest.price)} (~$${fmtNum(biggest.notional_usd, 0)})`
              : "",
            "",
            "## Top symbol (by notional)",
            "| Symbol | Event | Notional |",
            "|---|---|---|",
            ...topSymbols.map((t) => `| ${t.symbol} | ${t.count} | $${fmtNum(t.notionalUsd, 0)} |`),
            "",
            `## ${Math.min(RECENT_LIMIT, evs.length)} terbaru`,
            "| Waktu | Symbol | Sisi | Qty | Harga | Notional |",
            "|---|---|---|---|---|---|",
            ...evs.slice(0, RECENT_LIMIT).map(
              (e) =>
                `| ${fmtTime(e.trade_time)} | ${e.symbol} | ${e.side} | ${fmtNum(e.orig_qty, 3)} | ${fmtPrice(e.price)} | $${fmtNum(e.notional_usd, 0)} |`,
            ),
            "",
            SAMPLED_NOTE,
          );
        }

        return {
          content: [{ type: "text", text: lines.filter((l) => l !== "").join("\n") }],
          structuredContent: {
            symbol: symbol ?? null,
            degraded: res.degraded,
            degradedReason: res.degradedReason,
            totalCount: evs.length,
            totalNotionalUsd: totalNotional,
            sellCount: sell.length,
            buyCount: buy.length,
            sellNotionalUsd: sellNotional,
            buyNotionalUsd: buyNotional,
            topSymbols,
            biggest,
            recent: evs.slice(0, RECENT_LIMIT),
            streamHealth: res.meta?.streamHealth,
            ...(detail === "full" ? { events: evs } : {}),
          },
        };
      } catch (err) {
        if (err instanceof gw.StreamGatewayError) {
          const reason = gatewayDegradedReason(err);
          return {
            content: [
              {
                type: "text",
                text: [
                  symbol ? `# Likuidasi Real-Time — ${symbol}` : `# Likuidasi Real-Time — market-wide`,
                  "",
                  `⚠️ **STREAM DEGRADED**: ${reason}. Data di bawah mungkin tidak lengkap / basi.`,
                  "",
                  "Belum ada event likuidasi di window buffer (atau filter terlalu ketat).",
                  "",
                  SAMPLED_NOTE,
                ].join("\n"),
              },
            ],
            structuredContent: {
              symbol: symbol ?? null,
              degraded: true,
              degradedReason: reason,
              totalCount: 0,
              totalNotionalUsd: 0,
              sellCount: 0,
              buyCount: 0,
              sellNotionalUsd: 0,
              buyNotionalUsd: 0,
              topSymbols: [],
              biggest: null,
              recent: [],
              streamHealth: undefined,
            },
          };
        }
        return errorResult(err);
      }
    },
  );

  registerSafeTool(
    server,
    "binance_watch_orderbook_realtime",
    {
      title: "Watch Order Book Real-Time (wall lifecycle, on-demand)",
      description:
        "Aktifkan/perpanjang watch sub-detik order book satu symbol lewat WebSocket Binance @depth@100ms di gateway " +
        "VPS, lalu kembalikan event LIFECYCLE WALL (WALL_APPEARED / GREW / SHRANK / VANISHED) yang terkumpul. " +
        "Panggilan PERTAMA biasanya cuma mengarmkan watch (0 event) — panggil lagi beberapa detik kemudian pakai " +
        "`sinceMs` = ts event terakhir untuk lihat perubahan baru. Watch auto-mati setelah `ttlMs` (default 5 menit) " +
        "tanpa perpanjangan. BUKAN L2 book penuh: cuma level di atas ambang notional yang dilacak (hemat memori VPS " +
        "1GB, ada batas jumlah watch bersamaan). Wall pre-existing bisa muncul sebagai 1 WALL_APPEARED saat konek " +
        "(warmup ~1.5s menekan sebagian besar). Ambang wall heuristik, BELUM dikalibrasi. Kalau gateway belum " +
        "di-upgrade / watch penuh / stream putus: balik `degraded: true` + alasan, bukan diam-diam kosong.",
      inputSchema: {
        symbol: symbolSchema,
        ttlMs: z
          .number()
          .int()
          .min(30_000)
          .max(15 * 60_000)
          .optional()
          .describe("Umur watch tanpa perpanjangan (ms). Default 5 menit, maks 15 menit."),
        sinceMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Hanya event dengan ts > nilai ini. Pakai ts event terakhir dari panggilan sebelumnya."),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, ttlMs, sinceMs, detail }) => {
      const header = `# Watch Order Book Real-Time — ${symbol}`;
      try {
        const armed = await gw.watchOrderBook(symbol, ttlMs);
        if (!armed.ok) {
          return {
            content: [
              {
                type: "text",
                text: [header, "", `⚠️ **TIDAK BISA ARM WATCH**: ${armed.error ?? "gagal"}`, armed.activeWatches?.length ? `Watch aktif sekarang: ${armed.activeWatches.join(", ")}` : ""].filter(Boolean).join("\n"),
              },
            ],
            structuredContent: {
              symbol,
              watching: false,
              degraded: true,
              degradedReason: armed.error ?? "gagal arm watch",
              armed: false,
              events: [],
              eventCount: 0,
            },
          };
        }

        const diff = await gw.fetchDepthDiff(symbol, sinceMs);
        const evs = diff.events;
        const counts = { WALL_APPEARED: 0, WALL_GREW: 0, WALL_SHRANK: 0, WALL_VANISHED: 0 } as Record<string, number>;
        for (const e of evs) counts[e.type] = (counts[e.type] ?? 0) + 1;
        const bidEvents = evs.filter((e) => e.side === "bid").length;
        const askEvents = evs.filter((e) => e.side === "ask").length;
        const latestTs = evs.length ? evs[evs.length - 1].ts : (sinceMs ?? 0);

        const lines = [header, ""];
        if (armed.renewed) lines.push(`Watch diperpanjang — kedaluwarsa ~${fmtTime(armed.expiresAt ?? 0)}.`);
        else lines.push(`Watch BARU diaktifkan — kedaluwarsa ~${fmtTime(armed.expiresAt ?? 0)}. Panggil lagi beberapa detik lagi dengan sinceMs=${latestTs} untuk lihat perubahan.`);
        lines.push("");
        if (diff.degraded) {
          lines.push(`⚠️ **STREAM DEGRADED**: ${diff.degradedReason}. Data di bawah mungkin belum lengkap.`, "");
        }
        if (evs.length === 0) {
          lines.push("Belum ada event lifecycle wall di window (watch baru, atau order book stabil).");
        } else {
          lines.push(
            `- Event: ${evs.length} (bid ${bidEvents} / ask ${askEvents})`,
            `- Jenis: APPEARED ${counts.WALL_APPEARED} · GREW ${counts.WALL_GREW} · SHRANK ${counts.WALL_SHRANK} · VANISHED ${counts.WALL_VANISHED}`,
            "",
            `## ${Math.min(DEPTH_EVENT_LIMIT, evs.length)} event terbaru`,
            "| Waktu | Sisi | Jenis | Harga | Qty | Notional |",
            "|---|---|---|---|---|---|",
            ...evs
              .slice(-DEPTH_EVENT_LIMIT)
              .map(
                (e) =>
                  `| ${fmtTime(e.ts)} | ${e.side} | ${e.type.replace("WALL_", "")} | ${fmtPrice(e.price)} | ${fmtNum(e.qty, 3)} | $${fmtNum(e.notionalUsd, 0)} |`,
              ),
          );
        }

        return {
          content: [{ type: "text", text: lines.filter((l) => l !== "").join("\n") }],
          structuredContent: {
            symbol,
            watching: diff.watching,
            armed: true,
            renewed: armed.renewed ?? false,
            expiresAt: armed.expiresAt ?? null,
            degraded: diff.degraded,
            degradedReason: diff.degradedReason,
            eventCount: evs.length,
            counts,
            bidEvents,
            askEvents,
            latestTs,
            meta: diff.meta,
            recent: evs.slice(-DEPTH_EVENT_LIMIT),
            ...(detail === "full" ? { events: evs } : {}),
          },
        };
      } catch (err) {
        if (err instanceof gw.StreamGatewayError) {
          const reason = gatewayDegradedReason(err);
          return {
            content: [
              {
                type: "text",
                text: [header, "", `⚠️ **STREAM DEGRADED**: ${reason}.`, "", "Gateway belum di-upgrade untuk depth watch, atau tidak bisa dihubungi."].join("\n"),
              },
            ],
            structuredContent: {
              symbol,
              watching: false,
              armed: false,
              degraded: true,
              degradedReason: reason,
              eventCount: 0,
              recent: [],
            },
          };
        }
        return errorResult(err);
      }
    },
  );

  registerSafeTool(
    server,
    "binance_get_contract_events",
    {
      title: "Event Kontrak Futures (listing / delisting / settlement)",
      description:
        "Perubahan status kontrak USDS-M dari stream !contractInfo (di-buffer di gateway VPS): listing baru " +
        "(PENDING_TRADING → TRADING), delisting, jadwal settlement, perubahan bracket. Lebih cepat tau pair baru " +
        "daripada polling onboardDate di exchangeInfo. Event jarang — window buffer 30 hari.",
      inputSchema: {
        symbol: symbolSchema.optional(),
        limit: z.number().int().min(1).max(500).optional().default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit }) => {
      try {
        const res = await gw.fetchContractEvents({ symbol, limit });
        const rows = res.events.map((e) => ({
          symbol: e.symbol,
          pair: e.pair,
          contractType: e.contract_type,
          contractStatus: e.contract_status,
          onboardDate: e.onboard_date || null,
          deliveryDate: e.delivery_date || null,
          eventTime: e.event_time,
        }));

        const lines = [`# Event Kontrak Futures${symbol ? ` — ${symbol}` : ""}`, ""];
        if (res.degraded) {
          lines.push(`⚠️ **STREAM DEGRADED**: ${res.degradedReason}.`, "");
        }
        if (rows.length === 0) {
          lines.push("Belum ada event kontrak di window buffer (30 hari). Ini normal — event ini jarang.");
        } else {
          lines.push(
            "| Waktu | Symbol | Status | Tipe | Onboard | Delivery |",
            "|---|---|---|---|---|---|",
            ...rows.map(
              (r) =>
                `| ${fmtTime(r.eventTime)} | ${r.symbol} | ${r.contractStatus ?? "-"} | ${r.contractType ?? "-"} | ${r.onboardDate ? fmtTime(r.onboardDate) : "-"} | ${r.deliveryDate ? fmtTime(r.deliveryDate) : "-"} |`,
            ),
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            symbol: symbol ?? null,
            degraded: res.degraded,
            degradedReason: res.degradedReason,
            count: rows.length,
            events: rows,
            streamHealth: res.meta?.streamHealth,
          },
        };
      } catch (err) {
        if (err instanceof gw.StreamGatewayError) {
          const reason = gatewayDegradedReason(err);
          return {
            content: [
              {
                type: "text",
                text: [
                  `# Event Kontrak Futures${symbol ? ` — ${symbol}` : ""}`,
                  "",
                  `⚠️ **STREAM DEGRADED**: ${reason}.`,
                  "",
                  "Belum ada event kontrak di window buffer (30 hari). Ini normal — event ini jarang.",
                ].join("\n"),
              },
            ],
            structuredContent: {
              symbol: symbol ?? null,
              degraded: true,
              degradedReason: reason,
              count: 0,
              events: [],
              streamHealth: undefined,
            },
          };
        }
        return errorResult(err);
      }
    },
  );
}
