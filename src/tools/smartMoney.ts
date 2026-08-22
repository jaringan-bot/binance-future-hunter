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
        "Skor divergensi 'smart money' (top trader) vs 'retail' (global account) dari 5 variabel (top trader ratio, " +
        "global account ratio, OI delta 4h, funding, orderbook imbalance depth 20). BUKAN deteksi manipulasi harga -- " +
        "mengukur DIVERGENSI arah. Kondisi: LONG_LIQUIDATION_RISK, BULLISH_ACCUMULATION, SHORT_SQUEEZE_RISK, atau " +
        "NEUTRAL. confidenceScore (0-100) BUKAN probabilitas terkalibrasi -- lihat docs/mm_detection_framework.md " +
        "Section 4.2 untuk batasan threshold top-trader ratio.",
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
          .header(`${symbol} — Smart Money vs Retail`)
          .row("Kondisi", `${result.condition} (confidence ${result.confidenceScore}%, divScore ${result.divergenceScore >= 0 ? "+" : ""}${result.divergenceScore})`)
          .row("Smart Money", result.smartMoneyBias)
          .row("Retail", result.retailSentiment)
          .row(
            "Raw",
            `topTrader ${fmtNum(topTraderPositionRatio, 4)} | global ${fmtNum(globalAccountRatio, 4)} | OI4h ${oiDelta4hPct >= 0 ? "+" : ""}${oiDelta4hPct.toFixed(2)}% | funding ${fmtPct(fundingRate, 4)} | OBI20 ${orderBookImbalancePct.toFixed(1)}% | price ${priceBias} ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`,
          )
          .interpretation("Analisis", result.divergenceAnalysis)
          .note("confidenceScore BUKAN probabilitas terkalibrasi -- docs/mm_detection_framework.md Section 4.2.")
          .struct("symbol", symbol)
          .struct("condition", result.condition)
          .struct("smBias", result.smartMoneyBias)
          .struct("retail", result.retailSentiment)
          .struct("confidence", result.confidenceScore)
          .struct("divScore", result.divergenceScore)
          .struct("reason", result.divergenceAnalysis)
          .struct("raw", {
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
