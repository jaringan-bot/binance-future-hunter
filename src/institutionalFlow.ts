// computeInstitutionalFlowScore -- fungsi MURNI (tanpa fetch), dipakai
// binance_analyze_institutional_flow (src/tools/institutionalFlow.ts).
// Pola SAMA seperti scoreTier1Signals (src/pipelineEngine.ts): terima OUTPUT
// dari beberapa fungsi murni lain yang SUDAH ADA (bukan raw fetch), gabung
// jadi satu skor. TIDAK ADA fetch/logic yang diduplikasi dari tool lain --
// pure functions yang di-reuse:
//   - computeFundingDivergence  (src/tools/crossExchange.ts)
//   - findCrossVenueWalls       (src/tools/crossVenueDepth.ts)
//   - aggregateWhaleDeltas      (src/tools/hyperliquidWhale.ts)
//   - computeCftcTrend          (src/cftcClient.ts)
//   - computeOptionsPositioning (src/deribitClient.ts)
//
// DESAIN: kenapa BUKAN satu angka -100..+100 weighted-average tunggal --
// funding divergence antar-exchange (Binance vs Bybit vs OKX vs Hyperliquid)
// pada dasarnya mengukur SEBERAPA BESAR exchange-exchange itu tidak setuju,
// bukan "ke arah mana" -- memaksanya jadi 1 vote directional akan
// overclaim presisi yang gak ada di data ini. Jadi funding divergence
// dipakai sebagai FLAG confidence (exchange yang gak sepakat = sinyal
// gabungan kurang reliable), bukan vote directional. Skema "N dari M sinyal align"
// ini pola yang SAMA dengan binance_detect_mm_activity (checklist tier,
// bukan probabilitas terkalibrasi) -- konsisten dengan budaya repo ini:
// jujur soal apa yang bisa diklaim dari data heterogen kayak gini.
//
// SEMUA threshold di bawah (skala strength CFTC, ambang flag divergence)
// adalah HEURISTIK EKSPLISIT, belum dikalibrasi statistik -- sama seperti
// threshold lain di repo ini (smartMoneyAnalysis.ts, detectMmActivity.ts).
import type { DivergenceResult } from "./tools/crossExchange.js";
import type { CrossVenueWall } from "./tools/crossVenueDepth.js";
import type { WhaleAggregate } from "./tools/hyperliquidWhale.js";
import type { CftcTrend } from "./cftcClient.js";
import type { OptionsPositioning } from "./deribitClient.js";

export type FlowDirection = "LONG" | "SHORT" | "NEUTRAL";

export interface FlowComponent {
  name: "hyperliquid_whale" | "cftc_trend" | "cross_venue_walls" | "deribit_options";
  available: boolean;
  unavailableReason: string | null;
  direction: FlowDirection;
  strength: number; // 0-1, cuma berarti kalau available=true
}

export interface InstitutionalFlowScore {
  components: FlowComponent[];
  componentsAvailable: number;
  netDirection: FlowDirection;
  alignmentScore: number; // 0-100 -- seberapa besar komponen yang TERSEDIA setuju sama netDirection
  fundingDivergenceFlag: boolean;
  fundingDivergenceNote: string | null;
}

// levNetPctChange 10 poin persentase (window trend) = strength penuh (1.0),
// linear di bawahnya. Belum dikalibrasi -- table cftc_positioning_history
// baru mulai ngumpulin data (lihat computeCftcTrend di cftcClient.ts).
const CFTC_TREND_STRENGTH_SCALE_POINTS = 10;
// Selisih funding >0.1% antar-exchange dianggap "gak sepakat" -- heuristik,
// bukan dari backtest divergence vs reliability sinyal gabungan.
const FUNDING_DIVERGENCE_FLAG_THRESHOLD = 0.001;
// Put/call OI: PCR > 1 => lebih banyak put (bias SHORT), PCR < 1 => call-heavy
// (bias LONG). Strength = min(1, |log2(PCR)|). PCR=2 atau 0.5 => strength 1.
// BELUM dikalibrasi.
const OPTIONS_PCR_NEUTRAL_BAND = 0.05; // |PCR-1| di bawah ini = NEUTRAL

function whaleComponent(aggregate: WhaleAggregate | null): FlowComponent {
  if (!aggregate || aggregate.totalWallets === 0) {
    return {
      name: "hyperliquid_whale",
      available: false,
      unavailableReason: "HYPERLIQUID_WHALE_WATCHLIST kosong atau belum ada snapshot posisi untuk coin ini.",
      direction: "NEUTRAL",
      strength: 0,
    };
  }
  const direction: FlowDirection =
    aggregate.netLongWallets > aggregate.netShortWallets
      ? "LONG"
      : aggregate.netShortWallets > aggregate.netLongWallets
        ? "SHORT"
        : "NEUTRAL";
  return { name: "hyperliquid_whale", available: true, unavailableReason: null, direction, strength: aggregate.confidencePct };
}

