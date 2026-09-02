# Stage 3-4 — Real-time Depth Watch + Dashboard/Notify + Ranking Sub-Score Persist

> [Semeru] 2026-09-02: Ditulis setelah Stage 0-2 selesai + committed
> (`3bb8f0e`, branch `rinjani/stage-0-2`). **VPS produksi = AWS**
> (`svm-vps`, 13.212.7.132) — Oracle historis.
> Agent: **Rinjani** untuk semua Task koding (selesai). **Krakatau**
> (Cursor) untuk deploy — **user acc 2026-09-02**. Deploy PARSIAL (step 2-4
> ok, step 1 AWS SG blocker) — hasil di status bawah. Semeru (Claude Code)
> tidak jalanin deploy/`--remote`/SSH/SG.
>
> **PROGRES 2026-09-02 — KODE SELESAI, DEPLOY PARSIAL (blocker AWS SG):**
>
> Branch `rinjani/stage-0-2` (PR #1, `jaringan-bot/binance-future-hunter`).
> Tip commit `e745f7d`, di-push, sinkron dengan origin.
> Verifikasi: `tsc` bersih · **849 src test** (`npm test`) · **51 stream-gateway
> test** (`cd stream-gateway && node --test`).
>
> | Task | Status | Commit | Deploy footprint |
> |---|---|---|---|
> | A0 dynamic MMR buffer | ✅ kode | `5e0790f` | worker deploy |
> | A migration 0014 + persist 4 sub-skor ranking | ✅ kode | `89e467c` | **`--remote` migrate** + worker deploy |
> | C notify.ts multi-channel (Telegram/Discord/webhook) | ✅ kode + README ID/EN | `449efae` | worker deploy (secret Discord/webhook opsional, skip) |
> | D dashboard read-only `/dashboard` + `/api/dashboard/*` | ✅ kode + README ID/EN | `68a3dc0` | worker deploy (butuh `ADMIN_SECRET` biar aktif) |
> | D2 README proxy-relay rewrite + `.dev.vars.example` + error wording | ✅ | `467a86e`, `4c690cf` | — (docs) |
> | B on-demand depth watch + `binance_watch_orderbook_realtime` | ✅ kode + docs §3.2b | `2e36543` | **stream-gateway scp+install** + worker deploy |
> | B-fix degrade tool saat relay non-JSON (bukan crash) + `.gitattributes` eol=lf | ✅ kode | `e745f7d` | worker deploy (WAJIB — live `0d2006a8` masih versi crash) |
> | service `ExecStart` → `/usr/bin/env node` (blocker bootstrap AWS) | ✅ | `2e36543` (`.service`), `c450ba1` (bootstrap heredoc) | dipakai step 2 install |
> | E provision D1/KV baru / relay kedua / `ENTRY_WATCHLIST_SIZE` | ⛔ TIDAK dikerjakan | — | user putuskan lanjut instance lama untuk Stage 0-2 |
>
> **HASIL DEPLOY [Krakatau] 2026-09-02** (worker `binance-future-hunter.jaringan.workers.dev`, version `0d2006a8-6724-425c-b7de-091bb6a9ba4a`):
>
> | Step | Status | Catatan |
> |---|---|---|
> | 1. AWS SG 80/443 | ❌ **BLOCKER** | Inbound TCP 80/443 masih tertutup. `curl` timeout dari luar DAN dari dalam VPS (hairpin) ke `https://13.212.7.132.sslip.io/*`. Caddy `:80/:443` listen OK — blocker murni Security Group. Cursor sudah enable plugin `aws-core` (`.cursor/settings.json`, untuntracked) — coba `authorize-security-group-ingress` sendiri, atau console. |
> | 2. Stream-gateway scp+install | ✅ | `install.sh` butuh `sed -i 's/\r$//'` (CRLF Windows checkout — di-fix `e745f7d` `.gitattributes` buat pull berikutnya). Service `active`. Local: `curl localhost:8081/stream/health` → `"depthWatch":{"count":0,"maxWatches":8,"activeWatches":[]}` ✅ |
> | 3. D1 migrate `--remote` | ✅ | Hanya `0014` pending (0011-0013 sudah applied sebelumnya) → applied. **No drift.** |
> | 4. `wrangler deploy` | ✅ (versi crash) | `npm ci` + typecheck + 841 test hijau. Deployed. TAPI ini SEBELUM `e745f7d` → `binance_watch_orderbook_realtime` masih crash. **Perlu re-deploy `e745f7d`.** |
> | 5. Verify live | ⚠️ PARSIAL | `GET /` ✅ · `cme_get_institutional_positioning_trend` ✅ (1 laporan, FLAT) · `binance_analyze_institutional_flow` ✅ (align 100, 1/3 komponen — CFTC+HL belum ada data) · `binance_watch_orderbook_realtime` ❌ `Cannot read properties of undefined (reading 'ok')` — root cause: worker gagal reach `PROXY_URL` (SG blocked) + bug degrade (di-fix `e745f7d`) |
> | 6. Merge PR #1 | ⏸ SKIPPED | Tunggu step 1 + watch tool hijau |
>
> **Sisa buat lanjut (Krakatau / user):**
> 1. **AWS SG `13.212.7.132` inbound TCP 80 + 443 dari `0.0.0.0/0`.** Setelah
>    itu: `curl -m 10 https://13.212.7.132.sslip.io/{health,stream/health}`.
> 2. **Re-deploy worker** buat pick up `e745f7d` (`git pull && npx wrangler
>    deploy`). Live `0d2006a8` masih versi crash.
> 3. **`install.sh` CRLF (re-deploy).** `.gitattributes` fix cuma kena checkout
>    BARU — `git pull` tidak re-materialize `install.sh` yang tak berubah.
>    Sekali aja: `git rm -r --cached . && git checkout .` (LF-normalize working
>    tree, tanpa ubah konten) ATAU `sed` lagi.
> 4. Re-verify `binance_watch_orderbook_realtime` round-trip (call 1 arm →
>    tunggu ~5s → call 2 pakai `sinceMs` → `WALL_*` events).
> 5. Merge PR #1.
>
> **Semeru (Claude Code) TIDAK jalanin deploy/SG/`--remote`/SSH.** Standby
> buat debug output (drift, verify gagal, health tak sesuai). Diagnosis +
> fix `e745f7d` (Semeru) di-commit oleh Cursor dari working tree bersama.

## Goal

Tutup 3 gap yang tersisa dari plan "binance-future-hunter lebih powerful":
Stage 3 (deteksi real-time lebih dalam), Stage 4 (dashboard + multi-channel
notify), dan satu gap yang ditemukan pas kerjakan kalibrasi Stage 2 (4
sub-skor komponen ranking belum jadi kolom D1, cuma di notes string --
lihat komentar `scripts/calibrate-ranking-weights.mjs`).

## Constraints Global (sama semua Task)

- **Reuse, jangan reimplementasi.** Cek dulu fungsi murni yang sudah ada
  sebelum nulis baru -- pola pure-engine + thin-wrapper dipertahankan.
- **Tidak ada dependency npm baru** (`package.json` cuma
  `@modelcontextprotocol/sdk` + `zod`).
- **Nol subrequest Binance baru kalau bisa reuse fetch yang sudah ada** --
  ikuti disiplin `fullPipeline.ts`/`dcaPipelineEngine.ts`.
- Verifikasi tiap Task: `npm run typecheck && npm test` harus hijau
  SEBELUM lanjut Task berikutnya.
- Commit per-Task, trailer `Agent: Rinjani`, format ikuti commit
  `3bb8f0e` (deskripsi ringkas per-bagian, bukan cuma "wip").
- **TIDAK menjalankan**: `wrangler deploy`, `wrangler d1 migrations apply
  --remote`, `wrangler secret put`, SSH VPS. Itu Task D (Krakatau, gated).

---

## Task A0 — Buffer MMR dinamis dari volume ✅ SELESAI (`5e0790f`)

> [Semeru] 2026-09-02: dibahas terpisah sama user, keputusan final "Opsi C
> dulu" (bukan fetch leverageBracket riil yang butuh API key user -- itu
> ditunda, lihat "Item terpisah" di bawah, TETAP tidak dikerjakan di sini).

