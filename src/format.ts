export function fmtNum(value: string | number, decimals = 4): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(num)) return String(value);
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

// Format harga dengan presisi yang menyesuaikan magnitude, supaya pair
// harga besar (BTC ~64,000) dan pair harga kecil (DODOX ~0.117) sama-sama
// terbaca dengan akurat. fmtNum(price, 2) yang lama menghancurkan presisi
// pair < $1 karena hardcode 2 desimal untuk semua pair.
export function fmtPrice(value: string | number): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(num)) return String(value);
  const abs = Math.abs(num);
  const decimals = abs === 0 ? 2 : abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function fmtPct(value: string | number, decimals = 4): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(num)) return String(value);
  return `${(num * 100).toFixed(decimals)}%`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** Hitung arah tren sederhana dari deret angka (naik/turun/flat berdasarkan titik awal vs akhir). */
export function trendDirection(values: number[]): "naik" | "turun" | "flat" {
  if (values.length < 2) return "flat";
  const first = values[0];
  const last = values[values.length - 1];
  const changePct = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0;
  if (changePct > 0.5) return "naik";
  if (changePct < -0.5) return "turun";
  return "flat";
}
