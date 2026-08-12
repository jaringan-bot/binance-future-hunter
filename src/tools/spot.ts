import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtPrice, fmtPct, fmtTime } from "../format.js";
import { symbolSchema, KLINE_INTERVAL_ENUM, errorResult, parseTimeParam } from "../shared.js";
import { computeCvdFromTrades, summarizeKlines } from "../toolHelpers.js";
import { getPairThreshold } from "./config.js";

export function registerSpotTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // SPOT PRICE — harga spot Binance + basis riil vs futures mark price.
  // Basis futures_get_funding_rate dihitung vs INDEX price (rata-rata
  // beberapa exchange, bisa noisy). Basis di sini vs SPOT PRICE Binance
  // langsung — lebih akurat untuk baca apakah pump/dump didorong leverage
  // (futures) atau demand riil (spot), TAPI cuma jalan untuk pair yang
  // listed di Binance Spot (banyak pair futures-only, seperti koin baru,
  // TIDAK punya spot listing — tool ini akan error jelas untuk kasus itu).
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_spot_price",
    {
      title: "Harga Spot Binance + Basis vs Futures",
      description:
        "Mengambil harga SPOT Binance (bukan Futures) untuk sebuah pair, plus basis riil terhadap mark price Futures. " +
        "Basis di sini dihitung vs harga SPOT BINANCE LANGSUNG (bukan index price rata-rata beberapa exchange seperti di " +
        "binance_get_funding_rate) — lebih akurat untuk membedakan apakah sebuah pergerakan harga didorong leverage " +
        "(futures premium/discount melebar vs spot) atau demand/supply riil (spot dan futures bergerak selaras). " +
        "Basis melebar tiba-tiba menandakan futures mulai memimpin/leverage-driven — early warning sebelum funding rate " +
        "sempat menyusul naik/turun. " +
        "PENTING: banyak pair di Binance Futures adalah FUTURES-ONLY (terutama koin baru/kecil) dan TIDAK punya listing " +
        "di Binance Spot — tool ini akan gagal dengan error jelas untuk pair semacam itu (bukan bug, memang tidak ada " +
        "harga spot Binance untuk dibandingkan). " +
        "Untuk deteksi basis arbitrage (docs/mm_detection_framework.md Section 5): panggil binance_check_spot_listing dulu " +
        "kalau belum yakin pair-nya listed di Spot, dan ingat tool ini cuma snapshot sesaat — deteksi 'basis melebar lalu " +
        "kembali' butuh panggil berkali-kali manual, tidak ada tool histori basis time-series.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const [spot, futures, customThreshold] = await Promise.all([
          binanceProxy.getSpotPrice(symbol),
          binanceProxy.getCurrentFundingRateNative(symbol),
          getPairThreshold(symbol),
        ]);
        const spotPrice = parseFloat(spot.price);
        const markPrice = parseFloat(futures.markPrice);
        const basis = (markPrice - spotPrice) / spotPrice;

        // Default 0.05% — sama dengan default basis di binance_get_funding_rate,
        // bisa dioverride per-pair lewat binance_set_pair_threshold.
        const BASIS_THRESHOLD = customThreshold?.basisThreshold ?? 0.0005;
        const usingCustomThreshold = customThreshold?.basisThreshold !== undefined;
        const basisInterpretation =
          basis >= BASIS_THRESHOLD
            ? "PREMIUM (futures di atas spot — leverage/demand futures lebih agresif dari demand spot, waspada kalau melebar cepat)"
            : basis <= -BASIS_THRESHOLD
              ? "DISKON (futures di bawah spot — tekanan short/leverage di futures lebih agresif dari sell pressure spot)"
              : "NETRAL (futures dan spot selaras dekat — pergerakan harga kemungkinan didorong demand/supply riil, bukan leverage semata)";

        const text = [
          `# Harga Spot — ${symbol}`,
          ``,
          `- Harga Spot Binance: ${fmtPrice(spotPrice)}`,
          `- Mark Price Futures: ${fmtPrice(markPrice)}`,
          `- Basis (Futures vs Spot): ${fmtPct(basis, 4)}`,
          ``,
          `**Interpretasi Basis**: ${basisInterpretation}`,
          ``,
          `_Threshold basis dipakai: ±${fmtPct(BASIS_THRESHOLD, 4)}${usingCustomThreshold ? " (CUSTOM, di-set lewat binance_set_pair_threshold)" : " (default global)"}. ` +
            `Basis di sini vs harga SPOT BINANCE LANGSUNG, beda dari basis di binance_get_funding_rate yang vs INDEX price ` +
            `(rata-rata beberapa exchange). Kalau tool ini error "Invalid symbol", pair tersebut FUTURES-ONLY (tidak listed ` +
            `di Binance Spot) — basis futures-vs-spot tidak bisa dihitung untuk pair semacam itu._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, spotPrice, markPrice, basis, basisInterpretation, basisThreshold: BASIS_THRESHOLD, usingCustomThreshold },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  // ─────────────────────────────────────────────────────────────
  // SPOT MARKET — pelengkap tool binance_get_spot_price di atas. Semua
  // tool di bawah ini LANGSUNG dari Binance Spot API (api.binance.com,
  // lewat proxy market=spot), TERPISAH dari harga/likuiditas Futures.
  // Berguna untuk bedain gerakan harga yang didorong leverage (Futures)
  // vs demand/supply riil (Spot). Banyak tool di sini punya versi Futures
  // yang sudah ada duluan (binance_get_order_book_depth, binance_get_klines,
  // binance_get_agg_trades, binance_get_24hr_ticker) — versi Spot ini
  // sengaja dibuat mirip supaya gampang dibandingkan berdampingan.
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_spot_ticker_24hr",
    {
      title: "Statistik 24 Jam (Spot)",
      description:
        "Mengambil ringkasan statistik 24 jam di pasar SPOT Binance (bukan Futures): harga terakhir, perubahan %, " +
        "high/low, volume, VWAP (weighted average price), dan jumlah trade — LANGSUNG dari Binance native ticker/24hr Spot. " +
        "Bandingkan dengan binance_get_24hr_ticker (versi Futures) untuk pair yang sama: kalau volume/perubahan spot jauh " +
        "lebih kecil dari futures, pergerakan harga kemungkinan besar didorong leverage bukan demand riil. " +
        "PENTING: error 'Invalid symbol' berarti pair tersebut FUTURES-ONLY (tidak listed di Binance Spot).",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getSpotTicker24hr(symbol);
        const lastPrice = parseFloat(data.lastPrice);
        const priceChangePercent = parseFloat(data.priceChangePercent);
        const priceChange = parseFloat(data.priceChange);
        const highPrice = parseFloat(data.highPrice);
        const lowPrice = parseFloat(data.lowPrice);
        const vwap = parseFloat(data.weightedAvgPrice);
        const volume = parseFloat(data.volume);
        const quoteVolume = parseFloat(data.quoteVolume);

        const text = [
          `# Statistik 24 Jam (Spot) — ${symbol}`,
          ``,
          `- Harga Terakhir: ${fmtPrice(lastPrice)}`,
          `- Perubahan 24 Jam: ${priceChangePercent >= 0 ? "+" : ""}${priceChangePercent.toFixed(2)}% (${fmtPrice(priceChange)})`,
          `- High 24 Jam: ${fmtPrice(highPrice)}`,
          `- Low 24 Jam: ${fmtPrice(lowPrice)}`,
          `- VWAP (harga rata-rata tertimbang volume): ${fmtPrice(vwap)}`,
          `- Volume: ${fmtNum(volume, 2)} (≈ ${fmtNum(quoteVolume, 0)} quote asset)`,
          `- Jumlah Trade: ${fmtNum(data.count, 0)}`,
          ``,
          `_Data LANGSUNG dari Binance Spot native (ticker/24hr). Bandingkan quoteVolume ini dengan volume notional ` +
            `binance_get_24hr_ticker (Futures) untuk baca rasio futures/spot — rasio tinggi = gerakan lebih leverage-driven._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, lastPrice, priceChangePercent, vwap, volume, quoteVolume, count: data.count },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  server.registerTool(
    "binance_get_spot_book_ticker",
    {
      title: "Best Bid/Ask (Spot)",
      description:
        "Mengambil best bid/ask price + quantity real-time di pasar SPOT Binance — lebih ringan/cepat dari " +
        "binance_get_spot_order_book kalau cuma butuh spread sesaat, tanpa perlu full depth. Berguna untuk cross-check " +
        "spread spot vs spread futures (binance_get_order_book_depth): spread spot yang melebar tiba-tiba bisa jadi " +
        "tanda likuiditas riil menipis, terlepas dari kondisi order book futures.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getSpotBookTicker(symbol);
        const bidPrice = parseFloat(data.bidPrice);
        const askPrice = parseFloat(data.askPrice);
        const spread = askPrice - bidPrice;
        const spreadPct = bidPrice !== 0 ? (spread / bidPrice) * 100 : 0;

        const text = [
          `# Best Bid/Ask (Spot) — ${symbol}`,
          ``,
          `- Bid: ${fmtPrice(bidPrice)} (qty ${fmtNum(parseFloat(data.bidQty), 4)})`,
          `- Ask: ${fmtPrice(askPrice)} (qty ${fmtNum(parseFloat(data.askQty), 4)})`,
          `- Spread: ${fmtPrice(spread)} (${spreadPct.toFixed(4)}%)`,
          ``,
          `_Data real-time dari Binance Spot native (ticker/bookTicker)._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, bidPrice, askPrice, spread, spreadPct },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  server.registerTool(
    "binance_get_spot_order_book",
    {
      title: "Order Book Depth (Spot)",
      description:
        "Mengambil snapshot order book (bid/ask) real-time di pasar SPOT Binance, LANGSUNG dari Binance native. " +
        "Versi Spot dari binance_get_order_book_depth (Futures) — berguna untuk bandingkan wall/likuiditas spot vs " +
        "futures: kalau wall besar cuma muncul di futures tapi tidak di spot, itu lebih mungkin leverage/spekulasi " +
        "daripada komitmen order riil dari holder. PENTING: snapshot SESAAT, order book berubah cepat.",
      inputSchema: {
        symbol: symbolSchema,
        limit: z
          .number()
          .int()
          .refine((v) => [5, 10, 20, 50, 100, 500, 1000, 5000].includes(v), {
            message: "limit harus salah satu dari: 5, 10, 20, 50, 100, 500, 1000, 5000 (sesuai batasan Binance Spot API)",
          })
          .default(20)
          .describe("Jumlah level bid/ask yang diambil per sisi. Harus salah satu dari: 5, 10, 20, 50, 100, 500, 1000, 5000."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit }) => {
      try {
        const data = await binanceProxy.getSpotOrderBook(symbol, limit);

        const bidRows = data.bids
          .slice(0, 10)
          .map(([price, qty]) => `| ${fmtPrice(parseFloat(price))} | ${fmtNum(parseFloat(qty), 4)} |`)
          .join("\n");
        const askRows = data.asks
          .slice(0, 10)
          .map(([price, qty]) => `| ${fmtPrice(parseFloat(price))} | ${fmtNum(parseFloat(qty), 4)} |`)
          .join("\n");

        const bestBid = data.bids[0] ? parseFloat(data.bids[0][0]) : null;
        const bestAsk = data.asks[0] ? parseFloat(data.asks[0][0]) : null;
        const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
        const spreadPct = spread !== null && bestBid !== null ? (spread / bestBid) * 100 : null;

        const largestBid = data.bids.reduce(
          (max, [p, q]) => (parseFloat(q) > parseFloat(max[1]) ? [p, q] : max),
          data.bids[0] ?? ["0", "0"],
        );
        const largestAsk = data.asks.reduce(
          (max, [p, q]) => (parseFloat(q) > parseFloat(max[1]) ? [p, q] : max),
          data.asks[0] ?? ["0", "0"],
        );

        const text = [
          `# Order Book Depth (Spot) — ${symbol} (${limit} level per sisi)`,
          ``,
          `**Best Bid**: ${bestBid !== null ? fmtPrice(bestBid) : "N/A"} | **Best Ask**: ${bestAsk !== null ? fmtPrice(bestAsk) : "N/A"}`,
          `**Spread**: ${spread !== null ? fmtPrice(spread) : "N/A"} (${spreadPct !== null ? spreadPct.toFixed(4) : "N/A"}%)`,
          ``,
          `**Wall terbesar (Bid)**: harga ${fmtPrice(parseFloat(largestBid[0]))}, size ${fmtNum(parseFloat(largestBid[1]), 4)}`,
          `**Wall terbesar (Ask)**: harga ${fmtPrice(parseFloat(largestAsk[0]))}, size ${fmtNum(parseFloat(largestAsk[1]), 4)}`,
          ``,
          `## Top 10 Bids (harga tertinggi dulu)`,
          `| Harga | Quantity |`,
          `|---|---|`,
          bidRows,
          ``,
          `## Top 10 Asks (harga terendah dulu)`,
          `| Harga | Quantity |`,
          `|---|---|`,
          askRows,
          ``,
          `_Snapshot sesaat dari Binance Spot native. Order book berubah cepat — jangan overinterpretasi satu snapshot sebagai sinyal pasti._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, bestBid, bestAsk, spread, spreadPct },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  server.registerTool(
    "binance_get_spot_klines",
    {
      title: "Data Candlestick (Spot)",
      description:
        "Mengambil data candlestick OHLCV di pasar SPOT Binance untuk sebuah pair pada timeframe tertentu, LANGSUNG dari " +
        "Binance native. Versi Spot dari binance_get_klines (Futures) — bandingkan bias/volume kedua versi untuk pair yang " +
        "sama: kalau candle futures jauh lebih volatil/volumenya jauh lebih besar dari spot di jam yang sama, pergerakan " +
        "itu kemungkinan besar leverage-driven, bukan demand/supply riil. " +
        "Default (tanpa startTime/endTime) balikin candle TERBARU. Isi startTime untuk narik histori jauh ke belakang " +
        "(misal buat backtest) — maksimal `limit` candle per panggilan (limit maksimal 1000 untuk Spot, beda dari Futures " +
        "yang 1500). Untuk rentang lebih dari 1000 candle, panggil berkali-kali sambil geser startTime (pagination manual). " +
        "HEMAT TOKEN: default cuma balikin summary (bias, swing high/low, 15 candle terakhir) — array candle PENUH " +
        "TIDAK disertakan kecuali `includeCandles: true` diminta eksplisit.",
      inputSchema: {
        symbol: symbolSchema,
        interval: z
          .enum(KLINE_INTERVAL_ENUM)
          .describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(1000).default(100).describe("Jumlah candle yang diambil, maksimal 1000"),
        startTime: z
          .string()
          .optional()
          .describe(
            'Waktu mulai (ISO 8601, contoh "2026-07-01T00:00:00Z") — opsional, buat narik histori jauh ke belakang untuk backtest.',
          ),
        endTime: z
          .string()
          .optional()
          .describe("Waktu akhir (ISO 8601) — opsional, dipakai bareng startTime untuk membatasi window spesifik."),
        includeCandles: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Sertakan array candle PENUH di structuredContent -- default false biar hemat token. Set true kalau butuh proses data candle secara programatik.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit, startTime, endTime, includeCandles }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        const raw = await binanceProxy.getSpotKlinesNative(symbol, interval, limit, startMs, endMs);
        if (raw.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data candle Spot untuk ${symbol} @ ${interval}.` }] };
        }

        const { candles, lastClose, changePct, bias, swingHigh, swingLow } = summarizeKlines(raw);

        const recent = candles.slice(-15);
        const rows = recent
          .map(
            (c) =>
              `| ${fmtTime(c.openTime)} | ${fmtPrice(c.open)} | ${fmtPrice(c.high)} | ${fmtPrice(c.low)} | ${fmtPrice(c.close)} | ${fmtNum(c.volume, 2)} |`,
          )
          .join("\n");

        const text = [
          `# Candlestick (Spot) — ${symbol} @ ${interval} (${candles.length} candle)`,
          ``,
          `**Bias periode ini**: ${bias} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% dari candle pertama ke terakhir)`,
          `**Swing High**: ${fmtPrice(swingHigh)}`,
          `**Swing Low**: ${fmtPrice(swingLow)}`,
          `**Harga penutupan terakhir**: ${fmtPrice(lastClose)}`,
          ``,
          `## ${recent.length} Candle Terakhir`,
          `| Waktu Buka | Open | High | Low | Close | Volume |`,
          `|---|---|---|---|---|---|`,
          rows,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            interval,
            bias,
            changePct,
            swingHigh,
            swingLow,
            lastClose,
            ...(includeCandles ? { candles } : {}),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  server.registerTool(
    "binance_get_spot_agg_trades",
    {
      title: "Aggregate Trades / CVD (Spot)",
      description:
        "Mengambil trade individual terbaru (aggregate trades) di pasar SPOT Binance, termasuk sisi buy/sell aggressor " +
        "per trade. Versi Spot dari binance_get_agg_trades (Futures) — CVD spot menunjukkan tekanan beli/jual RIIL " +
        "(bukan leverage), cocok dibandingkan berdampingan dengan CVD futures untuk pair yang sama.",
      inputSchema: {
        symbol: symbolSchema,
        limit: z.number().int().min(1).max(200).default(50).describe("Jumlah trade terakhir yang diambil, maksimal 200."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit }) => {
      try {
        const trades = await binanceProxy.getSpotAggTrades(symbol, limit);
        if (trades.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data trade Spot untuk ${symbol}.` }] };
        }

        const { buyVolume, sellVolume, buyPct, cvd } = computeCvdFromTrades(trades);

        const recent = trades.slice(-15);
        const rows = recent
          .map((t) => {
            const side = t.m ? "SELL (taker)" : "BUY (taker)";
            return `| ${fmtTime(t.T)} | ${fmtPrice(parseFloat(t.p))} | ${fmtNum(parseFloat(t.q), 4)} | ${side} |`;
          })
          .join("\n");

        const text = [
          `# Aggregate Trades (Spot) — ${symbol} (${trades.length} trade terakhir)`,
          ``,
          `**CVD window ini**: ${cvd >= 0 ? "+" : ""}${fmtNum(cvd, 4)} (Buy: ${fmtNum(buyVolume, 4)} / Sell: ${fmtNum(sellVolume, 4)})`,
          `**Dominasi**: ${buyPct.toFixed(1)}% BUY vs ${(100 - buyPct).toFixed(1)}% SELL`,
          ``,
          `## ${recent.length} Trade Terakhir`,
          `| Waktu | Harga | Quantity | Sisi |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_CVD spot positif = demand beli riil dominan. Bandingkan dengan CVD binance_get_agg_trades (Futures) — kalau arahnya berlawanan, itu tanda spot dan futures sedang tidak selaras (salah satu leading, salah satu lagging)._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, cvd, buyVolume, sellVolume, buyPct },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  server.registerTool(
    "binance_get_spot_avg_price",
    {
      title: "Harga Rata-Rata Bergerak (Spot)",
      description:
        "Mengambil harga rata-rata bergerak (moving average price) terkini di pasar SPOT Binance, dihitung Binance " +
        "sendiri dari trade beberapa menit terakhir ('mins' pada response, biasanya 5 menit). Lebih stabil dari harga " +
        "last-trade sesaat (binance_get_spot_price) untuk kasus yang butuh referensi harga tidak gampang ter-spike " +
        "oleh satu trade outlier — Binance sendiri memakai ini di beberapa perhitungan risiko internal mereka.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getSpotAvgPrice(symbol);
        const price = parseFloat(data.price);
        const text = [
          `# Harga Rata-Rata Bergerak (Spot) — ${symbol}`,
          ``,
          `- Harga Rata-Rata (${data.mins} menit terakhir): ${fmtPrice(price)}`,
          ``,
          `_Data dari Binance Spot native (avgPrice). Berguna sebagai referensi harga yang lebih stabil dari last-trade sesaat._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, mins: data.mins, price },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  server.registerTool(
    "binance_check_spot_listing",
    {
      title: "Cek Status Listing Spot",
      description:
        "Mengecek apakah sebuah pair BENAR-BENAR listed di Binance Spot dan status tradingnya saat ini (TRADING, " +
        "BREAK, HALT, dll), LANGSUNG dari Binance native exchangeInfo. Gunakan ini SEBELUM memanggil tool Spot lain " +
        "untuk pair yang belum pasti listing-nya (banyak pair Futures, terutama koin baru/kecil, TIDAK punya listing " +
        "Spot sama sekali) — daripada menebak dari pesan error 'Invalid symbol' di tool lain.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const info = await binanceProxy.getSpotExchangeInfo(symbol);
        if (!info) {
          return {
            content: [
              {
                type: "text",
                text: `# Cek Listing Spot — ${symbol}\n\n**TIDAK LISTED** di Binance Spot. Pair ini kemungkinan besar futures-only (tidak punya pasangan trading di Spot).`,
              },
            ],
            structuredContent: { symbol, listed: false },
          };
        }

        const text = [
          `# Cek Listing Spot — ${symbol}`,
          ``,
          `**LISTED** di Binance Spot`,
          `- Status: ${info.status}`,
          `- Base Asset: ${info.baseAsset}`,
          `- Quote Asset: ${info.quoteAsset}`,
          `- Spot Trading Diizinkan: ${info.isSpotTradingAllowed ? "Ya" : "Tidak"}`,
          ``,
          `_Status selain "TRADING" (misal BREAK/HALT) berarti pair listed tapi order sedang tidak diproses normal._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { ...info, listed: true },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
