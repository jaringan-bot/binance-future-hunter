// Fungsi murni buat gating GET /admin/usage (src/index.ts) -- endpoint
// owner-only, BUKAN MCP tool (lihat migrations/0002_request_log.sql buat
// alasan privasi). Diekstrak ke sini biar testable tanpa perlu mock
// Request/D1.

// Constant-time compare -- string === biasa bisa bocorin timing info
// (return lebih cepat begitu ketemu byte pertama yang beda), remote
// timing attack via jaringan MEMANG lebih susah dari lokal tapi tetap
// bukan alasan skip mitigasi murah kayak gini.
function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  if (bytesA.length !== bytesB.length) return false;

  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

// expected undefined = fitur nonaktif (ADMIN_SECRET belum di-set) --
// SELALU balikin false, bukan "izinin semua" -- default aman.
export function isAuthorized(provided: string | null, expected: string | undefined): boolean {
  if (!expected) return false;
  if (!provided) return false;
  return timingSafeEqual(provided, expected);
}
