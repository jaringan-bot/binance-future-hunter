import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtPrice, fmtPct, fmtTime, trendDirection } from "../format.js";
import { symbolSchema, PERIOD_ENUM, errorResult } from "../shared.js";
import { getPairThreshold } from "./config.js";
import { truncateRows } from "../toolHelpers.js";

export function registerFundingTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // FUNDING RATE (Binance native via premiumIndex — funding TERKINI,
  // belum settled, plus mark price & waktu funding berikutnya)
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_funding_rate",
    {
      title: "Ambil Funding Rate Terkini",
      description:
        "Mengambil funding rate TERKINI untuk sebuah pair Binance Futures (native premiumIndex, source of truth — " +
        "bukan Coinalyze), plus basis (deviasi mark vs index price) buat baca sentimen premium/discount futures vs spot. " +
        "Interpretasi kontrarian: funding positif besar = long crowded (waspada long squeeze); negatif besar = short " +
        "crowded (waspada short squeeze). Basis positif besar = futures premium (sentimen long agresif, funding " +
        "biasanya menyusul naik); negatif besar = discount (sentimen short agresif); basis netral tapi funding ekstrem " +
        "= funding lagging, potensi mean-revert. " +
        "PERHATIAN: index price Binance rata-rata tertimbang beberapa exchange spot — noisy untuk pair kecil/baru " +
        "listing (salah satu sumber bisa illikuid), interpretasikan hati-hati. " +
        "Threshold crowded default ±0.03% funding / ±0.05% basis bisa dioverride per-pair lewat " +
        "binance_set_pair_threshold (Workers KV) -- berguna untuk altcoin volatil yang 'normal range'-nya beda jauh " +
        "dari BTC/ETH.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const [data, customThreshold] = await Promise.all([
          binanceProxy.getCurrentFundingRateNative(symbol),
          getPairThreshold(symbol),
        ]);
        const rate = parseFloat(data.lastFundingRate);
        const markPrice = parseFloat(data.markPrice);
        const indexPrice = parseFloat(data.indexPrice);
        // Basis = deviasi mark price dari index price. Ini SATU-SATUNYA angka
        // divergensi mark-vs-index yang kita tampilkan — sengaja tidak dihitung
        // dua kali dengan nama berbeda karena keduanya angka yang sama persis.
        const basis = (markPrice - indexPrice) / indexPrice;

        // Default ±0.03% funding, ±0.05% basis -- bisa dioverride per-pair
        // lewat binance_set_pair_threshold (disimpan di Workers KV).
        const FUNDING_THRESHOLD = customThreshold?.fundingThreshold ?? 0.0003;
        const BASIS_THRESHOLD = customThreshold?.basisThreshold ?? 0.0005;
        const usingCustomThreshold = customThreshold?.fundingThreshold !== undefined || customThreshold?.basisThreshold !== undefined;

        const interpretation =
          rate >= FUNDING_THRESHOLD
            ? "CROWDED LONG (funding cukup tinggi — mayoritas leverage di sisi long, ada risiko long squeeze jika harga berbalik turun)"
            : rate <= -FUNDING_THRESHOLD
              ? "CROWDED SHORT (funding negatif signifikan — mayoritas leverage di sisi short, ada risiko short squeeze jika harga berbalik naik)"
              : "NETRAL (funding dalam rentang wajar, tidak ada crowding ekstrem yang jelas)";

        const basisInterpretation =
          basis >= BASIS_THRESHOLD
            ? "PREMIUM TINGGI (mark price jauh di atas index — sentimen long agresif di futures, funding rate biasanya menyusul naik)"
            : basis <= -BASIS_THRESHOLD
              ? "DISCOUNT TINGGI (mark price jauh di bawah index — sentimen short agresif di futures, funding rate biasanya menyusul turun)"
              : Math.abs(rate) >= FUNDING_THRESHOLD
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
          `_Threshold dipakai: funding ±${fmtPct(FUNDING_THRESHOLD, 4)}, basis ±${fmtPct(BASIS_THRESHOLD, 4)}${usingCustomThreshold ? " (CUSTOM, di-set lewat binance_set_pair_threshold)" : " (default global)"}. Index price Binance adalah rata-rata tertimbang dari beberapa exchange spot — untuk pair kecil/baru listing, salah satu exchange sumber bisa illikuid dan membuat index price sendiri jadi noisy. Data LANGSUNG dari Binance native (premiumIndex)._`,
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
            fundingThreshold: FUNDING_THRESHOLD,
            basisThreshold: BASIS_THRESHOLD,
            usingCustomThreshold,
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
        const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
        const direction = trendDirection(rates);

        const { shown, totalCount, truncated } = truncateRows(points);
        const rows = shown
          .map((p) => `| ${fmtTime(p.fundingTime)} | ${fmtPct(parseFloat(p.fundingRate), 4)} |`)
          .join("\n");

        const text = [
          `# Histori Funding Rate — ${symbol} (${points.length} data terakhir)`,
          ``,
          truncated ? `_Menampilkan ${shown.length} terakhir dari ${totalCount} total (rata-rata & tren di bawah dihitung dari semua ${totalCount})._` : ``,
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
}
