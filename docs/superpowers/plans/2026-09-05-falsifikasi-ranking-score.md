# Falsifikasi skor ranking grid — temuan & rencana uji

**Status:** rencana UJI, bukan rencana perbaikan. Tidak ada perubahan formula
yang diusulkan di sini, dan tidak boleh ada sampai Fase 0 selesai.

**[Semeru] 2026-09-05.** Plan file = Semeru only (konvensi CLAUDE.md). Cursor
lapor hasil di chat; Semeru yang menuliskannya ke sini.

**FASE 0 SELESAI 2026-09-05.** Export masuk, kelima hipotesis dijalankan atas
23.881 baris. Hasil + verdict: **Bagian D** di bawah. Ringkas: inversinya
NYATA (H1 gugur), penyebabnya orientasi skor yang terbalik pada keempat
komponen, dan **T7 terbukti SALAH** — komponen ternyata independen.

---

## Context

Kalibrasi bobot ranking Tier-1 dijadwalkan setelah ≥2 minggu data pasca
2026-09-04 (`scripts/calibrate-ranking-weights.mjs`, CLAUDE.md roadmap).
Sebelum itu dijalankan, muncul pertanyaan mendasar: **bagaimana bisa
mengkalibrasi sesuatu yang salah?**

Kalibrasi hanya menyembuhkan *estimation error* — parameter belum tepat pada
struktur yang benar. Ia tidak menyembuhkan *specification error*: label yang
salah, bentuk fungsi yang salah, fitur berkorelasi yang diperlakukan
independen, sampel yang terkondisi. Menambah data pada model yang salah
spesifikasi hanya menghasilkan angka salah yang lebih presisi — dan lebih
berbahaya, karena angka hasil fit kehilangan penanda "BELUM DIKALIBRASI" yang
selama ini membuatnya bisa digugat.

Maka urutannya dibalik: **falsifikasi dulu, kalibrasi belakangan** — dan hanya
kalau ada yang selamat dari falsifikasi. Dokumen ini mencatat apa yang sudah
terbukti, dan merumuskan apa yang masih harus diuji sebelum satu baris formula
pun disentuh.

Uji pertama sudah dijalankan 2026-09-05 lewat
`whalescope_backtest_pipeline_decisions` terhadap worker live. Hasilnya di
bawah.

---

## Bagian A — Temuan yang SUDAH terbukti

Dataset: `pipeline_decision_log` 2026-08-29 → 2026-09-04 11:52 UTC (pra-deploy
Stage 3). **23.881 baris, 23.111 punya outcome 24 jam (cakupan 96,8%).**
Tidak ada baris sebelum 2026-08-29.

### T1 — Ambang TRADE 55 praktis tak terjangkau

| Keputusan | N | Porsi |
|---|---|---|
| WATCH | 19.231 | 80,5% |
| NO_TRADE | 3.876 | 16,2% |
| **TRADE (skor ≥ 55)** | **4** | **0,0167%** |

Empat TRADE dalam enam hari. Konsisten dengan analisis struktural: skor
baseline nol-informasi ≈ 30 poin, dan hanya komponen mm supportive yang punya
headroom besar menuju 55. Bucket `gte_55` tidak akan pernah punya N yang cukup
untuk mengestimasi apa pun.

### T2 — Skor tidak memisahkan return

| Metrik | lt_40 (n=18.273) | 40_55 (n=4.834) | z |
|---|---|---|---|
| Win rate 24h | 57,26% | 56,45% | −1,00 |
| Avg return 24h | +1,984% | +1,929% | — |
| Win rate 4h | 53,51% | 49,77% | **−4,62** |

Pada 24 jam selisihnya tepat satu SE. Pada 4 jam signifikan dan **negatif**.

### T3 — Skor terbalik pada SL-touch (kuat, tapi lihat H1)

Stop-loss berada **di bawah batas bawah grid** (`gridBoundEngine`:
`lower − slExtraAtr×ATR − buffer%`). Menyentuhnya = harga menembus seluruh
grid ke bawah, kegagalan terburuk untuk long grid.

| Jendela | lt_40 | 40_55 | Rasio |
|---|---|---|---|
| Seluruh rentang (n=22.492) | 1,67% | 3,97% | 2,38× (**z = 7,75**) |
| 2026-09-04 00:00–12:00 | 5,58% | 13,02% | 2,33× |
| 2026-09-03 16:00–18:00 | 3,33% | 18,02% | 5,41× |

Tereproduksi di sub-jendela independen.

### T4 — Lapisan keputusan ikut terbalik

| Keputusan | SL-touch 24h | N |
|---|---|---|
| NO_TRADE | **0,64%** | 3.257 |
| WATCH | **2,42%** | 19.231 |

Rasio 3,76×, **z = 9,95**. Symbol yang pipeline TOLAK lebih jarang jebol
daripada yang ia rekomendasikan diperhatikan. Inversinya bukan cuma di skor,
tapi di hard-screen + grid-risk gate juga.

### T5 — Label kalibrasi salah, dan label yang benar dibuang

`calibrate-ranking-weights.mjs` melatih terhadap `forward_return_4h` (return
ARAH). Grid bot tidak menghasilkan dari arah, melainkan dari osilasi dalam
range. `evaluateGridOutcome()` sudah menghitung `exitedRange` /
`timeInRangePct` di `pipelineDecisionBacktest.ts`, tapi **tidak ada kolomnya di
migrations 0011–0016** — dihitung, ditampilkan, lalu dibuang. Data yang sedang
dikumpulkan untuk kalibrasi tidak akan mengandungnya.

### T6 — Bobot ≠ pengaruh

Skor nol-informasi ≈ 30 poin (mm 3,5 + smartMoney 15 + regime 6 + buyPressure
7,5 − adverse 1,65). Headroom realistis menuju 55:

| Komponen | Bobot nominal | Rentang pengaruh nyata |
|---|---|---|
| mm supportive | 35% | ~+26 poin |
| smartMoney | 30% | ~+15 poin |
| regime | 20% | ~+14 poin |
| **buyPressure** | **15%** | **~+2 poin** |

