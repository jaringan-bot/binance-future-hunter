import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";

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
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return withCors(
        new Response(
          JSON.stringify({
            name: "binance-futures-mcp",
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
};
