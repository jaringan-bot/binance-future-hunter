# Signal Integrity Remediation — Grid / DCA / Traditional Futures

> ## 📋 STATUS
>
> | Stage | Isi | Status | Commit | Deploy |
> |---|---|---|---|---|
> | 0 | Plan file ini | ✅ [Semeru] 2026-09-04 | — | — |
> | 1 | Blocker: uang, uptime, buta (K1, K2, I1, I2, B1/B2) | ✅ **KODE SELESAI** [Semeru] 2026-09-04 — menunggu commit + acc deploy | — | ⏳ |
> | 2 | Reachability (K4/D3, K5, G1, I6, D1/D2, G6) + **K10 baru** | ✅ **KODE SELESAI** [Semeru] 2026-09-04 | — | ⏳ |
> | 3 | Kualitas sinyal / anti-halu (K8, K3, K6, K9, G3-G5, K7) + migration 0015 | ⏳ belum | — | — |
> | 4 | Backtest valid + observability + kalibrasi (B3, B4, backfill, I7) | ⏳ belum | — | — |
>
> **Keputusan user 2026-09-04:** legacy DCA jadi pre-gate wajib · fidelitas data
> tanpa call Binance tambahan · backtest fix aritmetika + metrik grid-native ·
> 4 stage dengan deploy per stage.
>
> **Baseline saat audit:** `main` @ `bac382f`, worker live `e511dcad`.
> `npm run typecheck` ✅ · `npm test` ✅ — **semua cacat di bawah lolos test
> suite yang ada.**
>
> ─────────────────────────────────────────────────────────────────────
>
> ### ✅ Stage 1 — kode selesai [Semeru] 2026-09-04
>
> Branch `claude/sharp-pare-291ecd`. `tsc --noEmit` bersih · **910 test hijau**
> (naik dari 849; +61 test, 0 test lama dihapus).
>
> | Task | Status | File |
> |---|---|---|
> | 1.1 K1 legacy jadi pre-gate wajib (`effectiveDcaDecision`, severity minimum) | ✅ | `src/cron/entryAlertCron.ts` |
> | 1.2 K2 fail-closed + invariant guard `findMissingRiskParams()` | ✅ | `src/cron/entryAlertCron.ts` |
> | 1.3 I1 429 keluar dari `RETRYABLE_STATUS` + `Retry-After` + cooldown per-relay | ✅ | `src/retry.ts`, `src/binanceProxyClient.ts` |
> | 1.4 I2 relay teruskan header weight + timeout + fix prototype-pollution | ✅ kode — **butuh redeploy VPS (Krakatau)** | `proxy-standalone/handler.mjs` |
> | 1.5 B1/B2 forward-return window 5m, entry = OPEN | ✅ | `src/tools/pipelineDecisionBacktest.ts`, `src/cron/pipelineDecisionOutcomeCron.ts` |
>
> **Mutation-test (bukti guard benar-benar menggigit, bukan test kosong):**
> - Kembalikan gate DCA lama (V3 sendirian memutuskan) → **1 test K1 MERAH**
>   ("does NOT alert when V3 says DCA_TRADE but the legacy engine hard-rejected").
> - Matikan `findMissingRiskParams()` → **3 test MERAH** (K1 + 2 K2).
> - Kode dikembalikan; 910/910 hijau lagi.
>
> **Perubahan perilaku yang DIHARAPKAN setelah deploy:**
> 1. Volume alert DCA **turun tajam** (8 hard gate hidup lagi). Bukan regresi.
> 2. String dedup `entry_alert_state.lastDecision` ganti format saat V3 aktif:
>    `NO_TRADE/DCA_WATCH+DCA_PAUSE_SOFT/TRAD_NO_TRADE` (dulu slot tengah cuma
>    `DCA_PAUSE_SOFT`). Efek sekali jalan: tick pertama pasca-deploy membaca
>    semua state lama sebagai "transisi" → **satu gelombang alert lebih ramai
>    dari biasanya, lalu normal.** Ini disengaja supaya transisi legacy↔V3
>    tidak tertelan cooldown.
> 3. `forward_return_1h` berhenti bernilai 0 seragam. Baris LAMA di
>    `pipeline_decision_log` tetap memakai semantik lama (1h = 0, 4h = 3 jam,
>    24h = 23 jam) — **jangan campur baris pra- dan pasca-deploy** saat
>    menganalisis; potong di timestamp deploy.
>
> **Sisa untuk Krakatau (GATED, tunggu acc user):**
> - `wrangler deploy` (Worker) — 1.1/1.2/1.3/1.5.
> - `scp` + restart relay di KEDUA host (AWS `svm-vps` + Oracle) — 1.4. Boleh
>   menyusul; Worker tidak bergantung padanya.
> - **Tidak ada migration di Stage 1.**
>
> ─────────────────────────────────────────────────────────────────────
>
> ### ✅ Stage 2 — kode selesai [Semeru] 2026-09-04
>
> `tsc --noEmit` bersih · **925 test hijau** (naik dari 910).
>
> | Task | Status | File |
> |---|---|---|
> | 2.1 K4+D3 funding percentile dari `/fapi/v1/fundingRate` | ✅ | `src/cron/dcaSmartMoneyAdapter.ts` |
> | 2.2 K5 head trad hidup di jalur regime-reject | ✅ | `src/tools/fullPipeline.ts` |
> | 2.3 G1 band WATCH tanpa batas atas + label HIGH_RISK | ✅ | `src/cron/entryAlertCron.ts` |
> | 2.4 I6 alert-budget (semantik jujur + KV-tunable, default 3→12) | ✅ | `src/engine/riskCircuitBreaker.ts` |
> | 2.5 D1 entryCount baca+increment · D2 capitulation dari gateway | ✅ | `entryAlertCron.ts`, `dcaSmartMoneyAdapter.ts`, `fullPipeline.ts` |
> | 2.6 G6 kuota hybrid grid/extremity (total tetap) | ✅ | `src/entryRanking.ts` |
> | **K10 (BARU)** safety/pause mencerminkan arah | ✅ | `src/cron/dcaSmartMoneyAdapter.ts` |
>
> **K10 — temuan BARU, ditemukan oleh reachability test Stage 2:**
> `computeDirectionalTiming()` sudah mirror untuk SHORT, tapi
> `computeDcaSafetyScore()` / `resolvePauseLevel()` tidak ikut — keduanya
> memakai `S_C < 25` dan `computeLongSqueezeRisk()` untuk KEDUA arah. Efeknya
> makin KUAT setup SHORT (arus jual dominan + long crowded), makin besar
> penaltinya → safety 10 → **DCA_STOP**. DCA SHORT tidak terjangkau tepat
> ketika paling layak. Diperbaiki mengikuti konvensi mirror yang sudah ada,
> bukan desain baru.
>
> **Mutation-test:**
> - `regimeOnlyReject = false` (perilaku K5 lama) → **1 test MERAH**.
> - Semua dikembalikan; suite hijau lagi.
>
> **Perubahan biaya per tick (40 symbol):**
> - +40 subrequest Binance (`/fapi/v1/fundingRate`, weight 1, LONG_CACHE 300s)
> - +40 request ke stream gateway VPS (liquidations, bukan weight Binance)
> - **−~33 juta row-read D1/hari** (query `market_snapshots` tanpa LIMIT dihapus)
> - Phase 1 tetap 40 symbol → biaya Phase 2 TIDAK berubah
>
> **Perubahan perilaku yang DIHARAPKAN setelah deploy:**
> 1. Alert DCA mulai muncul untuk pair non-watchlist (dulu mustahil: timing
>    ter-cap 55.6 < 60). Naik dari nol, tapi tetap di bawah pre-gate Stage 1.
> 2. DCA SHORT mulai mungkin (K10).
> 3. `TRAD_TRADE`/`TRAD_WATCH` skenario TREND_BREAKOUT mulai muncul.
> 4. WATCH grid skor tinggi + HIGH_RISK muncul dengan label ⚠️ HIGH RISK.
> 5. Alert budget 3→12: alert TRADE tidak lagi mati setelah 3 sinyal/hari.
> 6. `dca_active_plans.entry_count` mulai bergerak. **Ini state INFERENSI dari
>    harga, bukan konfirmasi fill** — worker tidak punya akses posisi user.
>
> **Sisa untuk Krakatau:** `wrangler deploy`. **Tidak ada migration di Stage 2.**
> Opsional KV tuning: `entry_alert:daily_alert_limit`, `entry_alert:extremity_frac`.

