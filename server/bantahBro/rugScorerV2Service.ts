import {
  type BantahBroHolderMetrics,
  type BantahBroPairSnapshot,
  type BantahBroRugScore,
  type BantahBroRiskLevel,
  type BantahBroTokenAnalysis,
} from "@shared/bantahBro";
import {
  analyzeToken,
  lookupMarketByQuery,
} from "./tokenIntelligence";
import {
  fetchGoPlusTokenSecurity,
  type GoPlusSecuritySnapshot,
} from "./goPlusSecurityClient";

type DexScreenerBoostedToken = {
  chainId?: string;
  tokenAddress?: string;
  amount?: number;
  totalAmount?: number;
  icon?: string;
  header?: string;
  description?: string;
  url?: string;
};

export type RugScorerV2Token = {
  id: string;
  chainId: string;
  chainLabel: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  logoUrl: string | null;
  pairUrl: string | null;
  priceUsd: number | null;
  liquidityUsd: number;
  marketCap: number | null;
  volumeH24: number;
  txnsH24: {
    buys: number;
    sells: number;
  };
  priceChangeH24: number;
  rug: BantahBroRugScore;
  holders: {
    status: BantahBroHolderMetrics["status"] | "not_requested";
    topHolderPercent: number | null;
    top10HolderPercent: number | null;
  };
  liquidityLock: {
    status: "safe" | "warning" | "danger" | "unknown";
    label: string;
    lockedPercent: number | null;
    source: "goplus";
    detail: string;
  };
  contractRisk: {
    status: "safe" | "warning" | "danger" | "unknown";
    label: string;
    source: "goplus";
    detail: string;
  };
  security: {
    provider: "goplus";
    providerStatus: GoPlusSecuritySnapshot["status"];
    holderSource: "moralis";
    holderStatus: BantahBroHolderMetrics["status"] | "not_requested";
    notes: string[];
    signals: Array<{
      key: string;
      label: string;
      tone: "safe" | "warning" | "danger" | "unknown";
      value: string | null;
      source: "goplus";
    }>;
  };
  source: "dexscreener";
  updatedAt: string;
  sparkline: number[];
};

export type RugScorerV2Dashboard = {
  generatedAt: string;
  source: "dexscreener";
  sourceStatus: "live";
  pinned: RugScorerV2Token[];
  trending: RugScorerV2Token[];
  popular: RugScorerV2Token[];
  overview: {
    analyzed: number;
    low: number;
    medium: number;
    high: number;
    lowPct: number;
    mediumPct: number;
    highPct: number;
  };
};

const DEXSCREENER_API_BASE =
  process.env.DEXSCREENER_API_BASE?.replace(/\/+$/, "") ||
  "https://api.dexscreener.com";
const DEXSCREENER_FETCH_TIMEOUT_MS = Number(
  process.env.BANTAHBRO_DEXSCREENER_FETCH_TIMEOUT_MS || 5_000,
);
const RUG_DASHBOARD_CACHE_MS = Number(process.env.BANTAHBRO_RUG_DASHBOARD_CACHE_MS || 45_000);

let dashboardCache:
  | {
      expiresAt: number;
      payload: RugScorerV2Dashboard;
    }
  | null = null;

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function chainLabel(chainId: string) {
  const normalized = String(chainId || "").toLowerCase();
  if (normalized === "solana" || normalized === "sol") return "Solana";
  if (normalized === "base" || normalized === "8453") return "Base";
  if (normalized === "arbitrum" || normalized === "42161") return "Arbitrum";
  if (normalized === "bsc" || normalized === "56") return "BSC";
  if (normalized === "ethereum" || normalized === "eth" || normalized === "1") return "Ethereum";
  if (normalized === "ton") return "TON";
  return chainId || "Unknown";
}

function tokenKey(chainId?: string | null, tokenAddress?: string | null) {
  return `${String(chainId || "").toLowerCase()}:${String(tokenAddress || "").toLowerCase()}`;
}

