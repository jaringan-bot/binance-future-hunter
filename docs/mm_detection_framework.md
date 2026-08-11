# Market Maker Detection Framework

> Framework deteksi aktivitas market maker (MM) menggunakan tool WhaleScope MCP (Binance Futures + Spot).
> **Catatan penting:** Tidak ada tool yang bisa melihat identitas atau posisi spesifik MM secara langsung. Framework ini membangun profil aktivitas MM dari jejak yang mereka tinggalkan di pasar.
>
> **Divalidasi dengan data riil** pada 2026-08-11 (lihat [Section 10](#10-validasi-empiris)) — beberapa klaim di versi awal direvisi setelah dicek langsung ke tool.

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
9. [Kesimpulan](#9-kesimpulan)
10. [Validasi Empiris](#10-validasi-empiris)

---

## 1. Prinsip Dasar

| Kemampuan | Bisa / Tidak |
|-----------|-------------|
| Melihat *identitas* MM | ❌ Tidak |
| Melihat *posisi spesifik* MM | ❌ Tidak |
| Mendeteksi **jejak aktivitas** MM (absorption, spoofing, stop hunt, basis arb) | ✅ Bisa, dengan menggabungkan 3–4 tool |

**Rule of thumb (heuristik, BUKAN probabilitas terkalibrasi):** Semakin banyak sinyal align dalam timeframe yang sama, semakin kuat indikasi aktivitas MM. Lihat tier di [Section 7](#7-checklist-live) — angka "%" di sana adalah `jumlah-checklist / total-checklist`, bukan hasil backtest statistik. Perlakukan sebagai bobot checklist, bukan angka probabilitas sungguhan.

**Step 0 — cek listing sebelum mulai:** Kalau mau pakai Section 5 (basis arbitrage), panggil `binance_check_spot_listing` dulu. Banyak pair Futures (terutama koin baru/kecil) TIDAK listed di Binance Spot sama sekali (contoh nyata: VELVETUSDT) — Section 5 otomatis tidak applicable untuk pair semacam itu, bukan berarti sinyalnya "tidak terdeteksi".

---

## 2. Sinyal Absorption

### 2.1 Order Book Absorption — *High Confidence*

**Tool yang digunakan:**
- `binance_get_order_book_depth`
- `binance_get_agg_trades`
- `binance_get_open_interest`
- `binance_get_spot_agg_trades` (pembanding CVD riil, lihat catatan di bawah)

**Kriteria deteksi:**

| Sinyal | Interpretasi |
|--------|-------------|
| **CVD flat/naik** tapi harga stagnan | MM sedang absorb sell pressure (accumulation) |
| **CVD turun drastis** tapi harga tidak jeblok | MM sedang absorb buy pressure (distribution) |
| **OI naik TAJAM (spike)** + harga sideways | MM buka posisi besar (kemungkinan hedging). Kenaikan OI yang gradual/smooth SELAMA BEBERAPA JAM (misal <1%/jam) BUKAN sinyal ini — itu normal market growth, bukan tanda MM |
| **Trade besar** di bid/ask tanpa slippage signifikan | Eksekusi MM dengan liquidity yang sudah disiapkan |
| **CVD futures dan CVD spot berlawanan arah** untuk pair yang sama (`binance_get_agg_trades` vs `binance_get_spot_agg_trades`) | Absorpsi terjadi spesifik di sisi futures (leverage) — bukan demand/supply riil di spot |

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

---

### 3.2 Order Book Refresh Rate Anomaly — *Low Confidence, TIDAK PRAKTIS via tool call biasa*

**Tool yang digunakan:**
- `binance_get_order_book_depth`

**Kriteria deteksi:**

| Sinyal | Interpretasi |
|--------|-------------|
| **Perubahan depth level 1–5 terlalu cepat** tanpa eksekusi yang signifikan | MM sedang re-quote |

> ⚠️ **Koreksi (2026-08-11):** Versi awal dokumen ini menyarankan "polling interval <500ms". Diukur langsung: satu kali panggilan `binance_get_order_book_depth` lewat worker (yang relay ke proxy Vercel ke Binance) makan waktu **299–625ms per call** (rata-rata 485ms dari 5x test). Polling <500ms **secara fisik tidak mungkin** lewat jalur MCP request/response biasa — setiap panggilan tool adalah satu request diskrit dari LLM, bukan stream/loop otomatis. Kalau deteksi ini benar-benar dibutuhkan, harus pakai orkestrasi EKSTERNAL di luar percakapan Claude (script terpisah yang polling langsung, bukan lewat tool call MCP satu-satu). Anggap sinyal ini **tidak actionable** dalam workflow normal Claude+MCP ini.

---

## 4. Sinyal Stop Hunt

### 4.1 Liquidation Cluster (Waktu) Reversal — *High Confidence*

**Tool yang digunakan:**
- `binance_get_liquidation_history`
- `binance_get_open_interest`
- `binance_get_klines`

**Kriteria deteksi:**

| Sinyal | Interpretasi |
|--------|-------------|
| **Cluster liquidation di WINDOW WAKTU tertentu** (misal 1-2 candle) lalu harga *reverse* | Kemungkinan stop hunt oleh MM |
| **OI turun tajam** pasca liquidation tapi harga recover | MM ambil posisi lawan |
| **Wick panjang** di candlestick + liquidation spike di window waktu yang sama | Classic stop hunt signature |

> ⚠️ **Koreksi (2026-08-11):** Versi awal menyebut "cluster liquidation **di level psikologis**". Dicek langsung ke `binance_get_liquidation_history` (sumber Coinalyze): response CUMA punya `symbol`, `totalLong`, `totalShort`, `dominance` per time-bucket — **TIDAK ADA field harga sama sekali**. Tool ini tidak bisa bilang liquidation itu terjadi di harga berapa, cuma total value per periode waktu (5m/15m/1h/dst). Untuk cross-check level harga, gabungkan manual dengan `binance_get_klines` di window waktu yang sama (lihat wick candle di jam itu) — tapi itu inferensi dari candle, bukan data liquidation per-harga yang eksplisit.

---

### 4.2 Top Trader Divergence — *Medium Confidence*

**Tool yang digunakan:**
- `binance_get_top_trader_ratio`
- `binance_get_long_short_ratio`

**Kriteria deteksi:**

| Sinyal | Interpretasi |
|--------|-------------|
| **Top trader short** tapi harga naik, atau *top trader long* tapi harga turun | MM (yang masuk kategori top trader) mungkin berlawanan arah dengan retail |
| **Blended ratio vs top trader ratio bergerak berlawanan arah**, magnitude signifikan RELATIF terhadap rentang normal pair itu | Smart money vs retail mismatch |

> ⚠️ **Koreksi (2026-08-11):** Versi awal pakai threshold fix "divergen >15%". Divalidasi ke BTCUSDT live: dalam window 45 menit, blended ratio naik 62.33%→62.70% sementara top-trader (position) turun 61.78%→61.59% — **arah berlawanan** (sinyal kualitatif valid) tapi magnitude cuma ~0.3-0.5 poin persentase, JAUH di bawah 15%. Pair likuid (BTC/ETH/dst) punya rasio yang bergerak dalam rentang sempit (~55-65%) secara normal — threshold 15% kemungkinan cuma pernah tercapai di pair kecil/volatil, bukan di major pair. **Jangan pakai angka 15% sebagai threshold universal** — bandingkan magnitude pergerakan terhadap rentang historis pair itu sendiri (misal: apakah pergerakan ini beberapa kali lipat dari pergerakan normal per-15-menit pair tersebut), bukan angka absolut fix.
>
> Ingat juga: threshold "top trader" itu sendiri **tidak dipublikasikan Binance** secara pasti dan datanya snapshot periodik (bukan tick-by-tick) — treat sebagai proxy kasar, bukan data pasti siapa "smart money".

---

## 5. Sinyal Basis Arbitrage

**Prasyarat**: jalankan `binance_check_spot_listing` dulu — kalau pair futures-only (tidak listed di Spot), section ini tidak applicable sama sekali.

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
| **CVD futures dan CVD spot berlawanan arah** (futures buy-dominant, spot sell-dominant, atau sebaliknya) | Tekanan leverage vs demand riil tidak selaras — indikasi arbitrage/hedging pressure |

> ⚠️ **Catatan praktis:** `binance_get_spot_price` (dan `binance_get_funding_rate`) cuma kasih SNAPSHOT sesaat — TIDAK ADA tool histori basis time-series di WhaleScope MCP. Untuk deteksi "basis melebar lalu kembali", harus panggil tool ini berkali-kali secara manual dan catat sendiri basis-nya per waktu (tidak otomatis tersedia sebagai satu tool call).

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
│  STEP 0: Cek listing spot (binance_check_spot_listing)       │
│  → Kalau futures-only, skip Step 4 (basis arb N/A)           │
├─────────────────────────────────────────────────────────────┤
│  STEP 1: Cek order book depth                                │
│  → Ada wall tidak wajar?                                     │
├─────────────────────────────────────────────────────────────┤
│  STEP 2: Cross-check agg trades + CVD (futures DAN spot)     │
│  → Wall-nya diabsorb atau dipull? CVD futures vs spot selaras?│
├─────────────────────────────────────────────────────────────┤
│  STEP 3: Cek OI + funding                                    │
│  → Ada perubahan TAJAM (bukan gradual) di derivative?        │
├─────────────────────────────────────────────────────────────┤
│  STEP 4: Validasi spot basis (skip kalau Step 0 = futures-only)│
│  → Ada aktivitas arbitrage? (perlu snapshot berkali-kali manual)│
├─────────────────────────────────────────────────────────────┤
│  STEP 5: Cek liquidation history                             │
│  → Ada cluster di WINDOW WAKTU tertentu (bukan level harga)? │
├─────────────────────────────────────────────────────────────┤
│  STEP 6: Cross-check top trader ratio                        │
│  → Smart money vs retail mismatch, RELATIF ke rentang normal │
│     pair itu (bukan threshold absolut 15%)?                  │
├─────────────────────────────────────────────────────────────┤
│  RULE: makin banyak sinyal align, makin kuat indikasi —       │
│  lihat tier heuristik di Section 7, bukan angka probabilitas │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Checklist Live

Gunakan checklist ini saat analisis real-time. Centang setiap item yang terdeteksi:

- [ ] **Order book:** Walls besar terdeteksi
- [ ] **CVD:** Flat/divergen dari harga (futures dan/atau spot)
- [ ] **OI:** Naik/turun TAJAM (spike, bukan gradual) tanpa harga follow
- [ ] **Spot basis:** Melebar lalu kembali (butuh listing spot, cek manual berkali-kali)
- [ ] **Liquidation:** Cluster di WINDOW WAKTU tertentu (bukan level harga spesifik)
- [ ] **Top trader:** Bergerak berlawanan arah dari blended ratio, magnitude signifikan relatif ke rentang normal pair itu

### Confidence Tier (heuristik checklist, BUKAN probabilitas statistik)

| Checked | Tier | Interpretasi |
|---------|-----------|-------------|
| 0 | — | Belum ada data |
| 1–2 | Weak | Kemungkinan besar retail noise, jangan diambil kesimpulan |
| 3–4 | Moderate | Mulai pantas dicurigai sebagai aktivitas MM, tapi masih perlu konteks (lihat Section 9) |
| 5–6 | Strong | Indikasi kuat, tapi tetap bukan bukti — MM detection dari public data selalu bersifat inferensial |

*(Angka checked/6 SENGAJA tidak ditampilkan sebagai persen — versi awal dokumen menampilkan ini sebagai "probabilitas %" yang menyiratkan kalibrasi statistik yang sebenarnya tidak ada di balik angka ini.)*

---

## 8. Mapping Tool → Sinyal

| Tool | Sinyal yang bisa dideteksi |
|------|---------------------------|
| `binance_check_spot_listing` | Prasyarat Section 5 — validasi pair punya leg spot atau tidak |
| `binance_get_order_book_depth` | Spoofing, absorption, liquidity withdrawal |
| `binance_get_order_book_imbalance` | Imbalance manipulation, price holding |
| `binance_get_agg_trades` | CVD divergence (futures), large trade execution |
| `binance_get_spot_agg_trades` | CVD riil (spot) — pembanding futures untuk deteksi leverage-driven vs demand riil |
| `binance_get_open_interest` | Position building, post-liquidation recovery |
| `binance_get_taker_volume_ratio` | Limit order dominance (MM characteristic) |
| `binance_get_liquidation_history` | Stop hunt cluster (per WAKTU, bukan per harga) |
| `binance_get_top_trader_ratio` | Smart money vs retail divergence (proxy kasar, threshold Binance tidak dipublikasikan) |
| `binance_get_long_short_ratio` | Retail sentiment vs price action |
| `binance_get_spot_price` | Basis arbitrage detection (snapshot sesaat, bukan time-series) |
| `binance_get_funding_rate` | Funding manipulation, scheduled rebalancing |
| `binance_get_funding_rate_history` | Funding pattern analysis |
| `binance_get_klines` | Wick analysis, reversal confirmation |

---

## 9. Kesimpulan

Framework ini **tidak membuktikan** keberadaan market maker secara definitif, melainkan menghitung **skor indikasi aktivitas MM** berdasarkan jejak yang mereka tinggalkan di pasar — bukan probabilitas terkalibrasi secara statistik.

**Kunci keberhasilan:**
1. **Jangan andalkan 1 sinyal saja** — selalu cross-check minimal 3 tool.
2. **Perhatikan timeframe** — sinyal yang align dalam 5–15 menit lebih kuat daripada dalam 1 jam.
3. **Konteks pasar penting** — sinyal MM lebih valid di saat volume rendah atau di area konsolidasi.
4. **False positive ada** — news event atau whale retail juga bisa memicu sinyal serupa.
5. **Bandingkan magnitude relatif ke pair itu sendiri**, bukan threshold absolut fix — pair likuid (BTC/ETH) dan pair kecil punya rentang pergerakan normal yang sangat berbeda.
6. **Section 3.2 (refresh rate anomaly) tidak actionable** lewat tool call MCP biasa — latency network round-trip (~300-625ms per call) lebih lambat dari interval yang dibutuhkan.

---

## 10. Validasi Empiris

Dicek langsung ke worker deployed (`whalescope-mcp.jaringan.dev`) pada 2026-08-11, pair BTCUSDT, window ~16:00-16:50 UTC:

| Sinyal | Data aktual | Trigger? |
|---|---|---|
| Order book wall | Depth 5/10 SEIMBANG, depth 20 bearish tipis (34.59%) | ❌ Tidak ada wall jelas |
| CVD vs harga | CVD futures +22.1 (99.9% buy) dalam window singkat, harga flat 63,523-63,525 | ✅ Trigger — cocok pola absorption |
| OI naik tajam | +0.65% dalam 2 jam, gradual (BUKAN spike) | ❌ Tidak memenuhi kriteria "tajam" |
| Basis spot-futures | -0.0322%, dalam batas netral (<0.05%) | ❌ Tidak melebar |
| Top trader vs blended | Blended naik 62.33%→62.70%, top-trader turun 61.78%→61.59% dalam 45 menit yang sama | ⚠️ Arah berlawanan tapi magnitude ~0.3-0.5 poin, jauh di bawah threshold lama (15%) |

**Skor**: ~1-1.5 dari 6 → tier **Weak**, sesuai kondisi pasar BTC yang tenang saat itu (bukan false-positive). Ini konfirmasi framework tidak over-trigger di kondisi normal — poin metodologi yang baik. Latency `binance_get_order_book_depth` diukur 5x: 299/406/532/562/625ms (rata-rata 485ms) — dasar untuk koreksi Section 3.2.

---

*Dibuat pada: 2026-08-11*
*Direvisi pada: 2026-08-11 setelah validasi data langsung ke WhaleScope MCP (worker deployed + latency test).*
*Framework ini dirancang untuk bekerja dengan tool WhaleScope MCP (Binance Futures + Spot).*