---

## Context

User mereproduksi ulang `whalescope-mcp` jadi `binance-future-hunter` karena tidak
puas dengan kualitas sinyal alert — "banyak sinyal halu". Audit menyeluruh
(2026-09-04) terhadap seluruh jalur sinyal menemukan bahwa keluhan itu bukan satu
bug, melainkan **empat kelas cacat independen** yang semuanya lolos typecheck dan
849 test — karena test menguji fungsi murni satu-satu dengan input buatan tangan,
dan **tidak pernah menguji reachability rantai keputusan yang tersusun**.

### Temuan inti

| Kode | Temuan | Bukti |
|---|---|---|
| **K1** | DCA V3 mem-bypass **8 hard gate keselamatan** DCA legacy | `entryAlertCron.ts:141-150` — `if (dcaSm) {...}` tidak pernah melihat `dca.decision` |
| **K2** | Alert DCA bisa terkirim **tanpa SL / leverage / sizing** | `entryAlertCron.ts:252-268` — tidak ada cabang yang jalan saat `dcaSm=TRADE` + legacy reject |
| **I1** | Retry pada HTTP 429 → **hingga 12 request Binance per satu call** | `retry.ts:5` (429 retryable) × `binanceProxyClient.ts:237` (429 failover) |
| **B1** | `forwardWindow:"1h"` **selalu return 0%** persis | `pipelineDecisionBacktest.ts:24` — window 1h dari `runAt` non-boundary hanya menghasilkan 1 candle |
| **K3** | `slopeSpot` **dikarang** = `slopeFutures × 0.85` → S_C konstan 28.05, cap 64 | `dcaSmartMoneyAdapter.ts:295` |
| **K4** | `DCA_TRADE` **mustahil secara aritmetika** untuk pair non-watchlist | timing max = `0.4(64) + 0 + 0.2(100) + 10` = **55.6** < `DCA_TIMING_WATCH_MIN` = 60 |
| **K5** | Skenario `TREND_BREAKOUT` adalah **dead code** | butuh `regime === "BREAKOUT"`, tapi hard screen me-reject BREAKOUT sebelum head trad jalan |
| **K6** | Bobot MM 35% **tandanya terbalik** — makin banyak manipulasi, makin tinggi skor | `pipelineEngine.ts:268` |
| **K7** | Dua engine menilai regime dengan tanda **berlawanan** | `REGIME_FAVORABILITY` ACC=0.9 vs `REGIME_SAFETY` ACC=30 |
| **K8** | Semua indikator dihitung dari **candle belum close** (repaint) | regime jadi fungsi dari menit cron (:07 vs :52) |
| **K9** | CVD dari **100 aggTrades** (≈2-10 detik tape) dipakai sebagai gate | `fullPipeline.ts:494` |
| **K10** | Safety/pause DCA hanya sudut pandang LONG → **SHORT tak terjangkau** tepat saat paling layak | ditemukan 2026-09-04 oleh reachability test Stage 2; `computeDcaSafetyScore` / `resolvePauseLevel` |

