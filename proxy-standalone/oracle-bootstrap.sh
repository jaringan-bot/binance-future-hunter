#!/bin/bash
# =============================================================================
# whale-binance-proxy — Oracle Cloud (OCI) one-shot bootstrap
# =============================================================================
# Works two ways:
#   A) Paste into the OCI "Create instance" wizard:
#        Advanced options -> Management -> "Paste cloud-init script"
#   B) SSH into a fresh Ubuntu 22.04/24.04 instance and run:
#        curl -o boot.sh <this-file> && sudo bash boot.sh
#
# What it does, idempotently:
#   - installs Node 22 (NodeSource) + Caddy (official apt repo)
#   - writes the relay to /opt/whale-binance-proxy/
#   - GENERATES a random PROXY_SECRET on first boot -> /opt/whale-binance-proxy/.env
#     (never printed to any chat; retrieve it later with:
#        sudo cat /opt/whale-binance-proxy/.env )
#   - runs the relay on 127.0.0.1:8080 under systemd
#   - Caddy terminates TLS on :443 for  <PUBLIC_IP>.sslip.io  (auto Let's Encrypt)
#   - opens ports 80 + 443 in the instance's own iptables
#
# YOU STILL MUST, in the OCI Console (cannot be scripted from inside the VM):
#   Networking -> the instance's VCN -> Security Lists -> Default Security List
#   -> Add Ingress Rules:  Source 0.0.0.0/0  IP Protocol TCP  Dest port 80
#                          Source 0.0.0.0/0  IP Protocol TCP  Dest port 443
#
# Final relay URL (this is your PROXY_URL for the Cloudflare Worker):
#   https://<PUBLIC_IP>.sslip.io
# =============================================================================
set -euo pipefail

APP_DIR=/opt/whale-binance-proxy
APP_USER=whaleproxy
PORT=8080

echo "[bootstrap] apt update + base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https openssl

echo "[bootstrap] install Node 22 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "[bootstrap] install Caddy (official apt repo)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "[bootstrap] create service user + app dir"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"

echo "[bootstrap] write relay files"

cat > "$APP_DIR/package.json" <<'PKGEOF'
{
  "name": "whale-binance-proxy-standalone",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18.17" },
  "scripts": { "start": "node server.mjs" }
}
PKGEOF

cat > "$APP_DIR/handler.mjs" <<'HANDLEREOF'
// Standalone Binance Futures/Spot proxy relay — platform-agnostic.
//
// Port of ../proxy/api/binance.ts (Vercel serverless) to a single
// Web-standard request handler that runs unchanged on Node (node:http),
// Deno Deploy (Deno.serve), Bun, Fly.io, Render, Koyeb, or a plain VPS.
//
// WHY THIS EXISTS: the Cloudflare Worker (whalescope-mcp) is WAF-blocked by
// Binance (HTTP 403 on every fapi.binance.com endpoint, /fapi/v1/ping
// included). It must call Binance through a relay hosted on an IP pool that
// is NOT WAF-blocked AND NOT geo-restricted (i.e. non-US region — Singapore
// / Tokyo are known-good, that is what the retired Vercel sin1 deploy used).
//
// AUTH: the caller MUST send header `x-proxy-secret` matching env
// PROXY_SECRET. Without it anyone hitting the public URL could relay through
// you and burn your Binance rate limit.
//
// SIGNED ENDPOINTS: optional caller header `x-binance-api-key` is forwarded
// to Binance as `X-MBX-APIKEY` (needed by /fapi/v1/leverageBracket). HMAC
// signing (secret) stays entirely caller-side — this relay only passes
// `signature` / `timestamp` / `recvWindow` through as ordinary query params
// and never touches the Binance secret.

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

const BASE_BY_MARKET = {
  futures: "https://fapi.binance.com",
  spot: "https://api.binance.com",
};

/** Constant-time string compare (node:crypto works on Node, Deno, Bun). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(bb, bb); // burn comparable time, don't early-return on length
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Drop caller-signed params before a URL touches any log. */
function redactUrl(u) {
  try {
    const parsed = new URL(u);
    for (const k of ["signature", "timestamp", "recvWindow", "apiKey"]) parsed.searchParams.delete(k);
    return parsed.toString();
  } catch {
    return "(unparseable url)";
  }
}