Pengaruh = bobot × simpangan baku komponen. Simpangan baku tidak pernah
diukur, jadi 35/30/20/15 menggambarkan niat, bukan perilaku.

### ~~T7 — Komponen bukan empat informasi~~ — **DICORET, TERBUKTI SALAH**

> **Dibantah H3 (Bagian D), 2026-09-05.** |ρ| maksimum antar komponen cuma
> **0,174**. Klaim di bawah diturunkan dari penalaran struktural, bukan
> pengukuran, dan datanya membantah. Dipertahankan di sini sebagai catatan
> supaya tidak diusulkan ulang.

~~CVD masuk ke mm supportive, regime, dan buyPressure. OI masuk ke mm
supportive, smartMoney, dan regime. Weighted-sum mengasumsikan independensi
yang tidak ada; saat CVD menyesatkan, ia menyesatkan tiga komponen sekaligus
dan skor terlihat makin yakin.~~

Pelajarannya: input bersama TIDAK otomatis berarti output berkorelasi.
Transformasi tiap komponen (bucket diskret, threshold, arah kondisi) ternyata
mendekorelasi CVD/OI yang mereka bagi.

### T8 — Batas bucket tidak sejajar dengan gate yang sesungguhnya (BARU)

`entryAlertCron.ts:152` — `isGridAlertWorthy()` mengirim alert WATCH pada
**rankingScore ≥ 50**. Tapi bucket backtest adalah `lt_40 / 40_55 / gte_55`.
Batas 50 — satu-satunya yang menentukan apa yang sampai ke manusia — **tidak
pernah diukur oleh analisis mana pun.**

### T9 — Dua dari tiga head tidak pernah diukur sama sekali (BARU)

`entryAlertCron.ts:482` — `decisionLog: toPipelineDecisionLogRow(r.grid, …)`.
Hanya head **grid** yang ditulis ke `pipeline_decision_log`. Head DCA dan
Traditional menghasilkan keputusan dan mengirim alert tapi **nol logging
outcome**. `dca_active_plans` adalah state rencana berjalan, bukan pengukuran
hasil.

### T10 — Dataset terkondisi oleh filter yang mau dievaluasi

`entry_alert_skip_log` (migration 0007) menyimpan nama symbol yang dibuang
pre-filter — tanpa outcome. 310 pair per tick tidak punya kontrafaktual, jadi
kalibrasi hanya bisa mengoptimalkan di dalam wilayah yang sudah dipilih F3.

### T11 — Data pasca-deploy belum matang (bukan bug)

4.120 baris sejak deploy Stage 3, `rowsWithOutcome: 0`. Baris terbaru berumur
23,5 jam vs ambang kematangan 26 jam. Normal. Outcome pertama matang sekitar
2026-09-05 14:00 UTC (21:00 WIB). `mm_adverse_component` hanya terisi di baris
pasca-deploy, jadi analisis apa pun yang memerlukannya harus menunggu.

---

## Bagian B — Hipotesis yang HARUS diuji sebelum ada perbaikan

Tiap hipotesis punya **kriteria bunuh**: hasil yang membuat saya membuangnya.
Tanpa itu ini bukan uji, cuma pencarian pembenaran.

### H1 — Inversi T3/T4 adalah artefak jarak stop-loss, bukan mutu grid

**Ini yang paling penting, dan bisa membatalkan T3 dan T4 sekaligus.**

`sl_touched_24h` tidak dinormalisasi terhadap jarak SL. SL diturunkan dari ATR,
jadi symbol bervolatilitas rendah punya SL yang secara mekanis lebih **rapat**
dan lebih mudah tersentuh — tanpa berarti setupnya lebih buruk. Kalau skor
tinggi berkorelasi dengan volatilitas rendah, seluruh inversi bisa jadi
artefak geometri, bukan temuan.

- **Uji:** dari kolom yang SUDAH dipersist, hitung `rangeWidthPct =
  (upper_price − lower_price) / lower_price` dan `slGapPct = (lower_price −
  stop_loss) / lower_price`. Bandingkan rerata keduanya lintas bucket skor.
  Lalu hitung ulang SL-touch **terkondisi desil `slGapPct`** — kalau inversinya
  bertahan di dalam tiap desil, ia nyata.
- **Data:** cukup kolom existing, tidak perlu instrumentasi baru.
- **Kriteria bunuh H1:** kalau `slGapPct` tidak berbeda bermakna lintas bucket
  (selisih rerata < 0,5 SD) DAN inversi bertahan di dalam desil → H1 gugur,
  T3/T4 berdiri.
- **Kalau H1 benar:** T3/T4 dicoret sebagai temuan, dan uji harus diulang
  dengan metrik grid-native yang dinormalisasi.

### H2 — Tidak satu pun dari 4 komponen punya daya pisah univariat

Skor komposit gagal, tapi mungkin satu komponen membawa sinyal yang tenggelam
oleh tiga lainnya.

- **Uji:** untuk tiap komponen (`mm_component`, `smart_money_component`,
  `regime_component`, `buy_pressure_component`), bagi ke desil dan ukur
  SL-touch + win rate per desil. Cari monotonisitas, bukan cuma selisih ujung.
- **Kriteria bunuh:** komponen dengan tren monotonik dan z > 3 setelah koreksi
  Bonferroni (4 komponen × 2 metrik = 8 uji → ambang α/8) **diselamatkan**;
  sisanya kandidat dibuang.
- **Catatan:** `mm_component` pra-deploy bersemantik LAMA (gabungan 6 sinyal).
  Jangan campur dengan pasca-deploy — `assertSingleMmSemantics()` sudah
  menegakkan ini di skrip kalibrasi, prinsip yang sama berlaku di sini.

### H3 — Komponen terlalu kolinear untuk bobot bisa diidentifikasi

- **Uji:** matriks korelasi Spearman antar 4 komponen atas 23k baris.
- **Kriteria bunuh:** semua |ρ| < 0,3 → H3 gugur, weighted-sum masih bentuk
  yang sah.