**Kenapa**: `liquidationPrice = avgEntryPrice * (1 - 1/leverage + 0.005)`
(`src/gridRiskEngine.ts:228-229`) pakai buffer MMR flat 0.5% buat SEMUA
pair. Riset (web search, tervalidasi ke sumber Binance): pair kecil/altcoin
MMR riil bisa **3x lebih tinggi** (contoh NOMUSDT tier 21x-50x = 1.50%).
Arah error-nya SELALU optimistic-salah buat risk tool: MMR riil lebih
tinggi -> liquidation riil lebih dekat ke entry -> tool bisa bilang "SAFE"
padahal liquidation bisa di atas stop-loss. `entryAlertCron` scan top-250
pair (bukan cuma BTC/ETH), dan capital-solve AKTIF nyari leverage
tertinggi yang masih SAFE/MODERATE -- persis di titik boundary yang paling
kena dampak error ini.

**Files:**
- `src/binanceFetcher.ts` -- `BinanceMarketData` interface tambah
  `quoteVolumeUsd?: number` (OPSIONAL, bukan required -- lihat alasan di
  Steps). `fetchBinanceMarketData()` tambah fetch ticker24hr (atau reuse
  kalau sudah ada fetch lain di fungsi itu) buat isi field ini.
- `src/gridRiskEngine.ts` -- fungsi murni baru
  `estimateMaintenanceMarginBufferPct(quoteVolumeUsd: number | undefined):
  number`:
  ```
  HIGH_LIQUIDITY_THRESHOLD_USD = 500_000_000  // heuristik, BELUM dikalibrasi
  MID_LIQUIDITY_THRESHOLD_USD  = 50_000_000   // ke bracket table Binance riil
  >= HIGH -> 0.005  (0.5%, default lama -- BTC/ETH/top pair)
  >= MID  -> 0.0075 (0.75%)
  default (termasuk undefined/unknown) -> 0.015 (1.5%, sesuai contoh NOMUSDT)
  ```
  `undefined` HARUS jatuh ke tier PALING KONSERVATIF (1.5%) -- data hilang
  tidak boleh diam-diam dianggap "aman"/high-liquidity, itu justru
  mengulang bug yang sedang diperbaiki.
  Ganti literal `+ 0.005` di `calculateGridRisk()` jadi
  `+ estimateMaintenanceMarginBufferPct(marketData.quoteVolumeUsd)`.
