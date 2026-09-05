// Engine MURNI monitor integritas sinyal -- tanpa fetch, tanpa D1, tanpa KV.
// Wrapper tipisnya: src/cron/signalIntegrityCron.ts (pola pure-engine +
// thin-wrapper yang sama dengan pipelineEngine.ts / smartMoneyAnalysis.ts).
//
// ─────────────────────────────────────────────────────────────
// KENAPA FILE INI ADA
//
// Falsifikasi 2026-09-05 (docs/superpowers/plans/2026-09-05-falsifikasi-
// ranking-score.md) menemukan skor ranking Tier-1 bukan sekadar tidak
// informatif -- ia informatif dan TERPASANG TERBALIK: skor tinggi menandakan
// grid lebih sering jebol.
//
// Tapi yang lebih penting dari angkanya: cacat itu berlangsung berminggu-minggu
// TANPA SATU PUN SINYAL. Begitu juga cabang peringatan smartMoney yang tidak
// pernah menyala 0 dari 7.284 kali, dan backfill outcome yang bisa mati total
// sambil tetap melaporkan sukses. Menemukan semuanya butuh satu hari kerja
// manual: export D1, skrip analisis, uji mutasi, stratifikasi.
//
// File ini membuat pemeriksaan itu berjalan sendiri.
//
// ─────────────────────────────────────────────────────────────
// LAPOR SAJA -- KEPUTUSAN USER 2026-09-05, JANGAN DIUBAH DIAM-DIAM
//
// Monitor ini TIDAK menahan alert, TIDAK menyetel bobot, TIDAK menyentuh
// scoreTier1Signals(). Ia mengirim notifikasi dan berhenti di situ.
//
// Godaan berikutnya akan terdengar masuk akal: "kalau kita sudah tahu skornya
// terbalik, kenapa tidak sekalian dibalik otomatis?" Jawabannya: ukuran yang
// jadi dasarnya BELUM tervalidasi out-of-sample. Menjadikannya auto-corrector
// berarti mengkalibrasi otomatis di atas struktur yang belum terbukti --
// persis kesalahan yang seluruh kerja falsifikasi ini dibuat untuk
// menghindarinya. Kalau suatu saat kewenangan itu memang diberikan, ia harus
// jadi keputusan user yang eksplisit dan tercatat, bukan efek samping refactor.
// ─────────────────────────────────────────────────────────────
import type { PipelineDecisionAggregateGroup } from "./d1Client.js";
import { SCORE_BUCKET_DISPATCH_MIN, SCORE_BUCKETS, type ScoreBucket } from "./pipelineDecisionLog.js";

// ── Statistik ──────────────────────────────────────────────────────────
/**
 * Uji z dua proporsi. `null` kalau salah satu kelompok kosong atau SE nol --
 * BUKAN 0, karena 0 akan terbaca "tidak ada perbedaan" padahal artinya
 * "tidak bisa dihitung".
 *
 * KEMBARAN: scripts/falsify-ranking-score.mjs punya implementasi yang sama.
 * Batas TS/mjs membuat berbagi kode butuh kontorsi build yang tidak sepadan
 * untuk fungsi sependek ini. Pengamannya: KEDUA test dipatok ke fixture
 * referensi yang SAMA (50/100 vs 75/100 -> z = 3.7796447), jadi kalau salah
 * satu implementasi bergeser, salah satu suite merah. Duplikasi yang tidak
 * bisa menyimpang diam-diam.
 */
export function twoProportionZ(
  succA: number,
  nA: number,
  succB: number,
  nB: number,
): { pA: number; pB: number; z: number } | null {
  if (nA <= 0 || nB <= 0) return null;
  const pA = succA / nA;
  const pB = succB / nB;
  const se = Math.sqrt((pA * (1 - pA)) / nA + (pB * (1 - pB)) / nB);
  if (!(se > 0)) return null;
  return { pA, pB, z: (pB - pA) / se };
}

