// Node entrypoint — wraps handler.mjs in a node:http server.
// Used for: plain VPS (systemd), Docker, Fly.io, Render, Koyeb.
// Deno Deploy uses deno.mjs instead.

import { createServer } from "node:http";
import { handleBinanceProxy, getEnv } from "./handler.mjs";

const PORT = Number(getEnv("PORT")) || 8080;

const server = createServer(async (req, res) => {
  try {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers.host || `localhost:${PORT}`;
    // GET only — no body forwarded.
    const request = new Request(`${proto}://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
    });

    const response = await handleBinanceProxy(request);

    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(await response.text());
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: `relay crash: ${err && err.message ? err.message : String(err)}` }));
  }
});

server.listen(PORT, () => {
  console.log(`whale-binance-proxy-standalone listening on :${PORT}`);
});
