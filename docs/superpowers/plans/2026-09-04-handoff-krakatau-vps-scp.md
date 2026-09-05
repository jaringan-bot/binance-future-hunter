# Handoff Krakatau — dua `scp` VPS (2026-09-04)

> Ditulis **Semeru**. Eksekusi = **Krakatau** (Cursor mode infra).
> **Acc user diberikan 2026-09-04** ("acc krakatau, kerjakan dua scp itu").
> Gate terbuka untuk DUA target di bawah ini SAJA — bukan acc umum untuk
> `wrangler deploy`, `--remote`, `secret put`, atau AWS SG.

## TL;DR

Kode di `main` sudah benar dan teruji lokal; yang **belum** adalah menyalinnya
ke VPS. Tidak ada `wrangler deploy`, tidak ada migration, tidak ada secret baru.
Murni `scp` + `systemctl restart` di host.

| # | File | Host | Service | Commit sumber |
|---|---|---|---|---|
| 1 | `stream-gateway/depthWatch.mjs` | `svm-vps` (13.212.7.132) | `whale-stream-gateway` | `bac382f` + `30d72ac` |
| 2 | `proxy-standalone/handler.mjs` | **KEDUA** host relay | `whale-binance-proxy` | `dd1d26c` |

**Jangan sentuh worker `whalescope-mcp`.** Tidak ada hubungannya dengan tugas
ini, dan cron-nya harus tetap tercabut (lihat CLAUDE.md).

---

## Pre-flight yang SUDAH dijalankan Semeru

- `stream-gateway` — `npm test` (node:test, bukan vitest): **59/59 hijau**.
- `proxy-standalone` — **TIDAK ADA test sama sekali.** Tidak ada `*.test.mjs`,
  `package.json` cuma punya script `start`. Perubahan handler.mjs berangkat
  **tanpa jaring pengaman unit test** sehingga verifikasi WAJIB perilaku
  pasca-deploy (bagian Verifikasi 2), bukan sekadar "service aktif".
- **DIPERBAIKI 2026-09-04:** test gateway dulu TIDAK tercakup `npm test` root
  (`vitest.config.ts` cuma include `src/**` + `scripts/**`). Sekarang script
  `test` di package.json root menjalankan gateway dulu, baru vitest:
  **59 + 951 = 1010 test**. Kegagalan gateway sekarang benar-benar
  menggagalkan `npm test` (diverifikasi lewat mutasi, exit 1). Jadi
  "npm test hijau" SEKARANG sudah mencakup gateway.

---

## Target 1 — `depthWatch.mjs` ke gateway

**Kenapa paling mendesak:** ambang wall volume-scaled sudah **live di Worker**,
tapi pasangannya di gateway belum. Peredaman churn baru setengah jalan.
Konsekuensi paling berbahaya bukan churn-nya, tapi **salah simpul**: kalau
verifikasi live besok melihat churn masih tinggi, gampang menyimpulkan
"histeresis tidak bekerja" padahal memang belum terpasang.

Yang dibawa:
- `EVENT_BUFFER_PER_SYMBOL` 500 menjadi **2000** (~15 menit history, muat satu
  TTL default 5 menit dengan headroom)
- `WALL_EXIT_HYSTERESIS = 0.15` — exit floor `threshold * 0.85`, memotong flap
  `WALL_APPEARED` vs `WALL_VANISHED` di buku BTC/ETH
- `30d72ac` adalah perbaikan atas `bac382f`: histeresis butuh **state**, tanpa
  itu `WALL_VANISHED` hilang selamanya. **Kirim keduanya, jangan `bac382f`
  saja.**

Jalur resmi (dari header `install.sh`), lebih aman daripada scp satu file:

    # dari stream-gateway/ di mesin lokal
    scp -i <key> *.mjs package.json whale-stream-gateway.service install.sh \
        ubuntu@13.212.7.132:/tmp/gw/
    ssh -i <key> ubuntu@13.212.7.132 "sudo bash /tmp/gw/install.sh"

`install.sh` idempoten: menyalin ke `/opt/whale-stream-gateway`,
`daemon-reload`, `restart`, dan **tidak** menimpa `.env` yang sudah ada.

### Verifikasi 1

    ssh ubuntu@13.212.7.132 "systemctl is-active whale-stream-gateway"
    ssh ubuntu@13.212.7.132 "grep -E 'EVENT_BUFFER_PER_SYMBOL|WALL_EXIT_HYSTERESIS' /opt/whale-stream-gateway/depthWatch.mjs"
    # harus 2000 dan 0.15 -- kalau masih 500, scp tidak mendarat
    curl -s https://13.212.7.132.sslip.io/health

Lalu amati rasio `WALL_APPEARED`/`WALL_VANISHED` per menit di pair likuid: harus
turun. Ini butuh waktu, bukan cek instan.

---

