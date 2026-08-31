# WhaleScope MCP — Binance Futures Market Intelligence

🇮🇩 Bahasa Indonesia | [🇬🇧 English](README.en.md)

MCP server yang menyediakan data publik Binance USDS-M Futures (funding rate,
open interest, long/short ratio, taker volume, candlestick, order book,
volatility) plus pembanding Binance Spot (harga, order book, candlestick,
CVD) sebagai tools yang bisa dipanggil Claude. Semua data yang disajikan
bersifat **publik read-only** — tidak ada order/trading, tidak ada akses ke
data akun pribadi.

## Quick Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/osindo-dev/whalescope-mcp)

Tombol ini clone repo + bikin Worker di akun Cloudflare kamu sendiri,
termasuk **provision KV namespace & D1 database baru otomatis** (Cloudflare
generate `id`/`database_id` baru buat akun kamu, gak perlu bikin manual).
**Bukan zero-touch sepenuhnya** — biar jujur soal apa yang masih manual:
setelah klik, kamu TETAP perlu set secret (Cloudflare gak bisa nebak value
dari layanan eksternal) — lihat `.dev.vars.example` di repo ini buat daftar
lengkap, atau [Setup Proxy Vercel](#setup-proxy-vercel-wajib-sekali-saja)
di bawah. `PROXY_URL`/`PROXY_SECRET` WAJIB (semua 46 tool butuh).

## Tujuan

Menyediakan gambaran positioning pasar Binance Futures — bukan cuma harga,
tapi juga *siapa* yang lagi buka posisi apa (retail vs top trader), *seberapa
crowded* leverage-nya, dan *di harga berapa* likuiditas menumpuk — langsung
dalam percakapan dengan Claude, tanpa perlu buka dashboard exchange terpisah.

## Manfaat

- **Satu pintu buat banyak sinyal.** Funding rate, open interest, order book,
  dan order flow — semua lewat satu MCP connector, bukan gonta-ganti tab.
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
- Infrastruktur cukup dengan free tier (Cloudflare Workers + Vercel Hobby)
  untuk pemakaian personal — 100% Binance-native, tidak ada dependensi
  agregator pihak ketiga lagi.

## Kekurangan

- **Sebagian besar tool request/response.** Funding/OI/klines/order book/ratio
  semua snapshot atau histori periodik. Data streaming yang ada terbatas:
  `binance_get_realtime_liquidations` + `binance_get_contract_events` (via
  stream gateway VPS, lihat di bawah) — tidak ada push tick-by-tick untuk
  harga / order book.
- **Liquidation: SAMPLED, bukan lengkap.** Sejak 2026-08-28 ada
  `binance_get_realtime_liquidations` — WebSocket `!forceOrder@arr`
  (`dstream.binance.com`) di-buffer always-on di VPS Oracle Singapore
  (`stream-gateway/`, di luar Cloudflare — worker Cloudflare sendiri masih
  di-WAF-block dari Binance). Binance men-throttle stream ini maks 1
  event/symbol/detik, jadi ini SAMPEL likuidasi, bukan tiap satu. Tetap cukup
  buat konfirmasi cluster stop-hunt di `binance_detect_mm_activity` (proxy
  ke-3, price-anchored & sisi-hunt). Tidak ada histori liquidation jauh ke
  belakang (buffer 24 jam).
- **Setup awal butuh proxy Vercel** (wajib) — bukan pasang-langsung-jalan,
  ada langkah konfigurasi manual sekali di awal.
- Tidak ada data wallet on-chain atau data dari exchange selain Binance
  Futures USDS-M.

**Sumber data: satu jalur, 100% Binance native.**

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

Konsekuensinya, worker ini butuh `PROXY_URL`/`PROXY_SECRET` (proxy Vercel,
wajib buat semua 46 tool) — lihat bagian Setup di bawah.

**Caching & state, tanpa kredensial tambahan.** Response upstream (funding
rate, klines, OI, dll — kecuali order book & aggregate trades yang butuh
freshness ketat) di-cache bertingkat (5 detik-1 jam tergantung endpoint)
lewat Cache API bawaan Cloudflare Workers, tidak perlu setup apapun.
Threshold custom per-pair tersimpan di Workers KV (binding `CONFIG_KV`).
Time-series (basis+funding+OI, dan 6 skor sinyal `binance_detect_mm_activity`)
tersimpan di D1 (binding `DB`) — diisi otomatis oleh Cron Trigger tiap 5
menit untuk watchlist tetap 50 pair (`SNAPSHOT_WATCHLIST` di `src/shared.ts`,
diurutkan market cap, mis. BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, dst).

**Cross-exchange, tanpa proxy tambahan.** `whalescope_compare_funding_across_exchanges`
akses Bybit/OKX/Hyperliquid LANGSUNG dari worker (dites dari edge
Cloudflare beneran, gak kena WAF/geo-block kayak Binance) — gak ada
kredensial atau setup tambahan buat 3 exchange itu.

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
| `binance_get_basis_history` | Histori basis+funding+OI time-series (snapshot Cron tiap 5 menit ke D1) — selalu tersedia untuk watchlist tetap 50 pair, best-effort untuk pair lain yang sering di-query — deteksi "basis melebar lalu kembali" tanpa cek manual berkali-kali | D1 + Cron Trigger |
| `binance_get_orderbook_delta` | 2 snapshot order book ~1-2 detik terpisah, bandingkan wall antar snapshot untuk deteksi spoofing RIIL (wall hilang tanpa harga crossing level itu) — beda dari `binance_get_order_book_depth` yang cuma 1 snapshot | Binance native |
| `binance_detect_mm_activity` | Skor + tier (Weak/Moderate/Strong/Extreme) dari 6 sinyal MM/whale sekaligus (absorption, spoofing 2-snapshot RIIL, stop-hunt simetris + OI-drop proxy + trade-volume-concentration proxy, basis arbitrage, OI divergence, funding extreme) — ganti 5-6 tool call manual. Stop-hunt TETAP tanpa data liquidation riil (dihapus permanen), lihat [Keterbatasan](#keterbatasan-yang-jujur-perlu-diketahui) | Binance native |
| `binance_market_regime` | Klasifikasi kondisi pasar: TRENDING_UP/DOWN, RANGING, BREAKOUT, ACCUMULATION, DISTRIBUTION — pakai ADX(14), tren OI, CVD, spike volatilitas/volume | Binance native |
| `binance_backtest_signal` | Validasi empiris sinyal `binance_detect_mm_activity`: win rate/avg return/max drawdown dari histori sinyal D1 (watchlist tetap), forward return dihitung on-demand dari klines historis | D1 + Binance native |
| `whalescope_backtest_pipeline_decisions` | Uji maju keputusan `full_pipeline` yang tersimpan di `pipeline_decision_log` (entry-alert Phase 2 + `persist=true`): win rate / avg return / SL-touch per keputusan (TRADE/WATCH/NO_TRADE) dan bucket skor (`lt_40` / `40_55` / `gte_55`). Forward return on-demand dari klines, bukan kolom precompute, bukan auto-tune bobot | D1 + Binance native |
| `binance_analyze_smart_money` | Skor divergensi smart money (top trader) vs retail (global account) dari 5 variabel: top trader ratio, global account ratio, delta OI, funding rate, orderbook imbalance — kondisi LONG_LIQUIDATION_RISK/BULLISH_ACCUMULATION/SHORT_SQUEEZE_RISK/NEUTRAL + confidenceScore. Beda dari `binance_detect_mm_activity` (6 sinyal absorption/spoofing/stop-hunt/basis-arb) — fokus khusus top-trader-vs-retail | Binance native |
| `whalescope_compare_funding_across_exchanges` | Bandingkan funding rate, last price, open interest, 24h change 1 pair across Binance/Bybit/OKX/Hyperliquid, deteksi divergensi — cross-confirm sinyal MM detection antar exchange. Satu-satunya tool yang BUKAN Binance-only | Binance native + Bybit + OKX + Hyperliquid |
| `binance_get_tool_catalog` | Daftar semua tool + kategori/token-cost/use-case, filter per kategori — cek ini dulu sebelum manggil banyak tool individual. Nama+description auto dari tool registry (selalu akurat), kategori/token-cost tetap manual | Semi-otomatis |
| `binance_get_adl_risk` | Rating risiko Auto-Deleveraging (LOW/MEDIUM/HIGH) per pair, update tiap 30 menit | Binance native |
| `binance_get_insurance_fund_balance` | Snapshot historis saldo insurance fund per asset margin | Binance native |
| `binance_get_mark_price_klines` | Candlestick dari MARK PRICE (acuan liquidation/funding), bukan harga transaksi | Binance native |
| `binance_get_index_price_klines` | Candlestick dari INDEX PRICE (blended beberapa exchange spot), dasar premium index/funding | Binance native |
| `binance_get_premium_index_klines` | Candlestick dari PREMIUM INDEX (rasio mark vs index price), komponen utama funding rate | Binance native |
| `binance_get_continuous_klines` | Candlestick kontrak PERPETUAL/CURRENT_QUARTER/NEXT_QUARTER per pair underlying | Binance native |
| `binance_get_quarterly_settlement_price` | Histori delivery/settlement price kontrak quarterly (tidak berlaku untuk perpetual) | Binance native |
| `binance_get_composite_index_info` | Komposisi base asset + bobot sebuah composite index symbol (mis. BTCDOMUSDT) | Binance native |
| `binance_get_index_constituents` | Daftar exchange+harga+bobot penyusun index price sebuah pair | Binance native |
| `whalescope_full_pipeline` | Decision chain PENUH Grid Bot Futures (composite tertinggi): hard screen → Tier-1 intelligence (smart money, MM composite, regime 1h+4h, order book) → hitung bound grid Compass-equivalent (ATR + swing high/low) → capital-solve EXACT ke budget rugi (`risk_usd`) per opsi leverage → keputusan TRADE/WATCH/NO_TRADE + parameter Grid Bot siap copy-paste, untuk 1-20 symbol sekaligus. `persist=true` (opsional) menulis row compact ke `pipeline_decision_log` (`source=manual` atau `dropstab` + `persist_ref` slug tab). Token cost TINGGI — lihat [`docs/full_pipeline_framework.md`](docs/full_pipeline_framework.md) | Binance native |

## Konvensi `detail`: summary vs full (hemat token)

Semua tool di atas yang balikin data array/histori (klines, agg trades,
order book, open interest/funding/basis history, long-short &
top-trader ratio) punya parameter opsional `detail: "summary" | "full"`,
default `"summary"`. Ini **satu-satunya perubahan default-behavior yang
disengaja** di pembaruan token-efficiency 2026-08 — bukan penghapusan
parameter, cuma default baru:

- `detail: "summary"` (default) — cuma metrik turunan (bias, tren, CVD,
  dominance, dst — yang memang sudah dihitung tool-nya) + maksimal 10 poin
  data terbaru. Ini yang dipakai kalau kamu tidak mengirim `detail` sama
  sekali, TERMASUK untuk caller lama yang belum tahu param ini ada.
- `detail: "full"` — array/level mentah penuh, perilaku identik dengan
  sebelum pembaruan ini.

Tool composite (`binance_analyze_pair`, `binance_analyze_smart_money`,
`binance_detect_mm_activity`, `analyze_futures_grid_risk`,
`whalescope_full_pipeline`) juga dirapikan: teks dipotong ~8-12 baris,
`structuredContent` jadi payload utama dengan key lebih pendek/flat, field
kosong (null/undefined) dibuang. **Tidak ada sinyal/metrik yang hilang** —
semua tetap reachable via `structuredContent` atau `detail: "full"`.

Detail lengkap + mapping field yang berganti nama:
[`docs/tool_response_reference.md`](docs/tool_response_reference.md).

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
| **Spoofing** | order book depth, `binance_get_orderbook_delta` (2-snapshot) | Wall besar muncul lalu hilang sebelum sempat tereksekusi TANPA harga benar-benar crossing level itu; spread tiba-tiba melebar lalu normal lagi dalam hitungan detik |
| **Stop hunt** | open interest, agg trades, klines | Wick panjang (arah manapun) + body kecil candle reversal, dibantu OI-drop proxy + konsentrasi trade agresif per harga — TETAP tanpa konfirmasi liquidation riil (dihapus permanen, lihat Kekurangan) |
| **Basis arbitrage** | spot price, funding rate, open interest | Basis spot-futures melebar lalu kembali cepat; funding ekstrem + OI naik (indikasi hedge short futures / long spot) |

**Rule of thumb:** kalau **≥3 sinyal align** dalam timeframe yang sama,
indikasi aktivitas MM cukup kuat untuk ditindaklanjuti — ini heuristik
checklist (lihat tier confidence di dokumen lengkap), **bukan** probabilitas
yang terkalibrasi secara statistik.

Dokumen lengkap: [`docs/mm_detection_framework.md`](docs/mm_detection_framework.md)
(v4, final) — berisi kriteria detail tiap sinyal, workflow step-by-step,
checklist live, dan mapping tool → sinyal.

## Framework: Full Pipeline Grid Bot (`whalescope_full_pipeline`)

Tool composite tertinggi di repo ini — menjalankan SELURUH decision chain
Grid Bot Futures dalam satu tool call, untuk satu atau banyak symbol
sekaligus (maks 20 per call), menggantikan ~8 tool call manual
(`binance_market_regime` ×2, `binance_analyze_smart_money`,
`binance_detect_mm_activity`, `binance_get_order_book_imbalance`,
`analyze_futures_grid_risk`, dst.) plus kalkulasi bound grid yang
sebelumnya tidak ada tool-nya sama sekali.

**Tahapan (2-wave fetch, reject-early):**

```
┌───────────────────────────────────────────────────────────────┐
│ WAVE 1 (semua symbol, paralel): ticker24hr, funding, klines    │
│ 1h+4h, OI+histori, agg trades, market context                  │
├───────────────────────────────────────────────────────────────┤
│ HARD SCREEN: tradable? volume >= minimum? |funding| <= maks?   │
│ regime 1h/4h != BREAKOUT?                                       │
│   → GAGAL = NO_TRADE, Wave 2 TIDAK PERNAH DIPANGGIL             │
├───────────────────────────────────────────────────────────────┤
│ WAVE 2 (survivor saja, paralel): top-trader ratio, global      │
│ account ratio, OI histori 24 titik, order book depth 50        │
├───────────────────────────────────────────────────────────────┤
│ TIER-1 SCORING: smart money divergence + 6 skor MM composite   │
│ + order book imbalance + CVD + regime → rankingScore 0-100     │
├───────────────────────────────────────────────────────────────┤
│ GRID BOUNDS (Compass-equivalent): ATR + swing high/low →       │
│ upper/lower/SL/TP/gridCount/gridType                            │
├───────────────────────────────────────────────────────────────┤
│ CAPITAL SOLVE: exact (bukan iteratif) per opsi leverage, pilih  │
│ leverage tertinggi SAFE/MODERATE dengan likuidasi aman          │
├───────────────────────────────────────────────────────────────┤
│ KEPUTUSAN: TRADE / WATCH / NO_TRADE + Grid Bot config siap-pakai│
└───────────────────────────────────────────────────────────────┘
```

Dokumen lengkap (stage-by-stage, worked example, Known Limitations):
[`docs/full_pipeline_framework.md`](docs/full_pipeline_framework.md).

### Hasil Validasi Empiris

Setiap klaim teknis di framework ini divalidasi langsung ke worker deployed
(bukan asumsi) sebelum masuk versi final. Beberapa temuan yang mengoreksi
asumsi awal:

| Klaim awal | Hasil validasi |
|---|---|
| Polling <500ms buat deteksi refresh-rate spoofing | ❌ Latency riil 298-898ms/call (rata-rata ~485ms) lewat proxy chain worker→Vercel→Binance — tidak reliable buat itu |
| Threshold divergence top-trader ratio universal (flat >15% atau tiered 3-15%) | ❌ Tidak pernah trigger — pergerakan riil 4 pair yang dites (SOLUSDT, BNBUSDT, LINKUSDT, AVAXUSDT) dalam window 2 jam cuma 0.40-2.35 poin, jauh di bawah threshold manapun |
| Retensi historis top-trader ratio "30-90 hari" | ⚠️ Dikoreksi — 90 hari tidak tersedia sama sekali dari Binance; 30 hari cuma di resolusi kasar (4h/1d), resolusi 15 menit cuma ~5 hari ke belakang |
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
- **Order book depth (`binance_get_order_book_depth`) adalah snapshot
  sesaat** — wall besar bisa hilang dalam hitungan detik (potensi
  spoofing), jangan overinterpretasi satu snapshot. Untuk deteksi spoofing
  RIIL (2-snapshot), pakai `binance_get_orderbook_delta` atau
  `binance_detect_mm_activity` (lihat di bawah).
- **Threshold "top trader" tidak dipublikasikan Binance secara pasti**, dan
  datanya snapshot periodik, bukan real-time tick-by-tick.
- Data histori OI (`binance_get_open_interest_history`) dibatasi retensi
  endpoint resmi Binance (`/futures/data/openInterestHist`), cek langsung
  kalau butuh rentang panjang.
- Tidak ada data wallet on-chain.
- **Liquidation cuma near-real-time + SAMPLED, tidak ada histori panjang.**
  `binance_get_realtime_liquidations` baca buffer 24 jam dari stream gateway
  VPS (`!forceOrder@arr` via `dstream.binance.com` — `fstream.binance.com`
  di-black-hole dari IP VPS). Binance throttle 1 event/symbol/detik → sampel,
  bukan lengkap. Tidak ada REST publik market-wide buat backfill historis.
  Worker Cloudflare sendiri masih tidak bisa WS langsung ke Binance (WAF).
- **`binance_detect_mm_activity`: spoofing sekarang 2-snapshot RIIL**
  (~1-2 detik lebih lambat dari tool lain karenanya, jeda eksplisit 1500ms
  antar 2 fetch — lihat `binance_get_orderbook_delta`), bukan heuristik
  1-snapshot lagi. **Stop-hunt sekarang simetris** (cek upper DAN lower
  wick, dulu cuma upper — bug lama) **+ 2 proxy independen** (reuse fetch
  yang sudah ada, bukan fetch baru): OI turun >=2% berbarengan sama wick
  candle, dan/atau volume trade agresif >=30% terkonsentrasi tepat di zona
  harga wick itu (dari 100 aggTrades terakhir, sama data yang dipakai
  CVD). Confidence naik bertahap: 0 proxy aktif = base, 1 proxy = lebih
  tinggi, 2 proxy sekaligus = tertinggi — TETAP TANPA data
  liquidation-by-price riil (permanen, lihat poin di atas). Confidence
  stop-hunt masih lebih rendah dari sinyal lain di tool yang sama —
  dicatat di evidence text tiap response.
- **`binance_market_regime`: spike volatilitas/volume dihitung relatif ke
  window fetch yang sama** (10 candle terakhir vs 10 sebelumnya), bukan
  baseline historis jangka panjang.
- **Time-series D1 (`market_snapshots`, dibaca `binance_get_basis_history`)
  SELALU tersedia untuk watchlist tetap 50 pair, best-effort untuk pair
  lain** — pair non-watchlist dapat histori kalau di-query >=3x dalam ~24
  jam DAN masuk top-5 pair non-watchlist paling sering di-query (KV
  counter, `src/queryFrequency.ts`), cron 5 menit baru snapshot pair itu
  setelah kondisi terpenuhi. `signal_history` (dibaca
  `binance_backtest_signal`) TETAP watchlist-only, tidak ikut diperluas.
- **Pair futures-only (HYPEUSDT, 1000PEPEUSDT, PUMPUSDT, dst.) — `spot_price`
  & `basis` NULL di `market_snapshots`** karena tidak listed di Binance Spot.
  Funding rate & Open Interest tetap tercatat normal; cuma kolom basis yang
  kosong buat pair semacam itu.
- **Belum ada pruning/retention buat row D1** — row nambah terus tanpa batas
  seiring waktu (di 50 pair x ~6.048 row/hari gabungan kedua tabel, D1 free
  tier 5 juta write/hari & 5GB storage masih longgar untuk waktu yang lama,
  tapi ini bukan solusi permanen).
- **Migrasi KV→D1 (basis history) TIDAK backfill data lama** — histori basis
  yang sempat tersimpan di Workers KV sebelum migrasi ini hilang, window 24
  jam baru keisi ulang natural beberapa jam setelah deploy.
- **`binance_backtest_signal`: forward return DIHITUNG ON-DEMAND dari klines
  historis** (close candle 1h terdekat ke waktu target), BUKAN simulasi
  eksekusi order riil — slippage/fee/partial fill tidak dihitung. Sample
  size kecil (di bawah ~20 sinyal) berarti confidence rendah, jangan
  simpulkan sinyal "reliable" dari sedikit data historis (baru mulai
  terkumpul dari kapan fitur ini deploy, bukan retroaktif).
- **`pipeline_decision_log` + `whalescope_backtest_pipeline_decisions`:**
  keputusan per-symbol Phase 2 entry-alert (dan `persist=true`) disimpan
  compact 90 hari. Forward return / SL-touch dihitung on-demand dari
  klines — **bukan** precompute, **bukan** auto-tune bobot 35/30/20/15
  atau threshold 55. `entry_alert_skip_log` retensi 30 hari. Formula awal
  **dibekukan** selama uji (peek 24 jam read-only, review serius 14 hari;
  jangan retune sampai ≥20 TRADE dengan 4h+24h selesai lintas ≥3 rezim 4h;
  14 hari TRADE=0 = hasil tes bahwa 55 terlalu ketat). Protokol lengkap:
  [`docs/full_pipeline_framework.md` §16](docs/full_pipeline_framework.md).
- **`whalescope_compare_funding_across_exchanges`: Open Interest belum
  divalidasi silang ke data live** antar 4 exchange (SEHARUSNYA base-asset
  di semua exchange termasuk OKX yang pakai field `oiCcy`, tapi belum ada
  pengecekan langsung — cek ulang kalau angkanya kelihatan janggal). Symbol
  mapping Binance→exchange lain best-effort (strip suffix USDT) — pair
  kecil yang gak listed di Bybit/OKX/Hyperliquid bakal muncul "gagal" di
  baris itu, bukan bikin tool call gagal total.
- **Rate limit self-throttle ke proxy Binance itu best-effort, BUKAN hard
  global limiter** — counter in-memory per-isolate (`src/rateLimiter.ts`),
  efektif SELAMA isolate yang sama dipakai ulang buat request beruntun,
  TAPI worker ini stateless per-request jadi bukan jaminan keras
  cross-isolate. Threshold 200 request/menit, count-based (bukan
  weight-based per-endpoint kayak limit asli Binance).
- **`binance_get_tool_catalog` SEMI-otomatis** — nama+description SELALU
  akurat (ditarik dari tool registry, gak pernah basi/ketinggalan). Tapi
  category/token-cost/dependencies TETAP manual (`CATALOG_METADATA` di
  `src/tools/catalog.ts`) — tool baru yang belum di-curated bakal muncul
  dengan category `"uncategorized"`, tetap kelihatan (gak ke-omit diam-diam)
  tapi belum ter-kategorisasi rapi.
- **`binance_analyze_smart_money` pakai threshold FIXED** (bukan hasil
  kalibrasi statistik per-pair) — lihat Section 4.2 & 12 di
  `docs/mm_detection_framework.md` untuk kenapa threshold absolut pada
  top-trader ratio harus dipakai hati-hati. `confidenceScore` output-nya
  mengukur margin di atas threshold, BUKAN probabilitas statistik
  terkalibrasi.

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

### Proxy sekunder / failover (opsional)

Kalau proxy primary kena WAF block/rate-limit/5xx, worker otomatis coba
proxy sekunder — TAPI cuma kalau dikonfigurasi. Tanpa ini, perilaku persis
sama seperti sebelumnya (1 proxy, error langsung dilempar kalau gagal).

1. Deploy instance Vercel KEDUA dari folder `proxy/` yang sama (region
   beda kalau mau, misal Hong Kong vs Singapore) dengan `PROXY_SECRET`
   sendiri (boleh beda dari primary).
2. Set dua secret tambahan:
   ```bash
   npx wrangler secret put PROXY_URL_2
   npx wrangler secret put PROXY_SECRET_2
   ```

Failover cuma jalan untuk error yang berkaitan sama kesehatan/kredensial
tier (401 secret salah, 403 WAF block, 429 rate limit, 5xx) — bukan buat
error request genuinely (400 symbol salah, 404) yang bakal gagal identik
di tier manapun. 401 SENGAJA termasuk (beda dari versi sebelumnya) karena
tiap tier proxy punya secret SENDIRI — primary salah bukan berarti
secondary juga salah.

### Direct fallback (tier terakhir, otomatis ON)

Kalau primary DAN secondary (kalau dikonfigurasi) sama-sama gagal, worker
otomatis coba langsung ke `fapi.binance.com`/`api.binance.com` TANPA proxy
sama sekali sebagai last-resort. Tidak butuh setup apapun (default ON) --
set `DISABLE_DIRECT_FALLBACK=true` di environment variable worker (bukan
secret, plain var biasa) kalau mau matikan. Lihat komentar "DIRECT
FALLBACK" di `src/binanceProxyClient.ts` untuk detail & catatan jujur soal
kenapa tier ini kemungkinan besar tetap kena WAF block di kondisi produksi
saat ini (worker Cloudflare ini SUDAH TERBUKTI diblokir Binance secara
langsung) -- tetap berguna untuk `wrangler dev` lokal (IP pool beda dari
edge Cloudflare produksi) dan sebagai jaring pengaman kalau kebijakan block
berubah.

## Setup Workers KV (wajib, sekali saja — kalau fork/deploy repo ini sendiri)

`id` KV namespace di `wrangler.toml` repo ini terikat ke akun Cloudflare
yang bikin — kalau kamu fork/clone dan deploy ke akun sendiri, wajib bikin
namespace baru:

```bash
npx wrangler kv namespace create WHALESCOPE_CONFIG
```

Copy `id` yang muncul ke `[[kv_namespaces]]` di `wrangler.toml`, ganti value
`id` yang lama (binding-nya biarkan tetap `CONFIG_KV`, kode worker rujuk
nama binding itu, bukan id). Tanpa ini, `binance_set_pair_threshold` dan
`binance_get_pair_threshold` akan gagal dengan error jelas ("CONFIG_KV
belum ke-bind di worker").

## Setup Workers D1 (wajib, sekali saja — kalau fork/deploy repo ini sendiri)

Sama seperti KV di atas, `database_id` D1 di `wrangler.toml` repo ini
terikat ke akun Cloudflare yang bikin. Kalau fork/deploy ke akun sendiri:

```bash
npx wrangler d1 create whalescope-mcp-db
```

Copy `database_id` yang muncul ke `[[d1_databases]]` di `wrangler.toml`
(binding biarkan tetap `DB`), lalu jalankan migration:

```bash
npx wrangler d1 migrations apply whalescope-mcp-db --remote
```

Tanpa ini, `binance_get_basis_history` dan `binance_backtest_signal` akan
gagal dengan error jelas ("D1 database (binding DB) belum ke-bind di
worker"), dan Cron Trigger snapshot basis+sinyal MM (tiap 5 menit) akan
gagal silent tiap tick (ke-log ke Workers Logs, tidak menggagalkan endpoint
`/mcp` lain).

## Admin: Usage Log (OPSIONAL)

Worker publik gampang ditemuin (terdaftar di [MCP Server Registry](https://registry.modelcontextprotocol.io/))
— jadi ada endpoint kecil buat liat siapa aja yang connect. **Ini BUKAN
MCP tool** (sengaja HTTP endpoint terpisah, gak pernah muncul di
`tools/list`) — kalau dibikin tool biasa, SIAPA AJA yang connect ke server
ini bisa liat IP visitor lain, kontradiksi sama tujuannya.

1. Set secret (tanpa ini, endpoint SELALU balik 403 — fitur nonaktif by
   default, aman):
   ```bash
   npx wrangler secret put ADMIN_SECRET
   ```
2. Akses:
   ```bash
   curl "https://<worker-url>/admin/usage?key=<ADMIN_SECRET>&hours=24"
   ```
   Balikin JSON: total request, jumlah IP unik, top 20 IP (+ negara,
   count), 20 request terakhir mentah. Default window 24 jam, bisa
   diubah lewat `hours`.

## Monitoring & Alerting

Backend ini punya beberapa titik gagal diam-diam (proxy Vercel/VPS mati, WS
stream gateway putus, Cron Trigger di-Cancel platform). Yang ada sekarang,
semua lewat **Telegram** (butuh `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
di-set — kalau tidak, alert cuma ke Workers Logs):

| Cek | Cron | Alert kalau |
|---|---|---|
| `checkHeartbeat` (`heartbeatCron.ts`) | 3×/hari (07/15/23 WIB) | 8 jam nol sinyal TRADE/WATCH — 1 pesan yang bedain "market sepi + backend normal" vs ">30% pair gagal tiap tick = backend bermasalah" vs "nol data = cron mati" |
| `checkEntryAlertCronFreshness` (`heartbeatCron.ts`) | nempel di `*/5` | nol tick entry-alert SELESAI dalam 40 menit (deteksi tick di-Cancel platform) — cooldown 1 jam |
| `checkStreamGatewayHealth` (`infraHealthCron.ts`) | nempel di `*/5` | VPS stream gateway `:8081/health` unreachable, WS ke Binance putus, atau buffer basi >5 menit — cooldown 1 jam |
| `checkMarketSnapshotFreshness` (`infraHealthCron.ts`) | nempel di `*/5` | nol baris `market_snapshots` baru dalam 20 menit (cron snapshot `*/5` berhenti nulis) — cooldown 1 jam |
| `checkD1Capacity` (`infraHealthCron.ts`) | 3×/hari (piggyback `HEARTBEAT_CRON`) | `market_snapshots` + `signal_history` (dua tabel tanpa pruning) gabungan lewat 5 juta baris — cooldown 24 jam |

Semua cek KV-gated (maks 1 alert per cooldown selagi kondisi persist), aman
dijalanin tiap 5 menit.

**Yang MASIH belum ada** (kerjaan dashboard, bukan kode):

- **Uptime monitor eksternal** ke worker `/` + relay `https://<vps>/health` —
  pakai UptimeRobot / Cloudflare Health Checks (gratis, 5-menit). Ini yang
  paling cepat nangkep VPS/relay mati total; cek internal di atas cuma
  backstop dengan lag.
- **Cloudflare notification** untuk spike error-rate Workers / CPU-limit —
  observability (`[observability] enabled = true`) cuma ngumpulin data, gak
  ada rule alert.

## Keamanan: DNS Rebinding Protection (OPSIONAL)

Endpoint `/mcp` memvalidasi header `Origin` sebelum memproses request --
default izinkan `https://claude.ai`/`https://claude.com` (dan request TANPA
header `Origin` sama sekali, yang mencakup mayoritas MCP client
server-to-server, termasuk cara worker ini dipakai sebagai custom
connector). Request dengan `Origin` LAIN yang tidak diizinkan dibalas 403.
Ini pengganti opsi bawaan SDK (`enableDnsRebindingProtection`/
`allowedHosts`/`allowedOrigins`) yang sudah `@deprecated` di
`@modelcontextprotocol/sdk` -- SDK sekarang merekomendasikan middleware
eksternal, itu yang dilakukan di sini.

Kalau kamu punya web app sendiri yang perlu manggil `/mcp` langsung dari
browser, tambahkan origin-nya:
```bash
npx wrangler secret put ALLOWED_ORIGINS
# contoh value: https://app-kamu.com,https://staging.app-kamu.com
```
(comma-separated, tanpa spasi setelah koma juga OK -- di-trim otomatis.)

Data disimpan di D1 (`request_log`), di-prune otomatis tiap Cron tick
buat row lebih dari 30 hari (tabel ini gak dibatasi watchlist tetap kayak
`market_snapshots`/`signal_history`, jadi bisa growth kalau ada traffic
asing beneran).

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
  kombinasi beberapa tool (order book, agg trades, OI, klines)
  mengikuti [Framework Analisis](#framework-analisis-deteksi-market-maker--whale)
  di atas — sebutkan pair-nya, Claude yang menjalankan workflow deteksinya
- *"Bandingin funding rate BTC, ETH, SOL, sama BNB"* →
  `binance_compare_symbols`
- *"Layak gak buka Grid Bot Futures di BTCUSDT dan ETHUSDT sekarang, budget
  rugi $20?"* → `whalescope_full_pipeline` (composite tertinggi, 1 call
  jalanin hard screen → Tier-1 intel → grid bounds → risk sizing →
  keputusan TRADE/WATCH/NO_TRADE + parameter Grid Bot siap copy-paste untuk
  kedua pair sekaligus)

Karena semua tool read-only, aman dicoba tanya apapun soal data pasar tanpa
risiko memicu order/trading — worker ini tidak punya kemampuan itu sama
sekali.

## Uji coba manual sebelum daftar ke Claude (disarankan)

`npm test` (vitest) + `npm run typecheck` adalah automated check di repo ini
— tapi keduanya cuma nge-cover pure logic (scoring functions, D1/KV
wrapper, tool handler lewat fake `McpServer`), BUKAN Workers `fetch`/
`scheduled` handler beneran (gak ada `@cloudflare/vitest-pool-workers`).
Verifikasi tool baru/berubah TETAP butuh manual lewat `wrangler dev` + curl
JSON-RPC buat itu.

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
proxy Vercel bekerja.

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
realistis. Bukan bagian `npm test`/CI (hit worker live via itu) — dipakai
manual pas mau cek dampak perubahan tool description/
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