### Hasil yang dituju

Alert yang **tidak pernah terkirim tanpa parameter risiko lengkap**, tidak dipicu
oleh noise/repaint, tidak menghargai manipulasi sebagai kualitas — dan sebuah
backtest yang **benar-benar bisa menghasilkan angka valid** sehingga threshold
bisa dikalibrasi dari data, bukan ditebak.

---

## Aturan main (lihat CLAUDE.md)

- **Semeru (Claude)** menulis kode + test + migration + docs. Boleh
  `npm run typecheck`, `npm test`, `wrangler dev`. **TIDAK BOLEH** `--remote`,
  `wrangler deploy`, `secret put`, SSH VPS.
- **Rinjani (Cursor)** commit/PR dari tree. Trailer `Agent: Rinjani`.
- **Krakatau (Cursor, GATED)** `d1 migrations apply --remote`, `wrangler deploy`,
  SSH redeploy relay. **Hanya setelah acc eksplisit user.**
- Satu agen aktif di tree pada satu waktu. Handoff eksplisit.
- **Plan file ini SEMERU-ONLY.** Cursor lapor hasil (step pass/fail, output,
  version id) **di chat**; Semeru yang tulis ke sini.
- Batasan repo yang tetap berlaku: **no new npm deps** · **jangan rename
  `whalescope_*`** · pure engine + thin wrapper · test ~1:1 · threshold yang
  belum di-backtest **wajib** ditandai "belum dikalibrasi".

---

## Stage 1 — Blocker: uang, uptime, buta

Tujuan: hentikan alert yang bisa merugikan langsung, hentikan mekanisme yang
menyebabkan IP-ban berulang, dan buat backtest berhenti berbohong.

### 1.1 — K1: legacy `evaluateDcaEntry` jadi pre-gate wajib
`src/cron/entryAlertCron.ts` · `isDcaAlertWorthy()`

`dcaSm` hanya boleh **menurunkan** keputusan, tidak pernah menaikkan:

```
alertWorthy = legacyAllows(dca) AND smAllows(dcaSm)
  legacyAllows : dca.decision ∈ {DCA_TRADE, DCA_WATCH}
  smAllows     : dcaSm == null ? true : dcaSm.decision ∈ {DCA_TRADE, DCA_WATCH}
  final head   : severity minimum dari keduanya (TRADE ∧ WATCH → WATCH)
```

Delapan gate yang kembali hidup: `liquidity` ($8M) · `dead_market` (ADX4H<12) ·
`strong_trend_4h` · `macro_overextended` · `macro_trend_opposing` ·
`funding_extreme` (>0.03%) · Hard Neutral Cap · `capital_solve_infeasible` (≤$20).

Semua sudah ada di `src/dcaPipelineEngine.ts` — **tidak ada logika baru ditulis**,
hanya jalurnya disambung kembali.

> ⚠️ Konsekuensi yang diharapkan: **volume alert DCA turun tajam.** Itu perilaku
> yang diinginkan, bukan regresi. Jangan "diperbaiki" dengan melonggarkan gate.

### 1.2 — K2: fail-closed pada alert tanpa parameter risiko
`src/cron/entryAlertCron.ts` · `formatEntryAlert()` + `classifyAlertHeads()`

- `dcaOn` hanya `true` kalau `dca.dcaBotConfig != null`. Tanpa config → head DCA
  dimatikan untuk alert itu (grid/trad tetap boleh jalan).
- Tambah **invariant guard** sebelum `dispatchNotification`: kalau ada head aktif
  yang tidak menyertakan SL, tolak kirim + `console.error`. Guard ini yang
  mencegah kelas bug ini kambuh lewat jalur lain.
- Test baru: `dcaSm=DCA_TRADE` + legacy `DCA_NO_TRADE` → **tidak ada notifikasi
  terkirim** (bukan sekadar teks berbeda).

### 1.3 — I1: hentikan retry storm pada rate-limit
`src/retry.ts` · `src/binanceProxyClient.ts`

Kondisi sekarang, satu panggilan logis saat Binance membalas 429:

```
relay-1 : 1 + 3 retry = 4 request
relay-2 : 1 + 3 retry = 4 request   (failover)
direct  : 1 + 3 retry = 4 request
────────────────────────────────────
        = hingga 12 request ke Binance, per satu call
```

Perbaikan:
- `RETRYABLE_STATUS`: **buang 429**, sisakan `{502, 503}`. Binance eksplisit:
  retry pada 429 memicu ban 418.
