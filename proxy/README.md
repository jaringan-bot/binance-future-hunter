# whale-binance-proxy

Proxy relay kecil di Vercel untuk fetch data Binance Futures API secara
langsung, dipakai sebagai jalur alternatif karena worker Cloudflare
(`whale.jaringan.dev` di root repo ini) diblokir total oleh WAF Binance
(HTTP 403 di semua endpoint termasuk `/fapi/v1/ping`).

Awalnya cuma dipakai untuk beberapa endpoint (depth, aggTrades, top-trader
ratio). Sejak dipindahnya funding rate & klines dari Coinalyze ke Binance
native (fix bug presisi harga & skala funding untuk pair kecil), proxy ini
jadi jalur utama untuk sebagian besar tool di worker — lihat README root
repo untuk daftar lengkap tool per sumber data.

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
GET /api/binance?path=<binance-path>&market=<futures|spot>&<param-lain>
Header: x-proxy-secret: <PROXY_SECRET>
```

`market` opsional, default `futures`. Isi `spot` untuk relay ke Binance Spot
API (`api.binance.com`) alih-alih Futures (`fapi.binance.com`) — dipakai
untuk basis futures-vs-spot riil (lihat `binance_get_spot_price` di worker).

Contoh:
```bash
curl -s "https://whale-binance-proxy.vercel.app/api/binance?path=/fapi/v1/ping" \
  -H "x-proxy-secret: <secret-kamu>"

curl -s "https://whale-binance-proxy.vercel.app/api/binance?path=/api/v3/ticker/price&market=spot&symbol=BTCUSDT" \
  -H "x-proxy-secret: <secret-kamu>"
```

## Path yang diizinkan (whitelist)

Whitelist di-split per market (lihat `ALLOWED_PATHS_BY_MARKET` di
`api/binance.ts`), supaya path futures dan spot gak ketuker.

**`market=futures`** (default):
- `/fapi/v1/ping` — baseline konektivitas
- `/fapi/v1/depth` — order book depth
- `/fapi/v1/aggTrades` — aggregate trades (untuk CVD granular)
- `/fapi/v1/fundingRate` — histori funding rate (settled)
- `/fapi/v1/premiumIndex` — funding rate terkini + mark/index price (basis)
- `/fapi/v1/klines` — candlestick OHLCV (dipakai juga oleh multi-timeframe
  bias & realized volatility)
- `/fapi/v1/ticker/24hr` — statistik 24 jam resmi
- `/fapi/v1/openInterest` — open interest snapshot
- `/futures/data/topLongShortAccountRatio` — top-trader ratio (akun)
- `/futures/data/topLongShortPositionRatio` — top-trader ratio (posisi)
- `/futures/data/globalLongShortAccountRatio` — ratio global (semua akun)
- `/futures/data/openInterestHist` — tren open interest
- `/futures/data/takerlongshortRatio` — taker buy/sell volume ratio

**`market=spot`**:
- `/api/v3/ticker/price` — harga spot terkini (dipakai `binance_get_spot_price`)
- `/api/v3/ticker/24hr` — statistik 24 jam spot (dipakai `binance_get_spot_ticker_24hr`)
- `/api/v3/ticker/bookTicker` — best bid/ask real-time (dipakai `binance_get_spot_book_ticker`)
- `/api/v3/depth` — order book spot (dipakai `binance_get_spot_order_book`)
- `/api/v3/klines` — candlestick spot (dipakai `binance_get_spot_klines`)
- `/api/v3/aggTrades` — aggregate trades spot / CVD riil (dipakai `binance_get_spot_agg_trades`)
- `/api/v3/avgPrice` — harga rata-rata bergerak spot (dipakai `binance_get_spot_avg_price`)
- `/api/v3/exchangeInfo` — metadata & status listing pair (dipakai `binance_check_spot_listing`)

Untuk menambah path baru, edit whitelist market yang relevan di
`ALLOWED_PATHS_BY_MARKET` (`api/binance.ts`) — JANGAN buka proxy generic
tanpa whitelist, supaya proxy ini tidak jadi pintu belakang buat fetch
endpoint Binance apapun (termasuk endpoint trading/private yang butuh API
key, yang TIDAK boleh lewat proxy publik seperti ini).
