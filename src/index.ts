import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import * as coinalyze from "./coinalyzeClient.js";
import * as binanceProxy from "./binanceProxyClient.js";
import * as kvConfig from "./kvConfig.js";
import * as d1Client from "./d1Client.js";
import { SNAPSHOT_WATCHLIST } from "./shared.js";
import { computeMmSignals } from "./tools/detectMmActivity.js";
import { isAuthorized } from "./adminUsage.js";

interface Env {
  COINALYZE_API_KEY?: string;
  PROXY_URL?: string;
  PROXY_SECRET?: string;
  // Proxy sekunder OPSIONAL -- kalau diset, binanceProxyClient otomatis
  // failover ke sini pas primary kena WAF block/rate-limit/5xx. Deploy ke
  // instance Vercel region lain, lihat proxy/README.md.
  PROXY_URL_2?: string;
  PROXY_SECRET_2?: string;
  CONFIG_KV?: KVNamespace;
  DB?: D1Database;
  // OPSIONAL -- kalau di-set, aktifin GET /admin/usage (ringkasan siapa
  // yang connect ke worker ini, lihat README "Admin: Usage Log"). Tanpa
  // ini, endpoint itu SELALU 403 (fitur nonaktif by default, aman).
  ADMIN_SECRET?: string;
}

const REQUEST_LOG_RETENTION_MS = 30 * 24 * 3600 * 1000; // 30 hari

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    coinalyze.setApiKey(env.COINALYZE_API_KEY);
    binanceProxy.setProxyConfig(env.PROXY_URL, env.PROXY_SECRET, env.PROXY_URL_2, env.PROXY_SECRET_2);
    kvConfig.setKvNamespace(env.CONFIG_KV);
    d1Client.setD1Database(env.DB);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return withCors(
        new Response(
          JSON.stringify({
            name: "whalescope-mcp",
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

  // Cron Trigger (lihat [triggers] di wrangler.toml, jalan tiap 5 menit) --
  // dua hal per symbol di SNAPSHOT_WATCHLIST (shared.ts, 10 pair), disimpan
  // ke D1: (1) market snapshot (basis futures-vs-spot + funding + OI, dibaca
  // binance_get_basis_history), (2) 6 skor sinyal MM lewat computeMmSignals()
  // (dibaca binance_backtest_signal). Satu symbol gagal TIDAK menggagalkan
  // symbol lain (try/catch per-symbol, dan basis-snapshot terpisah dari
  // signal-snapshot supaya satu gagal gak gugurin yang lain).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    coinalyze.setApiKey(env.COINALYZE_API_KEY);
    binanceProxy.setProxyConfig(env.PROXY_URL, env.PROXY_SECRET, env.PROXY_URL_2, env.PROXY_SECRET_2);
    kvConfig.setKvNamespace(env.CONFIG_KV);
    d1Client.setD1Database(env.DB);

    ctx.waitUntil(
      Promise.all(
        SNAPSHOT_WATCHLIST.map(async (symbol) => {
          const timestamp = Date.now();

          try {
            const [spot, futures, oi] = await Promise.all([
              binanceProxy.getSpotPrice(symbol),
              binanceProxy.getCurrentFundingRateNative(symbol),
              binanceProxy.getOpenInterestNative(symbol),
            ]);
            const spotPrice = parseFloat(spot.price);
            const markPrice = parseFloat(futures.markPrice);
            const basis = (markPrice - spotPrice) / spotPrice;
            await d1Client.insertMarketSnapshot({
              symbol,
              timestamp,
              spotPrice,
              markPrice,
              basis,
              fundingRate: parseFloat(futures.lastFundingRate),
              openInterest: parseFloat(oi.openInterest),
            });
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

    // Prune request_log >30 hari -- tabel ini (beda dari market_snapshots/
    // signal_history) bisa growth gak terduga kalau ada traffic asing,
    // gak dibatasi watchlist tetap kayak 2 tabel lain.
    ctx.waitUntil(
      d1Client
        .pruneOldRequestLogs(Date.now() - REQUEST_LOG_RETENTION_MS)
        .catch((err) => console.error("[cron] gagal prune request_log:", (err as Error)?.message ?? String(err))),
    );
  },
};
