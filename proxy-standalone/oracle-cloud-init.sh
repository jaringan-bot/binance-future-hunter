#!/bin/bash
# whale-binance-proxy - Oracle Cloud one-shot bootstrap (ASCII only, for the
# OCI "cloud-init script" field or "Choose cloud-init script file").
set -euo pipefail
APP_DIR=/opt/whale-binance-proxy
APP_USER=whaleproxy
PORT=8080

for i in $(seq 1 60); do
  if ! fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then break; fi
  sleep 5
done

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https openssl

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"

cat > "$APP_DIR/package.json" <<'PKGEOF'
{ "name": "whale-binance-proxy", "private": true, "type": "module" }
PKGEOF

cat > "$APP_DIR/handler.mjs" <<'HANDLEREOF'
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

const BASE_BY_MARKET = { futures: "https://fapi.binance.com", spot: "https://api.binance.com" };

function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length) { timingSafeEqual(bb, bb); return false; }
  return timingSafeEqual(ab, bb);
}

function redactUrl(u) {
  try {
    const p = new URL(u);
    for (const k of ["signature", "timestamp", "recvWindow", "apiKey"]) p.searchParams.delete(k);
    return p.toString();
  } catch { return "(unparseable)"; }
}

const ALLOWED = {
  futures: new Set(["/fapi/v1/ping","/fapi/v1/depth","/fapi/v1/aggTrades","/fapi/v1/fundingRate","/fapi/v1/premiumIndex","/fapi/v1/klines","/fapi/v1/ticker/24hr","/fapi/v1/openInterest","/futures/data/topLongShortAccountRatio","/futures/data/topLongShortPositionRatio","/futures/data/globalLongShortAccountRatio","/futures/data/openInterestHist","/futures/data/takerlongshortRatio","/futures/data/basis","/fapi/v1/symbolAdlRisk","/fapi/v1/insuranceBalance","/fapi/v1/leverageBracket","/fapi/v1/markPriceKlines","/fapi/v1/indexPriceKlines","/fapi/v1/premiumIndexKlines","/fapi/v1/indexInfo","/fapi/v1/continuousKlines","/futures/data/delivery-price","/fapi/v1/constituents","/fapi/v1/exchangeInfo","/fapi/v1/trades","/fapi/v1/ticker/bookTicker","/fapi/v2/ticker/price","/fapi/v1/fundingInfo","/fapi/v1/rpiDepth","/fapi/v1/tradingSchedule","/fapi/v1/allForceOrders"]),
  spot: new Set(["/api/v3/ticker/price","/api/v3/ticker/24hr","/api/v3/ticker/bookTicker","/api/v3/depth","/api/v3/klines","/api/v3/aggTrades","/api/v3/avgPrice","/api/v3/exchangeInfo"]),
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-proxy-secret, x-binance-api-key",
};

export function getEnv(name) {
  if (typeof process !== "undefined" && process.env && process.env[name] != null) return process.env[name];
  return undefined;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

export async function handleBinanceProxy(request) {
  const method = request.method;
  const url = new URL(request.url);
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname !== "/api/binance") return json(404, { error: "not found" });
  if (method !== "GET") return json(405, { error: "GET only" });
  const expected = getEnv("PROXY_SECRET");
  if (!expected) return json(500, { error: "PROXY_SECRET unset" });
  if (!safeEqual(request.headers.get("x-proxy-secret"), expected)) return json(401, { error: "unauthorized" });
  const market = url.searchParams.get("market") || "futures";
  const base = BASE_BY_MARKET[market];
  const allowed = ALLOWED[market];
  if (!base || !allowed) return json(400, { error: "bad market" });
  const path = url.searchParams.get("path");
  if (typeof path !== "string" || !allowed.has(path)) return json(400, { error: "bad path", market });
  const fp = new URLSearchParams();
  for (const [k, v] of url.searchParams) { if (k === "path" || k === "market") continue; fp.append(k, v); }
  const apiKey = request.headers.get("x-binance-api-key");
  const qs = fp.toString();
  const target = base + path + (qs ? "?" + qs : "");
  try {
    const h = { Accept: "application/json" };
    if (apiKey) h["X-MBX-APIKEY"] = apiKey;
    const r = await fetch(target, { headers: h });
    const ct = r.headers.get("content-type") ?? "";
    const body = await r.text();
    return new Response(body, { status: r.status, headers: { "Content-Type": ct.includes("application/json") ? "application/json" : "text/plain", ...CORS } });
  } catch (err) {
    console.error("[relay] upstream fail: " + (err && err.message ? err.message : err) + " " + redactUrl(target));
    return json(502, { error: "upstream fetch failed", market, path });
  }
}
HANDLEREOF

cat > "$APP_DIR/server.mjs" <<'SERVEREOF'
import { createServer } from "node:http";
import { handleBinanceProxy, getEnv } from "./handler.mjs";
const PORT = Number(getEnv("PORT")) || 8080;
createServer(async (req, res) => {
  try {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers.host || ("localhost:" + PORT);
    const request = new Request(proto + "://" + host + req.url, { method: req.method, headers: req.headers });
    const response = await handleBinanceProxy(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(await response.text());
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "relay crash" }));
  }
}).listen(PORT, "127.0.0.1", () => console.log("relay on 127.0.0.1:" + PORT));
SERVEREOF

if [ ! -f "$APP_DIR/.env" ]; then
  echo "PROXY_SECRET=$(openssl rand -hex 32)" > "$APP_DIR/.env"
fi
chmod 600 "$APP_DIR/.env"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

cat > /etc/systemd/system/whale-binance-proxy.service <<UNITEOF
[Unit]
Description=whale-binance-proxy relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PORT=$PORT
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env node server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now whale-binance-proxy

PUBIP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me)"
HOST="${PUBIP}.sslip.io"

cat > /etc/caddy/Caddyfile <<CADDYEOF
{
	email admin@${HOST}
}
${HOST} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:${PORT}
}
CADDYEOF

systemctl restart caddy
systemctl enable caddy

# OCI Ubuntu ships an INPUT chain ending in a REJECT catch-all. Insert the
# HTTP/HTTPS ACCEPT rules just BEFORE that REJECT (its 1-indexed position),
# not with a hardcoded index that can land after it.
reject_pos="$(iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null && continue
  if [ -n "${reject_pos:-}" ]; then
    iptables -I INPUT "$reject_pos" -p tcp --dport "$p" -j ACCEPT
  else
    iptables -I INPUT -p tcp --dport "$p" -j ACCEPT
  fi
done
netfilter-persistent save || { apt-get install -y iptables-persistent && netfilter-persistent save; } || true

echo "DONE https://${HOST}"
