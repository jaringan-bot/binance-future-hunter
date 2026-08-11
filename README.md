# Binance Futures MCP Server (whale)

MCP server yang menyediakan data publik Binance USDS-M Futures (funding rate,
open interest, long/short ratio, taker volume, candlestick) sebagai tools
yang bisa dipanggil Claude. Semua data yang disajikan bersifat **publik
read-only** — tidak ada order/trading, tidak ada akses ke data akun pribadi.

**Sumber data: Coinalyze, bukan Binance API langsung.** Semua domain Binance
(`fapi.binance.com`, `www.binance.com`) memblokir traffic dari Cloudflare
Workers di level WAF (403, company-wide — sudah dites langsung dari worker
ini, bukan asumsi). [Coinalyze](https://coinalyze.net) meng-agregasi ulang
data yang sama (sumber asli tetap Binance) dan API-nya sendiri di-hosting di
Cloudflare, jadi tidak kena block yang sama. Konsekuensinya: worker ini
**butuh `COINALYZE_API_KEY`** (gratis, signup di coinalyze.net) — lihat
bagian Setup di bawah.

## Yang disediakan

| Tool | Fungsi |
|---|---|
| `binance_get_funding_rate` | Funding rate terkini |
| `binance_get_funding_rate_history` | Tren funding rate dari waktu ke waktu |
| `binance_get_open_interest` | OI snapshot terkini |
| `binance_get_open_interest_history` | Tren OI naik/turun |
| `binance_get_long_short_ratio` | Rasio long vs short agregat (blended, semua trader) + tren |
| `binance_get_taker_volume_ratio` | Tekanan beli/jual agresif (taker volume) |
| `binance_get_klines` | Candlestick OHLCV per timeframe |
| `binance_get_multi_timeframe_bias` | Bias Bullish/Bearish/Sideways di 5 timeframe sekaligus (1m/5m/15m/1h/1d) |
| `binance_get_realized_volatility` | Realized volatility historis (15m/1h) dari log-return, untuk kalibrasi lebar grid |
| `binance_get_24hr_ticker` | Ringkasan statistik 24 jam |

## Keterbatasan yang jujur perlu diketahui

- **Long/short ratio adalah rasio agregat BLENDED**, bukan breakdown terpisah
  "global account (retail)" vs "top trader (whale)" seperti API resmi Binance.
  Coinalyze (sumber data worker ini) cuma punya satu ratio gabungan. Provider
  yang punya breakdown itu (CoinGlass, CoinAnk) semua berbayar — sudah dicek,
  tidak ada versi gratisnya per Agustus 2026.
- **24hr ticker dan taker buy/sell ratio adalah hasil derivasi**, bukan angka
  resmi dari endpoint ticker Binance — dihitung dari data candlestick (OHLCV)
  Coinalyze. Cukup akurat untuk overview, tapi bukan 1:1 sama persis dengan
  yang ditampilkan di Binance.
- Data histori OI dan funding rate dibatasi ketersediaannya oleh Coinalyze
  (umumnya beberapa bulan terakhir, tergantung symbol).
- Tidak ada data tick-level order book atau data wallet on-chain.
- Coinalyze free tier: rate limit 40 request/menit per API key.

## Setup Coinalyze API Key (wajib, sekali saja)

1. Daftar gratis di https://coinalyze.net
2. Ambil API key dari halaman akun
3. Set sebagai secret worker (bukan di `wrangler.toml`, bukan hardcode):
   ```bash
   npx wrangler secret put COINALYZE_API_KEY
   ```
   (paste API key saat diminta)

Tanpa secret ini, semua tool call akan gagal dengan pesan error yang jelas
("COINALYZE_API_KEY belum diset").

## Setup Deploy Otomatis (GitHub Actions → Cloudflare Workers)

Repo ini sudah punya workflow di `.github/workflows/deploy.yml` yang otomatis
menjalankan `wrangler deploy` setiap kali ada push ke branch `main`.

### Langkah setup (sekali saja)

**1. Buat Cloudflare API Token**

1. Buka https://dash.cloudflare.com/profile/api-tokens
2. Klik "Create Token"
3. Gunakan template **"Edit Cloudflare Workers"**
4. Scope ke akun kamu, lalu buat token
5. Salin token yang muncul (hanya ditampilkan sekali)

**2. Tambahkan token sebagai GitHub Secret**

1. Buka repo ini di GitHub → **Settings** → **Secrets and variables** → **Actions**
2. Klik **New repository secret**
3. Name: `CLOUDFLARE_API_TOKEN`
4. Value: token dari langkah 1
5. Simpan

**3. Trigger deploy**

Deploy akan otomatis jalan begitu ada push baru ke `main`. Untuk trigger
manual tanpa push baru, buka tab **Actions** di GitHub repo → pilih workflow
"Deploy to Cloudflare Workers" → **Run workflow**.

**4. Cek hasil deploy**

Setelah workflow selesai (cek tab Actions), worker akan live di:
```
https://binance-futures-mcp.<subdomain-cloudflare-kamu>.workers.dev
```

Buka URL tersebut — harus muncul JSON status `"ok"`.

## Setup Custom Domain (whale.jaringan.dev)

Ini **tidak** bisa dilakukan lewat GitHub Actions — perlu langkah manual satu
kali di dashboard Cloudflare:

1. Buka https://dash.cloudflare.com → pilih akun kamu
2. Buka **Workers & Pages** → pilih worker `binance-futures-mcp`
3. Buka tab **Settings** → **Domains & Routes**
4. Klik **Add** → **Custom Domain**
5. Masukkan `whale.jaringan.dev`
6. Cloudflare akan otomatis membuat DNS record yang diperlukan **jika**
   domain `jaringan.dev` sudah berada di zona Cloudflare akun yang sama.
   Kalau domain itu terdaftar di akun/registrar lain, kamu perlu tambahkan
   CNAME record secara manual mengarah ke target yang ditampilkan Cloudflare.

Setelah custom domain aktif, worker bisa diakses di
`https://whale.jaringan.dev` (bukan lagi domain `.workers.dev`).

## Daftarkan sebagai Custom Connector di Claude

1. Buka Claude (claude.ai) → **Settings** → **Connectors**
2. Pilih **Add custom connector**
3. Masukkan URL: `https://whale.jaringan.dev/mcp`
   (atau `https://binance-futures-mcp.<subdomain>.workers.dev/mcp` jika belum
   setup custom domain — perhatikan path `/mcp` di akhir, wajib)
4. Simpan, lalu aktifkan connector tersebut untuk percakapan yang kamu mau

## Uji coba manual sebelum daftar ke Claude (disarankan)

```bash
npm install
npx wrangler dev
```

Di terminal lain:
```bash
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "binance_get_funding_rate",
      "arguments": { "symbol": "BTCUSDT" }
    }
  }'
```

Kalau ini mengembalikan data funding rate BTCUSDT yang valid, server bekerja
dan siap dipakai.

## Biaya

Cloudflare Workers punya free tier 100.000 request/hari — untuk pemakaian
personal trading analysis ini jauh dari cukup, kemungkinan besar kamu tidak
akan pernah kena biaya.
