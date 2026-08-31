# Full Pipeline Framework — `whalescope_full_pipeline`

🇮🇩 Bahasa Indonesia | [🇬🇧 English](full_pipeline_framework.en.md)

> Dokumentasi lengkap tool composite tertinggi di WhaleScope MCP: satu tool
> call yang menjalankan seluruh decision chain Grid Bot Binance Futures --
> hard screen, Tier-1 intelligence, kalkulasi bound grid, risk sizing, dan
> keputusan akhir -- untuk satu atau banyak symbol sekaligus.

---

## Daftar Isi

1. [Kenapa Tool Ini Ada](#1-kenapa-tool-ini-ada)
2. [Arsitektur: Pure Engine + Thin Wrapper](#2-arsitektur-pure-engine--thin-wrapper)
3. [Alur 2-Wave Fetch (Reject Early)](#3-alur-2-wave-fetch-reject-early)
4. [Tahap 1: Hard Screen](#4-tahap-1-hard-screen)
5. [Tahap 2: Tier-1 Intelligence & Ranking Score](#5-tahap-2-tier-1-intelligence--ranking-score)
6. [Tahap 3: Grid Bounds (Compass-Equivalent)](#6-tahap-3-grid-bounds-compass-equivalent)
7. [Tahap 4: Capital Solve & Pemilihan Leverage](#7-tahap-4-capital-solve--pemilihan-leverage)
8. [Tahap 5: Keputusan Akhir](#8-tahap-5-keputusan-akhir)
9. [Informasi Non-Gate: Matches Needed & Estimasi Durasi ke Impas](#9-informasi-non-gate-matches-needed--estimasi-durasi-ke-impas)
10. [Mapping Tool → Sinyal](#10-mapping-tool--sinyal)
11. [Contoh Kasus (Worked Example)](#11-contoh-kasus-worked-example)
12. [Known Limitations](#12-known-limitations)
13. [Head DCA (entry-alert cron)](#13-head-dca-entry-alert-cron-2026-08-29)
14. [Pre-filter ranking F1 → F3](#14-pre-filter-ranking-f1--f3-2026-08-29)
15. [Deferred — grid volatility tiering](#15-deferred--grid-volatility-tiering)
16. [Log keputusan & uji formula](#16-log-keputusan--uji-formula-2026-08-31)

---

## 1. Kenapa Tool Ini Ada

Sebelum tool ini, seorang trader yang mau setup Binance Futures Grid Bot
harus manual menggabungkan ~8 tool call terpisah (`binance_market_regime`
dua kali untuk 1h dan 4h, `binance_analyze_smart_money`,
`binance_detect_mm_activity`, `binance_get_order_book_imbalance`,
`analyze_futures_grid_risk`, dst.), lalu menghitung SENDIRI parameter grid
(upper/lower/gridCount/stopLoss/takeProfit) -- **tidak ada satu tool pun**
di 44 tool sebelumnya yang menghasilkan angka-angka itu dari nol.
`whalescope_full_pipeline` menggabungkan seluruh rantai keputusan itu jadi
satu tool call, per symbol (bisa banyak symbol sekaligus, maks 20), dan
mengembalikan tabel hasil terurut plus parameter Grid Bot siap copy-paste.

**Yang TIDAK dilakukan tool ini:**

- Tidak mengeksekusi order apapun. Default tetap screening-only; `persist=true`
  hanya menulis row compact ke D1 (`pipeline_decision_log`), bukan order.
- Tidak reverse-engineer algoritma Compass Binance (tidak publik) -- bound
  grid dihitung dengan heuristik ATR + swing high/low yang terdokumentasi
  jelas sebagai APPROXIMATE (Bagian 6).
- Tidak menjamin profit -- ini alat screening + sizing, bukan alpha.

---

## 2. Arsitektur: Pure Engine + Thin Wrapper

Mengikuti pola `smartMoneyAnalysis.ts` + `smartMoney.ts` yang sudah dipakai
tool lain di repo ini:

| Layer | File | Isi |
|---|---|---|
| Pure engine (grid bounds) | `src/gridBoundEngine.ts` | `computeATR()`, `computeGridBounds()` -- murni fungsi angka masuk-angka keluar, tanpa fetch |
| Pure engine (screening/scoring/decision) | `src/pipelineEngine.ts` | `evaluateHardScreen()`, `scoreTier1Signals()`, `scaleCapitalForTargetLoss()`, `decidePipelineOutcome()` |
| Pure engine (grid velocity) | `src/gridVelocity.ts` | `computeGridVelocity()` -- estimasi matches + waktu ke impas (non-gate) |
| Concurrency helper | `src/concurrency.ts` | `mapWithConcurrency()` -- worker-pool buat proses banyak symbol paralel dibatasi `concurrency` |
| Thin MCP wrapper | `src/tools/fullPipeline.ts` | Zod schema, 2-wave fetch orchestration, panggil pure engine + fungsi murni tool lain LANGSUNG (bukan MCP roundtrip), susun output |

**Tidak ada logic dari 44 tool lain yang diduplikasi.** Fungsi murni yang
dipakai ulang secara langsung (import TypeScript, bukan panggil MCP tool):
`classifyRegime` (`marketRegime.ts`), `analyzeSmartMoneyDivergence`
(`smartMoneyAnalysis.ts`), 6 scorer MM (`detectMmActivity.ts`),
`calculateGridRisk` (`gridRiskEngine.ts`), `fetchMarketContext`
(`marketContext.ts`), plus helper umum (`computeCvdFromTrades`,
`summarizeKlines`, `calculateADX`, `errorResult`, `ToolResponseBuilder`).

---

## 3. Alur 2-Wave Fetch (Reject Early)

```
┌─────────────────────────────────────────────────────────────────┐
│ WAVE 1 (paralel, SEMUA symbol):                                   │
│   ticker24hr · funding rate · klines 1h (limit=max(lookback,40)) │
│   klines 4h (limit=40) · open interest + histori 1h (limit=2)    │
│   agg trades (limit=100) · fetchMarketContext()                   │
├─────────────────────────────────────────────────────────────────┤
│   -> hitung regime1h, regime4h (classifyRegime)                   │
│   -> evaluateHardScreen(): tradable? volume >= minimum?           │
│      |funding| <= maksimum? regime 1h/4h != BREAKOUT?             │
│                                                                     │
│      GAGAL? ──────────► NO_TRADE, WAVE 2 TIDAK PERNAH DIPANGGIL   │
│                          (inilah "reject early" -- symbol yang     │
│                          jelas tidak layak tidak membebani proxy   │
│                          dengan fetch Wave 2 sama sekali)          │
├─────────────────────────────────────────────────────────────────┤
│ WAVE 2 (paralel, SURVIVOR SAJA):                                   │
│   top-trader position ratio · global account ratio                │
│   open interest histori 24 titik · order book depth 50            │
│   threshold custom (Workers KV) · spot price (buat basis MM)      │
├─────────────────────────────────────────────────────────────────┤
│   -> analyzeSmartMoneyDivergence()                                 │
│   -> 6 skor MM murni (absorption/spoofing/stopHunt/basisArb/       │
│      oiDivergence/fundingExtreme)                                  │
│   -> scoreTier1Signals() -> rankingScore 0-100                     │
│   -> computeGridBounds() (dari klines 1h Wave 1)                   │
│   -> loop leverage (descending): capital-solve exact via           │
│      calculateGridRisk() 2x per leverage (referensi + final)       │
│   -> computeGridVelocity() (non-gate, reuse candles 1h)            │
│   -> decidePipelineOutcome() -> TRADE / WATCH / NO_TRADE           │
└─────────────────────────────────────────────────────────────────┘
```

**Order book depth 50 dipakai ULANG 3x** (bukan 3 fetch terpisah): OBI-5/10/
20, `orderBookBidDepthSL` buat grid-risk, dan orderbook-imbalance buat smart
money divergence. Satu `getOrderBookDepth(symbol, 50)` per symbol, bukan
tiga.

---

## 4. Tahap 1: Hard Screen

`evaluateHardScreen()` (`src/pipelineEngine.ts`) mengecek 4 kondisi, dan
mengumpulkan **SEMUA** alasan gagal (bukan cuma yang pertama ketemu) supaya
symbol yang di-reject tetap transparan kenapa:

| Kondisi | Sumber data | Default threshold |
|---|---|---|
| **Tradable** | Diderivasi dari fetch `ticker24hr` Wave 1 -- gagal fetch, atau `lastPrice`/`quoteVolume` tidak valid | — |
| **Volume minimum** | `quoteVolume` dari ticker24hr | `min_quote_volume_usd`, default $5,000,000 |
| **Funding tidak ekstrem** | `lastFundingRate` dari `premiumIndex` | `max_abs_funding_rate`, default 0.0005 (0.05%) |
| **Bukan regime BREAKOUT** | `classifyRegime()` untuk 1h DAN 4h (independen) | — |

Symbol yang gagal SATU SAJA dari 4 kondisi di atas langsung dikembalikan
sebagai `NO_TRADE` dengan `reasoning` berisi semua alasan gagal, dan **Wave
2 tidak pernah dipanggil untuk symbol itu**.

---

## 5. Tahap 2: Tier-1 Intelligence & Ranking Score

`scoreTier1Signals()` menggabungkan 4 komponen jadi satu `rankingScore`
0-100 (dipakai buat sorting hasil multi-symbol), bobot eksplisit
terdokumentasi (bukan hasil kalibrasi statistik):

| Komponen | Bobot | Sumber |
|---|---|---|
| Skor MM composite (0-6 dari 6 sinyal `detectMmActivity.ts`) | 35% | absorption, spoofing, stopHunt, basisArb, oiDivergence, fundingExtreme |
| Arah smart money vs retail | 30% | `analyzeSmartMoneyDivergence()` -- BULLISH_ACCUMULATION mendukung, LONG_LIQUIDATION_RISK jadi warning, SHORT_SQUEEZE_RISK setengah bobot, NEUTRAL netral |
| Favorability regime (rata-rata 1h+4h) | 20% | RANGING paling ideal untuk grid, ACCUMULATION/DISTRIBUTION cukup, TRENDING paling berisiko |
| Tekanan beli (OBI depth-20 + CVD) | 15% | Tool ini cuma dukung LONG grid, jadi tekanan beli lebih tinggi = lebih mendukung |

`TRADE_RANKING_SCORE_THRESHOLD = 55` -- dipakai `decidePipelineOutcome()`
di Tahap 5.

---

## 6. Tahap 3: Grid Bounds (Compass-Equivalent)

`computeGridBounds()` (`src/gridBoundEngine.ts`) menghitung SEMUA parameter
grid dari candle 1h Wave 1 + harga saat ini, murni heuristik (bukan
reverse-engineering fitur Compass Binance yang tidak publik):

1. **HH/LL** = swing high/low dari `lookback_bars` candle 1h terakhir.
2. **Upper/Lower** = HH/LL + buffer `ATR × atr_mult` di kedua sisi.
3. **Stop Loss** = Lower − `ATR × sl_extra_atr`, diperlebar lagi
   `sl_pct_buffer`% di bawahnya.
4. **Take Profit** = Upper + `ATR × (tp_atr_mult ?? atr_mult)` (default
   simetris).
5. **Grid Type**: `rangePercentage > 20%` → GEOMETRIC, selain itu →
   ARITHMETIC -- threshold PERSIS sama dengan `gridTypeMismatch` check di
   `gridRiskEngine.ts`, jadi grid yang dibentuk pipeline ini selalu lolos
   `gridTypeMismatch=false` kalau dianalisis ulang.
6. **Grid Count**: heuristik target ~0.75% lebar per step, dibatasi
   [10, 150] -- **bukan histogram-optimized**, lihat Bagian 12.

ATR dihitung Wilder's smoothing lewat `computeATR()`, dibangun di atas
`computeTrueRange()` yang diekstrak dari `calculateADX()`
(`src/toolHelpers.ts`) -- satu sumber kebenaran true-range dipakai ADX
maupun ATR.

---

## 7. Tahap 4: Capital Solve & Pemilihan Leverage

`calculateGridRisk()` (`src/gridRiskEngine.ts`) linear di `initialCapital`
untuk price/grid/leverage/SL tetap -- capital solve dilakukan **EXACT,
bukan iteratif**:

1. Run pertama pakai `REFERENCE_CAPITAL = $1000` → baca
   `slippageStressedLoss`.
2. `solvedInitialCapital = (risk_usd / slippageStressedLoss) × 1000`.
3. Run kedua pakai `solvedInitialCapital` → metrik akhir akurat.

Diulang untuk tiap opsi di `max_leverage_options` (default `[3, 5, 10]`),
**descending** -- dipilih leverage TERTINGGI yang statusnya SAFE/MODERATE
DAN likuidasi aman di bawah stop-loss. **Semua leverage yang dievaluasi
dicatat** di `risk.evaluatedLeverages[]` untuk transparansi, bukan cuma
yang terpilih -- termasuk yang REJECT (misal gagal minNotional Binance di
capital solve kecil).

`BinanceMarketData` untuk `calculateGridRisk()` di-**self-assemble** dari
data Wave 1/Wave 2 yang sudah di-fetch (funding, OI, order book) -- **BUKAN**
memanggil `fetchBinanceMarketData()` (`binanceFetcher.ts`), yang hit
`fapi.binance.com` langsung dan diblokir WAF Binance.

---

## 8. Tahap 5: Keputusan Akhir

`decidePipelineOutcome()` mengombinasikan hasil 3 tahap sebelumnya:

| Kondisi | Keputusan |
|---|---|
| Hard screen gagal | `NO_TRADE` |
| Semua leverage yang dievaluasi REJECT | `NO_TRADE` |
| Leverage terpilih status HIGH_RISK | `WATCH` |
| Leverage terpilih SAFE/MODERATE, `rankingScore >= 55` | `TRADE` |
| Leverage terpilih SAFE/MODERATE, `rankingScore < 55` | `WATCH` |

---

## 9. Informasi Non-Gate: Matches Needed & Estimasi Durasi ke Impas

Setelah capital solve selesai, pipeline menghitung **dua angka informasional**
yang **tidak mempengaruhi** keputusan TRADE / WATCH / NO_TRADE:

| Field | Sumber | Keterangan |
|---|---|---|
| `breakevenInfo.matchesNeeded` | `minBreakevenCycles` dari `calculateGridRisk` | Jumlah match yang dibutuhkan agar net profit menutup slippageStressedLoss |
| `breakevenInfo.estHoursToBreakeven` / `estDaysToBreakeven` | `computeGridVelocity()` (`src/gridVelocity.ts`) | Estimasi waktu kalender berdasarkan histori crossing rate candle 1h |

**Cara hitung Grid Velocity (murni dari candles 1h yang sudah di-fetch Wave 1):**

```
Step_$ (Arithmetic) = (Upper − Lower) / N
Step_$ (Geometric)  = Lower × (price_ratio − 1)   [level terendah]

Crossing_Candles = jumlah candle dengan (High − Low) ≥ Step_$
Crossing_Rate = Crossing_Candles / Total_Candle
Est_Candle_per_Match ≈ 1 / Crossing_Rate
Est_Waktu_per_Match ≈ Est_Candle_per_Match × 1 jam
Est_Total_Waktu_BE ≈ Matches_Needed × Est_Waktu_per_Match
```

**Wajib dipahami:**
- Ini **bukan gate**. Keputusan sudah final sebelum angka ini dihitung.
- Estimasi kasar berbasis histori singkat — bukan prediksi.
- Proxy “range candle ≥ step” bukan bukti match penuh terjadi.
- Sampel kecil (<50 candle) rawan bias outlier.
- Field `breakevenInfo.note` selalu berisi peringatan ini.

Di text summary, untuk kandidat TRADE, dua angka ini ditampilkan dengan ikon:
- 🔁 Matches ke Impas
- ⏱️ Estimasi Durasi ke Impas

Detail lengkap selalu ada di `structuredContent.results[i].breakevenInfo`.

---

## 10. Mapping Tool → Sinyal

| Tahap pipeline | Fungsi murni yang dipakai ulang | File asal |
|---|---|---|
| Regime 1h/4h | `classifyRegime()` | `src/tools/marketRegime.ts` |
| Smart money divergence | `analyzeSmartMoneyDivergence()` | `src/smartMoneyAnalysis.ts` |
| 6 skor MM composite | `calculateAbsorptionScore`, `calculateSpoofingScore`, `calculateStopHuntScore`, `calculateBasisArbScore`, `calculateOiDivergenceScore`, `calculateFundingExtremeScore`, `classifyTier` | `src/tools/detectMmActivity.ts` |
| Grid risk per leverage | `calculateGridRisk()` | `src/gridRiskEngine.ts` |
| Konteks regime/squeeze buat stress multiplier | `fetchMarketContext()` | `src/marketContext.ts` |
| CVD, kline summary, ADX, true range | `computeCvdFromTrades`, `summarizeKlines`, `calculateADX`, `computeTrueRange` | `src/toolHelpers.ts` |
| Grid bounds | `computeATR()`, `computeGridBounds()` | `src/gridBoundEngine.ts` |
| Screening/scoring/decision/capital-solve | `evaluateHardScreen`, `scoreTier1Signals`, `scaleCapitalForTargetLoss`, `decidePipelineOutcome` | `src/pipelineEngine.ts` |
| Matches + Estimasi durasi (non-gate) | `computeGridVelocity()` | `src/gridVelocity.ts` |

---

## 11. Contoh Kasus (Worked Example)

Symbol hipotetis `EXAMPLEUSDT`, `risk_usd=20`, default lainnya:

1. **Wave 1**: quoteVolume 24h $12,000,000 (lolos ambang $5,000,000),
   funding 0.0001 (lolos ambang 0.0005), regime1h=RANGING (confidence 0.7),
   regime4h=ACCUMULATION (confidence 0.6) -- keduanya bukan BREAKOUT →
   **hard screen lolos**, lanjut Wave 2.
2. **Wave 2**: smart money BULLISH_ACCUMULATION (confidence 66), skor MM
   composite 2.1/6, OBI depth-20 62% bid, CVD buy 65% →
   `rankingScore ≈ 61.4` (di atas ambang 55).
3. **Grid bounds**: HH=104, LL=96, ATR=2 → upper=106, lower=94,
   rangePercentage≈12.8% → ARITHMETIC, gridCount≈17, stopLoss≈90.1,
   takeProfit≈108.
4. **Capital solve**: leverage 10x → referenceRun (capital $1000)
   `slippageStressedLoss=$83.2` → `solvedInitialCapital = (20/83.2)×1000 ≈
   $240.4` → final run status SAFE, liquidationPrice=85.3 (aman di bawah
   stopLoss 90.1) → **leverage 10x terpilih**.
5. **Keputusan**: hard screen lolos + status SAFE + rankingScore 61.4 (≥55)
   → **TRADE**. `gridBotConfig`: Lower 94 / Upper 106 / N 17 / ARITHMETIC /
   10x / ISOLATED / SL 90.1 / TP 108.
6. **Non-gate**: `minBreakevenCycles` = 12 → `breakevenInfo.matchesNeeded=12`.
   Crossing rate dari 50 candle 1h ≈ 0.28 → estimasi ~43 jam (~1.8 hari)
   ke impas. Angka ini **tidak** mengubah keputusan TRADE.

_(Angka-angka di atas ilustratif untuk menjelaskan alur perhitungan, BUKAN
hasil query live ke Binance.)_

---

## 12. Known Limitations

1. **Grid Count heuristik, bukan histogram-optimized.** Target ~0.75%
   lebar per step, dibatasi [10, 150] -- pendekatan sederhana yang
   terdokumentasi, bukan hasil backtest/optimisasi distribusi harga
   historis.
2. **Margin-mode tidak dimodelkan di matematika risiko.**
   `GridInputParams` (`gridRiskEngine.ts`) tidak punya field margin-mode --
   semua perhitungan likuidasi/risiko APPROXIMATE ala isolated margin,
   terlepas dari `margin_mode` yang diminta (ISOLATED atau CROSSED). Untuk
   CROSSED riil, likuidasi bergantung pada TOTAL saldo akun, bukan cuma
   capital yang dialokasikan ke grid ini -- setiap hasil membawa
   `gridBotConfig.marginModeCaveat` yang menjelaskan ini eksplisit.
3. **Volume filter absolut, bukan percentile.** `min_quote_volume_usd`
   adalah ambang ABSOLUT ($5,000,000 default), pendekatan kasar dari cutoff
   "bottom 20%" -- TIDAK ada fetcher bulk-ticker/percentile baru di tool
   ini (di luar scope task ini).
4. **MM basis-arbitrage selalu simple-threshold, tidak pernah z-score D1.**
   Cabang z-score histori watchlist di `calculateBasisArbScore`
   (`detectMmActivity.ts`) SENGAJA di-skip (`basisZScore` selalu
   `undefined`) -- simplifikasi MVP, konsisten untuk semua symbol
   (watchlist atau bukan).
5. **"Tradable" diderivasi dari ticker24hr, bukan status listing resmi.**
   `FuturesExchangeInfoSymbol` di codebase ini tidak mengekspos field
   `status` (beda dari versi Spot-nya) -- fetch exchangeInfo terpisah cuma
   buat cek listing akan menambah call di luar desain 2-wave. Sebagai
   gantinya, "not tradable" diderivasi dari fetch `ticker24hr` yang SUDAH
   dilakukan Wave 1 (gagal fetch, atau `lastPrice`/`quoteVolume` tidak
   valid) -- proxy murah, bukan status listing resmi Binance.
6. **Regime 4h reuse OI/CVD Wave 1, bukan fetch timeframe-spesifik kedua.**
   Bagian yang benar-benar 4h-spesifik (ADX, volatility-spike,
   volume-spike dari candle 4h) dihitung independen dari 1h. Tapi
   `oiChangePct`/`cvdBuyPct` yang masuk ke `classifyRegime()` untuk regime
   4h REUSE nilai yang sama dipakai regime 1h (dari fetch OI-history/agg-
   trades Wave 1 yang sama) -- BUKAN fetch OI/CVD kedua yang timeframe-
   spesifik. Ini beda dari memanggil `binance_market_regime` dua kali
   manual (yang masing-masing re-fetch OI/CVD sendiri secara independen).
   Efisiensi sengaja karena pipeline ini SATU composite tool call, bukan
   bug -- tapi hasilnya TIDAK 100% identik dengan dua panggilan
   `binance_market_regime` terpisah.
7. **`getTopTraderPositionRatio` bisa terpanggil dua kali per symbol yang
   lolos hard screen.** `fetchMarketContext()` (Wave 1, dipanggil untuk
   SEMUA symbol per desain) sudah memanggil endpoint ini secara internal
   untuk `GridContextualRisk`-nya sendiri; Wave 2 memanggilnya lagi secara
   independen untuk `analyzeSmartMoneyDivergence()`, supaya sinyal smart
   money tidak diam-diam terdegradasi kalau `fetchMarketContext()` kena
   timeout 1.5 detik miliknya sendiri. Duplikasi call kecil ini SENGAJA
   (reliabilitas > penghematan satu call), didokumentasikan di sini biar
   jujur soal trade-off-nya.
8. **rankingScore dan threshold TRADE/WATCH (55) adalah pilihan eksplisit
   terdokumentasi, bukan hasil kalibrasi statistik** -- sama seperti
   threshold-threshold lain di codebase ini (`smartMoneyAnalysis.ts`,
   `detectMmActivity.ts`). `pipeline_decision_log` +
   `whalescope_backtest_pipeline_decisions` ada supaya threshold ini bisa
   diuji maju; log **tidak** men-auto-tune bobot.
9. **Token cost TINGGI.** Satu panggilan bisa memicu belasan fetch proxy
   per symbol (lebih untuk symbol yang lolos hard screen) -- pakai untuk
   keputusan akhir, bukan eksplorasi awal.
10. **Estimasi durasi ke impas adalah kasar.** Berbasis crossing rate
    histori singkat candle 1h. Bukan prediksi, bukan jaminan, dan **tidak
    mempengaruhi** keputusan TRADE/WATCH/NO_TRADE.

---

## 13. Head DCA (entry-alert cron, 2026-08-29)

`runPipelineForSymbol` dipecah jadi `runPipelineInternal` (fetch 1× 2-wave) +
dua konsumen: `evaluateGrid` (kode grid lama, verbatim) dan `evaluateDca`
(wrapper `src/dcaPipelineEngine.ts`). `runDualPipelineForSymbol` (dipakai
`entryAlertCron.ts`) mengembalikan `{grid, dca}`. Tool MCP
`whalescope_full_pipeline` tetap grid-only lewat `runPipelineForSymbol`.

- **Fetch tambahan head DCA: TEPAT 1** (`klines 1d`, limit 30, `.catch(()=>null)`)
  di Wave 2, survivor-only. Sisanya (RV annualized, ATR1h/4h, OI velocity,
  OBI, CVD, 4h swing) diturunkan dari data yang sudah di-fetch grid.
- **Shared cheap screen = `evaluateHardScreen` yang sekarang** (tidak diubah).
  Strictly lebih permisif dari tiap gate DCA (grid vol $5M < DCA $8M; grid
  funding 0.05% > DCA 0.03%; keduanya reject BREAKOUT + ADX-spike), jadi
  hard-screen reject ⇒ `{grid: NO_TRADE, dca: DCA_NO_TRADE}` tanpa Wave-2
  call, tanpa kehilangan pair DCA-worthy.
- **DCA engine**: profil MODERATE (default skill), Volatility-tiered gate ADX
  (`src/volatilityTier.ts`, cutoff 60/120, ×1.0/1.25/1.6), Entry Matrix
  35/15/15/20/15, Hard Neutral Cap 67, param math (price-drop-step dari
  ATR1h, multiplier geometric, TP/round 1.25%, SL dari ATR4h di luar level
  DCA terakhir, leverage 5-7, capital-solve base-order margin dari KV
  `entry_alert:dca_modal_usd` default $200).
- **Divergensi head DCA vs skill DCA** (semua dalam batas "targeted fixes /
  nol call Binance tambahan", lihat komentar `dcaPipelineEngine.ts`):
  taker-ratio → proxy CVD; wall-persistence → proxy OBI depth-10 +
  spoofing.score; ADX_1D/1D-regime → hanya kalau `klines1d` sukses;
  cross-exchange funding → tidak dijalankan; screening+entry → satu skor
  Entry-matrix; Non-Watchlist penalty tidak berlaku; Konservatif tidak
  di-expose; Leverage Bracket cross-check tidak tersedia di worker;
  `analyze_cvd_divergence` spot-vs-futures tidak dijalankan; RV pakai
  `realizedVolPct(candles1h)`; `modalAvailableUsd` = default config.

## 14. Pre-filter ranking F1 → F3 (2026-08-29)

`entryRanking.rankEntryCandidates` diganti dari "extremity-high"
(`0.5·pct(funding) + 0.5·pct(|priceChange|)`) ke **F3 "cheap grid score"**:
`volNorm(log10 quoteVolume) · clamp(1 − |priceChange24h|/p90) · clamp(1 −
|funding|/p90)`, threshold p90 per-tick. Backtest
(`scripts/backtest-ranking.mjs`, di-replay ke ground truth `[hardscreen]`
tick 11:07 UTC 2026-08-28): F1 top-N PASS rate 0.70–0.79 (lebih buruk dari
hard-screen 0.84) + membuang BTC/ETH/SOL/BNB; F3 p90 = 1.00 PASS, tier-1 4/4
rank #1–#10.

## 15. Deferred — grid volatility tiering

Grid engine (`pipelineEngine.ts`) BELUM mengadopsi Volatility Tier: masih
gate flat BREAKOUT + `ADX_FALLBACK_MIN=25` / `SPIKE_FALLBACK_MIN=4.0`.
`src/volatilityTier.ts` sudah ada (dipakai head DCA) dan ditulis supaya
perubahan bertarget nanti bisa menukar gate flat grid ke `effectiveGate`
tanpa menyentuh head DCA. Re-kalibrasi ADX-25/spike-4.0 sendiri butuh
N hari data shadow (`[hardscreen]` tail / `entry_alert_hardscreen_log`
yang direncanakan) — follow-up terpisah, data-gated.

---

## 16. Log keputusan & uji formula (2026-08-31)

`pipeline_decision_log` (migration 0011) menyimpan row compact per symbol
setelah Phase 2 entry-alert (selalu) dan setelah `whalescope_full_pipeline`
kalau `persist=true`.

- **Yang disimpan:** `run_at`, symbol, `source` (`entry_alert` | `manual` |
  `dropstab`), `source_ref` (slug tab Dropstab / label), keputusan,
  `ranking_score`, hard-screen pass + alasan, volume, funding, regime 1h/4h,
  `grid_risk_status`, lower/upper/SL. Hard-screen reject tetap di-log
  (bound grid boleh null).
- **Yang TIDAK disimpan:** `forward_return_*`. Dihitung on-demand oleh
  `whalescope_backtest_pipeline_decisions` dari klines 1h (pola
  `binance_backtest_signal`): win rate / avg return / SL-touch, di-bucket
  per keputusan dan skor (`lt_40` / `40_55` / `gte_55`).
- **Yang TIDAK dilakukan:** auto-tune bobot ranking 35/30/20/15 atau
  threshold 55. Log adalah bahan uji, bukan input optimizer.
- **Retensi:** 90 hari (sama `market_snapshots` / `signal_history`).
  `entry_alert_skip_log` diperpanjang 7 → 30 hari untuk audit F3.
- **Tidak ada cron berat kedua.** Persist menumpang tick entry-alert yang
  sudah bayar `full_pipeline`.

### Protokol uji (disepakati 2026-08-31)

Formula awal **dibekukan** selama uji. Hipotesis terpasang, bukan klaim sudah
benar.

| Parameter | Nilai terpasang |
|---|---|
| Bobot ranking (MM / smart money / regime / buy pressure) | 35 / 30 / 20 / 15 |
| Ambang TRADE | 55 |
| Volume quote 24h minimum | $5,000,000 |
| \|funding\| maksimum | 0.05% (`0.0005`) |

Aturan:

1. **Jangan geser** bobot, threshold 55, atau hard screen di atas sampai
   protokol di bawah terpenuhi. 0 TRADE di satu hari risk-off bukan bukti
   rumus rusak, juga bukan bukti rumus benar.
2. **Peek 24 jam** (boleh baca log / `whalescope_backtest_pipeline_decisions`)
   — read-only, tidak mengubah angka.
3. **Review serius 14 hari** — jendela pertama untuk memutus apakah gerbang
   terlalu ketat. 30/90 hari adalah retensi D1, bukan alasan menunda baca.
4. **Jangan retune** sampai ada **≥20 TRADE** dengan forward return **4h dan
   24h sudah selesai**, lintas **≥3 rezim 4h yang berbeda**.
5. Kalau **14 hari TRADE tetap 0**, itu **hasil tes** (55 terlalu ketat untuk
   pasar yang teramati) — baru boleh dibahas longgarkan. Bukan rewrite di
   hari pertama.

*Dibuat: 2026-08-22, bareng rilis `whalescope_full_pipeline`.*
*Update 2026-08-22: tambah non-gate Matches Needed + Estimated Time to Breakeven.*
*Update 2026-08-29: head DCA + shared 2-wave fetch + F1→F3 ranking (§13-15).*
*Update 2026-08-31: pipeline_decision_log + backtest on-demand (§16).*
*Update 2026-08-31: protokol uji formula dibekukan (bobot/55) sampai sample cukup.*
