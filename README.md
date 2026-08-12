# WhaleScope MCP — Binance Futures Market Intelligence

🇮🇩 Bahasa Indonesia | [🇬🇧 English](README.en.md)

MCP server yang menyediakan data publik Binance USDS-M Futures (funding rate,
open interest, long/short ratio, taker volume, candlestick, order book,
volatility) plus pembanding Binance Spot (harga, order book, candlestick,
CVD) sebagai tools yang bisa dipanggil Claude. Semua data yang disajikan
bersifat **publik read-only** — tidak ada order/trading, tidak ada akses ke
data akun pribadi.

## Tujuan

Menyediakan gambaran positioning pasar Binance Futures — bukan cuma harga,
tapi juga *siapa* yang lagi buka posisi apa (retail vs top trader), *seberapa
crowded* leverage-nya, dan *di harga berapa* likuiditas menumpuk — langsung
dalam percakapan dengan Claude, tanpa perlu buka dashboard exchange terpisah.

## Manfaat

- **Satu pintu buat banyak sinyal.** Funding rate, open interest, order book,
  order flow, dan histori liquidation — semua lewat satu MCP connector, bukan
  gonta-ganti tab.
- **Bisa bedain retail vs whale.** `binance_get_top_trader_ratio` kasih
  breakdown murni top-trader (terpisah dari `binance_get_long_short_ratio`
  yang blended) — berguna buat lihat kalau posisi retail dan whale lagi
  divergen.
- **Native Binance di mana itu penting.** Harga, funding rate, klines, order
  book — semua lewat jalur native Binance (bukan derivasi pihak ketiga),
  supaya presisi terjaga terutama untuk pair kecil/kurang likuid.
