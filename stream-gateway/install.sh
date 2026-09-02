#!/usr/bin/env bash
# Idempotent install / update for whale-stream-gateway on the production AWS VPS.
# SSH: Host svm-vps (13.212.7.132, ap-southeast-1) — see ~/.ssh/config.
# ASCII-only on purpose (the OCI console cloud-init textarea runs btoa()).
#
# Usage, from the repo's stream-gateway/ dir:
#   scp -i <key> *.mjs package.json whale-stream-gateway.service install.sh ubuntu@<vps>:/tmp/gw/
#   ssh -i <key> ubuntu@<vps> 'sudo bash /tmp/gw/install.sh'
set -euo pipefail

APP_DIR=/opt/whale-stream-gateway
APP_USER=whaleproxy
RELAY_ENV=/opt/whale-binance-proxy/.env
PORT=8081
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
CADDYFILE=/etc/caddy/Caddyfile

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found in PATH (need Node 22+ with node:sqlite)" >&2
  exit 1
fi

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"

mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"
chmod 750 "$APP_DIR"
install -m 644 -o "$APP_USER" -g "$APP_USER" \
  "$SRC_DIR/index.mjs" "$SRC_DIR/ws-client.mjs" "$SRC_DIR/store.mjs" \
  "$SRC_DIR/server.mjs" "$SRC_DIR/parse.mjs" "$SRC_DIR/depthWatch.mjs" \
  "$SRC_DIR/package.json" "$APP_DIR/"

# Reuse the relay's PROXY_SECRET so the Worker needs no new credential.
if [ ! -f "$APP_DIR/.env" ]; then
  if [ -f "$RELAY_ENV" ]; then
    SECRET="$(grep -oP '(?<=PROXY_SECRET=).*' "$RELAY_ENV" || true)"
  fi
  if [ -z "${SECRET:-}" ]; then
    echo "ERROR: cannot find PROXY_SECRET in $RELAY_ENV and $APP_DIR/.env does not exist" >&2
    exit 1
  fi
  printf 'PROXY_SECRET=%s\n' "$SECRET" > "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

install -m 644 "$SRC_DIR/whale-stream-gateway.service" /etc/systemd/system/whale-stream-gateway.service
systemctl daemon-reload
systemctl enable --now whale-stream-gateway
systemctl restart whale-stream-gateway

# --- Caddy: route /stream/* to :8081, everything else stays on :8080 --------
HOST="$(awk '/\.sslip\.io \{/ {print $1; exit}' "$CADDYFILE")"
if [ -z "$HOST" ]; then
  echo "ERROR: could not find the sslip.io site block in $CADDYFILE" >&2
  exit 1
fi
if ! grep -q "127.0.0.1:${PORT}" "$CADDYFILE"; then
  cat > "$CADDYFILE" <<CADDYEOF
{
	email admin@${HOST}
}
${HOST} {
	encode zstd gzip
	handle /stream/* {
		reverse_proxy 127.0.0.1:${PORT}
	}
	handle {
		reverse_proxy 127.0.0.1:8080
	}
}
CADDYEOF
  caddy validate --config "$CADDYFILE" --adapter caddyfile
  systemctl reload caddy
fi

sleep 2
systemctl is-active whale-stream-gateway
curl -fsS "http://127.0.0.1:${PORT}/stream/health" && echo
echo "DONE. Public: https://${HOST}/stream/health"
