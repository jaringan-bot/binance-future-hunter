#!/usr/bin/env node
// Token-efficiency audit script for binance-future-hunter.
//
// Measures three things against the LIVE deployed worker (not a mock):
//   1. Tool DEFINITION size (schema cost) -- paid once per Claude session
//      when the tool list is loaded, regardless of how many tools get called.
//   2. Tool RESPONSE size across input scales -- paid every tool call,
//      scales (or doesn't) with the `limit` parameter.
//   3. Information Density Ratio -- how much of a response's text is
//      actual data (numbers, timestamps, symbols) vs. boilerplate
//      (markdown structure, static disclaimer prose).
//
// Also runs one simulated multi-turn conversation (a realistic sequence
// of tool calls an analysis session would actually make) and logs the
// cumulative token cost turn-by-turn.
//
// TOKEN ESTIMATION CAVEAT: there is no publicly published Claude
// tokenizer package, so this uses the standard chars/4 approximation
// used throughout this project's token-efficiency audit. Treat all
// numbers here as APPROXIMATE, useful for relative comparison
// (before/after, tool A vs tool B) rather than exact counts.
//
// Usage: node scripts/token-audit.mjs
// Not part of `npm test` / CI -- this hits the live worker (and therefore
// Binance/Coinalyze through it), same "manual verification" convention
// documented in README.md for this repo.

const WORKER_URL = "https://binance-future-hunter.jaringan.dev/mcp";
const CHARS_PER_TOKEN = 4; // documented approximation, see header comment

function estimateTokens(str) {
  return Math.ceil(str.length / CHARS_PER_TOKEN);
}

function fmtTokens(n) {
  return `~${n.toLocaleString("en-US")} tok`;
}

async function rpc(method, params) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await res.text();
  const dataLine = raw.split("data: ")[1] ?? raw; // handle both SSE and plain JSON
  const parsed = JSON.parse(dataLine);
  return { parsed, raw, rawBytes: raw.length };
}

async function callTool(name, args) {
  const { parsed, raw, rawBytes } = await rpc("tools/call", { name, arguments: args });
  if (parsed.error) throw new Error(`${name}: JSON-RPC error: ${parsed.error.message}`);
  const result = parsed.result;
  const text = result?.content?.[0]?.text ?? "";
  return { result, text, raw, rawBytes, tokens: estimateTokens(raw) };
}

// ── Metric 1: tool definition (schema) size ──────────────────────────────
async function auditSchemaSize() {
  const { parsed, rawBytes } = await rpc("tools/list", {});
  const tools = parsed.result.tools;
  const perTool = tools
    .map((t) => {
      const json = JSON.stringify(t);
      return { name: t.name, chars: json.length, tokens: estimateTokens(json) };
    })
    .sort((a, b) => b.tokens - a.tokens);
  const totalTokens = perTool.reduce((sum, t) => sum + t.tokens, 0);

  console.log("\n=== 1. TOOL DEFINITION SIZE (schema cost, paid once per session) ===");
  console.log(`Total tools: ${tools.length}`);
  console.log(`Total schema size: ${rawBytes.toLocaleString()} bytes, ${fmtTokens(totalTokens)}`);
  console.log(`\nTop 5 largest tool definitions:`);
  for (const t of perTool.slice(0, 5)) {
    console.log(`  ${t.name.padEnd(35)} ${fmtTokens(t.tokens).padStart(12)}`);
  }
  return { totalTokens, perTool };
}

