# Market Maker Detection Framework

🇮🇩 Bahasa Indonesia | [🇬🇧 English](mm_detection_framework.en.md)

> Framework deteksi aktivitas market maker (MM) menggunakan tool WhaleScope MCP (Binance Futures + Spot).
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

### 3.2 Order Book Refresh Rate Anomaly — *Low Confidence*

**Tool yang digunakan:**
- `binance_get_order_book_depth`

> ⚠️ **Batasan teknis (tervalidasi):**
> - Latensi per call bervariasi besar: **298–898ms** (rata-rata ~485ms) lewat proxy chain worker→Vercel→Binance.
> - 2× call berurutan total **~1,788ms** — di ujung batas "1-2 detik", bisa lebih lama saat network buruk.
> - **Polling berurutan untuk deteksi "refresh rate" tidak reliable** — variasi latency terlalu besar untuk membedakan perubahan pasar vs noise jaringan.

**Kriteria deteksi (hanya snapshot tunggal):**

| Sinyal | Interpretasi |
|--------|-------------|
| **Anomali di snapshot tunggal**: wall muncul di level yang tidak wajar (jauh dari mid-price) dengan volume tidak proporsional | Kemungkinan spoofing — butuh konfirmasi dari sinyal lain (CVD, OI) |

> 💡 **Rekomendasi:** Jangan pakai deteksi berbasis perbandingan snapshot berurutan lewat tool call MCP biasa. Fokus pada analisis snapshot tunggal + konfirmasi silang dengan tool lain.

> ❌ **WebSocket: TIDAK TERSEDIA** di WhaleScope MCP. Semua 22 tool berbasis REST request/response diskrit. Deteksi real-time butuh stack terpisah di luar project ini.

---

## 4. Sinyal Stop Hunt

### 4.1 Liquidation Cluster (Waktu) Reversal — *High Confidence*

**Tool yang digunakan:**
- `binance_get_liquidation_history`
- `binance_get_open_interest`
- `binance_get_klines`

> ⚠️ **Batasan data:** `binance_get_liquidation_history` mengembalikan `{symbol, totalLong, totalShort, dominance}` per time-bucket, **tanpa field harga sama sekali**. Tidak bisa langsung memetakan "cluster di level psikologis".

**Kriteria deteksi:**

| Sinyal | Tool | Interpretasi |
|--------|------|-------------|
| **Spike liquidation** (totalLong/totalShort melonjak dibanding window sebelumnya) | `liquidation_history` | Ada force-closure massal di satu sisi |
| **Wick panjang** di candlestick pada timeframe yang sama | `klines` | Harga sempat disentuh lalu reverse — mapping manual ke area liquidation |
| **OI turun tajam** pasca liquidation spike | `open_interest` | MM ambil posisi lawan setelah hunt |
| **Harga reverse** dalam 1–3 candle setelah wick | `klines` | Konfirmasi stop hunt berhasil |

> **Workflow mapping harga:** Gunakan `klines` untuk identifikasi wick/extreme price pada waktu yang sama dengan liquidation spike — cross-reference MANUAL, tidak otomatis karena liquidation history tidak mengandung field harga.

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