- Honor header `Retry-After` kalau ada; kalau tidak, backoff tetap.
- **Per-relay cooldown** module-level di `binanceProxyClient.ts` (pola sama
  `rateLimiter.ts` — best-effort per-isolate, dokumentasikan jujur): relay yang
  membalas 418/429 di-skip sampai `Retry-After` / default 60s lewat, sehingga
  failover **tidak** memindahkan seluruh beban ke relay kedua sampai ikut ban.
- Parse `{"code":-1003,"msg":"...banned until <ts>"}` untuk mengisi cooldown
  dengan timestamp asli.

### 1.4 — I2: relay teruskan header weight Binance *(Krakatau, boleh menyusul)*
`proxy-standalone/handler.mjs`

Relay saat ini hanya meneruskan `Content-Type` — `X-MBX-USED-WEIGHT-1M` dan
`Retry-After` **dibuang**. Itu satu-satunya sinyal yang bisa mencegah ban, dan
kenapa `rateLimiter.ts` terpaksa count-based dengan asumsi "weight rata-rata
~1.5" (padahal `/fapi/v1/depth?limit=50` = weight 5, `/fapi/v1/ticker/24hr`
tanpa symbol = weight 40).

Sekalian: perbaiki prototype-pollution di `ALLOWED_PATHS_BY_MARKET[market]`
(`?market=constructor` → TypeError tak tertangkap) dan tambahkan
`AbortSignal.timeout(10_000)` pada `fetch` upstream (sekarang tidak ada timeout
di manapun — relevan dengan cron `Canceled` di wall-clock 12m13s).

Worker belum mengonsumsi header ini di Stage 1; konsumsinya (throttle
weight-aware) direncanakan setelah ada data nyata. **Redeploy relay = Krakatau,
SSH, gated.** Stage 1 Worker-side tidak bergantung padanya.

### 1.5 — B1 + B2: aritmetika forward-return
`src/tools/pipelineDecisionBacktest.ts` · `src/cron/pipelineDecisionOutcomeCron.ts`

Ganti fetch klines 1h ber-`startTime` non-boundary dengan **satu** fetch 5m:

```
getKlinesNative(symbol, "5m", 289, runAt, runAt + 24h)
entry = open(candle[0])        // ≤5 menit lag, TANPA look-ahead
exit  = close(candle[N-1])     // N = 12 (1h) / 48 (4h) / 288 (24h)
lows  = candle[0..N-1].low     // untuk didStopLossTouch
```

Menghapus sekaligus tiga cacat: window 1h yang selalu 0, lag ~1 jam, dan
off-by-one (yang selama ini menghitung 3h dan menamainya "4h", 23h dinamai "24h").
Jumlah subrequest **tidak berubah** (tetap 1 per row, slice 3×). `KLINE_LIMIT`
dan `FORWARD_WINDOW_MS` diganti `FORWARD_WINDOW_CANDLES = {1h:12, 4h:48, 24h:288}`.

`evaluateDecisionForward()` tetap satu sumber kebenaran untuk tool on-demand dan
cron backfill — perbaiki di sana, keduanya ikut. Komentar di
`pipelineDecisionOutcomeCron.ts:5` yang mengklaim angka "IDENTIK" jadi **benar**
setelah ini (sekarang tidak benar untuk window 1h).

### Gate Stage 1
`npm run typecheck && npm test` hijau → Rinjani commit/PR → **acc user** →
Krakatau `wrangler deploy` (relay redeploy opsional/menyusul) → **amati 48 jam**:
`wrangler tail | grep -E "entry-alert|429|418"` · tidak ada alert DCA tanpa SL ·
cek `entry_alert_run_log`.

---

## Stage 2 — Reachability: sinyal yang seharusnya ada tapi tidak pernah muncul

Stage 1 mengetatkan. Stage 2 memperbaiki hal-hal yang membuat sinyal **sah** tidak
pernah bisa terbit.

### 2.1 — K4 + D3: funding percentile dari sumber yang benar
`src/cron/dcaSmartMoneyAdapter.ts` · `loadFundingHistory30d()`

Ganti `queryMarketSnapshots(symbol, 720)` — D1, **~8.640 baris/symbol**, hanya
tersedia untuk 50 pair `SNAPSHOT_WATCHLIST` — dengan
`binanceProxy.getFundingRateHistoryNative(symbol, 90)`: 90 titik × 8 jam = 30
hari, **tersedia untuk semua perp**, weight 1, sudah `LONG_CACHE_TTL 300s`
(`binanceProxyClient.ts:52`).

Neraca: **+40 subrequest/tick** (≈160/jam vs budget 1.800/menit — dapat
diabaikan) tapi **−~33 juta row-read D1/hari** dan menghapus salah satu
kontributor wall-clock cron 12m13s. **Penurunan bersih penggunaan sumber daya.**

Dengan percentile nyata (bukan default 50 dari history kosong),
`shortBoost`/`longRisk` hidup dan `DCA_WATCH`/`DCA_TRADE` jadi terjangkau — di
bawah pre-gate legacy dari Stage 1.

### 2.2 — K5: hidupkan skenario TREND_BREAKOUT
`src/tools/fullPipeline.ts`

