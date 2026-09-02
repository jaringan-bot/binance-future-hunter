// Client CFTC Commitment of Traders -- Traders in Financial Futures (TFF),
// Futures Only, dataset publik Socrata "gpe5-46if" (publicreporting.cftc.gov).
// TIDAK butuh proxy/auth (public read). Data MINGGUAN (dirilis tiap Jumat,
// lag beberapa hari) -- cache TTL panjang, TIDAK disimpan ke D1 sama sekali
// (dataset CFTC sendiri sudah punya histori kalau nanti butuh rentang tanggal).
//
// TFF report pakai istilah "Leveraged Funds" (bukan "Managed Money" --
// istilah itu punya di laporan Disaggregated buat komoditas fisik, beda
// dataset) buat kategori paling deket "smart money spekulatif" di financial
// futures kayak Bitcoin/Ether. "Asset Managers" (dana institusional lebih
// pasif -- ETF, pensiun) disertakan terpisah sbg pembanding.
import { fetchWithRetry } from "./retry.js";
import { cachedFetch } from "./cache.js";

const CFTC_TFF_URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";
const CACHE_TTL_SECONDS = 12 * 3600; // data cuma update mingguan, gak perlu fresh tiap request

// Verified live via CFTC API (2026-08-25): contract_market_name persis
// segini di dataset gpe5-46if untuk kontrak CME. XRP/SOL juga ada di
// dataset ini kalau mau diperluas nanti.
export const CFTC_CONTRACT_NAME: Record<"BTC" | "ETH", string> = {
  BTC: "BITCOIN",
  ETH: "ETHER CASH SETTLED",
};

interface CftcRawRow {
  contract_market_name: string;
  report_date_as_yyyy_mm_dd: string;
  open_interest_all: string;
  lev_money_positions_long: string;
  lev_money_positions_short: string;
  change_in_lev_money_long: string;
  change_in_lev_money_short: string;
  asset_mgr_positions_long: string;
  asset_mgr_positions_short: string;
  change_in_asset_mgr_long: string;
  change_in_asset_mgr_short: string;
}

export interface CftcPositioningGroup {
  long: number;
  short: number;
  netPct: number; // (long - short) / openInterest, positif = net long
  changeLong: number;
  changeShort: number;
}

export interface CftcPositioningReport {
  contractMarketName: string;
  reportDate: string; // ISO date, minggu laporan (Selasa, dirilis Jumat)
  openInterest: number;
  leveragedFunds: CftcPositioningGroup;
  assetManagers: CftcPositioningGroup;
}

function toGroup(openInterest: number, long: string, short: string, changeLong: string, changeShort: string): CftcPositioningGroup {
  const longNum = parseFloat(long);
  const shortNum = parseFloat(short);
  return {
    long: longNum,
    short: shortNum,
    netPct: openInterest !== 0 ? (longNum - shortNum) / openInterest : 0,
    changeLong: parseFloat(changeLong),
    changeShort: parseFloat(changeShort),
  };
}

export async function getCftcPositioning(coin: "BTC" | "ETH"): Promise<CftcPositioningReport> {
  const contractName = CFTC_CONTRACT_NAME[coin];
  const params = new URLSearchParams({
    contract_market_name: contractName,
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: "1",
  });
  const url = `${CFTC_TFF_URL}?${params.toString()}`;

  const response = await cachedFetch(url, { headers: { Accept: "application/json" } }, CACHE_TTL_SECONDS, fetchWithRetry);
  if (!response.ok) {
    throw new Error(`CFTC HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const rows = (await response.json()) as CftcRawRow[];
  const row = rows[0];
  if (!row) {
    throw new Error(`Gak ada laporan COT ditemukan untuk kontrak "${contractName}" di dataset CFTC TFF.`);
  }

  const openInterest = parseFloat(row.open_interest_all);

  return {
    contractMarketName: row.contract_market_name,
    reportDate: row.report_date_as_yyyy_mm_dd,
    openInterest,
    leveragedFunds: toGroup(
      openInterest,
      row.lev_money_positions_long,
      row.lev_money_positions_short,
      row.change_in_lev_money_long,
      row.change_in_lev_money_short,
    ),
    assetManagers: toGroup(
      openInterest,
      row.asset_mgr_positions_long,
      row.asset_mgr_positions_short,
      row.change_in_asset_mgr_long,
      row.change_in_asset_mgr_short,
    ),
  };
}

// computeCftcTrend -- fungsi MURNI (tanpa fetch), dipakai
// cme_get_institutional_positioning_trend (src/tools/cftcPositioning.ts).
// Input: histori lokal dari D1 (cftc_positioning_history, diisi
// src/cron/cftcPositioningCron.ts), ASCENDING (oldest -> newest) --
// queryCftcPositioningHistory (d1Client.ts) sudah mengembalikan urutan ini.
//
// Ini rate-of-change MULTI-MINGGU dari histori yang KITA simpan sendiri,
// beda dari `changeLong`/`changeShort` di CftcPositioningGroup di atas yang
// cuma WoW dari API CFTC langsung (1 minggu, dihitung CFTC sendiri).
//
// DIRECTION_DEADBAND_PCT (2 poin persentase net-OI) adalah HEURISTIK
// eksplisit (bukan kalibrasi statistik) -- konsisten dengan budaya threshold
// di seluruh repo ini (smartMoneyAnalysis.ts, detectMmActivity.ts, dst):
// belum ada data cukup panjang buat tahu berapa besar pergerakan levNetPct
// yang "signifikan" vs noise laporan-ke-laporan, karena table ini baru mulai
// ngumpulin data dari commit ini -- BUKAN backfill retroaktif.
const DIRECTION_DEADBAND_PCT = 2;

export interface CftcHistoryPoint {
  reportDate: string;
  openInterest: number;
  levNetPct: number;
  amNetPct: number;
}

export type CftcTrendDirection = "RISING" | "FALLING" | "FLAT";

export interface CftcTrend {
  weeksAvailable: number;
  oldest: CftcHistoryPoint | null;
  latest: CftcHistoryPoint | null;
  levNetPctChange: number | null; // percentage points, latest - oldest dalam window
  amNetPctChange: number | null;
  direction: CftcTrendDirection; // dari levNetPctChange (Leveraged Funds = "smart money spekulatif")
}

export function computeCftcTrend(history: CftcHistoryPoint[]): CftcTrend {
  if (history.length === 0) {
    return { weeksAvailable: 0, oldest: null, latest: null, levNetPctChange: null, amNetPctChange: null, direction: "FLAT" };
  }

  const oldest = history[0];
  const latest = history[history.length - 1];
  const levNetPctChange = (latest.levNetPct - oldest.levNetPct) * 100; // fraction -> percentage points
  const amNetPctChange = (latest.amNetPct - oldest.amNetPct) * 100;

  let direction: CftcTrendDirection = "FLAT";
  if (levNetPctChange > DIRECTION_DEADBAND_PCT) direction = "RISING";
  else if (levNetPctChange < -DIRECTION_DEADBAND_PCT) direction = "FALLING";

  return {
    weeksAvailable: history.length,
    oldest,
    latest,
    levNetPctChange,
    amNetPctChange,
    direction,
  };
}