function buildSparkline(pair: BantahBroPairSnapshot & { rugScoreHint: number }) {
  const p5 = numberOrZero(pair.priceChange.m5);
  const p1 = numberOrZero(pair.priceChange.h1);
  const p6 = numberOrZero(pair.priceChange.h6);
  const p24 = numberOrZero(pair.priceChange.h24);

  // DexScreener gives live window deltas, not historical candles. This line is a
  // compact risk-trend projection from real windows, so we never invent prices.
  return [
    clamp(50 - p24 * 0.18, 8, 92),
    clamp(50 - p6 * 0.16, 8, 92),
    clamp(50 - p1 * 0.26, 8, 92),
    clamp(50 - p5 * 0.36, 8, 92),
    clamp(50 + (pair.txns.h1.sells - pair.txns.h1.buys) * 0.7, 8, 92),
    clamp(50 + pair.rugScoreHint * 0.35, 8, 92),
  ];
}

function holderSummaryFromAnalysis(analysis?: BantahBroTokenAnalysis | null) {
  return {
    status: analysis?.holders.status || ("not_requested" as const),
    topHolderPercent: analysis?.holders.topHolders[0]?.percentage ?? null,
    top10HolderPercent: analysis?.holders.holderSupply.top10SupplyPercent ?? null,
  };
}

