// Client Deribit public options API -- TIDAK butuh proxy/auth (public REST).
// Verified live 2026-09-04: get_book_summary_by_currency?kind=option BTC/ETH
// balikin ~850–1000 instrument; field option_type ABSENT -- put/call diinfer
// dari suffix instrument_name (-P / -C). Pola fetch+cache sama cftcClient.ts.
import { fetchWithRetry } from "./retry.js";
import { cachedFetch } from "./cache.js";

const DERIBIT_BOOK_SUMMARY_URL = "https://www.deribit.com/api/v2/public/get_book_summary_by_currency";
// Options OI/volume tidak berubah sedetik-detik; TTL 5 menit cukup buat tool on-demand.
const CACHE_TTL_SECONDS = 5 * 60;

export type DeribitOptionsCurrency = "BTC" | "ETH";

export interface DeribitOptionInstrument {
  instrument_name: string;
  open_interest: number;
  volume: number;
  mark_price?: number | null;
  bid_price?: number | null;
  ask_price?: number | null;
  mark_iv?: number | null;
}

interface DeribitJsonRpcResponse {
  jsonrpc?: string;
  result?: DeribitOptionInstrument[] | null;
  error?: { code?: number; message?: string } | null;
}

export interface OptionsPositioning {
  currency: DeribitOptionsCurrency | null;
  instrumentCount: number;
  callCount: number;
  putCount: number;
  totalCallOi: number;
  totalPutOi: number;
  /** put OI / call OI; null kalau call OI = 0 (hindari divide-by-zero). Belum dikalibrasi. */
  putCallRatio: number | null;
  totalVolume: number;
}

function optionSide(instrumentName: string): "call" | "put" | null {
  if (instrumentName.endsWith("-C")) return "call";
  if (instrumentName.endsWith("-P")) return "put";
  return null;
}

export async function getOptionsSummary(currency: DeribitOptionsCurrency): Promise<DeribitOptionInstrument[]> {
  const url = `${DERIBIT_BOOK_SUMMARY_URL}?currency=${currency}&kind=option`;
  const response = await cachedFetch(url, { headers: { Accept: "application/json" } }, CACHE_TTL_SECONDS, fetchWithRetry);
  if (!response.ok) {
    throw new Error(`Deribit HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const body = (await response.json()) as DeribitJsonRpcResponse;
  if (body.error) {
    throw new Error(`Deribit RPC error ${body.error.code ?? "?"}: ${body.error.message ?? "unknown"}`);
  }
  if (!Array.isArray(body.result)) {
    throw new Error(`Deribit response kosong/invalid untuk currency=${currency} kind=option.`);
  }
  return body.result;
}

/** Pure — aggregasi put/call dari suffix instrument_name (-P/-C). */
export function computeOptionsPositioning(
  instruments: DeribitOptionInstrument[],
  currency: DeribitOptionsCurrency | null = null,
): OptionsPositioning {
  let callCount = 0;
  let putCount = 0;
  let totalCallOi = 0;
  let totalPutOi = 0;
  let totalVolume = 0;
  let instrumentCount = 0;

  for (const row of instruments) {
    const side = optionSide(String(row.instrument_name ?? ""));
    if (!side) continue;
    instrumentCount += 1;
    const oi = Number(row.open_interest) || 0;
    const vol = Number(row.volume) || 0;
    totalVolume += vol;
    if (side === "call") {
      callCount += 1;
      totalCallOi += oi;
    } else {
      putCount += 1;
      totalPutOi += oi;
    }
  }

  return {
    currency,
    instrumentCount,
    callCount,
    putCount,
    totalCallOi,
    totalPutOi,
    putCallRatio: totalCallOi > 0 ? totalPutOi / totalCallOi : null,
    totalVolume,
  };
}
