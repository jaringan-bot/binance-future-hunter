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

**Backlog Krakatau (tunggu acc — jangan mulai), detail lengkap Task E di**
**`docs/superpowers/plans/2026-09-02-stage-3-4-realtime-dashboard.md`:**
(1) provision D1/KV **BARU** (`binance-future-hunter-db` + namespace baru —
keputusan final 2026-09-01: TIDAK numpang resource `whalescope-mcp` lama),
(2) migrate 0001–0014 `--remote` ke DB baru itu, (3) set secret wajib
(`PROXY_URL`/`PROXY_SECRET`, belum ke-copy dari worker lama), (4) `wrangler
deploy` + verify `GET /`, (5) push branch `rinjani/stage-0-2` + PR (cek
tracking branch-nya dulu, kelihatan mismatch ke `origin/semeru/agent-rules-docs`),
(6) **relay REST kedua** — Vercel (`proxy/`) SUDAH RETIRED (dipause
Vercel sendiri, lihat `proxy-standalone/README.md:3-4`), REST relay VPS
tunggal (`whale-binance-proxy`) sudah pernah kena weight-ban Binance HTTP
418 -1003 (1 IP nanggung semua traffic) — deploy instance kedua
`proxy-standalone/` (Fly.io/Deno/VPS kedua, BUKAN Vercel) + wire
`PROXY_URL_2`/`PROXY_SECRET_2`, baru setelah itu Rinjani naikkan
`ENTRY_WATCHLIST_SIZE` balik ke 350–500 (`src/entryWatchlist.ts`).

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
| 0–2 | **Kode selesai + COMMITTED** (`3bb8f0e`, branch `rinjani/stage-0-2`), **BELUM deploy** — lihat detail di bawah |
| 3 | Plan ditulis (Task B) — `docs/superpowers/plans/2026-09-02-stage-3-4-realtime-dashboard.md`. Whale-wallet-discovery spec (`docs/superpowers/specs/2026-09-01-whale-wallet-discovery.md`) sudah ada dari sebelumnya, cakupan beda (Bagian A whale/options data, bukan depth watch) |
| 4 | Plan ditulis (Task C/D, plan file sama dengan Stage 3) — multi-channel `notify.ts` + dashboard read-only |
| 0014 (follow-up Stage 2) | Plan ditulis (Task A, plan file sama) — persist 4 sub-skor ranking ke D1 |
| Deferred | Leverage Bracket riil (butuh API key Binance, butuh desain Semeru dulu sebelum jadi Task) |

### Stage 0–2 — kode selesai + committed, BELUM deploy

Kode + test lokal hijau (`typecheck` bersih, 808 test), commit `3bb8f0e` di branch `rinjani/stage-0-2` (tracking `origin/semeru/agent-rules-docs`, ahead 1 — cek dulu apa mismatch ini sengaja sebelum push). **Belum:** push, PR, provision D1/KV baru, `d1 migrations apply --remote`, `wrangler deploy`. Itu Task E (Krakatau) di plan Stage 3-4, tunggu acc user.

- **0011** (`pipeline_decision_log`) = **SUDAH merged** (`8beca7b`, PR #36)
- **0012** (`cftc_positioning_history`), **0013** (`pipeline_decision_outcomes`) = kode selesai + committed, **BELUM di-apply ke D1 remote manapun**

**Stage 2 — kode selesai + committed (termasuk):**
- migration 0013 + `pipelineDecisionOutcomeCron` (backfill `forward_return_*`)
- `scripts/calibrate-ranking-weights.mjs` (+ test) — standalone, input JSON export manual, **TIDAK auto-apply**
  - GAP follow-up: 4 sub-skor komponen belum jadi kolom D1 (baru di notes string) → migration 0014, lihat plan Stage 3-4 Task A
- backtest execution-aware: `fee_bps` (def 4) + `slippage_bps` (def 2), `net = gross − 2·(fee+slip)/1e4` — bukan replay order-book penuh
- CFTC trend + `binance_analyze_institutional_flow` — `src/institutionalFlow.ts`, crons, tools

**Jangan tulis "deployed"** sampai migrate remote + deploy terverifikasi di git (commit sudah ada, deploy belum).

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
