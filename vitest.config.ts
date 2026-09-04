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
    // stream-gateway/**/*.test.mjs SENGAJA TIDAK di sini. File-file itu
    // memakai `node:test` (`import { test } from "node:test"`), bukan API
    // vitest -- gateway adalah deployable zero-dep yang harus bisa dites di
    // VPS dengan `node --test` polos, tanpa vitest terpasang. Menambahkan
    // glob-nya ke sini TIDAK bekerja: callback-nya mendaftar ke runner Node
    // yang tidak pernah jalan di bawah vitest, hasilnya `No test suite found`
    // untuk kelima file. Karena itu ke-59 test gateway dijalankan lewat
    // runner-nya sendiri dari script `test` di package.json root, dan
    // `npm test` tetap menjalankan keduanya. Lihat juga `npm run test:worker`
    // (vitest saja) dan `npm run test:gateway` (gateway saja).
  },
});