- **Kalau |ρ| > 0,6 pada pasangan mana pun:** bobot pasangan itu tidak
  identifiable dari data sebanyak apa pun; solusinya menggabung/membuang
  komponen, bukan mengkalibrasi.

### H4 — Ambang dispatch 50 juga tidak memisahkan (T8 belum diukur)

- **Uji:** bucket ulang di batas 45 / 50 / 55 dan ukur SL-touch + win rate.
- **Kriteria bunuh:** ada diskontinuitas nyata di 50 → ambangnya kebetulan
  bermakna dan patut dipertahankan.

### H5 — Distribusi skor bergerombol sehingga ambang mana pun sewenang-wenang

Skor adalah tumpukan fungsi tangga (absorption ∈ {0,1; 0,5; 0,7–1,0};
smartMoney confidence kelipatan 0,2), jadi hanya beberapa lusin nilai yang
mungkin.

- **Uji:** histogram `ranking_score` resolusi 1 poin atas 23k baris.
- **Kriteria bunuh:** distribusi mulus dan unimodal → H5 gugur.
- **Kalau bergerombol:** menggeser ambang dari 55 ke 52 bisa tidak mengubah
  apa pun, atau mengubah segalanya — dan itu menjelaskan T1 lebih dalam.

### H6 — Head DCA & Traditional sama rusaknya, tapi tidak terlihat (T9)

**DI LUAR LINGKUP Fase 0** (keputusan user 2026-09-05: fokus grid dulu).

Tidak bisa diuji sekarang: **tidak ada datanya sama sekali.** Ini bukan
hipotesis yang gagal diuji, ini lubang instrumentasi. Dicatat supaya tidak
terlupa, dan supaya tidak ada yang mengira dua head itu "baik-baik saja" —
mereka cuma tidak terukur. Masuk Fase 1.

---

## Bagian C — Rencana eksekusi

### Fase 0 — Falsifikasi atas data yang sudah ada (TIDAK ada perubahan formula)

Semua H1–H5 bisa dijawab dari kolom yang sudah dipersist. Tidak perlu deploy,
tidak perlu migration, tidak perlu menunggu dua minggu.

Lingkup: **head grid saja** (keputusan user 2026-09-05). Head DCA &
Traditional tidak punya data berlabel, jadi memasukkannya hanya melebarkan
lingkup tanpa menambah temuan.

**Jalur data — meniru pola `calibrate-ranking-weights.mjs` yang sudah ada**
(keputusan user 2026-09-05: export Krakatau + analisis offline, BUKAN query
langsung dari sesi Claude, BUKAN perluasan tool + deploy): skrip offline
menerima export JSON, tidak menyentuh D1/kredensial sendiri.

1. **[Krakatau, butuh acc user]** satu perintah read-only. Direktori tujuan
   harus ada lebih dulu -- redirect shell tidak membuatnya, dan PowerShell
   gagal dengan `DirectoryNotFoundException`:
   ```
   mkdir .tmp-falsifikasi          # PowerShell: New-Item -ItemType Directory -Force .tmp-falsifikasi
   npx wrangler d1 execute binance-future-hunter-db --remote --json \
     --command "SELECT run_at, symbol, decision, ranking_score,
       hard_screen_passed, mm_component, smart_money_component,
       regime_component, buy_pressure_component, mm_adverse_component,
       lower_price, upper_price, stop_loss,
       forward_return_4h, forward_return_24h, sl_touched_24h
       FROM pipeline_decision_log
       WHERE run_at < 1788522720000" > .tmp-falsifikasi/dataset.json
   ```
   (`run_at < 1788522720000` = pra-deploy Stage 3, semantik mm seragam.)

2. **[Semeru]** `scripts/falsify-ranking-score.mjs` — Node built-in saja, nol
   dependency baru (aturan repo). Mengonsumsi JSON di atas dan mengeluarkan:
   - histogram skor resolusi 1 poin (H5)
   - matriks korelasi Spearman antar komponen (H3)
   - SL-touch & win rate per desil tiap komponen, dengan koreksi Bonferroni (H2)
   - rerata `rangeWidthPct` / `slGapPct` per bucket, lalu SL-touch terkondisi
     desil `slGapPct` (H1 — **dijalankan pertama**, karena bisa membatalkan
     T3/T4)
   - bucket ulang di 45/50/55 (H4)
   - menolak dataset campuran semantik mm, meniru `assertSingleMmSemantics()`

3. **[Semeru]** laporkan hasil ke dokumen ini sebagai Bagian D, dengan
   kriteria bunuh tiap hipotesis dijawab eksplisit ya/tidak.

### Gate keputusan

**Tidak ada perbaikan formula yang dirancang sampai Bagian D terisi.** Hasil
Fase 0 menentukan mana dari tiga jalan yang diambil, dan itu keputusan
terpisah yang diajukan ke user:

- H1 benar → T3/T4 gugur, uji diulang dengan metrik grid-native ternormalisasi
- H2 menyelamatkan ≥1 komponen → struktur diciutkan ke komponen itu saja
- H2 tidak menyelamatkan apa pun → skor komposit dibuang; rujukan bentuk
  pengganti sudah ada di repo sendiri (`institutionalFlow.ts:14` — "N dari M
  sinyal align" + flag confidence, yang secara eksplisit menolak meringkas
  sinyal heterogen jadi satu angka berbobot)

### Fase 1 — Instrumentasi (sesudah Fase 0, diajukan terpisah)

Bukan perbaikan formula, melainkan menutup lubang pengukuran:
- migration: persist `exited_range` / `exited_below` / `time_in_range_pct` ke
  `pipeline_decision_log`, diisi `pipelineDecisionOutcomeCron` yang **sudah
  memegang candle-nya** → nol fetch tambahan
- logging outcome untuk head DCA & Traditional (T9)
- outcome untuk sampel symbol yang di-skip pre-filter (T10)

---

## Sudah dikerjakan (2026-09-05, di working tree, BELUM di-deploy)

### `scripts/falsify-ranking-score.mjs` + test — SIAP JALAN

