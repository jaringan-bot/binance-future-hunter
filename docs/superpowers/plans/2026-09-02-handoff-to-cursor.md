# Serah Terima Proyek → Cursor (2026-09-02)

> Ditulis Semeru (Claude Code). Mulai titik ini, **Cursor pegang semua**:
> koding + infra + docs + deploy. Semeru **tidak lagi aktif** di tree —
> tugas terakhir Semeru: **audit/analisa penutup** setelah Cursor lapor
> selesai (lihat bagian terakhir).
>
> Split `.cursor/rules/agents.mdc` (Semeru vs Cursor) tetap valid sebagai
> deskripsi peran (Rinjani = build, Krakatau = deploy-gated), cuma sekarang
> dua-duanya Cursor. Aturan **gating deploy tetap berlaku**: `--remote` /
> `wrangler deploy` / `secret put` / SSH / AWS SG = tunggu acc user.

---

## TL;DR

- **`main` @ `351158b`** (`jaringan-bot/binance-future-hunter`), sinkron.
- **LIVE**: worker `e511dcad` = Stage 0–4 (PR #1 `a343004`, PR #2 `c522e37`).
  Infra AWS `svm-vps` (`13.212.7.132`), D1 instance existing
  (`3600a9bb-9261-492a-bf06-3a11b0448f4e`), migrations 0001–0014 applied `--remote`.
- **DI `main`, BELUM DEPLOY**: PR #3 (`138847c`) + PR #4 (`351158b`).
- `osindo-dev` sekarang collaborator repo → agent bisa buka/merge PR sendiri.
- Verifikasi lokal terakhir: `tsc` bersih · 857 src test · 54 stream-gateway test.

---

## 1. Task langsung — deploy PR #3 + #4 (Krakatau, acc user 2026-09-02)

Keduanya `src/**` + `stream-gateway/`. **No migration, no secret baru.**

| PR | Isi | Deploy footprint |
|---|---|---|
| #3 `138847c` | `wallThresholdForVolume` — ambang wall `binance_watch_orderbook_realtime` di-skala volume 24h (BTC ~$2M, bukan $250k flat). Per-watch override `wall_min_notional_usd`. | `wrangler deploy` + stream-gateway `scp`+`install.sh` (ubah `depthWatch.mjs`, `server.mjs`) |
| #4 `351158b` | `checkRelayHealth` — poll `/health` tiap REST relay (`PROXY_URL`/`PROXY_URL_2`) tiap tick `*/5`. Nangkep relay #2 mati diam-diam (yang `checkMarketSnapshotFreshness` gak bisa lihat). | `wrangler deploy` saja |

### Runbook

```
# 0. sync
git checkout main && git pull            # -> 351158b
npm ci && npm run typecheck && npm test    # ~857 green
(cd stream-gateway && node --experimental-sqlite --disable-warning=ExperimentalWarning --test)   # 54 green

# 1. stream-gateway update (SSH) — PR #3 ubah depthWatch.mjs + server.mjs
cd stream-gateway
# kalau install.sh CRLF: `sed -i 's/\r$//' install.sh`  (atau sekali: `git rm -r --cached . && git checkout .`)
scp -i ~/.ssh/jaringan.pem *.mjs package.json whale-stream-gateway.service install.sh ubuntu@13.212.7.132:/tmp/gw/
ssh svm-vps 'sudo bash /tmp/gw/install.sh'
ssh svm-vps 'systemctl is-active whale-stream-gateway; curl -s localhost:8081/stream/health'
# /stream/health tetap punya field depthWatch

# 2. worker deploy — #3 + #4
npx wrangler deploy
# PROXY_URL/PROXY_SECRET sudah ada. PROXY_URL_2 belum di-set (relay #2 belum live) — OK,
# checkRelayHealth cuma cek relay yang ke-configure.

# 3. verify live
curl -s https://binance-future-hunter.jaringan.workers.dev/       # "name":"binance-future-hunter"
# PR #3: binance_watch_orderbook_realtime {"symbol":"BTCUSDT"}
#   call 1 harus tunjukkan  "Ambang wall: $2,000,000 (volume-scaled ...)"  (bukan $250k)
#   tunggu ~6s, call 2 pakai sinceMs -> jumlah WALL_* event JAUH lebih sedikit dari 500
#   {"symbol":"BTCUSDT","wall_min_notional_usd":100000} -> thresholdSource "explicit"
# PR #4: wrangler tail ~5 menit -> TIDAK ada "[cron] gagal checkRelayHealth"
#   (opsional) matiin whale-binance-proxy sebentar -> Telegram alert "REST Relay: primary DOWN" dalam 5 menit -> nyalain lagi

# 4. lapor hasil DI CHAT ke user (version id baru, hasil verify, error di tail atau nggak)
```

---

## 2. Backlog bertahap — tunggu acc user eksplisit ("acc")

### 2a. Relay REST kedua (mitigasi weight-ban IP tunggal)

**Kenapa**: SEMUA egress Binance dari 1 IP VPS → pernah kena HTTP 418 `-1003`
(`src/entryWatchlist.ts:29-37`). Kode SUDAH siap: `PROXY_URL_2`/`PROXY_SECRET_2`
di `binanceProxyClient.ts` → round-robin ~50/50 dua IP, masing-masing budget
weight sendiri. Cuma belum ada target IP kedua yang live.

1. Deploy instance ke-2 `proxy-standalone/` di host **BEDA IP** — Fly.io free
   `sin` / Deno Deploy / VPS ke-2 ~$5/bln. **BUKAN Vercel** (retired).
2. `wrangler secret put PROXY_URL_2` + `wrangler secret put PROXY_SECRET_2`.
3. Verifikasi failover: matikan primary sementara → cek worker tetap dapat data
   lewat secondary (`checkRelayHealth` #4 bakal alert, itu tanda bagus).
4. **Setelah** failover verified live: naikkan `ENTRY_WATCHLIST_SIZE`
   (`src/entryWatchlist.ts:37`) 250 → 350–500. Itu perubahan KODE (bukan infra),
   pasangkan dengan re-tune `MAX_REQUESTS_PER_WINDOW` (`rateLimiter.ts`) +
   `ENTRY_ALERT_PACING_DELAY_MS` (`entryAlertCron.ts`) balik ke arah semula.
   Verifikasi tick entry-alert gak `Canceled` + gak ada 418 di `wrangler tail`
   selama ~beberapa jam sebelum naikkan lagi.

---

## 3. Deferred / butuh desain dulu (BUKAN task siap kerja)

| Item | Kenapa nunggu |
|---|---|
| **Leverage Bracket riil** (`/fapi/v1/leverageBracket` buat akurasi `liquidationPrice` di `gridRiskEngine.ts`) | Endpoint SIGNED/USER_DATA — butuh API key Binance user = perubahan model kredensial PERTAMA (sekarang 100% read-only tanpa kredensial akun). Butuh keputusan desain (opsional per-call API key vs skip). Mitigasi sementara sudah ada: `estimateMaintenanceMarginBufferPct` (buffer MMR di-skala volume, PR sebelumnya). |
| **Whale-wallet-discovery** | Spec `docs/superpowers/specs/2026-09-01-whale-wallet-discovery.md` (Opsi A: `hyperliquid_validate_candidate_wallet` + Deribit options data). Butuh verifikasi shape/rate-limit endpoint pihak ketiga live DULU sebelum jadi task. `HYPERLIQUID_WHALE_WATCHLIST` sekarang array kosong (curated manual by design). |
| **Sticky-set `SNAPSHOT_WATCHLIST`** | Analisa Semeru 2026-09-02: 50-pair curated market-cap sekarang benar untuk tujuannya (time-series kontinu). Kerjain HANYA kalau swap manual (mis. FTM→POL) jadi sering ganggu. Rekomendasi: **hybrid** ~20 majors hardcode permanen + ~30 tail sticky-set by volume 24h (symbol bertahan sampai jatuh di bawah rank N+margin selama K hari). BUKAN pure sticky-set (state overhead gak sepadan). BUKAN 7d/30d volume window (butuh ~500 klines call, ngalahin efisiensi 1 bulk ticker call). **Ranking basis ORTHOGONAL ke 418 — ganti basis TIDAK mengurangi weight, jangan harap gantiin relay #2.** |
| **ENTRY watchlist ranking** | Tetap volume 24h — sudah benar (likuiditas current > ukuran proyek buat grid entry). Jangan disamakan dengan SNAPSHOT. |

---

## 4. Follow-up tuning tercatat (BUKAN bug — konsisten "belum dikalibrasi")

- **Ambang wall depth-watch** (`wallThresholdForVolume`, PR #3): tier
  `$5B→$2M / $1B→$800k / $200M→$350k / $20M→$150k / else $80k`. Heuristik,
  belum backtest. Re-tune kalau data live nunjukkan masih kebanyakan / kesedikitan event.
- **`EVENT_BUFFER_PER_SYMBOL = 500`** (`depthWatch.mjs`): ring per symbol
  penuh cepat di pair sangat likuid → poll sering (`sinceMs`). By design.

---

## 5. Repo hygiene / catatan

- **`.gitattributes`** (`eol=lf` buat `*.sh` / `*.service` / `stream-gateway/**` /
  `proxy-standalone/**` / `migrations/*.sql`) sudah ada. Checkout Windows lama
  masih CRLF di working tree — sekali: `git rm -r --cached . && git checkout .`
  (normalize, tanpa ubah konten) biar `scp install.sh` gak butuh `sed` lagi.
- **`.cursor/mcp.json` + `.cursor/settings.json`** = config lokal Cursor,
  untracked. Cursor putuskan: commit (kalau mau shared, mis. `aws-core` plugin)
  atau tambah ke `.gitignore`.
- **`osindo-dev`** = collaborator repo sekarang → agent (`gh` / MCP GitHub)
  bisa buka + merge PR sendiri. PR #1/#2/#3/#4 semua squash-merged, branch dihapus.
- **README stale**: nyebut "29 tools" / "46 tool" / "watchlist tetap 50 pair" —
  sekarang **77 tool** (lihat `catalog.test.ts`). Update kalau sempat (Cursor
  owns `README*.md` sekarang).
- **Plan file lama** (`docs/superpowers/plans/2026-09-02-stage-3-4-realtime-dashboard.md`)
  = Stage 3–4, status DEPLOYED. Tetap valid sebagai record. Dokumen INI yang
  jadi acuan kerja lanjutan.

---

## 6. Konvensi yang WAJIB dipertahankan (jangan drift)

Detail: `CLAUDE.md`, `.cursor/rules/*.mdc`, `README.md`,
`docs/full_pipeline_framework.md`, `docs/mm_detection_framework.md`.

- **Pure engine + thin wrapper** — logika di modul murni, tool handler tipis.
- **Test : source ~1:1** — modul non-trivial butuh `.test.ts` di sebelahnya.
  Verifikasi: `npm run typecheck && npm test` + (kalau sentuh `stream-gateway/`)
  `cd stream-gateway && node --test`.
- **No new npm deps** — runtime cuma `@modelcontextprotocol/sdk` + `zod`.
- **Jangan rename tool `whalescope_*`** — backward compat MCP connector.
- **Dokumentasi jujur** — threshold/heuristik ditandai "belum dikalibrasi"
  kalau belum ada data backtest.
- **Secrets** — `wrangler secret put`, never hardcode.
- **D1** — instance existing (`database_id 3600a9bb-…` di `wrangler.toml`).
  Migration baru = file additive di `migrations/`, jangan edit yang sudah applied.
- **Deploy gating** — `--remote` / `wrangler deploy` / `secret put` / SSH /
  AWS SG = STOP, minta acc user, baru jalan.

---

## 7. Tugas penutup Semeru — audit di akhir

Setelah Cursor **selesai deploy PR #3 + #4 dan lapor hasil verify**, minta
Semeru (Claude Code) jalankan **analisa/audit penutup**:

- Diff `main` vs kondisi live — pastikan gak ada drift.
- Cek `wrangler tail` / hasil verify Cursor — `checkRelayHealth` jalan bersih,
  `binance_watch_orderbook_realtime` pakai ambang volume-scaled.
- Review area risiko: single-IP relay (sampai #2 live), `ENTRY_WATCHLIST_SIZE`
  coverage 250/~527, wall threshold belum backtest.
- Rekomendasi prioritas berikutnya (relay #2 vs whale-discovery vs leverage bracket).

Panggil Semeru dengan: *"Cursor selesai deploy PR #3+#4, hasil: <ringkasan>.
Jalankan audit penutup."*
