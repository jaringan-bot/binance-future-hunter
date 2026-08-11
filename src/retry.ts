// Retry sederhana dengan exponential backoff, dipakai bareng oleh
// binanceProxyClient.ts dan coinalyzeClient.ts. Cuma retry untuk kondisi
// yang genuinely transient (network error, atau status yang eksplisit
// menandakan "coba lagi nanti") -- BUKAN untuk error klien (400/401/404)
// yang bakal gagal lagi persis sama walau di-retry seratus kali.
const RETRYABLE_STATUS = new Set([429, 502, 503]);
const RETRY_DELAYS_MS = [500, 1000, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}
