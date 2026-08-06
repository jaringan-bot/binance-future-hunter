import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as coinalyze from "./coinalyzeClient.js";
import { fmtNum, fmtPct, fmtTime, trendDirection } from "./format.js";

const PERIOD_ENUM = [
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "1d",
] as const;

// Coinalyze tidak punya interval "3m" atau "8h" — di-drop dari enum ini.
const KLINE_INTERVAL_ENUM = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "1d",
] as const;

const symbolSchema = z
  .string()
  .toUpperCase()
  .describe(
    "Simbol pair Binance Futures, contoh: BTCUSDT, ETHUSDT. Harus pair perpetual yang terdaftar di Binance USDS-M Futures.",
  );

function errorResult(err: unknown) {
  const message =
    err instanceof coinalyze.CoinalyzeApiError
      ? err.message
      : `Terjadi error tak terduga: ${(err as Error)?.message ?? String(err)}`;
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "binance-futures-mcp",
    version: "1.0.0",
  });

  // ─────────────────────────────────────────────────────────────
  // FUNDING RATE
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_funding_rate",
    {
      title: "Ambil Funding Rate Terkini",
      description:
        "Mengambil funding rate TERKINI untuk sebuah pair Binance Futures (data via Coinalyze, sumber asli Binance). " +
        "Funding rate positif besar menandakan long crowded (bias kontrarian: waspada potensi long squeeze). " +
        "Funding rate negatif besar menandakan short crowded (bias kontrarian: waspada potensi short squeeze). " +
        "Gunakan tool ini untuk membaca sentimen leverage pasar saat ini.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await coinalyze.getCurrentFundingRate(symbol);
        const rate = data.value;
        const interpretation =
          rate >= 0.0003
            ? "CROWDED LONG (funding cukup tinggi — mayoritas leverage di sisi long, ada risiko long squeeze jika harga berbalik turun)"
            : rate <= -0.0003
              ? "CROWDED SHORT (funding negatif signifikan — mayoritas leverage di sisi short, ada risiko short squeeze jika harga berbalik naik)"
              : "NETRAL (funding dalam rentang wajar, tidak ada crowding ekstrem yang jelas)";

        const text = [
          `# Funding Rate — ${symbol}`,
          ``,
          `- Funding Rate Saat Ini: ${fmtPct(rate, 4)}`,
          `- Update Terakhir: ${fmtTime(data.update)}`,
          ``,
          `**Interpretasi**: ${interpretation}`,
          ``,
          `_Catatan: threshold crowded (±0.03%) adalah heuristik umum, sesuaikan dengan konteks volatilitas pair yang sedang ditradingkan. Data via Coinalyze (agregasi ulang data Binance)._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, fundingRate: rate, interpretation },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "binance_get_funding_rate_history",
    {
      title: "Histori Funding Rate",
      description:
        "Mengambil histori funding rate untuk melihat tren crowding leverage dari waktu ke waktu, bukan hanya snapshot sesaat " +
        "(data via Coinalyze, sumber asli Binance). Berguna untuk melihat apakah sentimen long/short sudah crowded dalam " +
        "beberapa hari terakhir atau baru saja berubah.",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(PERIOD_ENUM)
          .default("1h")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(30)
          .describe("Jumlah data poin histori yang diambil (default 30)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const bars = await coinalyze.getFundingRateHistory(symbol, period, limit);
        if (bars.length === 0) {
          return {
            content: [
              { type: "text", text: `Tidak ada data histori funding rate untuk ${symbol}.` },
            ],
          };
        }
        const rows = bars
          .map((b) => `| ${fmtTime(b.t * 1000)} | ${fmtPct(b.c, 4)} |`)
          .join("\n");

        const rates = bars.map((b) => b.c);
        const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
        const direction = trendDirection(rates);

        const text = [
          `# Histori Funding Rate — ${symbol} (${bars.length} data terakhir)`,
          ``,
          `| Waktu | Funding Rate |`,
          `|---|---|`,
          rows,
          ``,
          `**Rata-rata funding**: ${fmtPct(avg, 4)}`,
          `**Tren**: ${direction} (dibandingkan data paling lama vs paling baru dalam window ini)`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // OPEN INTEREST
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_open_interest",
    {
      title: "Open Interest Saat Ini",
      description:
        "Mengambil Open Interest (total kontrak terbuka) TERKINI untuk sebuah pair (data via Coinalyze, sumber asli Binance). " +
        "OI naik + harga naik = tren didukung entry baru (sehat). " +
        "OI turun + harga naik = short covering / posisi ditutup, bukan entry baru (kurang solid). " +
        "OI turun tajam = kemungkinan capitulation/liquidation massal.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await coinalyze.getCurrentOpenInterest(symbol);
        const text = [
          `# Open Interest — ${symbol}`,
          ``,
          `- Open Interest: ${fmtNum(data.value, 2)} kontrak`,
          `- Waktu: ${fmtTime(data.update)}`,
          ``,
          `_Gunakan bersama \`binance_get_open_interest_history\` untuk melihat tren naik/turun, dan bandingkan dengan pergerakan harga untuk interpretasi yang benar (OI saja tanpa konteks harga bisa menyesatkan)._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, openInterest: data.value, time: data.update },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "binance_get_open_interest_history",
    {
      title: "Histori Tren Open Interest",
      description:
        "Mengambil histori Open Interest untuk melihat TREN naik/turun sepanjang waktu (bukan cuma snapshot), data via Coinalyze " +
        "(sumber asli Binance). Ini yang dibutuhkan untuk menjawab 'apakah OI sedang naik atau turun hari ini'. " +
        "Kombinasikan dengan data candlestick harga (binance_get_klines) pada periode yang sama untuk interpretasi yang valid: " +
        "OI naik + harga naik = trend genuinely didukung entry baru; OI turun + harga naik = short covering (rally rapuh).",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(PERIOD_ENUM)
          .default("15m")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(30).describe("Jumlah data poin"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const bars = await coinalyze.getOpenInterestHistory(symbol, period, limit);
        if (bars.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Tidak ada data histori OI untuk ${symbol} pada period ${period}. Pastikan symbol adalah pair USDT-margined yang valid.`,
              },
            ],
          };
        }
        const values = bars.map((b) => b.c);
        const direction = trendDirection(values);
        const first = values[0];
        const last = values[values.length - 1];
        const changePct = first !== 0 ? ((last - first) / first) * 100 : 0;

        const rows = bars
          .map((b) => `| ${fmtTime(b.t * 1000)} | ${fmtNum(b.c, 2)} |`)
          .join("\n");

        const text = [
          `# Tren Open Interest — ${symbol} (period: ${period}, ${bars.length} data poin)`,
          ``,
          `**Tren keseluruhan window**: OI ${direction} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% dari awal ke akhir window)`,
          ``,
          `| Waktu | Open Interest |`,
          `|---|---|`,
          rows,
          ``,
          `_Langkah selanjutnya yang disarankan: panggil \`binance_get_klines\` pair & timeframe yang sama untuk cek apakah OI ${direction} ini terjadi bersamaan dengan harga naik atau turun — kombinasi keduanya yang menentukan interpretasi (entry baru vs covering vs capitulation)._`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // LONG/SHORT RATIO
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_long_short_ratio",
    {
      title: "Long/Short Ratio",
      description:
        "Mengambil rasio posisi long vs short agregat (semua trader) untuk sebuah pair Binance Futures, beserta tren dari waktu " +
        "ke waktu (data via Coinalyze, sumber asli Binance). Ratio > 1 berarti lebih banyak/besar posisi long dibanding short. " +
        "KETERBATASAN: ini rasio agregat BLENDED, BUKAN breakdown terpisah retail-vs-top-trader seperti data resmi Binance " +
        "(breakdown itu cuma tersedia dari provider berbayar seperti CoinGlass/CoinAnk, tidak ada versi gratis).",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(PERIOD_ENUM)
          .default("15m")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(10).describe("Jumlah data poin terakhir"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const bars = await coinalyze.getLongShortRatioHistory(symbol, period, limit);
        if (bars.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Data long/short ratio tidak tersedia untuk ${symbol}. Pastikan symbol adalah pair perpetual USDT-margined yang aktif.`,
              },
            ],
          };
        }

        const latest = bars[bars.length - 1];
        const bias = latest.l > 55 ? "LONG" : latest.l < 45 ? "SHORT" : "NETRAL";
        const direction = trendDirection(bars.map((b) => b.r));

        const rows = bars
          .map(
            (b) =>
              `| ${fmtTime(b.t * 1000)} | ${b.l.toFixed(2)}% | ${b.s.toFixed(2)}% | ${fmtNum(b.r, 4)} |`,
          )
          .join("\n");

        const text = [
          `# Long/Short Ratio — ${symbol} (period: ${period})`,
          ``,
          `## Snapshot Terkini`,
          `- **Long**: ${latest.l.toFixed(1)}% / **Short**: ${latest.s.toFixed(1)}% → ratio ${fmtNum(latest.r, 4)} → bias ${bias}`,
          `**Tren**: ${direction}`,
          ``,
          `## Histori`,
          `| Waktu | Long % | Short % | Ratio |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_Ini rasio agregat semua trader (blended), bukan breakdown top-trader/whale terpisah dari retail — lihat deskripsi tool untuk keterbatasan ini._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, longPct: latest.l, shortPct: latest.s, ratio: latest.r, bias },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "binance_get_taker_volume_ratio",
    {
      title: "Taker Buy/Sell Volume Ratio",
      description:
        "Mengambil rasio volume taker buy vs sell — proxy tekanan beli/jual AGRESIF (market order), berbeda dari long/short ratio " +
        "yang berbasis posisi terbuka (data via Coinalyze, diturunkan dari volume candlestick). Berguna sebagai konfirmasi tambahan: " +
        "apakah tekanan eksekusi market saat ini condong beli atau jual.",
      inputSchema: {
        symbol: symbolSchema,
        period: z.enum(PERIOD_ENUM).default("15m"),
        limit: z.number().int().min(1).max(500).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const bars = await coinalyze.getOhlcvHistory(symbol, period, limit);
        if (bars.length === 0) {
          return {
            content: [{ type: "text", text: `Tidak ada data taker volume untuk ${symbol}.` }],
          };
        }
        const ratioOf = (b: coinalyze.OhlcvBar) => {
          const sellVol = b.v - b.bv;
          return sellVol > 0 ? b.bv / sellVol : b.bv > 0 ? Infinity : 1;
        };
        const latest = bars[bars.length - 1];
        const ratio = ratioOf(latest);
        const bias = ratio > 1.05 ? "BUY dominan" : ratio < 0.95 ? "SELL dominan" : "seimbang";

        const rows = bars
          .map((b) => `| ${fmtTime(b.t * 1000)} | ${fmtNum(ratioOf(b), 4)} |`)
          .join("\n");

        const text = [
          `# Taker Buy/Sell Ratio — ${symbol} (period: ${period})`,
          ``,
          `**Rasio terkini**: ${fmtNum(ratio, 4)} → tekanan ${bias}`,
          `(ratio > 1 = volume buy lebih besar dari sell, < 1 = sebaliknya)`,
          ``,
          `| Waktu | Buy/Sell Ratio |`,
          `|---|---|`,
          rows,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // KLINES / PRICE ACTION untuk bias per-timeframe
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_klines",
    {
      title: "Data Candlestick (Klines)",
      description:
        "Mengambil data candlestick OHLCV untuk sebuah pair pada timeframe tertentu (data via Coinalyze, sumber asli Binance). " +
        "Gunakan ini untuk menentukan bias arah (bullish/bearish/sideways) di berbagai timeframe, mencari swing high/low, " +
        "dan level psikologis untuk estimasi zona SL/TP.",
      inputSchema: {
        symbol: symbolSchema,
        interval: z
          .enum(KLINE_INTERVAL_ENUM)
          .describe("Timeframe candle: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(100).describe("Jumlah candle yang diambil"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit }) => {
      try {
        const bars = await coinalyze.getOhlcvHistory(symbol, interval, limit);
        if (bars.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data candle untuk ${symbol} @ ${interval}.` }] };
        }

        const candles = bars.map((b) => ({
          openTime: b.t * 1000,
          open: b.o,
          high: b.h,
          low: b.l,
          close: b.c,
          volume: b.v,
        }));

        const closes = candles.map((c) => c.close);
        const highs = candles.map((c) => c.high);
        const lows = candles.map((c) => c.low);
        const firstClose = closes[0];
        const lastClose = closes[closes.length - 1];
        const changePct = ((lastClose - firstClose) / firstClose) * 100;
        const swingHigh = Math.max(...highs);
        const swingLow = Math.min(...lows);

        const bias =
          changePct > 1
            ? "BULLISH"
            : changePct < -1
              ? "BEARISH"
              : "SIDEWAYS";

        const recent = candles.slice(-15);
        const rows = recent
          .map(
            (c) =>
              `| ${fmtTime(c.openTime)} | ${fmtNum(c.open, 2)} | ${fmtNum(c.high, 2)} | ${fmtNum(c.low, 2)} | ${fmtNum(c.close, 2)} | ${fmtNum(c.volume, 2)} |`,
          )
          .join("\n");

        const text = [
          `# Candlestick — ${symbol} @ ${interval} (${candles.length} candle)`,
          ``,
          `**Bias periode ini**: ${bias} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% dari candle pertama ke terakhir)`,
          `**Swing High**: ${fmtNum(swingHigh, 2)}`,
          `**Swing Low**: ${fmtNum(swingLow, 2)}`,
          `**Harga penutupan terakhir**: ${fmtNum(lastClose, 2)}`,
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
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "binance_get_multi_timeframe_bias",
    {
      title: "Bias Multi-Timeframe Sekaligus",
      description:
        "Tool ringkas untuk langsung mendapatkan bias arah (Bullish/Bearish/Sideways) di 5 timeframe umum " +
        "(1m, 5m, 15m, 1h, 1d) dalam satu panggilan, tanpa perlu memanggil binance_get_klines berulang kali. " +
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
            const bars = await coinalyze.getOhlcvHistory(symbol, tf.interval, tf.limit);
            if (bars.length === 0) return { ...tf, bias: "N/A", changePct: 0, lastClose: 0 };
            const closes = bars.map((b) => b.c);
            const changePct = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
            const bias = changePct > 1 ? "BULLISH" : changePct < -1 ? "BEARISH" : "SIDEWAYS";
            return { ...tf, bias, changePct, lastClose: closes[closes.length - 1] };
          }),
        );

        const rows = results
          .map(
            (r) =>
              `| ${r.label} (${r.interval}) | ${r.bias} | ${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}% | ${fmtNum(r.lastClose, 2)} |`,
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

  server.registerTool(
    "binance_get_24hr_ticker",
    {
      title: "Statistik 24 Jam",
      description:
        "Mengambil ringkasan statistik 24 jam: harga terakhir, perubahan %, high/low 24 jam, volume (diturunkan dari 24 candle " +
        "1 jam via Coinalyze — pendekatan, bukan angka resmi ticker Binance). Cocok sebagai overview cepat sebelum masuk ke " +
        "analisis lebih dalam.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const bars = await coinalyze.getOhlcvHistory(symbol, "1h", 24);
        if (bars.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data untuk ${symbol}.` }] };
        }
        const openPrice = bars[0].o;
        const lastPrice = bars[bars.length - 1].c;
        const highPrice = Math.max(...bars.map((b) => b.h));
        const lowPrice = Math.min(...bars.map((b) => b.l));
        const volume = bars.reduce((sum, b) => sum + b.v, 0);
        const priceChange = lastPrice - openPrice;
        const priceChangePercent = (priceChange / openPrice) * 100;

        const text = [
          `# Statistik 24 Jam — ${symbol}`,
          ``,
          `- Harga Terakhir: ${fmtNum(lastPrice, 2)}`,
          `- Perubahan 24 Jam: ${priceChangePercent >= 0 ? "+" : ""}${priceChangePercent.toFixed(2)}% (${fmtNum(priceChange, 2)})`,
          `- High 24 Jam: ${fmtNum(highPrice, 2)}`,
          `- Low 24 Jam: ${fmtNum(lowPrice, 2)}`,
          `- Volume (24 candle 1h): ${fmtNum(volume, 2)}`,
          ``,
          `_Angka ini pendekatan dari 24 candle 1 jam terakhir (via Coinalyze), bukan hasil kalkulasi rolling-window resmi Binance._`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
