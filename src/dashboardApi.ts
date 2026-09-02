// Dashboard read-only -- di-serve dari Worker yang SAMA (bukan Cloudflare
// Pages terpisah, biar tidak nambah resource yang harus di-provision).
// Semua endpoint + halaman HTML di-gate `?key=<ADMIN_SECRET>` persis pola
// GET /admin/usage (isAuthorized, adminUsage.ts) -- ini dashboard owner,
// BUKAN publik. Reuse query function d1Client yang sudah ada; TIDAK ada
// query D1 baru.
import { isAuthorized } from "./adminUsage.js";
import {
  queryPipelineDecisionLog,
  querySignalHistory,
  queryHyperliquidWhaleRecentByCoin,
} from "./d1Client.js";
import { getDailyLossCircuit, getMacroRiskCircuit } from "./engine/riskCircuitBreaker.js";

export interface DashboardEnv {
  ADMIN_SECRET?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hoursParam(url: URL, fallback = 24): number {
  const h = Number(url.searchParams.get("hours"));
  return Number.isFinite(h) && h > 0 && h <= 24 * 30 ? h : fallback;
}

/**
 * Handle GET /api/dashboard/* dan GET /dashboard. Return null kalau path
 * bukan urusan dashboard (biar caller lanjut ke handler lain). Semua path
 * di sini gated `?key=` -- 403 generic kalau gagal (tidak bocorkan apakah
 * ADMIN_SECRET di-set), sama seperti /admin/usage.
 */
export async function handleDashboardRequest(url: URL, env: DashboardEnv): Promise<Response | null> {
  const path = url.pathname;
  if (path !== "/dashboard" && !path.startsWith("/api/dashboard/")) return null;

  if (!isAuthorized(url.searchParams.get("key"), env.ADMIN_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }

  if (path === "/dashboard") {
    return new Response(DASHBOARD_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  try {
    switch (path) {
      case "/api/dashboard/pipeline-decisions": {
        const hours = hoursParam(url);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 200);
        const now = Date.now();
        const rows = await queryPipelineDecisionLog({
          startTime: now - hours * 3_600_000,
          endTime: now,
          symbol: url.searchParams.get("symbol") ?? undefined,
          limit,
        });
        return json({ hours, count: rows.length, rows });
      }
      case "/api/dashboard/signals": {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) return json({ error: "param `symbol` wajib untuk endpoint ini" }, 400);
        const hours = hoursParam(url);
        const now = Date.now();
        const rows = await querySignalHistory(symbol, url.searchParams.get("type") ?? "all", now - hours * 3_600_000, now);
        return json({ symbol: symbol.toUpperCase(), hours, count: rows.length, rows });
      }
      case "/api/dashboard/whales": {
        const coin = (url.searchParams.get("coin") ?? "BTC").toUpperCase();
        const rows = await queryHyperliquidWhaleRecentByCoin(coin);
        return json({ coin, count: rows.length, rows });
      }
      case "/api/dashboard/circuit-breaker": {
        const [dailyLoss, macro] = await Promise.all([getDailyLossCircuit(), getMacroRiskCircuit()]);
        return json({ dailyLoss, macro });
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  } catch (err) {
    return json({ error: (err as Error)?.message ?? String(err) }, 500);
  }
}

// Satu halaman statis, vanilla fetch() + render tabel. TIDAK ada build
// step / framework (konsisten dengan minimal-deps repo ini). Key diambil
// dari `?key=` URL sendiri lalu diteruskan ke tiap panggilan /api/dashboard/*.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>binance-future-hunter — dashboard</title>
<style>
  :root { color-scheme: light dark; --bd: #8884; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  .muted { opacity: .65; font-size: .85em; }
  section { margin-top: 1.5rem; }
  h2 { font-size: .95rem; margin: 0 0 .5rem; border-bottom: 1px solid var(--bd); padding-bottom: .25rem; }
  .controls { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: .5rem 0; }
  input, button { font: inherit; padding: .25rem .4rem; }
  table { border-collapse: collapse; width: 100%; overflow-x: auto; display: block; }
  th, td { border: 1px solid var(--bd); padding: .2rem .4rem; text-align: right; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  .err { color: #c0392b; }
  pre { background: #8881; padding: .5rem; overflow-x: auto; }
</style>
</head>
<body>
<h1>binance-future-hunter</h1>
<div class="muted">Read-only. Data via <code>/api/dashboard/*</code> (gated <code>?key=</code>). Auto-refresh 60s.</div>

<section>
  <h2>Circuit breaker</h2>
  <pre id="cb">…</pre>
</section>

<section>
  <h2>Pipeline decisions</h2>
  <div class="controls">
    <label>hours <input id="pd-hours" type="number" value="24" min="1" max="720" style="width:5rem"></label>
    <label>symbol <input id="pd-symbol" placeholder="(semua)" style="width:8rem"></label>
    <button onclick="loadPipeline()">muat</button>
  </div>
  <div id="pd">…</div>
</section>

<section>
  <h2>Signals</h2>
  <div class="controls">
    <label>symbol <input id="sig-symbol" value="BTCUSDT" style="width:8rem"></label>
    <label>hours <input id="sig-hours" type="number" value="24" min="1" max="720" style="width:5rem"></label>
    <button onclick="loadSignals()">muat</button>
  </div>
  <div id="sig">…</div>
</section>

<section>
  <h2>Hyperliquid whales</h2>
  <div class="controls">
    <label>coin <input id="wh-coin" value="BTC" style="width:5rem"></label>
    <button onclick="loadWhales()">muat</button>
  </div>
  <div id="wh">…</div>
</section>

<script>
const KEY = new URLSearchParams(location.search).get("key") || "";
const api = (p) => fetch(p + (p.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(KEY)).then(r => r.json());
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function table(rows) {
  if (!rows || !rows.length) return '<div class="muted">(kosong)</div>';
  const cols = Object.keys(rows[0]);
  const head = "<tr>" + cols.map(c => "<th>" + esc(c) + "</th>").join("") + "</tr>";
  const body = rows.map(r => "<tr>" + cols.map(c => "<td>" + esc(r[c] ?? "") + "</td>").join("") + "</tr>").join("");
  return "<table>" + head + body + "</table>";
}
function fail(id, e) { document.getElementById(id).innerHTML = '<div class="err">' + esc(e && e.message || e) + '</div>'; }

async function loadCircuit() {
  try { document.getElementById("cb").textContent = JSON.stringify(await api("/api/dashboard/circuit-breaker"), null, 2); }
  catch (e) { fail("cb", e); }
}
async function loadPipeline() {
  try {
    const h = document.getElementById("pd-hours").value || 24;
    const s = document.getElementById("pd-symbol").value.trim();
    const d = await api("/api/dashboard/pipeline-decisions?hours=" + h + (s ? "&symbol=" + encodeURIComponent(s) : ""));
    document.getElementById("pd").innerHTML = (d.error ? '<div class="err">' + esc(d.error) + '</div>' : '<div class="muted">' + d.count + ' baris</div>' + table(d.rows));
  } catch (e) { fail("pd", e); }
}
async function loadSignals() {
  try {
    const s = document.getElementById("sig-symbol").value.trim() || "BTCUSDT";
    const h = document.getElementById("sig-hours").value || 24;
    const d = await api("/api/dashboard/signals?symbol=" + encodeURIComponent(s) + "&hours=" + h);
    document.getElementById("sig").innerHTML = (d.error ? '<div class="err">' + esc(d.error) + '</div>' : '<div class="muted">' + d.count + ' baris</div>' + table(d.rows));
  } catch (e) { fail("sig", e); }
}
async function loadWhales() {
  try {
    const c = document.getElementById("wh-coin").value.trim() || "BTC";
    const d = await api("/api/dashboard/whales?coin=" + encodeURIComponent(c));
    document.getElementById("wh").innerHTML = (d.error ? '<div class="err">' + esc(d.error) + '</div>' : '<div class="muted">' + d.count + ' baris</div>' + table(d.rows));
  } catch (e) { fail("wh", e); }
}
function loadAll() { loadCircuit(); loadPipeline(); loadSignals(); loadWhales(); }
loadAll();
setInterval(loadAll, 60000);
</script>
</body>
</html>`;
