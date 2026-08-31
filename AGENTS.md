# Agent notes — WhaleScope MCP

## Formula grid pipeline: dibekukan selama uji (2026-08-31)

Hipotesis terpasang, bukan klaim sudah benar. **Jangan ubah** angka ini sampai protokol terpenuhi:

- Bobot ranking: MM 35 / smart money 30 / regime 20 / buy pressure 15 (`src/pipelineEngine.ts`)
- Ambang TRADE: 55
- Hard screen: volume quote 24h ≥ $5,000,000, |funding| ≤ 0.05%

Protokol:

1. 0 TRADE di satu hari risk-off bukan bukti rumus rusak/benar.
2. Peek 24 jam: baca log / `whalescope_backtest_pipeline_decisions` saja. Jangan retune.
3. Review serius di **14 hari**. 30/90 hari = retensi D1, bukan jadwal tunda baca.
4. Jangan retune sampai ≥20 TRADE dengan forward return 4h **dan** 24h selesai, lintas ≥3 rezim 4h berbeda.
5. 14 hari TRADE tetap 0 **adalah hasil tes** (55 terlalu ketat) — baru boleh dibahas longgarkan.

Detail: `docs/full_pipeline_framework.md` §16 (EN: `docs/full_pipeline_framework.en.md` §12).
