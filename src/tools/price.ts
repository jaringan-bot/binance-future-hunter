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
  detailParam,
} from "../shared.js";
import { summarizeKlines, classifyPriceBias, truncateRows } from "../toolHelpers.js";

const RECENT_CANDLES = 5;

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
        "Candlestick OHLCV native Binance (source of truth, bukan Coinalyze). Balikin bias arah, swing high/low, " +
        "harga terakhir. Isi startTime untuk histori jauh ke belakang (maks `limit` candle/panggilan, maks 1500). " +
        "Default (`detail: summary`) cuma balikin ringkasan + 5 candle terakhir -- set `detail: \"full\"` atau " +
        "`includeCandles: true` untuk array candle penuh.",
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
            "DEPRECATED, dipertahankan untuk kompatibilitas -- pakai `detail: \"full\"` sebagai gantinya. true = sama seperti detail:\"full\".",
          ),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit, startTime, endTime, includeCandles, detail }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        const raw = await binanceProxy.getKlinesNative(symbol, interval, limit, startMs, endMs);
        if (raw.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data candle untuk ${symbol} @ ${interval}.` }] };
        }

        const isFull = detail === "full" || includeCandles;
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
            ...(isFull ? { candles } : { recent: candles.slice(-RECENT_CANDLES) }),
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
        "Bias arah (Bullish/Bearish/Sideways) di 5 timeframe (1m, 5m, 15m, 1h, 1d) sekaligus, LANGSUNG dari Binance " +
        "native -- ganti beberapa panggilan binance_get_klines manual. Cocok untuk 'apa bias BTCUSDT di semua timeframe'.",
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
        else alignment = "Timeframe TIDAK selaras (mixed) — kemungkinan konsolidasi/transisi.";

        const text = [
          `# Bias Multi-Timeframe — ${symbol}`,
          ``,
          `| Timeframe | Bias | Perubahan | Harga Terakhir |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `**Kesimpulan**: ${alignment}`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, results, alignment },
        };
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
        "Realized volatility (RV) dari log-return close-to-close, dua timeframe (15m/~24 jam, 1h/~30 jam), " +
        "LANGSUNG dari Binance native klines. Dikembalikan annualized (%) + per-periode (%) supaya tidak menyesatkan " +
        "untuk pair kecil volatil. Berguna cross-check kalibrasi lebar grid (i_atrMult Grid Advisor).",
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
          `_RV annualized tinggi = range candle melebar dibanding biasanya; pakai angka per-periode untuk intuisi ` +
            `pergerakan riil per candle. Dihitung dari log-return close-to-close, bukan true range._`,
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
        "Ringkasan statistik 24 jam: harga terakhir, perubahan %, high/low, volume — LANGSUNG dari Binance native " +
        "ticker/24hr (rolling window resmi). Overview cepat sebelum analisis lebih dalam.",
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
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, lastPrice, priceChangePercent, priceChange, highPrice, lowPrice, volume },
        };
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
        "Candlestick dari MARK PRICE (acuan liquidation/funding), BUKAN harga transaksi -- volume/trade count selalu " +
        "0 (harga sintetis). Pakai binance_get_klines untuk TA harga pasar biasa. Default ringkas, `detail: \"full\"` " +
        "untuk array candle penuh.",
      inputSchema: {
        symbol: symbolSchema,
        interval: z.enum(KLINE_INTERVAL_ENUM).describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(1500).default(100).describe("Jumlah candle yang diambil, maksimal 1500"),
        startTime: z.string().optional().describe('Waktu mulai (ISO 8601, contoh "2026-07-01T00:00:00Z") — opsional.'),
        endTime: z.string().optional().describe("Waktu akhir (ISO 8601) — opsional, dipakai bareng startTime."),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit, startTime, endTime, detail }) => {
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
          `_Candle MARK PRICE (acuan liquidation/funding), bukan harga transaksi._`,
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
            ...(detail === "full" ? { candles } : { recent: candles.slice(-RECENT_CANDLES) }),
          },
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
        "Candlestick dari INDEX PRICE (blended beberapa exchange spot, dasar premium index/funding), BUKAN harga " +
        "transaksi Futures. PENTING: pakai `pair` TANPA suffix margin-asset (contoh \"BTCUSD\"), bukan `symbol` biasa.",
      inputSchema: {
        pair: pairSchema,
        interval: z.enum(KLINE_INTERVAL_ENUM).describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(1500).default(100).describe("Jumlah candle yang diambil, maksimal 1500"),
        startTime: z.string().optional().describe('Waktu mulai (ISO 8601, contoh "2026-07-01T00:00:00Z") — opsional.'),
        endTime: z.string().optional().describe("Waktu akhir (ISO 8601) — opsional, dipakai bareng startTime."),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pair, interval, limit, startTime, endTime, detail }) => {
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
          `_Candle INDEX PRICE (blended dari beberapa exchange spot), dasar perhitungan premium index/funding rate._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            pair,
            interval,
            bias,
            changePct,
            swingHigh,
            swingLow,
            lastClose,
            ...(detail === "full" ? { candles } : { recent: candles.slice(-RECENT_CANDLES) }),
          },
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
        "Candlestick dari PREMIUM INDEX (selisih mark vs index price, komponen utama funding rate). Nilai adalah " +
        "RASIO premium (bukan harga absolut) -- jangan dibaca seperti candle harga biasa. Premium positif konsisten " +
        "= funding cenderung positif.",
      inputSchema: {
        symbol: symbolSchema,
        interval: z.enum(KLINE_INTERVAL_ENUM).describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(1500).default(100).describe("Jumlah candle yang diambil, maksimal 1500"),
        startTime: z.string().optional().describe('Waktu mulai (ISO 8601, contoh "2026-07-01T00:00:00Z") — opsional.'),
        endTime: z.string().optional().describe("Waktu akhir (ISO 8601) — opsional, dipakai bareng startTime."),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit, startTime, endTime, detail }) => {
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
          `_RASIO premium (mark vs index price), bukan harga absolut. Kombinasikan dengan binance_get_funding_rate._`,
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
            ...(detail === "full" ? { candles } : { recent: candles.slice(-RECENT_CANDLES) }),
          },
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
        "Candlestick untuk kontrak PERPETUAL/CURRENT_QUARTER/NEXT_QUARTER dari pair underlying -- bandingkan harga " +
        "dated vs perpetual. PENTING: pakai `pair` (TANPA suffix margin-asset, contoh \"BTCUSD\") + `contractType`, " +
        "bukan `symbol` biasa. Kontrak dated tidak selalu tersedia untuk semua pair.",
      inputSchema: {
        pair: pairSchema,
        contractType: z.enum(CONTRACT_TYPE_ENUM).describe("Tipe kontrak: PERPETUAL, CURRENT_QUARTER, atau NEXT_QUARTER"),
        interval: z.enum(KLINE_INTERVAL_ENUM).describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(1500).default(100).describe("Jumlah candle yang diambil, maksimal 1500"),
        startTime: z.string().optional().describe('Waktu mulai (ISO 8601, contoh "2026-07-01T00:00:00Z") — opsional.'),
        endTime: z.string().optional().describe("Waktu akhir (ISO 8601) — opsional, dipakai bareng startTime."),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pair, contractType, interval, limit, startTime, endTime, detail }) => {
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
          structuredContent: {
            pair,
            contractType,
            interval,
            bias,
            changePct,
            swingHigh,
            swingLow,
            lastClose,
            ...(detail === "full" ? { candles } : { recent: candles.slice(-RECENT_CANDLES) }),
          },
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
        "Histori delivery/settlement price kontrak QUARTERLY (harga final saat kontrak dated expire). Cuma relevan " +
        "untuk pair dengan listing quarterly/dated -- TIDAK berlaku untuk PERPETUAL. Pakai `pair` TANPA suffix margin-asset.",
      inputSchema: { pair: pairSchema, detail: detailParam },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pair, detail }) => {
      try {
        const data = await binanceProxy.getQuarterlySettlementPriceNative(pair);
        if (data.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada histori settlement price untuk ${pair} (kemungkinan tidak punya kontrak quarterly).` }] };
        }
        const { shown, totalCount, truncated } = truncateRows(data, 10);
        const rows = shown.map((d) => `| ${fmtTime(d.deliveryTime)} | ${fmtPrice(d.deliveryPrice)} |`).join("\n");
        const text = [
          `# Quarterly Settlement Price — ${pair}`,
          ``,
          truncated ? `_Menampilkan ${shown.length} terakhir dari ${totalCount} total (\`detail: "full"\` untuk semua)._` : ``,
          `| Waktu Delivery | Settlement Price |`,
          `|---|---|`,
          rows,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            pair,
            totalCount,
            ...(detail === "full" ? { settlements: data } : { recent: shown }),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
