import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as coinalyze from "./coinalyzeClient.js";
import * as binanceProxy from "./binanceProxyClient.js";
import { fmtNum, fmtPrice, fmtPct, fmtTime, trendDirection } from "./format.js";

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

// Coinalyze tidak punya interval "3m" atau "8h" — dua itu di-drop dari enum ini.
// (Binance native klines/fundingRate mendukung superset ini juga, jadi tetap
// aman dipakai untuk kedua sumber.)
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

// Semua endpoint /futures/data/* Binance (topLongShortAccountRatio,
// topLongShortPositionRatio, globalLongShortAccountRatio, openInterestHist,
// takerlongshortRatio) cuma support subset period ini (beda dari Coinalyze
// yang lebih fleksibel untuk endpoint yang masih dia sumberi).
const FUTURES_DATA_PERIOD_ENUM = [
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
      : err instanceof binanceProxy.BinanceProxyError
        ? err.message
        : `Terjadi error tak terduga: ${(err as Error)?.message ?? String(err)}`;
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

// RV = sqrt(mean(log_return^2)) * sqrt(periode/tahun) — realized volatility
// standar dari log-return close-to-close.
function computeRealizedVolatility(
  closes: number[],
  periodsPerYear: number,
): { periodPct: number; annualizedPct: number } {
  if (closes.length < 2) return { periodPct: 0, annualizedPct: 0 };
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const sumSq = logReturns.reduce((acc, r) => acc + r * r, 0);
  const periodVol = Math.sqrt(sumSq / logReturns.length);
  const annualizedVol = periodVol * Math.sqrt(periodsPerYear);
  return { periodPct: periodVol * 100, annualizedPct: annualizedVol * 100 };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "whalescope-mcp",
    version: "1.0.0",
  });

  // ─────────────────────────────────────────────────────────────
  // FUNDING RATE (Binance native via premiumIndex — funding TERKINI,
  // belum settled, plus mark price & waktu funding berikutnya)
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_funding_rate",
    {
      title: "Ambil Funding Rate Terkini",
      description:
        "Mengambil funding rate TERKINI untuk sebuah pair Binance Futures (LANGSUNG dari Binance native premiumIndex, " +
        "bukan lewat Coinalyze — source of truth), plus basis (deviasi mark price dari index price) untuk membaca " +
        "sentimen premium/discount futures vs spot. " +
        "Funding rate positif besar menandakan long crowded (bias kontrarian: waspada potensi long squeeze). " +
        "Funding rate negatif besar menandakan short crowded (bias kontrarian: waspada potensi short squeeze). " +
        "Basis positif besar menandakan futures premium tinggi (sentimen long agresif, funding biasanya menyusul naik); " +
        "basis negatif besar menandakan futures discount (sentimen short agresif); basis mendekati nol tapi funding " +
        "masih ekstrem menandakan funding lagging, kemungkinan mean-revert akan terjadi. " +
        "Gunakan tool ini untuk membaca sentimen leverage pasar saat ini. " +
        "PERHATIAN: index price Binance adalah rata-rata tertimbang dari beberapa exchange spot — untuk pair kecil " +
        "atau baru listing, salah satu exchange sumber bisa illikuid dan membuat index price (dan karenanya basis) " +
        "jadi noisy; interpretasikan dengan hati-hati untuk pair semacam itu.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getCurrentFundingRateNative(symbol);
        const rate = parseFloat(data.lastFundingRate);
        const markPrice = parseFloat(data.markPrice);
        const indexPrice = parseFloat(data.indexPrice);
        // Basis = deviasi mark price dari index price. Ini SATU-SATUNYA angka
        // divergensi mark-vs-index yang kita tampilkan — sengaja tidak dihitung
        // dua kali dengan nama berbeda karena keduanya angka yang sama persis.
        const basis = (markPrice - indexPrice) / indexPrice;

        const interpretation =
          rate >= 0.0003
            ? "CROWDED LONG (funding cukup tinggi — mayoritas leverage di sisi long, ada risiko long squeeze jika harga berbalik turun)"
            : rate <= -0.0003
              ? "CROWDED SHORT (funding negatif signifikan — mayoritas leverage di sisi short, ada risiko short squeeze jika harga berbalik naik)"
              : "NETRAL (funding dalam rentang wajar, tidak ada crowding ekstrem yang jelas)";

        const BASIS_THRESHOLD = 0.0005; // 0.05% — basis wajar biasanya lebih sempit dari ini di pair likuid
        const basisInterpretation =
          basis >= BASIS_THRESHOLD
            ? "PREMIUM TINGGI (mark price jauh di atas index — sentimen long agresif di futures, funding rate biasanya menyusul naik)"
            : basis <= -BASIS_THRESHOLD
              ? "DISCOUNT TINGGI (mark price jauh di bawah index — sentimen short agresif di futures, funding rate biasanya menyusul turun)"
              : Math.abs(rate) >= 0.0003
                ? "BASIS NETRAL TAPI FUNDING EKSTREM (basis belum mengkonfirmasi funding — kemungkinan funding lagging, waspada potensi mean-revert funding ke arah netral)"
                : "NETRAL (basis dalam rentang wajar, mark price mengikuti index dengan dekat)";

        const text = [
          `# Funding Rate — ${symbol}`,
          ``,
          `- Funding Rate Saat Ini: ${fmtPct(rate, 4)}`,
          `- Mark Price: ${fmtPrice(markPrice)}`,
          `- Index Price: ${fmtPrice(indexPrice)}`,
          `- Basis (Mark vs Index): ${fmtPct(basis, 4)}`,
          `- Waktu Funding Berikutnya: ${fmtTime(data.nextFundingTime)}`,
          `- Update Terakhir: ${fmtTime(data.time)}`,
          ``,
          `**Interpretasi Funding**: ${interpretation}`,
          `**Interpretasi Basis**: ${basisInterpretation}`,
          ``,
          `_Catatan: threshold crowded funding (±0.03%) dan basis (±0.05%) adalah heuristik umum, sesuaikan dengan konteks volatilitas pair yang sedang ditradingkan. Index price Binance adalah rata-rata tertimbang dari beberapa exchange spot — untuk pair kecil/baru listing, salah satu exchange sumber bisa illikuid dan membuat index price sendiri jadi noisy. Data LANGSUNG dari Binance native (premiumIndex)._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            fundingRate: rate,
            markPrice,
            indexPrice,
            basis,
            interpretation,
            basisInterpretation,
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
        "Mengambil histori funding rate (yang sudah settled) untuk melihat tren crowding leverage dari waktu ke waktu " +
        "(LANGSUNG dari Binance native, bukan lewat Coinalyze — source of truth). Berguna untuk melihat apakah sentimen " +
        "long/short sudah crowded dalam beberapa hari terakhir atau baru saja berubah.",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(PERIOD_ENUM)
          .default("1h")
          .describe(
            "Diabaikan — histori funding rate native Binance settled per interval funding pair itu sendiri (biasanya tiap 4-8 jam), bukan per-period custom. Parameter dipertahankan untuk kompatibilitas.",
          ),
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
    async ({ symbol, limit }) => {
      try {
        const points = await binanceProxy.getFundingRateHistoryNative(symbol, limit);
        if (points.length === 0) {
          return {
            content: [
              { type: "text", text: `Tidak ada data histori funding rate untuk ${symbol}.` },
            ],
          };
        }
        const rates = points.map((p) => parseFloat(p.fundingRate));
        const rows = points
          .map((p, i) => `| ${fmtTime(p.fundingTime)} | ${fmtPct(rates[i], 4)} |`)
          .join("\n");

        const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
        const direction = trendDirection(rates);

        const text = [
          `# Histori Funding Rate — ${symbol} (${points.length} data terakhir)`,
          ``,
          `| Waktu Settlement | Funding Rate |`,
          `|---|---|`,
          rows,
          ``,
          `**Rata-rata funding**: ${fmtPct(avg, 4)}`,
          `**Tren**: ${direction} (dibandingkan data paling lama vs paling baru dalam window ini)`,
          ``,
          `_Data LANGSUNG dari Binance native (fundingRate history — sudah settled)._`,
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
        "Mengambil Open Interest (total kontrak terbuka) TERKINI untuk sebuah pair (LANGSUNG dari Binance native, bukan lewat " +
        "Coinalyze — source of truth). " +
        "OI naik + harga naik = tren didukung entry baru (sehat). " +
        "OI turun + harga naik = short covering / posisi ditutup, bukan entry baru (kurang solid). " +
        "OI turun tajam = kemungkinan capitulation/liquidation massal.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getOpenInterestNative(symbol);
        const openInterest = parseFloat(data.openInterest);
        const text = [
          `# Open Interest — ${symbol}`,
          ``,
          `- Open Interest: ${fmtNum(openInterest, 2)} kontrak`,
          `- Waktu: ${fmtTime(data.time)}`,
          ``,
          `_Gunakan bersama \`binance_get_open_interest_history\` untuk melihat tren naik/turun, dan bandingkan dengan pergerakan harga untuk interpretasi yang benar (OI saja tanpa konteks harga bisa menyesatkan). Data LANGSUNG dari Binance native._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, openInterest, time: data.time },
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
        "Mengambil histori Open Interest untuk melihat TREN naik/turun sepanjang waktu (bukan cuma snapshot), LANGSUNG dari " +
        "Binance native (bukan lewat Coinalyze — source of truth). Ini yang dibutuhkan untuk menjawab 'apakah OI sedang naik " +
        "atau turun hari ini'. Kombinasikan dengan data candlestick harga (binance_get_klines) pada periode yang sama untuk " +
        "interpretasi yang valid: OI naik + harga naik = trend genuinely didukung entry baru; OI turun + harga naik = short " +
        "covering (rally rapuh).",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(FUTURES_DATA_PERIOD_ENUM)
          .default("15m")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(30).describe("Jumlah data poin"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const bars = await binanceProxy.getOpenInterestHistNative(symbol, period, limit);
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
        const values = bars.map((b) => parseFloat(b.sumOpenInterest));
        const direction = trendDirection(values);
        const first = values[0];
        const last = values[values.length - 1];
        const changePct = first !== 0 ? ((last - first) / first) * 100 : 0;

        const rows = bars
          .map((b, i) => `| ${fmtTime(b.timestamp)} | ${fmtNum(values[i], 2)} |`)
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
          `_Langkah selanjutnya yang disarankan: panggil \`binance_get_klines\` pair & timeframe yang sama untuk cek apakah OI ${direction} ini terjadi bersamaan dengan harga naik atau turun — kombinasi keduanya yang menentukan interpretasi (entry baru vs covering vs capitulation). Data LANGSUNG dari Binance native._`,
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
        "Mengambil rasio posisi long vs short agregat (semua akun/global) untuk sebuah pair Binance Futures, beserta tren dari " +
        "waktu ke waktu (LANGSUNG dari Binance native globalLongShortAccountRatio, bukan lewat Coinalyze — source of truth). " +
        "Ratio > 1 berarti lebih banyak/besar posisi long dibanding short. " +
        "KETERBATASAN: ini rasio agregat BLENDED, BUKAN breakdown terpisah retail-vs-top-trader — untuk breakdown top-trader " +
        "murni, pakai binance_get_top_trader_ratio.",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(FUTURES_DATA_PERIOD_ENUM)
          .default("15m")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(10).describe("Jumlah data poin terakhir"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const points = await binanceProxy.getGlobalAccountRatio(symbol, period, limit);
        if (points.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Data long/short ratio tidak tersedia untuk ${symbol}. Pastikan symbol adalah pair perpetual USDT-margined yang aktif.`,
              },
            ],
          };
        }

        const longPcts = points.map((p) => parseFloat(p.longAccount) * 100);
        const shortPcts = points.map((p) => parseFloat(p.shortAccount) * 100);
        const ratios = points.map((p) => parseFloat(p.longShortRatio));

        const latestLongPct = longPcts[longPcts.length - 1];
        const latestShortPct = shortPcts[shortPcts.length - 1];
        const latestRatio = ratios[ratios.length - 1];
        const bias = latestLongPct > 55 ? "LONG" : latestLongPct < 45 ? "SHORT" : "NETRAL";
        const direction = trendDirection(ratios);

        const rows = points
          .map(
            (p, i) =>
              `| ${fmtTime(p.timestamp)} | ${longPcts[i].toFixed(2)}% | ${shortPcts[i].toFixed(2)}% | ${fmtNum(ratios[i], 4)} |`,
          )
          .join("\n");

        const text = [
          `# Long/Short Ratio — ${symbol} (period: ${period})`,
          ``,
          `## Snapshot Terkini`,
          `- **Long**: ${latestLongPct.toFixed(1)}% / **Short**: ${latestShortPct.toFixed(1)}% → ratio ${fmtNum(latestRatio, 4)} → bias ${bias}`,
          `**Tren**: ${direction}`,
          ``,
          `## Histori`,
          `| Waktu | Long % | Short % | Ratio |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_Ini rasio agregat semua trader (blended), bukan breakdown top-trader/whale terpisah dari retail — pakai binance_get_top_trader_ratio untuk breakdown murni. Data LANGSUNG dari Binance native._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            longPct: latestLongPct,
            shortPct: latestShortPct,
            ratio: latestRatio,
            bias,
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // TOP-TRADER LONG/SHORT RATIO — breakdown top trader murni,
  // langsung dari Binance lewat proxy Vercel, BUKAN blended seperti
  // binance_get_long_short_ratio di atas.
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_top_trader_ratio",
    {
      title: "Top-Trader Long/Short Ratio (Breakdown Murni)",
      description:
        "Mengambil rasio long/short KHUSUS TOP TRADER (akun dengan posisi/margin terbesar di Binance Futures), TERPISAH dari " +
        "retail — data ini LANGSUNG dari Binance (lewat proxy relay, bukan lewat Coinalyze), jadi tidak ter-blend dengan akun kecil. " +
        "Ini proxy yang lebih dekat ke 'whale positioning' dibanding binance_get_long_short_ratio yang blended. " +
        "mode='account' = breakdown berdasarkan JUMLAH akun top trader yang long vs short. " +
        "mode='position' = breakdown berdasarkan SIZE POSISI top trader (mungkin lebih relevan untuk melihat dominasi modal besar, " +
        "karena satu akun besar dengan posisi masif tetap terhitung 1 akun di mode='account' tapi bobotnya besar di mode='position'). " +
        "KETERBATASAN: Binance tidak mempublikasikan threshold pasti 'top trader' itu top berapa persen, dan data ini snapshot " +
        "periodik (bukan real-time tick-by-tick).",
      inputSchema: {
        symbol: symbolSchema,
        mode: z
          .enum(["account", "position"])
          .default("account")
          .describe("'account' = breakdown jumlah akun top trader, 'position' = breakdown size posisi top trader"),
        period: z
          .enum(FUTURES_DATA_PERIOD_ENUM)
          .default("1h")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(10).describe("Jumlah data poin terakhir"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, mode, period, limit }) => {
      try {
        const points =
          mode === "position"
            ? await binanceProxy.getTopTraderPositionRatio(symbol, period, limit)
            : await binanceProxy.getTopTraderAccountRatio(symbol, period, limit);

        if (points.length === 0) {
          return {
            content: [
              { type: "text", text: `Tidak ada data top-trader ratio untuk ${symbol} (mode: ${mode}).` },
            ],
          };
        }

        const latest = points[points.length - 1];
        const longPct = parseFloat(latest.longAccount) * 100;
        const shortPct = parseFloat(latest.shortAccount) * 100;
        const ratio = parseFloat(latest.longShortRatio);
        const bias = longPct > 55 ? "LONG" : longPct < 45 ? "SHORT" : "NETRAL";
        const direction = trendDirection(points.map((p) => parseFloat(p.longShortRatio)));

        const rows = points
          .map(
            (p) =>
              `| ${fmtTime(p.timestamp)} | ${(parseFloat(p.longAccount) * 100).toFixed(2)}% | ${(parseFloat(p.shortAccount) * 100).toFixed(2)}% | ${fmtNum(parseFloat(p.longShortRatio), 4)} |`,
          )
          .join("\n");

        const modeLabel = mode === "position" ? "SIZE POSISI top trader" : "JUMLAH AKUN top trader";

        const text = [
          `# Top-Trader Long/Short Ratio — ${symbol} (mode: ${mode}, period: ${period})`,
          ``,
          `## Snapshot Terkini (berdasarkan ${modeLabel})`,
          `- **Long**: ${longPct.toFixed(2)}% / **Short**: ${shortPct.toFixed(2)}% → ratio ${fmtNum(ratio, 4)} → bias ${bias}`,
          `**Tren**: ${direction}`,
          ``,
          `## Histori`,
          `| Waktu | Long % | Short % | Ratio |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_Data LANGSUNG dari Binance (bukan Coinalyze), khusus akun TOP TRADER — lebih dekat ke proxy whale dibanding binance_get_long_short_ratio yang blended semua trader. Threshold 'top trader' tidak dipublikasikan Binance secara pasti._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, mode, longPct, shortPct, ratio, bias },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // ORDER BOOK DEPTH
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_order_book_depth",
    {
      title: "Order Book Depth",
      description:
        "Mengambil snapshot order book (bid/ask) real-time dengan size per level harga, LANGSUNG dari Binance lewat proxy relay. " +
        "Berguna untuk melihat wall besar (potensi order whale/spoofing), spread bid-ask, dan likuiditas di sekitar harga saat ini. " +
        "PENTING: ini snapshot SESAAT — order book berubah sangat cepat, terutama untuk pair dengan volume tinggi. Wall besar bisa " +
        "hilang dalam hitungan detik (bisa jadi spoofing/fake wall, bukan komitmen order sungguhan). Jangan overinterpretasi satu " +
        "snapshot sebagai sinyal pasti.",
      inputSchema: {
        symbol: symbolSchema,
        limit: z
          .number()
          .int()
          .refine((v) => [5, 10, 20, 50, 100, 500, 1000].includes(v), {
            message: "limit harus salah satu dari: 5, 10, 20, 50, 100, 500, 1000 (sesuai batasan Binance API)",
          })
          .default(20)
          .describe("Jumlah level bid/ask yang diambil per sisi. Harus salah satu dari: 5, 10, 20, 50, 100, 500, 1000."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit }) => {
      try {
        const data = await binanceProxy.getOrderBookDepth(symbol, limit);

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

        // Cari level dengan quantity terbesar di masing-masing sisi (potensi wall).
        const largestBid = data.bids.reduce(
          (max, [p, q]) => (parseFloat(q) > parseFloat(max[1]) ? [p, q] : max),
          data.bids[0] ?? ["0", "0"],
        );
        const largestAsk = data.asks.reduce(
          (max, [p, q]) => (parseFloat(q) > parseFloat(max[1]) ? [p, q] : max),
          data.asks[0] ?? ["0", "0"],
        );

        const text = [
          `# Order Book Depth — ${symbol} (${limit} level per sisi)`,
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
          `_Snapshot sesaat (waktu server Binance: ${fmtTime(data.T)}). Order book berubah cepat — wall besar bisa jadi spoofing, jangan jadi satu-satunya sinyal keputusan._`,
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

  // ─────────────────────────────────────────────────────────────
  // ORDER BOOK IMBALANCE (OBI)
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_order_book_imbalance",
    {
      title: "Order Book Imbalance (OBI)",
      description:
        "Menghitung persentase imbalance volume Bid vs Ask secara kumulatif di 3 level kedalaman harga (depth 5, 10, 20) " +
        "sekaligus dalam satu panggilan, LANGSUNG dari Binance lewat proxy relay. Beda dari binance_get_order_book_depth " +
        "yang cuma kasih snapshot mentah — tool ini langsung kasih rasio bid vs ask plus label bias (BULLISH/BEARISH/SEIMBANG) " +
        "per depth level. PENTING: ini snapshot SESAAT — order book berubah cepat, jangan overinterpretasi satu snapshot sebagai " +
        "sinyal pasti (sama seperti binance_get_order_book_depth).",
      inputSchema: {
        symbol: symbolSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getOrderBookDepth(symbol, 20);
        const depthLevels = [5, 10, 20] as const;

        const results = depthLevels.map((depth) => {
          const bidVol = data.bids
            .slice(0, depth)
            .reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
          const askVol = data.asks
            .slice(0, depth)
            .reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
          const totalVol = bidVol + askVol;

          if (totalVol === 0) {
            return { depth, bidVol, askVol, bidPct: null as number | null, bias: "TIDAK ADA DATA" };
          }

          const bidPct = (bidVol / totalVol) * 100;
          const bias = bidPct > 60 ? "BULLISH (bid dominan)" : bidPct < 40 ? "BEARISH (ask dominan)" : "SEIMBANG";
          return { depth, bidVol, askVol, bidPct, bias };
        });

        const rows = results
          .map(
            (r) =>
              `| ${r.depth} | ${fmtNum(r.bidVol, 4)} | ${fmtNum(r.askVol, 4)} | ${r.bidPct !== null ? r.bidPct.toFixed(2) + "%" : "N/A"} | ${r.bias} |`,
          )
          .join("\n");

        const bestBid = data.bids[0] ? parseFloat(data.bids[0][0]) : null;
        const bestAsk = data.asks[0] ? parseFloat(data.asks[0][0]) : null;

        const text = [
          `# Order Book Imbalance — ${symbol}`,
          ``,
          `**Best Bid**: ${bestBid !== null ? fmtPrice(bestBid) : "N/A"} | **Best Ask**: ${bestAsk !== null ? fmtPrice(bestAsk) : "N/A"}`,
          ``,
          `| Depth | Bid Volume | Ask Volume | Bid % | Bias |`,
          `|---|---|---|---|---|`,
          rows,
          ``,
          `_Snapshot sesaat (waktu server Binance: ${fmtTime(data.T)}). Volume dihitung dari raw base-asset quantity, ` +
            `bukan notional. Order book berubah cepat — jangan overinterpretasi satu snapshot sebagai sinyal pasti._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, levels: results },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // AGGREGATE TRADES / CVD GRANULAR
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_agg_trades",
    {
      title: "Aggregate Trades (untuk CVD Granular)",
      description:
        "Mengambil trade individual terbaru (aggregate trades) LANGSUNG dari Binance lewat proxy relay, termasuk apakah masing- " +
        "masing trade adalah buy atau sell aggressor (taker). Berbeda dari binance_get_taker_volume_ratio yang teragregasi per-jam, " +
        "ini granular per-trade — cocok untuk mendeteksi absorption (harga stagnan tapi volume besar masuk searah, indikasi entitas " +
        "besar menyerap likuiditas tanpa menggerakkan harga secara signifikan) atau lonjakan agresi mendadak. " +
        "PENTING: limit maksimal dibatasi ketat karena ini data granular, tidak cocok untuk analisis periode panjang — gunakan " +
        "binance_get_taker_volume_ratio untuk gambaran periode lebih panjang.",
      inputSchema: {
        symbol: symbolSchema,
        limit: z.number().int().min(1).max(200).default(50).describe("Jumlah trade terakhir yang diambil, maksimal 200."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit }) => {
      try {
        const trades = await binanceProxy.getAggTrades(symbol, limit);
        if (trades.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data trade untuk ${symbol}.` }] };
        }

        // m: true = buyer adalah maker → artinya SELLER yang agresif (taker sell).
        // m: false = buyer adalah taker → artinya BUYER yang agresif (taker buy).
        let buyVolume = 0;
        let sellVolume = 0;
        for (const t of trades) {
          const qty = parseFloat(t.q);
          if (t.m) sellVolume += qty;
          else buyVolume += qty;
        }
        const totalVolume = buyVolume + sellVolume;
        const buyPct = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 0;
        const cvd = buyVolume - sellVolume; // Cumulative Volume Delta sederhana untuk window ini

        const recent = trades.slice(-15);
        const rows = recent
          .map((t) => {
            const side = t.m ? "SELL (taker)" : "BUY (taker)";
            return `| ${fmtTime(t.T)} | ${fmtPrice(parseFloat(t.p))} | ${fmtNum(parseFloat(t.q), 4)} | ${side} |`;
          })
          .join("\n");

        const text = [
          `# Aggregate Trades — ${symbol} (${trades.length} trade terakhir)`,
          ``,
          `**CVD window ini**: ${cvd >= 0 ? "+" : ""}${fmtNum(cvd, 4)} (Buy: ${fmtNum(buyVolume, 4)} / Sell: ${fmtNum(sellVolume, 4)})`,
          `**Dominasi**: ${buyPct.toFixed(1)}% BUY vs ${(100 - buyPct).toFixed(1)}% SELL`,
          ``,
          `## ${recent.length} Trade Terakhir`,
          `| Waktu | Harga | Quantity | Sisi |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_CVD positif = tekanan beli agresif dominan di window ini. CVD negatif = tekanan jual agresif dominan. Window ini sangat pendek (${trades.length} trade) — untuk gambaran lebih luas, kombinasikan dengan binance_get_taker_volume_ratio._`,
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

  // ─────────────────────────────────────────────────────────────
  // LIQUIDATION HISTORY
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_liquidation_history",
    {
      title: "Histori Liquidation",
      description:
        "Mengambil histori nilai liquidation (long dan short yang kena force-close) untuk sebuah pair Binance Futures " +
        "dalam rentang waktu tertentu (data via Coinalyze, sumber asli Binance). PENTING: ini data LAGGING/REAKTIF — " +
        "mencatat apa yang SUDAH terjadi, bukan sinyal arah ke depan. Long liquidation dominan = tekanan turun baru saja " +
        "menyapu posisi long (bisa berarti downtrend berlanjut ATAU seller sudah kehabisan tenaga — perlu konfirmasi " +
        "tambahan dari funding rate/OI/price action). Short liquidation dominan = kebalikannya untuk sisi atas.",
      inputSchema: {
        symbol: symbolSchema,
        period: z
          .enum(PERIOD_ENUM)
          .default("1h")
          .describe("Interval antar data poin: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d"),
        limit: z.number().int().min(1).max(500).default(24).describe("Jumlah data poin histori yang diambil"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const bars = await coinalyze.getLiquidationHistory(symbol, period, limit);
        if (bars.length === 0) {
          return {
            content: [
              { type: "text", text: `Tidak ada data histori liquidation untuk ${symbol} pada period ${period}.` },
            ],
          };
        }

        const totalLong = bars.reduce((sum, b) => sum + b.l, 0);
        const totalShort = bars.reduce((sum, b) => sum + b.s, 0);
        const totalAll = totalLong + totalShort;
        const dominance =
          totalAll === 0
            ? "TIDAK ADA DATA"
            : totalLong > totalShort * 1.3
              ? "LONG DOMINAN (tekanan turun baru saja terjadi)"
              : totalShort > totalLong * 1.3
                ? "SHORT DOMINAN (tekanan naik baru saja terjadi)"
                : "SEIMBANG";

        const rows = bars
          .map((b) => `| ${fmtTime(b.t * 1000)} | ${fmtNum(b.l, 2)} | ${fmtNum(b.s, 2)} |`)
          .join("\n");

        const text = [
          `# Histori Liquidation — ${symbol} (period: ${period}, ${bars.length} data poin)`,
          ``,
          `**Total Long Liquidated**: ${fmtNum(totalLong, 2)}`,
          `**Total Short Liquidated**: ${fmtNum(totalShort, 2)}`,
          `**Dominasi window ini**: ${dominance}`,
          ``,
          `| Waktu | Long Liquidated | Short Liquidated |`,
          `|---|---|---|`,
          rows,
          ``,
          `_PENTING: data ini LAGGING (reaktif terhadap apa yang sudah terjadi), bukan sinyal arah ke depan. ` +
            `Jangan pakai sendirian untuk keputusan entry — kombinasikan dengan funding rate, OI trend, dan price action ` +
            `pada window waktu yang sama untuk interpretasi yang valid (misal: apakah ini akhir dari sebuah cascade, atau baru awal)._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, totalLong, totalShort, dominance },
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
        "yang berbasis posisi terbuka (LANGSUNG dari Binance native takerlongshortRatio, bukan lagi diturunkan manual dari volume " +
        "candlestick Coinalyze — source of truth). Berguna sebagai konfirmasi tambahan: apakah tekanan eksekusi market saat ini " +
        "condong beli atau jual.",
      inputSchema: {
        symbol: symbolSchema,
        period: z.enum(FUTURES_DATA_PERIOD_ENUM).default("15m"),
        limit: z.number().int().min(1).max(500).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, period, limit }) => {
      try {
        const points = await binanceProxy.getTakerLongShortRatioNative(symbol, period, limit);
        if (points.length === 0) {
          return {
            content: [{ type: "text", text: `Tidak ada data taker volume untuk ${symbol}.` }],
          };
        }
        const ratios = points.map((p) => parseFloat(p.buySellRatio));
        const ratio = ratios[ratios.length - 1];
        const bias = ratio > 1.05 ? "BUY dominan" : ratio < 0.95 ? "SELL dominan" : "seimbang";

        const rows = points
          .map((p, i) => `| ${fmtTime(p.timestamp)} | ${fmtNum(ratios[i], 4)} |`)
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
          ``,
          `_Data LANGSUNG dari Binance native (takerlongshortRatio) — buySellRatio dihitung resmi oleh Binance, bukan derivasi manual dari candlestick._`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // KLINES / PRICE ACTION untuk bias per-timeframe (Binance native)
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_klines",
    {
      title: "Data Candlestick (Klines)",
      description:
        "Mengambil data candlestick OHLCV untuk sebuah pair pada timeframe tertentu (LANGSUNG dari Binance native, " +
        "bukan lewat Coinalyze — source of truth, presisi harga menyesuaikan magnitude pair). " +
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
        const raw = await binanceProxy.getKlinesNative(symbol, interval, limit);
        if (raw.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data candle untuk ${symbol} @ ${interval}.` }] };
        }

        // Format Binance native: [openTime, open, high, low, close, volume, closeTime, ...]
        const candles = raw.map((k) => ({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
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
            const bias = changePct > 1 ? "BULLISH" : changePct < -1 ? "BEARISH" : "SIDEWAYS";
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

  server.registerTool(
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

  server.registerTool(
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

  return server;
}
