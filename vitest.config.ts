import { defineConfig } from "vitest/config";

// Vitest cari config ke atas kalau gak nemu di sini -- tanpa file ini,
// kalau repo di-clone di dalam direktori yang punya vitest.config.ts lain
// (misal project sebelah dengan struktur beda), test run bisa salah ambil
// `include` pattern punya project itu dan nemu 0 test file.
export default defineConfig({
  test: {
    // scripts/**/*.test.mjs: script standalone (scripts/*.mjs) sengaja
    // TIDAK di-typecheck (di luar tsconfig include) tapi bagian pure-nya
    // tetap dites -- lihat scripts/calibrate-ranking-weights.test.mjs.
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
