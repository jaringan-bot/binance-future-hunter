# whale-binance-proxy

Proxy relay kecil di Vercel untuk fetch data Binance Futures API secara
langsung, dipakai sebagai jalur alternatif karena worker Cloudflare
(`whale.jaringan.dev` di root repo ini) diblokir total oleh WAF Binance
(HTTP 403 di semua endpoint termasuk `/fapi/v1/ping`).

## Kenapa terpisah dari worker utama

Ini FOLDER TERPISAH (`proxy/`) di dalam repo yang sama, tapi di-deploy sebagai
project Vercel sendiri — bukan bagian dari worker Cloudflare. Cloudflare
Workers dan Vercel adalah dua platform hosting berbeda dengan IP pool
berbeda; endpoint yang diblokir di satu platform kadang tidak diblokir di
platform lain.

## Setup deploy

1. Di dashboard Vercel, buat project baru dari repo `osindo-dev/whale`,
   set **Root Directory** ke `proxy` (bukan root repo).
2. Set environment variable `PROXY_SECRET` ke string acak yang kamu buat
   sendiri (misal `openssl rand -hex 32`). JANGAN commit nilai ini ke git.
3. Deploy. Vercel akan kasih URL seperti `https://whale-binance-proxy.vercel.app`.
4. Simpan URL ini + `PROXY_SECRET` untuk dipakai di worker Cloudflare
   (lewat `wrangler secret put`), supaya worker bisa panggil proxy ini.

## Endpoint

```
GET /api/binance?path=<binance-path>&<param-lain>
Header: x-proxy-secret: <PROXY_SECRET>
```

Contoh:
```bash
curl -s "https://whale-binance-proxy.vercel.app/api/binance?path=/fapi/v1/ping" \
  -H "x-proxy-secret: <secret-kamu>"
```

## Path yang diizinkan (whitelist)

Hanya path read-only berikut yang bisa diteruskan (lihat `ALLOWED_PATHS`
di `api/binance.ts`):

- `/fapi/v1/ping` — baseline konektivitas
- `/fapi/v1/depth` — order book depth
- `/fapi/v1/aggTrades` — aggregate trades (untuk CVD granular)
- `/futures/data/topLongShortAccountRatio` — top-trader ratio (akun)
- `/futures/data/topLongShortPositionRatio` — top-trader ratio (posisi)
- `/futures/data/globalLongShortAccountRatio` — ratio global (semua akun)

Untuk menambah path baru, edit whitelist `ALLOWED_PATHS` di `api/binance.ts`
— JANGAN buka proxy generic tanpa whitelist, supaya proxy ini tidak jadi
pintu belakang buat fetch endpoint Binance apapun (termasuk endpoint
trading/private yang butuh API key, yang TIDAK boleh lewat proxy publik
seperti ini).
