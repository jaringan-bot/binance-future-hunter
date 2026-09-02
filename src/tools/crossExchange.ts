// whalescope_compare_funding_across_exchanges — bandingkan funding rate,
// last price, open interest, dan 24h change satu pair across Binance,
// Bybit, OKX, Hyperliquid dalam SATU tool call. Beda dari semua tool
// binance_* lain (yang emang Binance-only by design) -- ini satu-satunya
// tool cross-exchange di repo ini.
//
// KENAPA GAK BUTUH PROXY buat 3 exchange lain (beda dari Binance): sudah
// dites langsung dari edge Cloudflare (wrangler dev --remote, 2026-08-12)
// -- Bybit, OKX, Hyperliquid semua 200 OK, gak ada WAF/geo-block kayak
// Binance.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { getBybitMarketData } from "../bybitClient.js";
import { getOkxMarketData } from "../okxClient.js";
import { getHyperliquidMarketData } from "../hyperliquidClient.js";
import type { CrossExchangeMarketData } from "../bybitClient.js";
import { toExchangeSymbol } from "../symbolMap.js";
import { symbolSchema, errorResult } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtPct, fmtPrice, fmtNum } from "../format.js";

export interface FundingRateEntry {
  exchange: string;
  fundingRate: number;
}

export interface DivergenceResult {
  maxDivergence: number;
  highest: FundingRateEntry | null;
  lowest: FundingRateEntry | null;
}

// Fungsi murni, testable tanpa mock network -- ambil range funding rate
// terlebar antar exchange yang berhasil di-fetch (yang gagal/gak
// ke-mapping gak ikut dihitung).
export function computeFundingDivergence(entries: FundingRateEntry[]): DivergenceResult {
  if (entries.length === 0) return { maxDivergence: 0, highest: null, lowest: null };
  if (entries.length === 1) return { maxDivergence: 0, highest: entries[0], lowest: entries[0] };

  const sorted = [...entries].sort((a, b) => a.fundingRate - b.fundingRate);
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  return { maxDivergence: highest.fundingRate - lowest.fundingRate, highest, lowest };
}

// Exported buat di-reuse LANGSUNG (bukan panggil MCP tool) oleh
// binance_analyze_institutional_flow (src/tools/institutionalFlow.ts) --
// pola sama seperti fullPipeline.ts reuse fungsi murni tool lain.
export async function getBinanceMarketData(symbol: string): Promise<CrossExchangeMarketData> {
  const [funding, oi, ticker24hr] = await Promise.all([
    binanceProxy.getCurrentFundingRateNative(symbol),
    binanceProxy.getOpenInterestNative(symbol),
    binanceProxy.getTicker24hrNative(symbol),
  ]);
  return {
    fundingRate: parseFloat(funding.lastFundingRate),
    lastPrice: parseFloat(funding.markPrice),
    openInterest: parseFloat(oi.openInterest),
    change24hPct: parseFloat(ticker24hr.priceChangePercent) / 100,
  };
}

export function registerCrossExchangeTools(server: McpServer): void {
  registerSafeTool(
    server,
    "whalescope_compare_funding_across_exchanges",
    {
      title: "Bandingkan Funding Rate Antar Exchange (Binance/Bybit/OKX/Hyperliquid)",
      description:
        "Bandingkan funding rate, last price, OI, 24h change 1 pair across Binance/Bybit/OKX/Hyperliquid -- deteksi " +
        "divergensi funding, lihat di mana leverage menumpuk. Symbol format Binance (BTCUSDT), auto-mapped. Pair " +
        "yang gak listed di exchange tertentu ditandai gagal TANPA gagalin exchange lain.",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const bybitSymbol = toExchangeSymbol(symbol, "bybit");
        const okxSymbol = toExchangeSymbol(symbol, "okx");
        const hlSymbol = toExchangeSymbol(symbol, "hyperliquid");

        const [binanceRes, bybitRes, okxRes, hlRes] = await Promise.allSettled([
          getBinanceMarketData(symbol),
          bybitSymbol
            ? getBybitMarketData(bybitSymbol)
            : Promise.reject(new Error("Gagal di-mapping ke format symbol Bybit.")),
          okxSymbol
            ? getOkxMarketData(okxSymbol)
            : Promise.reject(new Error("Symbol tidak berakhiran USDT -- gak bisa di-mapping ke format OKX.")),
          hlSymbol
            ? getHyperliquidMarketData(hlSymbol)
            : Promise.reject(new Error("Symbol tidak berakhiran USDT -- gak bisa di-mapping ke format Hyperliquid.")),
        ]);

        const rows: { exchange: string; result: PromiseSettledResult<CrossExchangeMarketData> }[] = [
          { exchange: "Binance", result: binanceRes },
          { exchange: "Bybit", result: bybitRes },
          { exchange: "OKX", result: okxRes },
          { exchange: "Hyperliquid", result: hlRes },
        ];

        const successEntries: FundingRateEntry[] = [];
        const tableRows: string[][] = [];
        const structuredResults: (CrossExchangeMarketData & { exchange: string })[] = [];

        for (const { exchange, result } of rows) {
          if (result.status === "fulfilled") {
            const data = result.value;
            successEntries.push({ exchange, fundingRate: data.fundingRate });
            structuredResults.push({ exchange, ...data });
            tableRows.push([
              exchange,
              fmtPct(data.fundingRate, 4),
              fmtPrice(data.lastPrice),
              fmtNum(data.openInterest, 2),
              `${data.change24hPct >= 0 ? "+" : ""}${(data.change24hPct * 100).toFixed(2)}%`,
              "ok",
            ]);
          } else {
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
            tableRows.push([exchange, "-", "-", "-", "-", `gagal: ${message}`]);
          }
        }

        const divergence = computeFundingDivergence(successEntries);

        const builder = new ToolResponseBuilder()
          .header(`Cross-Exchange — ${symbol}`)
          .table(["Exchange", "Funding Rate", "Last Price", "Open Interest", "24h Change", "Status"], tableRows);

        if (successEntries.length >= 2 && divergence.highest && divergence.lowest) {
          builder
            .subheader("Divergensi Funding")
            .row(
              "Range",
              `${fmtPct(divergence.lowest.fundingRate, 4)} (${divergence.lowest.exchange}) s/d ${fmtPct(divergence.highest.fundingRate, 4)} (${divergence.highest.exchange})`,
            )
            .row("Selisih", fmtPct(divergence.maxDivergence, 4));
        } else {
          builder.note("Kurang dari 2 exchange berhasil di-fetch -- gak bisa hitung divergensi.");
        }

        builder
          .note(
            "Open Interest dalam base-asset (BTC dst, bukan notional USD) di keempat exchange -- SEHARUSNYA apple-to-apple, tapi belum divalidasi silang ke data live (OKX pakai field oiCcy, bukan oi/kontrak, biar sepadan sama 3 exchange lain -- cek ulang kalau angkanya kelihatan janggal). Bybit/OKX/Hyperliquid diakses LANGSUNG tanpa proxy (sudah dites gak kena WAF/geo-block); Binance tetap lewat proxy Vercel seperti tool lain.",
          )
          .struct("symbol", symbol)
          .struct("results", structuredResults)
          .struct("divergence", divergence);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
