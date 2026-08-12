// Symbol Binance-style (BTCUSDT) dipakai sebagai input universal buat
// whalescope_compare_funding_across_exchanges -- fungsi murni di sini
// nerjemahin ke format masing-masing exchange. Cuma pair *USDT perpetual
// yang didukung (sesuai symbolSchema di shared.ts); exchange lain balikin
// null kalau gak bisa di-derive, BUKAN throw -- biar tool caller bisa skip
// exchange itu tanpa gagalin seluruh panggilan.
export type CrossExchange = "bybit" | "okx" | "hyperliquid";

export function toExchangeSymbol(binanceSymbol: string, exchange: CrossExchange): string | null {
  const upper = binanceSymbol.toUpperCase();

  // Bybit linear perpetual pakai format IDENTIK sama Binance (BTCUSDT).
  if (exchange === "bybit") return upper;

  // OKX & Hyperliquid butuh base asset murni (BTC dari BTCUSDT) --
  // cuma pair *USDT yang bisa di-derive dengan aman.
  if (!upper.endsWith("USDT")) return null;
  const base = upper.slice(0, -4);
  if (!base) return null;

  if (exchange === "okx") return `${base}-USDT-SWAP`;
  return base; // hyperliquid: base asset doang, semua perp cross-margined USDC
}