function cftcComponent(trend: CftcTrend | null): FlowComponent {
  if (!trend || trend.weeksAvailable < 2 || trend.levNetPctChange === null) {
    return {
      name: "cftc_trend",
      available: false,
      unavailableReason: "Histori cftc_positioning_history belum cukup (butuh minimal 2 laporan mingguan) untuk hitung trend.",
      direction: "NEUTRAL",
      strength: 0,
    };
  }
  const direction: FlowDirection = trend.direction === "RISING" ? "LONG" : trend.direction === "FALLING" ? "SHORT" : "NEUTRAL";
  const strength = Math.min(1, Math.abs(trend.levNetPctChange) / CFTC_TREND_STRENGTH_SCALE_POINTS);
  return { name: "cftc_trend", available: true, unavailableReason: null, direction, strength };
}

function crossVenueWallComponent(walls: CrossVenueWall[] | null): FlowComponent {
  if (!walls || walls.length === 0) {
    return {
      name: "cross_venue_walls",
      available: false,
      unavailableReason: "Tidak ada wall kandidat terdeteksi di venue manapun pada snapshot ini.",
      direction: "NEUTRAL",
      strength: 0,
    };
  }
  const corroborated = walls.filter((w) => w.corroboratedBy.length > 0);
  if (corroborated.length === 0) {
    return {
      name: "cross_venue_walls",
      available: false,
      unavailableReason: "Ada wall kandidat, tapi tidak ada yang corroborated di >=2 venue -- tidak cukup kredibel buat jadi vote.",
      direction: "NEUTRAL",
      strength: 0,
    };
  }
  const bidCount = corroborated.filter((w) => w.side === "bid").length;
  const askCount = corroborated.filter((w) => w.side === "ask").length;
  const direction: FlowDirection = bidCount > askCount ? "LONG" : askCount > bidCount ? "SHORT" : "NEUTRAL";
  const strength = corroborated.length / walls.length;
  return { name: "cross_venue_walls", available: true, unavailableReason: null, direction, strength };
}

function deribitOptionsComponent(positioning: OptionsPositioning | null): FlowComponent {
  if (!positioning || positioning.instrumentCount === 0 || positioning.putCallRatio === null) {
    return {
      name: "deribit_options",
      available: false,
      unavailableReason:
        positioning?.putCallRatio === null && (positioning?.instrumentCount ?? 0) > 0
          ? "Call OI = 0 -- put/call ratio tidak terdefinisi."
          : "Options Deribit tidak tersedia (coin bukan BTC/ETH, atau fetch gagal/kosong).",
      direction: "NEUTRAL",
      strength: 0,
    };
  }
  const pcr = positioning.putCallRatio;
  if (Math.abs(pcr - 1) < OPTIONS_PCR_NEUTRAL_BAND) {
    return { name: "deribit_options", available: true, unavailableReason: null, direction: "NEUTRAL", strength: 0 };
  }
  const direction: FlowDirection = pcr > 1 ? "SHORT" : "LONG";
  const strength = Math.min(1, Math.abs(Math.log2(pcr)));
  return { name: "deribit_options", available: true, unavailableReason: null, direction, strength };
}

export function computeInstitutionalFlowScore(inputs: {
  fundingDivergence: DivergenceResult | null;
  crossVenueWalls: CrossVenueWall[] | null;
  hyperliquidWhale: WhaleAggregate | null;
  cftcTrend: CftcTrend | null;
  deribitOptions?: OptionsPositioning | null;
}): InstitutionalFlowScore {
  const components: FlowComponent[] = [
    whaleComponent(inputs.hyperliquidWhale),
    cftcComponent(inputs.cftcTrend),
    crossVenueWallComponent(inputs.crossVenueWalls),
    deribitOptionsComponent(inputs.deribitOptions ?? null),
  ];

  const available = components.filter((c) => c.available);
  const longStrength = available.filter((c) => c.direction === "LONG").reduce((sum, c) => sum + c.strength, 0);
  const shortStrength = available.filter((c) => c.direction === "SHORT").reduce((sum, c) => sum + c.strength, 0);

  let netDirection: FlowDirection = "NEUTRAL";
  if (longStrength > shortStrength) netDirection = "LONG";
  else if (shortStrength > longStrength) netDirection = "SHORT";

  const agreeingStrength = available.filter((c) => c.direction === netDirection).reduce((sum, c) => sum + c.strength, 0);
  const alignmentScore = available.length > 0 && netDirection !== "NEUTRAL" ? (agreeingStrength / available.length) * 100 : 0;

  const fundingDivergenceFlag = (inputs.fundingDivergence?.maxDivergence ?? 0) >= FUNDING_DIVERGENCE_FLAG_THRESHOLD;

  return {
    components,
    componentsAvailable: available.length,
    netDirection,
    alignmentScore,
    fundingDivergenceFlag,
    fundingDivergenceNote: fundingDivergenceFlag
      ? `Funding rate antar-exchange selisih >=${(FUNDING_DIVERGENCE_FLAG_THRESHOLD * 100).toFixed(2)}% -- exchange tidak sepakat, anggap alignmentScore kurang reliable.`
      : null,
  };
}