// Kept byte-for-byte in sync with ../proxy/api/binance.ts. If you add a path
// to the Vercel relay's whitelist, add it here too (and vice versa).
const ALLOWED_PATHS_BY_MARKET = {
  futures: new Set([
    "/fapi/v1/ping",
    "/fapi/v1/depth",
    "/fapi/v1/aggTrades",
    "/fapi/v1/fundingRate",
    "/fapi/v1/premiumIndex",
    "/fapi/v1/klines",
    "/fapi/v1/ticker/24hr",
    "/fapi/v1/openInterest",
    "/futures/data/topLongShortAccountRatio",
    "/futures/data/topLongShortPositionRatio",
    "/futures/data/globalLongShortAccountRatio",
    "/futures/data/openInterestHist",
    "/futures/data/takerlongshortRatio",
    "/futures/data/basis",
    "/fapi/v1/symbolAdlRisk",
    "/fapi/v1/insuranceBalance",
    // expects a request that is ALREADY signed by the caller
    // (query carries signature/timestamp/recvWindow + header
    // x-binance-api-key)
    "/fapi/v1/leverageBracket",
    "/fapi/v1/markPriceKlines",
    "/fapi/v1/indexPriceKlines",
    "/fapi/v1/premiumIndexKlines",
    "/fapi/v1/indexInfo",
    "/fapi/v1/continuousKlines",
    "/futures/data/delivery-price",
    "/fapi/v1/constituents",
    "/fapi/v1/exchangeInfo",
    "/fapi/v1/trades",
    "/fapi/v1/ticker/bookTicker",
    "/fapi/v2/ticker/price",
    "/fapi/v1/fundingInfo",
    "/fapi/v1/rpiDepth",
    "/fapi/v1/tradingSchedule",
    "/fapi/v1/allForceOrders",
  ]),
  spot: new Set([
    "/api/v3/ticker/price",
    "/api/v3/ticker/24hr",
    "/api/v3/ticker/bookTicker",
    "/api/v3/depth",
    "/api/v3/klines",
    "/api/v3/aggTrades",
    "/api/v3/avgPrice",
    "/api/v3/exchangeInfo",
  ]),
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-proxy-secret, x-binance-api-key",
};

/** Read an env var across Node / Deno / Bun without assuming a global. */
export function getEnv(name) {
  if (typeof process !== "undefined" && process.env && process.env[name] != null) {
    return process.env[name];
  }
  if (typeof Deno !== "undefined" && Deno.env) {
    try {
      return Deno.env.get(name) ?? undefined;
    } catch {
      return undefined; // --allow-env not granted
    }
  }
  return undefined;
}

