// binance_get_tool_catalog — daftar semua tool + kategori/use-case, biar
// Claude bisa pilih tool lebih tepat tanpa harus baca description panjang
// satu-satu tiap kali (whalescope_mcp_roadmap.md Bagian 6.3).
//
// SETENGAH auto-generate: nama+description SELALU ditarik dari
// getToolRegistry() (toolWrapper.ts, terisi otomatis tiap registerSafeTool
// dipanggil) -- gak pernah basi/ketinggalan walau lupa update file ini.
// category/tokenCost/dependencies TETAP manual di CATALOG_METADATA (itu
// judgment call editorial, gak ada di data SDK registerTool sama sekali,
// gak bisa di-derive). Tool yang KELUPAAN ditambahin ke CATALOG_METADATA
// TETAP muncul di catalog (nama+description tetap akurat) dengan fallback
// category "uncategorized" + useCase dari description yang di-truncate --
// gak pernah ke-omit diam-diam kayak sebelumnya.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerSafeTool, getToolRegistry } from "../toolWrapper.js";

const CATEGORY_ENUM = [
  "funding",
  "oi",
  "ratios",
  "orderbook",
  "trades",
  "risk",
  "technical",
  "spot",
  "composite",
  "config",
  "history",
  "backtest",
  "cross-exchange",
  "realtime",
  "meta",
  "uncategorized",
] as const;
type Category = (typeof CATEGORY_ENUM)[number];

type TokenCost = "low" | "medium" | "high";

interface CatalogMetadata {
  category: Category;
  tokenCost: TokenCost;
  useCase?: string; // kalau kosong, fallback ke description registry (truncated)
  dependencies: string[];
}

const DEFAULT_TOKEN_COST: TokenCost = "medium";
const FALLBACK_CATEGORY: Category = "uncategorized";
const USE_CASE_TRUNCATE_LENGTH = 100;

