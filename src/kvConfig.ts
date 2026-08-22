// Wrapper tipis di atas Workers KV (binding CONFIG_KV, lihat wrangler.toml)
// buat nyimpen config/state ringan: threshold per-pair custom
// (src/tools/config.ts) dan histori basis time-series (src/tools/basisHistory.ts
// + scheduled handler di src/index.ts).
//
// Pola module-level setter sama seperti coinalyzeClient.setApiKey() dan
// binanceProxyClient.setProxyConfig() -- di-set sekali di awal fetch()/
// scheduled() sebelum tool logic jalan.
let kv: KVNamespace | undefined;

export function setKvNamespace(namespace: KVNamespace | undefined): void {
  kv = namespace;
}

export class KvNotConfiguredError extends Error {
  constructor() {
    super(
      "CONFIG_KV belum ke-bind di worker. Cek [[kv_namespaces]] di wrangler.toml sudah benar dan worker sudah di-deploy ulang.",
    );
    this.name = "KvNotConfiguredError";
  }
}

function requireKv(): KVNamespace {
  if (!kv) throw new KvNotConfiguredError();
  return kv;
}

export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await requireKv().get(key);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

export async function putJson(key: string, value: unknown, options?: { expirationTtl?: number }): Promise<void> {
  await requireKv().put(key, JSON.stringify(value), options);
}

// Cloudflare KV list() default page size (1000) TIDAK di-paginate di sini --
// volume key yang diharapkan (query-frequency counter, lihat queryFrequency.ts)
// jauh di bawah itu. Kalau suatu saat melebihi, hasil silently terpotong --
// dicatat sebagai batasan yang diterima di skala saat ini, bukan bug.
export async function listKeys(prefix: string): Promise<string[]> {
  const result = await requireKv().list({ prefix });
  return result.keys.map((k) => k.name);
}
