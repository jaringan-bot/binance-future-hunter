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

// Parse ISO 8601 datetime string ke epoch ms. Dipakai untuk startTime/endTime
// klines (Futures & Spot) supaya backtest bisa narik histori jauh ke belakang,
// bukan cuma N candle terakhir.
export function parseTimeParam(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(
      `${label} tidak valid: "${value}" bukan format tanggal yang bisa di-parse. Gunakan ISO 8601, contoh: "2026-07-01T00:00:00Z".`,
    );
  }
  return ms;
}

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
export function computeRealizedVolatility(
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
        const [spot, futures] = await Promise.all([
          binanceProxy.getSpotPrice(symbol),
          binanceProxy.getCurrentFundingRateNative(symbol),
        ]);
        const spotPrice = parseFloat(spot.price);
        const markPrice = parseFloat(futures.markPrice);
        const basis = (markPrice - spotPrice) / spotPrice;

        const BASIS_THRESHOLD = 0.0005; // 0.05% — sama dengan threshold basis di binance_get_funding_rate
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
          `_Basis di sini vs harga SPOT BINANCE LANGSUNG, beda dari basis di binance_get_funding_rate yang vs INDEX price ` +
            `(rata-rata beberapa exchange). Kalau tool ini error "Invalid symbol", pair tersebut FUTURES-ONLY (tidak listed ` +
            `di Binance Spot) — basis futures-vs-spot tidak bisa dihitung untuk pair semacam itu._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, spotPrice, markPrice, basis, basisInterpretation },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // MARKET SCANNER — funding rate paling ekstrem lintas SEMUA pair Futures
  // sekaligus, 1 call ke premiumIndex tanpa parameter symbol (bukan loop
  // per-pair). Berguna untuk pertanyaan "pair mana yang paling crowded
  // long/short sekarang" tanpa perlu tau symbol-nya duluan.
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_scan_funding_extremes",
    {
      title: "Scan Funding Rate Paling Ekstrem (Semua Pair)",
      description:
        "Scan funding rate SEMUA pair Binance Futures sekaligus (1 call ke premiumIndex tanpa symbol, bukan loop " +
        "per-pair — jauh lebih murah), lalu urutkan dan kembalikan pair paling crowded LONG (funding paling positif) " +
        "dan paling crowded SHORT (funding paling negatif). Berguna untuk pertanyaan 'pair apa yang funding-nya " +
        "paling ekstrem sekarang' tanpa perlu tau symbol spesifik duluan — komplemen dari binance_get_funding_rate " +
        "yang perlu symbol. Threshold crowded sama dengan binance_get_funding_rate (±0.03%).",
      inputSchema: {
        quoteFilter: z
          .string()
          .optional()
          .default("USDT")
          .describe(
            "Filter pair berdasarkan quote asset di akhir symbol, misal 'USDT' (default, pair USDT-M) atau 'USDC'. Kosongkan string ('') untuk lihat semua pair tanpa filter quote asset.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Jumlah pair teratas per sisi (crowded long / crowded short) yang ditampilkan"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ quoteFilter, limit }) => {
      try {
        const all = await binanceProxy.getBulkFundingRatesNative();
        const filtered = all
          .filter((p) => (quoteFilter ? p.symbol.endsWith(quoteFilter) : true))
          .filter((p) => parseFloat(p.markPrice) > 0)
          .map((p) => ({
            symbol: p.symbol,
            fundingRate: parseFloat(p.lastFundingRate),
            markPrice: parseFloat(p.markPrice),
          }))
          .filter((p) => !Number.isNaN(p.fundingRate));

        if (filtered.length === 0) {
          return {
            content: [
              { type: "text", text: `Tidak ada pair yang cocok dengan filter quote '${quoteFilter}'.` },
            ],
          };
        }

        const crowdedLong = [...filtered].sort((a, b) => b.fundingRate - a.fundingRate).slice(0, limit);
        const crowdedShort = [...filtered].sort((a, b) => a.fundingRate - b.fundingRate).slice(0, limit);

        const rowsLong = crowdedLong
          .map((p, i) => `| ${i + 1} | ${p.symbol} | ${fmtPct(p.fundingRate, 4)} | ${fmtPrice(p.markPrice)} |`)
          .join("\n");
        const rowsShort = crowdedShort
          .map((p, i) => `| ${i + 1} | ${p.symbol} | ${fmtPct(p.fundingRate, 4)} | ${fmtPrice(p.markPrice)} |`)
          .join("\n");

        const text = [
          `# Scan Funding Rate Ekstrem (${filtered.length} pair dicek${quoteFilter ? `, filter quote: ${quoteFilter}` : ""})`,
          ``,
          `## Top ${crowdedLong.length} CROWDED LONG (funding paling positif)`,
          `| # | Symbol | Funding Rate | Mark Price |`,
          `|---|---|---|---|`,
          rowsLong,
          ``,
          `## Top ${crowdedShort.length} CROWDED SHORT (funding paling negatif)`,
          `| # | Symbol | Funding Rate | Mark Price |`,
          `|---|---|---|---|`,
          rowsShort,
          ``,
          `_Funding rate positif besar = mayoritas leverage di sisi long (risiko long squeeze jika harga berbalik). ` +
            `Funding rate negatif besar = mayoritas leverage di sisi short (risiko short squeeze). Threshold crowded ` +
            `heuristik ±0.03%, sama dengan binance_get_funding_rate — sesuaikan dengan konteks volatilitas pair. ` +
            `Data dari 1 call premiumIndex bulk (semua pair Futures sekaligus), snapshot sesaat._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            totalPairsScanned: filtered.length,
            quoteFilter,
            crowdedLong,
            crowdedShort,
          },
        };
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
        "periodik (bukan real-time tick-by-tick). " +
        "Untuk deteksi divergence smart-money vs retail (docs/mm_detection_framework.md Section 4.2): JANGAN pakai threshold " +
        "absolut universal (misal '15%') — tervalidasi data riil, pergerakan pair likuid (BTC/ETH) cuma <2.5 poin per 2 jam. " +
        "Bandingkan RELATIF ke histori pendek pair itu sendiri (~5-30 hari tergantung resolusi, retensi Binance terbatas), " +
        "fokus ke ARAH pergerakan yang berlawanan dari binance_get_long_short_ratio, bukan magnitude absolut.",
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
        "snapshot sebagai sinyal pasti. " +
        "Untuk deteksi spoofing/absorption yang lebih sistematis, lihat docs/mm_detection_framework.md Section 2-3 — rule of " +
        "thumb: butuh minimal 3 sinyal align (misal wall + CVD + OI) sebelum menyimpulkan aktivitas MM, satu snapshot saja tidak cukup.",
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
        "tambahan dari funding rate/OI/price action). Short liquidation dominan = kebalikannya untuk sisi atas. " +
        "Untuk deteksi stop hunt (docs/mm_detection_framework.md Section 4): PENTING, response ini TIDAK punya field " +
        "harga sama sekali (cuma total per window waktu) — cross-check manual dengan binance_get_klines di window waktu " +
        "yang sama untuk mapping ke level harga (wick candle).",
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
        "dan level psikologis untuk estimasi zona SL/TP. " +
        "Default (tanpa startTime/endTime) balikin candle TERBARU. Isi startTime untuk narik histori jauh ke belakang " +
        "(misal buat backtest strategi grid) — Binance balikin candle MULAI dari startTime ke depan, maksimal `limit` candle " +
        "per panggilan (limit maksimal 1500 untuk Futures). Untuk rentang lebih dari 1500 candle, panggil berkali-kali sambil " +
        "geser startTime ke closeTime candle terakhir dari hasil sebelumnya (pagination manual, tidak otomatis).",
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
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit, startTime, endTime }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        const raw = await binanceProxy.getKlinesNative(symbol, interval, limit, startMs, endMs);
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
            candles,
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
        "yang 1500). Untuk rentang lebih dari 1000 candle, panggil berkali-kali sambil geser startTime (pagination manual).",
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
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, interval, limit, startTime, endTime }) => {
      try {
        const startMs = parseTimeParam(startTime, "startTime");
        const endMs = parseTimeParam(endTime, "endTime");
        const raw = await binanceProxy.getSpotKlinesNative(symbol, interval, limit, startMs, endMs);
        if (raw.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data candle Spot untuk ${symbol} @ ${interval}.` }] };
        }

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
        const bias = changePct > 1 ? "BULLISH" : changePct < -1 ? "BEARISH" : "SIDEWAYS";

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
          structuredContent: { symbol, interval, bias, changePct, swingHigh, swingLow, lastClose, candles },
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

        let buyVolume = 0;
        let sellVolume = 0;
        for (const t of trades) {
          const qty = parseFloat(t.q);
          if (t.m) sellVolume += qty;
          else buyVolume += qty;
        }
        const totalVolume = buyVolume + sellVolume;
        const buyPct = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 0;
        const cvd = buyVolume - sellVolume;

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

  // ─────────────────────────────────────────────────────────────
  // COMPOSITE ANALYSIS — 1 tool call yang internally manggil 6 tool
  // sekaligus lewat Promise.all (funding, OI trend, top trader trend,
  // taker volume trend, order book, klines/bias), kembalikan summary
  // terstruktur. Mengurangi jumlah tool call buat overview cepat, tapi
  // TETAP bukan pengganti tool individual kalau butuh detail/histori
  // lebih panjang -- ini snapshot ringkas per masing-masing sudut.
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_analyze_pair",
    {
      title: "Analisis Ringkas Satu Pair (Composite)",
      description:
        "Overview cepat satu pair dalam SATU tool call: funding rate & basis, tren OI 6 jam terakhir, tren top-trader " +
        "positioning 4 jam terakhir, tren taker volume 4 jam terakhir, snapshot order book, dan bias harga dari 24 " +
        "candle 1 jam -- internally manggil 6 tool sekaligus lewat Promise.all. Cocok untuk pertanyaan 'gimana kondisi " +
        "pair X sekarang' tanpa perlu panggil tool satu-satu. Untuk histori lebih panjang atau detail per-sudut, tetap " +
        "pakai tool individual (binance_get_open_interest_history, binance_get_klines, dst) -- ini snapshot ringkas, " +
        "bukan pengganti analisis mendalam.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const [funding, oiHist, topTrader, taker, orderBook, klines] = await Promise.all([
          binanceProxy.getCurrentFundingRateNative(symbol),
          binanceProxy.getOpenInterestHistNative(symbol, "1h", 6),
          binanceProxy.getTopTraderPositionRatio(symbol, "1h", 4),
          binanceProxy.getTakerLongShortRatioNative(symbol, "1h", 4),
          binanceProxy.getOrderBookDepth(symbol, 20),
          binanceProxy.getKlinesNative(symbol, "1h", 24),
        ]);

        // Funding & basis
        const fundingRate = parseFloat(funding.lastFundingRate);
        const markPrice = parseFloat(funding.markPrice);
        const indexPrice = parseFloat(funding.indexPrice);
        const basis = (markPrice - indexPrice) / indexPrice;
        const fundingBias =
          fundingRate >= 0.0003 ? "CROWDED LONG" : fundingRate <= -0.0003 ? "CROWDED SHORT" : "netral";

        // OI trend
        const oiValues = oiHist.map((p) => parseFloat(p.sumOpenInterest));
        const oiTrend = trendDirection(oiValues);
        const oiChangePct =
          oiValues.length >= 2 && oiValues[0] !== 0
            ? ((oiValues[oiValues.length - 1] - oiValues[0]) / oiValues[0]) * 100
            : 0;

        // Top trader trend
        const topTraderLongPct = topTrader.map((p) => parseFloat(p.longAccount) * 100);
        const topTraderTrend = trendDirection(topTraderLongPct);
        const topTraderLatest = topTraderLongPct[topTraderLongPct.length - 1] ?? 0;

        // Taker volume
        const takerRatios = taker.map((p) => parseFloat(p.buySellRatio));
        const takerLatest = takerRatios[takerRatios.length - 1] ?? 1;
        const takerBias = takerLatest > 1.05 ? "BUY dominan" : takerLatest < 0.95 ? "SELL dominan" : "seimbang";

        // Order book
        const bestBid = orderBook.bids[0] ? parseFloat(orderBook.bids[0][0]) : null;
        const bestAsk = orderBook.asks[0] ? parseFloat(orderBook.asks[0][0]) : null;
        const spreadPct =
          bestBid !== null && bestAsk !== null ? ((bestAsk - bestBid) / bestBid) * 100 : null;

        // Klines bias
        const closes = klines.map((k) => parseFloat(k[4]));
        const highs = klines.map((k) => parseFloat(k[2]));
        const lows = klines.map((k) => parseFloat(k[3]));
        const changePct =
          closes.length >= 2 ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100 : 0;
        const priceBias = changePct > 1 ? "BULLISH" : changePct < -1 ? "BEARISH" : "SIDEWAYS";
        const swingHigh = highs.length ? Math.max(...highs) : 0;
        const swingLow = lows.length ? Math.min(...lows) : 0;
        const lastClose = closes[closes.length - 1] ?? 0;

        const text = [
          `# Analisis Ringkas — ${symbol}`,
          ``,
          `## Funding & Basis`,
          `- Funding Rate: ${fmtPct(fundingRate, 4)} (${fundingBias})`,
          `- Basis (mark vs index): ${fmtPct(basis, 4)}`,
          ``,
          `## Open Interest (6 jam terakhir)`,
          `- Tren: ${oiTrend} (${oiChangePct >= 0 ? "+" : ""}${oiChangePct.toFixed(2)}%)`,
          `- OI Terkini: ${fmtNum(oiValues[oiValues.length - 1] ?? 0, 2)}`,
          ``,
          `## Top Trader Positioning (4 jam terakhir, by size posisi)`,
          `- Long Terkini: ${topTraderLatest.toFixed(2)}%`,
          `- Tren: ${topTraderTrend}`,
          ``,
          `## Taker Volume (4 jam terakhir)`,
          `- Rasio Buy/Sell Terkini: ${fmtNum(takerLatest, 4)} → ${takerBias}`,
          ``,
          `## Order Book (depth 20)`,
          `- Best Bid: ${bestBid !== null ? fmtPrice(bestBid) : "N/A"} | Best Ask: ${bestAsk !== null ? fmtPrice(bestAsk) : "N/A"}`,
          `- Spread: ${spreadPct !== null ? spreadPct.toFixed(4) : "N/A"}%`,
          ``,
          `## Price Action (24 candle @1h)`,
          `- Bias: ${priceBias} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`,
          `- Swing High: ${fmtPrice(swingHigh)} | Swing Low: ${fmtPrice(swingLow)}`,
          `- Harga Terakhir: ${fmtPrice(lastClose)}`,
          ``,
          `_Snapshot ringkas dari 6 tool sekaligus (funding, OI history, top trader ratio, taker volume, order book, klines). ` +
            `Untuk histori lebih panjang atau detail lebih dalam per sudut, panggil tool individual yang relevan._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            fundingRate,
            basis,
            fundingBias,
            oiTrend,
            oiChangePct,
            topTraderLatest,
            topTraderTrend,
            takerLatest,
            takerBias,
            bestBid,
            bestAsk,
            spreadPct,
            priceBias,
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

  // ─────────────────────────────────────────────────────────────
  // MULTI-SYMBOL COMPARISON — bandingkan 1 metrik across beberapa pair
  // sekaligus (Promise.all per symbol), diurutkan dari yang paling ekstrem.
  // Beda dari binance_scan_funding_extremes yang scan SEMUA pair di market
  // untuk funding rate doang -- ini untuk pair yang SUDAH kamu tentukan,
  // dan bisa pilih metrik apa yang mau dibandingkan.
  // ─────────────────────────────────────────────────────────────
  const COMPARE_METRIC_ENUM = [
    "funding_rate",
    "price_change_24h",
    "open_interest",
    "top_trader_ratio",
    "taker_volume_ratio",
  ] as const;

  server.registerTool(
    "binance_compare_symbols",
    {
      title: "Bandingkan Beberapa Pair (Multi-Symbol)",
      description:
        "Bandingkan 1 metrik across beberapa pair Futures sekaligus (2-10 symbol), diurutkan dari yang paling " +
        "ekstrem. Metrik yang bisa dipilih: funding_rate (funding terkini), price_change_24h (%perubahan 24 jam), " +
        "open_interest (OI snapshot mentah, BUKAN notional USD -- jangan bandingkan langsung antar pair beda harga " +
        "tanpa konteks), top_trader_ratio (long% top trader terkini, by size posisi), taker_volume_ratio (rasio " +
        "buy/sell taker terkini). Beda dari binance_scan_funding_extremes yang scan SEMUA pair di market -- ini " +
        "untuk pair yang sudah kamu tentukan sendiri.",
      inputSchema: {
        symbols: z
          .array(symbolSchema)
          .min(2)
          .max(10)
          .describe("Daftar symbol yang mau dibandingkan, minimal 2 maksimal 10, contoh: [\"BTCUSDT\", \"ETHUSDT\", \"SOLUSDT\"]"),
        metric: z
          .enum(COMPARE_METRIC_ENUM)
          .describe(
            "Metrik yang dibandingkan: funding_rate, price_change_24h, open_interest, top_trader_ratio, atau taker_volume_ratio",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbols, metric }) => {
      try {
        const uniqueSymbols = Array.from(new Set(symbols));

        const fetchValue = async (symbol: string): Promise<{ symbol: string; value: number; extra?: string }> => {
          switch (metric) {
            case "funding_rate": {
              const data = await binanceProxy.getCurrentFundingRateNative(symbol);
              return { symbol, value: parseFloat(data.lastFundingRate) };
            }
            case "price_change_24h": {
              const data = await binanceProxy.getTicker24hrNative(symbol);
              return { symbol, value: parseFloat(data.priceChangePercent) };
            }
            case "open_interest": {
              const data = await binanceProxy.getOpenInterestNative(symbol);
              return { symbol, value: parseFloat(data.openInterest) };
            }
            case "top_trader_ratio": {
              const data = await binanceProxy.getTopTraderPositionRatio(symbol, "1h", 1);
              const latest = data[data.length - 1];
              return { symbol, value: latest ? parseFloat(latest.longAccount) * 100 : 0 };
            }
            case "taker_volume_ratio": {
              const data = await binanceProxy.getTakerLongShortRatioNative(symbol, "1h", 1);
              const latest = data[data.length - 1];
              return { symbol, value: latest ? parseFloat(latest.buySellRatio) : 0 };
            }
          }
        };

        const results = await Promise.all(uniqueSymbols.map(fetchValue));
        const sorted = [...results].sort((a, b) => b.value - a.value);

        const metricLabel: Record<(typeof COMPARE_METRIC_ENUM)[number], string> = {
          funding_rate: "Funding Rate",
          price_change_24h: "Perubahan 24 Jam",
          open_interest: "Open Interest (mentah)",
          top_trader_ratio: "Top Trader Long %",
          taker_volume_ratio: "Taker Buy/Sell Ratio",
        };
        const formatValue = (v: number): string => {
          if (metric === "funding_rate") return fmtPct(v, 4);
          if (metric === "price_change_24h") return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
          if (metric === "top_trader_ratio") return `${v.toFixed(2)}%`;
          return fmtNum(v, 4);
        };

        const rows = sorted
          .map((r, i) => `| ${i + 1} | ${r.symbol} | ${formatValue(r.value)} |`)
          .join("\n");

        const text = [
          `# Perbandingan ${metricLabel[metric]} — ${uniqueSymbols.length} pair`,
          ``,
          `| # | Symbol | ${metricLabel[metric]} |`,
          `|---|---|---|`,
          rows,
          ``,
          `_Diurutkan dari nilai tertinggi ke terendah. Data snapshot terkini per pair (bukan histori). ` +
            (metric === "open_interest"
              ? "PENTING: open_interest di sini angka mentah (jumlah kontrak), BUKAN notional USD -- pair beda harga tidak apple-to-apple dibandingkan langsung tanpa dikonversi."
              : "") +
            `_`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { metric, results: sorted },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
