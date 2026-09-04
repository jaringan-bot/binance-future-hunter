// Retry sederhana dengan exponential backoff, dipakai bareng oleh
// binanceProxyClient.ts dan coinalyzeClient.ts. Cuma retry untuk kondisi
// yang genuinely transient (network error, atau status yang eksplisit
// menandakan "coba lagi nanti") -- BUKAN untuk error klien (400/401/404)
// yang bakal gagal lagi persis sama walau di-retry seratus kali.
//
// ── 429 SENGAJA TIDAK DI-RETRY (2026-09-04, Stage 1 signal-integrity) ──
// Dulu 429 ada di set ini. Kombinasinya dengan FAILOVER_STATUS di
// binanceProxyClient.ts (yang JUGA berisi 429) bikin SATU panggilan logis
// meledak jadi sampai 12 request ke Binance saat rate-limit:
//     relay-1: 1 + 3 retry = 4
//     relay-2: 1 + 3 retry = 4   (failover)
//     direct : 1 + 3 retry = 4
// Artinya beban dilipatgandakan ~12x TEPAT saat kita harusnya mengerem --
// retry storm klasik. Binance eksplisit: 429 = "backoff", terus menekan
// setelah 429 menghasilkan IP weight-ban HTTP 418 `-1003`. Itu sudah dua
// kali kejadian di relay ini (lihat komentar ENTRY_WATCHLIST_SIZE di
// entryWatchlist.ts + MAX_REQUESTS_PER_WINDOW di rateLimiter.ts, yang
// dua-duanya mengobati GEJALA dengan menurunkan beban rata-rata, bukan
// akar peledakan beban di sini).
//
// 429 sekarang langsung dikembalikan ke callProxyEndpoint(), yang mencatat
// cooldown per-relay dan failover SEKALI ke relay lain -- bukan 4x per tier.
const RETRYABLE_STATUS = new Set([502, 503]);
const RETRY_DELAYS_MS = [500, 1000, 2000];
// Batas atas hormat-`Retry-After`. Server bisa mengirim angka besar (Binance
// pernah kirim ban durasi menit-jaman); menunggu selama itu di dalam satu
// invocation Worker akan memakan wall-clock cron. Di atas cap ini kita
// menyerah dan mengembalikan response apa adanya -- caller (per-relay
// cooldown di binanceProxyClient.ts) yang menyimpan durasi aslinya.
export const MAX_RETRY_AFTER_WAIT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse header `Retry-After` (RFC 9110): delta-seconds ATAU HTTP-date.
 * Return milidetik, atau `undefined` kalau header tidak ada / tidak valid /
 * sudah lewat. Diekspor untuk dipakai per-relay cooldown di
 * binanceProxyClient.ts -- satu parser, dua pemakai.
 */
export function parseRetryAfterMs(response: Response, now: number = Date.now()): number | undefined {
  // `headers` di-akses defensif: fetchWithRetry dipakai bareng beberapa
  // client (deribit, stablecoin, dst.) yang di test-nya menstub `fetch`
  // dengan objek Response-like minimal tanpa `headers`. Fungsi ini tidak
  // boleh melempar hanya karena header tidak bisa dibaca -- ketiadaan
  // Retry-After itu kondisi normal, bukan error.
  const raw = response.headers?.get?.("retry-after") ?? null;
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  // delta-seconds (bentuk yang dipakai Binance).
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }

  // HTTP-date.
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  const delta = dateMs - now;
  return delta > 0 ? delta : undefined;
}

export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (!RETRYABLE_STATUS.has(response.status) || attempt >= RETRY_DELAYS_MS.length) {
      return response;
    }
    // Hormati `Retry-After` kalau server mengirimnya DAN nilainya masih
    // masuk akal ditunggu di dalam satu invocation; kalau tidak, backoff
    // eksponensial biasa.
    const retryAfterMs = parseRetryAfterMs(response);
    const waitMs =
      retryAfterMs !== undefined && retryAfterMs <= MAX_RETRY_AFTER_WAIT_MS
        ? retryAfterMs
        : RETRY_DELAYS_MS[attempt];
    if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_WAIT_MS) {
      // Server minta tunggu lebih lama dari yang layak ditahan di sini --
      // serahkan ke caller (cooldown per-relay) daripada menahan slot.
      return response;
    }
    await sleep(waitMs);
  }
}
