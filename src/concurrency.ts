// mapWithConcurrency<T,R> -- worker-pool concurrency limiter dipakai
// whalescope_full_pipeline (src/tools/fullPipeline.ts) buat jalanin
// runPipelineForSymbol() untuk banyak symbol sekaligus TANPA membanjiri
// proxy Binance (rateLimiter.ts) dengan puluhan call paralel penuh kalau
// user minta 20 symbol dalam 1 tool call.
//
// SENGAJA worker-pool, BUKAN fixed chunking (mis. slice per 6 lalu
// Promise.all tiap chunk berurutan) -- chunking lockstep berarti chunk
// berikutnya nunggu SEMUA item chunk sebelumnya selesai, padahal durasi
// tiap symbol beda-beda (symbol yang short-circuit di hard-screen Wave 1
// jauh lebih cepat dari yang lolos ke Wave 2 penuh). Worker-pool menjaga
// `limit` slot tetap sibuk terus sampai antrean habis -- throughput lebih
// tinggi untuk workload heterogen kayak gini.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  const workerCount = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // TIDAK di-try/catch di sini -- kontrak fungsi ini: kalau `fn` reject,
      // rejection-nya propagate normal lewat Promise.all di bawah (dan
      // membatalkan hasil worker lain yang belum selesai, sesuai semantik
      // Promise.all standar). Pemanggil (runPipelineForSymbol di
      // fullPipeline.ts) SELALU bungkus badan fungsinya sendiri dengan
      // try/catch dan balikin objek NO_TRADE alih-alih throw, supaya di
      // praktiknya `fn` yang dioper ke sini tidak pernah reject -- satu
      // symbol gagal tidak pernah menggagalkan batch. Kontrak ini didokumentasikan
      // di sini supaya pemanggil baru sadar tanggung jawabnya ada di sisi mereka.
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}
