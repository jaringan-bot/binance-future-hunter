// binance_analyze_institutional_flow -- tool composite baru yang menggabungkan
// SEMPAT beberapa sinyal "institusional" yang sebelumnya cuma tabel deskriptif
// terpisah (whalescope_compare_funding_across_exchanges,
// whalescope_compare_orderbook_depth, hyperliquid_get_whale_wallet_positions,
// cme_get_institutional_positioning_trend) jadi SATU skor alignment.
//
// Pola "Pure Engine + Thin Wrapper" sama seperti fullPipeline.ts:
// computeInstitutionalFlowScore() (src/institutionalFlow.ts) murni, tool ini
// cuma fetch 4 sumber data secara paralel (Promise.allSettled, satu gagal
// TIDAK menggagalkan yang lain) lalu panggil fungsi murni + fungsi murni tool
// lain LANGSUNG (import, bukan MCP roundtrip) -- classifyRegime-style reuse.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { errorResult, symbolSchema } from "../shared.js";
import { toExchangeSymbol } from "../symbolMap.js";
import { getBinanceMarketData, computeFundingDivergence, type FundingRateEntry } from "./crossExchange.js";
import { getBybitMarketData } from "../bybitClient.js";
import { getOkxMarketData } from "../okxClient.js";
import { getHyperliquidMarketData } from "../hyperliquidClient.js";
import { fetchCrossVenueWalls } from "./crossVenueDepth.js";
import { queryHyperliquidWhaleRecentByCoin } from "../d1Client.js";
import { computeWhaleDeltas, aggregateWhaleDeltas } from "./hyperliquidWhale.js";
import { queryCftcPositioningHistory } from "../d1Client.js";
import { computeCftcTrend, CFTC_CONTRACT_NAME } from "../cftcClient.js";
import { getOptionsSummary, computeOptionsPositioning } from "../deribitClient.js";
import { computeInstitutionalFlowScore, type InstitutionalFlowScore } from "../institutionalFlow.js";

const CFTC_TREND_WEEKS = 8;

async function fetchFundingDivergence(symbol: string) {
  const bybitSymbol = toExchangeSymbol(symbol, "bybit");
  const okxSymbol = toExchangeSymbol(symbol, "okx");
  const hlSymbol = toExchangeSymbol(symbol, "hyperliquid");

  const results = await Promise.allSettled([
    getBinanceMarketData(symbol),
    bybitSymbol ? getBybitMarketData(bybitSymbol) : Promise.reject(new Error("no bybit mapping")),
    okxSymbol ? getOkxMarketData(okxSymbol) : Promise.reject(new Error("no okx mapping")),
    hlSymbol ? getHyperliquidMarketData(hlSymbol) : Promise.reject(new Error("no hyperliquid mapping")),
  ]);
  const exchanges = ["Binance", "Bybit", "OKX", "Hyperliquid"];
  const entries: FundingRateEntry[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") entries.push({ exchange: exchanges[i], fundingRate: r.value.fundingRate });
  });
  return computeFundingDivergence(entries);
}

export function registerInstitutionalFlowTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_analyze_institutional_flow",
    {
      title: "Skor Alignment Institutional Flow (Whale + CFTC + Cross-Venue + Options)",
      description:
        "Gabungkan sampai 4 sinyal institusional jadi 1 skor alignment: posisi whale on-chain Hyperliquid, trend CFTC COT " +
        "(Leveraged Funds, BTC/ETH saja), wall order book yang corroborated lintas >=2 exchange, dan put/call OI Deribit " +
        "(BTC/ETH) -- ke arah LONG atau SHORT, plus flag kalau funding rate antar-exchange lagi gak sepakat (confidence " +
        "gabungan diragukan). PENTING: bukan skor tunggal weighted-average -- tiap komponen bisa 'tidak tersedia' " +
        "(watchlist Hyperliquid kosong, coin bukan BTC/ETH buat CFTC/options, dst), alignmentScore cuma dihitung dari " +
        "komponen yang TERSEDIA (componentsAvailable). Heuristik, BUKAN probabilitas terkalibrasi -- sama seperti " +
        "binance_detect_mm_activity.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const hlCoin = toExchangeSymbol(symbol, "hyperliquid"); // base asset, mis. "BTC", null kalau gak bisa di-derive
        const cftcCoin = hlCoin && hlCoin in CFTC_CONTRACT_NAME ? (hlCoin as keyof typeof CFTC_CONTRACT_NAME) : null;

        const [fundingDivergenceRes, crossVenueRes, whaleRes, cftcRes, optionsRes] = await Promise.allSettled([
          fetchFundingDivergence(symbol),
          fetchCrossVenueWalls(symbol),
          hlCoin ? queryHyperliquidWhaleRecentByCoin(hlCoin) : Promise.resolve(null),
          cftcCoin ? queryCftcPositioningHistory(cftcCoin, CFTC_TREND_WEEKS) : Promise.resolve(null),
          cftcCoin
            ? getOptionsSummary(cftcCoin).then((rows) => computeOptionsPositioning(rows, cftcCoin))
            : Promise.resolve(null),
        ]);

        const fundingDivergence = fundingDivergenceRes.status === "fulfilled" ? fundingDivergenceRes.value : null;
        const crossVenueWalls = crossVenueRes.status === "fulfilled" ? crossVenueRes.value.walls : null;
        const whaleRows = whaleRes.status === "fulfilled" ? whaleRes.value : null;
        const cftcHistory = cftcRes.status === "fulfilled" ? cftcRes.value : null;
        const deribitOptions = optionsRes.status === "fulfilled" ? optionsRes.value : null;

        const hyperliquidWhale = whaleRows ? aggregateWhaleDeltas(hlCoin ?? "", computeWhaleDeltas(whaleRows)) : null;
        const cftcTrend = cftcHistory
          ? computeCftcTrend(
              cftcHistory.map((h) => ({ reportDate: h.reportDate, openInterest: h.openInterest, levNetPct: h.levNetPct, amNetPct: h.amNetPct })),
            )
          : null;

        const score: InstitutionalFlowScore = computeInstitutionalFlowScore({
          fundingDivergence,
          crossVenueWalls,
          hyperliquidWhale,
          cftcTrend,
          deribitOptions,
        });

        const builder = new ToolResponseBuilder()
          .header(`Institutional Flow -- ${symbol}`)
          .row("Net Direction", score.netDirection)
          .row("Alignment Score", `${score.alignmentScore.toFixed(1)}/100`)
          .row("Komponen Tersedia", `${score.componentsAvailable}/4`);

        builder.subheader("Detail Komponen").table(
          ["Komponen", "Tersedia?", "Arah", "Strength", "Catatan"],
          score.components.map((c) => [
            c.name,
            c.available ? "ya" : "tidak",
            c.direction,
            c.strength.toFixed(2),
            c.unavailableReason ?? "-",
          ]),
        );

        if (score.fundingDivergenceFlag && score.fundingDivergenceNote) {
          builder.note(score.fundingDivergenceNote);
        }
        builder.note(
          "alignmentScore dihitung HANYA dari komponen yang tersedia (componentsAvailable), bukan diasumsikan 0 kalau " +
            "kosong -- kalau componentsAvailable=0, netDirection selalu NEUTRAL dan alignmentScore=0 (tidak ada data buat vote).",
        );

        builder.struct("symbol", symbol).struct("score", score);
        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
