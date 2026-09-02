import { describe, it, expect, vi, afterEach } from "vitest";
import { getCftcPositioning, computeCftcTrend, type CftcHistoryPoint } from "./cftcClient.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function rawRow(overrides: Record<string, string> = {}) {
  return {
    contract_market_name: "BITCOIN",
    report_date_as_yyyy_mm_dd: "2026-08-18T00:00:00.000",
    open_interest_all: "21760",
    lev_money_positions_long: "4488",
    lev_money_positions_short: "11927",
    change_in_lev_money_long: "-509",
    change_in_lev_money_short: "-122",
    asset_mgr_positions_long: "4531",
    asset_mgr_positions_short: "1799",
    change_in_asset_mgr_long: "-210",
    change_in_asset_mgr_short: "-708",
    ...overrides,
  };
}

describe("getCftcPositioning", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses the latest COT row and computes net % of open interest", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([rawRow()]));
    vi.stubGlobal("fetch", fetchMock);

    const report = await getCftcPositioning("BTC");

    expect(report.contractMarketName).toBe("BITCOIN");
    expect(report.openInterest).toBe(21760);
    expect(report.leveragedFunds).toMatchObject({ long: 4488, short: 11927, changeLong: -509, changeShort: -122 });
    expect(report.leveragedFunds.netPct).toBeCloseTo((4488 - 11927) / 21760);
    expect(report.assetManagers).toMatchObject({ long: 4531, short: 1799 });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("contract_market_name=BITCOIN");
    expect(url).toContain("gpe5-46if.json");
  });

  it("maps ETH to the CME 'ETHER CASH SETTLED' contract name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([rawRow({ contract_market_name: "ETHER CASH SETTLED" })]));
    vi.stubGlobal("fetch", fetchMock);

    await getCftcPositioning("ETH");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("ETHER+CASH+SETTLED");
  });

  it("throws when no COT row is returned for the contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    await expect(getCftcPositioning("BTC")).rejects.toThrow("Gak ada laporan COT ditemukan");
  });

  it("throws on non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("error", false, 500)));
    await expect(getCftcPositioning("BTC")).rejects.toThrow("CFTC HTTP 500");
  });
});

function point(overrides: Partial<CftcHistoryPoint> = {}): CftcHistoryPoint {
  return { reportDate: "2026-08-18", openInterest: 21760, levNetPct: -0.3, amNetPct: 0.15, ...overrides };
}

describe("computeCftcTrend", () => {
  it("returns an empty/neutral trend for no history", () => {
    const trend = computeCftcTrend([]);
    expect(trend).toEqual({
      weeksAvailable: 0,
      oldest: null,
      latest: null,
      levNetPctChange: null,
      amNetPctChange: null,
      direction: "FLAT",
    });
  });

  it("computes levNetPctChange/amNetPctChange in percentage points from oldest to latest", () => {
    const history = [
      point({ reportDate: "2026-07-28", levNetPct: -0.3, amNetPct: 0.1 }),
      point({ reportDate: "2026-08-04", levNetPct: -0.2, amNetPct: 0.12 }),
      point({ reportDate: "2026-08-18", levNetPct: -0.1, amNetPct: 0.15 }),
    ];
    const trend = computeCftcTrend(history);
    expect(trend.weeksAvailable).toBe(3);
    expect(trend.oldest?.reportDate).toBe("2026-07-28");
    expect(trend.latest?.reportDate).toBe("2026-08-18");
    expect(trend.levNetPctChange).toBeCloseTo(20); // -0.1 - (-0.3) = 0.2 -> 20 poin
    expect(trend.amNetPctChange).toBeCloseTo(5); // 0.15 - 0.10 = 0.05 -> 5 poin
  });

  it("classifies RISING when levNetPctChange exceeds the deadband", () => {
    const trend = computeCftcTrend([point({ levNetPct: -0.3 }), point({ levNetPct: 0.0 })]); // +30 poin
    expect(trend.direction).toBe("RISING");
  });

  it("classifies FALLING when levNetPctChange drops below the negative deadband", () => {
    const trend = computeCftcTrend([point({ levNetPct: 0.1 }), point({ levNetPct: -0.2 })]); // -30 poin
    expect(trend.direction).toBe("FALLING");
  });

  it("classifies FLAT when the change stays inside the +/-2 point deadband", () => {
    const trend = computeCftcTrend([point({ levNetPct: -0.1 }), point({ levNetPct: -0.105 })]); // -0.5 poin
    expect(trend.direction).toBe("FLAT");
  });
});
