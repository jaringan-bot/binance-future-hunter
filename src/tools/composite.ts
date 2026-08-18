import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtPrice, fmtPct, fmtTime, trendDirection } from "../format.js";
import { symbolSchema, errorResult } from "../shared.js";
import { summarizeKlines } from "../toolHelpers.js";

// Dipakai binance_compare_symbols di bawah -- didefinisikan module-level
// (bukan di dalam function) karena dirujuk di beberapa tempat dalam tool
// yang sama (schema enum + Record type buat label).
const COMPARE_METRIC_ENUM = [
  "funding_rate",
  "price_change_24h",
  "open_interest",
  "top_trader_ratio",
  "taker_volume_ratio",
] as const;

export function registerCompositeTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // COMPOSITE ANALYSIS — 1 tool call yang internally manggil 6 tool
  // sekaligus lewat Promise.all (funding, OI trend, top trader trend,
  // taker volume trend, order book, klines/bias), kembalikan summary
  // terstruktur. Mengurangi jumlah tool call buat overview cepat, tapi
  // TETAP bukan pengganti tool individual kalau butuh detail/histori
  // lebih panjang -- ini snapshot ringkas per masing-masing sudut.
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
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
        const {
          changePct,
          bias: priceBias,
          swingHigh,
          swingLow,
          lastClose,
        } = summarizeKlines(klines);

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


  registerSafeTool(
    server,
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


  // ─────────────────────────────────────────────────────────────
  // COMPOSITE INDEX INFO
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_composite_index_info",
    {
      title: "Composite Index Symbol Information",
      description:
        "Mengambil komposisi base asset (beserta bobot kuantitas/persentase) sebuah COMPOSITE INDEX symbol " +
        "(mis. DEFIUSDT — index multi-aset, bukan pair single-asset biasa). " +
        "PENTING: cuma relevan untuk symbol composite index — kebanyakan pair biasa (BTCUSDT, ETHUSDT, dst) TIDAK " +
        "punya data ini dan akan balik kosong/error karena bukan composite index.",
      inputSchema: {
        symbol: symbolSchema.optional().describe("Symbol composite index tertentu -- opsional, kosongkan untuk semua composite index."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getCompositeIndexInfoNative(symbol);
        if (data.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada data composite index untuk ${symbol ?? "(semua symbol)"}.` }] };
        }
        const blocks = data.map((idx) => {
          const rows = idx.baseAssetList
            .map((a) => `| ${a.baseAsset} | ${a.quoteAsset} | ${a.weightInQuantity} | ${fmtPct(a.weightInPercentage)} |`)
            .join("\n");
          return [
            `## ${idx.symbol}`,
            `| Base Asset | Quote Asset | Weight (Quantity) | Weight (%) |`,
            `|---|---|---|---|`,
            rows,
          ].join("\n");
        });
        const text = [`# Composite Index Info${symbol ? ` — ${symbol}` : ""}`, ``, blocks.join("\n\n")].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { indices: data },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );


  // ─────────────────────────────────────────────────────────────
  // INDEX PRICE CONSTITUENTS
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_index_constituents",
    {
      title: "Index Price Constituents",
      description:
        "Mengambil daftar exchange spot + harga + bobot yang menyusun INDEX PRICE sebuah pair (dasar perhitungan " +
        "index price yang dipakai binance_get_index_price_klines/premium index/funding rate). " +
        "Berlaku untuk pair biasa (mis. BTCUSDT, ETHUSDT — index price-nya blended dari beberapa exchange spot " +
        "seperti Binance/OKX/Coinbase/dst), BUKAN cuma untuk composite index symbol. " +
        "Kalau harga di satu exchange menyimpang jauh dari yang lain, itu bisa jadi indikasi anomali data di " +
        "exchange tersebut (bukan berarti index price Binance salah).",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getIndexConstituentsNative(symbol);
        const rows = data.constituents
          .map((c) => `| ${c.exchange} | ${c.symbol} | ${fmtPrice(c.price)} | ${fmtPct(c.weight)} |`)
          .join("\n");
        const text = [
          `# Index Price Constituents — ${data.symbol}`,
          ``,
          `Waktu: ${fmtTime(data.time)}`,
          ``,
          `| Exchange | Symbol | Harga | Bobot |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_Bandingkan harga antar exchange untuk deteksi anomali data di satu sumber. Gunakan bersama ` +
            `binance_get_index_price_klines untuk melihat pergerakan index price hasil blend ini dalam bentuk candle._`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol: data.symbol, time: data.time, constituents: data.constituents },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
