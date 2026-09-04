// gridSmartMoneyAdapter.ts
//
// ─────────────────────────────────────────────────────────────
// K7 (2026-09-04, Stage 3) -- DEAD CODE DIHAPUS + KONFLIK REGIME
// DISELESAIKAN.
//
// File ini DULU berisi "Grid Bot Smart Money Adapter V2":
// evaluateGridSmartMoney(), computeGridSafetyScore(), regimeSafetyScore(),
// oiGuardScore(), plus bobot & threshold -- lengkap dengan test, tapi
// **tidak pernah dipanggil di produksi**. fullPipeline.ts hanya mengimpor
// TIPE `GridSmDecision` di bawah, lalu menghitung nilainya dengan aturan
// ad-hoc inline sendiri.
//
// Lebih buruk dari sekadar menganggur: tabel REGIME_SAFETY di dalamnya
// MEMBERI NILAI BERLAWANAN dengan REGIME_FAVORABILITY di pipelineEngine.ts
// yang benar-benar jalan --
//
//     Regime         | REGIME_FAVORABILITY (produksi) | REGIME_SAFETY (mati)
//     ACCUMULATION   | 0.9  "kondusif"                | 30  "bahaya, pre-breakout"
//     DISTRIBUTION   | 0.7  "kondusif"                | 20  "bahaya"
//
// Dua sumber kebenaran yang saling bertentangan di repo yang sama, tanpa
// dokumen yang menengahi. Konflik itu diselesaikan di pipelineEngine.ts
// (lihat blok K7 di sana): favorability ACCUMULATION/DISTRIBUTION
// DITURUNKAN, karena definisi classifyRegime() sendiri untuk kedua regime
// itu adalah "OI membangun sementara harga flat" -- pola PRA-BREAKOUT, yang
// untuk grid range-bound berarti risiko keluar range naik.
//
// Untuk menghidupkan engine ini lagi: ambil dari riwayat git (branch
// claude/stage-3-signal-quality, commit induk).
// ─────────────────────────────────────────────────────────────

/**
 * Keputusan Grid Bot dari sudut pandang Smart Money. Saat ini hanya
 * `GRID_NO_TRADE` yang diproduksi, oleh aturan inline di fullPipeline.ts
 * (grid NO_TRADE + regime breakout/trending), dan dikonsumsi
 * dcaSmartMoneyAdapter sebagai cross-product guard.
 */
export type GridSmDecision = "GRID_TRADE" | "GRID_WATCH" | "GRID_NO_TRADE" | "GRID_REGRID_SUGGESTED";
