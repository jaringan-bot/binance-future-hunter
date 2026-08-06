import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as binance from "./binanceClient.js";
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

const KLINE_INTERVAL_ENUM = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
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
    err instanceof binance.BinanceApiError
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
        "Mengambil funding rate TERKINI (real-time premium index) dan mark price untuk sebuah pair Binance Futures. " +
        "Funding rate positif besar menandakan long crowded (bias kontrarian: waspada potensi long squeeze). " +
        "Funding rate negatif besar menandakan short crowded (bias kontrarian: waspada potensi short squeeze). " +
        "Gunakan tool ini untuk membaca sentimen leverage pasar saat ini.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binance.getPremiumIndex(symbol);
        const rate = parseFloat(data.lastFundingRate);
        const interpretation =
          rate >= 0.0003
            ? "CROWDED LONG (funding cukup tinggi — mayoritas leverage di sisi long, ada risiko long squeeze jika harga berbalik turun)"
            : rate <= -0.0003
              ? "CROWDED SHORT (funding negatif signifikan — mayoritas leverage di sisi short, ada risiko short squeeze jika harga berbalik naik)"
              : "NETRAL (funding dalam rentang wajar, tidak ada crowding ekstrem yang jelas)";

        const text = [
          `# Funding Rate — ${data.symbol}`,
          ``,
          `- Mark Price: ${fmtNum(data.markPrice, 2)}`,
          `- Index Price: ${fmtNum(data.indexPrice, 2)}`,
          `- Funding Rate Saat Ini: ${fmtPct(data.lastFundingRate, 4)}`,
          `- Interest Rate: ${fmtPct(data.interestRate, 4)}`,
          `- Next Funding Time: ${fmtTime(data.nextFundingTime)}`,
          ``,
          `**Interpretasi**: ${interpretation}`,
          ``,
          `_Catatan: threshold crowded (±0.03%) adalah heuristik umum, sesuaikan dengan konteks volatilitas pair yang sedang ditradingkan._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol: data.symbol,
            markPrice: parseFloat(data.markPrice),
            fundingRate: rate,
            nextFundingTime: data.nextFundingTime,
            interpretation,
          },
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
        "Mengambil histori funding rate settlement (biasanya tiap 8 jam) untuk melihat tren crowding leverage dari waktu ke waktu, " +
        "bukan hanya snapshot sesaat. Berguna untuk melihat apakah sentimen long/short sudah crowded dalam beberapa hari terakhir " +
        "atau baru saja berubah.",
      inputSchema: {
        symbol: symbolSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(30)
          .describe("Jumlah data poin histori yang diambil (default 30, tiap poin ~8 jam)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit }) => {
      try {
        const data = await binance.getFundingRateHistory(symbol, limit);
        if (data.length === 0) {
          return {
            content: [
              { type: "text", text: `Tidak ada data histori funding rate untuk ${symbol}.` },
            ],
          };
        }
        const rows = data
          .map(
            (d) =>
              `| ${fmtTime(d.fundingTime)} | ${fmtPct(d.fundingRate, 4)} | ${fmtNum(d.markPrice, 2)} |`,
          )
          .join("\n");

        const rates = data.map((d) => parseFloat(d.fundingRate));
        const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
        const direction = trendDirection(rates);

        const text = [
          `# Histori Funding Rate — ${symbol} (${data.length} data terakhir)`,
          ``,
          `| Waktu | Funding Rate | Mark Price |`,
          `|---|---|---|`,
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
        "Mengambil Open Interest (total kontrak terbuka) TERKINI untuk sebuah pair. " +
        "OI naik + harga naik = tren didukung entry baru (sehat). " +
        "OI turun + harga naik = short covering / posisi ditutup, bukan entry baru (kurang solid). " +
        "OI turun tajam = kemungkinan capitulation/liquidation massal.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binance.getOpenInterest(symbol);
        const text = [
          `# Open Interest — ${data.symbol}`,
          ``,
          `- Open Interest: ${fmtNum(data.openInterest, 2)} kontrak`,
          `- Waktu: ${fmtTime(data.time)}`,
          ``,
          `_Gunakan bersama \`binance_get_open_interest_history\` untuk melihat tren naik/turun, dan bandingkan dengan pergerakan harga untuk interpretasi yang benar (OI saja tanpa konteks harga bisa menyesatkan)._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol: data.symbol,
            openInterest: parseFloat(data.openInterest),
            time: data.time,
          },
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
        "Mengambil histori Open Interest untuk melihat TREN naik/turun sepanjang waktu (bukan cuma snapshot). " +
        "Ini yang dibutuhkan untuk menjawab 'apakah OI sedang naik atau turun hari ini'. " +
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
        const data = await binance.getOpenInterestHistory(symbol, period, limit);
        if (data.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Tidak ada data histori OI untuk ${symbol} pada period ${period}. Pastikan symbol adalah pair USDT-margined yang valid (data histori OI hanya tersedia untuk 30 hari terakhir).`,
              },
            ],
          };
        }
        const values = data.map((d) => parseFloat(d.sumOpenInterest));
        const direction = trendDirection(values);
        const first = values[0];
        const last = values[values.length - 1];
        const changePct = first !== 0 ? ((last - first) / first) * 100 : 0;

        const rows = data
          .map(
            (d) =>
              `| ${fmtTime(d.timestamp)} | ${fmtNum(d.sumOpenInterest, 2)} | $${fmtNum(d.sumOpenInterestValue, 0)} |`,
          )
          .join("\n");

        const text = [
          `# Tren Open Interest — ${symbol} (period: ${period}, ${data.length} data poin)`,
          ``,
          `**Tren keseluruhan window**: OI ${direction} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% dari awal ke akhir window)`,
          ``,
          `| Waktu | Open Interest | Nilai (USD) |`,
          `|---|---|---|`,
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
  // LONG/SHORT RATIO (retail vs top trader)
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_long_short_ratio",
    {
      title: "Long/Short Ratio — Retail vs Top Trader",
      description:
        "Tool INTI untuk strategi 'ikuti whale, oposisi retail'. Mengambil dan membandingkan tiga rasio sekaligus: " +
        "(1) Global Account Ratio = proxy SELURUH akun retail (dihitung per akun, bukan per size). " +
        "(2) Top Trader Account Ratio = rasio akun dengan size terbesar (dihitung per akun). " +
        "(3) Top Trader Position Ratio = rasio berdasarkan SIZE POSISI top trader (lebih akurat menunjukkan arah 'uang besar' dibanding rasio akun). " +
        "PENTING: jika Global Ratio dan Top Trader Position Ratio berlawanan arah, itu sinyal divergence retail-vs-whale yang jadi dasar strategi kontrarian kamu. " +
        "Jika keduanya searah, TIDAK ada divergence yang bisa dieksploitasi — jangan paksakan sinyal.",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(PERIOD_ENUM)
          .default("15m")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(10).describe("Jumlah data poin terakhir yang dibandingkan"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const [globalData, topAccountData, topPositionData] = await Promise.all([
          binance.getGlobalLongShortRatio(symbol, period, limit),
          binance.getTopTraderAccountRatio(symbol, period, limit),
          binance.getTopTraderPositionRatio(symbol, period, limit),
        ]);

        if (globalData.length === 0 || topPositionData.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Data long/short ratio tidak tersedia untuk ${symbol}. Pastikan symbol adalah pair perpetual USDT-margined yang aktif.`,
              },
            ],
          };
        }

        const latestGlobal = globalData[globalData.length - 1];
        const latestTopAccount = topAccountData[topAccountData.length - 1];
        const latestTopPosition = topPositionData[topPositionData.length - 1];

        const globalLongPct = parseFloat(latestGlobal.longAccount) * 100;
        const topPosLongPct = parseFloat(latestTopPosition.longAccount) * 100;

        const globalBias = globalLongPct > 55 ? "LONG" : globalLongPct < 45 ? "SHORT" : "NETRAL";
        const topBias = topPosLongPct > 55 ? "LONG" : topPosLongPct < 45 ? "SHORT" : "NETRAL";

        let divergenceNote: string;
        if (globalBias !== "NETRAL" && topBias !== "NETRAL" && globalBias !== topBias) {
          divergenceNote =
            `🔴 **DIVERGENCE TERDETEKSI**: Retail (global) condong ${globalBias}, sementara Top Trader (whale, by position size) condong ${topBias}. ` +
            `Ini sinyal klasik untuk strategi kontrarian — pertimbangkan arah ${topBias} (mengikuti whale, berlawanan retail).`;
        } else if (globalBias === topBias && globalBias !== "NETRAL") {
          divergenceNote =
            `⚪ Tidak ada divergence — retail dan top trader sama-sama condong ${globalBias}. ` +
            `Tidak ada sinyal kontrarian yang jelas dari data ini saja; strategi 'oposisi retail' tidak applicable saat ini.`;
        } else {
          divergenceNote = `⚪ Salah satu atau kedua rasio berada di zona netral (45-55%). Sinyal belum cukup kuat untuk ditindaklanjuti.`;
        }

        const rows = globalData
          .map((g, i) => {
            const ta = topAccountData[i];
            const tp = topPositionData[i];
            return `| ${fmtTime(g.timestamp)} | ${fmtNum(g.longAccount, 4)} | ${ta ? fmtNum(ta.longAccount, 4) : "N/A"} | ${tp ? fmtNum(tp.longAccount, 4) : "N/A"} |`;
          })
          .join("\n");

        const text = [
          `# Long/Short Ratio — ${symbol} (period: ${period})`,
          ``,
          `## Snapshot Terkini`,
          `- **Global Account (retail proxy)**: ${globalLongPct.toFixed(1)}% long / ${(100 - globalLongPct).toFixed(1)}% short → bias ${globalBias}`,
          `- **Top Trader Account**: ${(parseFloat(latestTopAccount.longAccount) * 100).toFixed(1)}% long`,
          `- **Top Trader Position (by size, paling representatif untuk whale)**: ${topPosLongPct.toFixed(1)}% long / ${(100 - topPosLongPct).toFixed(1)}% short → bias ${topBias}`,
          ``,
          divergenceNote,
          ``,
          `## Histori (kolom: waktu | global long% | top-account long% | top-position long%)`,
          `| Waktu | Global | Top Acc | Top Pos |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_Catatan metodologi: "Global Account Ratio" menghitung per akun (1 akun kecil = 1 akun besar secara bobot), sedangkan "Top Trader Position Ratio" menghitung berdasarkan size — ini alasan kenapa Top Trader Position dipakai sebagai proxy whale yang lebih andal dibanding Top Trader Account._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            globalLongPct,
            topPositionLongPct: topPosLongPct,
            globalBias,
            topBias,
            hasDivergence: globalBias !== "NETRAL" && topBias !== "NETRAL" && globalBias !== topBias,
          },
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
        "yang berbasis posisi terbuka. Berguna sebagai konfirmasi tambahan: apakah tekanan eksekusi market saat ini condong beli atau jual.",
      inputSchema: {
        symbol: symbolSchema,
        period: z.enum(PERIOD_ENUM).default("15m"),
        limit: z.number().int().min(1).max(500).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const data = await binance.getTakerBuySellVolume(symbol, period, limit);
        if (data.length === 0) {
          return {
            content: [{ type: "text", text: `Tidak ada data taker volume untuk ${symbol}.` }],
          };
        }
        const latest = data[data.length - 1];
        const ratio = parseFloat(latest.buySellRatio);
        const bias = ratio > 1.05 ? "BUY dominan" : ratio < 0.95 ? "SELL dominan" : "seimbang";

        const rows = data
          .map((d) => `| ${fmtTime(Number(d.timestamp))} | ${fmtNum(d.buySellRatio, 4)} |`)
          .join("\n");

        const text = [
          `# Taker Buy/Sell Ratio — ${symbol} (period: ${period})`,
          ``,
          `**Rasio terkini**: ${fmtNum(latest.buySellRatio, 4)} → tekanan ${bias}`,
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
        "Mengambil data candlestick OHLCV untuk sebuah pair pada timeframe tertentu (1m, 5m, 15m, 1h, 4h, 1d, dll). " +
        "Gunakan ini untuk menentukan bias arah (bullish/bearish/sideways) di berbagai timeframe, mencari swing high/low, " +
        "dan level psikologis untuk estimasi zona SL/TP.",
      inputSchema: {
        symbol: symbolSchema,
        interval: z
          .enum(KLINE_INTERVAL_ENUM)
          .describe("Timeframe candle: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(100).describe("Jumlah candle yang diambil"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit }) => {
      try {
        const raw = await binance.getKlines(symbol, interval, limit);
        if (raw.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data candle untuk ${symbol} @ ${interval}.` }] };
        }

        const candles = raw.map((k) => ({
          openTime: k[0] as number,
          open: parseFloat(k[1] as string),
          high: parseFloat(k[2] as string),
          low: parseFloat(k[3] as string),
          close: parseFloat(k[4] as string),
          volume: parseFloat(k[5] as string),
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

        // Tampilkan hanya 15 candle terakhir di tabel supaya ringkas; sisanya sudah terwakili di ringkasan.
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
            const raw = await binance.getKlines(symbol, tf.interval, tf.limit);
            if (raw.length === 0) return { ...tf, bias: "N/A", changePct: 0, lastClose: 0 };
            const closes = raw.map((k) => parseFloat(k[4] as string));
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
        "Mengambil ringkasan statistik 24 jam: harga terakhir, perubahan %, high/low 24 jam, volume. " +
        "Cocok sebagai overview cepat sebelum masuk ke analisis lebih dalam.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binance.getTicker24hr(symbol);
        const text = [
          `# Statistik 24 Jam — ${data.symbol}`,
          ``,
          `- Harga Terakhir: ${fmtNum(data.lastPrice, 2)}`,
          `- Perubahan 24 Jam: ${data.priceChangePercent}% (${fmtNum(data.priceChange, 2)})`,
          `- High 24 Jam: ${fmtNum(data.highPrice, 2)}`,
          `- Low 24 Jam: ${fmtNum(data.lowPrice, 2)}`,
          `- Volume: ${fmtNum(data.volume, 2)} (Quote: $${fmtNum(data.quoteVolume, 0)})`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