// ── Cek 1: backfill outcome mati diam-diam ─────────────────────────────
//
// Kegagalan yang hampir menggigit 2026-09-05: deploy mendahului migration,
// sehingga UPDATE menulis ke kolom yang belum ada. Panggilan cron dibungkus
// `.catch()` yang cuma nge-log (index.ts), jadi tick lain tetap jalan dan
// TIDAK ADA yang crash -- backfill berhenti total secara senyap, dan satu-
// satunya gejala dari luar adalah rowsWithOutcome yang tidak bertambah.
// Itu gejala yang sama persis dengan "belum matang 26 jam".
//
// ANGKA DI BAWAH BELUM DIKALIBRASI. Dipilih dari kapasitas nyata cron:
// 30 baris/tick x 288 tick/hari = 8.640/hari, sementara entry-alert menulis
// ~3.700 baris/hari. Backlog sehat mestinya mendekati nol, jadi 500 baris
// matang yang menganggur sudah menandakan aliran berhenti -- bukan sekadar
// lambat.
export const PENDING_BACKLOG_ALERT = 500;
// Di bawah ini, fraksi NULL tidak berarti apa-apa (bisa kebetulan semua
// baris terbaru memang NO_TRADE tanpa bound grid).
export const MIN_BACKFILL_SAMPLE = 50;
// Secara historis ~95% baris punya bound grid (22.759 dari 23.881 pada
// dataset 2026-08-29..09-04), jadi fraksi NULL yang mendekati 100% berarti
// kolom grid TIDAK PERNAH terisi -- bukan variasi normal.
export const GRID_NULL_ALERT_RATE = 0.95;

export type BackfillVerdict = "OK" | "STALLED" | "GRID_COLUMNS_DEAD" | "INSUFFICIENT_SAMPLE";

export interface BackfillHealthInput {
  /** Baris yang jendela 24 jam-nya SUDAH lewat tapi outcome-nya masih NULL, dan percobaannya belum habis. */
  pendingMatured: number;
  /** Baris ber-outcome di jendela terakhir (proxy "baru saja di-backfill"). */
  recentBackfilled: number;
  /** Dari `recentBackfilled`, berapa yang kolom grid-nya NULL. */
  recentGridNull: number;
}

export interface BackfillHealthResult {
  verdict: BackfillVerdict;
  gridNullRate: number | null;
  detail: string;
}

export function evaluateBackfillHealth(input: BackfillHealthInput): BackfillHealthResult {
  const { pendingMatured, recentBackfilled, recentGridNull } = input;

  // Backlog diperiksa DULU: kalau aliran berhenti, fraksi NULL dihitung atas
  // baris lama dan tidak memberitahu apa pun tentang keadaan sekarang.
  if (pendingMatured >= PENDING_BACKLOG_ALERT) {
    return {
      verdict: "STALLED",
      gridNullRate: recentBackfilled > 0 ? recentGridNull / recentBackfilled : null,
      detail:
        `${pendingMatured} baris sudah matang (>26 jam) tapi outcome-nya masih NULL ` +
        `(ambang ${PENDING_BACKLOG_ALERT}). Backfill outcome berhenti mengalir -- cek log cron ` +
        "backfillPipelineDecisionOutcomes; error D1 di sana cuma di-log, tidak pernah melempar.",
    };
  }

  if (recentBackfilled < MIN_BACKFILL_SAMPLE) {
    return {
      verdict: "INSUFFICIENT_SAMPLE",
      gridNullRate: null,
      detail: `cuma ${recentBackfilled} baris ber-outcome di jendela ini (minimum ${MIN_BACKFILL_SAMPLE}) -- belum bisa dinilai.`,
    };
  }

  const gridNullRate = recentGridNull / recentBackfilled;
  if (gridNullRate >= GRID_NULL_ALERT_RATE) {
    return {
      verdict: "GRID_COLUMNS_DEAD",
      gridNullRate,
      detail:
        `${(gridNullRate * 100).toFixed(1)}% baris yang baru di-backfill punya kolom grid NULL ` +
        `(ambang ${(GRID_NULL_ALERT_RATE * 100).toFixed(0)}%), padahal forward return-nya terisi. ` +
        "Gejala khas: lower_price/upper_price tidak ikut di-SELECT queryPendingPipelineDecisionOutcomes, " +
        "sehingga evaluateGridOutcome() menerima undefined dan mengembalikan null untuk SETIAP baris.",
    };
  }

  return {
    verdict: "OK",
    gridNullRate,
    detail: `${recentBackfilled} baris ber-outcome, ${(gridNullRate * 100).toFixed(1)}% tanpa metrik grid, backlog ${pendingMatured}.`,
  };
}

