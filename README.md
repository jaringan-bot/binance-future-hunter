# Binance Futures MCP Server (whale)

MCP server yang menyediakan data publik Binance USDS-M Futures (funding rate,
open interest, long/short ratio, taker volume, candlestick, order book,
volatility) sebagai tools yang bisa dipanggil Claude. Semua data yang
disajikan bersifat **publik read-only** — tidak ada order/trading, tidak ada
akses ke data akun pribadi.

**Sumber data: dua jalur, tergantung tool.**

- **Binance native, lewat proxy relay Vercel.** Domain Binance
  (`fapi.binance.com`) memblokir traffic dari Cloudflare Workers di level WAF
  (403, company-wide — sudah dites langsung dari worker ini, bukan asumsi).
  Vercel pakai IP pool berbeda, jadi tidak kena block yang sama. Worker
  Cloudflare relay lewat proxy kecil di `proxy/` (project Vercel terpisah,
  lihat `proxy/README.md`). Ini jalur untuk funding rate (current & histori),
  klines/OHLCV, bias multi-timeframe, realized volatility, statistik 24 jam,
  top-trader long/short ratio, order book depth, dan aggregate trades.
- **[Coinalyze](https://coinalyze.net)**, untuk data yang belum (atau sengaja
  belum) dipindah ke jalur native: open interest, long/short ratio blended
  (semua trader), histori liquidation, dan taker buy/sell volume ratio.
  Coinalyze meng-agregasi ulang data yang sama (sumber asli tetap Binance)
  dan API-nya sendiri di-hosting di Cloudflare, jadi tidak kena block yang
  sama.

Konsekuensinya, worker ini butuh **dua set kredensial**: `COINALYZE_API_KEY`
dan `PROXY_URL`/`PROXY_SECRET` (proxy Vercel) — lihat bagian Setup di bawah.

## Yang disediakan

| Tool | Fungsi | Sumber |
|---|---|---|
| `binance_get_funding_rate` | Funding rate terkini + basis (deviasi mark vs index price) | Binance native |
| `binance_get_funding_rate_history` | Tren funding rate dari waktu ke waktu | Binance native |
| `binance_get_open_interest` | OI snapshot terkini | Coinalyze |
| `binance_get_open_interest_history` | Tren OI naik/turun | Coinalyze |
| `binance_get_long_short_ratio` | Rasio long vs short agregat (blended, semua trader) + tren | Coinalyze |
| `binance_get_top_trader_ratio` | Rasio long/short KHUSUS top trader (breakdown murni, akun atau size posisi) | Binance native |
| `binance_get_order_book_depth` | Snapshot order book (bid/ask), spread, wall terbesar | Binance native |
| `binance_get_order_book_imbalance` | Imbalance volume bid vs ask di depth 5/10/20, dengan label bias (BULLISH/BEARISH/SEIMBANG) | Binance native |
| `binance_get_agg_trades` | Trade individual granular (buy/sell aggressor) untuk deteksi absorption | Binance native |
| `binance_get_liquidation_history` | Histori liquidation | Coinalyze |
| `binance_get_taker_volume_ratio` | Tekanan beli/jual agresif (taker volume), derivasi dari OHLCV | Coinalyze |
| `binance_get_klines` | Candlestick OHLCV per timeframe | Binance native |
| `binance_get_multi_timeframe_bias` | Bias Bullish/Bearish/Sideways di 5 timeframe sekaligus (1m/5m/15m/1h/1d) | Binance native |
| `binance_get_realized_volatility` | Realized volatility historis (15m/1h) dari log-return, untuk kalibrasi lebar grid | Binance native |
| `binance_get_24hr_ticker` | Ringkasan statistik 24 jam (rolling window resmi) | Binance native |

## Keterbatasan yang jujur perlu diketahui

- **Long/short ratio (`binance_get_long_short_ratio`) adalah rasio agregat
  BLENDED**, bukan breakdown terpisah "global account (retail)" vs "top
  trader (whale)". Untuk breakdown murni top-trader, pakai
  `binance_get_top_trader_ratio` (sudah native Binance, terpisah dari tool
  ini).
- **Taker buy/sell ratio adalah hasil derivasi**, bukan angka resmi dari
  endpoint taker ratio Binance — dihitung dari data candlestick (OHLCV)
  Coinalyze. Cukup akurat untuk overview, tapi bukan 1:1 sama persis dengan
  yang ditampilkan di Binance.
- **Basis funding rate bisa noisy untuk pair kecil/baru listing** — index
  price Binance adalah rata-rata tertimbang dari beberapa exchange spot,
  salah satunya bisa illikuid untuk pair semacam itu.