> ⚠️ **Catatan praktis:** `binance_get_spot_price` dan `binance_get_funding_rate` cuma kasih SNAPSHOT sesaat — TIDAK ADA tool histori basis time-series. Deteksi "basis melebar lalu kembali" harus manual: panggil berkali-kali dan catat sendiri basis per waktu.

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
│  STEP 1: Cek order book depth (snapshot tunggal)               │
│  → Ada wall tidak wajar?                                       │
├─────────────────────────────────────────────────────────────┤
│  STEP 2: Cross-check agg trades + CVD (futures DAN spot)       │
│  → Wall-nya diabsorb atau dipull? CVD futures vs spot selaras? │
├─────────────────────────────────────────────────────────────┤
│  STEP 3: Cek OI + funding                                      │
│  → Ada perubahan TAJAM (bukan gradual) di derivative?          │
├─────────────────────────────────────────────────────────────┤
│  STEP 4: Validasi spot basis (skip kalau Step 0 = futures-only)│
│  → Ada aktivitas arbitrage? (snapshot manual berkali-kali)     │
├─────────────────────────────────────────────────────────────┤
│  STEP 5: Cek liquidation history + klines                      │
│  → Spike liquidation align dengan wick panjang di waktu sama?  │
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
- [ ] **Liquidation + klines:** Spike liquidation align dengan wick panjang
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
| `binance_get_agg_trades` | CVD divergence (futures), large trade execution | — |
| `binance_get_spot_agg_trades` | CVD riil (spot), pembanding leverage vs demand riil | — |
| `binance_get_open_interest` | Position building, post-liquidation recovery | — |
| `binance_get_taker_volume_ratio` | Limit order dominance (MM characteristic) | — |
| `binance_get_liquidation_history` | Liquidation spike per WAKTU | Tanpa field harga — perlu cross-check `klines` manual |
| `binance_get_top_trader_ratio` | Smart money vs retail divergence | Pergerakan kecil (<2.5 poin/2jam bahkan pair moderate); retensi historis ~30 hari maks (4h/1d), ~5 hari di resolusi 15m; threshold Binance sendiri tidak dipublikasikan |
| `binance_get_long_short_ratio` | Retail sentiment vs price action | — |
| `binance_get_spot_price` | Basis arbitrage detection | Snapshot sesaat, tidak ada time-series basis |
| `binance_get_funding_rate` | Funding manipulation, scheduled rebalancing | — |
| `binance_get_funding_rate_history` | Funding pattern analysis | — |
| `binance_get_klines` | Wick analysis, reversal confirmation, harga mapping | — |

---

## 9. Kesimpulan

Framework ini **tidak membuktikan** keberadaan market maker secara definitif, melainkan menghitung **skor indikasi aktivitas MM** dari jejak yang mereka tinggalkan — bukan probabilitas terkalibrasi secara statistik.

**Kunci keberhasilan:**
1. **Jangan andalkan 1 sinyal saja** — cross-check minimal 3 tool.
2. **Perhatikan timeframe** — sinyal align dalam 5–15 menit lebih kuat daripada dalam 1 jam.
3. **Konteks pasar penting** — sinyal MM lebih valid di volume rendah/area konsolidasi.
4. **False positive ada** — news event atau whale retail bisa memicu sinyal serupa.
5. **Kalibrasi per-pair** — threshold top-trader ratio harus dibangun dari data historis pair sendiri (~5-30 hari, tergantung resolusi), bukan angka universal.
6. **Kenali batasan teknis** — latency 300-900ms/call, liquidation tanpa harga, retensi historis top-trader ratio terbatas, refresh-rate real-time tidak feasible via REST tool call, WebSocket tidak tersedia.

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
| WebSocket fallback "jika tersedia" | ❌ Dihapus | Tidak tersedia di WhaleScope MCP (100% REST) |
| Threshold divergence >15% flat | ❌ Dihapus | Tidak pernah trigger untuk pair manapun |
| Tiered threshold 3-15% per liquiditas | ❌ Dihapus | Angka tebakan, semua pair jauh di bawah |
| "Cluster liquidation di level psikologis" | ⚠️ Direvisi | Tidak ada field harga — cross-check `klines` manual |
| Persentil historis "30-90 hari" | ⚠️ Direvisi | 90 hari tidak tersedia sama sekali dari Binance; 30 hari cuma di resolusi kasar (4h/1d), 5 hari di resolusi 15m |

---

*Dibuat pada: 2026-08-11*
*Versi 4.0 (final) — semua klaim teknis divalidasi langsung ke data live WhaleScope MCP, termasuk latency, batas historis endpoint, dan realita pergerakan top-trader ratio lintas pair.*