// ── Metric 2: response size across input scales ──────────────────────────
async function auditScaling() {
  console.log("\n=== 2. RESPONSE SIZE ACROSS INPUT SCALES ===");
  console.log("(Tools with a `limit` parameter -- shows whether response size scales");
  console.log(" linearly with `limit`, or stays flat because of text truncation.)\n");

  const cases = [
    { tool: "binance_get_klines", base: { symbol: "BTCUSDT", interval: "1h" }, scaleParam: "limit", scales: [10, 100, 500] },
    { tool: "binance_get_long_short_ratio", base: { symbol: "BTCUSDT", period: "5m" }, scaleParam: "limit", scales: [10, 100, 500] },
    { tool: "binance_get_top_trader_ratio", base: { symbol: "BTCUSDT", period: "5m" }, scaleParam: "limit", scales: [10, 100, 500] },
  ];

  for (const c of cases) {
    console.log(`${c.tool}:`);
    let prevTokens = null;
    for (const scale of c.scales) {
      const { tokens, rawBytes } = await callTool(c.tool, { ...c.base, [c.scaleParam]: scale });
      const growth = prevTokens ? `(${(tokens / prevTokens).toFixed(2)}x vs previous scale)` : "";
      console.log(`  ${c.scaleParam}=${String(scale).padEnd(5)} -> ${rawBytes.toLocaleString().padStart(7)} bytes, ${fmtTokens(tokens).padEnd(12)} ${growth}`);
      prevTokens = tokens;
    }
  }

  // Explicit contrast: klines default (summary-only) vs opt-in includeCandles=true
  // at the same limit=500 -- proves the opt-in escape hatch still works.
  console.log(`\nbinance_get_klines limit=500, includeCandles contrast:`);
  const withoutCandles = await callTool("binance_get_klines", { symbol: "BTCUSDT", interval: "1h", limit: 500 });
  const withCandles = await callTool("binance_get_klines", { symbol: "BTCUSDT", interval: "1h", limit: 500, includeCandles: true });
  console.log(`  includeCandles=false (default) -> ${fmtTokens(withoutCandles.tokens)}`);
  console.log(`  includeCandles=true  (opt-in)  -> ${fmtTokens(withCandles.tokens)} (${(withCandles.tokens / withoutCandles.tokens).toFixed(1)}x -- expected, caller asked for full data)`);
}

// ── Metric 3: Information Density Ratio ───────────────────────────────────
// Heuristic line-by-line classification. Not exact tokenization -- see
// header caveat. Rows/values are "data"; markdown structure, headers, and
// static disclaimer prose are "boilerplate".
function classifyText(text) {
  let dataTokens = 0;
  let boilerplateTokens = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    // Markdown header ("# ...", "## ...")
    if (/^#{1,6}\s/.test(line)) {
      boilerplateTokens += estimateTokens(line);
      continue;
    }
    // Table separator row ("|---|---|")
    if (/^\|[\s:|-]+\|$/.test(line)) {
      boilerplateTokens += estimateTokens(line);
      continue;
    }
    // Static footnote/disclaimer, this codebase's convention: "_..._" wrapping a whole line
    if (/^_.*_$/.test(line)) {
      boilerplateTokens += estimateTokens(line);
      continue;
    }
    // Table data row: "| a | b | c |" -- pipes+padding = boilerplate, cell content = data
    if (line.startsWith("|")) {
      const cells = line.split("|").filter((c) => c.trim() !== "");
      const cellContent = cells.join(" ");
      const structureChars = line.length - cellContent.length;
      dataTokens += estimateTokens(cellContent);
      boilerplateTokens += estimateTokens(" ".repeat(Math.max(0, structureChars)));
      continue;
    }
    // "- Label: value" or "**Label**: value" -- label = boilerplate, value = data
    const labelMatch = line.match(/^[-*]*\s*\*{0,2}[^:]+\*{0,2}:\s*(.+)$/);
    if (labelMatch) {
      const value = labelMatch[1];
      const label = line.slice(0, line.length - value.length);
      boilerplateTokens += estimateTokens(label);
      dataTokens += estimateTokens(value);
      continue;
    }
    // Fallback: plain prose paragraph -- interpretive text, counted as boilerplate.
    boilerplateTokens += estimateTokens(line);
  }

  return { dataTokens, boilerplateTokens, ratio: boilerplateTokens > 0 ? dataTokens / boilerplateTokens : Infinity };
}