Mengonsumsi export JSON dan menjawab H1–H5 dengan kriteria bunuh yang
dievaluasi otomatis jadi VERDICT. Nol dependency npm baru. `unwrapDataset()`
dan `assertSingleMmSemantics()` di-REUSE dari `calibrate-ranking-weights.mjs`,
bukan disalin.

Tujuh penjaga keputusan diuji-mutasi satu per satu — tiap ambang dirusak,
dipastikan ada test yang gagal, lalu dipulihkan:

| Mutasi | Tertangkap |
|---|---|
| OR Mantel-Haenszel `> 1` → `>= 0` | ya (setelah test isolasi ditambah) |
| syarat konsistensi arah dihapus | ya (setelah test isolasi ditambah) |
| ambang konfound `0.5 SD` → `999` | ya (setelah test isolasi ditambah) |
| Bonferroni `> 2.734` → `> 0` | ya (setelah test isolasi ditambah) |
| syarat monotonik `0.7` → `-1` | ya |
| minimum stratum `3` → `0` | ya |
| Spearman abaikan tie | ya |

Empat di antaranya semula LOLOS — verdict-nya sudah dijatuhkan oleh syarat
lain sebelum ambang itu sempat menentukan apa pun. Test isolasi ditambahkan
untuk masing-masing. Ini persis alasan uji mutasi wajib: 23 test hijau di
percobaan pertama tidak membuktikan satu pun ambang itu berfungsi.

Satu guard lahir dari smoke test CLI, bukan dari rancangan: kalau `slGapPct`
banyak nilai kembar, pembagian kuantil menghasilkan stratum berisi SATU
kelompok skor saja, dan verdict akan percaya diri di atas 4 dari 10 stratum.
Sekarang ditolak eksplisit sebagai "stratifikasi terlalu tipis".

### `summarizeGridOutcomesByScoreBucket()` di
`src/tools/pipelineDecisionBacktest.ts` — tabulasi silang metrik grid × bucket
skor, plus tabel output dan field struct `gridOutcomeByScoreBucket`.

Catatan jujur yang ditulis di kode dan wajib dibaca bareng angkanya: tabel itu
**lemah secara statistik**. Sampel detail diambil sebagai "N baris terbaru" dan
satu tick entry-alert menulis puluhan baris, jadi `limit ≤ 80` dalam praktiknya
= 1–2 tick. Dikonfirmasi di data live: 15 baris dari satu panggilan semuanya
ber-`run_at` identik. Baris satu tick bukan observasi independen. Peringatan ini
masuk ke note output supaya tabel baru tidak menyesatkan seperti tabel lama.

Verifikasi keseluruhan: `npm run typecheck` bersih; `npm test` 99 file / 1004 test lulus;
test baru diuji-mutasi (grouping dirusak → 2 test gagal → dipulihkan).

---

## Verifikasi Fase 0

- `node scripts/falsify-ranking-score.mjs .tmp-falsifikasi/dataset.json`
  menghasilkan keenam blok output di atas tanpa error
- `npm run typecheck && npm test` tetap hijau (skrip punya test sendiri,
  pola `calibrate-ranking-weights.test.mjs`)
- tiap kriteria bunuh dijawab eksplisit di Bagian D — hipotesis yang tidak
  terbunuh maupun terkonfirmasi ditandai "tidak konklusif", bukan didiamkan
- angka yang dilaporkan disertai N dan z, bukan persentase telanjang

---

## Bagian D — HASIL Fase 0 (2026-09-05)

Dataset: export pra-deploy Stage 3, **23.881 baris, 0 di-drop**.
Perintah: `node scripts/falsify-ranking-score.mjs .tmp-falsifikasi/dataset.json`

> Kolom komponen hanya terisi di **7.521 baris** — migration 0014 baru, dan
> baris yang gagal hard-screen tidak pernah sampai `scoreTier1Signals()`.
> H2/H3 berdiri di atas 7.521, bukan 23.881. H1/H4/H5 memakai seluruh baris.

### H1 — GUGUR. Inversi NYATA, bukan artefak jarak stop-loss

| | skor < 40 | skor ≥ 40 |
|---|---|---|
| jarak SL rata-rata | 3,47% | 3,59% |
| lebar range | 15,71% | 15,53% |
| SL-touch tanpa koreksi | 1,72% | 4,07% (z = 7,87) |

Selisih jarak SL cuma **0,052 SD** — konfound yang saya khawatirkan praktis
tidak ada. Setelah distratifikasi 10 desil jarak SL, **odds ratio
Mantel-Haenszel = 1,944**.

**T3 dan T4 BERDIRI.** Hipotesis penyelamat saya sendiri gagal.

**Peringatan margin — wajib dibaca:** guard konsistensi arah lolos di
**6/10 = 0,60, tepat di ambang 0,60**. Satu stratum berbalik saja dan
verdict-nya jadi TIDAK KONKLUSIF. Meringankan: desil 2 dan 3 punya NOL
kejadian di kedua kelompok (0,00% vs 0,00%) sehingga tidak membawa informasi
arah apa pun, tapi tetap dihitung sebagai "tidak konsisten". Di antara 8
stratum yang informatif, arahnya konsisten **6/8 = 0,75**. Efeknya juga
heterogen (desil 8 berbalik: 6,70% vs 5,33%), dan Mantel-Haenszel
mengandaikan homogenitas — jadi OR 1,944 adalah ringkasan kasar, bukan
estimasi presisi.

### H2 — GUGUR SEBAGIAN, TAPI TERBALIK

| komponen | bobot | tren SL (ρ) | z ujung SL | tren win | z ujung win | status |
|---|---|---|---|---|---|---|
| mm | 35% | +0,442 | −0,16 | −0,164 | −3,13 | dibuang |
| smartMoney | 30% | **+0,899** | **8,87** | −0,782 | **−23,73** | TERBALIK |
| regime | 20% | **+0,842** | **6,76** | +0,236 | 0,69 | TERBALIK |
| buyPressure | 15% | +0,383 | 3,09 | +0,273 | 0,90 | dibuang |

