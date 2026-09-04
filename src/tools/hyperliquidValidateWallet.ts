// hyperliquid_validate_candidate_wallet -- Opsi A whale discovery:
// query clearinghouseState sekali untuk 1 address kandidat SEBELUM user
// commit ke HYPERLIQUID_WHALE_WATCHLIST. Watchlist tetap manual.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getUserClearinghouseSnapshot } from "../hyperliquidClient.js";
import { errorResult, detailParam } from "../shared.js";
import { registerSafeTool } from "../toolWrapper.js";
import { ToolResponseBuilder } from "../responseBuilder.js";
import { fmtNum } from "../format.js";

const EVM_ADDRESS = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Address harus format EVM 0x + 40 hex")
  .describe("Address wallet Hyperliquid kandidat (0x...).");

export function registerHyperliquidValidateWalletTools(server: McpServer): void {
  registerSafeTool(
    server,
    "hyperliquid_validate_candidate_wallet",
    {
      title: "Validasi Kandidat Whale Wallet Hyperliquid",
      description:
        "Query posisi on-chain + equity ringkas SATU address Hyperliquid (clearinghouseState) sebelum memutuskan " +
        "masuk HYPERLIQUID_WHALE_WATCHLIST. Bukan discovery otomatis -- watchlist tetap curated manual; tool ini " +
        "cuma menurunkan friksi riset (cek account value, jumlah posisi, side/size per coin). " +
        "PENTING: equity/posisi bisa berubah cepat; snapshot sesaat, bukan skor kualitas whale.",
      inputSchema: { address: EVM_ADDRESS, detail: detailParam },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address, detail }) => {
      try {
        const snap = await getUserClearinghouseSnapshot(address);
        const longs = snap.positions.filter((p) => p.side === "long").length;
        const shorts = snap.positions.filter((p) => p.side === "short").length;

        const builder = new ToolResponseBuilder()
          .header(`Hyperliquid Candidate Wallet -- ${address}`)
          .row("Account Value (USD)", snap.accountValue === null ? "n/a" : fmtNum(snap.accountValue, 2))
          .row("Withdrawable", snap.withdrawable === null ? "n/a" : fmtNum(snap.withdrawable, 2))
          .row("Margin Used", snap.totalMarginUsed === null ? "n/a" : fmtNum(snap.totalMarginUsed, 2))
          .row("Open Positions", fmtNum(snap.positions.length, 0))
          .row("Long / Short", `${longs} / ${shorts}`);

        if (snap.positions.length === 0) {
          builder.note("Tidak ada posisi perp terbuka saat ini — masih boleh dicurasi kalau equity/histori menarik.");
        } else if (detail === "full") {
          builder.subheader("Posisi").table(
            ["Coin", "Side", "Size", "Entry", "Leverage"],
            snap.positions.map((p) => [
              p.coin,
              p.side,
              fmtNum(p.size, 4),
              p.entryPrice === null ? "-" : fmtNum(p.entryPrice, 2),
              p.leverage === null ? "-" : fmtNum(p.leverage, 0),
            ]),
          );
        } else {
          const top = [...snap.positions].sort((a, b) => b.size - a.size).slice(0, 10);
          builder.subheader("Top posisi (max 10 by size)").table(
            ["Coin", "Side", "Size"],
            top.map((p) => [p.coin, p.side, fmtNum(p.size, 4)]),
          );
        }

        builder.note(
          "Kalau lolos curation manual, tambahkan address ke HYPERLIQUID_WHALE_WATCHLIST di src/shared.ts " +
            "(atau secret JSON array) lalu deploy. Tool ini TIDAK menulis watchlist.",
        );
        builder.struct("snapshot", snap);
        return builder.build();
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
