// Sumber data derivatives Binance Futures lewat Coinalyze (https://coinalyze.net).
// Dipakai karena fapi.binance.com DAN www.binance.com sama-sama memblokir
// traffic dari Cloudflare Workers (403, block company-wide di WAF mereka,
// sudah dites langsung dari worker ini). Coinalyze meng-agregasi ulang data
// yang sama (termasuk dari Binance) dan API-nya sendiri di-hosting di
// Cloudflare — jadi tidak kena block yang sama.
//
// Keterbatasan: Coinalyze cuma punya SATU long/short ratio blended, tidak
// ada breakdown "global account" vs "top trader" seperti API Binance asli.
// Provider yang punya breakdown itu (CoinGlass, CoinAnk) semua berbayar.

const BASE_URL = "https://api.coinalyze.net/v1";
const EXCHANGE_CODE = "A"; // Binance — dari GET /v1/exchanges

let apiKey: string | undefined;

export function setApiKey(key: string | undefined) {
  apiKey = key;
}

export class CoinalyzeApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = "CoinalyzeApiError";
  }
}

// Interval Binance-style (dipakai tool schema) -> interval asli Coinalyze.
// Coinalyze tidak punya "3m" atau "8h" — dua itu di-drop dari enum di server.ts.
const INTERVAL_MAP: Record<string, string> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1h": "1hour",
  "2h": "2hour",
  "4h": "4hour",
  "6h": "6hour",
  "12h": "12hour",
  "1d": "daily",
};

const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "6h": 21600,
  "12h": 43200,
  "1d": 86400,
};

function toCoinalyzeSymbol(binanceSymbol: string): string {
  return `${binanceSymbol.toUpperCase()}_PERP.${EXCHANGE_CODE}`;
}

async function callCoinalyze<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  if (!apiKey) {
    throw new CoinalyzeApiError(
      "COINALYZE_API_KEY belum diset di worker. Jalankan `wrangler secret put COINALYZE_API_KEY`.",
      undefined,
      path,
    );
  }
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
  } catch (err) {
    throw new CoinalyzeApiError(
      `Gagal menghubungi Coinalyze API: ${(err as Error).message}. Coba lagi sebentar lagi.`,
      undefined,
      path,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 429) {
      throw new CoinalyzeApiError(
        `Rate limit Coinalyze API tercapai (40 request/menit). Tunggu beberapa detik.`,
        response.status,
        path,
      );
    }
    throw new CoinalyzeApiError(
      `Coinalyze API error HTTP ${response.status}: ${body || response.statusText}. Cek symbol/parameter.`,
      response.status,
      path,
    );
  }

  return response.json() as Promise<T>;
}

function rangeFor(intervalKey: string, limit: number): { from: number; to: number } {
  const seconds = INTERVAL_SECONDS[intervalKey] ?? 3600;
  const to = Math.floor(Date.now() / 1000);
  const from = to - seconds * limit;
  return { from, to };
}

export interface FundingRateValue {
  symbol: string;
  value: number;
  update: number;
}

export interface OpenInterestValue {
  symbol: string;
  value: number;
  update: number;
}

export interface OhlcBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface OhlcvBar extends OhlcBar {
  v: number;
  bv: number;
  tx: number;
  btx: number;
}

export interface LongShortBar {
  t: number;
  r: number;
  l: number;
  s: number;
}

interface HistorySeries<T> {
  symbol: string;
  history: T[];
}

export async function getCurrentFundingRate(symbol: string): Promise<FundingRateValue> {
  const sym = toCoinalyzeSymbol(symbol);
  const data = await callCoinalyze<FundingRateValue[]>("/funding-rate", { symbols: sym });
  if (data.length === 0) {
    throw new CoinalyzeApiError(`Tidak ada data funding rate untuk ${symbol}.`, undefined, "/funding-rate");
  }
  return data[0];
}

export async function getFundingRateHistory(
  symbol: string,
  intervalKey: string,
  limit: number,
): Promise<OhlcBar[]> {
  const sym = toCoinalyzeSymbol(symbol);
  const interval = INTERVAL_MAP[intervalKey] ?? "1hour";
  const { from, to } = rangeFor(intervalKey, limit);
  const data = await callCoinalyze<HistorySeries<OhlcBar>[]>("/funding-rate-history", {
    symbols: sym,
    interval,
    from,
    to,
  });
  return data[0]?.history ?? [];
}

export async function getCurrentOpenInterest(symbol: string): Promise<OpenInterestValue> {
  const sym = toCoinalyzeSymbol(symbol);
  const data = await callCoinalyze<OpenInterestValue[]>("/open-interest", {
    symbols: sym,
    convert_to_usd: "false",
  });
  if (data.length === 0) {
    throw new CoinalyzeApiError(`Tidak ada data open interest untuk ${symbol}.`, undefined, "/open-interest");
  }
  return data[0];
}

export async function getOpenInterestHistory(
  symbol: string,
  intervalKey: string,
  limit: number,
): Promise<OhlcBar[]> {
  const sym = toCoinalyzeSymbol(symbol);
  const interval = INTERVAL_MAP[intervalKey] ?? "1hour";
  const { from, to } = rangeFor(intervalKey, limit);
  const data = await callCoinalyze<HistorySeries<OhlcBar>[]>("/open-interest-history", {
    symbols: sym,
    interval,
    from,
    to,
    convert_to_usd: "false",
  });
  return data[0]?.history ?? [];
}

export async function getLongShortRatioHistory(
  symbol: string,
  intervalKey: string,
  limit: number,
): Promise<LongShortBar[]> {
  const sym = toCoinalyzeSymbol(symbol);
  const interval = INTERVAL_MAP[intervalKey] ?? "1hour";
  const { from, to } = rangeFor(intervalKey, limit);
  const data = await callCoinalyze<HistorySeries<LongShortBar>[]>("/long-short-ratio-history", {
    symbols: sym,
    interval,
    from,
    to,
  });
  return data[0]?.history ?? [];
}

export async function getOhlcvHistory(
  symbol: string,
  intervalKey: string,
  limit: number,
): Promise<OhlcvBar[]> {
  const sym = toCoinalyzeSymbol(symbol);
  const interval = INTERVAL_MAP[intervalKey] ?? "1hour";
  const { from, to } = rangeFor(intervalKey, limit);
  const data = await callCoinalyze<HistorySeries<OhlcvBar>[]>("/ohlcv-history", {
    symbols: sym,
    interval,
    from,
    to,
  });
  return data[0]?.history ?? [];
}