Dua komponen punya daya pisah kuat dan lolos Bonferroni — **dengan tanda
terbalik**. Nilai `smartMoney` makin tinggi → SL-touch makin sering (ρ = 0,90)
DAN win rate makin rendah (z = −23,73). `regime` sama arahnya.

**Dan keempat komponen menunjuk arah adverse yang sama** (ρ semuanya
positif). Itu bukan empat kebetulan terpisah — itu orientasi skornya yang
terbalik secara sistematis.

Konfirmasi T6 dari sisi data: `mm`, komponen berbobot TERBESAR (35%), punya
z ujung −0,16 — **nol daya pisah**. Bobot terbesar diberikan ke komponen yang
tidak memisahkan apa pun, sementara 50% bobot (smartMoney + regime) diberikan
ke dua komponen yang memisahkan ke arah yang salah.

> **Catatan proses:** kriteria bunuh H2 seperti ditulis semula hanya menguji
> KEKUATAN dan MONOTONISITAS, tidak menguji ARAH — sehingga melabeli keduanya
> "SELAMAT", yang terbaca sebagai "layak dipertahankan". Skrip diperbaiki
> 2026-09-05 untuk memisahkan "berguna apa adanya" dari "TERBALIK". Cacat
> kriteria, bukan cacat data.

### H3 — GUGUR. Komponen ternyata INDEPENDEN — **T7 SALAH**

| pasangan | ρ |
|---|---|
| mm × buyPressure | 0,174 |
| smartMoney × regime | 0,087 |
| regime × buyPressure | −0,039 |
| mm × regime | 0,013 |
| smartMoney × buyPressure | −0,007 |
| mm × smartMoney | −0,002 |

|ρ| maksimum **0,174** — jauh di bawah ambang 0,3.

**T7 DICORET.** Saya menyimpulkan komponen berkorelasi dari penalaran
struktural (CVD masuk ke tiga komponen, OI ke tiga), dan datanya membantah:
transformasi masing-masing komponen ternyata mendekorelasi input bersama itu.
Bobotnya identifiable, dan weighted-sum tetap bentuk yang sah.

Konsekuensi penting: masalahnya **bukan** struktur. Masalahnya TANDA dan
BOBOT.

### H4 — BERDIRI. Ambang 50 tidak memisahkan

| bucket | N | SL-touch | win 24h |
|---|---|---|---|
| lt_45 | 23.190 | 2,14% | 57,97% |
| 45_50 | 631 | 4,86% | 55,92% |
| 50_55 | 53 | 8,51% | 51,06% |
| gte_55 | 7 | 0,00% (n=6) | 66,67% |

Lompatan tepat di 50: z = 0,88 — tidak signifikan (N di atas 50 cuma 53).
Ambang 50 tidak istimewa.

Tapi perhatikan **gradiennya**: SL-touch naik monoton 2,14% → 4,86% → 8,51%
seiring skor naik, dan win rate turun 57,97% → 55,92% → 51,06%. Konsisten
dengan H1 dan H2: bukan ambangnya yang salah tempat, melainkan seluruh sumbu
skornya yang mengarah ke sisi yang salah.

### H5 — BERDIRI. Distribusi bergerombol

2.112 nilai berbeda dari 23.881 baris; **77% massa di 10 bin**; **27 dari 62
bin kosong**. Massa terkonsentrasi di skor 31–42, puncak di 35–37.

Menjelaskan T1 lebih dalam: ambang 55 bukan cuma tinggi, ia berada di ekor
yang nyaris tak berpenghuni. Menggeser ambang di dalam rentang 31–42 akan
mengubah banyak hal sekaligus; di atas 45 nyaris tidak mengubah apa pun.

### Ringkasan verdict

| Hipotesis | Verdict | Akibat |
|---|---|---|
| H1 konfound SL | **GUGUR** (margin tipis) | T3/T4 berdiri — inversi nyata |
| H2 tidak ada komponen berdaya pisah | **GUGUR SEBAGIAN, TERBALIK** | smartMoney & regime kuat tapi tandanya salah |
| H3 kolinearitas | **GUGUR** | **T7 dicoret — saya salah** |
| H4 ambang 50 | **BERDIRI** | 50 tidak istimewa; gradiennya yang adverse |
| H5 pergerombolan | **BERDIRI** | ambang di ekor kosong |

### Apa yang berubah untuk Fase berikutnya

Gate keputusan di Bagian C menyebut tiga jalan. Data memilih jalan yang
**tidak** ada di daftar itu, dan hasilnya lebih baik dari dugaan:

Struktur weighted-sum-nya SEHAT (H3 gugur — komponen independen, bobot
identifiable). Yang rusak adalah **orientasi**: keempat komponen memprediksi
kegagalan, dua di antaranya dengan kekuatan besar. Jadi skor ini bukan
"tidak informatif" — ia informatif dan dipasang terbalik.

**JANGAN langsung membalik tanda.** Membalik koefisien berdasarkan data
in-sample yang sama adalah persis overfitting yang membuat kita sampai di
sini. Yang dibutuhkan sebelum perubahan apa pun:

1. **Replikasi out-of-sample** — data pasca-deploy Stage 3 (mulai matang
   2026-09-05 14:00 UTC) belum pernah dilihat model mana pun. Kalau arah
   adverse-nya berulang di sana, barulah ia temuan; kalau tidak, ini artefak
   satu rezim pasar enam hari.
2. **Label grid-native** (Fase 1) — seluruh Bagian D bersandar pada
   `sl_touched_24h` dan return arah. Keduanya proxy. `exited_range` /
   `time_in_range_pct` adalah ukuran yang sebenarnya, dan masih belum
   dipersist.
3. **Cari mekanismenya** — kenapa `smartMoney` tinggi menandakan grid jebol?
   Hipotesis yang perlu diuji: `BULLISH_ACCUMULATION` + confidence tinggi
   muncul justru saat OI menumpuk cepat dan CVD condong — yaitu prakondisi
   breakout, yang untuk grid adalah risiko, bukan berkah. Ini persis
   penalaran K7 (ACCUMULATION/DISTRIBUTION = pre-breakout) yang sudah
   diterapkan ke tabel regime tapi TIDAK ke komponen smart money.

