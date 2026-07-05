import {
  bantahBroTokenAnalysisSchema,
  type BantahBroHolderMetrics,
  type BantahBroMomentumScore,
  type BantahBroPairSnapshot,
  type BantahBroRugScore,
  type BantahBroScoreReason,
  type BantahBroTokenAnalysis,
  type BantahBroTokenRef,
} from "@shared/bantahBro";
import { fetchMoralisHolderMetrics } from "./moralisClient";

type DexScreenerPair = Record<string, unknown>;

const DEXSCREENER_API_BASE =
  process.env.DEXSCREENER_API_BASE?.replace(/\/+$/, "") ||
  "https://api.dexscreener.com";
const DEXSCREENER_FETCH_TIMEOUT_MS = Number(
  process.env.BANTAHBRO_DEXSCREENER_FETCH_TIMEOUT_MS || 5_000,
);

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toNullableNumber(value: unknown): number | null {
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toHttpUrlOrNull(value: unknown): string | null {
  const candidate = toStringOrNull(value);
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function firstHttpUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const url = toHttpUrlOrNull(value);
    if (url) return url;
  }
  return null;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getWindowNumber(source: unknown, key: string): number {
  return toNumber(getRecord(source)[key]);
}

function getWindowTxns(source: unknown, key: string) {
  const txns = getRecord(getRecord(source)[key]);
  return {
    buys: toNumber(txns.buys),
    sells: toNumber(txns.sells),
  };
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function riskLevel(score: number): BantahBroRugScore["riskLevel"] {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function momentumLevel(score: number): BantahBroMomentumScore["momentumLevel"] {
  if (score >= 70) return "hot";
  if (score >= 40) return "warming";
  return "cold";
}

export function normalizePair(pair: DexScreenerPair): BantahBroPairSnapshot {
  const baseToken = getRecord(pair.baseToken);
  const quoteToken = getRecord(pair.quoteToken);
  const info = getRecord(pair.info);
  const liquidity = getRecord(pair.liquidity);
  const txns = pair.txns;
  const volume = pair.volume;
  const priceChange = pair.priceChange;
  const pairCreatedAtMs = toNullableNumber(pair.pairCreatedAt);
  const pairCreatedDate =
    pairCreatedAtMs && pairCreatedAtMs > 0 ? new Date(pairCreatedAtMs) : null;
  const pairAgeMinutes = pairCreatedDate
    ? Math.max(0, Math.floor((Date.now() - pairCreatedDate.getTime()) / 60000))
    : null;

  return {
    chainId: String(pair.chainId || ""),
    dexId: toStringOrNull(pair.dexId),
    url: toStringOrNull(pair.url),
    imageUrl: firstHttpUrl(
      info.imageUrl,
      info.logoUrl,
      info.iconUrl,
      baseToken.logoURI,
      baseToken.logoUrl,
      baseToken.imageUrl,
    ),
    pairAddress: String(pair.pairAddress || ""),
    baseToken: {
      address: String(baseToken.address || ""),
      name: toStringOrNull(baseToken.name),
      symbol: toStringOrNull(baseToken.symbol),
    },
    quoteToken: {
      address: String(quoteToken.address || ""),
      name: toStringOrNull(quoteToken.name),
      symbol: toStringOrNull(quoteToken.symbol),
    },
    priceUsd: toNullableNumber(pair.priceUsd),
    liquidityUsd: toNumber(liquidity.usd),
    marketCap: toNullableNumber(pair.marketCap),
    fdv: toNullableNumber(pair.fdv),
    pairCreatedAt: pairCreatedDate ? pairCreatedDate.toISOString() : null,
    pairAgeMinutes,
    volume: {
      m5: getWindowNumber(volume, "m5"),
      h1: getWindowNumber(volume, "h1"),
      h6: getWindowNumber(volume, "h6"),
      h24: getWindowNumber(volume, "h24"),
    },
    txns: {
      m5: getWindowTxns(txns, "m5"),
      h1: getWindowTxns(txns, "h1"),
      h6: getWindowTxns(txns, "h6"),
      h24: getWindowTxns(txns, "h24"),
    },
    priceChange: {
      m5: getWindowNumber(priceChange, "m5"),
      h1: getWindowNumber(priceChange, "h1"),
      h6: getWindowNumber(priceChange, "h6"),
      h24: getWindowNumber(priceChange, "h24"),
    },
    boostsActive: toNumber(getRecord(pair.boosts).active),
  };
}

export function choosePrimaryPair(pairs: BantahBroPairSnapshot[]) {
  return [...pairs].sort((a, b) => {
    const liquidityDelta = b.liquidityUsd - a.liquidityUsd;
    if (Math.abs(liquidityDelta) > 1) return liquidityDelta;
    return b.volume.h24 - a.volume.h24;
  })[0] || null;
}

function addReason(
  reasons: BantahBroScoreReason[],
  code: string,
  label: string,
  impact: number,
) {
  reasons.push({ code, label, impact });
}

export function calculateRugScore(
  pair: BantahBroPairSnapshot | null,
  holders?: BantahBroHolderMetrics,
): BantahBroRugScore {
  const reasons: BantahBroScoreReason[] = [];
  const missingSignals = [
    "liquidity lock percentage",
    "contract flags",
    "deployer wallet history",
  ];
  if (holders?.status !== "available") {
    missingSignals.unshift("holder distribution");
  }

  if (!pair) {
    return {
      score: 75,
      riskLevel: "high",
      verdict: "No active DEX pair found. Unknown liquidity is high risk.",
      reasons: [
        {
          code: "no_pair",
          label: "No active DEX pair found for this token.",
          impact: 75,
        },
      ],
      missingSignals,
    };
  }

  let score = 0;
  const volumeLiquidityRatio =
    pair.liquidityUsd > 0 ? pair.volume.h1 / pair.liquidityUsd : pair.volume.h1 > 0 ? 99 : 0;
  const h1Txns = pair.txns.h1.buys + pair.txns.h1.sells;
  const sellPressure = pair.txns.h1.buys > 0
    ? pair.txns.h1.sells / pair.txns.h1.buys
    : pair.txns.h1.sells > 0
      ? 99
      : 0;
  const topHolderPercent = holders?.topHolders[0]?.percentage ?? null;
  const top10SupplyPercent = holders?.holderSupply.top10SupplyPercent ?? null;
  const totalHolders = holders?.totalHolders ?? null;

  if (pair.liquidityUsd <= 0) {
    score += 30;
    addReason(reasons, "no_liquidity", "No visible USD liquidity.", 30);
  } else if (pair.liquidityUsd < 1000) {
    score += 25;
    addReason(reasons, "tiny_liquidity", "Liquidity is below $1k.", 25);
  } else if (pair.liquidityUsd < 5000) {
    score += 18;
    addReason(reasons, "thin_liquidity", "Liquidity is below $5k.", 18);
  } else if (pair.liquidityUsd < 20000) {
    score += 8;
    addReason(reasons, "light_liquidity", "Liquidity is still light.", 8);
  }

  if (pair.pairAgeMinutes !== null) {
    if (pair.pairAgeMinutes < 30) {
      score += 20;
      addReason(reasons, "very_new_pair", "Pair is less than 30 minutes old.", 20);
    } else if (pair.pairAgeMinutes < 120) {
      score += 12;
      addReason(reasons, "new_pair", "Pair is less than 2 hours old.", 12);
    } else if (pair.pairAgeMinutes < 1440) {
      score += 5;
      addReason(reasons, "young_pair", "Pair is less than 24 hours old.", 5);
    }
  }

  if (volumeLiquidityRatio > 5) {
    score += 18;
    addReason(reasons, "volume_liquidity_mismatch", "H1 volume is more than 5x liquidity.", 18);
  } else if (volumeLiquidityRatio > 2) {
    score += 10;
    addReason(reasons, "hot_volume_thin_liquidity", "H1 volume is high relative to liquidity.", 10);
  }

  if (sellPressure > 2 && h1Txns >= 6) {
    score += 15;
    addReason(reasons, "heavy_sell_pressure", "H1 sells are more than 2x buys.", 15);
  } else if (sellPressure > 1.35 && h1Txns >= 6) {
    score += 8;
    addReason(reasons, "sell_pressure", "H1 sells are materially above buys.", 8);
  }

  if (pair.priceChange.h1 <= -40) {
    score += 18;
    addReason(reasons, "hard_h1_dump", "Price is down more than 40% in 1h.", 18);
  } else if (pair.priceChange.h1 <= -20) {
    score += 10;
    addReason(reasons, "h1_dump", "Price is down more than 20% in 1h.", 10);
  }

  if (pair.priceChange.m5 <= -20) {
    score += 12;
    addReason(reasons, "sharp_m5_dump", "Price is down more than 20% in 5m.", 12);
  }

  if (pair.boostsActive > 0 && pair.liquidityUsd < 10000) {
    score += 10;
    addReason(reasons, "boosted_thin_liquidity", "Active boost on thin liquidity.", 10);
  }

  if (topHolderPercent !== null) {
    if (topHolderPercent >= 40) {
      score += 25;
      addReason(reasons, "top_holder_dominates", `Top holder controls ${topHolderPercent.toFixed(1)}% of supply.`, 25);
    } else if (topHolderPercent >= 20) {
      score += 15;
      addReason(reasons, "large_top_holder", `Top holder controls ${topHolderPercent.toFixed(1)}% of supply.`, 15);
    } else if (topHolderPercent >= 10) {
      score += 8;
      addReason(reasons, "notable_top_holder", `Top holder controls ${topHolderPercent.toFixed(1)}% of supply.`, 8);
    }
  }

  if (top10SupplyPercent !== null) {
    if (top10SupplyPercent >= 70) {
      score += 22;
      addReason(reasons, "top10_concentration_extreme", `Top 10 holders control ${top10SupplyPercent.toFixed(1)}% of supply.`, 22);
    } else if (top10SupplyPercent >= 50) {
      score += 14;
      addReason(reasons, "top10_concentration_high", `Top 10 holders control ${top10SupplyPercent.toFixed(1)}% of supply.`, 14);
    } else if (top10SupplyPercent >= 30) {
      score += 7;
      addReason(reasons, "top10_concentration_notable", `Top 10 holders control ${top10SupplyPercent.toFixed(1)}% of supply.`, 7);
    }
  }

  if (totalHolders !== null) {
    if (totalHolders < 50) {
      score += 16;
      addReason(reasons, "tiny_holder_base", `Only ${totalHolders} holders visible.`, 16);
    } else if (totalHolders < 200) {
      score += 8;
      addReason(reasons, "small_holder_base", `Only ${totalHolders} holders visible.`, 8);
    }
  }

  const finalScore = clampScore(score);
  const level = riskLevel(finalScore);
  const verdict =
    level === "high"
      ? "High risk. This setup needs receipts before conviction."
      : level === "medium"
        ? "Medium risk. Tradeable chaos, but still suspect."
        : "Low visible rug risk from DexScreener data only.";

  return {
    score: finalScore,
    riskLevel: level,
    verdict,
    reasons,
    missingSignals,
  };
}

export function calculateMomentumScore(
  pair: BantahBroPairSnapshot | null,
  rugScore?: BantahBroRugScore,
): BantahBroMomentumScore {
  const reasons: BantahBroScoreReason[] = [];

  if (!pair) {
    return {
      score: 0,
      momentumLevel: "cold",
      verdict: "No active pair. Nothing to chase yet.",
      reasons,
    };
  }

  let score = 0;
  const h1Buys = pair.txns.h1.buys;
  const h1Sells = pair.txns.h1.sells;
  const buySellRatio = h1Sells > 0 ? h1Buys / h1Sells : h1Buys > 0 ? 99 : 0;
  const volumeLiquidityRatio =
    pair.liquidityUsd > 0 ? pair.volume.h1 / pair.liquidityUsd : 0;

  if (pair.volume.h1 > 100000) {
    score += 25;
    addReason(reasons, "strong_h1_volume", "H1 volume is above $100k.", 25);
  } else if (pair.volume.h1 > 25000) {
    score += 18;
    addReason(reasons, "healthy_h1_volume", "H1 volume is above $25k.", 18);
  } else if (pair.volume.h1 > 5000) {
    score += 10;
    addReason(reasons, "early_h1_volume", "H1 volume is above $5k.", 10);
  }

  if (pair.liquidityUsd > 100000) {
    score += 18;
    addReason(reasons, "deep_liquidity", "Liquidity is above $100k.", 18);
  } else if (pair.liquidityUsd > 25000) {
    score += 12;
    addReason(reasons, "useful_liquidity", "Liquidity is above $25k.", 12);
  } else if (pair.liquidityUsd > 5000) {
    score += 6;
    addReason(reasons, "some_liquidity", "Liquidity is above $5k.", 6);
  }

  if (pair.priceChange.h1 >= 75) {
    score += 22;
    addReason(reasons, "explosive_h1_move", "Price is up more than 75% in 1h.", 22);
  } else if (pair.priceChange.h1 >= 30) {
    score += 16;
    addReason(reasons, "strong_h1_move", "Price is up more than 30% in 1h.", 16);
  } else if (pair.priceChange.h1 >= 10) {
    score += 8;
    addReason(reasons, "positive_h1_move", "Price is up more than 10% in 1h.", 8);
  }

  if (pair.priceChange.m5 >= 15) {
    score += 10;
    addReason(reasons, "m5_acceleration", "Price is accelerating over 5m.", 10);
  }

  if (buySellRatio > 2 && h1Buys + h1Sells >= 6) {
    score += 15;
    addReason(reasons, "buy_pressure", "H1 buys are more than 2x sells.", 15);
  } else if (buySellRatio > 1.25 && h1Buys + h1Sells >= 6) {
    score += 8;
    addReason(reasons, "mild_buy_pressure", "H1 buys are ahead of sells.", 8);
  }

  if (volumeLiquidityRatio > 0.25 && volumeLiquidityRatio <= 2.5) {
    score += 8;
    addReason(reasons, "healthy_volume_liquidity_ratio", "Volume is active without looking absurd versus liquidity.", 8);
  }

  if (pair.boostsActive > 0) {
    score += 4;
    addReason(reasons, "boosted_visibility", "Token has active DexScreener boost visibility.", 4);
  }

  if (rugScore?.riskLevel === "high") {
    score -= 15;
    addReason(reasons, "rug_risk_penalty", "High rug score cuts momentum confidence.", -15);
  }

  const finalScore = clampScore(score);
  const level = momentumLevel(finalScore);
  const verdict =
    level === "hot"
      ? "Hot momentum. This might run, but risk still matters."
      : level === "warming"
        ? "Warming up. Worth watching before calling it a runner."
        : "Cold. Not enough signal yet.";

  return {
    score: finalScore,
    momentumLevel: level,
    verdict,
    reasons,
  };
}

function buildRugPost(pair: BantahBroPairSnapshot | null, rug: BantahBroRugScore) {
  if (!pair || rug.riskLevel !== "high") return null;
  const symbol = pair.baseToken.symbol ? `$${pair.baseToken.symbol}` : "This token";
  const reason = rug.reasons[0]?.label || "Risk signals are stacking.";
  return [
    "🚨 BANTAH ALERT",
    "",
    `🪙 ${symbol}`,
    `⚠️ Rug Score: ${rug.score}/100`,
    "",
    reason,
    "",
    "💀 Verdict: risky. 🎯 Market candidate: will this dump 70% in 6h?",
  ].join("\n");
}

function buildRunnerPost(
  pair: BantahBroPairSnapshot | null,
  momentum: BantahBroMomentumScore,
) {
  if (!pair || momentum.momentumLevel === "cold") return null;
  const symbol = pair.baseToken.symbol ? `$${pair.baseToken.symbol}` : "This token";
  const reason = momentum.reasons[0]?.label || "Momentum is waking up.";
  return [
    `🚀 ${symbol} looks alive.`,
    "",
    reason,
    `📈 Momentum Score: ${momentum.score}/100`,
    "",
    momentum.momentumLevel === "hot"
      ? "🔥 This might run. 🎯 Market candidate: will it 2x in 24h?"
      : "👀 Watching before the loud call.",
  ].join("\n");
}

function buildSuggestedActions(
  rug: BantahBroRugScore,
  momentum: BantahBroMomentumScore,
) {
  const actions: string[] = [];
  if (rug.riskLevel === "high") actions.push("create_rug_market_candidate");
  if (momentum.momentumLevel === "hot") actions.push("create_runner_market_candidate");
  if (rug.riskLevel !== "high" && momentum.momentumLevel !== "hot") {
    actions.push("watch_only");
  }
  return actions;
}

export async function fetchDexScreenerTokenPairs(ref: BantahBroTokenRef) {
  const url = `${DEXSCREENER_API_BASE}/token-pairs/v1/${encodeURIComponent(
    ref.chainId,
  )}/${encodeURIComponent(ref.tokenAddress)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(DEXSCREENER_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`DexScreener token-pairs request failed with ${response.status}`);
  }

  const data: unknown = await response.json();
  return Array.isArray(data) ? (data as DexScreenerPair[]) : [];
}

export async function analyzeToken(ref: BantahBroTokenRef): Promise<BantahBroTokenAnalysis> {
  const [rawPairs, holders] = await Promise.all([
    fetchDexScreenerTokenPairs(ref),
    fetchMoralisHolderMetrics(ref),
  ]);
  const pairs = rawPairs
    .map(normalizePair)
    .filter((pair) => pair.chainId && pair.pairAddress);
  const primaryPair = choosePrimaryPair(pairs);
  const rug = calculateRugScore(primaryPair, holders);
  const momentum = calculateMomentumScore(primaryPair, rug);
  const priceChangesH1 = pairs.map((pair) => pair.priceChange.h1);

  const analysis = {
    source: "dexscreener" as const,
    generatedAt: new Date().toISOString(),
    chainId: ref.chainId,
    tokenAddress: ref.tokenAddress,
    tokenSymbol: primaryPair?.baseToken.symbol || null,
    tokenName: primaryPair?.baseToken.name || null,
    primaryPair,
    pairs,
    aggregate: {
      pairCount: pairs.length,
      totalLiquidityUsd: pairs.reduce((sum, pair) => sum + pair.liquidityUsd, 0),
      totalVolumeH1: pairs.reduce((sum, pair) => sum + pair.volume.h1, 0),
      totalVolumeH24: pairs.reduce((sum, pair) => sum + pair.volume.h24, 0),
      totalBuysH1: pairs.reduce((sum, pair) => sum + pair.txns.h1.buys, 0),
      totalSellsH1: pairs.reduce((sum, pair) => sum + pair.txns.h1.sells, 0),
      strongestPriceChangeH1: priceChangesH1.length ? Math.max(...priceChangesH1) : 0,
      weakestPriceChangeH1: priceChangesH1.length ? Math.min(...priceChangesH1) : 0,
    },
    holders,
    rug,
    momentum,
    suggestedActions: buildSuggestedActions(rug, momentum),
    posts: {
      rug: buildRugPost(primaryPair, rug),
      runner: buildRunnerPost(primaryPair, momentum),
    },
  };

  return bantahBroTokenAnalysisSchema.parse(analysis);
}

const MARKET_QUERY_ALIASES: Record<string, string> = {
  bitcoin: "BTC/USDC",
  btc: "BTC/USDC",
  ethereum: "ETH/USDC",
  eth: "ETH/USDC",
  solana: "SOL/USDC",
  sol: "SOL/USDC",
  binance: "BNB/USDT",
  bnb: "BNB/USDT",
  arbitrum: "ARB/USDC",
  arb: "ARB/USDC",
  pepe: "PEPE/USDC",
};

function normalizeDexSearchQuery(query: string) {
  const normalized = String(query || "")
    .trim()
    .replace(/^\$/g, "")
    .toLowerCase();

  return MARKET_QUERY_ALIASES[normalized] || query.trim();
}

function normalizeTickerTerm(value: string) {
  return String(value || "")
    .trim()
    .replace(/^\$/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
}

function normalizeDexChainId(chainId?: string | null) {
  const normalized = String(chainId || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "8453" || normalized === "base") return "base";
  if (normalized === "42161" || normalized === "arbitrum" || normalized === "arb") return "arbitrum";
  if (normalized === "56" || normalized === "bsc" || normalized === "binance" || normalized === "bnb") {
    return "bsc";
  }
  if (normalized === "sol" || normalized === "solana") return "solana";
  return normalized;
}

async function fetchDexScreenerSearchPairs(query: string) {
  const url = new URL("/latest/dex/search", DEXSCREENER_API_BASE);
  url.searchParams.set("q", query);

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(DEXSCREENER_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`DexScreener search request failed with ${response.status}`);
  }

  const data = (await response.json()) as { pairs?: DexScreenerPair[] } | null;
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

function scoreTickerPairMatch(pair: BantahBroPairSnapshot, query: string) {
  const normalizedQuery = normalizeTickerTerm(query);
  if (!normalizedQuery) return 0;

  const symbol = normalizeTickerTerm(pair.baseToken.symbol || "");
  const name = normalizeTickerTerm(pair.baseToken.name || "");
  const address = normalizeTickerTerm(pair.baseToken.address || "");

  if (symbol === normalizedQuery) return 400;
  if (name === normalizedQuery) return 320;
  if (address === normalizedQuery) return 260;
  if (symbol.startsWith(normalizedQuery)) return 180;
  if (name.startsWith(normalizedQuery)) return 140;
  if (symbol.includes(normalizedQuery)) return 110;
  if (name.includes(normalizedQuery)) return 90;
  return 0;
}

function chooseMarketSearchPair(
  pairs: BantahBroPairSnapshot[],
  query: string,
  mode: "broad" | "ticker" | "ticker-first",
) {
  if (mode === "broad") {
    return choosePrimaryPair(pairs);
  }

  if (mode === "ticker-first") {
    return pairs.find((pair) => scoreTickerPairMatch(pair, query) > 0) || null;
  }

  const matchedPairs = pairs
    .map((pair) => ({
      pair,
      score: scoreTickerPairMatch(pair, query),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.pair.liquidityUsd !== left.pair.liquidityUsd) {
        return right.pair.liquidityUsd - left.pair.liquidityUsd;
      }
      return right.pair.volume.h24 - left.pair.volume.h24;
    });

  return matchedPairs[0]?.pair || null;
}

export type BantahBroMarketLookup = {
  query: string;
  resolvedQuery: string;
  chainId: string | null;
  pair: BantahBroPairSnapshot | null;
  pairCount: number;
  generatedAt: string;
};

export async function lookupMarketByQuery(params: {
  query: string;
  chainId?: string | null;
  mode?: "broad" | "ticker" | "ticker-first";
}): Promise<BantahBroMarketLookup> {
  const resolvedQuery = normalizeDexSearchQuery(params.query);
  const requestedChainId = normalizeDexChainId(params.chainId);
  const lookupMode = params.mode || "broad";
  const rawPairs = await fetchDexScreenerSearchPairs(resolvedQuery);
  const normalizedPairs = rawPairs
    .map(normalizePair)
    .filter((pair) => pair.chainId && pair.pairAddress);

  const filteredPairs =
    requestedChainId
      ? normalizedPairs.filter((pair) => normalizeDexChainId(pair.chainId) === requestedChainId)
      : normalizedPairs;

  const candidatePairs = filteredPairs.length > 0 ? filteredPairs : normalizedPairs;
  const pair = chooseMarketSearchPair(candidatePairs, params.query, lookupMode);
  const matchedPairCount =
    lookupMode !== "broad"
      ? candidatePairs.filter((candidate) => scoreTickerPairMatch(candidate, params.query) > 0).length
      : candidatePairs.length;

  return {
    query: params.query.trim(),
    resolvedQuery,
    chainId: requestedChainId,
    pair,
    pairCount: matchedPairCount,
    generatedAt: new Date().toISOString(),
  };
}
