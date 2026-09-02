# Whale Wallet Discovery & Options-Market Data — Design

> **STATUS: SPEC, belum implementasi.** Ditulis sebagai bagian dari
> penguatan pilar "Smart Money / Whale / MM / Institutional" (lihat rebrand
> `binance-future-hunter`) -- API pihak ketiga yang relevan di sini butuh
> verifikasi shape/biaya/ToS dulu sebelum di-commit ke kode, disiplin yang
> sama dipakai `2026-08-11-realtime-liquidation-stream-design.md` sebelum
> `stream-gateway/` dibangun. Riset di bawah sudah divalidasi via web search
> 2026-09-01 (bukan asumsi/tebakan), tapi BELUM dites langsung ke endpoint
> live (beda dari budaya "Validasi Empiris" repo ini yang selalu tes ke
> worker deployed) -- itu kerjaan implementasi, bukan spec.

## Latar Belakang

Dua gap konkret di cakupan data institusional yang ada sekarang:

1. **`HYPERLIQUID_WHALE_WATCHLIST` (src/shared.ts) kosong by design** --
   dicurate manual, tidak ada mekanisme discovery otomatis. Komentar di
   kode sendiri sudah jujur: "Hyperliquid gak punya API leaderboard resmi
   (endpoint publik yang ada undocumented/internal, dipakai UI mereka
   sendiri, bisa berubah kapan aja tanpa notice)".
2. **Tidak ada data options market sama sekali** -- semua sinyal
   institusional yang ada (CFTC COT, cross-exchange funding, whale
   Hyperliquid) berasal dari futures/perpetual, bukan options. Skew
   put/call dan options OI adalah sinyal positioning institusional yang
   umum dipakai (hedging/directional bet lewat options sering mendahului
   pergerakan spot/futures) tapi belum ada tool untuk itu di repo ini.

## Tujuan

Menentukan pendekatan konkret (bukan cuma "nanti ditambah") untuk kedua
gap ini, supaya jadi task implementasi yang well-scoped di iterasi
berikutnya -- bukan janji kosong.

## Bagian A — Whale Wallet Discovery (Hyperliquid)

### Riset (web search 2026-09-01)

Dikonfirmasi via `hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint`:
API publik resmi Hyperliquid **tidak punya endpoint leaderboard/discovery**
sama sekali -- semua endpoint (`vaultDetails`, `userVaultEquities`,
`portfolio`, dst) butuh address yang SUDAH diketahui sebagai input, tidak
ada cara "list top traders" dari API resmi. Ini mengonfirmasi (bukan cuma
mengulang) komentar existing di `src/shared.ts`.

Opsi yang tersedia di luar API resmi:

| Opsi | Deskripsi | Biaya | Risiko | Keputusan |
|---|---|---|---|---|
| A. Tetap manual curation, tambah tool bantu validasi | `HYPERLIQUID_WHALE_WATCHLIST` tetap diisi manual, tapi tambah tool `hyperliquid_validate_candidate_wallet` yang query `userClearinghouseState` sekali buat 1 address kandidat (dari riset manual user/Hyperdash/block explorer) dan tampilkan posisi + equity-nya SEBELUM diputuskan masuk watchlist permanen | $0 | Rendah -- pakai endpoint resmi yang sudah dipakai (`hyperliquidClient.ts`) | **Direkomendasikan sebagai langkah pertama** -- buildable sekarang, nol dependency baru |
| B. Nansen API (Hyperliquid Leaderboard / Address Leaderboard) | Endpoint resmi vendor (`docs.nansen.ai/api/hyperliquid/hyperliquid-leaderboard`, `POST /api/v1/perp-leaderboard`) -- ranked by PnL/ROI, ToS-safe (data vendor resmi) | Berbayar (butuh API key/subscription, harga tidak dipublikasi terbuka) | Rendah secara ToS, tapi nambah dependency berbayar pertama di repo ini (semua sumber data sekarang gratis/publik) | Ditunda -- butuh keputusan budget eksplisit dari user, di luar scope teknis spec ini |
| C. Scraper pihak ketiga (Apify Hyperliquid Leaderboard Scraper, dsb) | Scrape UI leaderboard Hyperliquid via layanan scraping | Berbayar (pay-per-use Apify) lebih murah dari C | **Tinggi** -- scraping UI vendor lain berisiko ToS, dan stabilitasnya tidak terjamin (UI berubah = scraper patah tanpa notice) | **Ditolak** -- kontradiksi langsung sama prinsip "100% Binance-native / sumber resmi" yang sudah jadi budaya repo ini |
| D. Reverse-engineer endpoint internal UI Hyperliquid | Endpoint yang dipakai `app.hyperliquid.xyz/leaderboard` sendiri (undocumented) | $0 | **Tinggi** -- persis alasan kenapa ini SUDAH ditolak sebelumnya (komentar existing `src/shared.ts`): "bisa berubah kapan aja tanpa notice" | **Ditolak** (sudah diputuskan sebelumnya, dikonfirmasi ulang di sini) |

