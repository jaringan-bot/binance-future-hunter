#!/usr/bin/env bash
# Bangkitkan .dev.vars (dibaca otomatis oleh `wrangler dev`) dari environment
# variable yang tersedia di VM -- dipakai supaya secret Cloud Agent (PROXY_URL,
# PROXY_SECRET, dst) sampai ke worker lokal tanpa pernah di-commit (.dev.vars
# ada di .gitignore). Skrip ini AMAN di-commit: hanya membaca env, tidak
# menyimpan nilai apa pun.
#
# Idempoten: menulis ulang .dev.vars dari nol tiap dijalankan. Key yang env-nya
# kosong/tak diset di-skip, jadi kalau tidak ada secret sama sekali file jadi
# kosong dan worker tetap jalan (tool Binance-native degrade rapi dengan pesan
# "PROXY_URL belum diset", perilaku default).
set -euo pipefail

cd "$(dirname "$0")/.."

OUT=".dev.vars"

# Semua secret/var yang dibaca src/index.ts (interface Env). CONFIG_KV & DB
# adalah binding (dari wrangler.toml), bukan secret, jadi tidak di sini.
KEYS=(
  PROXY_URL
  PROXY_SECRET
  PROXY_URL_2
  PROXY_SECRET_2
  DISABLE_DIRECT_FALLBACK
  ALLOWED_ORIGINS
  ADMIN_SECRET
  TELEGRAM_BOT_TOKEN
  TELEGRAM_CHAT_ID
)

TMP="$(mktemp)"
written=0
for key in "${KEYS[@]}"; do
  value="${!key:-}"
  if [ -n "$value" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$TMP"
    written=$((written + 1))
  fi
done

mv "$TMP" "$OUT"
chmod 600 "$OUT"

if [ "$written" -eq 0 ]; then
  echo "[gen-dev-vars] tidak ada env var secret yang diset; $OUT dibuat kosong (tool Binance-native akan degrade rapi)."
else
  # Cetak nama key saja, JANGAN nilainya.
  echo "[gen-dev-vars] menulis $written entri ke $OUT: $(cut -d= -f1 "$OUT" | paste -sd' ' -)"
fi
