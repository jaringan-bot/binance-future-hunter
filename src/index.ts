import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import * as binanceProxy from "./binanceProxyClient.js";
import * as kvConfig from "./kvConfig.js";
import * as streamGateway from "./streamGatewayClient.js";
import * as d1Client from "./d1Client.js";
import { SNAPSHOT_WATCHLIST, WALL_SCAN_WATCHLIST, HYPERLIQUID_WHALE_WATCHLIST } from "./shared.js";
import { computeMmSignals } from "./tools/detectMmActivity.js";
import { isAuthorized } from "./adminUsage.js";
import { scanWallCandidates } from "./cron/wallTrackingCron.js";
import { snapshotBasisForSymbol, snapshotNonWatchlistBasis } from "./cron/marketSnapshotCron.js";
import { snapshotWhaleWallet } from "./cron/hyperliquidWhaleCron.js";
import { snapshotCftcPositioning } from "./cron/cftcPositioningCron.js";
import { backfillPipelineDecisionOutcomes } from "./cron/pipelineDecisionOutcomeCron.js";
import { runEntryAlertCheck } from "./cron/entryAlertCron.js";
import { checkHeartbeat, checkEntryAlertCronFreshness } from "./cron/heartbeatCron.js";
import {
  checkStreamGatewayHealth,
  checkMarketSnapshotFreshness,
  checkD1Capacity,
} from "./cron/infraHealthCron.js";

