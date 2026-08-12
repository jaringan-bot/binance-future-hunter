// whalescope_compare_funding_across_exchanges — bandingkan funding rate +
// last price satu pair across Binance, Bybit, OKX, Hyperliquid dalam SATU
// tool call. Beda dari semua tool binance_* lain (yang emang Binance-only
// by design) -- ini satu-satunya tool cross-exchange di repo ini.
//
// KENAPA CUMA funding rate + last price (bukan OI/24h change juga): field
// itu paling standar & paling gampang dibandingkan apple-to-apple antar 4
// exchange, dan itu yang paling ngedrive use-case utama (deteksi arbitrase
// funding + cross-confirm sinyal binance_detect_mm_activity). OI/24h change
// field-nya gak seragam (OKX butuh endpoint terpisah lagi), sengaja
// ditunda -- follow-up gampang kalau versi funding-only ini kepake.
//
// KENAPA GAK BUTUH PROXY (beda dari Binance): sudah dites langsung dari
// edge Cloudflare (wrangler dev --remote, 2026-08-12) -- Bybit, OKX,
// Hyperliquid semua 200 OK, gak ada WAF/geo-block kayak Binance.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { getBybitFundingRate } from "../bybitClient.js";
import { getOkxFundingRate } from "../okxClient.js";
import { getHyperliquidFundingRate } from "../hyperliquidClient.js";
import { toExchangeSymbol } from "../symbolMap.js";
import { symbolSchema, errorResult } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtPct, fmtPrice } from "../format.js";

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

export function registerCrossExchangeTools(server: McpServer): void {
  registerSafeTool(
    server,
    "whalescope_compare_funding_across_exchanges",
    {
      title: "Bandingkan Funding Rate Antar Exchange (Binance/Bybit/OKX/Hyperliquid)",
      description:
        "Bandingkan funding rate + last price satu pair across Binance, Bybit, OKX, dan Hyperliquid dalam SATU " +
        "tool call -- deteksi divergensi funding (indikasi arbitrase atau sentimen beda antar platform) dan " +
        "cross-confirm sinyal binance_detect_mm_activity (sinyal kuat di Binance doang vs muncul di semua " +
        "exchange = confidence beda). Symbol pakai format Binance (BTCUSDT), otomatis di-mapping ke format " +
        "masing-masing exchange -- kalau pair gak listed di exchange tertentu (umum buat altcoin kecil), baris " +
        "itu ditandai gagal/gak tersedia TANPA gagalin exchange lain. HANYA funding rate + last price (bukan " +
        "OI/24h change -- field itu gak seragam antar exchange, di luar scope tool ini).",
      inputSchema: { symbol: symbolSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const bybitSymbol = toExchangeSymbol(symbol, "bybit");
        const okxSymbol = toExchangeSymbol(symbol, "okx");
        const hlSymbol = toExchangeSymbol(symbol, "hyperliquid");

        const [binanceRes, bybitRes, okxRes, hlRes] = await Promise.allSettled([
          binanceProxy
            .getCurrentFundingRateNative(symbol)
            .then((f) => ({ fundingRate: parseFloat(f.lastFundingRate), lastPrice: parseFloat(f.markPrice) })),
          bybitSymbol
            ? getBybitFundingRate(bybitSymbol)
            : Promise.reject(new Error("Gagal di-mapping ke format symbol Bybit.")),
          okxSymbol
            ? getOkxFundingRate(okxSymbol)
            : Promise.reject(new Error("Symbol tidak berakhiran USDT -- gak bisa di-mapping ke format OKX.")),
          hlSymbol
            ? getHyperliquidFundingRate(hlSymbol)
            : Promise.reject(new Error("Symbol tidak berakhiran USDT -- gak bisa di-mapping ke format Hyperliquid.")),
        ]);

        const rows: { exchange: string; result: PromiseSettledResult<{ fundingRate: number; lastPrice: number }> }[] = [
          { exchange: "Binance", result: binanceRes },
          { exchange: "Bybit", result: bybitRes },
          { exchange: "OKX", result: okxRes },
          { exchange: "Hyperliquid", result: hlRes },
        ];

        const successEntries: FundingRateEntry[] = [];
        const tableRows: string[][] = [];

        for (const { exchange, result } of rows) {
          if (result.status === "fulfilled") {
            successEntries.push({ exchange, fundingRate: result.value.fundingRate });
            tableRows.push([exchange, fmtPct(result.value.fundingRate, 4), fmtPrice(result.value.lastPrice), "ok"]);
          } else {
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
            tableRows.push([exchange, "-", "-", `gagal: ${message}`]);
          }
        }

        const divergence = computeFundingDivergence(successEntries);

        const builder = new ToolResponseBuilder()
          .header(`Funding Rate Cross-Exchange — ${symbol}`)
          .table(["Exchange", "Funding Rate", "Last Price", "Status"], tableRows);

        if (successEntries.length >= 2 && divergence.highest && divergence.lowest) {
          builder
            .subheader("Divergensi")
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
            "Cuma funding rate + last price (bukan OI/24h change). Bybit/OKX/Hyperliquid diakses LANGSUNG tanpa proxy (sudah dites gak kena WAF/geo-block); Binance tetap lewat proxy Vercel seperti tool lain.",
          )
          .struct("symbol", symbol)
          .struct("results", successEntries)
          .struct("divergence", divergence);

        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