Hard screen adalah gate **grid**, tapi sekarang ikut mematikan head Traditional.
Pisahkan: kalau hard screen gagal **hanya** karena tag regime
(`regime1h_breakout`, `regime4h_breakout`, `adx_spike_*`) — bukan `not_tradable`
/ `low_volume` / `funding_extreme` — tetap jalankan
`evaluateTraditionalFuturesEntry()` dari data Wave 1 yang sudah ada
(`oiVelocity` boleh `null`, engine sudah fault-tolerant). Grid tetap `NO_TRADE`.

Nol subrequest tambahan. Sekalian perbaiki komentar salah di
`fullPipeline.ts:936` yang menyatakan TREND_BREAKOUT "jalan penuh".

### 2.3 — G1: band alert WATCH grid
`src/cron/entryAlertCron.ts` · `isGridAlertWorthy()`

`rankingScore >= 50 && < 55` membuang setup skor 72 + `HIGH_RISK` (yang oleh
`decidePipelineOutcome` diberi `WATCH`) secara **diam-diam**, sementara skor 51 +
SAFE dialert. Ganti jadi `rankingScore >= WATCH_MIN_ALERT_SCORE` tanpa batas
atas, dengan penanda ikon berbeda untuk `HIGH_RISK` supaya tetap terbaca sebagai
peringatan, bukan entry.

### 2.4 — I6: circuit breaker sesuai namanya
`src/engine/riskCircuitBreaker.ts`

`recordTradeAlert()` menambah `count`/`total_loss` **setiap alert terkirim**,
tanpa hubungan apapun dengan hasil trade. `count >= 3` → semua alert TRADE mute
hingga 25 jam. Ini penghitung alert, bukan circuit breaker kerugian — dan
kemungkinan besar penyebab "alert menghilang setelah beberapa sinyal".

- Rename konsep jadi **alert budget** di dokumentasi + pesan notifikasi. Nama key
  KV `state:daily_loss_circuit` **dipertahankan** demi kompatibilitas state yang
  sedang berjalan.
- Limit dibaca dari KV (`entry_alert:daily_alert_limit`), default dinaikkan dari
  3 ke nilai wajar, ditandai "belum dikalibrasi".
- Circuit berbasis kerugian **nyata** (dari `forward_return_*` yang di-backfill)
  dijadwalkan Stage 4, bukan sekarang.

### 2.5 — D1 + D2: DCA plan benar-benar stateful, capitulation hidup
`src/tools/fullPipeline.ts` · `src/cron/entryAlertCron.ts` · `src/cron/dcaSmartMoneyAdapter.ts`

- Baca `getDcaActivePlan()` **sebelum** evaluasi dan oper `entryCount` ke
  `buildAndEvaluateDcaSmartMoney()`. Sekarang tidak pernah dibaca balik → selalu
  0 → guard `entryCount >= maxEntries` dead code, alert selalu tertulis `(1/6)`.
- Increment `entryCount` saat trigger terlampaui (`nextTriggerPrice` tersentuh),
  bukan setiap tick. Isi `avgEntryPrice` / `totalInvested` / `lastEntryAt` yang
  selama ini selalu NULL.
- Isi `liqSpikeUsd` / `liqMean24hUsd` dari
  `streamGatewayClient.fetchLiquidations()` (sudah dipakai `detectMmActivity.ts`)
  supaya `isCapitulation()` — yang sekarang **selalu false** karena default 0/0 —
  bisa memicu `DCA_STOP`.

### 2.6 — G6: Phase 1 hybrid, budget tetap
`src/entryRanking.ts` · `src/cron/entryAlertCron.ts`

F3 memilih pair paling likuid & paling **tidak** bergerak — benar untuk grid,
tapi membuang persis kandidat yang dibutuhkan DCA (funding ekstrem) dan
Traditional (sweep/breakout). Satu pre-filter, tiga tujuan bertentangan, 310 dari
350 pair dibuang tiap tick.

Ubah Phase 1 jadi union dengan **total tetap 40**: ~30 teratas F3 (grid) + ~10
teratas skor extremity terbalik (DCA/Trad), dedup. Nol subrequest tambahan, nol
perubahan wall-clock. Rasio ditandai "belum dikalibrasi" dan dibuat KV-tunable
seperti `entry_alert:top_n`.

### Gate Stage 2
`typecheck && test` hijau → PR → acc → deploy → amati: `dcaTradeCount` /
`dcaWatchCount` di `entry_alert_run_log` tidak lagi nol · `TRAD_TRADE` muncul di
jalur breakout · subrequest/tick masih jauh di bawah 20.000.

---

## Stage 3 — Kualitas sinyal (anti-halu)

Inti dari keluhan "sinyal halu". Butuh **migration 0015** → Krakatau.

### 3.1 — K8: satu titik potong candle belum close
`src/toolHelpers.ts` · `src/tools/fullPipeline.ts`

`getKlinesNative` mengembalikan candle berjalan sebagai elemen terakhir, dan
candle itu dipakai apa adanya oleh ADX, ATR, realized vol, `volumeSpikeRatio`,
grid bounds HH/LL, MM stop-hunt, dan `active.close` deteksi sweep.

Dampak terukur: cron fire di :07/:22/:37/:52. Pada :07 candle baru berumur 7
menit → volumenya ~12% nilai akhir → syarat BREAKOUT
(`volSpike>2 AND oiΔ>3% AND volumeSpike>2`) hampir mustahil terpenuhi; pada :52
jauh lebih mudah. **Klasifikasi regime jadi fungsi dari menit cron.** Untuk sweep:
uji "reclaim" pada candle belum close = repaint klasik.

