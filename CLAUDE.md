# Claude Code — binance-future-hunter

Ringkasan untuk sesi architect. Cursor rules detail ada di `.cursor/rules/`.

## Apa ini

MCP server Cloudflare Worker untuk analisis Binance Futures (~90 modul TS, ~90 file test).
Bukan greenfield. Bukan Telegram bot — `src/telegram.ts` = **outbound notifier** 1-arah saja.
Stage 4 rencana: generalisasi ke `notify.ts` (belum ada).

## Stack nyata

| Komponen | Lokasi | Deploy |
|---|---|---|
| Worker + cron + MCP | `src/`, `wrangler.toml` | `npx wrangler deploy` (manual, by design) |
| D1 time-series | `migrations/`, binding `DB` | `wrangler d1 migrations apply … --remote` |
| KV config | binding `CONFIG_KV` | jarang write |
| Binance REST relay | `proxy-standalone/` | Vercel + systemd di Oracle VPS |
| WS liquidations | `stream-gateway/` | systemd `whale-stream-gateway` + Caddy |

**Tidak ada:** Docker, docker-compose, Nginx, GitHub Actions → VPS, Telegraf/webhook bot.

## Pembagian peran — nama gunung untuk identifikasi

| Nama | Peran | Dijalankan sebagai |
|---|---|---|
| **Semeru** | Architect & Problem Solver — spec, desain logika, debug rumit, verifikasi lokal | Claude Code (sesi ini) |
| **Rinjani** | Builder & Executor — koding, refactor, boilerplate, test, siapkan commit/PR | Cursor Agent (mode normal) |
| **Krakatau** | Infra & Deploy — `d1 migrations apply --remote`, `wrangler deploy`, `secret put`, SSH VPS. **GATED: hanya setelah user acc** | Cursor Agent (mode infra) |
| **Ijen** | Reviewer — `/code-review`, ultrareview, audit diff pre-merge | Claude cloud (user-triggered) |
| **Bromo** | Observability — uptime eksternal + CF alert (Stage 4) | belum ada |

| | Semeru (Claude) | Rinjani / Krakatau (Cursor) |
|---|---|---|
| Boleh | `typecheck`, `npm test`, `wrangler dev` | Rinjani: kode + test + commit prep. Krakatau: `--remote`, `wrangler deploy`, secrets, SSH VPS |
| Jangan | `--remote`, deploy, SSH, secret put | Redesign arsitektur tanpa spec; gabung perubahan kode + aksi deploy dalam satu langkah |

**Konvensi:** branch `rinjani/<slug>` / `krakatau/<slug>`; commit trailer `Agent: Rinjani` / `Agent: Krakatau`;
status di plan file & handoff diprefiks `[Semeru]` / `[Rinjani]` / `[Krakatau]` + tanggal.

**Backlog Krakatau (tunggu acc — jangan mulai):** (1) commit+push Stage 0–2, (2) migrate 0012/0013 `--remote`, (3) `wrangler deploy` + verify `GET /`.

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
| 0–2 | **Kode selesai, BELUM di-commit/deploy** — lihat detail di bawah |
| 3 | Belum ditulis — VPS/stream-gateway; spec: `docs/superpowers/specs/2026-09-01-whale-wallet-discovery.md` |
| 4 | Belum ditulis — observability eksternal + generalisasi `notify.ts` |
| Deferred | Leverage Bracket riil (butuh API key Binance) |

### Stage 0–2 — kode selesai, BELUM di-commit/deploy

Kode + test lokal hijau (`typecheck` bersih, ~800 test). Semua masih di working tree `main` (untracked/modified). **Belum:** commit, push, PR, `d1 migrations apply --remote`, `wrangler deploy`. Itu tugas Cursor setelah user acc.

- **0011** (`pipeline_decision_log`) = **SUDAH merged** (`8beca7b`, PR #36)
- **0012/0013** = **BELUM** — file `?? migrations/0012…`, `?? migrations/0013…`

**Stage 2 — kode selesai (termasuk):**
- migration 0013 + `pipelineDecisionOutcomeCron` (backfill `forward_return_*`)
- `scripts/calibrate-ranking-weights.mjs` — standalone, input JSON export manual, **TIDAK auto-apply**
  - GAP follow-up: 4 sub-skor komponen belum jadi kolom D1 (baru di notes string) → butuh migration 0014 / ubah `scoreTier1Signals` return breakdown
- backtest execution-aware: `fee_bps` (def 4) + `slippage_bps` (def 2), `net = gross − 2·(fee+slip)/1e4` — bukan replay order-book penuh
- CFTC trend + `binance_analyze_institutional_flow` — file untracked (`src/institutionalFlow.ts`, crons, tools)

**Jangan tulis "deployed"** sampai commit + migrate remote + deploy terverifikasi di git.

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