const CATALOG_METADATA: Record<string, CatalogMetadata> = {
  binance_get_funding_rate: { category: "funding", tokenCost: "low", useCase: "Cek funding rate & basis terkini satu pair", dependencies: [] },
  binance_get_funding_rate_history: { category: "funding", tokenCost: "medium", useCase: "Histori funding rate untuk deteksi pola berulang", dependencies: [] },
  binance_scan_funding_extremes: { category: "funding", tokenCost: "medium", useCase: "Scan SEMUA pair sekaligus cari funding paling ekstrem", dependencies: [] },
  binance_get_open_interest: { category: "oi", tokenCost: "low", useCase: "Snapshot OI terkini satu pair", dependencies: [] },
  binance_get_open_interest_history: { category: "oi", tokenCost: "medium", useCase: "Tren OI untuk deteksi posisi baru dibuka/ditutup", dependencies: [] },
  binance_get_long_short_ratio: { category: "ratios", tokenCost: "medium", useCase: "Rasio long/short blended (top trader + global account)", dependencies: [] },
  binance_get_top_trader_ratio: { category: "ratios", tokenCost: "medium", useCase: "Rasio long/short KHUSUS akun top trader (bukan blended)", dependencies: [] },
  binance_get_order_book_depth: { category: "orderbook", tokenCost: "medium", useCase: "Snapshot bid/ask depth mentah", dependencies: [] },
  binance_get_order_book_imbalance: { category: "orderbook", tokenCost: "low", useCase: "Rasio bid/ask imbalance terkini (sudah diringkas)", dependencies: [] },
  binance_get_orderbook_delta: { category: "orderbook", tokenCost: "medium", useCase: "Bandingkan 2 snapshot order book ~1-2 detik terpisah untuk deteksi spoofing riil (wall hilang tanpa harga crossing)", dependencies: [] },
  binance_get_agg_trades: { category: "trades", tokenCost: "medium", useCase: "CVD granular per-trade dari aggregate trades", dependencies: [] },
  binance_get_taker_volume_ratio: { category: "trades", tokenCost: "medium", useCase: "Rasio taker buy/sell volume resmi Binance", dependencies: [] },
  binance_get_klines: { category: "technical", tokenCost: "medium", useCase: "Candle OHLCV + bias harga otomatis", dependencies: [] },
  binance_get_multi_timeframe_bias: { category: "technical", tokenCost: "medium", useCase: "Bias harga across beberapa timeframe sekaligus", dependencies: [] },
  binance_get_realized_volatility: { category: "technical", tokenCost: "low", useCase: "Volatilitas realized dari log-return close-to-close", dependencies: [] },
  binance_get_24hr_ticker: { category: "technical", tokenCost: "low", useCase: "Statistik 24 jam resmi Binance (rolling window)", dependencies: [] },
  binance_get_spot_price: { category: "spot", tokenCost: "low", useCase: "Harga spot + basis riil vs mark price futures", dependencies: [] },
  binance_get_spot_ticker_24hr: { category: "spot", tokenCost: "low", useCase: "Statistik 24 jam spot (VWAP, open, count trade)", dependencies: [] },
  binance_get_spot_book_ticker: { category: "spot", tokenCost: "low", useCase: "Best bid/ask spot sesaat (lebih ringan dari full depth)", dependencies: [] },
  binance_get_spot_order_book: { category: "spot", tokenCost: "medium", useCase: "Snapshot depth spot, bandingkan likuiditas vs futures", dependencies: [] },
  binance_get_spot_klines: { category: "spot", tokenCost: "medium", useCase: "Candle spot, bandingkan volatilitas vs futures", dependencies: [] },
  binance_get_spot_agg_trades: { category: "spot", tokenCost: "medium", useCase: "CVD spot riil (bukan leverage-driven)", dependencies: [] },
  binance_get_spot_avg_price: { category: "spot", tokenCost: "low", useCase: "Harga rata-rata bergerak window 5 menit", dependencies: [] },
  binance_get_spot_rolling_ticker: { category: "spot", tokenCost: "low", useCase: "Statistik spot jendela bebas 1m-7d (momentum 1h/4h tanpa derivasi klines)", dependencies: [] },
  binance_check_spot_listing: { category: "spot", tokenCost: "low", useCase: "Cek apakah pair beneran listed di Binance Spot", dependencies: [] },
  binance_analyze_pair: { category: "composite", tokenCost: "high", useCase: "Overview cepat 1 pair dari 6 sudut sekaligus (raw data)", dependencies: ["funding", "oi", "ratios", "trades", "orderbook", "technical"] },
  binance_compare_symbols: { category: "composite", tokenCost: "medium", useCase: "Bandingkan 1 metrik across 2-10 pair sekaligus", dependencies: ["funding", "technical", "ratios", "trades"] },
  binance_detect_mm_activity: { category: "composite", tokenCost: "high", useCase: "Skor + tier aktivitas MM/whale dari 6 sinyal (gantikan 5-6 tool call manual)", dependencies: ["orderbook", "trades", "oi", "funding", "technical", "spot"] },
  binance_market_regime: { category: "composite", tokenCost: "medium", useCase: "Klasifikasi TRENDING/RANGING/BREAKOUT/ACCUMULATION/DISTRIBUTION", dependencies: ["technical", "oi", "trades"] },
  binance_set_pair_threshold: { category: "config", tokenCost: "low", useCase: "Set threshold funding/basis custom per pair", dependencies: [] },
  binance_get_pair_threshold: { category: "config", tokenCost: "low", useCase: "Cek threshold custom yang sudah di-set", dependencies: [] },
  binance_get_basis: { category: "history", tokenCost: "medium", useCase: "Histori basis native index vs futures (GET /futures/data/basis) — semua pair, period 5m–1d", dependencies: [] },
  binance_get_basis_history: { category: "history", tokenCost: "medium", useCase: "Histori basis+funding+OI dari snapshot cron 5 menit ke D1 -- selalu tersedia untuk 50-pair watchlist tetap, best-effort untuk pair lain yang sering di-query", dependencies: [] },
  binance_backtest_signal: { category: "backtest", tokenCost: "high", useCase: "Validasi empiris sinyal MM detection: win rate/avg return/max drawdown dari histori sinyal D1 + forward return on-demand", dependencies: ["history", "technical"] },
  whalescope_backtest_pipeline_decisions: {
    category: "backtest",
    tokenCost: "high",
    useCase: "Uji maju keputusan full pipeline (TRADE/WATCH/NO_TRADE + bucket skor 55) dari D1 + forward return/SL-touch on-demand",
    dependencies: ["history", "technical"],
  },
  whalescope_compare_funding_across_exchanges: { category: "cross-exchange", tokenCost: "medium", useCase: "Bandingkan funding rate, price, OI, 24h change 1 pair across Binance/Bybit/OKX/Hyperliquid, deteksi divergensi", dependencies: ["funding"] },
  binance_get_realtime_liquidations: { category: "realtime", tokenCost: "medium", useCase: "Likuidasi paksa terbaru market-wide dari WS stream (di-buffer di gateway VPS, feed di-sampel Binance)", dependencies: [] },
  binance_get_contract_events: { category: "realtime", tokenCost: "low", useCase: "Event listing/delisting/settlement kontrak futures dari WS !contractInfo (buffer 30 hari)", dependencies: [] },
  binance_get_tool_catalog: { category: "meta", tokenCost: "low", useCase: "Daftar semua tool + kategori/use-case (tool ini sendiri)", dependencies: [] },
  binance_get_adl_risk: { category: "risk", tokenCost: "low", useCase: "Quantile risk rating ADL per pair (update tiap 30 menit)", dependencies: [] },
  binance_get_insurance_fund_balance: { category: "risk", tokenCost: "low", useCase: "Snapshot historis saldo insurance fund per asset margin", dependencies: [] },
  binance_get_mark_price_klines: { category: "technical", tokenCost: "medium", useCase: "Candle mark price (acuan liquidation/funding), bukan harga transaksi", dependencies: [] },
  binance_get_index_price_klines: { category: "technical", tokenCost: "medium", useCase: "Candle index price (blended spot), dasar premium index/funding", dependencies: [] },
  binance_get_premium_index_klines: { category: "technical", tokenCost: "medium", useCase: "Candle premium index (rasio mark vs index price), komponen funding rate", dependencies: [] },
  binance_get_continuous_klines: { category: "technical", tokenCost: "medium", useCase: "Candle kontrak PERPETUAL/CURRENT_QUARTER/NEXT_QUARTER per pair underlying", dependencies: [] },
  binance_get_quarterly_settlement_price: { category: "history", tokenCost: "low", useCase: "Histori delivery/settlement price kontrak quarterly", dependencies: [] },
  binance_get_composite_index_info: { category: "composite", tokenCost: "low", useCase: "Komposisi base asset + bobot sebuah composite index symbol", dependencies: [] },
  binance_get_index_constituents: { category: "composite", tokenCost: "low", useCase: "Daftar exchange+symbol penyusun index price composite index symbol", dependencies: [] },
  whalescope_full_pipeline: {
    category: "composite",
    tokenCost: "high",
    useCase: "Decision chain penuh Grid Bot Futures (hard screen -> Tier-1 intel -> grid bounds -> risk -> keputusan) untuk 1-20 symbol",
    dependencies: ["funding", "oi", "ratios", "orderbook", "trades", "technical", "risk", "composite"],
  },
  // Native extras (2026-08-22)
  binance_get_exchange_info: { category: "config", tokenCost: "medium", useCase: "Trading rules, tick size, min qty, status pair sebelum order/grid", dependencies: [] },
  binance_get_recent_trades: { category: "trades", tokenCost: "medium", useCase: "Trade individual mentah (bukan aggregate) + CVD micro-structure", dependencies: [] },
  binance_get_book_ticker: { category: "orderbook", tokenCost: "low", useCase: "Best bid/ask + qty saja, sangat ringan dibanding full depth", dependencies: [] },
  binance_get_price_ticker: { category: "technical", tokenCost: "low", useCase: "Harga terakhir saja (endpoint ringan)", dependencies: [] },
  binance_get_funding_info: { category: "funding", tokenCost: "low", useCase: "Interval funding + cap/floor + interest rate per symbol", dependencies: [] },
  binance_get_rpi_depth: { category: "orderbook", tokenCost: "medium", useCase: "Order book termasuk RPI orders (beda dari depth biasa)", dependencies: [] },
  binance_get_trading_schedule: { category: "config", tokenCost: "low", useCase: "Jadwal sesi trading TradFi underlying assets", dependencies: [] },
  binance_get_all_force_orders: { category: "risk", tokenCost: "medium", useCase: "Histori force orders / liquidations market-wide", dependencies: [] },
  whalescope_risk_circuit: {
    category: "risk",
    tokenCost: "low",
    useCase: "Baca/set circuit breaker KV (daily-loss + macro pause) untuk entry-alert cron",
    dependencies: [],
  },
  binance_get_orderbook_wall_persistence: {
    category: "orderbook",
    tokenCost: "medium",
    useCase: "Persistensi wall bid/ask dari snapshot cron (spoof vs wall riil)",
    dependencies: ["orderbook"],
  },
  binance_analyze_smart_money: {
    category: "composite",
    tokenCost: "high",
    useCase: "Posisi smart money vs retail (top trader by size, bukan by account)",
    dependencies: ["ratios", "oi", "trades"],
  },
  analyze_futures_grid_risk: {
    category: "risk",
    tokenCost: "high",
    useCase: "Risk math long-grid: status SAFE/MODERATE/HIGH_RISK/REJECT",
    dependencies: ["technical", "oi", "ratios", "risk"],
  },
  hyperliquid_get_whale_wallet_positions: {
    category: "cross-exchange",
    tokenCost: "medium",
    useCase: "Agregat posisi wallet whale Hyperliquid (watchlist) per coin",
    dependencies: [],
  },
  whalescope_compare_orderbook_depth: {
    category: "cross-exchange",
    tokenCost: "medium",
    useCase: "Bandingkan depth/spread 1 pair across venue",
    dependencies: ["orderbook"],
  },
  cme_get_institutional_positioning: {
    category: "history",
    tokenCost: "medium",
    useCase: "CFTC COT positioning institusi (CME)",
    dependencies: [],
  },
  whalescope_get_stablecoin_supply: {
    category: "composite",
    tokenCost: "low",
    useCase: "Supply stablecoin (USDT/USDC) sebagai konteks likuiditas makro",
    dependencies: [],
  },
  estimate_slippage: {
    category: "orderbook",
    tokenCost: "low",
    useCase: "Estimasi slippage dari depth yang dikirim caller",
    dependencies: [],
  },
  analyze_cvd_divergence: {
    category: "trades",
    tokenCost: "medium",
    useCase: "Divergensi CVD vs harga dari array aggTrades caller",
    dependencies: [],
  },
  filter_block_trades: {
    category: "trades",
    tokenCost: "low",
    useCase: "Filter block/large trades dari array aggTrades caller",
    dependencies: [],
  },
  compute_funding_velocity: {
    category: "funding",
    tokenCost: "low",
    useCase: "Kecepatan perubahan funding dari histori yang dikirim caller",
    dependencies: [],
  },
  estimate_stop_loss_liquidity_risk: {
    category: "risk",
    tokenCost: "medium",
    useCase: "Likuiditas di sekitar stop-loss vs depth yang dikirim caller",
    dependencies: ["orderbook"],
  },
  taker_imbalance_aggregator: {
    category: "trades",
    tokenCost: "medium",
    useCase: "Agregat taker buy/sell imbalance dari window aggTrades",
    dependencies: [],
  },
  whalescope_get_oi_velocity: {
    category: "oi",
    tokenCost: "low",
    useCase: "Kecepatan perubahan OI dari histori yang dikirim caller",
    dependencies: [],
  },
  whalescope_detect_liquidity_sweep: {
    category: "composite",
    tokenCost: "high",
    useCase: "Deteksi liquidity sweep (wick vs ATR, CVD, OI, force orders)",
    dependencies: ["technical", "trades", "oi", "risk"],
  },
  whalescope_find_grid_walls: {
    category: "orderbook",
    tokenCost: "medium",
    useCase: "Bound grid di wall bid/ask tebal; GRID_NO_TRADE kalau wall tidak ada",
    dependencies: ["orderbook", "technical"],
  },
};