Perbaikan:
- Tambah `closeTime` (opsional) ke `KlineCandle` di `summarizeKlines()` (index 6
  `KlineTuple`, additive — tidak memecah konsumen lain).
- Helper baru: `dropUnclosedCandle(candles, now?): KlineCandle[]`.
- Terapkan **satu kali di batas fetch** `fullPipeline.ts` untuk klines 1h/4h/1d,
  sehingga semua konsumen hilir otomatis memakai candle tertutup.
- Naikkan `klineLimit` +1 supaya window efektif tidak menyusut.
- `currentPrice` tetap dari `markPrice` (sudah begitu) → harga tetap real-time.

Setelah ini: **evaluasi ulang** apakah `ADX_FALLBACK_MIN` / `SPIKE_FALLBACK_MIN`
(EMERGENCY PATCH `pipelineEngine.ts:48`, confidence LOW-MEDIUM, n=1 anchor) masih
dibutuhkan — patch itu menambal gejala dari akar yang sekarang diperbaiki.

### 3.2 — K3: buang komponen spot palsu, beri nama jujur
`src/cron/dcaSmartMoneyAdapter.ts` · `src/cron/smartMoneyPipelineEngine.ts`

`slopeSpot = slopeFutures * 0.85` membuat
`slopeRatioScore = min(100, 0.85 × 33) = 28.05` **konstan**, apapun kondisi pasar
dan arah apapun — padahal `DIVERGENCE_W.slopeRatio = 0.5` adalah bobot terbesar
Scenario C. Akibatnya `S_C ∈ [14.0, 64.0]`, tidak pernah bisa > 64.

- Hapus `slopeSpot: slopeFutures * 0.85`. `calculateScenarioC()` tidak lagi
  menerima `slopeSpot`/`slopeFutures` dari jalur DCA.
- Bobot `DIVERGENCE_W` dinormalisasi ulang ke dua komponen yang datanya nyata
  (`takerSpot`, `multiTf`); nilai barunya ditandai **"belum dikalibrasi"**.
- **Penamaan jujur:** tanpa data spot ini bukan lagi "Spot vs Futures CVD
  divergence". Rename di kode + docs jadi *directional flow alignment*, dan catat
  kapabilitas divergence spot-vs-futures sebagai **deferred** — `getSpotKlinesNative`
  ada, tapi biayanya +1 call/symbol dan banyak perp tidak listed di Spot.
- Efek samping yang diinginkan: S_C tidak lagi ter-cap 64 → `DCA_TRADE` (≥75)
  benar-benar terjangkau, di bawah pre-gate legacy Stage 1.
- `smartMoneyPipelineEngine.test.ts` / `dcaSmartMoneyAdapter.test.ts` butuh
  ekspektasi baru — itu perubahan perilaku yang disengaja.

### 3.3 — K6: perbaiki tanda skor MM (migration 0015)
`src/tools/detectMmActivity.ts` · `src/pipelineEngine.ts` · `migrations/0015_*.sql`

`mmComponent` adalah **35%** dari `rankingScore` (bobot terbesar), tapi 6
sub-sinyalnya mengukur **abnormalitas/manipulasi**, bukan kelayakan grid. Makin
banyak manipulasi terdeteksi → skor makin tinggi → makin mudah lolos ambang 55.

| Kelompok | Sinyal | Arah untuk long-grid mean-reversion |
|---|---|---|
| **Supportive** | `absorption`, `oiDivergence` | mendukung ✅ |
| **Adverse** | `spoofing`, `stopHunt`, `fundingExtreme`, `basisArb` | menaikkan risiko ❌ |

`mmComponent` = supportive saja; `mmAdverseComponent` baru **mengurangi**
`rankingScore`. Magnitudo penalti ditandai "belum dikalibrasi" dan sengaja
konservatif — **kalibrasi dilakukan Stage 4** dengan
`scripts/calibrate-ranking-weights.mjs` begitu backtest sudah valid.

Migration 0015 (pola additive persis 0013/0014):

```sql
ALTER TABLE pipeline_decision_log ADD COLUMN mm_adverse_component REAL;
```

Baris lama `NULL` → skrip kalibrasi memfilter `mm_adverse_component IS NOT NULL`,
sehingga **semantik lama dan baru tidak tercampur** dalam satu kolom.

### 3.4 — K9: CVD 100-trade turun dari gate keras
`src/tools/fullPipeline.ts` · `src/pipelineEngine.ts`

100 aggTrades ≈ 2-10 detik tape di pair likuid — noise, bukan order flow — namun
memberi makan komponen `buyPressure` (15%), klasifikasi
ACCUMULATION/DISTRIBUTION, `absorption`, `takerMatch` DCA, dan `takerSpotNorm`.

Repo punya `aggTradesPaginator.fetchAggTradesForWindow()`, tapi **terukur ~115
halaman per window 60 menit di BTCUSDT** → 40 symbol/tick akan langsung memicu
ban. Sesuai keputusan "nol call tambahan":

- Sertakan `cvdSampleSeconds` (dari `aggTrades[0].T` … `aggTrades[n-1].T`) dan
  turunkan bobot/kepercayaan `buyPressure` saat window sampel terlalu pendek.