async function auditDensityRatio() {
  console.log("\n=== 3. INFORMATION DENSITY RATIO (data tokens : boilerplate tokens) ===");
  console.log("(Heuristic, not exact -- table cell values / labeled values counted as");
  console.log(" data; markdown structure, headers, and static disclaimer prose as");
  console.log(" boilerplate. Higher ratio = more signal per token spent.)\n");

  const targets = [
    { tool: "binance_get_funding_rate", args: { symbol: "BTCUSDT" } },
    { tool: "binance_get_klines", args: { symbol: "BTCUSDT", interval: "1h", limit: 24 } },
    { tool: "binance_get_long_short_ratio", args: { symbol: "BTCUSDT", period: "1h", limit: 12 } },
    { tool: "binance_analyze_pair", args: { symbol: "BTCUSDT" } },
  ];

  for (const t of targets) {
    const { text } = await callTool(t.tool, t.args);
    const { dataTokens, boilerplateTokens, ratio } = classifyText(text);
    console.log(
      `  ${t.tool.padEnd(32)} data=${fmtTokens(dataTokens).padEnd(10)} boilerplate=${fmtTokens(boilerplateTokens).padEnd(10)} ratio=${ratio.toFixed(2)}`,
    );
  }
}

// ── Simulated multi-turn conversation ─────────────────────────────────────
async function simulateConversation(schemaTokens) {
  console.log("\n=== 4. SIMULATED MULTI-TURN CONVERSATION ===");
  console.log("(Realistic sequence: scan market -> check funding -> check klines -> composite analysis)\n");

  let cumulative = schemaTokens;
  console.log(`  [turn 0] tool schema loaded (one-time)     ${fmtTokens(schemaTokens).padStart(12)}   running total: ${fmtTokens(cumulative)}`);

  const step1 = await callTool("binance_scan_funding_extremes", { limit: 10 });
  cumulative += step1.tokens;
  const topSymbol = step1.result?.structuredContent?.topSymbolLong?.symbol ?? "BTCUSDT";
  console.log(`  [turn 1] binance_scan_funding_extremes      ${fmtTokens(step1.tokens).padStart(12)}   running total: ${fmtTokens(cumulative)}  (top symbol: ${topSymbol})`);

  const step2 = await callTool("binance_get_funding_rate", { symbol: topSymbol });
  cumulative += step2.tokens;
  console.log(`  [turn 2] binance_get_funding_rate(${topSymbol})${" ".repeat(Math.max(0, 6 - topSymbol.length))}${fmtTokens(step2.tokens).padStart(12)}   running total: ${fmtTokens(cumulative)}`);

  const step3 = await callTool("binance_get_klines", { symbol: topSymbol, interval: "1h", limit: 24 });
  cumulative += step3.tokens;
  console.log(`  [turn 3] binance_get_klines(${topSymbol}, limit=24)${" ".repeat(Math.max(0, 3 - topSymbol.length))}${fmtTokens(step3.tokens).padStart(12)}   running total: ${fmtTokens(cumulative)}`);

  const step4 = await callTool("binance_analyze_pair", { symbol: topSymbol });
  cumulative += step4.tokens;
  console.log(`  [turn 4] binance_analyze_pair(${topSymbol})${" ".repeat(Math.max(0, 5 - topSymbol.length))}${fmtTokens(step4.tokens).padStart(12)}   running total: ${fmtTokens(cumulative)}`);

  console.log(`\n  TOTAL for this 4-turn analysis conversation: ${fmtTokens(cumulative)} (incl. one-time schema load)`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`binance-future-hunter token audit -- ${new Date().toISOString()}`);
  console.log(`Worker: ${WORKER_URL}`);
  console.log(`Token estimation: chars/${CHARS_PER_TOKEN} approximation (no public Claude tokenizer exists -- see script header)`);

  const { totalTokens: schemaTokens } = await auditSchemaSize();
  await auditScaling();
  await auditDensityRatio();
  await simulateConversation(schemaTokens);

  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error("token-audit failed:", err);
  process.exit(1);
});
