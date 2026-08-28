// DRY-RUN HARNESS -- bukan test perilaku, tapi pengukur jumlah subrequest
// proxy Binance per tick entry-alert. Menjalankan runEntryAlertCheck() ASLI
// (runPipelineForSymbol, fetchMarketContext, evaluateHardScreen, gridBound/
// gridRisk engine -- semua REAL) di atas stub binanceProxyClient yang cuma
// MENGHITUNG panggilan + mengembalikan shape minimal valid. Watchlist
// sintetis 250 pair, pass-rate hard-screen dikontrol lewat quoteVolume.
//
// Dipakai buat deliverable "subrequest count/tick per fase" dan sekaligus
// jadi regression guard: kalau ada yang nambah fetch per-pair di Wave 1/2,
// angka di bawah ninggi dan test ini kelihatan berubah.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as binanceProxy from "../binanceProxyClient.js";
import * as d1Client from "../d1Client.js";
import * as kvConfig from "../kvConfig.js";
import { runEntryAlertCheck } from "./entryAlertCron.js";

const counts: Record<string, number> = {};
function bump(name: string) {
  counts[name] = (counts[name] ?? 0) + 1;
}

// Simulasi withCache untuk /fapi/v1/exchangeInfo (STATIC_CACHE_PATHS, TTL
// 3600s di binanceProxyClient.ts). calculateGridRisk -> fetchSymbolTradingRules
// memanggilnya berkali-kali per symbol dalam satu pipeline run; di produksi
// cuma call PERTAMA per (symbol,jam) yang jadi subrequest, sisanya cache-hit
// per-isolate. Harness menghitung cache-miss saja supaya angka mendekati
// weight riil ke Binance.
const exchangeInfoCache = new Set<string>();

const PAIR_COUNT = 250;
// Fraksi watchlist yang LOLOS hard-screen (quoteVolume di atas ambang +
// funding kecil + regime bukan BREAKOUT). Sisa -> reject low_volume,
// short-circuit sebelum Wave 2. Set ke angka dari sample live (tick 11:07
// UTC: 156/185 = 0.84).
const HARD_SCREEN_PASS_FRACTION = 0.84;

function isPass(symbol: string): boolean {
  const n = Number(symbol.replace(/\D/g, ""));
  return n < Math.round(PAIR_COUNT * HARD_SCREEN_PASS_FRACTION);
}

function klines(limit: number): binanceProxy.KlineTuple[] {
  // Tren naik lembut + noise kecil -> ADX finite, regime TRENDING_UP/RANGING
  // (bukan BREAKOUT), volatilitySpike ~1.
  return Array.from({ length: limit }, (_, i) => {
    const base = 100 + i * 0.2 + Math.sin(i / 3) * 0.5;
    const open = base;
    const close = base + 0.1;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    const t = 1_700_000_000_000 + i * 3_600_000;
    return [
      t, String(open), String(high), String(low), String(close), "1500",
      t + 3_599_999, "150000", 60, "750", "75000", "0",
    ] as binanceProxy.KlineTuple;
  });
}

vi.mock("../tools/fullPipeline.js", async (orig) => orig()); // REAL
vi.mock("../pacing.js", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../telegram.js", () => ({
  sendTelegramAlert: vi.fn().mockResolvedValue(undefined),
  escapeMarkdown: (t: string) => t,
}));
vi.mock("../d1Client.js", () => ({
  getEntryAlertState: vi.fn().mockResolvedValue(null),
  upsertEntryAlertState: vi.fn().mockResolvedValue(undefined),
  insertEntryAlertRunLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../kvConfig.js", () => ({
  getJson: vi.fn().mockResolvedValue(null),
  putJson: vi.fn().mockResolvedValue(undefined),
  listKeys: vi.fn().mockResolvedValue([]),
  setKvNamespace: vi.fn(),
}));