- Jangan pakai `cvdBuyPct` sebagai **syarat keras** di `classifyRegime`
  (ACCUMULATION/DISTRIBUTION) dan `takerMatch` DCA — jadikan pengubah confidence.
- Dokumentasikan batas ini eksplisit di tool description + README (konvensi
  "dokumentasi jujur").

### 3.5 — Matematika risiko grid
`src/gridRiskEngine.ts` · `src/marketContext.ts` · `src/shared.ts`

- **G3** `fundingPerCycleUSD = dailyFundingBleedUSD / gridCount` — `gridCount`
  adalah jumlah **level**, bukan cycle per hari. Dua satuan berbeda dikurangkan,
  dan `netProfitPerCycleUSD <= 0` adalah kondisi **REJECT** (bukan kosmetik).
  Ganti dengan estimasi cycle/hari dari `computeGridVelocity()`
  (`src/gridVelocity.ts`, sudah ada, sekarang cuma dipakai informasional).
- **G4** `liquidationPrice = avgEntry × (1 − 1/lev + MMR)` mengasumsikan
  notional = capital × leverage, padahal hanya `m` dari `gridCount+1` level
  terisi → menolak setup yang sebenarnya aman. Hitung dari exposure terisi nyata
  + margin tersisa.
- **G5** Dua definisi realized volatility berbeda — `fullPipeline.ts:232`
  (`sqrt(Σr²/n)`, tanpa kurang mean) vs `marketContext.ts:72`
  (sample variance) — menghasilkan label regime yang bisa **berbeda untuk pair &
  candle yang sama**, padahal keduanya jadi gate (`hardScreen` menolak BREAKOUT;
  `gridRiskEngine` REJECT saat `marketRegime === "BREAKOUT" && priceChange < 0`).
  Satukan ke `computeRealizedVolatility()` di `src/shared.ts:380`.

### 3.6 — K7: selesaikan konflik regime + hapus dead code
`src/pipelineEngine.ts` · `src/cron/gridSmartMoneyAdapter.ts` · `src/cron/smartMoneyPipelineEngine.ts`

| Regime | `REGIME_FAVORABILITY` (produksi) | `REGIME_SAFETY` (dead code) |
|---|---|---|
| ACCUMULATION | **0.9 — kondusif** | **30 — bahaya, pre-breakout** |
| DISTRIBUTION | **0.7 — kondusif** | **20 — bahaya** |

Keduanya di repo yang sama, salah satu pasti keliru, dan tidak ada dokumen yang
menengahi. Putuskan satu tabel, dokumentasikan alasannya, lalu **hapus atau
sambungkan**:

- `evaluateGridSmartMoney()` — `gridSmartMoneyAdapter.ts:131`
- `evaluateSmartMoneyEntry()` — `smartMoneyPipelineEngine.ts:113`

Keduanya lengkap dengan test tapi **tidak pernah dipanggil di produksi**
(`fullPipeline` hanya impor **tipe** `GridSmDecision`, lalu bikin aturan ad-hoc
inline di `fullPipeline.ts:967`). Rekomendasi: **hapus**, pertahankan
`calculateScenarioC` yang memang dipakai — dead code bertest memberi ilusi
cakupan.

### Gate Stage 3
`typecheck && test` hijau → PR → acc → Krakatau `d1 migrations apply --remote`
(0015) **lalu** `wrangler deploy` (**urutan ini wajib**) → amati distribusi
`rankingScore` sebelum vs sesudah, dan konsistensi label regime lintas menit cron
(:07 vs :52) untuk pair yang sama.

---

## Stage 4 — Backtest yang valid + observability + kalibrasi

Stage 1-3 memperbaiki logika. Stage 4 membuat perbaikan itu **bisa dibuktikan**.

### 4.1 — B3: agregasi di SQL, bukan 80 baris terbaru
`src/d1Client.ts` · `src/tools/pipelineDecisionBacktest.ts`

`MAX_ROWS = 80` dengan `ORDER BY run_at DESC` atas ~3.840 baris/hari berarti
permintaan "backtest 30 hari" hanya melihat **±20 menit dari satu-dua tick**.
Bukan sampel, bukan rentang.

Tambah `queryPipelineDecisionAggregates()` yang melakukan `COUNT` / `AVG` /
win-rate **di SQL, atas seluruh rentang**, memakai kolom `forward_return_*` yang
**sudah di-backfill** cron — sekarang tool mengabaikannya dan refetch klines per
baris, jadi lambat DAN terbatas. Nol fetch klines untuk agregat; tabel detail
tetap dibatasi 15 baris untuk tampilan.

### 4.2 — B4: metrik grid-native
`src/tools/pipelineDecisionBacktest.ts`

Directional long return bukan PnL grid: harga bisa +5% (return "menang")
sementara grid rugi karena keluar range ke atas. Dari klines 5m yang sudah
diambil di Stage 1.5 plus `lower_price` / `upper_price` / `stop_loss` yang
**sudah ada** di `pipeline_decision_log`, hitung on-demand (**tanpa migration**):

- `exitedRange` — ada candle high > upper atau low < lower
- `timeInRangePct`
- `gridCrossings` — jumlah traversal step (reuse pendekatan `computeGridVelocity()`)
- `slTouched` — sudah ada, dipertahankan

