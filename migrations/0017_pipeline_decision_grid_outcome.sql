-- F2 (2026-09-05, Fase 1 falsifikasi): persist metrik grid-native ke
-- pipeline_decision_log.
--
-- LATAR: seluruh evaluasi skor ranking selama ini bersandar pada
-- `forward_return_*` (return ARAH) dan `sl_touched_24h`. Keduanya PROXY.
-- Grid bot tidak menghasilkan uang dari arah, melainkan dari osilasi di
-- dalam range: pair yang naik 8% lurus adalah forward return besar sekaligus
-- grid yang GAGAL (harga keluar range, posisi tersangkut di batas atas),
-- sementara pair yang bolak-balik lalu tutup di harga sama punya forward
-- return 0 dan grid yang panen sepanjang hari.
--
-- evaluateGridOutcome() (src/tools/pipelineDecisionBacktest.ts) SUDAH
-- menghitung ukuran yang benar sejak Stage 4, tapi hasilnya cuma hidup di
-- dalam tool on-demand: dihitung, ditampilkan, lalu dibuang. Akibatnya
-- agregat grid-native hanya bisa dihitung atas "sampel detail" <= 80 baris
-- terbaru -- yang dalam praktiknya cuma 1-2 tick entry-alert, dan baris
-- dalam satu tick berbagi kondisi pasar sehingga BUKAN observasi independen.
-- Bandingkan dengan `sl_touched_24h` yang dipersist: ia bisa diagregasi SQL
-- atas 22.492 baris, dan justru itulah yang membongkar inversi skor
-- (docs/superpowers/plans/2026-09-05-falsifikasi-ranking-score.md, Bagian D).
--
-- Kolom di bawah menutup jarak itu. Diisi pipelineDecisionOutcomeCron.ts
-- dari candle YANG SAMA yang sudah di-fetch untuk forward_return_* --
-- NOL subrequest tambahan.
--
-- NULLABLE, dan itu disengaja (pola sama 0013/0014/0015, beda dari 0016):
-- NULL berarti "TIDAK DIUKUR", bukan "diukur, hasilnya nol". Ada tiga sebab
-- sah sebuah baris tetap NULL selamanya:
--   1. baris pra-migration ini (backfill hanya jalan untuk baris yang
--      forward_return_24h-nya masih NULL, jadi baris lama tidak diisi ulang)
--   2. lower_price / upper_price NULL -- keputusan NO_TRADE yang gagal
--      hard-screen sebelum bound grid sempat dihitung
--   3. bound degenerate (upper <= lower) -> deriveGridShape() mengembalikan
--      null
-- Memakai DEFAULT 0 akan mencampur ketiganya dengan "grid bertahan penuh di
-- dalam range", dan itu kebohongan yang persis sejenis dengan yang sedang
-- diperbaiki dokumen ini.
--
-- Jendela = 24 jam, SAMA dengan sl_touched_24h, supaya keduanya bisa
-- dibandingkan langsung tanpa penyesuaian jendela.
ALTER TABLE pipeline_decision_log ADD COLUMN grid_exited_range INTEGER;
ALTER TABLE pipeline_decision_log ADD COLUMN grid_exited_above INTEGER;
ALTER TABLE pipeline_decision_log ADD COLUMN grid_exited_below INTEGER;
ALTER TABLE pipeline_decision_log ADD COLUMN grid_time_in_range_pct REAL;

-- Proxy sisi UNTUNG, pelengkap ketiga kolom "jebol" di atas: fraksi candle
-- 5m yang range-nya (high-low) >= satu step grid. Bukan bukti match penuh
-- terjadi -- tidak ada order book, antrian, atau fee di sini -- tapi tanpa
-- satu pun ukuran sisi untung, optimasi apa pun akan meminimalkan
-- "keluar range" dengan cara memilih pair yang tidak bergerak sama sekali,
-- yaitu grid yang aman DAN tidak menghasilkan apa-apa.
ALTER TABLE pipeline_decision_log ADD COLUMN grid_crossing_rate REAL;
