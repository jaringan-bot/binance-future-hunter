# Vercel Hobby — Catatan Kuota & Formula

> **Status: RELAY VERCEL SUDAH RETIRED.** Dokumen ini catatan referensi
> **kalau suatu saat Vercel dipertimbangkan lagi** sebagai host relay Binance.
> Bukan setup aktif. Relay produksi sekarang = VPS AWS + `proxy-standalone/`
> (lihat [`proxy-standalone/README.md`](../proxy-standalone/README.md)).

## 0. Blocker utama BUKAN kuota

Alasan sebenarnya `proxy/` (Vercel) ditinggalkan **bukan** karena kuota habis,
tapi karena **Hobby plan melarang commercial use** — Vercel meng-*auto-pause*
project-nya sendiri. Jadi:

- Formula kuota di bawah relevan **HANYA** kalau pakai **plan berbayar (Pro)**
  atau use-case yang jelas non-komersial.
- **Jangan** simpulkan "kuota muat → aman pakai Hobby." Batasannya ToS, bukan
  angka menit.

## 1. Metrik: Vercel Hobby "Active CPU"

- **Kuota:** 4 jam/bulan = **240 menit/bulan** (metrik *Active CPU* = waktu
  compute saat fungsi benar-benar eksekusi, BUKAN wall-clock).
- **Baseline terukur** (diverifikasi dari dashboard usage **riil**, bukan
  artikel pihak ketiga — lihat `src/shared.ts:22-26`):
  **10 pair (SNAPSHOT cron `*/5`) ≈ 35 menit/bulan (~15% kuota).**

## 2. Formula

Untuk workload **SNAPSHOT cron `*/5`** (~11 call/pair/run, 288 run/hari):

```
CPU_menit_per_bulan ≈ N_pair × 3.5
```

Turunannya: 10 pair = 35 menit → **3.5 menit / pair / bulan** (asumsi linear).

Sebagai persen kuota:

```
%kuota ≈ (N_pair × 3.5) / 240 × 100
```

Ceiling (batas sebelum 100% kuota):

```
N_pair_maks ≈ 240 / 3.5 ≈ 68 pair
```

## 3. Contoh

| N_pair | CPU menit/bulan | % dari 240 |
|---|---|---|
| 10 | 35 | ~15% |
| 50 | 175 | ~73% |
| 68 | ~238 | ~99% (ceiling) |

Di 50 pair headroom sudah **tidak longgar** (~73%) — angka ini yang jadi dasar
catatan "monitor usage Vercel" di `src/shared.ts`.

## 4. Batas validitas formula (WAJIB dibaca sebelum dipakai)

- **Hanya untuk workload SNAPSHOT cron `*/5`** (~11 call/pair). **TIDAK**
  termasuk `entryAlertCron` (250–500 pair, jauh lebih berat) — kalau entry-alert
  ikut di Vercel, kuota jebol jauh lebih cepat dan formula ini **tidak berlaku**.
- **Ekstrapolasi linear**, tervalidasi hanya di titik terukur (10 & 50 pair).
  Overlap antar cron di window yang sama bisa bikin konsumsi **superlinear**.
- Angka `3.5 menit/pair/bulan` **spesifik** ke konfigurasi call/pair saat itu.
  Kalau jumlah call/pair, cadence cron, atau region berubah → **ukur ulang
  baseline**, jangan pakai konstanta ini buta.
- "Active CPU" ≠ wall-clock. Jangan campur dengan cap wall-clock cron (limit
  terpisah, lihat komentar `[limits]`/cron di `wrangler.toml` untuk konteks
  Cloudflare — bukan Vercel).

## 5. Kapan dokumen ini relevan

- **Hanya** kalau ada rencana konkret balik ke Vercel dengan **plan berbayar**
  atau use-case non-komersial.
- Untuk relay Binance saat ini: **pakai VPS / Fly.io / Deno Deploy** (region
  Singapore/Tokyo), lihat [`proxy-standalone/README.md`](../proxy-standalone/README.md).
  Vercel = jalur historis/retired.
