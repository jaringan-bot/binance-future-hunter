# Real-Time Liquidation Stream — Design

> **UPDATE 2026-08-28 — SUPERSEDED / dibangun dengan arsitektur berbeda.**
> Bukan Durable Object di worker (spec di bawah), tapi komponen always-on
> `whale-stream-gateway` (`stream-gateway/` di repo): Node + `node:sqlite`,
> WS ke `dstream.binance.com` untuk always-on `!forceOrder@arr` (BUKAN
> `fstream` dari **IP Oracle** — di-black-hole; lihat catatan IP di bawah).
> **Produksi VPS = AWS ap-southeast-1** (`svm-vps`, 13.212.7.132) sejak
> 2026-09-02; Oracle (`146.235.17.228`) historis. HTTP read API di `/stream/*`
> di balik Caddy + relay. Worker baca via `PROXY_URL`. Tools
> `binance_get_realtime_liquidations` + `binance_get_contract_events`. Feed
> di-sampel Binance (1/symbol/detik). Spec DO di bawah dibiarkan sebagai
> catatan pendekatan yang tidak dipakai.
>
> **UPDATE 2026-08-22**: dikonfirmasi ULANG kali ketiga (sesi terpisah lagi,
> juga belum baca spec ini dulu) — kesimpulan sama persis, WAF block WS
> masih ada. Keputusan diambil: `binance_get_liquidation_history` (tool
> Coinalyze terakhir yang tersisa) DIHAPUS total dari codebase, bukan
> dibiarkan jalan pakai Coinalyze. Dicatat sebagai keterbatasan jujur di
> README (bagian Kekurangan) sampai ada budget/kebutuhan buat relay
> berbayar. `coinalyzeClient.ts` dan semua wiring `COINALYZE_API_KEY`
> sudah dihapus juga — proyek ini sekarang 100% Binance-native.
>
> **STATUS: DIBATALKAN (2026-08-11).** Spike test membuktikan `fstream.binance.com`
> (WS gateway) kena WAF block yang sama seperti `fapi.binance.com` — 403 Forbidden
> langsung dari IP Cloudflare Worker (dites via throwaway worker, lihat detail di
> bawah). Proxy Vercel existing (`proxy/api/binance.ts`) cuma Serverless Function
> request/response, gak bisa nahan WebSocket 24/7. Semua opsi relay yang viable
> (upgrade Vercel Pro ~$20/bulan, atau tambah service always-on ~$5/bulan di
> Fly.io/Railway) butuh biaya tambahan — diputuskan untuk tidak lanjut. Dokumen ini
> dibiarkan sebagai catatan kenapa pendekatan ini gak dipilih, bukan spec aktif.
>
> **Dikonfirmasi ulang independen 2026-08-12** (sesi terpisah, belum baca
> spec ini dulu): throwaway worker `whalescope-do-ws-test` di-deploy beneran
> (`wrangler deploy`, bukan cuma `wrangler dev --remote`), buka WS outbound
> ke `wss://fstream.binance.com/ws/btcusdt@aggTrade` — hasil SAMA, HTTP 403
> di step upgrade. Catatan tambahan dari sesi ini: `wrangler dev --remote`
> TIDAK reliable buat tes ini kalau DO class belum pernah di-deploy beneran
> (gagal duluan dengan error 1101 generik sebelum sempat nyoba WS-nya sama
> sekali) — kalau mau spike test serupa lagi nanti, langsung `wrangler
> deploy` throwaway worker, jangan andalkan `dev --remote` doang. Worker
> throwaway udah dihapus lagi (`wrangler delete`) setelah tes.

## Latar Belakang

`binance_get_liquidation_history` (tool existing) bersifat lagging/historis — data candlestick-based via Coinalyze, mencatat apa yang sudah terjadi per interval waktu. Tidak ada cara menangkap liquidation event detik demi detik saat terjadi. Binance tidak punya REST publik untuk liquidation market-wide (`/fapi/v1/allForceOrders` itu private, akun sendiri saja), jadi satu-satunya sumber real-time market-wide adalah WebSocket stream `!forceOrder@arr`.

## Tujuan

Tool MCP baru yang mengembalikan liquidation event terbaru (near-real-time), sebagai companion dari `binance_get_liquidation_history` yang historis — bukan pengganti.

## Pendekatan yang Dipertimbangkan

| Opsi | Deskripsi | Keputusan |
|---|---|---|
| A. WebSocket Hibernation API | DO buka WS outbound ke Binance, pakai `ctx.acceptWebSocket()` — bisa hibernate, hemat billing CPU | **Dipilih** |
| B. WebSocket biasa (non-hibernating) | DO tetap ke-load di memory selama WS hidup | Ditolak — biaya duration lebih mahal, tidak dapat resilience platform |
| C. Polling REST berkala | Ganti stream jadi polling endpoint force-order | Ditolak — tidak ada endpoint REST publik market-wide untuk liquidation |

## Arsitektur

Durable Object baru `LiquidationStreamDO`, singleton (1 instance global via `idFromName("global")`). DO membuka WebSocket outbound ke `wss://fstream.binance.com/ws/!forceOrder@arr`, memakai WebSocket Hibernation API. MCP tool baru query DO ini lewat RPC call — bukan lewat WS langsung dari client MCP.