Poin 3 layak diperiksa lebih dulu: kalau mekanismenya sama dengan K7, maka
perbaikannya bukan "balik tandanya" melainkan koreksi semantik yang sudah
punya preseden di repo ini.

---

## Bagian E — Mekanisme inversi (2026-09-05, lanjutan Fase 0)

Menjawab poin 3 di akhir Bagian D: **kenapa** komponen-komponen itu terbalik.
Analisis kode + data yang sama (`.tmp-falsifikasi/mech.mjs`, scratch, tidak
di-commit). n = 7.284 baris yang punya komponen + SL + geometri.

### E1 — `smartMoneyComponent` SATU SISI: tidak pernah bisa mengurangi skor

`scoreLongLiquidationRisk()` mensyaratkan `globalAccountRatio > 1.8`. Dalam
7.284 baris, kondisi itu **TIDAK PERNAH SEKALI PUN** terpenuhi:

| region komponen | arti | n |
|---|---|---|
| < 50 | LONG_LIQUIDATION_RISK | **0** |
| = 50 | NEUTRAL / confidence nol | 6.774 |
| 50–70 | bullish, confidence rendah | 404 |
| > 70 | bullish, confidence tinggi | 106 |

`smartMoneyComponent` = `(directional + 100) / 2`, dan cabang negatifnya mati.
Jadi komponen berbobot **30%** ini secara struktural hanya bisa **menaikkan**
skor, tidak pernah menurunkannya. Cabang "warning"-nya ada di kode, punya
test, dan tidak pernah dieksekusi di produksi.

### E2 — Dan saat ia aktif, ia menandai BAHAYA, bukan peluang

| region | SL-touch | z vs NEUTRAL | rasio |
|---|---|---|---|
| = 50 NEUTRAL | 2,49% | — | — |
| 50–70 bullish conf rendah | **10,15%** | 5,06 | 4,08× |
| > 70 bullish conf tinggi | **18,87%** | 4,30 | 7,58× |

Dose-response monotonik: makin yakin sinyalnya, makin sering grid jebol.
Dan ini **bukan** artefak geometri — `rho(smartMoney, slGapPct) = 0,004`,
jarak SL rata-rata praktis sama di ketiga region (3,53% / 3,84% / 3,08%).
Setelah stratifikasi jarak SL: **MH OR = 4,411** (mentah z = 6,53).

Hanya 7,0% baris yang punya smartMoney aktif — kecil, tapi justru 7% itulah
yang skornya terdorong naik menuju ambang alert.

### E3 — Mekanismenya: ini K7 yang belum diterapkan ke smart money

`scoreBullishAccumulation()` mensyaratkan `oiDeltaPct > 0`, dan
`core3 = oiIncreaseScore(oiDeltaPct)` menaikkan confidence sebanding laju
kenaikan OI (saturasi di +5%). Artinya: **makin cepat OI menumpuk, makin
tinggi confidence, makin tinggi skor.**

Bandingkan dengan penalaran K7 yang SUDAH diterapkan ke tabel regime
(`pipelineEngine.ts:285`):

> ACCUMULATION = CVD buy dominan + **OI NAIK** + harga FLAT … "posisi sedang
> dibangun sementara harga belum bergerak — energi yang menumpuk untuk keluar
> dari range. Untuk grid yang bertaruh harga TETAP di dalam range, itu risiko,
> bukan berkah." → favorability diturunkan 0,9 → 0,6.

Fenomena yang **sama persis** — akumulasi posisi tanpa pergerakan harga —
dikenali dan dikoreksi di tabel regime, tapi dibiarkan utuh di komponen smart
money, di mana ia justru menyumbang bobot terbesar kedua (30%) dengan tanda
positif penuh.

Jadi perbaikannya bukan "balik koefisien dari hasil fit" melainkan **koreksi
semantik yang sudah punya preseden di repo ini**. Itu jauh lebih bisa
dipertahankan, dan tidak bergantung pada dataset in-sample yang sama.

### E4 — `regime` terbalik juga, tapi mekanismenya BELUM jelas

| desil regime | SL-touch | slGap% | rangeWidth% |
|---|---|---|---|
| 1 (≈25) | 0,00% | 3,14 | 13,70 |
| 5 (≈36) | 3,57% | 3,22 | 14,84 |
| 10 (≈63) | 5,90% | 3,54 | 13,99 |

Naik hampir monoton. `rho(regime, slGapPct) = 0,159` — konfound geometri kecil
tapi tidak nol, dan lebar range tidak menunjukkan tren, jadi bukan sekadar
"bound lebih sempit". MH OR = 1,549.

Komponen regime tinggi ≈ RANGING dengan ADX rendah (`rangingConfidence =
0.5 + (20 − adx)/40`). Jadi temuannya: **pasar yang paling tenang justru
paling sering menjebol grid.** Hipotesis yang belum diuji: volatility
clustering — periode tenang tak biasa mendahului ekspansi volatilitas. Itu
konsisten dengan keluarga penalaran K7, tapi **jangan diperlakukan sebagai
kesimpulan** sampai diuji terpisah.

### E5 — `mm` justru komponen yang paling terkonfound geometri

`rho(mm, slGapPct) = 0,245` dan `rho(mm, rangeWidthPct) = 0,234` — tertinggi
dari keempatnya. MH OR-nya paling kecil (1,287). Konsisten dengan H2: mm
memang komponen dengan daya pisah paling lemah, dan sebagian dari yang sedikit
itu pun geometris.

### Peringatan metodologis untuk Bagian E

Konsistensi arah antar stratum hanya **4/10** untuk smartMoney, regime, dan
mm. Itu di bawah ambang 0,6 yang dipakai H1. Penyebabnya SL-touch adalah
kejadian jarang (baseline ~2,5%), sehingga banyak stratum berisi nol kejadian
di kedua kelompok dan tidak membawa informasi arah. Bukti terkuat E2 karena
itu **bukan** MH OR-nya, melainkan dose-response tiga tingkat di tabel E2 yang
tidak memerlukan stratifikasi sama sekali.