### 4.3 — Backfill cron: head-of-line blocking
`src/cron/pipelineDecisionOutcomeCron.ts` · `src/d1Client.ts:881`

`ORDER BY run_at ASC LIMIT 30` memilih ulang baris yang gagal permanen (symbol
delisted, klines kurang dari 25) **setiap tick sampai 14 hari**. Kalau ada ≥30
baris seperti itu, antrian **macet total** dan tidak ada baris baru yang pernah
di-backfill. Tambah penanda attempt supaya baris gagal berulang di-skip, bukan
memblokir.

### 4.4 — I7: buka dashboard
`ADMIN_SECRET` belum di-set → `/dashboard` dan `/api/dashboard/*` **selalu 403**
sejak Stage 4 lama. Krakatau `wrangler secret put ADMIN_SECRET` (gated) supaya
ada jalan melihat data selain `wrangler tail`.

### 4.5 — Kalibrasi dengan data nyata
Setelah ≥2 minggu data pasca-Stage-3: export dataset (perintah
`wrangler d1 execute --json` sudah terdokumentasi di header
`scripts/calibrate-ranking-weights.mjs`) → jalankan skrip → **review manual**.
Skrip sengaja tidak auto-apply.

Kandidat pertama yang dikalibrasi: bobot 35/30/20/15 · magnitudo penalti
`mmAdverse` (Stage 3.3) · `TRADE_RANKING_SCORE_THRESHOLD = 55` ·
`DCA_TIMING_TRADE_MIN = 75`.

---

## File yang disentuh (peta cepat)

| Area | File |
|---|---|
| Gate & format alert | `src/cron/entryAlertCron.ts` |
| Engine DCA | `src/dcaPipelineEngine.ts`, `src/cron/dcaSmartMoneyAdapter.ts` |
| Engine grid & ranking | `src/pipelineEngine.ts`, `src/gridRiskEngine.ts`, `src/gridVelocity.ts` |
| Orkestrasi | `src/tools/fullPipeline.ts` |
| Regime & helper | `src/tools/marketRegime.ts`, `src/toolHelpers.ts`, `src/marketContext.ts`, `src/shared.ts` |
| MM scoring | `src/tools/detectMmActivity.ts` |
| Pre-filter | `src/entryRanking.ts` |
| Transport | `src/retry.ts`, `src/binanceProxyClient.ts` |
| Relay (Krakatau deploy) | `proxy-standalone/handler.mjs` |
| Backtest | `src/tools/pipelineDecisionBacktest.ts`, `src/cron/pipelineDecisionOutcomeCron.ts`, `src/d1Client.ts` |
| Circuit | `src/engine/riskCircuitBreaker.ts` |
| Migration | `migrations/0015_mm_adverse_component.sql` (Stage 3) |

Setiap modul yang perilakunya berubah dapat `.test.ts` di sebelahnya (konvensi
test : source ~1:1).

> **Prioritas test baru: reachability test.** Inilah kelas test yang absen dan
> yang membuat semua cacat ini lolos 849 test hijau. Contoh pertanyaan yang harus
> dijawab test: *"dengan input apa pun dalam rentang valid, apakah `DCA_TRADE`
> bisa tercapai?"* · *"apakah `TREND_BREAKOUT` punya jalur hidup dari
> `runTriplePipelineForSymbol`?"*

---

## Verifikasi

**Per stage, sebelum handoff ke Rinjani (Semeru, lokal):**

```bash
npm run typecheck && npm test
```

**Lokal end-to-end tanpa deploy:**

```bash
npx wrangler dev
```

Lalu panggil `whalescope_full_pipeline` untuk pair yang diketahui memicu tiap
cabang, dan `whalescope_backtest_pipeline_decisions` dengan `forwardWindow=1h` —
sebelum Stage 1 hasilnya **selalu −0.12% / win rate 0%**; sesudahnya harus
bervariasi. Itu tes penerimaan paling tajam untuk B1.

**Live pasca-deploy (Krakatau lapor di chat, Semeru tulis ke plan file):**

- `wrangler tail | grep -E "entry-alert|hardscreen|429|418"`
- `entry_alert_run_log`: `dcaTradeCount` / `tradTradeCount` tidak lagi nol (Stage 2)
- Tidak ada alert DCA tanpa blok SL/leverage (Stage 1)
- Subrequest/invocation < 20.000 · wallTime < 15 menit · cpuTime < 30 detik
- Label regime konsisten untuk pair sama lintas tick :07 vs :52 (Stage 3)

---

## Yang sengaja TIDAK dikerjakan

- **Wire `aggTradesPaginator` ke cron** — terukur ~115 halaman/60 menit untuk
  BTCUSDT; 40 symbol/tick akan langsung memicu ban. Tetap standalone.
- **Spot klines untuk `slopeSpot` riil** — +1 call/symbol dan banyak perp tidak
  listed spot. Dicatat sebagai **deferred**, bukan dikarang (Stage 3.2).
- **Auto-tune bobot dari skrip kalibrasi** — skrip menghasilkan usulan untuk
  review manual, sesuai disiplin yang sudah ada di repo.
- **Relay REST ketiga / `ENTRY_WATCHLIST_SIZE` naik lagi** — backlog Krakatau
  yang sudah ada, tidak dicampur ke rencana ini.