- **Gratis buat pemakaian personal** — lihat bagian [Biaya](#biaya).

## Kelebihan

- 29 tools mencakup lima sudut analisis: bias arah pasar, area harga kunci
  (order book), konfirmasi eksekusi (order flow/aggressor), pembanding
  Futures-vs-Spot (leverage-driven vs demand riil), dan market-wide scan
  (funding rate ekstrem lintas semua pair, atau bandingkan metrik across
  beberapa pair) — plus tool composite (`binance_analyze_pair`) buat
  overview cepat tanpa banyak tool call, dan config/histori (threshold
  per-pair, basis time-series) yang tersimpan di Workers KV.
- Read-only terhadap data pasar Binance — tidak ada order/trading. Satu-
  satunya tool yang menulis state (`binance_set_pair_threshold`) cuma
  nyimpen preferensi threshold kamu sendiri di Workers KV, tidak menyentuh
  akun Binance/data pihak luar sama sekali.
- Transparan soal keterbatasan tiap tool (lihat bagian di bawah), bukan
  dibungkus seolah semua data sempurna.
- Infrastruktur cukup dengan free tier (Cloudflare Workers + Vercel Hobby +
  Coinalyze free tier) untuk pemakaian personal.

## Kekurangan

- **Bukan stream real-time.** Semua tool bersifat request/response (snapshot
  atau histori periodik) — tidak ada push event detik-demi-detik (misalnya
  liquidation baru terjadi). Menambah itu butuh komponen infrastruktur
  tambahan yang di luar cakupan project ini saat ini.
- **Satu tool masih lewat agregator pihak ketiga** (Coinalyze, khusus histori
  liquidation) — lihat bagian
  [Keterbatasan](#keterbatasan-yang-jujur-perlu-diketahui) untuk detail.
- **Setup awal butuh beberapa kredensial** (Coinalyze API key + proxy Vercel)
  — bukan pasang-langsung-jalan, ada langkah konfigurasi manual sekali di
  awal.
- **Rate limit free tier Coinalyze** (40 request/menit per API key) bisa jadi
  bottleneck kalau dipakai sangat intensif.
- Tidak ada data wallet on-chain atau data dari exchange selain Binance
  Futures USDS-M.

**Sumber data: dua jalur, tergantung tool.**

- **Binance native, lewat proxy relay Vercel.** Domain Binance
  (`fapi.binance.com`) memblokir traffic dari Cloudflare Workers di level WAF
  (403, company-wide — sudah dites langsung dari worker ini, bukan asumsi).
  Vercel pakai IP pool berbeda, jadi tidak kena block yang sama. Worker
  Cloudflare relay lewat proxy kecil di `proxy/` (project Vercel terpisah,
  lihat `proxy/README.md`). Ini jalur untuk funding rate (current & histori),
  klines/OHLCV, bias multi-timeframe, realized volatility, statistik 24 jam,
  order book depth, aggregate trades, open interest (current & histori),
  long/short ratio (blended & top-trader), taker buy/sell volume ratio, dan
  harga spot (proxy juga relay ke Binance Spot API `api.binance.com` lewat
  parameter `market=spot`, lihat `proxy/README.md`).
- **[Coinalyze](https://coinalyze.net)**, sekarang cuma untuk satu tool yang
  belum dipindah ke jalur native: histori liquidation
  (`binance_get_liquidation_history`). Coinalyze meng-agregasi ulang data yang
  sama (sumber asli tetap Binance) dan API-nya sendiri di-hosting di
  Cloudflare, jadi tidak kena block yang sama.

Konsekuensinya, worker ini butuh **dua set kredensial**: `COINALYZE_API_KEY`
dan `PROXY_URL`/`PROXY_SECRET` (proxy Vercel) — lihat bagian Setup di bawah.

**Caching & state, tanpa kredensial tambahan.** Response upstream (funding
rate, klines, OI, dll — kecuali order book & aggregate trades yang butuh
freshness ketat) di-cache singkat (5 detik) lewat Cache API bawaan
Cloudflare Workers, tidak perlu setup apapun. Threshold custom per-pair dan
histori basis time-series tersimpan di Workers KV (binding `CONFIG_KV`,
sudah termasuk di `wrangler.toml` repo ini) — snapshot basis diisi otomatis
oleh Cron Trigger tiap 5 menit untuk watchlist tetap (BTCUSDT, ETHUSDT,
SOLUSDT).

## Yang disediakan

| Tool | Fungsi | Sumber |
|---|---|---|
| `binance_get_funding_rate` | Funding rate terkini + basis (deviasi mark vs index price) | Binance native |
| `binance_get_funding_rate_history` | Tren funding rate dari waktu ke waktu | Binance native |
| `binance_get_spot_price` | Harga spot Binance + basis riil vs mark price futures (beda dari basis di atas yang vs index price). Error jelas kalau pair futures-only (tidak listed di Spot) | Binance native (Spot) |
| `binance_scan_funding_extremes` | Scan funding rate SEMUA pair Futures sekaligus (1 call bulk), kembalikan top pair paling crowded long/short | Binance native |
| `binance_get_open_interest` | OI snapshot terkini | Binance native |
| `binance_get_open_interest_history` | Tren OI naik/turun | Binance native |
| `binance_get_long_short_ratio` | Rasio long vs short agregat (blended, semua trader) + tren | Binance native |
| `binance_get_top_trader_ratio` | Rasio long/short KHUSUS top trader (breakdown murni, akun atau size posisi) | Binance native |
| `binance_get_order_book_depth` | Snapshot order book (bid/ask), spread, wall terbesar | Binance native |
| `binance_get_order_book_imbalance` | Imbalance volume bid vs ask di depth 5/10/20, dengan label bias (BULLISH/BEARISH/SEIMBANG) | Binance native |
| `binance_get_agg_trades` | Trade individual granular (buy/sell aggressor) untuk deteksi absorption | Binance native |
| `binance_get_liquidation_history` | Histori liquidation | Coinalyze |
| `binance_get_taker_volume_ratio` | Tekanan beli/jual agresif (taker volume), statistik resmi Binance | Binance native |
| `binance_get_klines` | Candlestick OHLCV per timeframe, dukung `startTime`/`endTime` (histori jauh ke belakang, buat backtest, maks 1500 candle/panggilan) | Binance native |
| `binance_get_multi_timeframe_bias` | Bias Bullish/Bearish/Sideways di 5 timeframe sekaligus (1m/5m/15m/1h/1d) | Binance native |
| `binance_get_realized_volatility` | Realized volatility historis (15m/1h) dari log-return, untuk kalibrasi lebar grid | Binance native |
| `binance_get_24hr_ticker` | Ringkasan statistik 24 jam (rolling window resmi) | Binance native |
| `binance_get_spot_ticker_24hr` | Statistik 24 jam versi Spot (harga, %change, VWAP, volume, jumlah trade) — bandingkan dengan versi Futures di atas | Binance native (Spot) |
| `binance_get_spot_book_ticker` | Best bid/ask + qty real-time Spot, lebih ringan dari full order book | Binance native (Spot) |
| `binance_get_spot_order_book` | Order book depth Spot (bid/ask, spread, wall terbesar) | Binance native (Spot) |
| `binance_get_spot_klines` | Candlestick OHLCV Spot per timeframe, dukung `startTime`/`endTime` (maks 1000 candle/panggilan) | Binance native (Spot) |
| `binance_get_spot_agg_trades` | Trade individual granular Spot (CVD riil, bukan leverage) | Binance native (Spot) |
| `binance_get_spot_avg_price` | Harga rata-rata bergerak Spot (window beberapa menit, lebih stabil dari last-trade) | Binance native (Spot) |
| `binance_check_spot_listing` | Cek apakah pair listed di Binance Spot + status trading — dipakai sebelum panggil tool Spot lain untuk pair yang belum pasti | Binance native (Spot) |
| `binance_analyze_pair` | Overview cepat 1 pair (composite): funding, tren OI, tren top trader, taker volume, order book, bias harga — 6 tool sekaligus dalam 1 call | Binance native |
| `binance_compare_symbols` | Bandingkan 1 metrik (funding rate, %change 24h, OI, top trader ratio, taker ratio) across 2-10 pair sekaligus, diurutkan dari paling ekstrem | Binance native |
| `binance_set_pair_threshold` | Set threshold funding/basis custom per-pair (override default ±0.03%/±0.05%), tersimpan di Workers KV | Workers KV |
| `binance_get_pair_threshold` | Cek threshold custom yang sudah di-set untuk sebuah pair | Workers KV |
| `binance_get_basis_history` | Histori basis futures-vs-spot time-series (snapshot Cron tiap 5 menit), watchlist tetap BTCUSDT/ETHUSDT/SOLUSDT — deteksi "basis melebar lalu kembali" tanpa cek manual berkali-kali | Workers KV + Cron Trigger |

## Framework Analisis: Deteksi Market Maker & Whale

Tidak ada tool yang bisa melihat identitas atau posisi spesifik market
maker (MM)/whale secara langsung — data Binance yang publik memang tidak
menyediakan itu. Yang bisa dilakukan (dan itulah fungsi framework ini):
membaca **jejak aktivitas** mereka dengan menggabungkan beberapa tool di
atas, lalu menghitung skor indikasi dari pola yang muncul.

**Empat kategori sinyal yang dideteksi:**

| Sinyal | Tool utama | Contoh pola |
|---|---|---|
| **Absorption** | order book depth, agg trades (futures & spot), open interest | CVD flat/naik tapi harga stagnan = sell pressure sedang diserap (accumulation); OI spike tajam + harga sideways = posisi besar baru dibuka |
| **Spoofing** | order book depth, order book imbalance | Wall besar muncul lalu hilang sebelum sempat tereksekusi; spread tiba-tiba melebar lalu normal lagi dalam hitungan detik |
| **Stop hunt** | liquidation history, open interest, klines | Spike liquidation di satu sisi + wick panjang di candle pada waktu yang sama + harga reverse dalam 1-3 candle sesudahnya |
| **Basis arbitrage** | spot price, funding rate, open interest | Basis spot-futures melebar lalu kembali cepat; funding ekstrem + OI naik (indikasi hedge short futures / long spot) |

**Rule of thumb:** kalau **≥3 sinyal align** dalam timeframe yang sama,
indikasi aktivitas MM cukup kuat untuk ditindaklanjuti — ini heuristik
checklist (lihat tier confidence di dokumen lengkap), **bukan** probabilitas
yang terkalibrasi secara statistik.

Dokumen lengkap: [`docs/mm_detection_framework.md`](docs/mm_detection_framework.md)
(v4, final) — berisi kriteria detail tiap sinyal, workflow step-by-step,
checklist live, dan mapping tool → sinyal.

### Hasil Validasi Empiris

Setiap klaim teknis di framework ini divalidasi langsung ke worker deployed
(bukan asumsi) sebelum masuk versi final. Beberapa temuan yang mengoreksi
asumsi awal:

| Klaim awal | Hasil validasi |
|---|---|
| Polling <500ms buat deteksi refresh-rate spoofing | ❌ Latency riil 298-898ms/call (rata-rata ~485ms) lewat proxy chain worker→Vercel→Binance — tidak reliable buat itu |
| Threshold divergence top-trader ratio universal (flat >15% atau tiered 3-15%) | ❌ Tidak pernah trigger — pergerakan riil 4 pair yang dites (SOLUSDT, BNBUSDT, LINKUSDT, AVAXUSDT) dalam window 2 jam cuma 0.40-2.35 poin, jauh di bawah threshold manapun |
| Retensi historis top-trader ratio "30-90 hari" | ⚠️ Dikoreksi — 90 hari tidak tersedia sama sekali dari Binance; 30 hari cuma di resolusi kasar (4h/1d), resolusi 15 menit cuma ~5 hari ke belakang |
| Liquidation history bisa dipetakan ke level harga | ❌ Field `binance_get_liquidation_history` cuma `{totalLong, totalShort, dominance}` per window waktu, tanpa harga sama sekali — perlu cross-check manual ke `klines` |
| Kondisi pasar tenang (BTCUSDT) tidak over-trigger | ✅ Terkonfirmasi — skor ~1-1.5/6 (tier Weak) saat pasar sideways, framework tidak salah alarm di kondisi normal |

Detail penuh (termasuk raw data test per klaim): Section 10,
[`docs/mm_detection_framework.md`](docs/mm_detection_framework.md#10-validasi-empiris).

## Keterbatasan yang jujur perlu diketahui

- **Long/short ratio (`binance_get_long_short_ratio`) adalah rasio agregat
  BLENDED**, bukan breakdown terpisah "global account (retail)" vs "top
  trader (whale)". Untuk breakdown murni top-trader, pakai
  `binance_get_top_trader_ratio` (sudah native Binance, terpisah dari tool
  ini).
- **Basis funding rate bisa noisy untuk pair kecil/baru listing** — index
  price Binance adalah rata-rata tertimbang dari beberapa exchange spot,
  salah satunya bisa illikuid untuk pair semacam itu.
- **Order book depth adalah snapshot sesaat** — wall besar bisa hilang dalam
  hitungan detik (potensi spoofing), jangan overinterpretasi satu snapshot.
- **Threshold "top trader" tidak dipublikasikan Binance secara pasti**, dan
  datanya snapshot periodik, bukan real-time tick-by-tick.
- Data histori OI (`binance_get_open_interest_history`) dibatasi retensi
  endpoint resmi Binance (`/futures/data/openInterestHist`) — tidak selama
  histori Coinalyze sebelumnya, cek langsung kalau butuh rentang panjang.
- Tidak ada data wallet on-chain.
- Coinalyze free tier: rate limit 40 request/menit per API key — sekarang
  cuma berlaku untuk `binance_get_liquidation_history`.

## Setup Coinalyze API Key (wajib, sekali saja)

1. Daftar gratis di https://coinalyze.net
2. Ambil API key dari halaman akun
3. Set sebagai secret worker (bukan di `wrangler.toml`, bukan hardcode):
   ```bash
   npx wrangler secret put COINALYZE_API_KEY
   ```
   (paste API key saat diminta)

Tanpa secret ini, `binance_get_liquidation_history` (satu-satunya tool
bersumber Coinalyze, lihat tabel di atas) akan gagal dengan pesan error yang
jelas ("COINALYZE_API_KEY belum diset").

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

## Setup Workers KV (wajib, sekali saja — kalau fork/deploy repo ini sendiri)

`id` KV namespace di `wrangler.toml` repo ini terikat ke akun Cloudflare
yang bikin — kalau kamu fork/clone dan deploy ke akun sendiri, wajib bikin
namespace baru:

```bash
npx wrangler kv namespace create WHALESCOPE_CONFIG
```

Copy `id` yang muncul ke `[[kv_namespaces]]` di `wrangler.toml`, ganti value
`id` yang lama (binding-nya biarkan tetap `CONFIG_KV`, kode worker rujuk
nama binding itu, bukan id). Tanpa ini, `binance_set_pair_threshold`,
`binance_get_pair_threshold`, dan `binance_get_basis_history` akan gagal
dengan error jelas ("CONFIG_KV belum ke-bind di worker").

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

## Setup Custom Domain (whalescope-mcp.jaringan.dev)

Ini **tidak** bisa dilakukan lewat GitHub Actions — perlu langkah manual satu
kali di dashboard Cloudflare:

1. Buka https://dash.cloudflare.com → pilih akun kamu
2. Buka **Workers & Pages** → pilih worker `whalescope-mcp`
3. Buka tab **Settings** → **Domains & Routes**
4. Klik **Add** → **Custom Domain**
5. Masukkan `whalescope-mcp.jaringan.dev`
6. Cloudflare akan otomatis membuat DNS record yang diperlukan **jika**
   domain `jaringan.dev` sudah berada di zona Cloudflare akun yang sama.
   Kalau domain itu terdaftar di akun/registrar lain, kamu perlu tambahkan
   CNAME record secara manual mengarah ke target yang ditampilkan Cloudflare.

Setelah custom domain aktif, worker bisa diakses di
`https://whalescope-mcp.jaringan.dev` (bukan lagi domain `.workers.dev`).

## Daftarkan sebagai Custom Connector di Claude

1. Buka Claude (claude.ai) → **Settings** → **Connectors**
2. Pilih **Add custom connector**
3. Masukkan URL: `https://whalescope-mcp.jaringan.dev/mcp`
   (atau `https://whalescope-mcp.<subdomain>.workers.dev/mcp` jika belum
   setup custom domain — perhatikan path `/mcp` di akhir, wajib)
4. Simpan, lalu aktifkan connector tersebut untuk percakapan yang kamu mau

### Contoh Penggunaan

Setelah connector aktif, tinggal minta lewat percakapan biasa — Claude yang
menentukan tool mana yang dipanggil (dan berapa kali) berdasarkan pertanyaan:

- *"Funding rate BTCUSDT sekarang gimana, ada indikasi crowded?"* →
  `binance_get_funding_rate`
- *"Pair apa yang funding-nya paling ekstrem sekarang di seluruh market?"* →
  `binance_scan_funding_extremes`
- *"Cek overview lengkap ETHUSDT — funding, OI, order book, bias harga"* →
  `binance_analyze_pair` (composite, 1 call ganti 6 tool terpisah)
- *"Ada tanda-tanda aktivitas market maker di SOLUSDT belakangan ini?"* →
  kombinasi beberapa tool (order book, agg trades, OI, liquidation, klines)
  mengikuti [Framework Analisis](#framework-analisis-deteksi-market-maker--whale)
  di atas — sebutkan pair-nya, Claude yang menjalankan workflow deteksinya
- *"Bandingin funding rate BTC, ETH, SOL, sama BNB"* →
  `binance_compare_symbols`

Karena semua tool read-only, aman dicoba tanya apapun soal data pasar tanpa
risiko memicu order/trading — worker ini tidak punya kemampuan itu sama
sekali.

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
proxy Vercel bekerja. Untuk jalur Coinalyze, ganti `name` ke
`binance_get_liquidation_history` — kalau itu juga valid, jalur Coinalyze
bekerja.

## Audit & Hasil

### Efisiensi Token

Response tool MCP masuk langsung ke context window Claude — beda dari REST
API biasa di mana ukuran response relatif "gratis". Repo ini pernah punya
beberapa tool yang boros token tanpa disadari; sudah diperbaiki dan
diverifikasi ke worker live (2026-08-12):

| Temuan | Sebelum | Sesudah |
|---|---|---|
| `binance_get_klines`/`spot_klines` — `structuredContent.candles` selalu ikut full array | ~14.400 token di `limit=500` (57,7KB), sampai ~43.000 token di limit maksimal 1500 | Opt-in lewat parameter `includeCandles` (default `false`) — default cuma summary (bias, swing high/low, 15 candle terakhir) |
| 6 tool histori (OI history, long/short ratio, top trader ratio, funding rate history, taker volume ratio, liquidation history) — tabel teks tanpa batas baris | 20-29KB (~5.000-7.250 token) per call di `limit=500` | Truncate ke 15 baris terakhir di teks — summary (avg/tren/dominance) tetap dihitung dari SEMUA data yang di-fetch, bukan cuma yang ditampilkan |
| 5 deskripsi tool terpanjang (funding_rate, top_trader_ratio, spot_price, klines, spot_klines) | 16.869 karakter total | 15.671 karakter (~7%, ~300 token dihemat di one-time tool-list load per sesi) |
| `binance_scan_funding_extremes` — `structuredContent.crowdedLong/crowdedShort` duplikat array yang sudah ada di tabel teks | ~2,9KB di `limit=50` (maks) | Cuma `topSymbolLong`/`topSymbolShort` (1 simbol paling ekstrem tiap sisi) — tabel lengkap tetap di teks |

Verifikasi ulang kapan saja:

```bash
npm run token-audit
```

Manggil worker deployed langsung, ukur ukuran skema tool, ukuran response
lintas skala `limit`, dan "Information Density Ratio" (data vs boilerplate)
buat beberapa tool representatif, plus simulasi 1 percakapan multi-turn
realistis. Bukan bagian `npm test`/CI (hit worker live + Binance/Coinalyze
via itu) — dipakai manual pas mau cek dampak perubahan tool description/
format response terhadap konsumsi token. Estimasi token pakai heuristik
chars/4 (gak ada tokenizer resmi Claude yang di-publish sebagai package),
jadi angkanya approximate, berguna buat perbandingan relatif (sebelum vs
sesudah perubahan), bukan angka token exact.

### Keamanan

- **Validasi input simbol pair.** `symbolSchema` (dipakai semua tool yang
  butuh parameter `symbol`) dibatasi maksimal 20 karakter dan hanya
  menerima `[A-Z0-9_]`. Sebelumnya tidak ada batasan — karena simbol dipakai
  langsung sebagai bagian key Workers KV (`threshold:${symbol}`,
  `basis_history:${symbol}`), input tanpa batas panjang/karakter berisiko
  melebihi limit 512-byte key KV atau menyisipkan karakter (titik dua,
  newline) yang mengacaukan konstruksi key. Batas 20 karakter divalidasi ke
  data riil (simbol terpanjang di Binance Futures saat ini 17 karakter),
  dan regex sengaja mengizinkan underscore supaya kontrak dated/quarterly
  (contoh `BTCUSDT_260925`) tetap valid.
- **Read-only terhadap akun.** Tidak ada tool yang melakukan order/trading
  atau mengakses data akun pribadi — satu-satunya tool yang menulis state
  (`binance_set_pair_threshold`) cuma menyimpan preferensi threshold di
  Workers KV milik worker sendiri.
- **Kredensial selalu lewat Wrangler secret**, tidak pernah di-hardcode atau
  masuk `wrangler.toml`/git — lihat peringatan eksplisit di bagian
  [Setup Proxy Vercel](#setup-proxy-vercel-wajib-sekali-saja) soal cara
  aman set secret.
- Repo ini di-scan manual untuk memastikan tidak ada API key, secret, atau
  kredensial nyata yang ter-commit — hanya placeholder/contoh (misal URL
  proxy `whale-pearl.vercel.app` di dokumentasi setup adalah nama contoh,
  bukan endpoint nyata).

## Biaya

- Cloudflare Workers: free tier 100.000 request/hari — untuk pemakaian
  personal trading analysis ini jauh dari cukup.
- Vercel (proxy relay): free tier Hobby plan mencakup jutaan invocation/bulan
  untuk serverless function — tidak akan kena biaya untuk pemakaian personal.
  Perhatikan: `PROXY_SECRET` wajib dijaga kerahasiaannya, karena siapapun
  yang tahu URL + secret bisa memakai quota proxy ini atas nama kamu.

Kemungkinan besar kamu tidak akan pernah kena biaya di kedua platform untuk
pemakaian personal.

## Disclaimer

**Project ini open source dan publik** — source code, arsitektur, dan
dokumentasi (termasuk framework analisis di `docs/`) bisa dilihat, di-clone,
dan dimodifikasi siapa saja lewat repo GitHub ini. Tidak ada data akun
pribadi yang disimpan atau diproses — semua tool bersifat read-only terhadap
API publik Binance.

- **Bukan saran finansial.** Semua data dan interpretasi (funding rate, OI,
  order book, framework deteksi MM, dll) bersifat informational — hasil
  pengolahan data publik, BUKAN rekomendasi trading. Tidak ada jaminan
  akurasi, kelengkapan, atau ketepatan waktu data — cek [Keterbatasan yang
  jujur perlu diketahui](#keterbatasan-yang-jujur-perlu-diketahui) untuk
  batasan spesifik tiap tool sebelum mengambil keputusan berdasarkan data ini.
- **Tanggung jawab pengguna.** Siapapun yang deploy, memakai, atau
  memodifikasi worker ini bertanggung jawab penuh atas hasil dan konsekuensi
  pemakaiannya sendiri — termasuk keputusan trading yang diambil berdasarkan
  output tool-tool ini.
- **Kepatuhan ke Binance API Terms of Use.** Worker ini memanggil endpoint
  publik Binance (Futures & Spot). Pemakaian personal/non-komersial sejalan
  dengan ketentuan Binance yang berlaku umum; redistribusi ulang data secara
  komersial atau pemakaian skala besar sebaiknya dicek dulu terhadap
  [Binance API Terms of Use](https://www.binance.com/en/terms) — di luar
  tanggung jawab project ini.
- **Lisensi: [MIT](LICENSE).** Bebas dipakai, dimodifikasi, dan
  didistribusikan ulang (termasuk untuk keperluan komersial), selama notice
  copyright & lisensi MIT tetap disertakan. Software disediakan "as is",
  tanpa jaminan apapun — sejalan dengan disclaimer di atas.
