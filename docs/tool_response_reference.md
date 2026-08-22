# Referensi Response Tool: `detail` & Output Composite Ringkas

Dokumen ini menjelaskan dua perubahan konvensi response tool (2026-08) yang
dibuat murni untuk hemat token, TANPA mengurangi data yang bisa diakses:

1. Parameter `detail: "summary" | "full"` di semua tool array/history-shaped.
2. Struktur `structuredContent` yang lebih ringkas & flat di 5 tool composite.

Tidak ada nama parameter Zod yang dihapus/diganti nama di perubahan ini —
semua penambahan bersifat opsional dengan default baru. Ini **satu-satunya**
perubahan default-behavior yang disengaja: caller lama yang tidak mengirim
`detail` sekarang dapat response yang lebih ringkas (bukan array penuh) dari
sebelumnya.

## 1. Parameter `detail`

Ditambahkan (opsional, default `"summary"`) ke semua tool yang sebelumnya
(atau berpotensi) mengembalikan array candle/trade/level/histori panjang:

| Tool | `summary` (default) | `full` |
|---|---|---|
| `binance_get_klines` / `binance_get_spot_klines` | ringkasan (bias, swing high/low, last) + 5 candle terakhir | array candle penuh (sama seperti `includeCandles: true`, param lama tetap ada) |
| `binance_get_mark_price_klines`, `_index_price_klines`, `_premium_index_klines`, `_continuous_klines` | ringkasan + 5 candle terakhir | array candle penuh |
| `binance_get_quarterly_settlement_price` | 10 settlement terakhir | semua settlement |
| `binance_get_agg_trades` / `binance_get_spot_agg_trades` | CVD + ringkasan (trade mentah TIDAK disertakan) | array trade mentah penuh |
| `binance_get_taker_volume_ratio` | rasio terkini + <=10 poin terbaru | semua poin sesuai `limit` |
| `binance_get_order_book_depth` / `binance_get_spot_order_book` | best bid/ask + spread (level mentah TIDAK disertakan) | array bids/asks penuh sesuai `limit` |
| `binance_get_open_interest_history` | tren + <=10 poin terbaru | semua poin sesuai `limit` |
| `binance_get_funding_rate_history` | rata-rata + tren + <=10 poin terbaru | semua poin sesuai `limit` |
| `binance_get_basis_history` | current/avg/range + <=10 snapshot terbaru | semua snapshot dalam window `hours` |
| `binance_get_long_short_ratio` / `binance_get_top_trader_ratio` | snapshot + tren + <=10 poin terbaru | semua poin sesuai `limit` |

Field markdown (teks tabel) tetap dipotong ke 10-15 baris terakhir di kedua
mode — `detail: "full"` hanya mempengaruhi `structuredContent`, bukan
panjang tabel teks (supaya teks tetap terbaca manusia untuk `limit` besar).

**Kenapa bukan cuma `limit` kecil saja?** `limit` mengontrol berapa banyak
data yang di-*fetch* dari Binance (dipakai penuh untuk hitung
rata-rata/tren), sedangkan `detail` mengontrol berapa banyak dari data yang
sudah di-fetch itu yang ikut dikirim balik ke Claude. Keduanya independen:
`limit: 500, detail: "summary"` tetap menghitung tren dari 500 titik, tapi
cuma balikin ringkasan + 10 poin terakhir.

## 2. Output Composite Ringkas (§B/§D)

5 tool composite (`binance_analyze_pair`, `binance_analyze_smart_money`,
`binance_detect_mm_activity`, `analyze_futures_grid_risk`,
`whalescope_full_pipeline`) dirapikan:

- **Markdown teks** dipotong ke sekitar 8-12 baris, reasoning/evidence
  dibatasi ke sinyal yang aktif/relevan saja (maks ~6 bullet) — bukan lagi
  subheader + tabel + evidence penuh per sinyal/symbol.
- **`structuredContent`** jadi field pembawa utama: key lebih pendek & flat,
  field null/undefined dibuang (`dropNulls()`, `src/shared.ts`), field
  keputusan (`status`, `decision`, `tier`, `condition`) dipromosikan ke
  top-level.
- **Tidak ada sinyal/metrik yang dihapus** — semua angka yang sebelumnya
  dinarasikan panjang di teks sekarang tetap ada di `structuredContent`,
  cuma tidak lagi ditulis ulang sebagai paragraf.

### Mapping field yang berubah nama

Kalau kode kamu mem-parsing `structuredContent` tool-tool ini secara
terprogram (bukan cuma baca teks), berikut field yang berganti nama:

**`binance_analyze_pair`**

| Lama | Baru |
|---|---|
| `fundingRate` | `funding` |
| `oiChangePct` | `oiChg` |
| `topTraderLatest` | `ttPct` |
| `topTraderTrend` | `ttTrend` |
| `takerLatest` | `takerRatio` |
| `changePct` | `chg` |
| `swingHigh` / `swingLow` / `lastClose` | `high` / `low` / `last` |

**`binance_analyze_smart_money`**

| Lama | Baru |
|---|---|
| `smartMoneyBias` | `smBias` |
| `retailSentiment` | `retail` |
| `confidenceScore` | `confidence` |
| `divergenceScore` | `divScore` |
| `divergenceAnalysis` | `reason` |
| `signals` (7 raw variable) | `raw` |

**`analyze_futures_grid_risk`** — `metrics`/`market`/`context`/`anomalies`
tetap sama strukturnya (tidak di-rename, cuma `context`/`anomalies`
sekarang null-stripped), TAPI `status`, `circuitBreakerTriggered`, dan
`circuitBreakerReason` (sebelumnya di dalam `circuit_breaker.*`) sekarang
juga ada di top-level response sebagai first-class decision fields.

**`binance_detect_mm_activity`** dan **`whalescope_full_pipeline`** —
`structuredContent` TIDAK berubah struktur/nama field sama sekali (cuma
teks-nya yang dipangkas), supaya integrasi terprogram yang sudah ada tidak
perlu berubah.

## Rekomendasi

- Kalau kamu (atau Claude) cuma butuh baca kesimpulan/keputusan → biarkan
  default `detail: "summary"`, ini yang paling hemat token.
- Kalau butuh proses data mentah secara programatik (backtest kustom,
  kalkulasi sendiri di luar tool ini) → set `detail: "full"` secara
  eksplisit per panggilan yang butuh.
- Untuk batasan analitis tiap sinyal (bukan soal ukuran response), lihat
  [`docs/mm_detection_framework.md`](mm_detection_framework.md) dan
  [`docs/full_pipeline_framework.md`](full_pipeline_framework.md).