export { CATALOG_METADATA, FALLBACK_CATEGORY };

function truncateUseCase(description: string | undefined): string {
  if (!description) return "(belum ada description terdaftar)";
  return description.length > USE_CASE_TRUNCATE_LENGTH
    ? `${description.slice(0, USE_CASE_TRUNCATE_LENGTH)}…`
    : description;
}

export function registerCatalogTools(server: McpServer): void {
  registerSafeTool(
    server,
    "binance_get_tool_catalog",
    {
      title: "Tool Catalog & Usage Guide",
      description:
        "Daftar semua tool WhaleScope MCP dengan kategori, estimasi token cost, use-case, dan dependency-nya. " +
        "Berguna sebelum manggil banyak tool individual -- cek dulu kategori/use-case yang relevan biar gak salah " +
        "pilih tool atau kelewat tool composite yang bisa gantikan beberapa tool sekaligus. Nama+description " +
        "SELALU akurat (auto dari tool registry); kategori 'uncategorized' berarti tool itu belum di-curated " +
        "manual, useCase-nya fallback dari description yang dipotong.",
      inputSchema: {
        category: z
          .enum(["all", ...CATEGORY_ENUM])
          .optional()
          .describe(`Filter kategori: ${CATEGORY_ENUM.join(", ")}, atau "all" (default) untuk semua.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ category }) => {
      const merged = getToolRegistry().map((entry) => {
        const meta = CATALOG_METADATA[entry.name];
        return {
          name: entry.name,
          category: meta?.category ?? FALLBACK_CATEGORY,
          tokenCost: meta?.tokenCost ?? DEFAULT_TOKEN_COST,
          useCase: meta?.useCase ?? truncateUseCase(entry.description),
          dependencies: meta?.dependencies ?? [],
        };
      });

      const filtered = category && category !== "all" ? merged.filter((t) => t.category === category) : merged;

      const rows = filtered.map((t) => `| ${t.name} | ${t.category} | ${t.tokenCost} | ${t.useCase} |`).join("\n");

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
