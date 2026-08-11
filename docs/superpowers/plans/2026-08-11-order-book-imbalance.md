# Order Book Imbalance (OBI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP tool `binance_get_order_book_imbalance` that computes bid vs ask volume imbalance (%) at depth levels 5, 10, and 20 in a single call, with an automatic bias label per level.

**Architecture:** Pure computation on top of the existing `binanceProxyClient.getOrderBookDepth` function — one proxy call at depth 20, sliced to compute all three levels. No new files, no new dependencies, no infra changes.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (`McpServer.registerTool`), Zod (input schema), Cloudflare Workers.

## Global Constraints

- Volume computed from raw base-asset quantity (not notional/price×qty) — matches `binance_get_order_book_depth` convention.
- Bias thresholds: `bidPct > 60` → BULLISH, `bidPct < 40` → BEARISH, else SEIMBANG.
- One `getOrderBookDepth(symbol, 20)` call total — do not call the proxy 3 times for 3 depth levels.
- No new test framework — project has none (`typecheck` + manual verify only, per existing convention).

---

### Task 1: Add `binance_get_order_book_imbalance` tool

**Files:**
- Modify: `src/server.ts` (insert new tool block after `binance_get_order_book_depth`, which ends at line 601 — insert starting at line 602, before the `AGGREGATE TRADES / CVD GRANULAR` section comment at line 603)

**Interfaces:**
- Consumes: `binanceProxy.getOrderBookDepth(symbol: string, limit: number): Promise<OrderBookDepth>` (existing, `src/binanceProxyClient.ts:137`), where `OrderBookDepth.bids`/`.asks` are `[string, string][]` (`[price, quantity]`)
- Consumes: `symbolSchema` (existing Zod schema, `src/server.ts:51`), `errorResult(err)` (existing, `src/server.ts:58`), `fmtPrice` (existing, `src/format.ts:14`)
- Produces: nothing consumed by other tasks — this is a self-contained leaf tool, no other task depends on it

- [ ] **Step 1: Write the tool registration block**

Insert this block into `src/server.ts` immediately after the closing `);` of `binance_get_order_book_depth` (after line 601) and before the `// ─────────────────────────────────────────────────────────────\n  // AGGREGATE TRADES / CVD GRANULAR` comment on line 603:

```typescript
  // ─────────────────────────────────────────────────────────────
  // ORDER BOOK IMBALANCE (OBI)
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "binance_get_order_book_imbalance",
    {
      title: "Order Book Imbalance (OBI)",
      description:
        "Menghitung persentase imbalance volume Bid vs Ask secara kumulatif di 3 level kedalaman harga (depth 5, 10, 20) " +
        "sekaligus dalam satu panggilan, LANGSUNG dari Binance lewat proxy relay. Beda dari binance_get_order_book_depth " +
        "yang cuma kasih snapshot mentah — tool ini langsung kasih rasio bid vs ask plus label bias (BULLISH/BEARISH/SEIMBANG) " +
        "per depth level. PENTING: ini snapshot SESAAT — order book berubah cepat, jangan overinterpretasi satu snapshot sebagai " +
        "sinyal pasti (sama seperti binance_get_order_book_depth).",
      inputSchema: {
        symbol: symbolSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const data = await binanceProxy.getOrderBookDepth(symbol, 20);
        const depthLevels = [5, 10, 20] as const;

        const results = depthLevels.map((depth) => {
          const bidVol = data.bids
            .slice(0, depth)
            .reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
          const askVol = data.asks
            .slice(0, depth)
            .reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
          const totalVol = bidVol + askVol;

          if (totalVol === 0) {
            return { depth, bidVol, askVol, bidPct: null as number | null, bias: "TIDAK ADA DATA" };
          }

          const bidPct = (bidVol / totalVol) * 100;
          const bias = bidPct > 60 ? "BULLISH (bid dominan)" : bidPct < 40 ? "BEARISH (ask dominan)" : "SEIMBANG";
          return { depth, bidVol, askVol, bidPct, bias };
        });

        const rows = results
          .map(
            (r) =>
              `| ${r.depth} | ${fmtNum(r.bidVol, 4)} | ${fmtNum(r.askVol, 4)} | ${r.bidPct !== null ? r.bidPct.toFixed(2) + "%" : "N/A"} | ${r.bias} |`,
          )
          .join("\n");

        const bestBid = data.bids[0] ? parseFloat(data.bids[0][0]) : null;
        const bestAsk = data.asks[0] ? parseFloat(data.asks[0][0]) : null;

        const text = [
          `# Order Book Imbalance — ${symbol}`,
          ``,
          `**Best Bid**: ${bestBid !== null ? fmtPrice(bestBid) : "N/A"} | **Best Ask**: ${bestAsk !== null ? fmtPrice(bestAsk) : "N/A"}`,
          ``,
          `| Depth | Bid Volume | Ask Volume | Bid % | Bias |`,
          `|---|---|---|---|---|`,
          rows,
          ``,
          `_Snapshot sesaat (waktu server Binance: ${fmtTime(data.T)}). Volume dihitung dari raw base-asset quantity, ` +
            `bukan notional. Order book berubah cepat — jangan overinterpretasi satu snapshot sebagai sinyal pasti._`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { symbol, levels: results },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

```

- [ ] **Step 2: Typecheck**

Run: `cd ~/Documents/GitHub/whale && npm run typecheck`
Expected: no errors. If `fmtNum`, `fmtPrice`, or `fmtTime` show as unused-import errors, they are already imported at the top of `src/server.ts` (line 5) and used by neighboring tools — this new block reuses them, so no import changes needed.

- [ ] **Step 3: Manual verify locally with wrangler dev**

Run: `cd ~/Documents/GitHub/whale && npx wrangler dev`

In a second terminal, use the MCP Inspector to connect and call the tool:

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI: connect to `http://localhost:8787/mcp` (Streamable HTTP transport), open the Tools tab, select `binance_get_order_book_imbalance`, run it with `symbol: "BTCUSDT"`.

Expected: response text has a markdown table with 3 rows (depth 5, 10, 20), each with a `Bid %` value between 0-100% and a `bias` label (BULLISH/BEARISH/SEIMBANG). `structuredContent.levels` has 3 entries.

Also test one low-liquidity pair (e.g. a small-cap USDT perp) to confirm no crash/`NaN` if a side is thin.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/GitHub/whale
git add src/server.ts
git commit -m "$(cat <<'EOF'
feat: tambah tool binance_get_order_book_imbalance (OBI)

Hitung persentase imbalance volume bid vs ask di depth 5/10/20 sekaligus
dari 1x panggilan getOrderBookDepth, dengan label bias otomatis
(BULLISH >60%, BEARISH <40%, SEIMBANG di antaranya).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KE7RdtauwLc31G66hpkNrz
EOF
)"
```

---

## Post-merge

This tool auto-deploys via the existing `Deploy to Cloudflare Workers` GitHub Actions workflow (`.github/workflows/deploy.yml`) on push to `main` — same as every prior tool in this repo. No manual deploy step needed once merged.
