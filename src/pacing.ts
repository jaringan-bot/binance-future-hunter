// Sleep kecil dipisah jadi modul sendiri (bukan cuma di retry.ts) supaya
// entryAlertCron.ts bisa mock-nya di test tanpa nunggu waktu asli.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
