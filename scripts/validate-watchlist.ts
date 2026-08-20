// scripts/validate-watchlist.ts (script baru, jalankan manual sebelum deploy,
// TIDAK dijalankan otomatis oleh worker)
import { SNAPSHOT_WATCHLIST } from "../src/shared.js";

async function validateSymbol(symbol: string): Promise<boolean> {
  const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
  return res.ok;
}

async function main() {
  const results = await Promise.all(
    SNAPSHOT_WATCHLIST.map(async (symbol) => ({
      symbol,
      valid: await validateSymbol(symbol),
    })),
  );
  const invalid = results.filter((r) => !r.valid);
  if (invalid.length > 0) {
    console.error("Symbol tidak valid/delisted:", invalid.map((r) => r.symbol).join(", "));
    process.exit(1);
  }
  console.log(`Semua ${SNAPSHOT_WATCHLIST.length} simbol tervalidasi.`);
}

main();
