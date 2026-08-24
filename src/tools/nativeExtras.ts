import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";
import * as binanceProxy from "../binanceProxyClient.js";
import { fmtNum, fmtPrice, fmtTime } from "../format.js";
import { symbolSchema, errorResult, detailParam } from "../shared.js";
import { truncateRows } from "../toolHelpers.js";

export function registerNativeExtrasTools(server: McpServer): void {

  // ─────────────────────────────────────────────────────────────
  // 1. EXCHANGE INFO
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_exchange_info",
    {
      title: "Exchange Information (Trading Rules)",
      description:
        "Full exchange info Binance Futures: status pair, filters (PRICE_FILTER, LOT_SIZE, MIN_NOTIONAL, dll), " +
        "precision, contractType. Kalau `symbol` dikirim, hanya return 1 pair. Berguna cek tick size, min qty, " +
        "status trading sebelum buka grid/order.",
      inputSchema: {
        symbol: symbolSchema.optional().describe("Opsional. Kalau diisi, filter hanya 1 symbol."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        // /fapi/v1/exchangeInfo mengabaikan query param `symbol` (beda dari
        // spot) -- Binance selalu balikin SEMUA pair, harus difilter di sini.
        const data = await binanceProxy.getFuturesExchangeInfo(symbol as string);
        const allSymbols = data.symbols ?? [];
        const symbols = symbol
          ? allSymbols.filter((s: any) => s.symbol === (symbol as string).toUpperCase())
          : allSymbols;

        if (symbols.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: symbol
                  ? `Symbol ${symbol} tidak ditemukan di exchangeInfo.`
                  : "Tidak ada data exchangeInfo.",
              },
            ],
          };
        }

        const rows = symbols
          .slice(0, 20)
          .map((s: any) => {
            const lot = s.filters?.find((f: any) => f.filterType === "LOT_SIZE");
            const price = s.filters?.find((f: any) => f.filterType === "PRICE_FILTER");
            const minNotional = s.filters?.find((f: any) => f.filterType === "MIN_NOTIONAL");
            return `| ${s.symbol} | ${s.status} | ${s.contractType ?? "-"} | ${price?.tickSize ?? "-"} | ${lot?.minQty ?? "-"} | ${minNotional?.notional ?? "-"} |`;
          })
          .join("\n");

        const text = [
          `# Exchange Info${symbol ? ` — ${symbol}` : ` (${symbols.length} symbols)`}`,
          ``,
          `| Symbol | Status | Contract | Tick Size | Min Qty | Min Notional |`,
          `|---|---|---|---|---|---|`,
          rows,
          symbols.length > 20
            ? `\n_Menampilkan 20 pertama dari ${symbols.length}. Gunakan symbol spesifik untuk detail penuh._`
            : ``,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            count: symbols.length,
            symbols: symbol ? symbols : symbols.slice(0, 50),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // 2. RECENT TRADES (individual, bukan aggregate)
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_recent_trades",
    {
      title: "Recent Trades (Individual)",
      description:
        "Trade individual terbaru (GET /fapi/v1/trades) — BEDA dari binance_get_agg_trades yang sudah di-aggregate. " +
        "Lebih granular untuk analisis micro-structure. Default summary (CVD + 15 trade terakhir).",
      inputSchema: {
        symbol: symbolSchema,
        limit: z.number().int().min(1).max(1000).default(50).describe("Jumlah trade terakhir (max 1000)"),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit, detail }) => {
      try {
        const trades = await binanceProxy.getRecentTrades(symbol, limit);
        if (!trades || trades.length === 0) {
          return { content: [{ type: "text", text: `Tidak ada recent trades untuk ${symbol}.` }] };
        }

        let buyVol = 0;
        let sellVol = 0;
        for (const t of trades) {
          const qty = parseFloat(t.qty);
          if (t.isBuyerMaker) sellVol += qty;
          else buyVol += qty;
        }
        const cvd = buyVol - sellVol;
        const buyPct = (buyVol / (buyVol + sellVol || 1)) * 100;

        const recent = trades.slice(-15);
        const rows = recent
          .map((t) => {
            const side = t.isBuyerMaker ? "SELL (taker)" : "BUY (taker)";
            return `| ${fmtTime(t.time)} | ${fmtPrice(parseFloat(t.price))} | ${fmtNum(parseFloat(t.qty), 4)} | ${side} |`;
          })
          .join("\n");

        const text = [
          `# Recent Trades — ${symbol} (${trades.length} trade)`,
          ``,
          `**CVD**: ${cvd >= 0 ? "+" : ""}${fmtNum(cvd, 4)} | Buy ${fmtNum(buyVol, 4)} / Sell ${fmtNum(sellVol, 4)} (${buyPct.toFixed(1)}% BUY)`,
          ``,
          `## ${recent.length} Trade Terakhir`,
          `| Waktu | Harga | Qty | Sisi |`,
          `|---|---|---|---|`,
          rows,
          ``,
          `_Beda dari binance_get_agg_trades: ini trade individual mentah, bukan compressed._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            cvd,
            buyVol,
            sellVol,
            buyPct,
            ...(detail === "full" ? { trades } : {}),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // 3. BOOK TICKER
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_book_ticker",
    {
      title: "Book Ticker (Best Bid/Ask)",
      description:
        "Best bid/ask price + quantity saja (GET /fapi/v1/ticker/bookTicker). Sangat ringan dibanding full depth. " +
        "Kalau symbol kosong, return semua pair (hati-hati payload besar).",
      inputSchema: {
        symbol: symbolSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getBookTicker(symbol);
        const list = Array.isArray(data) ? data : [data];

        if (list.length === 0) {
          return { content: [{ type: "text", text: "Tidak ada data bookTicker." }] };
        }

        const rows = list
          .slice(0, 30)
          .map(
            (t) =>
              `| ${t.symbol} | ${fmtPrice(parseFloat(t.bidPrice))} | ${fmtNum(parseFloat(t.bidQty), 4)} | ${fmtPrice(parseFloat(t.askPrice))} | ${fmtNum(parseFloat(t.askQty), 4)} |`,
          )
          .join("\n");

        const text = [
          `# Book Ticker${symbol ? ` — ${symbol}` : ` (${list.length} pairs)`}`,
          ``,
          `| Symbol | Bid Price | Bid Qty | Ask Price | Ask Qty |`,
          `|---|---|---|---|---|`,
          rows,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { count: list.length, tickers: list.slice(0, 50) },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // 4. PRICE TICKER
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_price_ticker",
    {
      title: "Price Ticker (Latest Price)",
      description:
        "Harga terakhir saja (GET /fapi/v2/ticker/price). Ringan. Symbol opsional (kalau kosong return banyak pair).",
      inputSchema: {
        symbol: symbolSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getPriceTicker(symbol);
        const list = Array.isArray(data) ? data : [data];

        const rows = list
          .slice(0, 40)
          .map((t) => `| ${t.symbol} | ${fmtPrice(parseFloat(t.price))} |`)
          .join("\n");

        const text = [
          `# Price Ticker${symbol ? ` — ${symbol}` : ` (${list.length} pairs)`}`,
          ``,
          `| Symbol | Price |`,
          `|---|---|`,
          rows,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { count: list.length, prices: list.slice(0, 100) },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // 5. FUNDING INFO
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_funding_info",
    {
      title: "Funding Info (Interval + Cap/Floor)",
      description:
        "Info struktur funding per symbol: funding interval, adjusted funding rate cap/floor, interest rate. " +
        "Berguna tahu seberapa sering funding settle dan batasan rate-nya.",
      inputSchema: {
        symbol: symbolSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        // /fapi/v1/fundingInfo tidak menerima param `symbol` -- selalu balikin
        // SEMUA pair yang punya cap/floor funding custom (bukan semua pair
        // exist). Filter di sini; kalau simbol yang diminta gak ada di daftar,
        // artinya dia pakai default funding rate Binance (bukan error).
        const data = await binanceProxy.getFundingInfo(symbol);
        const allEntries = Array.isArray(data) ? data : [data];
        const list = symbol
          ? allEntries.filter((f) => f.symbol === (symbol as string).toUpperCase())
          : allEntries;

        if (symbol && list.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `${symbol} tidak punya cap/floor funding custom -- pakai default Binance (interval 8h, cap/floor standar).`,
              },
            ],
          };
        }

        const rows = list
          .slice(0, 30)
          .map(
            (f) =>
              `| ${f.symbol} | ${f.fundingIntervalHours ?? "-"}h | ${f.adjustedFundingRateCap ?? "-"} | ${f.adjustedFundingRateFloor ?? "-"} | ${f.interestRate ?? "-"} |`,
          )
          .join("\n");

        const text = [
          `# Funding Info${symbol ? ` — ${symbol}` : ""}`,
          ``,
          `| Symbol | Interval | Cap | Floor | Interest Rate |`,
          `|---|---|---|---|---|`,
          rows,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { count: list.length, fundingInfo: list.slice(0, 50) },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // 6. RPI DEPTH
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_rpi_depth",
    {
      title: "RPI Order Book Depth",
      description:
        "Order book yang TERMASUK Retail Price Improvement (RPI) orders (GET /fapi/v1/rpiDepth). " +
        "Beda dari binance_get_order_book_depth yang mengecualikan RPI. Default summary (top 10 + wall).",
      inputSchema: {
        symbol: symbolSchema,
        limit: z.number().int().default(20).describe("Jumlah level per sisi"),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit, detail }) => {
      try {
        const data = await binanceProxy.getRpiDepth(symbol, limit);

        const bestBid = data.bids?.[0] ? parseFloat(data.bids[0][0]) : null;
        const bestAsk = data.asks?.[0] ? parseFloat(data.asks[0][0]) : null;
        const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

        const bidRows = (data.bids || [])
          .slice(0, 10)
          .map(([p, q]) => `| ${fmtPrice(parseFloat(p))} | ${fmtNum(parseFloat(q), 4)} |`)
          .join("\n");
        const askRows = (data.asks || [])
          .slice(0, 10)
          .map(([p, q]) => `| ${fmtPrice(parseFloat(p))} | ${fmtNum(parseFloat(q), 4)} |`)
          .join("\n");

        const text = [
          `# RPI Order Book — ${symbol}`,
          ``,
          `**Best Bid**: ${bestBid !== null ? fmtPrice(bestBid) : "N/A"} | **Best Ask**: ${bestAsk !== null ? fmtPrice(bestAsk) : "N/A"}`,
          `**Spread**: ${spread !== null ? fmtPrice(spread) : "N/A"}`,
          ``,
          `## Top 10 Bids`,
          `| Harga | Qty |`,
          `|---|---|`,
          bidRows,
          ``,
          `## Top 10 Asks`,
          `| Harga | Qty |`,
          `|---|---|`,
          askRows,
          ``,
          `_Termasuk RPI orders. Bandingkan dengan binance_get_order_book_depth (tanpa RPI)._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            symbol,
            bestBid,
            bestAsk,
            spread,
            ...(detail === "full" ? { bids: data.bids, asks: data.asks } : {}),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // 7. TRADING SCHEDULE
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_trading_schedule",
    {
      title: "Trading Schedule (TradFi Sessions)",
      description:
        "Jadwal sesi trading untuk underlying assets (US, Korea, Hong Kong, China, commodities). " +
        "Sangat relevan untuk TradFi perpetual.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await binanceProxy.getTradingSchedule();
        const list = Array.isArray(data) ? data : [data];

        const rows = list
          .slice(0, 40)
          .map((s: any) => {
            const key = s.symbol ?? s.underlying ?? "-";
            const tz = s.timezone ?? "-";
            const sessions = s.sessions ? JSON.stringify(s.sessions).slice(0, 80) : "-";
            return `| ${key} | ${tz} | ${sessions} |`;
          })
          .join("\n");

        const text = [
          `# Trading Schedule`,
          ``,
          `| Symbol/Underlying | Timezone | Sessions |`,
          `|---|---|---|`,
          rows,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { count: list.length, schedules: list.slice(0, 50) },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // 8. ALL FORCE ORDERS (Liquidations)
  // ─────────────────────────────────────────────────────────────
  registerSafeTool(
    server,
    "binance_get_all_force_orders",
    {
      title: "All Force Orders (Liquidations)",
      description:
        "Histori liquidation / force orders market-wide (GET /fapi/v1/allForceOrders). " +
        "Catatan: endpoint ini sering dibatasi Binance. Handle error dengan baik. " +
        "Bukan pengganti data liquidation-by-price (yang WAF-blocked).",
      inputSchema: {
        symbol: symbolSchema.optional(),
        limit: z.number().int().min(1).max(1000).default(50),
        startTime: z.string().optional().describe("ISO 8601"),
        endTime: z.string().optional().describe("ISO 8601"),
        detail: detailParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, limit, startTime, endTime, detail }) => {
      try {
        const startMs = startTime ? Date.parse(startTime) : undefined;
        const endMs = endTime ? Date.parse(endTime) : undefined;

        const data = await binanceProxy.getAllForceOrders({
          symbol,
          limit,
          startTime: startMs && !Number.isNaN(startMs) ? startMs : undefined,
          endTime: endMs && !Number.isNaN(endMs) ? endMs : undefined,
        });

        const list = Array.isArray(data) ? data : [];
        if (list.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Tidak ada force orders${symbol ? ` untuk ${symbol}` : ""}.`,
              },
            ],
          };
        }

        const { shown, totalCount, truncated } = truncateRows(list, 15);
        const rows = shown
          .map(
            (o: any) =>
              `| ${fmtTime(o.time)} | ${o.symbol} | ${o.side} | ${fmtPrice(parseFloat(o.price))} | ${fmtNum(parseFloat(o.origQty), 4)} | ${o.status} |`,
          )
          .join("\n");

        const text = [
          `# Force Orders / Liquidations${symbol ? ` — ${symbol}` : ""}`,
          ``,
          truncated ? `_Menampilkan ${shown.length} dari ${totalCount}._` : ``,
          `| Waktu | Symbol | Side | Price | Qty | Status |`,
          `|---|---|---|---|---|---|`,
          rows,
          ``,
          `_Data market-wide liquidation. Sering dibatasi Binance._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            count: list.length,
            ...(detail === "full" ? { orders: list } : { recent: shown }),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
