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
// klines 1d call count -- dilacak TERPISAH dari `counts` supaya tidak
// double-count di `total` (getKlinesNative sudah termasuk yang 1d).
let klines1dCount = 0;

// Simulasi withCache untuk /fapi/v1/exchangeInfo (STATIC_CACHE_PATHS, TTL
// 3600s di binanceProxyClient.ts). calculateGridRisk -> fetchSymbolTradingRules
// memanggilnya berkali-kali per symbol dalam satu pipeline run; di produksi
// cuma call PERTAMA per (symbol,jam) yang jadi subrequest, sisanya cache-hit
// per-isolate. Harness menghitung cache-miss saja supaya angka mendekati
// weight riil ke Binance.
const exchangeInfoCache = new Set<string>();

const PAIR_COUNT = 250;
// Dikunci sebagai regression guard (lihat tabel di bawah).
const DEDUP_TOTAL = 2716; // post-dedup, tanpa pre-filter (top_n>=250); +209 klines 1d (DCA head, 1/survivor)
const SURVIVORS_NO_FILTER = 209; // pair lolos hard-screen di harness (hash ~0.84 * 250)
const TOPN40_TOTAL = 483; // post-dedup + top_n=40 F3 (40 survivor); +40 klines 1d (DCA head)
// Target fraksi LOLOS hard-screen dari sample live (tick 11:07 UTC 2026-08-28:
// 156 PASS / 185 evaluated = 0.843). Diterapkan lewat pseudo-hash per symbol
// (bukan by-index) supaya TIDAK berkorelasi dengan urutan ranking pre-filter
// -- jadi di mode top-N, ~84% dari 40 pair terpilih yang lolos, realistis.
const HARD_SCREEN_PASS_FRACTION = 0.84;

function isPass(symbol: string): boolean {
  const n = Number(symbol.replace(/\D/g, ""));
  return ((n * 1103515245 + 12345) >>> 8) % 1000 < Math.round(HARD_SCREEN_PASS_FRACTION * 1000);
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
  insertEntryAlertSkipLog: vi.fn().mockResolvedValue(undefined),
  insertPipelineDecisionLogs: vi.fn().mockResolvedValue(undefined),
  // dca_active_plans: dipanggil dari DUA tempat pada jalur yang dites di
  // sini -- pre-gate DCA di fullPipeline.ts (1/survivor) dan
  // persistDcaActivePlan() di entryAlertCron.ts (get + upsert, 1/survivor).
  // Ketiganya WAJIB distub: keduanya ditelan try/catch, jadi export yang
  // hilang TIDAK menggagalkan test -- harness cuma diam-diam mengukur
  // jalur error. deleteDcaActivePlan belum terjangkau (DCA_STOP tidak
  // pernah muncul di data sintetis harness) tapi tetap distub supaya
  // tidak jadi lubang senyap kalau data harness bergeser.
  getDcaActivePlan: vi.fn().mockResolvedValue(null),
  upsertDcaActivePlan: vi.fn().mockResolvedValue(undefined),
  deleteDcaActivePlan: vi.fn().mockResolvedValue(undefined),
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
    // priceChange varied (spread, non-degenerate for F3). quoteVolume: pass
    // pairs huge, non-pass tiny -> non-pass pairs get F3 volNorm ~0 -> score 0
    // -> F3 always selects exactly N *pass* pairs -> survivors == N in top-N mode.
    return Array.from({ length: PAIR_COUNT }, (_, i) => ({
      symbol: `SYM${i}USDT`,
      lastPrice: "100",
      priceChange: "1",
      priceChangePercent: String((i % 30) * 0.3),
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
      lastFundingRate: String((((PAIR_COUNT - i) % 20) + 1) / 2e6),
      nextFundingTime: 0,
      interestRate: "0",
      time: 0,
    }));
  }),
  getKlinesNative: vi.fn(async (_s: string, interval: string, limit: number) => {
    bump("getKlinesNative");
    if (interval === "1d") klines1dCount += 1; // head DCA, survivor only (dilacak terpisah)
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
  hasBinanceApiCredentials: () => false,
}));

