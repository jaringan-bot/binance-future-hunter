// Hitung frekuensi query untuk pair DI LUAR SNAPSHOT_WATCHLIST, dipakai
// binance_get_basis_history & binance_detect_mm_activity supaya pair yang
// "sering di-query" bisa dapat histori basis dari cron 5-menit walau bukan
// bagian 50-pair watchlist tetap (lihat marketSnapshotCron.ts
// snapshotNonWatchlistBasis()). Wall tracking (cron 1-menit) SENGAJA tidak
// disentuh -- tetap watchlist-only, cron itu sudah punya known concurrency
// warning di 50 symbol, nggak mau nambah beban di sana.
import { getJson, putJson, listKeys } from "./kvConfig.js";
import { SNAPSHOT_WATCHLIST } from "./shared.js";

const QUERY_COUNT_PREFIX = "basis_query_count:";
const QUERY_COUNT_TTL_SECONDS = 24 * 3600;
export const TOP_N_NON_WATCHLIST = 5;
export const MIN_QUERY_COUNT = 3;

// Increment-with-TTL-refresh, BUKAN sliding-window murni: tiap query
// nge-reset TTL 24 jam, count terus nambah selama pair itu di-query
// minimal 1x/24 jam, otomatis nol lagi (key expire) kalau berhenti
// di-query 24 jam penuh. KV gak punya atomic increment/sliding-window
// tanpa Durable Object -- ini simplifikasi yang disengaja, sama semangat
// "best-effort" seperti rateLimiter.ts. Read-then-write juga BUKAN atomic
// -- request paralel bisa saling menimpa increment (last-write-wins),
// diterima di skala kecil ini.
export async function recordNonWatchlistQuery(symbol: string): Promise<void> {
  const upper = symbol.toUpperCase();
  if ((SNAPSHOT_WATCHLIST as readonly string[]).includes(upper)) return;
  try {
    const key = `${QUERY_COUNT_PREFIX}${upper}`;
    const current = (await getJson<number>(key)) ?? 0;
    await putJson(key, current + 1, { expirationTtl: QUERY_COUNT_TTL_SECONDS });
  } catch {
    // Sama pola getPairThreshold() (tools/config.ts) -- KV belum ke-bind
    // atau gagal transient TIDAK BOLEH gagalin tool call gara-gara fitur
    // pelengkap ini.
  }
}

export interface TopQueriedSymbol {
  symbol: string;
  count: number;
}

export async function getTopQueriedNonWatchlistSymbols(): Promise<TopQueriedSymbol[]> {
  try {
    const keys = await listKeys(QUERY_COUNT_PREFIX);
    const entries = await Promise.all(
      keys.map(async (key) => ({
        symbol: key.slice(QUERY_COUNT_PREFIX.length),
        count: (await getJson<number>(key)) ?? 0,
      })),
    );
    return entries
      .filter((e) => e.count >= MIN_QUERY_COUNT)
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_N_NON_WATCHLIST);
  } catch {
    return []; // cron caller (snapshotNonWatchlistBasis) harus tetap jalan walau ini gagal
  }
}
