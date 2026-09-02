# Claude Code — binance-future-hunter

Ringkasan untuk sesi architect. Cursor rules detail ada di `.cursor/rules/`.

## Apa ini

MCP server Cloudflare Worker untuk analisis Binance Futures (~95 modul TS, ~95 file test).
Bukan greenfield. Bukan Telegram bot — notifikasi lewat `src/notify.ts` (fan-out
Telegram + Discord + generic webhook; `src/telegram.ts` = impl Telegram-nya).

**Stage 0–4 SELESAI + DEPLOYED (2026-09-02, PR #1 → `main` `a343004`).** Worker
live `e511dcad`. Detail per-task + hasil deploy: `docs/superpowers/plans/2026-09-02-stage-3-4-realtime-dashboard.md` (status block paling atas).

## Stack nyata

| Komponen | Lokasi | Deploy |
|---|---|---|
| Worker + cron + MCP | `src/`, `wrangler.toml` | `npx wrangler deploy` (manual, by design) |
| D1 time-series | `migrations/`, binding `DB` | `wrangler d1 migrations apply … --remote` |
| KV config | binding `CONFIG_KV` | jarang write |
| Binance REST relay | `proxy-standalone/` | AWS VPS systemd (`svm-vps`, 13.212.7.132) |
| WS liquidations | `stream-gateway/` | AWS VPS — `whale-stream-gateway` + Caddy |

**Tidak ada:** Docker, docker-compose, Nginx, GitHub Actions → VPS, Telegraf/webhook bot.

## Pembagian peran — nama gunung untuk identifikasi

| Nama | Peran | Dijalankan sebagai |
|---|---|---|
| **Semeru** | Architect & Problem Solver — spec, desain logika, debug rumit, verifikasi lokal | Claude Code (sesi ini) |
| **Rinjani** | Builder & Executor — koding, refactor, boilerplate, test, siapkan commit/PR | Cursor Agent (mode normal) |
| **Krakatau** | Infra & Deploy — `d1 migrations apply --remote`, `wrangler deploy`, `secret put`, SSH VPS, AWS SG. **GATED: hanya setelah user acc eksplisit** | Cursor Agent (mode infra) |
| **Ijen** | Reviewer — `/code-review`, ultrareview, audit diff pre-merge | Claude cloud (user-triggered) |
| **Bromo** | Observability — uptime eksternal + CF alert | belum ada |

| | Semeru (Claude) | Rinjani / Krakatau (Cursor) |
|---|---|---|
| Boleh | `typecheck`, `npm test`, `wrangler dev`, tulis kode+test+migration+docs | Rinjani: infra-mechanics + commit hasil kerja Semeru dari tree. Krakatau: `--remote`, `wrangler deploy`, secrets, SSH VPS, AWS SG |
| Jangan | `--remote`, deploy, SSH, secret put, AWS SG | Ubah file milik Semeru (lihat ownership) tanpa lapor dulu; gabung perubahan kode + aksi deploy dalam satu langkah |

### Ownership file/direktori (hindari edit bertabrakan)

**Akar friksi 2026-09-02: dua agen ngedit file sama di working tree yang sama, barengan.** Aturan:

| Owner | Path | Agen lain |
|---|---|---|
| **Semeru** | `src/**`, `migrations/**`, `stream-gateway/*.mjs` (logika), `proxy-standalone/handler.mjs`+`server.mjs` (logika), `scripts/**`, `docs/**`, `README*.md`, `CLAUDE.md`, `.cursor/rules/**`, `vitest.config.ts`, `.gitattributes`, `.gitignore` | Cursor **lapor di chat** kalau nemu bug / mau ubah wording — Semeru yang edit. Kalau Semeru idle & perubahan trivial, Cursor boleh tapi **ping dulu** + trailer `Agent: Rinjani`. |
| **Cursor** | `*.service`, `stream-gateway/install.sh`, `proxy-standalone/oracle-*.sh`, `.cursor/environment.json` `.cursor/settings.json` `.cursor/mcp.json`, `wrangler.toml` (resource id/binding), eksekusi `wrangler`/`ssh`/`scp`/`aws` | Semeru boleh baca, tapi tidak edit deploy-mechanics tanpa minta Cursor. |

**Plan file (`docs/superpowers/plans/*.md`) = SEMERU ONLY.** Cursor lapor hasil (step pass/fail, output, version id) **di chat**; Semeru yang tulis ke plan file. Jangan dua-duanya nulis ke file yang sama.

**Timing:** satu agen aktif di tree pada satu waktu. Handoff eksplisit ("Semeru selesai X, giliran Cursor Y"). Jangan jalan paralel di area yang overlap.

**Scratch/diagnostik:** `.tmp-*` sudah di-gitignore. Cursor: taruh spike/diagnostic file di `.tmp-*` atau di luar repo, jangan di root — `git add -A` bisa nyapu.

**Konvensi:** branch `rinjani/<slug>` / `krakatau/<slug>`; commit trailer `Agent: Rinjani` / `Agent: Krakatau` / `Agent: Semeru`;
status di plan file & handoff diprefiks `[Semeru]` / `[Rinjani]` / `[Krakatau]` + tanggal.

**Infra live (Stage 0–4 deployed 2026-09-02):**
- Worker `binance-future-hunter.jaringan.workers.dev` (version `e511dcad`).
- D1 = **instance existing** (`database_id 3600a9bb-9261-492a-bf06-3a11b0448f4e`
  di `wrangler.toml`). User batalkan rencana D1/KV baru — lanjut yang ada.
  Migrations 0001–0014 applied `--remote`.
- VPS AWS `svm-vps` (`13.212.7.132`, SSH Host `svm-vps`): `whale-binance-proxy`
  (:8080) + `whale-stream-gateway` (:8081, `!forceOrder@arr` always-on +
  on-demand depth watch) + Caddy TLS. Relay: `https://13.212.7.132.sslip.io`.
- Secret di-set: `PROXY_URL`, `PROXY_SECRET`. Belum di-set (opsional):
  `ADMIN_SECRET` (dashboard SELALU 403 tanpa ini),
  `DISCORD_WEBHOOK_URL`/`NOTIFY_WEBHOOK_URL`, `TELEGRAM_*`.

**Backlog Krakatau (tunggu acc eksplisit — jangan mulai):**
- **Relay REST kedua** (mitigasi weight-ban IP tunggal — `whale-binance-proxy`
  1 IP sudah pernah kena `-1003`/HTTP 418). Deploy instance ke-2
  `proxy-standalone/` di host BEDA (Fly.io `sin` / Deno / VPS ke-2, **BUKAN**
  Vercel — sudah retired) + `PROXY_URL_2`/`PROXY_SECRET_2`. **Setelah** failover
  terverifikasi live: Rinjani naikkan `ENTRY_WATCHLIST_SIZE`
  (`src/entryWatchlist.ts`) 250 → 350–500.
- Provision D1/KV baru — **dibatalkan** (lihat di atas); re-evaluate terpisah.

## Konvensi kode (wajib)

- **Pure engine + thin wrapper** — logika di modul murni; tool handler tipis (`fullPipeline.ts`, `institutionalFlow.ts`).
- **Test : source ~1:1** — setiap modul berperilaku non-trivial butuh `.test.ts` di sebelahnya.
- **No new npm deps** — runtime cuma `@modelcontextprotocol/sdk` + `zod`. Jangan tambah package tanpa diskusi eksplisit.
- **Jangan rename `whalescope_*` tool names** — backward compat MCP connector; tool `binance_*` baru OK.
- **Dokumentasi jujur** — threshold/heuristik harus ditandai "belum dikalibrasi" kalau belum ada data backtest.
- **Secrets** — `wrangler secret put`, never hardcode.

## Roadmap rebrand (≠ Tahap Pipeline 1–5 di `docs/full_pipeline_framework.md`)

| Stage | Status |
|---|---|
| 0 rebrand → `binance-future-hunter` | ✅ deployed |
| 1 institutional flow — CFTC trend, `binance_analyze_institutional_flow` (mig 0012) | ✅ deployed |
| 2 backtest rigor — outcomes cron (mig 0013), execution-aware backtest, `calibrate-ranking-weights.mjs`, ranking sub-scores (mig 0014) | ✅ deployed |
| 3 real-time — `binance_watch_orderbook_realtime` (on-demand depth watch, WS `@depth@100ms`) | ✅ deployed + live-verified |
| 4 — `notify.ts` multi-channel + dashboard read-only (`/dashboard`, `/api/dashboard/*`) | ✅ deployed |
| Deferred | Leverage Bracket riil (butuh API key Binance, butuh desain Semeru dulu). Relay REST kedua + `ENTRY_WATCHLIST_SIZE` (backlog Krakatau di atas). Whale-wallet-discovery spec `docs/superpowers/specs/2026-09-01-whale-wallet-discovery.md` (belum jadi Task) |

Detail per-task + hasil live-verify: plan file Stage 3-4 (status block atas).

**Follow-up tuning tercatat (BUKAN bug):** ambang wall depth-watch `$250k`
kekecilan buat buku BTC (churn tinggi); `EVENT_BUFFER_PER_SYMBOL=500` penuh
cepat di pair likuid. Lihat plan file.

## Dokumen wajib baca sebelum desain fitur

- `README.md`
- `docs/full_pipeline_framework.md`
- `docs/mm_detection_framework.md`
- `wrangler.toml` (komentar D1/KV rebrand, cron, subrequest limits)

## Verifikasi sebelum selesai (Claude)

```bash
npm run typecheck && npm test
```

Deploy/migrate remote = tugas **Krakatau** (Cursor), bukan Semeru. Tunggu acc user.