- `src/tools/fullPipeline.ts` -- baris ~716-719 (self-assembled
  `BinanceMarketData`, `quoteVolumeUsd` SUDAH ada di scope dari Wave 1,
  lihat baris 441-443) -- tambah field itu ke object yang di-construct.
- `src/tools/futuresGridRisk.ts` -- tidak perlu diubah kalau
  `fetchBinanceMarketData()` sudah handle sendiri.

**Steps:**
- [ ] `quoteVolumeUsd` OPSIONAL di `BinanceMarketData` (BUKAN required) --
      supaya TIDAK breaking change ke semua fixture test yang sudah
      construct `BinanceMarketData` literal (grep dulu berapa banyak
      call-site sebelum putuskan required vs optional, tapi default ke
      optional+conservative-fallback kecuali ada alasan kuat sebaliknya).
- [ ] `estimateMaintenanceMarginBufferPct()` + test (kasus high/mid/low/
      undefined, pastikan undefined = tier paling konservatif).
- [ ] Wire ke `calculateGridRisk()`, test existing
      `gridRiskEngine.test.ts` HARUS tetap pass (kalau ada test yang
      hardcode angka liquidationPrice dengan asumsi buffer 0.5% flat,
      pair test itu harus disuplai `quoteVolumeUsd` tinggi biar tidak
      berubah perilaku -- BUKAN mengubah assertion existing tanpa alasan).
