import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import * as coinalyze from "./coinalyzeClient.js";
import * as binanceProxy from "./binanceProxyClient.js";
import * as kvConfig from "./kvConfig.js";
import { appendBasisSnapshot, BASIS_HISTORY_WATCHLIST } from "./tools/basisHistory.js";

interface Env {
  COINALYZE_API_KEY?: string;
  PROXY_URL?: string;
  PROXY_SECRET?: string;
  CONFIG_KV?: KVNamespace;
}

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
  async fetch(request: Request, env: Env): Promise<Response> {
    coinalyze.setApiKey(env.COINALYZE_API_KEY);
    binanceProxy.setProxyConfig(env.PROXY_URL, env.PROXY_SECRET);
    kvConfig.setKvNamespace(env.CONFIG_KV);
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

    if (url.pathname !== "/mcp") {
      return withCors(
        new Response("Not found. Gunakan endpoint /mcp untuk koneksi MCP.", { status: 404 }),
      );
    }

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
  // snapshot basis futures-vs-spot buat watchlist tetap (BASIS_HISTORY_WATCHLIST),
  // disimpan ke Workers KV lewat appendBasisSnapshot(). Dibaca kembali oleh
  // tool binance_get_basis_history. Satu symbol gagal snapshot TIDAK
  // menggagalkan symbol lain (try/catch per-symbol).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    coinalyze.setApiKey(env.COINALYZE_API_KEY);
    binanceProxy.setProxyConfig(env.PROXY_URL, env.PROXY_SECRET);
    kvConfig.setKvNamespace(env.CONFIG_KV);

    ctx.waitUntil(
      Promise.all(
        BASIS_HISTORY_WATCHLIST.map(async (symbol) => {
          try {
            const [spot, futures] = await Promise.all([
              binanceProxy.getSpotPrice(symbol),
              binanceProxy.getCurrentFundingRateNative(symbol),
            ]);
            const spotPrice = parseFloat(spot.price);
            const markPrice = parseFloat(futures.markPrice);
            const basis = (markPrice - spotPrice) / spotPrice;
            await appendBasisSnapshot(symbol, { timestamp: Date.now(), spotPrice, markPrice, basis });
          } catch (err) {
            console.error(`[cron] gagal snapshot basis ${symbol}:`, (err as Error)?.message ?? String(err));
          }
        }),
      ),
    );
  },
};
