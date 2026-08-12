// binance_get_tool_catalog — daftar statis semua tool + kategori/use-case,
// biar Claude bisa pilih tool lebih tepat tanpa harus baca description
// panjang satu-satu tiap kali (whalescope_mcp_roadmap.md Bagian 6.3).
// Daftar ini di-maintain MANUAL -- kalau nambah/hapus tool di file lain,
// update juga di sini (tidak ada mekanisme auto-generate dari registerTool
// calls, di luar scope upgrade ini).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool } from "../toolWrapper.js";

const CATEGORY_ENUM = [
  "funding",
  "oi",
  "ratios",
  "orderbook",
  "trades",
  "liquidation",
  "technical",
  "spot",
  "composite",
  "config",
  "history",
  "backtest",
  "cross-exchange",
  "meta",
] as const;
type Category = (typeof CATEGORY_ENUM)[number];

interface CatalogEntry {
  name: string;
  category: Category;
  tokenCost: "low" | "medium" | "high";
  useCase: string;
  dependencies: string[];
}

const CATALOG: CatalogEntry[] = [
  { name: "binance_get_funding_rate", category: "funding", tokenCost: "low", useCase: "Cek funding rate & basis terkini satu pair", dependencies: [] },
  { name: "binance_get_funding_rate_history", category: "funding", tokenCost: "medium", useCase: "Histori funding rate untuk deteksi pola berulang", dependencies: [] },
  { name: "binance_scan_funding_extremes", category: "funding", tokenCost: "medium", useCase: "Scan SEMUA pair sekaligus cari funding paling ekstrem", dependencies: [] },
  { name: "binance_get_open_interest", category: "oi", tokenCost: "low", useCase: "Snapshot OI terkini satu pair", dependencies: [] },
  { name: "binance_get_open_interest_history", category: "oi", tokenCost: "medium", useCase: "Tren OI untuk deteksi posisi baru dibuka/ditutup", dependencies: [] },
  { name: "binance_get_long_short_ratio", category: "ratios", tokenCost: "medium", useCase: "Rasio long/short blended (top trader + global account)", dependencies: [] },
  { name: "binance_get_top_trader_ratio", category: "ratios", tokenCost: "medium", useCase: "Rasio long/short KHUSUS akun top trader (bukan blended)", dependencies: [] },
  { name: "binance_get_order_book_depth", category: "orderbook", tokenCost: "medium", useCase: "Snapshot bid/ask depth mentah", dependencies: [] },
  { name: "binance_get_order_book_imbalance", category: "orderbook", tokenCost: "low", useCase: "Rasio bid/ask imbalance terkini (sudah diringkas)", dependencies: [] },
  { name: "binance_get_agg_trades", category: "trades", tokenCost: "medium", useCase: "CVD granular per-trade dari aggregate trades", dependencies: [] },
  { name: "binance_get_taker_volume_ratio", category: "trades", tokenCost: "medium", useCase: "Rasio taker buy/sell volume resmi Binance", dependencies: [] },
  { name: "binance_get_liquidation_history", category: "liquidation", tokenCost: "medium", useCase: "Total long/short liquidated per window waktu (via Coinalyze, TANPA harga)", dependencies: [] },
  { name: "binance_get_klines", category: "technical", tokenCost: "medium", useCase: "Candle OHLCV + bias harga otomatis", dependencies: [] },
  { name: "binance_get_multi_timeframe_bias", category: "technical", tokenCost: "medium", useCase: "Bias harga across beberapa timeframe sekaligus", dependencies: [] },
  { name: "binance_get_realized_volatility", category: "technical", tokenCost: "low", useCase: "Volatilitas realized dari log-return close-to-close", dependencies: [] },
  { name: "binance_get_24hr_ticker", category: "technical", tokenCost: "low", useCase: "Statistik 24 jam resmi Binance (rolling window)", dependencies: [] },
  { name: "binance_get_spot_price", category: "spot", tokenCost: "low", useCase: "Harga spot + basis riil vs mark price futures", dependencies: [] },
  { name: "binance_get_spot_ticker_24hr", category: "spot", tokenCost: "low", useCase: "Statistik 24 jam spot (VWAP, open, count trade)", dependencies: [] },
  { name: "binance_get_spot_book_ticker", category: "spot", tokenCost: "low", useCase: "Best bid/ask spot sesaat (lebih ringan dari full depth)", dependencies: [] },
  { name: "binance_get_spot_order_book", category: "spot", tokenCost: "medium", useCase: "Snapshot depth spot, bandingkan likuiditas vs futures", dependencies: [] },
  { name: "binance_get_spot_klines", category: "spot", tokenCost: "medium", useCase: "Candle spot, bandingkan volatilitas vs futures", dependencies: [] },
  { name: "binance_get_spot_agg_trades", category: "spot", tokenCost: "medium", useCase: "CVD spot riil (bukan leverage-driven)", dependencies: [] },
  { name: "binance_get_spot_avg_price", category: "spot", tokenCost: "low", useCase: "Harga rata-rata bergerak window 5 menit", dependencies: [] },
  { name: "binance_check_spot_listing", category: "spot", tokenCost: "low", useCase: "Cek apakah pair beneran listed di Binance Spot", dependencies: [] },
  { name: "binance_analyze_pair", category: "composite", tokenCost: "high", useCase: "Overview cepat 1 pair dari 6 sudut sekaligus (raw data)", dependencies: ["funding", "oi", "ratios", "trades", "orderbook", "technical"] },
  { name: "binance_compare_symbols", category: "composite", tokenCost: "medium", useCase: "Bandingkan 1 metrik across 2-10 pair sekaligus", dependencies: ["funding", "technical", "ratios", "trades"] },
  { name: "binance_detect_mm_activity", category: "composite", tokenCost: "high", useCase: "Skor + tier aktivitas MM/whale dari 6 sinyal (gantikan 5-6 tool call manual)", dependencies: ["orderbook", "trades", "oi", "funding", "technical", "spot"] },
  { name: "binance_market_regime", category: "composite", tokenCost: "medium", useCase: "Klasifikasi TRENDING/RANGING/BREAKOUT/ACCUMULATION/DISTRIBUTION", dependencies: ["technical", "oi", "trades"] },
  { name: "binance_set_pair_threshold", category: "config", tokenCost: "low", useCase: "Set threshold funding/basis custom per pair", dependencies: [] },
  { name: "binance_get_pair_threshold", category: "config", tokenCost: "low", useCase: "Cek threshold custom yang sudah di-set", dependencies: [] },
  { name: "binance_get_basis_history", category: "history", tokenCost: "medium", useCase: "Histori basis+funding+OI dari snapshot cron 5 menit ke D1 (watchlist tetap 10 pair saja)", dependencies: [] },
  { name: "binance_backtest_signal", category: "backtest", tokenCost: "high", useCase: "Validasi empiris sinyal MM detection: win rate/avg return/max drawdown dari histori sinyal D1 + forward return on-demand", dependencies: ["history", "technical"] },
  { name: "whalescope_compare_funding_across_exchanges", category: "cross-exchange", tokenCost: "medium", useCase: "Bandingkan funding rate + last price 1 pair across Binance/Bybit/OKX/Hyperliquid, deteksi divergensi", dependencies: ["funding"] },
  { name: "binance_get_tool_catalog", category: "meta", tokenCost: "low", useCase: "Daftar semua tool + kategori/use-case (tool ini sendiri)", dependencies: [] },
];

