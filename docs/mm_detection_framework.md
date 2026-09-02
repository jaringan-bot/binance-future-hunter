# Market Maker Detection Framework

🇮🇩 Bahasa Indonesia | [🇬🇧 English](mm_detection_framework.en.md)

> Framework deteksi aktivitas market maker (MM) menggunakan tool Binance Future Hunter (Binance Futures + Spot).
> **Catatan penting:** Tidak ada tool yang bisa melihat identitas atau posisi spesifik MM secara langsung. Framework ini membangun profil aktivitas MM dari jejak yang mereka tinggalkan di pasar.

---

## Daftar Isi

1. [Prinsip Dasar](#1-prinsip-dasar)
2. [Sinyal Absorption](#2-sinyal-absorption)
3. [Sinyal Spoofing](#3-sinyal-spoofing)
4. [Sinyal Stop Hunt](#4-sinyal-stop-hunt)
5. [Sinyal Basis Arbitrage](#5-sinyal-basis-arbitrage)
6. [Workflow Deteksi Step-by-Step](#6-workflow-deteksi-step-by-step)
7. [Checklist Live](#7-checklist-live)
8. [Mapping Tool → Sinyal](#8-mapping-tool--sinyal)
9. [Catatan Validasi Praktis](#9-catatan-validasi-praktis)
10. [Kesimpulan](#10-kesimpulan)
11. [Automated Scoring — binance_detect_mm_activity](#11-automated-scoring--binance_detect_mm_activity)
12. [Smart Money Divergence Score — binance_analyze_smart_money](#12-smart-money-divergence-score--binance_analyze_smart_money)

---

## 1. Prinsip Dasar

| Kemampuan | Bisa / Tidak |
|-----------|-------------|
| Melihat *identitas* MM | ❌ Tidak |
| Melihat *posisi spesifik* MM | ❌ Tidak |
| Mendeteksi **jejak aktivitas** MM (absorption, spoofing, stop hunt, basis arb) | ✅ Bisa, dengan menggabungkan 3–4 tool |

**Rule of thumb:** Jika **≥3 sinyal align** dalam timeframe yang sama, indikasi aktivitas MM cukup kuat untuk ditindaklanjuti (bukan probabilitas statistik terkalibrasi — lihat Section 7).

**Step 0 — cek listing sebelum mulai:** Kalau mau pakai Section 5 (basis arbitrage), panggil `binance_check_spot_listing` dulu. Banyak pair Futures (terutama koin baru/kecil) TIDAK listed di Binance Spot sama sekali (contoh nyata: VELVETUSDT) — Section 5 otomatis tidak applicable untuk pair semacam itu.

---

## 2. Sinyal Absorption

### 2.1 Order Book Absorption — *High Confidence*

**Tool yang digunakan:**
- `binance_get_order_book_depth`
- `binance_get_agg_trades`
- `binance_get_open_interest`
- `binance_get_spot_agg_trades` (pembanding CVD riil)

**Kriteria deteksi:**

| Sinyal | Interpretasi |
|--------|-------------|
| **CVD flat/naik** tapi harga stagnan | MM sedang absorb sell pressure (accumulation) |
| **CVD turun drastis** tapi harga tidak jeblok | MM sedang absorb buy pressure (distribution) |
| **OI naik TAJAM (spike)** + harga sideways | MM buka posisi besar (kemungkinan hedging). Kenaikan gradual selama beberapa jam (misal <1%/jam) BUKAN sinyal ini — itu normal market growth |
| **Trade besar** di bid/ask tanpa slippage signifikan | Eksekusi MM dengan liquidity yang sudah disiapkan |
| **CVD futures dan CVD spot berlawanan arah** untuk pair yang sama | Absorpsi spesifik di sisi futures (leverage), bukan demand/supply riil spot |

**`analyze_cvd_divergence` — window & threshold (empirik, probe #2-#5, 2026-08-26):**

| Pair class | Window | `neutralThresholdPct` | Status |
|---|---|---|---|
| Likuid/N-tinggi (BTCUSDT-class, ~17k-115k trades/window) | 60 menit kontinu | 0.0536 (5.36 poin) | **Tervalidasi** — 5 ronde probe 5→60 menit, spread divergence turun monoton 40.07→23.66→15.94→7.98→5.36 poin |
| Kurang likuid/N-rendah (DOGEUSDT-class, ~1.7k-5.8k trades/window) | 60 menit (diadopsi) | 0.0536 (sama) | **Asumsi, BELUM divalidasi** — diekstrapolasi dari pola BTCUSDT; probe langsung cuma sampai 30 menit, dan di situ spread NAIK (18.20→24.40), bukan turun. Revisit kalau sinyal divergence di pair less-liquid terbukti gak reliable |

Kekhawatiran trade-concentration (top-3 trade dominasi CVD) yang sempat muncul di diagnosis awal probe series ini terbukti artefak metrik (denominator net-CVD collapse ke 0 pas flow balanced) — metrik terkoreksi (top-3 notional / total notional) nunjukin 0/24 leg (BTCUSDT+DOGEUSDT, semua width yang diprobe) ngelewatin 20%.

---

### 2.2 Taker Volume Divergence — *Medium Confidence*

**Tool yang digunakan:**
- `binance_get_taker_volume_ratio`
- `binance_get_agg_trades`

**Kriteria deteksi:**

| Sinyal | Interpretasi |
|--------|-------------|
| **Taker buy/sell ratio ≈ 1.0** di saat volatilitas tinggi | Pasar di-absorb oleh limit orders (karakteristik MM), bukan market orders |
| **Volume spike** tapi spread menipis | MM sedang tighten pasar |

---

## 3. Sinyal Spoofing

### 3.1 Wall Pull / Spoofing — *High Confidence*

**Tool yang digunakan:**
- `binance_get_order_book_depth`
- `binance_get_order_book_imbalance`

**Kriteria deteksi:**

| Sinyal | Interpretasi |
|--------|-------------|
| **Walls besar muncul lalu hilang** sebelum tereksekusi | Tanda layering/spoofing khas MM |
| **Imbalance ekstrem di depth 5–10** yang tidak diikuti pergerakan harga | MM sedang menahan harga |
| **Spread tiba-tiba melebar** lalu kembali normal dalam detik | MM withdraw liquidity |

> ✅ **Update 2026-08-22: sekarang otomatis via `binance_get_orderbook_delta`.** Tool ini AMBIL 2 snapshot order book dengan jeda EKSPLISIT (default 1500ms, bisa diatur 500-5000ms) — bukan polling secepat mungkin — lalu bandingkan wall (qty ≥2x median sisi yang sama) antar snapshot: wall yang hilang/menyusut >70% TANPA harga (sisi lawan) benar-benar crossing level itu = indikasi spoofing riil. Dipakai juga otomatis di dalam `binance_detect_mm_activity` (lihat Section 11). Lihat Section 3.2 untuk kenapa jeda eksplisit ini menghindari masalah latency-variance yang sempat bikin pendekatan ini ditolak sebelumnya.

---

### 3.2 Order Book Refresh Rate Anomaly — *sekarang Medium-High Confidence lewat `binance_get_orderbook_delta`*

**Tool yang digunakan:**
- `binance_get_order_book_depth` (snapshot tunggal, manual)
- `binance_get_orderbook_delta` (2-snapshot, otomatis — lihat di bawah)

> ⚠️ **Batasan teknis (tervalidasi):**
> - **Chain lama (worker→Vercel→Binance)**: latensi per call **298–898ms** (rata-rata ~485ms), spread ~600ms — polling back-to-back tidak reliable.
> - **Chain baru (worker→VPS relay Singapura→Binance, sejak 2026-08-28)**: diukur 2026-08-28 — leg VPS→Binance **~77ms** (spread 7ms, `curl localhost:8080` 10×); full chain dari luar (my-machine ID → relay publik → Binance) **~150ms rata-rata, spread 18ms** (12×). Deployed worker (edge CF dekat SG → VPS) diperkirakan **~90–150ms, spread <30ms**. Latensi turun ~3×, variance turun ~20–30×.
> - Konsekuensi: polling sub-detik back-to-back buat refresh-rate spoofing sekarang **feasible** buat kasus terbatas (variance jaringan sudah kecil dibanding jendela deteksi). Deteksi wall lifecycle sub-detik sungguhan tetap butuh WS `@depth@100ms` (mekanisme on-demand watch di stream gateway — spec terpisah, belum dibangun).

**Kriteria deteksi (2-snapshot, via `binance_get_orderbook_delta`):**

| Sinyal | Interpretasi |
|--------|-------------|
| **Wall hilang/menyusut >70%** antar 2 snapshot TANPA sisi lawan (opposite side) benar-benar crossing harga level itu | Spoofing — order ditarik, bukan dieksekusi |
| **Wall hilang DAN sisi lawan crossing harga level itu** | Eksekusi wajar (harga beneran bergerak lewat level itu), BUKAN spoofing |
| **Anomali di snapshot tunggal** (`binance_get_order_book_depth`): wall di level tidak wajar, volume tidak proporsional | Kemungkinan spoofing — masih butuh konfirmasi sinyal lain kalau cuma 1 snapshot |

> 💡 **Jeda eksplisit `binance_get_orderbook_delta` (default 1500ms) tetap default yang aman.** Dengan chain baru (spread ~20ms) jarak antar-snapshot jadi jauh lebih konsisten, tapi 1500ms tetap dipertahankan sebagai default — cukup buat wall spoofing (ditarik dalam hitungan detik) dan tidak ada alasan mengetatkannya tanpa kebutuhan. Untuk kasus yang butuh sub-detik, mekanisme on-demand depth-diff watch di stream gateway (spec terpisah) lebih tepat daripada polling REST.

> ⚠️ **WebSocket: TERBATAS.** Stream gateway VPS pegang `!forceOrder@arr` + `!contractInfo` always-on (→ `binance_get_realtime_liquidations`, `binance_get_contract_events`). TIDAK ada stream depth/aggTrade per-symbol (high-volume, sengaja di luar scope batch ini). Deteksi refresh-rate wall sub-detik butuh tambahan on-demand depth watch — belum dibangun.

---

## 4. Sinyal Stop Hunt

### 4.1 Liquidation Cluster Reversal — **data liquidation RIIL tersedia lagi via stream gateway VPS (2026-08-28)**

> **Sejarah**: `binance_get_liquidation_history` (via Coinalyze) dihapus 2026-08-22 — Binance gak punya REST publik market-wide, dan WebSocket `fstream.binance.com` (`!forceOrder@arr`) kena block dari Cloudflare Workers/DO (3x dikonfirmasi). Solusi butuh relay always-on berbayar, yang saat itu ditolak.
>
> **2026-08-28 — infra baru bikin ini possible lagi.** Oracle VPS Singapore (`146.235.17.228`, ~$3.6/bln, bukan Cloudflare) sekarang jalanin `whale-stream-gateway` (`stream-gateway/` di repo): satu WebSocket always-on ke `dstream.binance.com/stream?streams=!forceOrder@arr/!contractInfo` (NB: `fstream.binance.com` di-black-hole dari IP SG — accept upgrade, kirim nol data; `dstream` serve feed `!forceOrder@arr` yang sama termasuk simbol USD-M dan TIDAK di-filter), buffer ke SQLite, expose `GET /stream/liquidations?symbol=&sinceMs=&minNotionalUsd=` di balik Caddy yang sama. Tool baru `binance_get_realtime_liquidations` + `binance_get_contract_events`.
>
> **Feed di-SAMPEL Binance** (maks 1 event/symbol/detik) — bukan tiap liquidation. Jadi tetap dipakai sebagai **confidence-boost**, bukan trigger tunggal.
>
> **Sinyal `stopHunt` di `binance_detect_mm_activity` sekarang punya 3 konfirmasi** (wick SIMETRIS — upper=hunt of longs, lower=hunt of shorts — tetap prasyarat):
> 1. **OI-drop proxy**: OI turun ≥2% berbarengan candle wick (REUSE OI-history fetch, bukan fetch baru).
> 2. **Trade-volume concentration proxy**: dari 100 aggTrades terakhir (REUSE dari CVD), volume trade agresif searah hunt terkonsentrasi ≥30% di zona harga wick.
> 3. **Liquidation cluster RIIL** (baru): dari stream gateway, cluster liquidasi di sisi hunt (`SELL` buat hunt-of-longs, `BUY` buat hunt-of-shorts) dengan harga DI DALAM zona wick — ≥3 event ATAU ≥$50k notional. Ini bukan proxy, ini data liquidation-by-price langsung (walau sampled). Best-effort: kalau gateway down/degraded, `computeMmSignals` pass `undefined` dan stopHunt fallback ke proxy 1+2 saja.
>
> **Tier** (full pattern / partial wick>0.6):
> - cluster liquidasi RIIL ada → **0.98 / 0.72** (tertinggi, mengalahkan kombinasi proxy)
> - else: 0 proxy → 0.8/0.5 · 1 proxy → 0.9/0.6 · 2 proxy → 0.95/0.65
>
> Thresholds (−2% OI, 30% konsentrasi, 3 event / $50k) semua heuristik disengaja, BELUM dikalibrasi ke data riil. Lihat Section 8/11.

---

### 4.2 Top Trader Divergence — *Medium Confidence*

**Tool yang digunakan:**
- `binance_get_top_trader_ratio`
- `binance_get_long_short_ratio`

> ⚠️ **Threshold universal tidak valid — tervalidasi dengan data riil.** Baik threshold flat (>15%) maupun tiered per-liquiditas (3-15%) SAMA-SAMA gagal: pergerakan top-trader ratio riil jauh di bawah keduanya untuk semua pair yang dites (window 2 jam, 8×15m):
>
> | Pair | Range aktual |
> |------|-------------|
> | SOLUSDT | 1.02 poin |
> | BNBUSDT | 0.60 poin |
> | LINKUSDT | 0.40 poin |
> | AVAXUSDT | 2.35 poin |
>
> **Angka threshold spesifik apapun (flat atau tiered) adalah tebakan tanpa kalibrasi data — jangan dipakai apa adanya.**

**Kriteria deteksi (pendekatan relatif per-pair):**

| Pendekatan | Cara pakai |
|-----------|-----------|
| **Persentil historis** | Kalibrasi threshold dari data historis pair sendiri via `binance_get_top_trader_ratio`. **Batasan tervalidasi**: endpoint Binance ini punya retensi data ~30-31 hari MAKSIMAL (dites langsung — period=4h dan period=1d sama-sama mentok di tanggal yang sama, ~30 hari ke belakang, TIDAK PEDULI parameter `limit`). Untuk kalibrasi delta INTRADAY (15 menit), lookback realistis cuma **~5 hari** (period=15m, limit=500 = batas maksimal poin yang tersedia). Klaim "30-90 hari" di versi sebelumnya salah — 90 hari **tidak tersedia sama sekali** dari Binance untuk endpoint ini, dan 30 hari cuma tercapai di resolusi kasar (4h/1d) yang kehilangan detail intraday. |
| **Arah vs magnitude** | Untuk pair likuid (BTC, ETH, SOL, BNB), fokus pada **arah pergerakan** (top trader naik vs turun) yang berlawanan dengan harga, bukan angka absolut. Perubahan 0.5–1 poin dengan arah kontra-harga sudah cukup signifikan berdasar data di atas. |
| **Delta vs blended** | Hitung selisih absolut antara top-trader ratio dan blended ratio dari waktu ke waktu. Pelebaran/penyempitan drastis RELATIF ke histori pendek pair itu sendiri (5 hari @15m) → mismatch. |

> 💡 **Rekomendasi:** Jangan pakai threshold universal (flat atau tiered) tanpa kalibrasi data historis. Setiap pair punya karakter volatilitas ratio sendiri, dan histori yang tersedia dari Binance terbatas ~5 hari (resolusi halus) sampai ~30 hari (resolusi kasar) — bangun baseline dalam batasan itu, bukan asumsi 90 hari.

---

## 5. Sinyal Basis Arbitrage

**Prasyarat**: jalankan `binance_check_spot_listing` dulu — kalau pair futures-only, section ini tidak applicable.

### 5.1 Spot-Futures Basis Arbitrage — *Medium Confidence*

**Tool yang digunakan:**
- `binance_check_spot_listing` (prasyarat)
- `binance_get_spot_price`
- `binance_get_funding_rate`
- `binance_get_open_interest`
- `binance_get_spot_agg_trades` / `binance_get_agg_trades` (pembanding CVD spot vs futures)

**Kriteria deteksi:**

| Sinyal | Interpretasi |
|--------|-------------|
| **Basis spot-futures melebar** lalu kembali dalam waktu singkat | MM melakukan basis trade/arbitrage |
| **Funding rate positif ekstrem + OI naik** | MM mungkin short futures sambil buy spot (hedged) |
| **CVD futures dan CVD spot berlawanan arah** | Tekanan leverage vs demand riil tidak selaras |

> ⚠️ **Catatan praktis:** `binance_get_spot_price` dan `binance_get_funding_rate` cuma kasih SNAPSHOT sesaat — bukan time-series. Untuk histori, pakai `binance_get_basis_history` (D1, snapshot cron 5 menit): SELALU tersedia untuk 50-pair watchlist tetap; untuk pair lain, best-effort — histori mulai terkumpul begitu pair itu di-query ≥3x dalam ~24 jam DAN masuk top-5 pair non-watchlist paling sering di-query (lihat `src/queryFrequency.ts`). Kalau pair di luar itu, tetap manual: panggil berkali-kali dan catat sendiri basis per waktu.

---

### 5.2 Funding Rate Manipulation — *Low Confidence*

**Tool yang digunakan:**
- `binance_get_funding_rate`
- `binance_get_funding_rate_history`

**Kriteria deteksi:**

| Sinyal | Interpretasi |
|--------|-------------|
| **Funding rate flip** dari negatif ke positif ekstrem dalam 1–2 interval | MM memanfaatkan funding untuk push posisi lawan |
| **Funding rate history** menunjukkan pola repetitive di jam tertentu | MM scheduled rebalancing |

---

## 6. Workflow Deteksi Step-by-Step

```
┌─────────────────────────────────────────────────────────────┐
│  STEP 0: Cek listing spot (binance_check_spot_listing)        │
│  → Kalau futures-only, skip Step 4 (basis arb N/A)            │
├─────────────────────────────────────────────────────────────┤
│  STEP 1: Cek order book depth (snapshot tunggal), ATAU          │
│  binance_get_orderbook_delta (2-snapshot, spoofing riil)        │
│  → Ada wall tidak wajar / wall hilang tanpa harga crossing?     │
├─────────────────────────────────────────────────────────────┤
│  STEP 2: Cross-check agg trades + CVD (futures DAN spot)       │
│  → Wall-nya diabsorb atau dipull? CVD futures vs spot selaras? │
├─────────────────────────────────────────────────────────────┤
│  STEP 3: Cek OI + funding                                      │
│  → Ada perubahan TAJAM (bukan gradual) di derivative?          │
├─────────────────────────────────────────────────────────────┤
│  STEP 4: Validasi spot basis (skip kalau Step 0 = futures-only)│
│  → binance_get_basis_history (watchlist selalu, pair lain      │
│  best-effort) atau snapshot manual berkali-kali                │
├─────────────────────────────────────────────────────────────┤
│  STEP 5: Klines (wick simetris) + OI-drop proxy + konsentrasi   │
│  trade agresif per harga, TETAP TANPA data liquidation riil     │
│  (dihapus permanen, WAF-blocked)                                │
├─────────────────────────────────────────────────────────────┤
│  STEP 6: Cross-check top trader ratio                          │
│  → Arah berlawanan blended ratio? (baseline ~5-30 hari pair    │
│     sendiri, BUKAN threshold universal)                        │
├─────────────────────────────────────────────────────────────┤
│  RULE: makin banyak sinyal align, makin kuat indikasi           │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Checklist Live

- [ ] **Order book:** Wall tidak wajar di snapshot tunggal
- [ ] **CVD:** Flat/divergen dari harga (futures dan/atau spot)
- [ ] **OI:** Naik/turun TAJAM (spike, bukan gradual) tanpa harga follow
- [ ] **Spot basis:** Melebar lalu kembali (butuh listing spot, cek manual berkali-kali)
- [ ] **Klines (dulu liquidation + klines):** Wick panjang + reversal, TANPA konfirmasi liquidation (tool dihapus)
- [ ] **Top trader:** Berlawanan arah dari blended ratio, dibanding baseline pair itu sendiri

### Confidence Tier (heuristik checklist, BUKAN probabilitas statistik terkalibrasi)

| Checked | Tier | Interpretasi |
|---------|-----------|-------------|
| 0 | — | Belum ada data |
| 1–2 | Weak | Kemungkinan besar retail noise |
| 3–4 | Moderate | Mulai pantas dicurigai, tapi tetap perlu konteks (Section 10) |
| 5–6 | Strong | Indikasi kuat — tetap bukan bukti definitif |

---

## 8. Mapping Tool → Sinyal

| Tool | Sinyal yang bisa dideteksi | Batasan tervalidasi |
|------|---------------------------|---------|
| `binance_check_spot_listing` | Prasyarat Section 5 | — |
| `binance_get_order_book_depth` | Spoofing, absorption, liquidity withdrawal | Latensi 298-898ms/call, tidak bisa deteksi refresh rate real-time |
| `binance_get_order_book_imbalance` | Imbalance manipulation, price holding | Snapshot tunggal, tidak ada historis |
| `binance_get_orderbook_delta` | Spoofing riil via 2-snapshot delta (wall hilang tanpa harga crossing) | Menambah latency ~1-2 detik/call (jeda eksplisit 1500ms default antar 2 fetch) |
| `binance_get_agg_trades` | CVD divergence (futures), large trade execution | — |
| `binance_get_spot_agg_trades` | CVD riil (spot), pembanding leverage vs demand riil | — |
| `binance_get_open_interest` | Position building, post-liquidation recovery | — |
| `binance_get_taker_volume_ratio` | Limit order dominance (MM characteristic) | — |
| `binance_get_top_trader_ratio` | Smart money vs retail divergence | Pergerakan kecil (<2.5 poin/2jam bahkan pair moderate); retensi historis ~30 hari maks (4h/1d), ~5 hari di resolusi 15m; threshold Binance sendiri tidak dipublikasikan |
| `binance_get_long_short_ratio` | Retail sentiment vs price action | — |
| `binance_get_spot_price` | Basis arbitrage detection | Snapshot sesaat, tidak ada time-series basis |
| `binance_get_funding_rate` | Funding manipulation, scheduled rebalancing | — |
| `binance_get_funding_rate_history` | Funding pattern analysis | — |
| `binance_get_klines` | Wick analysis, reversal confirmation, harga mapping | — |
| `binance_detect_mm_activity` | SEMUA 6 sinyal di atas sekaligus, otomatis + skor (lihat Section 11) | Spoofing sekarang 2-snapshot riil (~1-2 detik lebih lambat). Stop-hunt simetris + OI-drop proxy + konsentrasi trade agresif per harga, TETAP tanpa data liquidation riil (dihapus permanen) |
| `binance_backtest_signal` | Validasi empiris skor `binance_detect_mm_activity` historis (win rate/avg return) | Forward return on-demand dari klines, bukan simulasi eksekusi riil; watchlist tetap 50 pair saja |

---

## 9. Kesimpulan

Framework ini **tidak membuktikan** keberadaan market maker secara definitif, melainkan menghitung **skor indikasi aktivitas MM** dari jejak yang mereka tinggalkan — bukan probabilitas terkalibrasi secara statistik.

**Kunci keberhasilan:**
1. **Jangan andalkan 1 sinyal saja** — cross-check minimal 3 tool.
2. **Perhatikan timeframe** — sinyal align dalam 5–15 menit lebih kuat daripada dalam 1 jam.
3. **Konteks pasar penting** — sinyal MM lebih valid di volume rendah/area konsolidasi.
4. **False positive ada** — news event atau whale retail bisa memicu sinyal serupa.
5. **Kalibrasi per-pair** — threshold top-trader ratio harus dibangun dari data historis pair sendiri (~5-30 hari, tergantung resolusi), bukan angka universal.
6. **Kenali batasan teknis** — latency 300-900ms/call, tidak ada data liquidation sama sekali (dihapus permanen, lihat Section 4.1; OI-drop + trade-volume-concentration proxy jadi mitigasi terbaik yang tersedia), retensi historis top-trader ratio terbatas, refresh-rate real-time sub-detik tidak feasible, WebSocket tidak tersedia. Spoofing 2-snapshot (`binance_get_orderbook_delta`) SEKARANG tersedia tapi menambah latency ~1-2 detik.

---

## 10. Validasi Empiris

Semua tervalidasi langsung ke worker deployed (`whalescope-mcp.jaringan.dev`), 2026-08-11.

**#1 — Kondisi pasar tenang (BTCUSDT, ~16:00-16:50 UTC):**

| Sinyal | Data | Trigger? |
|--------|------|----------|
| Order book wall | Depth 5/10 seimbang, depth 20 bearish tipis (34.59%) | ❌ |
| CVD vs harga | CVD +22.1 (99.9% buy), harga flat 63,523–63,525 | ✅ Trigger |
| OI naik tajam | +0.65%/2 jam, gradual bukan spike | ❌ |
| Basis spot-futures | −0.0322%, dalam batas netral | ❌ |
| Top trader vs blended | Blended naik 62.33%→62.70%, top-trader turun 61.78%→61.59% (45 menit) | ⚠️ Arah berlawanan, magnitude kecil |

Skor ~1-1.5/6 → tier Weak. **Hasil masuk akal** — BTC tenang, framework tidak over-trigger di kondisi normal.

**#2 — Latency order book:** 5x call 298/406/532/562/625ms + 2x sequential test 898/890ms → range **298-898ms**, rata-rata ~485ms. 2 snapshot berurutan total ~1,788ms — marginal, tidak reliable buat deteksi sub-detik.

**#3 — Top-trader ratio range riil (2 jam, 8×15m):** SOLUSDT 1.02 poin, BNBUSDT 0.60 poin, LINKUSDT 0.40 poin, AVAXUSDT 2.35 poin — semua jauh di bawah threshold universal manapun (flat 15% maupun tiered 3-15%).

**#4 — Retensi historis top-trader ratio:** limit=500 di period 15m/1h dapat full 500 poin (5 hari / 21 hari), tapi period 4h cuma dapat 186 poin (bukan 500) dan period 1d cuma 31 poin — keduanya mentok di tanggal yang SAMA (~30-31 hari ke belakang), konfirmasi hard retention limit dari Binance sendiri, bukan soal parameter `limit` di tool kita.

**Daftar klaim yang sudah dikoreksi dari versi awal:**

| Klaim awal | Status | Koreksi |
|-----------|--------|---------|
| Polling <500ms untuk refresh-rate spoofing | ❌ Dihapus | Latency 298-898ms, tidak reliable |
| Snapshot comparison 1-2 detik | ⚠️ Marginal | 2× call bisa 1.8s+, variasi terlalu besar |
| WebSocket fallback "jika tersedia" | ❌ Dihapus | Tidak tersedia di Binance Future Hunter (100% REST) |
| Threshold divergence >15% flat | ❌ Dihapus | Tidak pernah trigger untuk pair manapun |
| Tiered threshold 3-15% per liquiditas | ❌ Dihapus | Angka tebakan, semua pair jauh di bawah |
| "Cluster liquidation di level psikologis" | ⚠️ Direvisi | Tidak ada field harga — cross-check `klines` manual |
| Persentil historis "30-90 hari" | ⚠️ Direvisi | 90 hari tidak tersedia sama sekali dari Binance; 30 hari cuma di resolusi kasar (4h/1d), 5 hari di resolusi 15m |

---

## 11. Automated Scoring — `binance_detect_mm_activity`

Section 1-8 di atas adalah workflow MANUAL (gabungin 5-6 tool call sendiri,
baca tabel, hitung berapa sinyal align). `binance_detect_mm_activity`
(dirilis 2026-08-12) otomasi PERSIS workflow itu jadi 1 tool call: fetch
6 sumber data lewat `Promise.all`, hitung skor tiap sinyal (0-1), jumlahin
jadi total 0-6, klasifikasi tier.

**PENTING — ini SISTEM SKOR BEDA dari checklist Section 7**, jangan
disamain:

| | Section 7 (manual) | Section 11 (`binance_detect_mm_activity`) |
|---|---|---|
| Granularitas | Checklist ya/tidak (0-6 diskrit) | Skor kontinu tiap sinyal (0-1) |
| Jumlah sinyal | 6 (order book, CVD, OI, basis, liquidation+klines, top trader) | 6 tapi BEDA komposisi (lihat mapping di bawah) |
| Tier | Weak(1-2)/Moderate(3-4)/Strong(5-6) | Weak(<2)/Moderate(<3.5)/Strong(<5)/Extreme(≥5) |
| Liquidation | Section 4.1 — **dihapus permanen**, tool `binance_get_liquidation_history` sudah tidak ada | TIDAK dipakai — stop-hunt dari `klines` (wick simetris) + OI-drop proxy + trade-volume-concentration proxy (lihat batasan di bawah) |

### Mapping sinyal otomatis → section manual

| Sinyal (`src/tools/detectMmActivity.ts`) | Section terkait | Formula ringkas | Confidence |
|---|---|---|---|
| `absorption` | 2.1 Order Book Absorption | CVD buy% dominan (>60%) + harga flat (\|Δ\|<0.5%) + OI naik tajam (>3%) → skor 0.7-1.0. CVD buy% (>55%) + harga turun → 0.5 (lemah). Selain itu → 0.1 | **Medium** — pakai CVD+OI+harga (data resmi Binance), TAPI cuma window 1 snapshot klines, bukan cross-check spot CVD kayak Section 2.1 manual |
| `spoofing` | 3.1 Wall Pull / Spoofing | 2 snapshot order book ~1.5 detik terpisah (`binance_get_orderbook_delta` internal). Wall (qty ≥2x median) yang hilang/menyusut >70% TANPA sisi lawan crossing harga level itu → 0.9 (wall TERBESAR yang spoofed) atau 0.5 (wall sekunder). Selain itu → 0.1 | **High** (wall terbesar spoofed) / **Medium** (wall sekunder) — sekarang 2-snapshot RIIL, bukan proxy 1-snapshot lagi (lihat Section 3.1/3.2, `src/tools/orderbookDelta.ts`) |
| `stopHunt` | 4.1 Liquidation Cluster Reversal (dihapus permanen) | Wick simetris (upper=hunt of longs ATAU lower=hunt of shorts, dulu cuma upper — bug) >70% dari range + body <20% + reversal searah wick → 0.8, +0.05/proxy aktif (OI-drop ≥2% dan/atau konsentrasi trade agresif ≥30% di zona wick) → 0.9 (1 proxy) / 0.95 (2 proxy). Wick >60% doang → 0.5, sama pola +proxy → 0.6/0.65. Selain itu → 0.1 | **Low-Medium** — dari `klines` (wick simetris) + 2 proxy independen (REUSE fetch OI history & aggTrades yang sudah ada, TANPA panggilan baru), TETAP TANPA konfirmasi liquidation-by-price riil (dihapus permanen, lihat Section 4.1) |
| `basisArb` | 5.1 Spot-Futures Basis Arbitrage | Kalau symbol ada histori D1 (50 pair watchlist tetap): z-score basis >2 std dev + funding >0.05% → 0.9. Tanpa histori: basis >2x threshold → 0.7 (kurang akurat, dicatat di evidence), >threshold → 0.5. Selain itu → 0.1 | **Medium-High** untuk 50 pair watchlist (ada konteks histori D1 24 jam), **Medium** untuk pair lain (threshold statis, gak ada konteks distribusi) |
| `oiDivergence` | 2.1 (OI naik tajam) + 6.STEP3 | OI naik >5% + harga flat (\|Δ\|<1%) → 0.8. OI naik >3% berlawanan arah harga → 0.7. Selain itu → 0.1 | **Medium** — data OI resmi Binance, tapi window cuma 1 jam (2 titik data), bukan histori panjang |
| `fundingExtreme` | 5.2 Funding Rate Manipulation | Funding >3x threshold → 1.0, >2x → 0.8, >threshold → 0.6, di bawah → skala proporsional | **High** — funding rate langsung dari Binance (`premiumIndex`), paling reliable dari 6 sinyal ini |

**Threshold default**: funding ±0.03% (0.0003), basis ±0.05% (0.0005) —
sama persis dengan default `binance_get_funding_rate`/`binance_get_spot_price`,
bisa di-override per-pair lewat `binance_set_pair_threshold` (Workers KV,
dipakai otomatis oleh `binance_detect_mm_activity` juga).

**Yang TIDAK diikutkan dari framework manual**: top-trader divergence
(Section 4.2) dan taker volume divergence (Section 2.2) TIDAK jadi sinyal
terpisah di versi otomatis ini — di luar scope 6-sinyal awal
(`whalescope_mcp_roadmap.md` Appendix A). Follow-up yang masuk akal kalau
mau nambah presisi skor.

### Validasi empiris — lewat `binance_backtest_signal`, bukan lagi manual

Section 10 di atas (Validasi Empiris) dilakuin manual sebelum
`binance_detect_mm_activity` ada — cocokin sinyal-per-sinyal ke kondisi
pasar riil, sekali jalan. Sekarang, tiap 5 menit Cron Trigger snapshot ke-6
skor di atas ke D1 (`signal_history`, watchlist 50 pair tetap) TANPA perlu
dites manual lagi — `binance_backtest_signal` query histori itu, hitung
forward return N jam setelah tiap sinyal aktif (skor ≥0.6) trigger, agregat
win rate/avg return/max drawdown. Ini validasi EMPIRIS BERKELANJUTAN,
bukan snapshot satu kali kayak Section 10 — tapi baru mulai ngumpulin data
dari tanggal deploy (2026-08-12), belum retroaktif, dan sample size kecil
di awal berarti confidence rendah (lihat catatan di README "Keterbatasan
yang jujur perlu diketahui").

---

## 12. Smart Money Divergence Score — `binance_analyze_smart_money`

Tool KEDUA yang mengotomatisasi bagian dari framework ini jadi skor
terstruktur (di samping `binance_detect_mm_activity` di Section 11) --
tapi fokusnya SEMPIT dan BEDA: bukan 6 sinyal absorption/spoofing/
stop-hunt/basis-arb/OI-divergence/funding-extreme, melainkan spesifik
Section 4.2 (Top Trader Divergence) diperluas dengan OI delta, funding
rate, dan orderbook imbalance sebagai konteks pendukung.

**PENTING -- perbedaan dengan Section 4.2:** Section 4.2 secara eksplisit
menyimpulkan threshold absolut pada top-trader ratio TIDAK VALID tanpa
kalibrasi per-pair (pergerakan riil 0.4-2.35 poin/2 jam, jauh di bawah
threshold universal manapun yang pernah dicoba). `binance_analyze_smart_money`
tetap pakai threshold fixed (`topTraderPositionRatio > 1.4`, `> 1.2`, `< 0.95`;
`globalAccountRatio > 1.8`, `< 0.8`; `fundingRate < -0.03%`) sesuai
spesifikasi eksplisit tool ini -- BUKAN klaim baru bahwa threshold absolut
sudah tervalidasi. `confidenceScore` output tool ini mengkompensasi dengan
mengukur margin di atas threshold + sinyal pendukung searah (funding,
orderbook), bukan probabilitas statistik. Untuk keputusan berisiko tinggi,
tetap cross-check dengan pendekatan relatif Section 4.2 (persentil historis
pair itu sendiri) atau `binance_detect_mm_activity` (Section 11, sinyal
berbeda, konfirmasi silang lebih kuat daripada mengandalkan satu tool saja).

**4 kondisi yang dideteksi** (prioritas kalau overlap: liquidation risk >
accumulation > squeeze):

| Kondisi | Kriteria |
|---|---|
| `LONG_LIQUIDATION_RISK` | Global account ratio > 1.8, top trader ratio < 0.95, OI naik |
| `BULLISH_ACCUMULATION` | Top trader ratio > 1.4, global account ratio < 0.8, OI naik |
| `SHORT_SQUEEZE_RISK` | Funding rate < -0.03%, top trader ratio > 1.2, harga tidak bullish |
| `NEUTRAL` | Tidak ada kombinasi di atas yang match |

Lihat `src/smartMoneyAnalysis.ts` untuk formula skor lengkap.

---

*Dibuat pada: 2026-08-11*
*Versi 4.0 (final) — semua klaim teknis divalidasi langsung ke data live Binance Future Hunter (dulu whalescope-mcp), termasuk latency, batas historis endpoint, dan realita pergerakan top-trader ratio lintas pair.*
*Section 11 ditambahkan 2026-08-12: dokumentasi `binance_detect_mm_activity` (automated scoring) + `binance_backtest_signal` (validasi empiris berkelanjutan).*
*Section 12 ditambahkan 2026-08-15: dokumentasi `binance_analyze_smart_money` (Smart Money Divergence Score).*