### Status uji out-of-sample

Dicek 2026-09-05: 4.280 baris pasca-deploy, `rowsWithOutcome: 0`. Ambang
kematangan 26 jam baru terlampaui ~13:52 UTC (20:52 WIB) untuk baris paling
awal. **Belum bisa diuji.** Jangan mengambil keputusan formula apa pun
sebelum ini ada.

---

## Bagian F — Fase 1 (instrumentasi) — SELESAI di working tree, BELUM di-deploy

**[Semeru] 2026-09-05.** Menutup T5: label grid-native sekarang dipersist,
bukan dihitung lalu dibuang.

### Yang berubah

| File | Perubahan |
|---|---|
| `migrations/0017_pipeline_decision_grid_outcome.sql` | 5 kolom baru, semua NULLABLE |
| `src/d1Client.ts` | `PendingPipelineDecisionOutcomeRow` + `lowerPrice`/`upperPrice`; SELECT ikut mengambilnya; `PipelineDecisionOutcomeUpdate` + 5 field grid; UPDATE menulisnya |
| `src/cron/pipelineDecisionOutcomeCron.ts` | panggil `evaluateGridOutcome()` atas candle YANG SUDAH di-fetch |

Kolom: `grid_exited_range`, `grid_exited_above`, `grid_exited_below`,
`grid_time_in_range_pct`, `grid_crossing_rate`. Jendela 24 jam, identik
dengan `sl_touched_24h`, supaya keduanya bisa dibandingkan langsung.

### Tiga keputusan desain yang perlu diketahui

**Nol fetch tambahan.** Cron sudah menarik 289 candle 5m per baris untuk
`forward_return_*`. `evaluateGridOutcome()` memakai array yang sama. Diuji
eksplisit: `expect(getKlinesNative).toHaveBeenCalledTimes(1)`.

**`evaluateGridOutcome()` DI-REUSE, bukan diimplementasi ulang.** Kolom yang
dipersist wajib bernilai sama dengan yang dihitung tool on-demand untuk baris
yang sama. Dua implementasi = dua definisi "keluar range" yang bisa menyimpang
diam-diam — persis kesalahan yang pernah terjadi pada window 1h (B1/B2).

**NULL ≠ 0.** Field grid di `PipelineDecisionOutcomeUpdate` dibuat WAJIB
(bukan optional) supaya tiap caller memutuskan eksplisit. NULL = tidak
diukur (bound tidak ada / degenerate / baris pra-0017); `false`/0 = diukur,
grid bertahan. Kalau keduanya tertukar, agregat SQL akan membaca ribuan baris
NO_TRADE tanpa bound sebagai "grid sukses".

### Uji mutasi — tiga penjaga, satu celah yang awalnya lolos

| Mutasi | Tertangkap |
|---|---|
| `evaluateGridOutcome()` tidak dipakai (grid selalu null) | ya |
| `boolToDb` tanpa cek null (false dan null jadi sama) | ya |
| `lower_price`/`upper_price` dicabut dari SELECT | **awalnya TIDAK** |

Mutasi ketiga lolos dan itu celah berbahaya: tanpa kolom bound di SELECT,
`row.lowerPrice` jadi `undefined`; `evaluateGridOutcome()` memakai `== null`
sehingga `undefined` lolos sebagai "tidak ada bound" dan mengembalikan null.
Hasilnya kolom grid NULL untuk SETIAP baris selamanya — dan cron tetap
melaporkan `updated > 0`, jadi tidak ada satu pun sinyal bahwa ia rusak.
Test penahannya ditambahkan di `d1Client.pipelineDecisionOutcomes.test.ts`.

Fake D1 di test juga dinaikkan disiplinnya: klausa SET sekarang DIBACA dari
SQL (nama kolom di-parse, lalu di-zip dengan argumen) alih-alih posisi
di-hardcode. Daftar posisi akan diam-diam menulis nilai ke kolom yang salah
begitu urutan kolom bergeser — hijau, tapi bohong.

Verifikasi: `npm run typecheck` bersih; `npm test` **99 file / 1015 test**.

### Handoff Krakatau (butuh acc user, BELUM dijalankan)

```
npx wrangler d1 migrations apply binance-future-hunter-db --remote
npx wrangler deploy
```

Migration 0017 murni `ALTER TABLE ADD COLUMN` nullable — tidak menulis ulang
baris lama, tidak mengunci tabel lama, aman untuk tabel 28k baris.

**Kolom baru hanya terisi untuk baris yang `forward_return_24h`-nya masih
NULL** saat cron berjalan (itu predikat antrian backfill). Baris pra-deploy
yang sudah punya outcome TIDAK akan diisi ulang — jadi jam nol data
grid-native adalah saat deploy, bukan mundur ke 2026-08-29. Itu konsekuensi
yang diterima; mengisi ulang 23k baris berarti 23k fetch klines.

### Belum dikerjakan (sengaja)

Sisi BACA-nya. `queryPipelineDecisionAggregates()` belum mengagregasi kolom
grid, jadi tabel grid-native di tool masih memakai sampel detail 1–2 tick.
Ditunda karena agregat atas kolom yang 100% NULL tidak bisa diuji terhadap
data nyata — dikerjakan setelah cron mengisi beberapa hari. Keduanya toh
butuh deploy yang sama.

---

## Bagian G — Remediasi + monitor otomatis (2026-09-05, di working tree)

Keputusan user yang mengikat pekerjaan ini: monitor **lapor saja**, formula
**dibekukan** sampai replikasi out-of-sample, pass pertama dua cek.

Konsekuensinya dijaga: **nol angka** di `scoreTier1Signals()`,
`REGIME_FAVORABILITY`, `TRADE_RANKING_SCORE_THRESHOLD`, atau
`smartMoneyAnalysis.ts` yang berubah.

### G1 — Bucket disejajarkan ke gate sesungguhnya (menutup T8)