- [ ] Wire `quoteVolumeUsd` di `fullPipeline.ts` self-assembly.
- [ ] `binanceFetcher.ts` fetch ticker24hr (via proxy, BUKAN direct
      `fapi.binance.com` -- perhatikan komentar existing di
      `fullPipeline.ts:335-336` soal `fetchBinanceMarketData()` yang
      sekarang direct-fetch dan WAF-blocked di produksi; kalau memang
      sudah blocked, tambahan ini tidak memperbaiki itu, cuma jangan
      memperparah -- pertimbangkan lewat proxy yang sama seperti
      `binanceProxyClient.ts` kalau memungkinkan tanpa ubah scope besar).
- [ ] Update `docs/full_pipeline_framework.md` §12.2 (margin-mode caveat)
      -- catat mitigasi ini eksplisit sebagai heuristik-belum-tervalidasi,
      BUKAN diklaim sudah akurat.
- [ ] `npm run typecheck && npm test`.

---

## Task A — Migration 0014: persist 4 sub-skor ranking ✅ SELESAI (`89e467c`)

**Kenapa**: `scoreTier1Signals()` (`src/pipelineEngine.ts`) menghasilkan 4
komponen (`mmComponent` 35%, `smartMoneyComponent` 30%, `regimeComponent`
20%, `buyPressureComponent` 15%) yang di-jumlah jadi `rankingScore`, tapi
cuma `rankingScore` final yang tersimpan ke `pipeline_decision_log`. Script
kalibrasi (`scripts/calibrate-ranking-weights.mjs`) fit ulang bobot 4
komponen itu -- TANPA nilai per-komponen historis, kalibrasi cuma bisa
jalan kalau caller re-derive 4 komponen itu dari kolom lain (mmComponent
dari `grid_risk_status` tidak cukup, informasinya hilang). Ini blocker
nyata buat kalibrasi jalan pakai data production asli.

**Files:**
- `migrations/0014_pipeline_decision_ranking_components.sql` (baru) --
  `ALTER TABLE pipeline_decision_log ADD COLUMN mm_component REAL;` +
  3 kolom sejenis (`smart_money_component`, `regime_component`,
  `buy_pressure_component`), semua nullable, pola sama migration 0013.
- `src/pipelineDecisionLog.ts` -- `PipelineDecisionLogRow` tambah 4 field
  opsional, `toPipelineDecisionLogRow()` isi dari
  `result.rankingBreakdown` (cek `SymbolPipelineResult` di
  `src/tools/fullPipeline.ts` -- kalau `scoreTier1Signals()` belum
  mengembalikan breakdown per-komponen terpisah dari `rankingScore` total,
  tambah return field itu DI `scoreTier1Signals()` sendiri,
  `src/pipelineEngine.ts` -- JANGAN hitung ulang di layer lain, satu
  sumber kebenaran).
- `src/d1Client.ts` -- `insertPipelineDecisionLogs`/`queryPipelineDecisionLog`/
  `mapPipelineDecisionLogRow` (sekitar baris 726-844) tambah 4 kolom baru,
  pola identik kolom existing.
- Test: extend `src/pipelineDecisionLog.test.ts` (kalau ada) atau file
  d1Client yang relevan -- cek 4 kolom baru ke-mapping benar.

**Steps:**
- [ ] Migration 0014 (nullable, additive -- JANGAN backfill row lama,
      row lama biarkan NULL selamanya, sama filosofi 0013).
- [ ] `scoreTier1Signals()` return breakdown 4 komponen eksplisit (bukan
      cuma total).
- [ ] Wire breakdown ke `toPipelineDecisionLogRow()` -> d1Client insert/query.
- [ ] `npm run typecheck && npm test`.
- [ ] Update comment di `scripts/calibrate-ranking-weights.mjs` yang
      nyebut gap ini ("4 sub-skor belum jadi kolom D1") -- hapus/update
      begitu kolomnya ada (script masih tetap terima JSON export manual,
      TIDAK auto-connect ke D1 -- itu keputusan disengaja sebelumnya,
      jangan diubah).