function json(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders },
  });
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleBinanceProxy(request) {
  const method = request.method;
  const url = new URL(request.url);

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Health probe — no secret required (Render / Fly / Koyeb hit this).
  if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/healthz") {
    return json(200, { ok: true, service: "whale-binance-proxy-standalone" });
  }

  if (url.pathname !== "/api/binance") {
    return json(404, { error: "Not found. Endpoint is GET /api/binance?path=<binance-path>." });
  }

  if (method !== "GET") {
    return json(405, { error: "Method not allowed, gunakan GET." });
  }

  const expectedSecret = getEnv("PROXY_SECRET");
  if (!expectedSecret) {
    return json(500, { error: "PROXY_SECRET belum diset di environment variable host." });
  }
  const providedSecret = request.headers.get("x-proxy-secret");
  if (!safeEqual(providedSecret, expectedSecret)) {
    return json(401, { error: "Unauthorized: header x-proxy-secret tidak cocok atau tidak ada." });
  }

  const marketParam = url.searchParams.get("market");
  const market = marketParam || "futures";
  const binanceBase = BASE_BY_MARKET[market];
  const allowedPaths = ALLOWED_PATHS_BY_MARKET[market];
  if (!binanceBase || !allowedPaths) {
    return json(400, { error: "Parameter 'market' tidak dikenali, harus salah satu dari: futures, spot." });
  }

  const path = url.searchParams.get("path");
  if (typeof path !== "string" || !allowedPaths.has(path)) {
    return json(400, {
      error: "Parameter 'path' wajib diisi dan harus salah satu dari whitelist market ini.",
      market,
      allowedPaths: Array.from(allowedPaths),
    });
  }

  // Forward every query param except our own routing keys, preserving order
  // (matters for caller-signed endpoints).
  const forwardParams = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key === "path" || key === "market") continue;
    forwardParams.append(key, value);
  }
  const apiKeyHeader = request.headers.get("x-binance-api-key");

  const qs = forwardParams.toString();
  const targetUrl = `${binanceBase}${path}${qs ? `?${qs}` : ""}`;

  try {
    const outboundHeaders = { Accept: "application/json" };
    if (apiKeyHeader) outboundHeaders["X-MBX-APIKEY"] = apiKeyHeader;

    const binanceRes = await fetch(targetUrl, { headers: outboundHeaders });
    const contentType = binanceRes.headers.get("content-type") ?? "";
    const body = await binanceRes.text();

    return new Response(body, {
      status: binanceRes.status,
      headers: {
        "Content-Type": contentType.includes("application/json") ? "application/json" : "text/plain",
        ...CORS,
      },
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // Server-side only, signed params stripped. Never returned to the caller.
    console.error(`[relay] upstream fetch failed: ${msg} — ${redactUrl(targetUrl)}`);
    return json(502, { error: "upstream fetch failed", market, path });
  }
}
HANDLEREOF

cat > "$APP_DIR/server.mjs" <<'SERVEREOF'
// Node entrypoint — wraps handler.mjs in a node:http server.
import { createServer } from "node:http";
import { handleBinanceProxy, getEnv } from "./handler.mjs";

const PORT = Number(getEnv("PORT")) || 8080;

const server = createServer(async (req, res) => {
  try {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers.host || `localhost:${PORT}`;
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`whale-binance-proxy-standalone listening on 127.0.0.1:${PORT}`);
});
SERVEREOF

echo "[bootstrap] generate PROXY_SECRET (first boot only)"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "PROXY_SECRET=$(openssl rand -hex 32)" > "$APP_DIR/.env"
fi
chmod 600 "$APP_DIR/.env"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "[bootstrap] systemd unit for the relay"
cat > /etc/systemd/system/whale-binance-proxy.service <<UNITEOF
[Unit]
Description=whale-binance-proxy standalone relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PORT=$PORT
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now whale-binance-proxy

echo "[bootstrap] resolve public IP + write Caddyfile (auto-TLS via sslip.io)"
PUBIP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me)"
if [ -z "${PUBIP:-}" ]; then
  echo "[bootstrap] FATAL: could not determine public IP" >&2
  exit 1
fi
HOSTNAME_TLS="${PUBIP}.sslip.io"
echo "[bootstrap] public IP = $PUBIP  ->  https://$HOSTNAME_TLS"

cat > /etc/caddy/Caddyfile <<CADDYEOF
{
	email admin@${HOSTNAME_TLS}
}

${HOSTNAME_TLS} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:${PORT}
}
CADDYEOF

systemctl restart caddy
systemctl enable caddy

echo "[bootstrap] open ports 80 + 443 in the instance iptables"
# OCI Ubuntu images ship a restrictive INPUT chain with a REJECT catch-all.
# Insert ACCEPT rules for HTTP/HTTPS just before that REJECT.
for p in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 6 -p tcp --dport "$p" -j ACCEPT || iptables -I INPUT -p tcp --dport "$p" -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save
else
  apt-get install -y iptables-persistent
  netfilter-persistent save || true
fi

echo
echo "============================================================"
echo " DONE."
echo
echo " Relay URL (PROXY_URL for the Cloudflare Worker):"
echo "     https://${HOSTNAME_TLS}"
echo
echo " Get the generated secret (run after SSH):"
echo "     sudo cat ${APP_DIR}/.env"
echo
echo " Still TODO in the OCI Console:"
echo "   VCN -> Security Lists -> Default -> Add Ingress:"
echo "     0.0.0.0/0  TCP  port 80"
echo "     0.0.0.0/0  TCP  port 443"
echo
echo " Verify (wait ~30s for the TLS cert first):"
echo "     curl -s https://${HOSTNAME_TLS}/health"
echo "     curl -s 'https://${HOSTNAME_TLS}/api/binance?path=/fapi/v1/ping' -H \"x-proxy-secret: \$(sudo cat ${APP_DIR}/.env | cut -d= -f2)\""
echo "============================================================"