vi.mock("../binanceProxyClient.js", () => ({
  getFuturesExchangeInfo: vi.fn(async (symbol?: string) => {
    const key = symbol ?? "__all__";
    if (!exchangeInfoCache.has(key)) {
      exchangeInfoCache.add(key);
      bump("getFuturesExchangeInfo");
    }
    return {
      symbols: Array.from({ length: PAIR_COUNT }, (_, i) => ({
        symbol: `SYM${i}USDT`,
        filters: [],
        status: "TRADING",
        contractType: "PERPETUAL",
        quoteAsset: "USDT",
      })),
    };
  }),
  getAllTicker24hrNative: vi.fn(async () => {
    bump("getAllTicker24hrNative");
    return Array.from({ length: PAIR_COUNT }, (_, i) => ({
      symbol: `SYM${i}USDT`,
      lastPrice: "100",
      priceChange: "1",
      priceChangePercent: "1",
      highPrice: "105",
      lowPrice: "95",
      volume: "100000",
      quoteVolume: isPass(`SYM${i}USDT`) ? "9999999999" : "1000000",
    }));
  }),
  getBulkFundingRatesNative: vi.fn(async () => {
    bump("getBulkFundingRatesNative");
    return Array.from({ length: PAIR_COUNT }, (_, i) => ({
      symbol: `SYM${i}USDT`,
      markPrice: "100",
      indexPrice: "100",
      estimatedSettlePrice: "100",
      lastFundingRate: "0.00001",
      nextFundingTime: 0,
      interestRate: "0",
      time: 0,
    }));
  }),
  getKlinesNative: vi.fn(async (_s: string, _i: string, limit: number) => {
    bump("getKlinesNative");
    return klines(limit ?? 50);
  }),
  getOpenInterestNative: vi.fn(async (s: string) => {
    bump("getOpenInterestNative");
    return { symbol: s, openInterest: "1000000", time: 0 };
  }),
  getOpenInterestHistNative: vi.fn(async (s: string, _p: string, limit: number) => {
    bump("getOpenInterestHistNative");
    return Array.from({ length: limit }, (_, i) => ({
      symbol: s,
      sumOpenInterest: String(1_000_000 + i * 100),
      sumOpenInterestValue: String(100_000_000 + i * 10_000),
      timestamp: i,
    }));
  }),
  getAggTrades: vi.fn(async () => {
    bump("getAggTrades");
    return Array.from({ length: 100 }, (_, i) => ({
      a: i, p: "100", q: "1", f: i, l: i, T: i, m: i % 2 === 0,
    }));
  }),
  getTopTraderPositionRatio: vi.fn(async (s: string) => {
    bump("getTopTraderPositionRatio");
    return [{ symbol: s, longAccount: "0.55", shortAccount: "0.45", longShortRatio: "1.22", timestamp: 0 }];
  }),
  getGlobalAccountRatio: vi.fn(async (s: string) => {
    bump("getGlobalAccountRatio");
    return [{ symbol: s, longAccount: "0.52", shortAccount: "0.48", longShortRatio: "1.08", timestamp: 0 }];
  }),
  getOrderBookDepth: vi.fn(async () => {
    bump("getOrderBookDepth");
    const bids: [string, string][] = Array.from({ length: 50 }, (_, i) => [String(100 - i * 0.1), "10"]);
    const asks: [string, string][] = Array.from({ length: 50 }, (_, i) => [String(100 + i * 0.1), "10"]);
    return { lastUpdateId: 0, E: 0, T: 0, bids, asks };
  }),
  getSpotPrice: vi.fn(async (s: string) => {
    bump("getSpotPrice");
    return { symbol: s, price: "100" };
  }),
}));

describe("DRY-RUN: subrequest count per entry-alert tick (post-dedup)", () => {
  beforeEach(() => {
    for (const k of Object.keys(counts)) delete counts[k];
    exchangeInfoCache.clear();
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);
  });

  // ── HASIL DRY-RUN (dikunci sebagai regression guard) ──────────────────
  // 250 pair, hard-screen pass fraction 0.84 (dari sample live tick 11:07
  // UTC 2026-08-28: 156 PASS / 185 evaluated). Angka = subrequest LOGIS ke
  // proxy Binance per tick (tanpa retry/3-tier failover; /fapi/v1/exchangeInfo
  // dimodelkan cache-hit per (symbol,jam) sesuai STATIC_CACHE_PATHS).
  //
  //                              POST-DEDUP   BASELINE (pre-dedup)
  //   setup (exchInfo+ticker+funding)     3   4   (ticker di-fetch 2x)
  //   Wave 1 (250 pair):
  //     klines 1h+4h                    500   500
  //     openInterest                    250   250
  //     openInterestHist(2)             250   250
  //     aggTrades                       250   250
  //     fetchMarketContext (5/pair)       0   1250 (dulu unconditional di Wave 1)
  //   Wave 2 (210 survivor):
  //     topTraderPositionRatio          210   210
  //     globalAccountRatio              210   210
  //     openInterestHist(24)            210   210
  //     orderBookDepth(50)              210   210
  //     spotPrice                       210   210
  //   leverage loop:
  //     exchangeInfo per-survivor       210   210 (fetchSymbolTradingRules)
  //   ─────────────────────────────────────────────
  //   TOTAL / tick                     2513   3764
  //   Reduksi (b) dedup: (3764-2513)/3764 = 33.2%
  //
  // NB oiHist total 460 = 250 (Wave1 limit 2) + 210 (Wave2 limit 24).
  it("locks the post-dedup subrequest count per tick and its phase split", async () => {
    await runEntryAlertCheck({ TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "y" } as never);

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const setupExchangeInfo = 1; // no-arg call
    const tradingRulesCalls = (counts.getFuturesExchangeInfo ?? 0) - setupExchangeInfo;

    // Inti STEP 1(b): ticker24hr + premiumIndex + exchangeInfo(no-arg) 1x each.
    expect(counts.getAllTicker24hrNative).toBe(1);
    expect(counts.getBulkFundingRatesNative).toBe(1);
    // Wave 1 klines = 2/pair (1h + 4h), BUKAN 3 -- fetchMarketContext tidak
    // lagi fetch klines1h sendiri.
    expect(counts.getKlinesNative).toBe(500);
    // OI current & aggTrades = 1/pair -- tidak digandakan fetchMarketContext.
    expect(counts.getOpenInterestNative).toBe(250);
    expect(counts.getAggTrades).toBe(250);
    // Wave 2 fan-out = 1/survivor.
    expect(counts.getTopTraderPositionRatio).toBe(210);
    expect(counts.getGlobalAccountRatio).toBe(210);
    expect(counts.getOrderBookDepth).toBe(210);
    expect(counts.getSpotPrice).toBe(210);
    expect(counts.getOpenInterestHistNative).toBe(460);
    // leverage loop -> fetchSymbolTradingRules: 1 exchangeInfo per survivor.
    expect(tradingRulesCalls).toBe(210);

    expect(total).toBe(2513);
  });
});