---

## Task B — Stage 3: on-demand real-time order-book depth watch

**Kenapa**: `docs/mm_detection_framework.md` §3.2 eksplisit bilang ini
"belum dibangun" -- deteksi spoofing sekarang cuma REST 2-snapshot
(`binance_get_orderbook_delta`, jeda 1.5 detik), bukan sub-detik riil.
`stream-gateway/` VPS sekarang cuma pegang `!forceOrder@arr` +
`!contractInfo` (market-wide, bukan per-symbol).

**Files:**
- `stream-gateway/depthWatch.mjs` (baru) -- ikuti pola `ws-client.mjs`
  (backoff array, watchdog liveness) TAPI per-symbol ON-DEMAND, bukan
  always-on:   buka `wss://fstream.binance.com/ws/<symbol>@depth@100ms` di **AWS VPS
  produksi** (verified Krakatau spike 2026-09-02, ~588 msg/60s — black-hole
  Oracle tidak apply). TTL 5 menit per subscribe (default), auto-
  unsubscribe + close WS kalau tidak ada permintaan baru sebelum TTL
  habis -- supaya VPS 1GB tidak overload (constraint sama kayak alasan
  `WALL_SCAN_WATCHLIST` dipotong dari 50->15 pair, lihat `src/shared.ts`).
- `stream-gateway/server.mjs` -- endpoint baru `POST /stream/watch`
  (body: `{symbol, ttlMs?}`, mulai/extend watch, balikin
  `{watching: true, expiresAt}`) + `GET /stream/depth-diff?symbol=&sinceMs=`
  (baca event wall-lifecycle yang sudah di-deteksi dari watch aktif,
  404/`{watching:false}` kalau tidak ada watch aktif untuk symbol itu).
  Auth sama (`x-proxy-secret` header, `safeEqual()`) kayak endpoint lain
  di file ini.
- `src/streamGatewayClient.ts` -- fungsi baru `watchOrderBook(symbol, ttlMs)`
  + `fetchDepthDiff(symbol, sinceMs)`, pola sama `fetchLiquidations`/
  `fetchContractEvents` yang sudah ada (degrade graceful,
  `StreamGatewayError`).
- `src/tools/realtimeStream.ts` -- tool baru
  `binance_watch_orderbook_realtime` (input: `symbol`, `ttlMs` optional).
  Response `degraded: true` + reason kalau gateway belum di-upgrade/watch
  belum aktif (pola sama 2 tool existing di file ini).

**Steps:**
- [x] Spike test (Krakatau 2026-09-02, AWS `svm-vps` 13.212.7.132) — **UNBLOCKED**
      | # | URL | Upgrade | 1st msg | Msgs/60s |
      |---|---|---|---|
      | 1 | `fstream…/btcusdt@depth@100ms` | OK | 75ms | 588 |
      | 2 | `fstream…/btcusdt@aggTrade` | OK | — | 0 (silent) |
      | 3 | `fstream…/stream?streams=…depth@100ms` | OK | 193ms | 587 |
      | 4 | `dstream…/btcusdt@depth@100ms` | OK | 62ms | 587 |
      | 5 | spot depth | OK | 82ms | 600 |
      **Keputusan:** Rinjani lanjut `depthWatch.mjs` pakai `fstream` `#1` atau `#3`
      di **AWS VPS produksi**. Black-hole Oracle tidak generalize ke AWS.
- [x] Implement `stream-gateway/depthWatch.mjs` (per-symbol `@depth@100ms`,
      coarse book, WALL_APPEARED/GREW/SHRANK/VANISHED, TTL + maxWatches,
      warmup) + `server.mjs` `POST /stream/watch` + `GET /stream/depth-diff`
      (+ POST body reader di `createServer`) + wire di `index.mjs`
      (`STREAM_DEPTH_WS_BASE`=fstream, `STREAM_DEPTH_MAX_WATCHES`=8).