### Rekomendasi

Implementasikan **Opsi A** di iterasi berikutnya (tool kecil, pola sama
seperti tool lain yang query 1 address on-demand) -- ini TIDAK menyelesaikan
"discovery otomatis" (watchlist tetap manual), tapi menurunkan friksi
curation manual (user riset address dari luar, lalu validasi cepat lewat
Claude sebelum commit ke `HYPERLIQUID_WHALE_WATCHLIST`). Opsi B (Nansen)
didokumentasikan sebagai jalur upgrade eksplisit KALAU user memutuskan mau
bayar untuk leaderboard otomatis -- bukan diasumsikan/dibangun sekarang.

## Bagian B — Options Market Data (Deribit)

### Riset (web search 2026-09-01)

`public/get_book_summary_by_currency` (Deribit API) **tidak butuh
autentikasi**, filter `kind=option`, balikin per-instrument: open interest,
volume 24h, mark price, best bid/ask. Ini analog langsung dengan pola
`cftcClient.ts`/`stablecoinClient.ts` yang sudah ada di repo ini (public
REST, no-auth, no-proxy-needed -- beda dari Binance yang WAF-blocked).

Deribit **tidak** mengembalikan put/call ratio atau total OI langsung dalam
satu field -- itu harus DIHITUNG di sisi kita dari daftar instrument
per-currency (jumlah OI semua instrument `option_type=put` vs `call`,
group by expiry kalau mau granular). Ini kerjaan agregasi murni (fungsi
testable tanpa network), pola sama seperti `computeFundingDivergence`/
`computeCftcTrend`.

### Rekomendasi

Beda dari Bagian A, **ini TIDAK butuh keputusan budget/ToS** -- data publik
gratis, pola fetch+cache sama persis dengan `cftcClient.ts` (`cachedFetch`,
TTL panjang karena options OI tidak berubah sedetik-detik). Bisa naik status
dari "spec" ke "task implementasi siap kerja" di iterasi berikutnya begitu
ada slot -- BUKAN dependency baru, BUKAN keputusan bisnis, murni kerja
teknis mengikuti pola existing.

## Arsitektur (Bagian B, Deribit -- karena ini yang siap diimplementasi)

```
src/deribitClient.ts (baru)         -- fetch + cache, pola cftcClient.ts
  getOptionsSummary(currency: "BTC"|"ETH")
    -> cachedFetch("https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=X&kind=option", ..., TTL)
    -> return raw instrument list

  computeOptionsPositioning(instruments)   -- FUNGSI MURNI
    -> totalCallOi, totalPutOi, putCallRatio
    -> (opsional v2) breakdown per expiry terdekat

src/tools/deribitOptions.ts (baru)
  binance_get_options_positioning(coin: "BTC"|"ETH")
    -> panggil getOptionsSummary + computeOptionsPositioning
    -> ToolResponseBuilder, pola sama tool lain
```

Tidak menyentuh `institutionalFlow.ts` di iterasi ini -- integrasi options
positioning sebagai komponen ke-4 `computeInstitutionalFlowScore()` adalah
follow-up TERPISAH setelah tool dasarnya ada dan sempat divalidasi
(konsisten dengan cara `cme_get_institutional_positioning_trend` dibangun
dulu sebagai tool berdiri sendiri sebelum di-fuse).

## Error Handling (Bagian B)

- Currency selain BTC/ETH -- Deribit options market cuma likuid untuk
  BTC/ETH (sama batasan kayak CFTC), tool reject dengan pesan jelas
  (`z.enum(["BTC", "ETH"])`, pola sama `cme_get_institutional_positioning`).
- Deribit HTTP non-200 / response kosong -- error jelas, pola sama
  `getCftcPositioning` (`throw new Error(...)`, ditangkap `errorResult()`
  di tool layer).
- Instrument list kosong (expiry gap, dsb) -- `computeOptionsPositioning`
  balikin `putCallRatio: null` dengan note, bukan divide-by-zero.

## Testing (Bagian B)

Pola sama `cftcClient.test.ts`: mock `fetch` global buat
`getOptionsSummary`, unit test murni untuk `computeOptionsPositioning`
(kasus normal, kasus OI nol, kasus semua call/semua put).

## Scope Eksplisit

- **Tidak termasuk**: implementasi kode apapun di iterasi ini -- dokumen
  ini spec buat iterasi BERIKUTNYA.
- **Tidak termasuk**: opsi B/C/D Bagian A (Nansen/scraper/reverse-engineer)
  -- didokumentasikan sebagai alternatif yang DIPERTIMBANGKAN dan
  ditolak/ditunda, bukan rencana kerja.
- **Tidak mengubah**: `computeInstitutionalFlowScore()` (`src/institutionalFlow.ts`)
  -- integrasi options positioning ke skor gabungan itu adalah task
  terpisah setelah tool dasar Bagian B ada.