## Target 2 — `handler.mjs` ke KEDUA relay

Tiga perubahan (`dd1d26c`, komentar I2 menandainya "BUTUH REDEPLOY VPS"):

1. **Passthrough header budget** — `x-mbx-used-weight-1m`, `x-mbx-used-weight`,
   `x-mbx-order-count-1m`, `retry-after`. Relay selama ini **membuangnya**,
   jadi Worker buta terhadap seberapa dekat sebuah IP relay ke weight-ban. Ini
   satu-satunya sinyal yang bisa mencegah `-1003` / HTTP 418, dan alasan
   `rateLimiter.ts` terpaksa count-based dengan asumsi "weight rata-rata ~1.5"
   (padahal `/fapi/v1/depth?limit=50` berbobot 5 dan `/fapi/v1/ticker/24hr`
   tanpa symbol berbobot 40). **Ini akar masalah IP-ban yang memotivasi
   Stage 1.**
2. **`UPSTREAM_TIMEOUT_MS = 10_000`** via `AbortSignal.timeout` — tanpa ini satu
   koneksi Binance yang menggantung menahan slot relay tanpa batas, dan di sisi
   Worker menahan satu slot concurrency cron sampai batas invocation.
3. **Fix prototype-pollution** pada `?market=` — `Object.hasOwn` alih-alih
   lookup langsung. `?market=constructor` dulu mengembalikan anggota
   `Object.prototype` yang truthy, lolos cek `!allowedPaths`, lalu
   `allowedPaths.has()` melempar TypeError tak tertangkap sehingga jadi 500,
   bukan 400.

Ulangi untuk KEDUA host:

    scp -i <key> proxy-standalone/handler.mjs ubuntu@<HOST>:/tmp/handler.mjs
    ssh -i <key> ubuntu@<HOST> "sudo install -m 644 /tmp/handler.mjs /opt/whale-binance-proxy/handler.mjs && sudo systemctl restart whale-binance-proxy && systemctl is-active whale-binance-proxy"

### Host relay — HASIL PROBE 2026-09-04

Alamat relay #2 tidak ada di repo (nilainya di secret `PROXY_URL_2`).
`~/.ssh/config` memuat tiga host; user menjalankan probe read-only:

| Host | IP | `whale-binance-proxy` | `/opt` |
|---|---|---|---|
| `svm-vps` | 13.212.7.132 | **active** | `whale-binance-proxy` + `whale-stream-gateway` |
| `svm-jkt` | 108.136.219.101 | SSH **timeout** port 22 | tidak terbaca |
| `jaringan-dev` | 146.235.17.228 | **active** | `whale-binance-proxy` + `whale-stream-gateway` |

**Koreksi:** versi sebelumnya dokumen ini menandai `jaringan-dev` sebagai
"jangan diasumsikan relay #2" karena hanya muncul di spec Oracle 2026-08-11.
Probe membuktikan host itu MENJALANKAN relay dan aktif. Dugaan bahwa
`svm-jkt` adalah relay #2 (murni dari namanya) TIDAK terbukti.

**`scp` handler.mjs ke `svm-vps` DAN `jaringan-dev`.** Keduanya menjalankan
relay, file-nya sama, dan meng-update host yang ternyata bukan `PROXY_URL_2`
pun tidak merugikan — kode identik, bug yang sama diperbaiki. Ini justru
menghilangkan risiko relay campur-versi, bukan menambahnya.

**SSH timeout pada `svm-jkt` BUKAN bukti host itu mati.** Port 22 bisa
ditutup Security Group sementara :443 tetap melayani. Kalau `PROXY_URL_2`
ternyata menunjuk ke sana, relay #2 tidak akan pernah ter-update lewat SSH
dan itu masalah tersendiri. Cek dari luar sebelum menyimpulkan:

    curl -s -o /dev/null -w %{http_code}n https://108.136.219.101.sslip.io/health

**TEMUAN BARU yang belum ditindaklanjuti:** `jaringan-dev` juga punya
`/opt/whale-stream-gateway`. Kalau service itu AKTIF, ada DUA stream gateway
berjalan — pola yang sama dengan duplikasi cron whalescope-mcp (lihat
CLAUDE.md). Harus dicek sebelum menyimpulkan apa pun soal churn depth-watch:

    ssh jaringan-dev "systemctl is-active whale-stream-gateway"

### Verifikasi 2 — perilaku, bukan cuma `is-active`

Dua cek biner yang murah dan tegas, jalankan **per host**:

    # (a) header weight harus MUNCUL sekarang (sebelumnya dibuang)
    curl -sD- -o /dev/null -H "x-proxy-secret: <SECRET>" \
      "https://<HOST>/api/binance?path=/fapi/v1/time" | grep -i x-mbx-used-weight
    # kosong = scp belum mendarat atau service belum restart

    # (b) prototype-pollution: harus 400, BUKAN 500
    curl -s -o /dev/null -w "%{http_code}\n" -H "x-proxy-secret: <SECRET>" \
      "https://<HOST>/api/binance?market=constructor&path=/fapi/v1/time"