- [x] `src/streamGatewayClient.ts` `watchOrderBook()` + `fetchDepthDiff()`
      (POST helper, degrade graceful) + tool
      `binance_watch_orderbook_realtime` (`src/tools/realtimeStream.ts`),
      catalog metadata + count 76→77.
- [x] Test: `stream-gateway/depthWatch.test.mjs` (13) +
      `stream-gateway/server.test.mjs` (extend, 11) +
      `src/tools/realtimeStream.test.ts` (extend, 6). 51 gateway test /
      841 src test pass.
- [x] `docs/mm_detection_framework.md` + `.en.md` §3.2/§3.2b diperbarui
      (hapus "belum dibangun", jelasin lifecycle event + TTL/maxWatches +
      limitasi "bukan L2 penuh").
- [x] Fix service `ExecStart`: `/usr/bin/env node` + `Environment=PATH`
      (node di `/usr/local/bin` di AWS, bukan `/usr/bin`) --
      `whale-binance-proxy.service` + `whale-stream-gateway.service`.
- [ ] `npm run typecheck && npm test`.

---

## Task C — Stage 4a: multi-channel notification ✅ SELESAI (`449efae`)

**Files:**
- `src/notify.ts` (baru) -- interface `NotificationChannel { send(text):
  Promise<void> }`. Implementasi: `TelegramChannel` (WRAP
  `sendTelegramAlert` yang ada di `src/telegram.ts`, JANGAN tulis ulang
  logic-nya -- perilaku harus identik ke caller lama), `DiscordChannel`
  (webhook POST `{content: text}`, opsional -- skip kalau
  `DISCORD_WEBHOOK_URL` kosong, pola sama Telegram sekarang: log +
  skip, JANGAN throw/gagalin cron), `GenericWebhookChannel` (POST JSON
  `{text}` ke `NOTIFY_WEBHOOK_URL` kalau di-set, opsional juga).
  `dispatchNotification(env, text)` -- fan-out ke SEMUA channel yang
  ke-konfigurasi (Promise.allSettled, satu channel gagal tidak
  menggagalkan yang lain, sama filosofi `sendTelegramAlert` yang sudah
  ada: "gak pernah throw").
- `src/index.ts` -- tambah `DISCORD_WEBHOOK_URL?`, `NOTIFY_WEBHOOK_URL?`
  ke interface `Env` (optional, comment jelas sama pola field lain).
- `src/cron/entryAlertCron.ts`, `src/cron/heartbeatCron.ts`,
  `src/cron/infraHealthCron.ts` -- ganti `sendTelegramAlert(env, text)`
  jadi `dispatchNotification(env, text)`. **JANGAN ubah isi pesan/format**
  di 3 file ini, cuma ganti pemanggilan fungsi.

**Steps:**
- [ ] `src/notify.ts` + test (`src/notify.test.ts`, mock fetch pola sama
      `src/telegram.test.ts`).
- [ ] Wire `Env` interface.
- [ ] Ganti 3 caller cron (grep `sendTelegramAlert` buat pastikan semua
      lokasi ke-cover, termasuk `maybeNotifyDailyCircuit`/
      `maybeNotifyMacroCircuit` di `entryAlertCron.ts`).
- [ ] `npm run typecheck && npm test`.
- [ ] README: section baru "Notifikasi Multi-Channel" (ID+EN), jelasin
      `DISCORD_WEBHOOK_URL`/`NOTIFY_WEBHOOK_URL` opsional, Telegram tetap
      default/satu-satunya yang wajib kalau mau notifikasi sama sekali.

## Task D — Stage 4b: dashboard read-only ✅ SELESAI (`68a3dc0`)

**Files:**
- `src/tools/../dashboardApi.ts` atau langsung di `src/index.ts` --
  endpoint baru `GET /api/dashboard/pipeline-decisions`,
  `/api/dashboard/signals`, `/api/dashboard/whales`,
  `/api/dashboard/circuit-breaker` -- reuse query function `d1Client.ts`
  yang SUDAH ADA (`queryPipelineDecisionLog`, `querySignalHistory`,
  `queryHyperliquidWhaleRecentByCoin`, dst -- JANGAN bikin query D1 baru
  kalau yang lama sudah cukup). Gate akses sama persis pola
  `/admin/usage` (`isAuthorized(key, env.ADMIN_SECRET)`, 403 generic kalau
  gagal, reuse `src/adminUsage.ts` -- JANGAN bikin secret/auth baru).