`lt_40 / 40_55 / gte_55` → **`lt_40 / 40_50 / 50_55 / gte_55`**.

Batas 50 adalah gate alert yang sebenarnya (`isGridAlertWorthy`), dan selama
ini duduk di TENGAH bucket `40_55` — jadi setiap analisis backtest melaporkan
angka untuk pita yang tidak dipakai siapa pun mengambil keputusan.

Dua pengaman struktural, bukan sekadar penggantian angka:

**Label diturunkan dari ambangnya** lewat template literal, tidak ditulis
tangan. Komentar lama memperingatkan "kalau threshold diubah, label wajib
ikut diubah — kalau tidak output akan berbohong". Sekarang label itu tidak
bisa lagi berbohong.

**Test invarian** meng-import `WATCH_MIN_ALERT_SCORE` dari `entryAlertCron.ts`
dan menegaskan ia sama dengan `SCORE_BUCKET_DISPATCH_MIN`. Produksi tetap
bebas dependensi (mapper murni tidak boleh bergantung ke layer cron), tapi
keduanya tidak bisa lagi bergeser sendiri-sendiri tanpa suite merah.

### G2 — Metrik grid diagregasi di SQL (menutup sisa Fase 1)

`queryPipelineDecisionAggregates()` kini juga mengagregasi kolom migration
0017. Tabel grid per bucket di tool berhenti memakai sampel detail 1–2 tick
dan memakai seluruh rentang — peringatan korelasi intra-tick dicabut karena
sebabnya hilang.

**`gridKnown` adalah penyebutnya, BUKAN `sampleSize`.** Kolom grid NULL
berarti tidak diukur (keputusan tanpa bound + semua baris pra-0017);
memasukkannya ke penyebut membuat tingkat "keluar range" terlihat jauh lebih
aman dari kenyataan. Diuji-mutasi: mengganti penyebut ke `sampleSize`
membuat dua test merah.

### G3 — Monitor integritas sinyal

`src/signalIntegrity.ts` (engine murni) + `src/cron/signalIntegrityCron.ts`
(wrapper tipis), menumpang tick heartbeat `0 0,8,16 * * *` — rumah yang sama
dengan `checkD1Capacity`, untuk alasan yang sama: agregat berat, kondisi
bergerak lambat.

Pola `infraHealthCron.ts` dipakai apa adanya: cooldown KV,
`dispatchNotification`, `now` injectable. Bedanya cooldown 24 jam, bukan 1
jam — kondisi ini bergerak dalam hitungan hari.

**Cek 1 — backfill mati diam-diam.** `STALLED` saat backlog baris matang
melewati 500; `GRID_COLUMNS_DEAD` saat ≥95% baris yang baru di-backfill punya
kolom grid NULL. Yang kedua adalah kegagalan yang hampir menggigit hari ini,
dan pesan alert-nya menyebut penyebab konkretnya (`lower_price` tidak ikut
di-SELECT), bukan cuma "ada yang salah".

**Cek 2 — daya pisah skor.** Membandingkan tingkat keluar-range di atas vs di
bawah gate dispatch atas jendela 7 hari. `INVERTED` / `NO_SEPARATION` / `OK` /
`INSUFFICIENT_SAMPLE`. Pemisahnya sengaja gate 50, bukan ambang TRADE 55 —
yang ingin dijawab adalah "apakah yang benar-benar kita kirim ke manusia
berperilaku lebih baik", dan 55 praktis tak pernah tercapai (T1).

Tiga sifat yang sengaja dipasang:

- **`INSUFFICIENT_SAMPLE` dilaporkan, bukan didiamkan** — dan tidak memicu
  alert. Diam akan terbaca sebagai sehat, dan itu justru cara kegagalan yang
  sedang diberantas.
- **Verdict SELALU masuk log**, termasuk OK. Notifikasi bisa tertahan
  cooldown; log tidak. "Monitor jalan tapi tidak menemukan apa-apa" harus
  bisa dibedakan dari "monitor tidak jalan".
- **Catatan lapor-saja ditulis di kode**, lengkap dengan alasannya. Godaan
  berikutnya ("kalau sudah tahu terbalik, kenapa tidak dibalik otomatis?")
  terdengar masuk akal dan salah — ukuran dasarnya belum tervalidasi
  out-of-sample.

### Duplikasi `twoProportionZ`, dikunci

Ada di `scripts/falsify-ranking-score.mjs` (Node) dan `src/signalIntegrity.ts`
(Worker). Batas TS/mjs membuat berbagi kode tidak sepadan untuk fungsi
sependek itu.

Keduanya dipatok ke **fixture referensi yang sama** (50/100 vs 75/100 →
z = 3.7796447300922726). Diuji: menggeser HANYA implementasi TS membuat
suite merah.

Test lama di sisi mjs juga diperbaiki — ia menulis
`0.25 / Math.sqrt(0.25/100 + 0.1875/100)`, yaitu menguji rumus dengan rumus
yang sama, jadi akan tetap hijau meski KEDUA implementasi salah secara
identik. Sekarang literal.

### Uji mutasi

| Mutasi | Tertangkap |
|---|---|
| gate dispatch digeser 50→45 sendirian | ya |
| label bucket ditulis tangan lagi | ya |
| penyebut metrik grid → `sampleSize` | ya |
| rata-rata grid default 0, bukan null | ya |
| `INSUFFICIENT_SAMPLE` dianggap layak alert | ya |
| arah inversi dibalik (INVERTED ↔ OK) | ya |
| backlog diperiksa sesudah fraksi NULL | ya |
| `twoProportionZ` TS digeser sendirian | ya |

Verifikasi: `npm run typecheck` bersih; `npm test` **101 file / 1045 test**.

### Yang harus terlihat setelah deploy

Run pertama monitor mestinya melaporkan `INSUFFICIENT_SAMPLE` di kedua cek —
kolom grid baru terisi sejak 0017 di-deploy hari ini. Itu **bukti ia
menghitung**, bukan diam. Kalau yang muncul justru `OK` di hari pertama,
justru itu yang mencurigakan.