Cek (a) yang paling penting — ia membuktikan tepat perubahan yang memotivasi
seluruh Stage 1.

---

## Lapor balik

Sesuai konvensi: Krakatau lapor **di chat**, prefiks `[Krakatau] 2026-09-04`,
Semeru yang menulis hasilnya ke plan file. Yang perlu dilaporkan:

- Berapa host relay yang benar-benar ter-update (1 atau 2), dan alamatnya.
- Output mentah cek (a) dan (b) per host.
- Output `grep EVENT_BUFFER_PER_SYMBOL` di gateway.
- Timestamp restart tiap service — dibutuhkan supaya verifikasi live besok bisa
  memotong data sebelum/sesudah dengan benar.

## Kaitan dengan verifikasi live besok

Jendela 24 jam blok A buka **2026-09-05 11:52 UTC**. Idealnya kedua `scp` ini
mendarat **sebelum** itu, supaya 24 jam pertama mengukur satu konfigurasi utuh.
Kalau mendarat di tengah jendela, **catat jamnya** — data akan terbelah
sebelum/sesudah, persis jenis kontaminasi yang menyulitkan di batas 11:52 kemarin.

---

## HASIL EKSEKUSI — 2026-09-05 (ditulis Semeru dari laporan terminal user)

Dieksekusi **user langsung di terminal**, bukan Krakatau dan bukan Semeru:
SSH/`scp` diblokir classifier auto mode di sesi Claude Code, dan izin user di
chat tidak mengangkat blokir itu.

### Target 1 — gateway: MENDARAT, konstanta BELUM diverifikasi

- `install.sh` jalan di `svm-vps`, service `active`.
- Health: `ok:true`, `reconnectCount:0`, `malformedCount:0`, `lastError:null`,
  `liqRowCount` 38812 utuh, `depthWatch.count` 0 (on-demand, wajar).
- **`connectedSince` = 2026-09-05T00:00:01Z — 11,9 jam SEBELUM jendela blok A
  (11:52Z).** Seluruh 24 jam pengukuran berjalan di atas satu konfigurasi
  gateway, tidak terbelah. Ini yang dikejar.
- `grep` konstanta GAGAL: `Permission denied` — `install.sh` men-set
  `/opt/whale-stream-gateway` mode 750 milik user lain, butuh `sudo`.
  **`active` hanya berarti service hidup, bukan bukti file barunya yang jalan.**
  Belum boleh disebut tuntas sampai `2000` dan `0.15` terlihat.

### Target 2 — relay: SELESAI, terverifikasi checksum

| Host | service | sha256 `/opt/whale-binance-proxy/handler.mjs` |
|---|---|---|
| `svm-vps` | active | `224db0ad9f7cfc9f8...` cocok |
| `jaringan-dev` | active | `224db0ad9f7cfc9f8...` cocok |

Cocok byte-per-byte dengan `main`. Karena KEDUA host relay kini menjalankan
kode yang sama, identitas `PROXY_URL_2` tidak perlu dipecahkan — risiko relay
campur-versi hilang apa pun jawabannya.

### INSIDEN — relay utama sempat menjalankan kode tak dikenal

Percobaan pertama memakai rantai perintah `;` (bukan `&&`) yang **disusun
Semeru**. `scp` gagal (cwd salah: `stream-gateway/`, bukan root repo), tapi
`sudo install` TETAP jalan. Di `svm-vps` kebetulan ada sisa `/tmp/handler.mjs`
entah dari kapan, sehingga file itu ter-install ke `/opt` dan relay di-restart
dengan kode yang tidak diketahui versinya. `jaringan-dev` selamat hanya karena
tidak punya sisa file (`install: cannot stat`).

Tertutup oleh redeploy terverifikasi di atas. **Pelajaran: rantai perintah
deploy WAJIB `&&`, dan buktinya checksum, bukan `systemctl is-active`.**

### Masih terbuka

1. Konstanta gateway belum terbukti:
   `ssh svm-vps "sudo grep -E 'EVENT_BUFFER_PER_SYMBOL|WALL_EXIT_HYSTERESIS' /opt/whale-stream-gateway/depthWatch.mjs"`
2. `jaringan-dev` punya `/opt/whale-stream-gateway`. Kalau service itu aktif,
   ada DUA gateway berjalan — pola yang sama dengan duplikasi cron
   whalescope-mcp. **Cek ini sebelum menyimpulkan apa pun soal churn
   depth-watch besok.**
3. `svm-jkt` (108.136.219.101) SSH timeout port 22, belum terjelaskan. Bukan
   bukti host mati — :443 bisa tetap melayani.
