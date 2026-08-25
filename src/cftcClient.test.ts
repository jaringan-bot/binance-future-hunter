import { describe, it, expect, vi, afterEach } from "vitest";
import { getCftcPositioning } from "./cftcClient.js";

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