- `src/index.ts` -- route `GET /dashboard` (bukan `/mcp`, bukan
  `/admin/*`) serve 1 file HTML+JS inline (TEMPLATE STRING di file yang
  sama atau file terpisah di-import sebagai string -- TIDAK ada build
  step, TIDAK ada framework, vanilla fetch() ke endpoint di atas + render
  tabel). Route ini JUGA gated `?key=<ADMIN_SECRET>` sama seperti
  `/admin/usage` -- dashboard ini punya-mu sendiri, bukan publik.

**Steps:**
- [ ] 4 endpoint `/api/dashboard/*` + test (pola test HTTP handler yang
      sudah ada kalau ada, kalau tidak ada precedent, test fungsi
      query-nya lewat d1Client test yang sudah ada, endpoint-nya cukup
      typecheck).
- [ ] 1 halaman HTML+JS inline, `/dashboard` route.
- [ ] `npm run typecheck && npm test`.
- [ ] README: section "Dashboard" (ID+EN) -- cara akses, kenapa gated key
      yang sama dengan admin usage.

---

## Task D2 — README: perbaiki section proxy yang basi ✅ SELESAI (`467a86e`, `4c690cf`)

**Kenapa**: `README.md`/`README.en.md` bagian "Setup Proxy Vercel (wajib,
sekali saja)" masih instruksikan Vercel sebagai jalur utama/wajib --
padahal per `proxy-standalone/README.md:3-4`, Vercel relay **sudah
retired** (dipause Vercel sendiri, bukan keputusan proyek ini).
`proxy-standalone/` (deploy VPS/Fly.io/Deno/Render) adalah jalur yang
sebenarnya dipakai sekarang. User baru yang ikut README apa adanya bakal
coba setup sesuatu yang sudah tidak berfungsi.

**Files:**
- `README.md`/`README.en.md` -- ganti section "Setup Proxy Vercel (wajib,
  sekali saja)" jadi mengarah ke `proxy-standalone/README.md` sebagai
  jalur utama (VPS/Fly.io/Deno/Render, bukan Vercel). Sebut Vercel HANYA
  sebagai catatan historis ("relay awal proyek ini, sekarang retired"),
  bukan instruksi setup aktif.
- `src/binanceProxyClient.ts` -- opsional, kalau sempat: genericize
  wording error message yang masih hardcode "Vercel" (`Cek PROXY_SECRET
  cocok antara worker dan Vercel...`, `Gagal menghubungi proxy Vercel...`)
  jadi netral ("proxy relay") -- `PROXY_URL`/`PROXY_URL_2` sudah host-
  agnostic di levelkode, cuma pesan errornya yang ketinggalan.

**Steps:**
- [ ] Update kedua README.
- [ ] (opsional) genericize wording error di `binanceProxyClient.ts`.
- [ ] `npm run typecheck && npm test` (perubahan ini murni dokumentasi +
      string, harusnya tidak mengubah behavior test manapun -- kalau ada
      test yang assert isi pesan error mengandung kata "Vercel", update
      assertion-nya juga).

---

## Task E — Krakatau (GATED, tunggu acc eksplisit user sebelum mulai APAPUN)

Backlog infra terbaru (update dari CLAUDE.md -- keputusan D1/KV BARU
sudah final per user 2026-09-01, BUKAN numpang `whalescope-mcp` lama):

1. `npx wrangler d1 create binance-future-hunter-db` +
   `npx wrangler kv namespace create WHALESCOPE_CONFIG` -- copy
   `database_id`/`id` hasil ke `wrangler.toml` (ganti value placeholder
   yang ada sekarang, binding TETAP `DB`/`CONFIG_KV`).