export function registerCatalogTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_get_tool_catalog",
    {
      title: "Tool Catalog & Usage Guide",
      description:
        "Daftar semua tool WhaleScope MCP dengan kategori, estimasi token cost, use-case, dan dependency-nya. " +
        "Berguna sebelum manggil banyak tool individual -- cek dulu kategori/use-case yang relevan biar gak salah " +
        "pilih tool atau kelewat tool composite yang bisa gantikan beberapa tool sekaligus.",
      inputSchema: {
        category: z
          .enum(["all", ...CATEGORY_ENUM])
          .optional()
          .describe(`Filter kategori: ${CATEGORY_ENUM.join(", ")}, atau "all" (default) untuk semua.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ category }) => {
      const filtered = category && category !== "all" ? CATALOG.filter((t) => t.category === category) : CATALOG;

      const rows = filtered
        .map((t) => `| ${t.name} | ${t.category} | ${t.tokenCost} | ${t.useCase} |`)
        .join("\n");

      const text = [
        `# Tool Catalog${category && category !== "all" ? ` — kategori: ${category}` : ""} (${filtered.length} tool)`,
        ``,
        `| Tool | Kategori | Token Cost | Use Case |`,
        `|---|---|---|---|`,
        rows,
        ``,
        `_Kategori tersedia: ${CATEGORY_ENUM.join(", ")}. Tool composite (analyze_pair, compare_symbols, ` +
          `detect_mm_activity, market_regime) internally manggil beberapa tool lain -- prioritaskan tool composite ` +
          `kalau pertanyaannya butuh gambaran umum, baru turun ke tool individual kalau butuh detail spesifik._`,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: { total: filtered.length, tools: filtered },
      };
    },
  );
}
