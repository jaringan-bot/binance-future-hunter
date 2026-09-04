// smartMoneyPipelineEngine.ts -- fungsi murni bersama untuk head Smart
// Money. NOL subrequest.
//
// ─────────────────────────────────────────────────────────────
// K7 (2026-09-04, Stage 3) -- DEAD CODE DIHAPUS.
//
// File ini DULU berisi "Smart Money Core Engine V2": evaluateSmartMoneyEntry()
// dengan 3 skenario (Squeeze / Sweep / Divergence), bobot, threshold, dan
// filter regime -- ~90 baris LENGKAP DENGAN TEST, tapi **tidak pernah
// dipanggil di produksi**. Satu-satunya penyebutnya adalah definisinya
// sendiri dan test-nya; fullPipeline.ts cuma mengimpor TIPE `GridSmDecision`
// lalu membuat aturan ad-hoc inline sendiri.
//
// Dead code yang punya test memberi ILUSI CAKUPAN: suite terlihat hijau dan
// "teruji" padahal yang diuji tidak pernah jalan. Itu bagian dari kenapa 849
// test hijau bisa hidup berdampingan dengan seluruh cacat di
// docs/superpowers/plans/2026-09-04-signal-integrity-remediation.md.
//
// Ikut terhapus karena hanya dipakai engine itu: SQUEEZE_W, SWEEP_W,
// consolidationScore(), slopeRatioScore(), SmartMoneyInput/Result,
// SmartMoneyDecision/Scenario, filter isStrongTrending().
//
// Untuk menghidupkannya lagi: ambil dari riwayat git (branch
// claude/stage-3-signal-quality, commit induk) -- jangan dibiarkan
// menganggur di tree sambil menipu metrik cakupan.
// ─────────────────────────────────────────────────────────────

function clamp100(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 100 ? 100 : x;
}

// ─────────────────────────────────────────────────────────────
// K3 (2026-09-04, Stage 3) -- KOMPONEN SPOT PALSU DIBUANG, NAMANYA
// DIJUJURKAN.
//
// CACAT LAMA: fungsi ini bernama calculateScenarioC() dan diiklankan sebagai
// "Spot vs Futures CVD divergence", dengan bobot terbesar (0.5) pada
// slopeRatioScore(slopeSpot, slopeFutures). Tapi satu-satunya pemanggil
// produksi (dcaSmartMoneyAdapter.ts) membangun input-nya begini:
//
//     slopeSpot: slopeFutures * 0.85
//
// Data spot TIDAK PERNAH di-fetch -- angkanya DIKARANG dari slope futures
// dengan konstanta tetap. Konsekuensinya:
//
//     slopeRatioScore(0.85*s, s) = min(100, 0.85 * 33) = 28.05   KONSTAN
//
// apapun kondisi pasar, arah apapun, pair apapun. Separuh skor "divergence"
// adalah konstanta, dan S_C jadi terkurung di [14.0, 64.0] -- tidak pernah
// bisa > 64. Itu salah satu sebab DCA_TRADE (butuh timing >= 75) nyaris
// mustahil terbit, bersama K4.
//
// PERBAIKAN: komponen slopeRatio dibuang seluruhnya. Tanpa data spot ini
// BUKAN divergence spot-vs-futures -- menyebutnya begitu adalah klaim yang
// tidak didukung data. Namanya jadi FLOW ALIGNMENT: sejauh mana arus taker
// dan keselarasan multi-timeframe searah.
//
// DEFERRED (bukan dilupakan): divergence spot-vs-futures yang SUNGGUHAN
// butuh sumber data spot. `getSpotKlinesNative` sudah ada, tapi biayanya
// +1 subrequest/symbol dan banyak perp tidak listed di Spot.
//
// BOBOT BARU BELUM DIKALIBRASI -- 0.5 milik slopeRatio dibagi proporsional
// ke dua komponen yang datanya nyata (0.3 : 0.2 -> 0.6 : 0.4), bukan hasil
// fitting. Stage 4 yang mengkalibrasi dengan data.
// ─────────────────────────────────────────────────────────────
export const FLOW_ALIGNMENT_W = { takerFlow: 0.6, multiTf: 0.4 };

export interface FlowAlignmentInput {
  /** Taker buy ratio ternormalisasi 0-100. Saat ini CVD FUTURES, bukan spot. */
  takerFlowNorm: number;
  /** MultiTF alignment 0/50/100 (smartMoneyMetrics.multiTfAlignScore, 1h+4h). */
  multiTfAlign: number;
}

/** Flow-alignment sub-score 0-100. Dulu `calculateScenarioC` -- lihat K3. */
export function calculateFlowAlignment(i: FlowAlignmentInput): number {
  return clamp100(
    FLOW_ALIGNMENT_W.takerFlow * clamp100(i.takerFlowNorm) + FLOW_ALIGNMENT_W.multiTf * clamp100(i.multiTfAlign),
  );
}