Binding baru di `wrangler.toml`: `durable_objects` binding + `migrations` block (`new_sqlite_classes`). DO menyimpan buffer event di SQLite storage bawaan DO (bukan in-memory) agar buffer survive hibernation.

## Komponen

- **`src/liquidationStreamDO.ts`** (baru) — class `LiquidationStreamDO extends DurableObject`
  - `constructor` — cek koneksi WS existing (`ctx.getWebSockets()`); kalau kosong, panggil `connect()`
  - `connect()` — buka `new WebSocket("wss://fstream.binance.com/ws/!forceOrder@arr")`, `ctx.acceptWebSocket(ws, ["binance-forceorder"])`
  - `webSocketMessage(ws, message)` — parse JSON forceOrder event, normalize `{symbol, side, price, qty, notionalUsd, time}`, INSERT ke tabel SQLite `liquidations`, trim buffer ke max 500 row
  - `webSocketClose(ws, code, reason)` / `webSocketError(ws, error)` — `ctx.storage.setAlarm(Date.now() + 5000)` untuk reconnect
  - `alarm()` — cek WS masih ada & OPEN; kalau tidak, `connect()` ulang
  - `getRecent(symbol?, limit)` — RPC method, query SQLite filtered by symbol (kalau dikasih) + limit, return array event

- **`src/index.ts`** — tambah `LIQUIDATION_DO: DurableObjectNamespace` ke interface `Env`, teruskan env ke `createServer(env)` (perlu refactor signature — saat ini `createServer()` tidak menerima env)

- **`src/server.ts`** — tool baru `binance_get_realtime_liquidations` (param: `symbol` optional, `limit` optional), handler ambil DO stub via `env.LIQUIDATION_DO.idFromName("global")`, panggil `.getRecent(symbol, limit)`

- **`wrangler.toml`** — tambah `[[durable_objects.bindings]]` + `[[migrations]]` block

## Alur Data

```
Binance !forceOrder@arr (WS push kontinu)
        │
        ▼
LiquidationStreamDO.webSocketMessage()
  → parse & normalize event
  → INSERT ke SQLite table `liquidations`
  → trim: keep last 500 row saja
        │
        ▼ (persistent, DO bisa hibernate di antara event)

MCP tool call: binance_get_realtime_liquidations(symbol?, limit)
        │
        ▼
src/index.ts fetch handler
  → env.LIQUIDATION_DO.idFromName("global")
  → stub.getRecent(symbol, limit)   [RPC, DO wake kalau lagi hibernate]
        │
        ▼
SELECT ... WHERE symbol = ? (kalau ada) ORDER BY time DESC LIMIT ?
        │
        ▼
Balik ke MCP caller: list event {symbol, side, price, qty, notionalUsd, time}
```

DO ini satu instance jalan terus-menerus, terpisah dari siklus request MCP (yang stateless per-call). WS connect pertama kali ter-trigger saat DO pertama kali di-spawn (first tool call ke arah dia) — kalau MCP server belum pernah dipanggil sejak deploy, buffer masih kosong sampai WS nyambung dan event pertama masuk.

## Error Handling

- **WS putus** (`webSocketClose`/`webSocketError`) → alarm reconnect 5 detik kemudian. Fixed 5s interval, tidak perlu backoff kompleks — Binance stream jarang reject kalau tidak spam connect.
- **Malformed/unexpected message** → skip diam-diam (tidak throw, tidak putus koneksi), agar 1 event aneh tidak menjatuhkan seluruh stream.
- **Buffer kosong** (DO baru pertama kali jalan, belum ada event masuk) → tool return array kosong + note text: "Stream baru mulai, buffer masih kosong. Coba lagi beberapa saat."
- **DO error/exception di tool call** → propagate sebagai MCP tool error biasa (pola sama semua tool lain sekarang).
- **Symbol filter tidak match apapun** → return array kosong, bukan error (symbol valid tapi kebetulan belum ada liquidation event masuk untuk dia).

## Testing

Project tidak punya test runner (hanya `typecheck` + manual verify tiap PR, konsisten dengan histori — fix casing sebelumnya ketahuan dari testing manual di Vercel preview). Mengikuti pola yang sama:

- `npm run typecheck` — pastikan type DO, RPC, binding Env beres
- Manual verify lewat `wrangler dev` lokal: pantau console log tiap event forceOrder masuk, atau cek lewat Cloudflare dashboard Observability (`enabled = true` di wrangler.toml)
- Manual verify di preview deployment: panggil tool `binance_get_realtime_liquidations` dari MCP client, cek balikan sesuai simbol yang lagi rame (misal BTCUSDT saat volatile)
- Tidak menambah test framework baru — mengikuti convention project (YAGNI)

## Scope Eksplisit

- **Tidak termasuk**: fitur Order Book Imbalance (OBI) — dibahas terpisah, spec sendiri setelah ini.
- **Tidak termasuk**: alerting/notifikasi keluar (Slack, webhook) — tool ini murni query buffer via MCP, bukan push notification.
- **Tidak mengubah**: `binance_get_liquidation_history` (tool existing) tetap ada apa adanya sebagai data historis via Coinalyze.
