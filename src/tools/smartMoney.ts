import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { symbolSchema, errorResult } from "../shared.js";
import { summarizeKlines } from "../toolHelpers.js";
import { analyzeSmartMoneyDivergence } from "../smartMoneyAnalysis.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtNum, fmtPct } from "../format.js";

export function registerSmartMoneyTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // SMART MONEY VS RETAIL DIVERGENCE (COMPOSITE) -- 5 tool call sekaligus
  // lewat Promise.all (top trader ratio, global account ratio, OI history,
  // funding, order book), kombinasikan jadi 1 skor divergensi terstruktur.
  // Lihat src/smartMoneyAnalysis.ts untuk formula & docs/mm_detection_
  // framework.md Section 4.2 untuk batasan kalibrasi threshold top-trader
  // ratio, dan Section 12 untuk cara tool ini beda dari
  // binance_detect_mm_activity (Section 11 -- 6 sinyal absorption/spoofing/
  // stop-hunt/basis-arb/OI-divergence/funding-extreme, BUKAN top-trader vs
  // retail divergence).
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_analyze_smart_money",
    {
      title: "Smart Money vs Retail Divergence (Composite)",
      description:
        "Skor divergensi positioning 'smart money' (top trader, by size posisi) vs 'retail' (global account, " +
        "blended) untuk satu pair Futures, dari kombinasi 5 variabel: top trader position ratio, global account " +
        "ratio, delta OI 4 jam terakhir, funding rate terkini, dan orderbook depth imbalance (depth 20) -- 5 tool " +
        "call sekaligus lewat Promise.all. BUKAN deteksi 'MM memanipulasi harga' (MM murni delta-neutral/hedged, " +
        "rasio long/short sendiri bukan bukti manipulasi) -- ini mengukur DIVERGENSI arah antara akun besar vs akun " +
        "retail. Beda dari binance_detect_mm_activity (6 sinyal absorption/spoofing/stop-hunt/basis-arb terpisah) -- " +
        "tool ini fokus khusus top-trader-vs-retail positioning. Mengembalikan salah satu dari 4 kondisi: " +
        "LONG_LIQUIDATION_RISK (retail trap -- retail dominan long, top trader short/netral, OI naik), " +
        "BULLISH_ACCUMULATION (top trader dominan long, retail dominan short, OI naik), SHORT_SQUEEZE_RISK " +
        "(funding rate negatif ekstrem + top trader tetap long + harga belum naik), atau NEUTRAL. Plus " +
        "smartMoneyBias, retailSentiment, confidenceScore (0-100, dari margin di atas threshold + sinyal " +
        "pendukung searah, BUKAN probabilitas statistik terkalibrasi -- lihat docs/mm_detection_framework.md " +
        "Section 4.2 untuk kenapa threshold absolut pada top-trader ratio harus dipakai hati-hati). Cross-check " +
        "dengan tool individual (binance_get_top_trader_ratio, binance_get_long_short_ratio) untuk histori/detail " +
        "lebih dalam.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const [topTrader, globalRatio, oiHist, funding, orderBook, klines] = await Promise.all([
          binanceProxy.getTopTraderPositionRatio(symbol, "1h", 1),
          binanceProxy.getGlobalAccountRatio(symbol, "1h", 1),
          binanceProxy.getOpenInterestHistNative(symbol, "1h", 24),
          binanceProxy.getCurrentFundingRateNative(symbol),
          binanceProxy.getOrderBookDepth(symbol, 20),
          binanceProxy.getKlinesNative(symbol, "1h", 24),
        ]);

        const topTraderLatest = topTrader[topTrader.length - 1];
        const globalLatest = globalRatio[globalRatio.length - 1];
        if (!topTraderLatest || !globalLatest) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Data top trader / global account ratio tidak tersedia untuk ${symbol}. Pastikan symbol adalah pair perpetual USDT-margined yang aktif.`,
              },
            ],
          };
        }

        const topTraderPositionRatio = parseFloat(topTraderLatest.longShortRatio);
        const globalAccountRatio = parseFloat(globalLatest.longShortRatio);

        const oiValues = oiHist.map((p) => parseFloat(p.sumOpenInterest));
        const oiDelta4hPct =
          oiValues.length >= 5 && oiValues[oiValues.length - 5] !== 0
            ? ((oiValues[oiValues.length - 1] - oiValues[oiValues.length - 5]) / oiValues[oiValues.length - 5]) * 100
            : 0;
        const oiDelta24hPct =
          oiValues.length >= 2 && oiValues[0] !== 0
            ? ((oiValues[oiValues.length - 1] - oiValues[0]) / oiValues[0]) * 100
            : 0;

        const fundingRate = parseFloat(funding.lastFundingRate);

        const bidVol20 = orderBook.bids.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
        const askVol20 = orderBook.asks.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
        const totalVol20 = bidVol20 + askVol20;
        const orderBookImbalancePct = totalVol20 > 0 ? (bidVol20 / totalVol20) * 100 : 50;

        const { bias: priceBias, changePct } = summarizeKlines(klines);

        const result = analyzeSmartMoneyDivergence({
          topTraderPositionRatio,
          globalAccountRatio,
          oiDeltaPct: oiDelta4hPct,
          fundingRate,
          orderBookImbalancePct,
          priceBias,
        });

        const builder = new ToolResponseBuilder()
          .header(`Smart Money vs Retail Divergence — ${symbol}`)
          .row("Kondisi", result.condition)
          .row("Smart Money Bias", result.smartMoneyBias)
          .row("Retail Sentiment", result.retailSentiment)
          .row("Confidence Score", `${result.confidenceScore}%`)
          .row("Divergence Score", `${result.divergenceScore >= 0 ? "+" : ""}${result.divergenceScore}`)
          .subheader("5 Variabel Mentah")
          .table(
            ["Variabel", "Nilai"],
            [
              ["Top Trader Position Ratio", fmtNum(topTraderPositionRatio, 4)],
              ["Global Account Ratio", fmtNum(globalAccountRatio, 4)],
              ["OI Delta (4 jam)", `${oiDelta4hPct >= 0 ? "+" : ""}${oiDelta4hPct.toFixed(2)}%`],
              ["OI Delta (24 jam, konteks tambahan)", `${oiDelta24hPct >= 0 ? "+" : ""}${oiDelta24hPct.toFixed(2)}%`],
              ["Funding Rate", fmtPct(fundingRate, 4)],
              ["Orderbook Imbalance (depth 20, % bid)", `${orderBookImbalancePct.toFixed(2)}%`],
              ["Price Bias (24 candle @1h)", `${priceBias} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`],
            ],
          )
          .subheader("Analisis")
          .interpretation("Divergensi", result.divergenceAnalysis)
          .note(
            "confidenceScore dihitung dari margin di atas threshold operasional + 2 sinyal pendukung searah " +
              "(funding, orderbook) -- BUKAN probabilitas statistik terkalibrasi. Threshold sengaja fixed/eksplisit " +
              "sesuai spesifikasi, bukan hasil kalibrasi historis per-pair -- untuk validasi lebih dalam (terutama " +
              "top-trader ratio yang secara empiris pergerakannya kecil per pair likuid), cross-check " +
              "docs/mm_detection_framework.md Section 4.2 dan tool binance_get_top_trader_ratio / " +
              "binance_get_long_short_ratio untuk histori.",
          )
          .struct("symbol", symbol)
          .struct("condition", result.condition)
          .struct("smartMoneyBias", result.smartMoneyBias)
          .struct("retailSentiment", result.retailSentiment)
          .struct("confidenceScore", result.confidenceScore)
          .struct("divergenceScore", result.divergenceScore)
          .struct("divergenceAnalysis", result.divergenceAnalysis)
          .struct("signals", {
            topTraderPositionRatio,
            globalAccountRatio,
            oiDelta4hPct,
            oiDelta24hPct,
            fundingRate,
            orderBookImbalancePct,
            priceBias,
            priceChangePct: changePct,
          });

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