function riskLevelFromScore(score: number): BantahBroRiskLevel {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function verdictFromScore(score: number) {
  if (score >= 70) return "High-risk token. Contract, LP, or market signals need caution before touching.";
  if (score >= 40) return "Medium risk. Some live signals need review before sizing exposure.";
  return "Lower observed risk from currently available live signals.";
}

function dedupeStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function defaultSecuritySnapshot(pair: BantahBroPairSnapshot): GoPlusSecuritySnapshot {
  return {
    source: "goplus",
    status: "unsupported",
    chainId: pair.chainId,
    tokenAddress: pair.baseToken.address,
    network: null,
    error: "GoPlus scan was not requested for this token.",
    contractRisk: {
      status: "unknown",
      label: "Contract not verified",
      detail: "No live contract-risk adapter result is available.",
    },
    liquidityLock: {
      status: "unknown",
      label: "LP lock not verified",
      lockedPercent: null,
      detail: "No live liquidity-lock adapter result is available.",
    },
    flags: [],
  };
}

function enhanceRugScore(rug: BantahBroRugScore, security: GoPlusSecuritySnapshot): BantahBroRugScore {
  const reasons = [...rug.reasons];
  let additiveRisk = 0;

  if (security.contractRisk.status === "danger") {
    additiveRisk += 25;
    reasons.push({
      code: "contract_red_flags",
      label: security.contractRisk.label,
      impact: 25,
    });
  } else if (security.contractRisk.status === "warning") {
    additiveRisk += 10;
    reasons.push({
      code: "contract_warnings",
      label: security.contractRisk.label,
      impact: 10,
    });
  }

  if (security.liquidityLock.status === "danger") {
    additiveRisk += 16;
    reasons.push({
      code: "lp_unlocked",
      label: security.liquidityLock.label,
      impact: 16,
    });
  } else if (security.liquidityLock.status === "warning") {
    additiveRisk += 8;
    reasons.push({
      code: "lp_partially_locked",
      label: security.liquidityLock.label,
      impact: 8,
    });
  }

  const score = clamp(Math.round(rug.score + additiveRisk), 0, 100);
  let missingSignals = [...rug.missingSignals];
  if (security.status === "available") {
    missingSignals = missingSignals.filter((signal) => signal !== "contract flags");
    if (security.liquidityLock.lockedPercent !== null) {
      missingSignals = missingSignals.filter((signal) => signal !== "liquidity lock percentage");
    }
  }

  return {
    score,
    riskLevel: riskLevelFromScore(score),
    verdict: verdictFromScore(score),
    reasons: reasons
      .sort((left, right) => right.impact - left.impact)
      .slice(0, 8),
    missingSignals: dedupeStrings(missingSignals),
  };
}

function buildSecurityNotes(security: GoPlusSecuritySnapshot) {
  const notes: string[] = [];
  if (security.status === "available") {
    notes.push(`GoPlus ${security.network || "network"} security scan live.`);
  } else if (security.error) {
    notes.push(security.error);
  }
  if (security.liquidityLock.status === "unknown") {
    notes.push("LP lock could not be verified from live security data.");
  }
  return notes;
}

function tokenFromPair(params: {
  pair: BantahBroPairSnapshot;
  rug: BantahBroRugScore;
  analysis?: BantahBroTokenAnalysis | null;
  security?: GoPlusSecuritySnapshot | null;
}): RugScorerV2Token {
  const pairWithHint = {
    ...params.pair,
    rugScoreHint: params.rug.score,
  } as BantahBroPairSnapshot & { rugScoreHint: number };
  const security = params.security || defaultSecuritySnapshot(params.pair);
  const holders = holderSummaryFromAnalysis(params.analysis);

  return {
    id: tokenKey(params.pair.chainId, params.pair.baseToken.address),
    chainId: params.pair.chainId,
    chainLabel: chainLabel(params.pair.chainId),
    tokenAddress: params.pair.baseToken.address,
    tokenSymbol: params.pair.baseToken.symbol,
    tokenName: params.pair.baseToken.name,
    logoUrl: params.pair.imageUrl,
    pairUrl: params.pair.url,
    priceUsd: params.pair.priceUsd,
    liquidityUsd: params.pair.liquidityUsd,
    marketCap: params.pair.marketCap,
    volumeH24: params.pair.volume.h24,
    txnsH24: {
      buys: params.pair.txns.h24.buys,
      sells: params.pair.txns.h24.sells,
    },
    priceChangeH24: params.pair.priceChange.h24,
    rug: params.rug,
    holders,
    liquidityLock: {
      status: security.liquidityLock.status,
      label: security.liquidityLock.label,
      lockedPercent: security.liquidityLock.lockedPercent,
      source: "goplus",
      detail: security.liquidityLock.detail,
    },
    contractRisk: {
      status: security.contractRisk.status,
      label: security.contractRisk.label,
      source: "goplus",
      detail: security.contractRisk.detail,
    },
    security: {
      provider: "goplus",
      providerStatus: security.status,
      holderSource: "moralis",
      holderStatus: holders.status,
      notes: buildSecurityNotes(security),
      signals: security.flags.slice(0, 10).map((flag) => ({
        ...flag,
        source: "goplus" as const,
      })),
    },
    source: "dexscreener",
    updatedAt: new Date().toISOString(),
    sparkline: buildSparkline(pairWithHint),
  };
}

async function fetchDexScreenerBoostedTokens() {
  const response = await fetch(`${DEXSCREENER_API_BASE}/token-boosts/top/v1`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(DEXSCREENER_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`DexScreener boosted token request failed with ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? (data as DexScreenerBoostedToken[]) : [];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results: R[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return results;
}

async function buildFastTokenFromBoost(boostedToken: DexScreenerBoostedToken) {
  if (!boostedToken.chainId || !boostedToken.tokenAddress) return null;

  const [analysis, security] = await Promise.all([
    analyzeToken({
      chainId: boostedToken.chainId,
      tokenAddress: boostedToken.tokenAddress,
    }),
    fetchGoPlusTokenSecurity({
      chainId: boostedToken.chainId,
      tokenAddress: boostedToken.tokenAddress,
    }),
  ]);
  if (!analysis.primaryPair) return null;
  const rug = enhanceRugScore(analysis.rug, security);

  return tokenFromPair({
    pair: analysis.primaryPair,
    rug,
    analysis: {
      ...analysis,
      rug,
    },
    security,
  });
}

function sortByRiskThenVolume(left: RugScorerV2Token, right: RugScorerV2Token) {
  if (right.rug.score !== left.rug.score) return right.rug.score - left.rug.score;
  return right.volumeH24 - left.volumeH24;
}

function sortByVolume(left: RugScorerV2Token, right: RugScorerV2Token) {
  return right.volumeH24 - left.volumeH24;
}

function buildOverview(tokens: RugScorerV2Token[]) {
  const analyzed = tokens.length;
  const low = tokens.filter((token) => token.rug.score < 40).length;
  const medium = tokens.filter((token) => token.rug.score >= 40 && token.rug.score < 70).length;
  const high = tokens.filter((token) => token.rug.score >= 70).length;
  const denom = Math.max(1, analyzed);

  return {
    analyzed,
    low,
    medium,
    high,
    lowPct: Math.round((low / denom) * 100),
    mediumPct: Math.round((medium / denom) * 100),
    highPct: Math.round((high / denom) * 100),
  };
}

export async function getRugScorerV2Dashboard(params: {
  scanLimit?: number;
  force?: boolean;
} = {}): Promise<RugScorerV2Dashboard> {
  if (!params.force && dashboardCache && dashboardCache.expiresAt > Date.now()) {
    return dashboardCache.payload;
  }

  const scanLimit = Math.max(8, Math.min(params.scanLimit || 28, 60));
  const boostedTokens = await fetchDexScreenerBoostedTokens();
  const dedupedBoosts: DexScreenerBoostedToken[] = [];
  const usedBoosts = new Set<string>();

  for (const boostedToken of boostedTokens) {
    const key = tokenKey(boostedToken.chainId, boostedToken.tokenAddress);
    if (!boostedToken.chainId || !boostedToken.tokenAddress || usedBoosts.has(key)) continue;
    usedBoosts.add(key);
    dedupedBoosts.push(boostedToken);
    if (dedupedBoosts.length >= scanLimit) break;
  }

  const settled = await mapWithConcurrency(dedupedBoosts, 4, async (boostedToken) => {
    try {
      return await buildFastTokenFromBoost(boostedToken);
    } catch {
      return null;
    }
  });
  const tokens = settled.filter((token): token is RugScorerV2Token => Boolean(token));

  if (tokens.length === 0) {
    throw new Error("No live DexScreener tokens were available for Rug Scorer V2.");
  }

  const popular = [...tokens].sort(sortByVolume).slice(0, 12);
  const trending = [...tokens].sort(sortByRiskThenVolume).slice(0, 7);
  const pinned = [...tokens]
    .sort((left, right) => {
      if (left.rug.score !== right.rug.score) return left.rug.score - right.rug.score;
      return right.volumeH24 - left.volumeH24;
    })
    .slice(0, 6);

  const payload: RugScorerV2Dashboard = {
    generatedAt: new Date().toISOString(),
    source: "dexscreener",
    sourceStatus: "live",
    pinned,
    trending,
    popular,
    overview: buildOverview(tokens),
  };

  dashboardCache = {
    expiresAt: Date.now() + RUG_DASHBOARD_CACHE_MS,
    payload,
  };

  return payload;
}

export async function searchRugScorerV2Token(params: {
  query: string;
  chainId?: string | null;
}) {
  const query = params.query.trim();
  if (!query) {
    throw new Error("Search query is required.");
  }

  const lookup = await lookupMarketByQuery({
    query,
    chainId: params.chainId,
    mode: "ticker-first",
  });

  if (!lookup.pair) {
    throw new Error("No live DexScreener pair found for that token.");
  }

  const [analysis, security] = await Promise.all([
    analyzeToken({
      chainId: lookup.pair.chainId,
      tokenAddress: lookup.pair.baseToken.address,
    }),
    fetchGoPlusTokenSecurity({
      chainId: lookup.pair.chainId,
      tokenAddress: lookup.pair.baseToken.address,
    }),
  ]);

  if (!analysis.primaryPair) {
    throw new Error("No active DEX pair found for that token.");
  }
  const rug = enhanceRugScore(analysis.rug, security);
  const enhancedAnalysis = {
    ...analysis,
    rug,
  };

  return {
    generatedAt: new Date().toISOString(),
    query,
    resolvedQuery: lookup.resolvedQuery,
    pairCount: lookup.pairCount,
    token: tokenFromPair({
      pair: analysis.primaryPair,
      rug,
      analysis: enhancedAnalysis,
      security,
    }),
    analysis: enhancedAnalysis,
  };
}