interface Env {
  PROXY_URL?: string;
  PROXY_SECRET?: string;
  // Proxy sekunder OPSIONAL -- kalau diset, binanceProxyClient otomatis
  // failover ke sini pas primary kena WAF block/rate-limit/5xx. Deploy ke
  // instance Vercel region lain, lihat proxy/README.md.
  PROXY_URL_2?: string;
  PROXY_SECRET_2?: string;
  // OPSIONAL -- "true" buat matikan direct-to-Binance fallback (tier
  // terakhir setelah primary & secondary gagal, lihat komentar DIRECT
  // FALLBACK di binanceProxyClient.ts). Default ON.
  DISABLE_DIRECT_FALLBACK?: string;
  // OPSIONAL -- comma-separated, origin browser TAMBAHAN yang diizinkan
  // memanggil /mcp selain default (https://claude.ai, https://claude.com).
  // Lihat komentar DNS rebinding protection di bawah.
  ALLOWED_ORIGINS?: string;
  CONFIG_KV?: KVNamespace;
  DB?: D1Database;
  // OPSIONAL -- kalau di-set, aktifin GET /admin/usage (ringkasan siapa
  // yang connect ke worker ini, lihat README "Admin: Usage Log"). Tanpa
  // ini, endpoint itu SELALU 403 (fitur nonaktif by default, aman).
  ADMIN_SECRET?: string;
  // OPSIONAL -- token bot Telegram (dari @BotFather) + chat_id tujuan, buat
  // entry alert (ENTRY_ALERT_CRON). Kalau salah satu belum diset, alert
  // di-skip + di-log (lihat src/telegram.ts), TIDAK menggagalkan cron.
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

const REQUEST_LOG_RETENTION_MS = 30 * 24 * 3600 * 1000; // 30 hari
const WALL_TRACKING_RETENTION_MS = 48 * 3600 * 1000; // 48 jam
const HYPERLIQUID_WHALE_RETENTION_MS = 14 * 24 * 3600 * 1000; // 14 hari
const WALL_SCAN_CRON = "*/1 * * * *";
const HYPERLIQUID_WHALE_CRON = "*/15 * * * *";
// Offset 7 menit dari grid `*/5`/`*/15` di atas -- entryAlertCron.ts jalanin
// pipeline penuh (bukan cuma basis snapshot) buat top-200 pair, numpuk di
// tick yang sama dengan snapshot cron bisa nabrak MAX_REQUESTS_PER_WINDOW
// proxy internal (rateLimiter.ts). Offset ini gak pernah bertepatan dengan
// kelipatan 5 menit manapun.
//
// SENGAJA range-step ("7-59/15"), BUKAN comma-list ("7,22,37,52") --
// comma-list KETERIMA saat registrasi (muncul benar di dashboard + wrangler
// deploy), tapi ANEHNYA gak pernah beneran fire (diverifikasi wrangler tail
// 3x berturut-turut, tick :07/:22/:37 semua kelewat, sementara */1, */5,
// */15 normal terus). Range-step hasilnya SAMA (fire di menit 7,22,37,52)
// tapi pakai operator step yang sama kayak */15 yang udah terbukti reliable.
const ENTRY_ALERT_CRON = "7-59/15 * * * *";
// 00.00/08.00/16.00 UTC = 07.00/15.00/23.00 WIB (UTC+7) -- heartbeat
// entry-alert (heartbeatCron.ts), user request 2026-08-25.
const HEARTBEAT_CRON = "0 0,8,16 * * *";
const ENTRY_ALERT_RUN_LOG_RETENTION_MS = 2 * 24 * 3600 * 1000; // 2 hari -- heartbeat lookback 8 jam tetap muat.
const MARKET_SIGNAL_RETENTION_MS = 90 * 24 * 3600 * 1000; // 90 hari -- market_snapshots + signal_history.
// entry_alert_skip_log: window audit MANUAL multi-hari ("apakah pair yang
// di-skip pre-filter pernah jadi setup bagus"), jadi retensi jauh lebih
// panjang dari run_log. 30 hari -- 7 hari terlalu pendek untuk uji F3.
const ENTRY_ALERT_SKIP_LOG_RETENTION_MS = 30 * 24 * 3600 * 1000;
// pipeline_decision_log: keputusan per-symbol Phase 2. 90 hari, sama
// dengan market_snapshots / signal_history -- cukup untuk uji maju skor 55
// lintas beberapa rezim, ~40 row/tick * 96 tick/hari * 90 ≈ 350k row.
const PIPELINE_DECISION_LOG_RETENTION_MS = 90 * 24 * 3600 * 1000;

// Server ini STATELESS (sessionIdGenerator: undefined): setiap request
// membuat instance server + transport baru. Ini pola resmi yang
// direkomendasikan SDK untuk Cloudflare Workers, karena Workers tidak
// menjaga state antar-invocation (tiap request bisa jatuh ke isolate
// berbeda). Cocok untuk MCP server berbasis API call read-only seperti ini.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

// DNS rebinding / cross-site request protection.
//
// @modelcontextprotocol/sdk's WebStandardStreamableHTTPServerTransport still
// ships `enableDnsRebindingProtection`/`allowedHosts`/`allowedOrigins`
// options, but they're marked @deprecated in the SDK's own type defs -- the
// SDK now expects this to be handled by external middleware, which is what
// this function is.
//
// We validate the `Origin` header ONLY (not `Host`). On Cloudflare Workers,
// which route is even reachable for a given request is decided by the
// platform (zone/custom-domain binding) before this code runs, so spoofing
// `Host` doesn't open a new route the way it would on a shared multi-tenant
// origin server -- Host validation would be redundant here. The real threat
// this guards against is a malicious web page using DNS rebinding to make a
// victim's browser call this public endpoint as if it were same-origin;
// browsers ALWAYS send `Origin` on cross-origin fetch/XHR. Non-browser MCP
// clients (server-to-server calls, which is how this worker is actually used
// as a Claude custom connector) typically send no `Origin` header at all, so
// those are allowed through unconditionally.
const DEFAULT_ALLOWED_ORIGINS = new Set(["https://claude.ai", "https://claude.com"]);

function isOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin) return true;
  if (DEFAULT_ALLOWED_ORIGINS.has(origin)) return true;
  const extra = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    binanceProxy.setProxyConfig(
      env.PROXY_URL,
      env.PROXY_SECRET,
      env.PROXY_URL_2,
      env.PROXY_SECRET_2,
      env.DISABLE_DIRECT_FALLBACK !== "true",
    );
    kvConfig.setKvNamespace(env.CONFIG_KV);
    d1Client.setD1Database(env.DB);
    streamGateway.setStreamGatewayConfig(env.PROXY_URL, env.PROXY_SECRET);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return withCors(
        new Response(
          JSON.stringify({
            name: "binance-future-hunter",
            status: "ok",
            endpoint: "/mcp",
            note: "Daftarkan URL <this-worker-url>/mcp sebagai custom MCP connector.",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // Owner-only, BUKAN MCP tool -- sengaja endpoint HTTP terpisah, gak
    // pernah nongol di tools/list, biar visitor lain (siapa aja yang bisa
    // connect ke /mcp) gak bisa liat log visitor lain. 403 generic kalau
    // gagal auth -- gak bocorin apakah ADMIN_SECRET ke-set atau kosong.
    if (url.pathname === "/admin/usage" && request.method === "GET") {
      if (!isAuthorized(url.searchParams.get("key"), env.ADMIN_SECRET)) {
        return withCors(new Response("Forbidden", { status: 403 }));
      }
      try {
        const hours = Number(url.searchParams.get("hours")) || 24;
        const summary = await d1Client.queryRequestLogSummary(hours);
        return withCors(
          new Response(JSON.stringify(summary, null, 2), { headers: { "Content-Type": "application/json" } }),
        );
      } catch (err) {
        return withCors(
          new Response(`Gagal query usage log: ${(err as Error)?.message ?? String(err)}`, { status: 500 }),
        );
      }
    }

    if (url.pathname !== "/mcp") {
      return withCors(
        new Response("Not found. Gunakan endpoint /mcp untuk koneksi MCP.", { status: 404 }),
      );
    }

    const origin = request.headers.get("Origin");
    if (!isOriginAllowed(origin, env)) {
      return withCors(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: `Origin '${origin}' tidak diizinkan (DNS rebinding protection). Set ALLOWED_ORIGINS di worker kalau ini legitimate.`,
            },
            id: null,
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // Fire-and-forget -- JANGAN nge-block/gagalin request MCP asli kalau
    // logging gagal (misal D1 belum ke-bind di deployment yang belum
    // migrasi). Cuma buat visibility "siapa yang connect", bukan bagian
    // kritikal dari fungsi server.
    ctx.waitUntil(
      d1Client
        .insertRequestLog({
          timestamp: Date.now(),
          ip: request.headers.get("cf-connecting-ip"),
          country: (request.cf as IncomingRequestCfProperties | undefined)?.country ?? null,
          colo: (request.cf as IncomingRequestCfProperties | undefined)?.colo ?? null,
          userAgent: request.headers.get("user-agent"),
        })
        .catch((err) => console.error("[request-log] gagal insert:", (err as Error)?.message ?? String(err))),
    );

    try {
      // Stateless: instance server & transport baru per-request.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createServer();
      await server.connect(transport);

      const response = await transport.handleRequest(request);
      return withCors(response);
    } catch (err) {
      return withCors(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: `Internal error: ${(err as Error)?.message ?? String(err)}`,
            },
            id: null,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
  },

  // Lima Cron Trigger (lihat [triggers] di wrangler.toml), dibedakan lewat
  // event.cron string:
  // - WALL_SCAN_CRON (*/1, tiap 1 menit): scan wall kandidat order book
  //   untuk WALL_SCAN_WATCHLIST (shared.ts -- subset 15 pair pertama dari
  //   SNAPSHOT_WATCHLIST by market cap, BUKAN full 50, cut manual buat
  //   nurunin overage Vercel Hobby -- WALL_SCAN adalah ~95% driver-nya
  //   karena getOrderBookDepth NO_CACHE by design) -> wall_tracking (dibaca
  //   binance_get_orderbook_wall_persistence).
  // - ENTRY_ALERT_CRON (7,22,37,52 -- tiap 15 menit, offset dari grid */5 &
  //   */15 lainnya): whalescope_full_pipeline penuh untuk top-200 pair
  //   USDT-M perpetual by 24h volume (entryWatchlist.ts, DINAMIS bukan
  //   hardcode) -> kirim alert Telegram (telegram.ts) pas symbol TRANSISI ke
  //   TRADE, atau masih TRADE tapi cooldown 4 jam sejak alert terakhir sudah
  //   lewat (entryAlertCron.ts, state di D1 entry_alert_state).
  // - HYPERLIQUID_WHALE_CRON (*/15, tiap 15 menit): snapshot posisi wallet
  //   whale HYPERLIQUID_WHALE_WATCHLIST -> hyperliquid_whale_snapshots
  //   (dibaca hyperliquid_get_whale_wallet_positions).
  // - HEARTBEAT_CRON (00.00/08.00/16.00 UTC = 07.00/15.00/23.00 WIB, 3x/hari):
  //   kalau gak ada alert TRADE/WATCH sama sekali dalam 8 jam terakhir,
  //   kirim 1 pesan Telegram yang bedain "market sepi" dari "backend
  //   bermasalah" (heartbeatCron.ts, tally dari entry_alert_run_log). JUGA
  //   checkD1Capacity() (infraHealthCron.ts) -- alert kalau market_snapshots
  //   + signal_history lewat ambang baris (backstop di atas prune 90 hari).
  // - selain itu (*/5, tiap 5 menit, DEFAULT/fallback): dua hal per symbol
  //   di SNAPSHOT_WATCHLIST -- (1) market snapshot (basis futures-vs-spot +
  //   funding + OI, dibaca binance_get_basis_history), (2) 6 skor sinyal MM
  //   lewat computeMmSignals() (dibaca binance_backtest_signal). Satu symbol
  //   gagal TIDAK menggagalkan symbol lain (try/catch per-symbol, dan
  //   basis-snapshot terpisah dari signal-snapshot supaya satu gagal gak
  //   gugurin yang lain). SETELAH watchlist selesai, juga snapshot basis
  //   (SAJA -- bukan computeMmSignals/signal_history) buat top-5 pair
  //   NON-watchlist paling sering di-query (snapshotNonWatchlistBasis, lihat
  //   src/queryFrequency.ts) -- TIDAK menyentuh wall tracking (cron 1-menit)
  //   sama sekali. Prune request_log & wall_tracking juga di sini. Plus 3
  //   cek gap/health yang KV-gated (maks 1 alert/jam): checkEntryAlertCronFreshness
  //   (heartbeatCron.ts) + checkStreamGatewayHealth + checkMarketSnapshotFreshness
  //   (infraHealthCron.ts) -- masing-masing nutup blind spot yang checkHeartbeat()
  //   sendiri gak lihat (VPS stream gateway mati, cron snapshot ini berhenti).
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    binanceProxy.setProxyConfig(
      env.PROXY_URL,
      env.PROXY_SECRET,
      env.PROXY_URL_2,
      env.PROXY_SECRET_2,
      env.DISABLE_DIRECT_FALLBACK !== "true",
    );
    kvConfig.setKvNamespace(env.CONFIG_KV);
    d1Client.setD1Database(env.DB);
    streamGateway.setStreamGatewayConfig(env.PROXY_URL, env.PROXY_SECRET);

    if (event.cron === WALL_SCAN_CRON) {
      ctx.waitUntil(
        Promise.all(
          WALL_SCAN_WATCHLIST.map(async (symbol) => {
            try {
              await scanWallCandidates(symbol);
            } catch (err) {
              console.error(`[cron] gagal wall scan ${symbol}:`, (err as Error)?.message ?? String(err));
            }
          }),
        ),
      );
      return;
    }

    if (event.cron === ENTRY_ALERT_CRON) {
      ctx.waitUntil(
        runEntryAlertCheck({ TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID }),
      );
      // Prune entry_alert_run_log di sini (bukan cron ke-6 sendiri) -- retensi
      // 2 hari gak butuh presisi tiap tick, sama alasan seperti prune lain.
      ctx.waitUntil(
        d1Client
          .pruneOldEntryAlertRunLog(Date.now() - ENTRY_ALERT_RUN_LOG_RETENTION_MS)
          .catch((err) => console.error("[cron] gagal prune entry_alert_run_log:", (err as Error)?.message ?? String(err))),
      );
      ctx.waitUntil(
        d1Client
          .pruneOldEntryAlertSkipLog(Date.now() - ENTRY_ALERT_SKIP_LOG_RETENTION_MS)
          .catch((err) => console.error("[cron] gagal prune entry_alert_skip_log:", (err as Error)?.message ?? String(err))),
      );
      ctx.waitUntil(
        d1Client
          .pruneOldPipelineDecisionLog(Date.now() - PIPELINE_DECISION_LOG_RETENTION_MS)
          .catch((err) => console.error("[cron] gagal prune pipeline_decision_log:", (err as Error)?.message ?? String(err))),
      );
      return;
    }

    if (event.cron === HEARTBEAT_CRON) {
      const telegramEnv = { TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID };
      ctx.waitUntil(checkHeartbeat(telegramEnv));
      // D1 capacity check di sini (3x/hari, bukan tiap */5) -- COUNT(*) di
      // tabel jutaan baris gak murah, dan runway dari alert ke "harus prune"
      // itu puluhan hari, jadi gak butuh presisi menit.
      ctx.waitUntil(
        checkD1Capacity(telegramEnv).catch((err) =>
          console.error("[cron] gagal checkD1Capacity:", (err as Error)?.message ?? String(err)),
        ),
      );
      // Snapshot CFTC COT ke D1 di sini (3x/hari) -- data sumbernya cuma
      // update mingguan (Jumat), jadi TIDAK butuh Cron Trigger sendiri;
      // INSERT OR IGNORE (unique index coin+report_date, lihat d1Client.ts)
      // bikin ngecek lebih sering dari update-rate asli aman/no-op.
      for (const coin of ["BTC", "ETH"] as const) {
        ctx.waitUntil(
          snapshotCftcPositioning(coin).catch((err) =>
            console.error(`[cron] gagal snapshot CFTC ${coin}:`, (err as Error)?.message ?? String(err)),
          ),
        );
      }
      return;
    }

    if (event.cron === HYPERLIQUID_WHALE_CRON) {
      ctx.waitUntil(
        Promise.all(
          HYPERLIQUID_WHALE_WATCHLIST.map(async (address) => {
            try {
              await snapshotWhaleWallet(address);
            } catch (err) {
              console.error(`[cron] gagal hyperliquid whale snapshot ${address}:`, (err as Error)?.message ?? String(err));
            }
          }),
        ),
      );
      // Prune di tick ini sendiri (bukan cron ke-4) -- retensi 14 hari gak
      // butuh presisi tiap tick, sama alasan seperti pruneOldWallTracking.
      ctx.waitUntil(
        d1Client
          .pruneOldHyperliquidWhaleSnapshots(Date.now() - HYPERLIQUID_WHALE_RETENTION_MS)
          .catch((err) =>
            console.error("[cron] gagal prune hyperliquid_whale_snapshots:", (err as Error)?.message ?? String(err)),
          ),
      );
      return;
    }

    // Gap-detection untuk entry-alert cron (2026-08-27) -- piggyback di sini
    // (*/5, paling sering setelah */1) karena ENTRY_ALERT_CRON sendiri bisa
    // di-Cancel platform SEBELUM sempat lapor apa pun soal dirinya sendiri.
    // Lihat checkEntryAlertCronFreshness() (heartbeatCron.ts) untuk detail.
    const defaultTickTelegramEnv = {
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID,
    };
    ctx.waitUntil(
      checkEntryAlertCronFreshness(defaultTickTelegramEnv).catch((err) =>
        console.error("[cron] gagal checkEntryAlertCronFreshness:", (err as Error)?.message ?? String(err)),
      ),
    );

    // Infra-health checks (src/cron/infraHealthCron.ts) -- juga piggyback di
    // tick */5 ini. Keduanya KV-gated (maks 1 alert/jam selagi kondisi
    // persist), jadi aman dijalanin tiap 5 menit. Nutup blind spot yang
    // checkHeartbeat() gak lihat: stream gateway VPS mati, dan cron snapshot
    // ini sendiri berhenti nulis baris.
    ctx.waitUntil(
      checkStreamGatewayHealth(defaultTickTelegramEnv).catch((err) =>
        console.error("[cron] gagal checkStreamGatewayHealth:", (err as Error)?.message ?? String(err)),
      ),
    );
    ctx.waitUntil(
      checkMarketSnapshotFreshness(defaultTickTelegramEnv).catch((err) =>
        console.error("[cron] gagal checkMarketSnapshotFreshness:", (err as Error)?.message ?? String(err)),
      ),
    );

    ctx.waitUntil(
      Promise.all(
        SNAPSHOT_WATCHLIST.map(async (symbol) => {
          const timestamp = Date.now();

          try {
            await snapshotBasisForSymbol(symbol, timestamp);
          } catch (err) {
            console.error(`[cron] gagal market snapshot ${symbol}:`, (err as Error)?.message ?? String(err));
          }

          try {
            const signals = await computeMmSignals(symbol);
            await d1Client.insertSignalSnapshots(
              Object.entries(signals).map(([signalType, s]) => ({
                symbol,
                timestamp,
                signalType,
                score: s.score,
                evidence: s.evidence,
              })),
            );
          } catch (err) {
            console.error(`[cron] gagal signal snapshot ${symbol}:`, (err as Error)?.message ?? String(err));
          }
        }),
      ),
    );

    // Basis snapshot (SAJA, bukan signal_history) buat pair NON-watchlist
    // yang sering di-query -- lihat komentar di atas scheduled().
    ctx.waitUntil(
      snapshotNonWatchlistBasis().catch((err) =>
        console.error("[cron] gagal snapshot non-watchlist:", (err as Error)?.message ?? String(err)),
      ),
    );

    // Backfill forward_return_1h/4h/24h + sl_touched_24h ke
    // pipeline_decision_log (migration 0013) -- max 30 row/tick, row yang
    // window 24h-nya sudah lewat. Lihat src/cron/pipelineDecisionOutcomeCron.ts.
    ctx.waitUntil(
      backfillPipelineDecisionOutcomes().catch((err) =>
        console.error("[cron] gagal backfill pipeline_decision_log outcomes:", (err as Error)?.message ?? String(err)),
      ),
    );

    // Prune request_log >30 hari -- tabel ini bisa growth gak terduga kalau
    // ada traffic asing, gak dibatasi watchlist tetap kayak 2 tabel time-series.
    ctx.waitUntil(
      d1Client
        .pruneOldRequestLogs(Date.now() - REQUEST_LOG_RETENTION_MS)
        .catch((err) => console.error("[cron] gagal prune request_log:", (err as Error)?.message ?? String(err))),
    );
    ctx.waitUntil(
      d1Client
        .pruneOldMarketSnapshots(Date.now() - MARKET_SIGNAL_RETENTION_MS)
        .catch((err) => console.error("[cron] gagal prune market_snapshots:", (err as Error)?.message ?? String(err))),
    );
    ctx.waitUntil(
      d1Client
        .pruneOldSignalHistory(Date.now() - MARKET_SIGNAL_RETENTION_MS)
        .catch((err) => console.error("[cron] gagal prune signal_history:", (err as Error)?.message ?? String(err))),
    );

    // Prune wall_tracking >48 jam -- dilakukan di tick 5-menit ini (bukan
    // Cron Trigger ke-3) karena retensi 48 jam gak butuh presisi prune tiap
    // menit, dan slot Cron Trigger Free plan terbatas 5.
    ctx.waitUntil(
      d1Client
        .pruneOldWallTracking(Date.now() - WALL_TRACKING_RETENTION_MS)
        .catch((err) => console.error("[cron] gagal prune wall_tracking:", (err as Error)?.message ?? String(err))),
    );
  },
};
