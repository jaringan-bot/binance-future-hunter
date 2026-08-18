import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtPrice, fmtTime } from "../format.js";
import {
  symbolSchema,
  pairSchema,
  KLINE_INTERVAL_ENUM,
  CONTRACT_TYPE_ENUM,
  errorResult,
  parseTimeParam,
  computeRealizedVolatility,
} from "../shared.js";
import { summarizeKlines, classifyPriceBias } from "../toolHelpers.js";

export function registerPriceTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // KLINES / PRICE ACTION untuk bias per-timeframe (Binance native)
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_klines",
    {
      title: "Data Candlestick (Klines)",
      description:
        "Candlestick OHLCV untuk sebuah pair per timeframe (native Binance, bukan Coinalyze — source of truth, presisi " +
        "harga menyesuaikan magnitude pair). Buat nentuin bias arah (bullish/bearish/sideways), cari swing high/low, " +
        "dan level psikologis buat estimasi zona SL/TP. " +
        "Default (tanpa startTime/endTime) balikin candle TERBARU. Isi startTime buat narik histori jauh ke belakang " +
        "(misal backtest grid) — Binance balikin candle MULAI dari startTime ke depan, maksimal `limit` candle/panggilan " +
        "(maks 1500 Futures). Rentang >1500 candle: panggil berkali-kali sambil geser startTime ke closeTime candle " +
        "terakhir (pagination manual). " +
        "HEMAT TOKEN: default cuma balikin summary (bias, swing high/low, 15 candle terakhir) — array candle PENUH " +
        "TIDAK disertakan kecuali `includeCandles: true` (500 candle penuh ≈14.000 token kalau selalu disertakan).",
      inputSchema: {
        symbol: symbolSchema,
        interval: z
          .enum(KLINE_INTERVAL_ENUM)
          .describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(1500).default(100).describe("Jumlah candle yang diambil, maksimal 1500"),
        startTime: z
          .string()
          .optional()
          .describe(
            'Waktu mulai (ISO 8601, contoh "2026-07-01T00:00:00Z") — opsional, buat narik histori jauh ke belakang untuk backtest, bukan cuma data terbaru.',
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
            "Sertakan array candle PENUH (semua field OHLCV per candle) di structuredContent -- default false biar hemat token. " +
              "Set true kalau butuh proses data candle secara programatik (backtest, kalkulasi custom), bukan cuma baca ringkasan.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit, startTime, endTime, includeCandles }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        const raw = await binanceProxy.getKlinesNative(symbol, interval, limit, startMs, endMs);
        if (raw.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data candle untuk ${symbol} @ ${interval}.` }] };
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
          `# Candlestick — ${symbol} @ ${interval} (${candles.length} candle)`,
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


  registerSafeTool(
    server,
    "binance_get_multi_timeframe_bias",
    {
      title: "Bias Multi-Timeframe Sekaligus",
      description:
        "Tool ringkas untuk langsung mendapatkan bias arah (Bullish/Bearish/Sideways) di 5 timeframe umum " +
        "(1m, 5m, 15m, 1h, 1d) dalam satu panggilan, tanpa perlu memanggil binance_get_klines berulang kali " +
        "(LANGSUNG dari Binance native, presisi harga menyesuaikan magnitude pair). " +
        "Cocok untuk menjawab pertanyaan 'apa bias BTCUSDT di semua timeframe saat ini'.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const timeframes: Array<{ interval: (typeof KLINE_INTERVAL_ENUM)[number]; limit: number; label: string }> = [
          { interval: "1m", limit: 60, label: "1 Menit" },
          { interval: "5m", limit: 60, label: "5 Menit" },
          { interval: "15m", limit: 60, label: "15 Menit" },
          { interval: "1h", limit: 48, label: "1 Jam" },
          { interval: "1d", limit: 30, label: "1 Hari" },
        ];

        const results = await Promise.all(
          timeframes.map(async (tf) => {
            const raw = await binanceProxy.getKlinesNative(symbol, tf.interval, tf.limit);
            if (raw.length === 0) return { ...tf, bias: "N/A", changePct: 0, lastClose: 0 };
            const closes = raw.map((k) => parseFloat(k[4]));
            const changePct = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
            const bias = classifyPriceBias(changePct);
            return { ...tf, bias, changePct, lastClose: closes[closes.length - 1] };
          }),
        );

        const rows = results
          .map(
            (r) =>
              `| ${r.label} (${r.interval}) | ${r.bias} | ${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}% | ${fmtPrice(r.lastClose)} |`,
          )
          .join("\n");

        const bullCount = results.filter((r) => r.bias === "BULLISH").length;
        const bearCount = results.filter((r) => r.bias === "BEARISH").length;
        let alignment: string;
        if (bullCount >= 4) alignment = "Mayoritas timeframe BULLISH — bias searah kuat ke atas.";
        else if (bearCount >= 4) alignment = "Mayoritas timeframe BEARISH — bias searah kuat ke bawah.";
        else alignment = "Timeframe TIDAK selaras (mixed) — hati-hati, kemungkinan sedang konsolidasi/transisi, cocokkan strategi scalp vs swing dengan timeframe yang relevan.";

        const text = [
          `# Bias Multi-Timeframe — ${symbol}`,
          ``,
          `| Timeframe | Bias | Perubahan | Harga Terakhir |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `**Kesimpulan**: ${alignment}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  registerSafeTool(
    server,
    "binance_get_realized_volatility",
    {
      title: "Realized Volatility (Historis)",
      description:
        "Menghitung realized volatility (RV) historis untuk sebuah pair Binance Futures di dua timeframe " +
        "(15 menit, ~24 jam terakhir; dan 1 jam, ~30 jam terakhir), LANGSUNG dari Binance native klines. " +
        "RV dihitung dari log-return antar candle close (RV = sqrt(mean(log_return^2)) * sqrt(periode/tahun)), " +
        "ditampilkan baik dalam bentuk annualized (%) maupun per-periode (%) supaya tidak menyesatkan untuk pair " +
        "kecil yang volatil (angka annualized saja bisa terlihat ekstrem tapi tidak intuitif). " +
        "RV tinggi menandakan range candle historis melebar dibanding biasanya — berguna untuk cross-check " +
        "dengan input i_atrMult di indikator Pine Script Grid Advisor saat mengkalibrasi lebar grid range.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const [klines15m, klines1h] = await Promise.all([
          binanceProxy.getKlinesNative(symbol, "15m", 96),
          binanceProxy.getKlinesNative(symbol, "1h", 30),
        ]);

        const closes15m = klines15m.map((k) => parseFloat(k[4]));
        const closes1h = klines1h.map((k) => parseFloat(k[4]));

        const rv15m = computeRealizedVolatility(closes15m, 35040);
        const rv1h = computeRealizedVolatility(closes1h, 8760);

        const text = [
          `# Realized Volatility — ${symbol}`,
          ``,
          `| Timeframe | Annualized | Per-Periode | Jumlah Candle |`,
          `|---|---|---|---|`,
          `| 15 Menit (~24 jam) | ${rv15m.annualizedPct.toFixed(2)}% | ${rv15m.periodPct.toFixed(4)}% | ${closes15m.length} |`,
          `| 1 Jam (~30 jam) | ${rv1h.annualizedPct.toFixed(2)}% | ${rv1h.periodPct.toFixed(4)}% | ${closes1h.length} |`,
          ``,
          `**Interpretasi**: RV annualized tinggi menandakan range candle historis melebar dibanding biasanya — ` +
            `gunakan angka per-periode untuk intuisi pergerakan riil per candle (annualized saja bisa terlihat ` +
            `ekstrem untuk pair kecil yang volatil). Cross-check dengan i_atrMult di Grid Advisor Pine Script ` +
            `saat mengkalibrasi lebar grid range.`,
          ``,
          `_Data LANGSUNG dari Binance native (klines). RV dihitung dari log-return close-to-close, bukan true range._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            rv15mAnnualizedPct: rv15m.annualizedPct,
            rv15mPeriodPct: rv15m.periodPct,
            rv1hAnnualizedPct: rv1h.annualizedPct,
            rv1hPeriodPct: rv1h.periodPct,
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  registerSafeTool(
    server,
    "binance_get_24hr_ticker",
    {
      title: "Statistik 24 Jam",
      description:
        "Mengambil ringkasan statistik 24 jam: harga terakhir, perubahan %, high/low 24 jam, volume — LANGSUNG dari Binance " +
        "native ticker/24hr (rolling window resmi Binance, bukan pendekatan dari 24 candle 1 jam seperti sebelumnya). " +
        "Cocok sebagai overview cepat sebelum masuk ke analisis lebih dalam.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getTicker24hrNative(symbol);
        const lastPrice = parseFloat(data.lastPrice);
        const priceChange = parseFloat(data.priceChange);
        const priceChangePercent = parseFloat(data.priceChangePercent);
        const highPrice = parseFloat(data.highPrice);
        const lowPrice = parseFloat(data.lowPrice);
        const volume = parseFloat(data.volume);

        const text = [
          `# Statistik 24 Jam — ${symbol}`,
          ``,
          `- Harga Terakhir: ${fmtPrice(lastPrice)}`,
          `- Perubahan 24 Jam: ${priceChangePercent >= 0 ? "+" : ""}${priceChangePercent.toFixed(2)}% (${fmtPrice(priceChange)})`,
          `- High 24 Jam: ${fmtPrice(highPrice)}`,
          `- Low 24 Jam: ${fmtPrice(lowPrice)}`,
          `- Volume: ${fmtNum(volume, 2)}`,
          ``,
          `_Data LANGSUNG dari Binance native (ticker/24hr — rolling window resmi, bukan pendekatan dari candle 1 jam)._`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  // ─────────────────────────────────────────────────────────────
  // MARK PRICE KLINES
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_mark_price_klines",
    {
      title: "Candlestick Mark Price",
      description:
        "Candlestick dari MARK PRICE (harga acuan liquidation/funding), BUKAN dari harga transaksi (trade) seperti " +
        "binance_get_klines. Field volume/jumlah trade/taker* di response akan selalu 0 karena tidak ada transaksi " +
        "riil di belakang harga sintetis ini. " +
        "PENTING: pakai tool ini untuk analisis pergerakan mark price (referensi liquidation price/funding), " +
        "BUKAN untuk technical analysis harga pasar biasa — untuk itu pakai binance_get_klines.",
      inputSchema: {
        symbol: symbolSchema,
        interval: z.enum(KLINE_INTERVAL_ENUM).describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(1500).default(100).describe("Jumlah candle yang diambil, maksimal 1500"),
        startTime: z.string().optional().describe('Waktu mulai (ISO 8601, contoh "2026-07-01T00:00:00Z") — opsional.'),
        endTime: z.string().optional().describe("Waktu akhir (ISO 8601) — opsional, dipakai bareng startTime."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit, startTime, endTime }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        const raw = await binanceProxy.getMarkPriceKlinesNative(symbol, interval, limit, startMs, endMs);
        if (raw.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data mark price candle untuk ${symbol} @ ${interval}.` }] };
        }
        const { candles, lastClose, changePct, bias, swingHigh, swingLow } = summarizeKlines(raw);
        const text = [
          `# Mark Price Candlestick — ${symbol} @ ${interval} (${candles.length} candle)`,
          ``,
          `**Bias periode ini**: ${bias} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`,
          `**Swing High**: ${fmtPrice(swingHigh)}`,
          `**Swing Low**: ${fmtPrice(swingLow)}`,
          `**Mark Price terakhir**: ${fmtPrice(lastClose)}`,
          ``,
          `_Ini candle MARK PRICE (acuan liquidation/funding), bukan harga transaksi. Bandingkan dengan ` +
            `binance_get_klines untuk melihat selisih mark price vs harga transaksi (basis)._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, interval, bias, changePct, swingHigh, swingLow, lastClose },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  // ─────────────────────────────────────────────────────────────
  // INDEX PRICE KLINES
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_index_price_klines",
    {
      title: "Candlestick Index Price",
      description:
        "Candlestick dari INDEX PRICE (harga acuan blended dari beberapa exchange spot, dasar perhitungan premium " +
        "index/funding rate), BUKAN dari harga transaksi (trade) Binance Futures. " +
        "PENTING: parameter pakai `pair` (format TANPA suffix margin-asset, contoh \"BTCUSD\"), BUKAN `symbol` " +
        "biasa (\"BTCUSDT\") — pair salah format akan error/kosong.",
      inputSchema: {
        pair: pairSchema,
        interval: z.enum(KLINE_INTERVAL_ENUM).describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(1500).default(100).describe("Jumlah candle yang diambil, maksimal 1500"),
        startTime: z.string().optional().describe('Waktu mulai (ISO 8601, contoh "2026-07-01T00:00:00Z") — opsional.'),
        endTime: z.string().optional().describe("Waktu akhir (ISO 8601) — opsional, dipakai bareng startTime."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pair, interval, limit, startTime, endTime }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        const raw = await binanceProxy.getIndexPriceKlinesNative(pair, interval, limit, startMs, endMs);
        if (raw.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data index price candle untuk ${pair} @ ${interval}.` }] };
        }
        const { candles, lastClose, changePct, bias, swingHigh, swingLow } = summarizeKlines(raw);
        const text = [
          `# Index Price Candlestick — ${pair} @ ${interval} (${candles.length} candle)`,
          ``,
          `**Bias periode ini**: ${bias} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`,
          `**Swing High**: ${fmtPrice(swingHigh)}`,
          `**Swing Low**: ${fmtPrice(swingLow)}`,
          `**Index Price terakhir**: ${fmtPrice(lastClose)}`,
          ``,
          `_Ini candle INDEX PRICE (blended dari beberapa exchange spot), dasar perhitungan premium index/funding rate._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { pair, interval, bias, changePct, swingHigh, swingLow, lastClose },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  // ─────────────────────────────────────────────────────────────
  // PREMIUM INDEX KLINES
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_premium_index_klines",
    {
      title: "Candlestick Premium Index",
      description:
        "Candlestick dari PREMIUM INDEX (selisih mark price vs index price, komponen utama perhitungan funding " +
        "rate), BUKAN dari harga transaksi (trade). Premium index positif konsisten = funding cenderung positif " +
        "(long bayar short), negatif konsisten = funding cenderung negatif. " +
        "PENTING: nilai candle di sini adalah RASIO premium (bukan harga absolut) — jangan dibaca seperti candle " +
        "harga biasa.",
      inputSchema: {
        symbol: symbolSchema,
        interval: z.enum(KLINE_INTERVAL_ENUM).describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(1500).default(100).describe("Jumlah candle yang diambil, maksimal 1500"),
        startTime: z.string().optional().describe('Waktu mulai (ISO 8601, contoh "2026-07-01T00:00:00Z") — opsional.'),
        endTime: z.string().optional().describe("Waktu akhir (ISO 8601) — opsional, dipakai bareng startTime."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit, startTime, endTime }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        const raw = await binanceProxy.getPremiumIndexKlinesNative(symbol, interval, limit, startMs, endMs);
        if (raw.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data premium index candle untuk ${symbol} @ ${interval}.` }] };
        }
        const { candles, lastClose, changePct, bias, swingHigh, swingLow } = summarizeKlines(raw);
        const text = [
          `# Premium Index Candlestick — ${symbol} @ ${interval} (${candles.length} candle)`,
          ``,
          `**Tren periode ini**: ${bias} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`,
          `**Premium tertinggi**: ${swingHigh}`,
          `**Premium terendah**: ${swingLow}`,
          `**Premium terakhir**: ${lastClose}`,
          ``,
          `_Nilai di atas adalah RASIO premium (mark price vs index price), bukan harga absolut. Premium positif ` +
            `konsisten cenderung mendorong funding rate positif (long bayar short), gunakan bersama ` +
            `binance_get_funding_rate untuk konfirmasi._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, interval, bias, changePct, swingHigh, swingLow, lastClose },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  // ─────────────────────────────────────────────────────────────
  // CONTINUOUS KLINES
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_continuous_klines",
    {
      title: "Candlestick Continuous Contract",
      description:
        "Candlestick untuk kontrak PERPETUAL/CURRENT_QUARTER/NEXT_QUARTER dari sebuah pair underlying, berguna " +
        "membandingkan harga kontrak dated (quarterly) vs perpetual di pair yang sama. " +
        "PENTING: parameter pakai `pair` (format TANPA suffix margin-asset, contoh \"BTCUSD\") + `contractType`, " +
        "BUKAN `symbol` biasa. Kontrak CURRENT_QUARTER/NEXT_QUARTER TIDAK selalu tersedia untuk semua pair " +
        "(cuma pair dengan listing dated contract).",
      inputSchema: {
        pair: pairSchema,
        contractType: z.enum(CONTRACT_TYPE_ENUM).describe("Tipe kontrak: PERPETUAL, CURRENT_QUARTER, atau NEXT_QUARTER"),
        interval: z.enum(KLINE_INTERVAL_ENUM).describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(1500).default(100).describe("Jumlah candle yang diambil, maksimal 1500"),
        startTime: z.string().optional().describe('Waktu mulai (ISO 8601, contoh "2026-07-01T00:00:00Z") — opsional.'),
        endTime: z.string().optional().describe("Waktu akhir (ISO 8601) — opsional, dipakai bareng startTime."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pair, contractType, interval, limit, startTime, endTime }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        const raw = await binanceProxy.getContinuousKlinesNative(pair, contractType, interval, limit, startMs, endMs);
        if (raw.length === 0) {
          return {
            content: [{ type: "text", text: `Tidak ada data candle untuk ${pair} (${contractType}) @ ${interval}.` }],
          };
        }
        const { candles, lastClose, changePct, bias, swingHigh, swingLow } = summarizeKlines(raw);
        const text = [
          `# Continuous Candlestick — ${pair} ${contractType} @ ${interval} (${candles.length} candle)`,
          ``,
          `**Bias periode ini**: ${bias} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`,
          `**Swing High**: ${fmtPrice(swingHigh)}`,
          `**Swing Low**: ${fmtPrice(swingLow)}`,
          `**Harga penutupan terakhir**: ${fmtPrice(lastClose)}`,
          ``,
          `_Bandingkan dengan kontrak PERPETUAL pair yang sama untuk melihat basis dated-vs-perpetual._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { pair, contractType, interval, bias, changePct, swingHigh, swingLow, lastClose },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  // ─────────────────────────────────────────────────────────────
  // QUARTERLY CONTRACT SETTLEMENT PRICE
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_quarterly_settlement_price",
    {
      title: "Quarterly Contract Settlement Price",
      description:
        "Histori delivery/settlement price untuk kontrak QUARTERLY sebuah pair underlying (harga final saat " +
        "kontrak dated expire dan di-settle). " +
        "PENTING: cuma relevan untuk pair yang punya listing kontrak QUARTERLY/dated (ada tanggal expiry) — TIDAK " +
        "berlaku untuk kontrak PERPETUAL yang memang tidak pernah expire/settle. Parameter pakai `pair` " +
        "(format TANPA suffix margin-asset, contoh \"BTCUSD\").",
      inputSchema: { pair: pairSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pair }) => {
      try {
        const data = await binanceProxy.getQuarterlySettlementPriceNative(pair);
        if (data.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada histori settlement price untuk ${pair} (kemungkinan tidak punya kontrak quarterly).` }] };
        }
        const rows = data.map((d) => `| ${fmtTime(d.deliveryTime)} | ${fmtPrice(d.deliveryPrice)} |`).join("\n");
        const text = [
          `# Quarterly Settlement Price — ${pair}`,
          ``,
          `| Waktu Delivery | Settlement Price |`,
          `|---|---|`,
          rows,
          ``,
          `_Cuma relevan untuk kontrak QUARTERLY (ada expiry), tidak berlaku untuk PERPETUAL. Gunakan ` +
            `binance_get_continuous_klines untuk melihat pergerakan harga kontrak dated sebelum settlement._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { pair, settlements: data },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