// ── Cek 2: daya pisah skor hilang / terbalik ───────────────────────────
//
// Membandingkan tingkat "grid keluar range" untuk symbol DI ATAS gate alert
// vs DI BAWAHNYA. Pemisahnya sengaja SCORE_BUCKET_DISPATCH_MIN, bukan ambang
// TRADE 55: yang ingin dijawab adalah "apakah yang benar-benar kita kirimkan
// ke manusia berperilaku lebih baik", dan ambang 55 praktis tak pernah
// tercapai (4 dari 23.881 -- lihat T1).
//
// ARAH: `exited` = harga keluar range = grid gagal. Skor yang bekerja
// mestinya punya exit rate LEBIH RENDAH di kelompok tinggi.
export const MIN_BUCKET_SAMPLE = 100;
// |z| di bawah ini dianggap tidak memisahkan. 2 dipilih sebagai ambang
// konvensional dua-sisi ~5%; BELUM DIKALIBRASI terhadap laju false-positive
// yang sebenarnya di jendela mingguan.
export const SEPARATION_Z = 2;

export type DiscriminatingVerdict = "OK" | "NO_SEPARATION" | "INVERTED" | "INSUFFICIENT_SAMPLE";

export interface DiscriminatingPowerResult {
  verdict: DiscriminatingVerdict;
  lowExitRate: number | null;
  highExitRate: number | null;
  lowKnown: number;
  highKnown: number;
  z: number | null;
  detail: string;
}

/**
 * `groups` adalah `byScoreBucket` dari queryPipelineDecisionAggregates().
 * Bucket digabung jadi dua sisi gate dispatch.
 */
export function evaluateDiscriminatingPower(groups: PipelineDecisionAggregateGroup[]): DiscriminatingPowerResult {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const side = (keys: readonly ScoreBucket[]) =>
    keys.reduce(
      (acc, k) => {
        const g = byKey.get(k);
        return g ? { known: acc.known + g.gridKnown, exited: acc.exited + g.gridExited } : acc;
      },
      { known: 0, exited: 0 },
    );

  // Dua bucket pertama di bawah gate, dua terakhir di atas/di gate.
  // Diturunkan dari SCORE_BUCKETS supaya menggeser batas tidak diam-diam
  // memindahkan symbol ke sisi yang salah.
  const low = side([SCORE_BUCKETS[0], SCORE_BUCKETS[1]]);
  const high = side([SCORE_BUCKETS[2], SCORE_BUCKETS[3]]);

  if (low.known < MIN_BUCKET_SAMPLE || high.known < MIN_BUCKET_SAMPLE) {
    return {
      verdict: "INSUFFICIENT_SAMPLE",
      lowExitRate: low.known ? low.exited / low.known : null,
      highExitRate: high.known ? high.exited / high.known : null,
      lowKnown: low.known,
      highKnown: high.known,
      z: null,
      detail:
        `sampel terukur belum cukup (rendah ${low.known}, tinggi ${high.known}, minimum ${MIN_BUCKET_SAMPLE} per sisi). ` +
        "Kolom grid baru terisi sejak migration 0017 di-deploy, jadi ini normal di hari-hari awal.",
    };
  }

  const zr = twoProportionZ(low.exited, low.known, high.exited, high.known);
  if (!zr) {
    return {
      verdict: "INSUFFICIENT_SAMPLE",
      lowExitRate: low.exited / low.known,
      highExitRate: high.exited / high.known,
      lowKnown: low.known,
      highKnown: high.known,
      z: null,
      detail: "standard error nol (kedua sisi tanpa variasi) -- tidak bisa diuji.",
    };
  }

  const base = {
    lowExitRate: zr.pA,
    highExitRate: zr.pB,
    lowKnown: low.known,
    highKnown: high.known,
    z: zr.z,
  };
  const rates =
    `keluar-range skor rendah ${(zr.pA * 100).toFixed(2)}% (n=${low.known}) vs ` +
    `skor tinggi ${(zr.pB * 100).toFixed(2)}% (n=${high.known}), z=${zr.z.toFixed(2)}`;

  if (Math.abs(zr.z) < SEPARATION_Z) {
    return { ...base, verdict: "NO_SEPARATION", detail: `${rates} -- skor tidak memisahkan apa pun.` };
  }
  if (zr.z > 0) {
    // pB > pA: skor TINGGI lebih sering jebol.
    return {
      ...base,
      verdict: "INVERTED",
      detail: `${rates} -- skor tinggi justru LEBIH SERING jebol. Ini pola yang sama dengan temuan 2026-09-05.`,
    };
  }
  return { ...base, verdict: "OK", detail: `${rates} -- skor tinggi lebih jarang jebol, sesuai harapan.` };
}

/** Verdict yang layak mengganggu manusia. `OK` dan `INSUFFICIENT_SAMPLE` tidak. */
export function isAlertworthy(verdict: BackfillVerdict | DiscriminatingVerdict): boolean {
  return verdict !== "OK" && verdict !== "INSUFFICIENT_SAMPLE";
}

export { SCORE_BUCKET_DISPATCH_MIN };
