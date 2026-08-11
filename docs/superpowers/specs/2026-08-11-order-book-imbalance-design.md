# Order Book Imbalance (OBI) — Design

## Latar Belakang

`binance_get_order_book_depth` (tool existing) cuma kasih snapshot mentah bid/ask — user harus baca tabel dan hitung sendiri selisih volume bid vs ask. Belum ada tool yang langsung menghitung persentase imbalance antara total volume Bid vs Ask secara kumulatif di beberapa level kedalaman harga teratas.

## Tujuan

Tool MCP baru yang menghitung Order Book Imbalance (OBI) — rasio persen bid vs ask volume — di beberapa depth level sekaligus (5, 10, 20), plus label bias otomatis.

## Arsitektur

Tidak ada infra baru. Tool baru murni komputasi di atas data yang sudah bisa diambil lewat `binanceProxyClient.getOrderBookDepth` (fungsi existing, dipakai juga oleh `binance_get_order_book_depth`).

Alur: 1x panggil `getOrderBookDepth(symbol, 20)` — ambil depth level 20, cukup untuk menghitung ketiga level (5/10/20) sekaligus lewat slicing array, tidak perlu 3x round-trip ke proxy.

## Rumus

Untuk tiap depth level N (5, 10, 20):

```
bidVol = sum(qty) dari top N bids
askVol = sum(qty) dari top N asks
bidPct = bidVol / (bidVol + askVol) * 100
bias   = bidPct > 60 ? "BULLISH (bid dominan)"
       : bidPct < 40 ? "BEARISH (ask dominan)"
       : "SEIMBANG"
```

Volume dihitung dari **raw base-asset quantity** (bukan notional/price×qty) — konsisten dengan `binance_get_order_book_depth` existing yang juga pakai raw qty untuk deteksi wall.

## Komponen

- **`src/server.ts`** — tambah 1 tool block baru, `binance_get_order_book_imbalance`, ditempatkan setelah `binance_get_order_book_depth` (sekitar line 601). Input schema: `{ symbol: symbolSchema }` (tanpa param depth — 3 level dihitung sekaligus, sama pola `binance_get_multi_timeframe_bias`).
- **`src/binanceProxyClient.ts`** — tidak diubah, reuse `getOrderBookDepth` yang sudah ada.
- Tidak ada file baru.

## Error Handling

- Error proxy/network → pola existing: `try/catch` → `errorResult(err)`.
- Salah satu sisi (bid atau ask) kosong di level tertentu (order book super tipis, pair illiquid) → `bidVol + askVol = 0` untuk level itu → hindari division by zero, tampilkan "TIDAK ADA DATA" untuk depth itu, bukan crash atau `NaN`.

## Testing

Mengikuti convention project (tidak ada test runner, manual verify):

- `npm run typecheck`
- Manual verify via `wrangler dev` lokal, lalu preview deployment: panggil tool untuk BTCUSDT (order book tebal, harus selalu ada data di semua 3 level) dan satu pair kecil/illiquid (cek edge case tipis/kosong tidak crash)

## Scope Eksplisit

- **Tidak termasuk**: histori OBI dari waktu ke waktu (cuma snapshot sesaat, sama seperti `binance_get_order_book_depth`).
- **Tidak termasuk**: weighting berbasis notional (price × qty) — pakai raw qty, konsisten dengan tool depth existing.
- **Tidak mengubah**: `binance_get_order_book_depth` (tool existing) tetap ada apa adanya.