describe("DRY-RUN: subrequest count per entry-alert tick (post-dedup)", () => {
  beforeEach(() => {
    klines1dCount = 0;
    for (const k of Object.keys(counts)) delete counts[k];
    exchangeInfoCache.clear();
    vi.mocked(d1Client.getEntryAlertState).mockResolvedValue(null);
    vi.mocked(kvConfig.getJson).mockResolvedValue(null);
  });

  // ── HASIL DRY-RUN (dikunci sebagai regression guard) ──────────────────
  // 250 pair, hard-screen pass ~0.84 (sample live tick 11:07 UTC 2026-08-28:
  // 156 PASS / 185 evaluated -- di harness diterapkan via pseudo-hash per
  // symbol, jadi survivor count tidak persis 0.84*N). Angka = subrequest
  // LOGIS ke proxy Binance per tick (tanpa retry/3-tier failover;
  // /fapi/v1/exchangeInfo dimodelkan cache-hit per (symbol,jam) sesuai
  // STATIC_CACHE_PATHS). SURV = pair yang lolos hard-screen (masuk Wave 2).
  //
  //                            BASELINE   +DEDUP (b)   +DEDUP+TOP-N40 (a)
  //   watchlist diproses            250        250        40
  //   survivors (hard-screen)       209        209        32
  //   setup (exchInfo+ticker+fund)    4          3          3
  //   Wave 1 (klines1h+4h 2/pair +  1250       1250       200
  //     OI + oiHist2 + aggTrades)
  //   fetchMarketContext (5/pair)   1250          0          0
  //   Wave 2 (topTrader/global/    1045       1045       160
  //     oiHist24/orderBook/spot)
  //   exchangeInfo per-survivor     209        209         32
  //   ────────────────────────────────────────────────────
  //   TOTAL / tick (harness)       3758       2507        395
  //   Reduksi (b) dedup    : 3758 -> 2507  = -33.3%
  //   Reduksi (b)+(a) N=40 : 3758 ->  395  = -89.5%
  //   Reduksi (a) incremental: 2507 -> 395 = -84.2%
  // BASELINE = (+DEDUP total 2507) + 1251 (1 ticker-refetch + 5*250
  // fetchMarketContext yang dulu unconditional di Wave 1).
  it("no pre-filter (top_n >= watchlist): locks post-dedup count + phase split", async () => {
    vi.mocked(kvConfig.getJson).mockResolvedValue(9999);
    await runEntryAlertCheck({ TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "y" } as never);

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const survivors = counts.getTopTraderPositionRatio ?? 0;
    const tradingRulesCalls = (counts.getFuturesExchangeInfo ?? 0) - 1;

    // Inti STEP 1(b): ticker24hr + premiumIndex + exchangeInfo(no-arg) 1x each.
    expect(counts.getAllTicker24hrNative).toBe(1);
    expect(counts.getBulkFundingRatesNative).toBe(1);
    // Wave 1 klines = 2/pair (1h + 4h). Head DCA menambah EXACTLY 1 klines 1d
    // per survivor (Wave 2), nol call Wave-1 lain.
    expect(counts.getKlinesNative).toBe(500 + survivors);
    expect(klines1dCount).toBe(survivors);
    expect(counts.getOpenInterestNative).toBe(250);
    expect(counts.getAggTrades).toBe(250);
    // Wave 2 fan-out = 1/survivor untuk kelima call + 1 exchangeInfo/survivor.
    expect(counts.getGlobalAccountRatio).toBe(survivors);
    expect(counts.getOrderBookDepth).toBe(survivors);
    expect(counts.getSpotPrice).toBe(survivors);
    expect(counts.getOpenInterestHistNative).toBe(250 + survivors);
    expect(tradingRulesCalls).toBe(survivors);
    // survivor ~84% dari 250.
    expect(survivors).toBeGreaterThan(195);
    expect(survivors).toBeLessThan(225);

    expect(total).toBe(DEDUP_TOTAL);
    expect(SURVIVORS_NO_FILTER).toBe(survivors);
  });

  it("top_n=40: locks post-dedup+top-N subrequest count", async () => {
    vi.mocked(kvConfig.getJson).mockResolvedValue(40);
    await runEntryAlertCheck({ TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "y" } as never);

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const survivors = counts.getTopTraderPositionRatio ?? 0;

    // Cuma 40 pair masuk Wave 1: klines 1h+4h = 80, + klines 1d/survivor (DCA head).
    expect(counts.getKlinesNative).toBe(80 + survivors);
    expect(klines1dCount).toBe(survivors);
    expect(counts.getOpenInterestNative).toBe(40);
    expect(counts.getAggTrades).toBe(40);
    // F3 hanya memilih pair yang lolos hard-screen di harness ini -> survivor == 40.
    expect(survivors).toBe(40);

    expect(total).toBe(TOPN40_TOTAL);
  });
});