- **Order book depth adalah snapshot sesaat** — wall besar bisa hilang dalam
  hitungan detik (potensi spoofing), jangan overinterpretasi satu snapshot.
- **Threshold "top trader" tidak dipublikasikan Binance secara pasti**, dan
  datanya snapshot periodik, bukan real-time tick-by-tick.
- Data histori OI (`binance_get_open_interest_history`) dibatasi
  ketersediaannya oleh Coinalyze (umumnya beberapa bulan terakhir, tergantung
  symbol).
- Tidak ada data wallet on-chain.
- Coinalyze free tier: rate limit 40 request/menit per API key.

## Setup Coinalyze API Key (wajib, sekali saja)

1. Daftar gratis di https://coinalyze.net
2. Ambil API key dari halaman akun
3. Set sebagai secret worker (bukan di `wrangler.toml`, bukan hardcode):
   ```bash
   npx wrangler secret put COINALYZE_API_KEY
   ```
   (paste API key saat diminta)

Tanpa secret ini, tool yang bersumber Coinalyze (lihat tabel di atas) akan
gagal dengan pesan error yang jelas ("COINALYZE_API_KEY belum diset").

## Setup Proxy Vercel (wajib, sekali saja)

Tool berlabel "Binance native" di tabel atas butuh proxy relay di Vercel,
karena worker Cloudflare diblokir langsung oleh WAF Binance. Detail deploy
proxy ada di `proxy/README.md` — ringkasnya:

1. Deploy folder `proxy/` sebagai project Vercel terpisah (Root Directory =
   `proxy`), set env var `PROXY_SECRET` di Vercel (string acak, generate
   sendiri, misal `openssl rand -hex 32`).
2. Set dua secret ini di worker Cloudflare:
   ```bash
   npx wrangler secret put PROXY_URL
   npx wrangler secret put PROXY_SECRET
   ```
   `PROXY_URL` = URL project Vercel (contoh `https://whale-pearl.vercel.app`),
   `PROXY_SECRET` = string yang sama persis dengan yang di-set di Vercel.

Tanpa dua secret ini, tool berlabel "Binance native" akan gagal dengan pesan
error yang jelas ("PROXY_URL atau PROXY_SECRET belum diset di worker").

**Penting**: jangan pernah buat secret Cloudflare dengan VALUE sebagai NAME
(misal `wrangler secret put` lalu tidak sengaja paste value di prompt nama).
`wrangler secret list` hanya boleh membocorkan nama secret, tidak pernah
value — kesalahan ini membuat value asli bocor lewat command yang seharusnya
aman.

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
https://whalescope-mcp.<subdomain-cloudflare-kamu>.workers.dev
```

Buka URL tersebut — harus muncul JSON status `"ok"`.

## Setup Custom Domain (whale.jaringan.dev)

Ini **tidak** bisa dilakukan lewat GitHub Actions — perlu langkah manual satu
kali di dashboard Cloudflare:

1. Buka https://dash.cloudflare.com → pilih akun kamu
2. Buka **Workers & Pages** → pilih worker `whalescope-mcp`
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
   (atau `https://whalescope-mcp.<subdomain>.workers.dev/mcp` jika belum
   setup custom domain — perhatikan path `/mcp` di akhir, wajib)
4. Simpan, lalu aktifkan connector tersebut untuk percakapan yang kamu mau

## Uji coba manual sebelum daftar ke Claude (disarankan)

Tidak ada test suite otomatis di repo ini — `npm run typecheck` adalah satu-
satunya automated check. Verifikasi tool baru/berubah dilakukan manual lewat
`wrangler dev` + curl JSON-RPC.

```bash
npm install
npx wrangler dev
```

Di terminal lain, contoh untuk tool Binance native:
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

Kalau ini mengembalikan data funding rate + basis BTCUSDT yang valid, jalur
proxy Vercel bekerja. Untuk tool Coinalyze, ganti `name` ke misalnya
`binance_get_open_interest` — kalau itu juga valid, jalur Coinalyze bekerja.

## Biaya

- Cloudflare Workers: free tier 100.000 request/hari — untuk pemakaian
  personal trading analysis ini jauh dari cukup.
- Vercel (proxy relay): free tier Hobby plan mencakup jutaan invocation/bulan
  untuk serverless function — tidak akan kena biaya untuk pemakaian personal.
  Perhatikan: `PROXY_SECRET` wajib dijaga kerahasiaannya, karena siapapun
  yang tahu URL + secret bisa memakai quota proxy ini atas nama kamu.

Kemungkinan besar kamu tidak akan pernah kena biaya di kedua platform untuk
pemakaian personal.
