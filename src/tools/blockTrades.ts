// filter_block_trades -- pure calculation, TIDAK fetch dari Binance sendiri.
// trades diinjeksi caller (mis. hasil binance_get_agg_trades sebelumnya).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolSchema, aggTradeSchema, errorResultWithCode } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { truncateRows } from "../toolHelpers.js";
import type { AggTrade } from "../binanceProxyClient.js";

const USD_QUOTE_SUFFIXES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "USDP"] as const;

// Naive suffix check -- sama pola yang SUDAH dipakai repo ini (symbolMap.ts,
// tools/funding.ts quoteFilter) untuk pair non-*USDT, bukan pola baru. Tool
// ini "pure calculation" (gak fetch exchangeInfo sendiri), jadi gak ada cara
// lain buat tau quote asset asli selain dari nama symbol.
export function isUsdQuotedSymbol(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  return USD_QUOTE_SUFFIXES.some((q) => upper.endsWith(q));
}

export interface BlockTradesResult {
  matched: AggTrade[];
  buyVolume: number;
  sellVolume: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
  totalMatchedCount: number;
  totalInputCount: number;
  errorCode?: "EMPTY_TRADES";
}

const EMPTY_RESULT: Omit<BlockTradesResult, "errorCode" | "totalInputCount"> = {
  matched: [],
  buyVolume: 0,
  sellVolume: 0,
  buyNotionalUsd: 0,
  sellNotionalUsd: 0,
  totalMatchedCount: 0,
};

// m: true = buyer maker -> seller taker (sell). m: false = buyer taker (buy).
// Konvensi sama persis dengan computeCvdFromTrades (toolHelpers.ts).
export function filterBlockTrades(trades: AggTrade[], minNotionalUsd: number, quoteUsdRate: number): BlockTradesResult {
  if (trades.length === 0) {
    return { ...EMPTY_RESULT, totalInputCount: 0, errorCode: "EMPTY_TRADES" };
  }

  const matched: AggTrade[] = [];
  let buyVolume = 0;
  let sellVolume = 0;
  let buyNotionalUsd = 0;
  let sellNotionalUsd = 0;

  for (const t of trades) {
    const price = parseFloat(t.p);
    const qty = parseFloat(t.q);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
    const notionalUsd = price * qty * quoteUsdRate;
    if (notionalUsd <= minNotionalUsd) continue;

    matched.push(t);
    if (t.m) {
      sellVolume += qty;
      sellNotionalUsd += notionalUsd;
    } else {
      buyVolume += qty;
      buyNotionalUsd += notionalUsd;
    }
  }

  return {
    matched,
    buyVolume,
    sellVolume,
    buyNotionalUsd,
    sellNotionalUsd,
    totalMatchedCount: matched.length,
    totalInputCount: trades.length,
  };
}

export function registerBlockTradesTools(server: McpServer): void {
  registerSafeTool(
    server,
    "filter_block_trades",
    {
      title: "Filter Block Trade / Large Taker",
      description:
        "Filter agg-trades (diinjeksi caller, BUKAN fetch sendiri -- pass hasil binance_get_agg_trades) berdasarkan " +
        "notional USD (price*qty*quoteUsdRate) di atas ambang, agregat buy/sell via field m. Reject kalau symbol " +
        "sepertinya bukan pair quote USD DAN quoteUsdRate masih default 1.0.",
      inputSchema: {
        symbol: symbolSchema,
        trades: z.array(aggTradeSchema).max(5000).describe("Agg-trades (binance_get_agg_trades)."),
        minNotionalUsd: z.number().positive().default(100_000).describe("Ambang notional USD minimum, default $100k."),
        quoteUsdRate: z
          .number()
          .positive()
          .default(1.0)
          .describe(
            "Kurs quote-asset ke USD. Default 1.0 (asumsi quote asset SUDAH USD-family: USDT/USDC/BUSD/FDUSD/TUSD/USDP). " +
              "WAJIB diisi manual untuk pair non-USD (mis. ETHBTC), kalau tidak tool ini reject.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ symbol, trades, minNotionalUsd, quoteUsdRate }) => {
      if (quoteUsdRate === 1.0 && !isUsdQuotedSymbol(symbol)) {
        return errorResultWithCode(
          "NON_USD_QUOTE_PAIR_REQUIRES_CONVERSION_RATE",
          `Symbol ${symbol} sepertinya bukan pair quote USD (USDT/USDC/BUSD/FDUSD/TUSD/USDP) dan quoteUsdRate masih default 1.0 -- ` +
            `notional USD yang dihitung bakal salah. Isi quoteUsdRate manual (mis. harga base-asset quote dalam USD).`,
          { symbol, quoteUsdRate },
        );
      }

      const result = filterBlockTrades(trades, minNotionalUsd, quoteUsdRate);

      if (result.errorCode) {
        return errorResultWithCode(result.errorCode, `Array trades kosong untuk ${symbol}.`, { symbol });
      }

      const rows = truncateRows(result.matched, 15).shown.map((t) => [
        String(t.T),
        t.m ? "SELL" : "BUY",
        t.p,
        t.q,
        (parseFloat(t.p) * parseFloat(t.q) * quoteUsdRate).toFixed(2),
      ]);

      const builder = new ToolResponseBuilder()
        .header(`Block Trades — ${symbol}`)
        .row("Matched / Total", `${result.totalMatchedCount} / ${result.totalInputCount}`)
        .row("Buy Volume (matched)", result.buyVolume.toFixed(4))
        .row("Sell Volume (matched)", result.sellVolume.toFixed(4))
        .row("Buy Notional (USD)", result.buyNotionalUsd.toFixed(2))
        .row("Sell Notional (USD)", result.sellNotionalUsd.toFixed(2));

      if (rows.length > 0) {
        builder.table(["Waktu (T)", "Sisi", "Harga", "Qty", "Notional USD"], rows);
      }

      builder
        .struct("symbol", symbol)
        .struct("totalMatchedCount", result.totalMatchedCount)
        .struct("totalInputCount", result.totalInputCount)
        .struct("buyVolume", result.buyVolume)
        .struct("sellVolume", result.sellVolume)
        .struct("buyNotionalUsd", result.buyNotionalUsd)
        .struct("sellNotionalUsd", result.sellNotionalUsd);

      return builder.build();
    },
  );
}
