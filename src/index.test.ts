// Routing entry Worker. Fokus SEMPIT: kontrak HTTP root `/` -- bagian yang
// dilihat monitor uptime eksternal, dan satu-satunya jalur di index.ts yang
// return sebelum menyentuh D1/KV/relay, jadi bisa dites tanpa harness penuh.
//
// Latar: 2026-09-05 monitor melaporkan worker "DOWN (HTTP 404)" berulang
// lewat Telegram, padahal worker sehat. Sebabnya `/` dulu hanya cocok untuk
// GET; HEAD -- default banyak layanan uptime karena hemat bandwidth -- jatuh
// ke catch-all 404 di bawah. Test ini mengunci HEAD supaya tidak diam-diam
// balik jadi 404.
import { describe, it, expect } from "vitest";
import worker from "./index.js";

const ENV = {} as never;
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

async function call(method: string, path = "/"): Promise<Response> {
  return worker.fetch(new Request(`https://example.workers.dev${path}`, { method }), ENV, CTX);
}

describe("Worker root routing", () => {
  it("GET / -> 200 + body status ok", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const json = (await res.json()) as { status: string; endpoint: string };
    expect(json.status).toBe("ok");
    expect(json.endpoint).toBe("/mcp");
  });

  // Guard inti. Kalau ini merah, monitor uptime akan melaporkan DOWN palsu.
  it("HEAD / -> 200, TANPA body, header sama seperti GET", async () => {
    const res = await call("HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.text()).toBe("");
  });

  it("HEAD dan GET melaporkan Content-Length yang sama", async () => {
    const [get, head] = [await call("GET"), await call("HEAD")];
    const bodyLen = String(new TextEncoder().encode(await get.text()).length);
    expect(head.headers.get("Content-Length")).toBe(bodyLen);
  });

  // Catch-all TIDAK boleh ikut longgar: perbaikan di atas khusus `/`.
  it("path tak dikenal tetap 404, untuk GET maupun HEAD", async () => {
    expect((await call("GET", "/tidak-ada")).status).toBe(404);
    expect((await call("HEAD", "/tidak-ada")).status).toBe(404);
  });

  it("POST / tetap 404 -- root bukan endpoint MCP", async () => {
    expect((await call("POST")).status).toBe(404);
  });

  it("OPTIONS / -> 204 preflight CORS", async () => {
    expect((await call("OPTIONS")).status).toBe(204);
  });
});