2. `npx wrangler d1 migrations apply binance-future-hunter-db --remote`
   -- migration 0001 s/d TERBARU (0014 kalau Task A sudah kelar duluan),
   database baru kosong, semua migration jalan urut.
3. Set secret wajib (belum ke-copy dari worker lama): `PROXY_URL`,
   `PROXY_SECRET`. Opsional: `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`,
   `ADMIN_SECRET`, `DISCORD_WEBHOOK_URL`/`NOTIFY_WEBHOOK_URL` (kalau Task
   C sudah kelar), `ALLOWED_ORIGINS`. Daftar lengkap: `.dev.vars.example`.
4. `npx wrangler deploy`.
5. Verifikasi live: `curl https://<worker-url>/` -> JSON
   `"name": "binance-future-hunter"`. Test minimal 3 tool baru (curl
   JSON-RPC ke `/mcp`, contoh format di README "Uji coba manual").
6. **Task B (Stage 3) butuh SSH VPS** buat deploy `stream-gateway/`
   update + spike-test `@depth@100ms` (lihat Task B step 1) -- ini
   koordinasi Krakatau DI TENGAH Rinjani ngerjain Task B, bukan di akhir.
7. Push branch + buka PR (kalau belum) -- branch sekarang
   `rinjani/stage-0-2` tracking `origin/semeru/agent-rules-docs` (nama
   tracking-nya kelihatan mismatch, cek dulu apa ini sengaja sebelum
   push).
8. **Relay REST kedua (mitigasi weight-ban IP tunggal).**
   [Semeru] 2026-09-02, dibahas terpisah sama user: Vercel (`proxy/`)
   SUDAH RETIRED (dipause Vercel sendiri untuk commercial-use di Hobby
   plan -- lihat `proxy-standalone/README.md:3-4`, BUKAN keputusan kita).
   Setelah REST relay full pindah ke VPS (`proxy-standalone/` sebagai
   `whale-binance-proxy`), SEMUA traffic Binance keluar dari 1 IP -- kena
   weight-ban Binance HTTP 418 -1003 sekali (insiden nyata, lihat komentar
   `src/entryWatchlist.ts:29-34`), mitigasi sementara watchlist
   entry-alert diturunkan 350->250 pair. Solusi proper (SUDAH ada
   mekanismenya di kode, `PROXY_URL_2`/`PROXY_SECRET_2` di
   `binanceProxyClient.ts`, cuma belum ada target kedua yang live): deploy
   SATU LAGI instance `proxy-standalone/` di host BEDA (opsi termurah dari
   `proxy-standalone/README.md`: Fly.io free tier region `sin`, Deno
   Deploy $0, atau VPS kedua ~$5/bulan -- JANGAN pakai Vercel lagi, sudah
   retired), lalu `wrangler secret put PROXY_URL_2` +
   `wrangler secret put PROXY_SECRET_2`. Setelah itu verifikasi failover
   jalan (matikan primary sementara, cek worker tetap dapat data lewat
   secondary), baru naikkan `ENTRY_WATCHLIST_SIZE`
   (`src/entryWatchlist.ts`) balik ke 350-500 -- itu perubahan KODE
   (Rinjani), bukan infra, kerjakan SETELAH relay kedua terverifikasi
   live, jangan naikkan watchlist duluan sebelum ada IP kedua.

**JANGAN mulai Task E sebelum user bilang eksplisit "acc deploy" atau
sejenisnya di chat.**

---

## Item terpisah -- BUKAN bagian plan ini, butuh Semeru dulu

**Leverage Bracket riil** (`/fapi/v1/leverageBracket`, buat akurasi
`liquidationPrice` di `gridRiskEngine.ts`) -- endpoint SIGNED/USER_DATA,
butuh API key Binance dari user. Ini perubahan model kredensial pertama
di proyek ini (sekarang 100% read-only tanpa kredensial akun) -- BUTUH
desain eksplisit (opsional per-call API key vs skip) sebelum jadi Task
buat Rinjani. Jangan dikerjakan dari plan ini.
