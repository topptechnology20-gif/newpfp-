import { analyzeToken, lookupMarketByQuery } from "./tokenIntelligence";
import type { BantahBroTokenAnalysis } from "@shared/bantahBro";
import { getBantahBroBattleOverrideMap, type BantahBroBattleOverride } from "./battleOverridesService";
import { getBantahBroListedBattleMap, type BantahBroListedBattle } from "./battleListingsService";

const DEXSCREENER_API_BASE =
  process.env.DEXSCREENER_API_BASE?.replace(/\/+$/, "") ||
  "https://api.dexscreener.com";

const ENGINE_CACHE_TTL_MS = 15_000;
const DEFAULT_SCAN_LIMIT = 28;
const DEFAULT_CANDIDATE_LIMIT = 80;
const DEFAULT_SELECTED_LIMIT = 24;
const DEFAULT_FEATURED_LIMIT = 8;
const DEXSCREENER_ENGINE_FETCH_TIMEOUT_MS = Number(
  process.env.BANTAHBRO_ENGINE_DEXSCREENER_TIMEOUT_MS || 5_000,
);
const TOKEN_ANALYSIS_TIMEOUT_MS = Number(
  process.env.BANTAHBRO_ENGINE_TOKEN_ANALYSIS_TIMEOUT_MS || 7_500,
);

type DexScreenerBoostedToken = {
  chainId?: string;
  tokenAddress?: string;
  url?: string;
};

export type BantahBroBattleCategory =
  | "hot_war"
  | "emerging_war"
  | "agent_war"
  | "community_war"
  | "sponsored_war";

export type BantahBroBattleSafetyLabel = "safe" | "experimental" | "filtered";

export interface BantahBroBattleDiscoveryTokenProfile {
  id: string;
  emoji: string;
  logoUrl: string | null;
  displaySymbol: string;
  actualSymbol: string | null;
  tokenName: string | null;
  narrative: string;
  chainId: string | null;
  chainLabel: string | null;
  tokenAddress: string | null;
  pairAddress: string | null;
  pairUrl: string | null;
  dexId: string | null;
  priceUsd: number | null;
  priceDisplay: string;
  priceChangeM5: number;
  priceChangeH1: number;
  priceChangeH24: number;
  change: string;
  direction: "up" | "down" | "flat";
  volumeM5: number;
  volumeH1: number;
  volumeH24: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  buysM5: number;
  sellsM5: number;
  buysH1: number;
  sellsH1: number;
  buysH24: number;
  sellsH24: number;
  pairAgeMinutes: number | null;
  boostsActive: number;
  rugScore: number;
  rugRiskLevel: "low" | "medium" | "high";
  momentumScore: number;
  safetyLabel: BantahBroBattleSafetyLabel;
  eligible: boolean;
  filterFlags: {
    liquidity: boolean;
    volume: boolean;
    age: boolean;
    rug: boolean;
    honeypot: "unknown";
    contractRisk: "unknown";
  };
  source: "dexscreener";
}

export interface BantahBroBattleCandidate {
  id: string;
  title: string;
  category: BantahBroBattleCategory;
  status: "candidate";
  durationSeconds: number;
  winnerRule: "highest_price_gain" | "buy_pressure" | "volume_dominance" | "hybrid_score";
  sides: [BantahBroBattleDiscoveryTokenProfile, BantahBroBattleDiscoveryTokenProfile];
  score: number;
  scoreBreakdown: {
    momentum: number;
    volumeLiquidity: number;
    buyPressure: number;
    socialAttention: number;
    communityRivalry: number;
    whaleSmartMoney: number;
  };
  safetyLabel: BantahBroBattleSafetyLabel;
  rules: string[];
  rationale: string[];
  createdFrom: {
    marketData: "dexscreener";
    engineVersion: "v1";
  };
  adminOverride?: Pick<BantahBroBattleOverride, "hidden" | "pinned" | "featured" | "note" | "updatedAt">;
  officialListing?: Pick<BantahBroListedBattle, "id" | "status" | "source" | "listedAt" | "updatedAt">;
}

export interface BantahBroBattleEngineFeed {
  updatedAt: string;
  scanner: {
    mode: "continuous-market-scanner";
    rawScanPool: number;
    analyzedTokens: number;
    battleCandidates: number;
    selectedLiveBattles: number;
    featuredBattles: number;
    scanLimit: number;
  };
  filters: {
    minLiquidityUsd: number;
    minVolumeH24: number;
    minAgeMinutes: number;
    note: string;
  };
  candidates: BantahBroBattleCandidate[];
  selectedBattles: BantahBroBattleCandidate[];
  featuredBattles: BantahBroBattleCandidate[];
  rejectedTokens: Array<{
    symbol: string | null;
    chainId: string | null;
    tokenAddress: string | null;
    reason: string;
  }>;
  sources: {
    dexscreener: {
      active: boolean;
      message: string;
    };
    virtuals: {
      active: false;
      message: string;
    };
    bankr: {
      active: false;
      message: string;
    };
  };
}

let cachedFeed: BantahBroBattleEngineFeed | null = null;
let cachedAt = 0;
let cachedFeedKey = "";
let inflightFeedPromise: Promise<BantahBroBattleEngineFeed> | null = null;
let inflightFeedKey = "";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function formatUsd(value: number | null | undefined) {
  const resolved = safeNumber(value);
  if (resolved <= 0) return "n/a";
  if (resolved >= 1_000_000_000) return `$${(resolved / 1_000_000_000).toFixed(2)}B`;
  if (resolved >= 1_000_000) return `$${(resolved / 1_000_000).toFixed(2)}M`;
  if (resolved >= 1_000) return `$${(resolved / 1_000).toFixed(1)}K`;
  if (resolved >= 1) return `$${resolved.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${resolved.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0.00%";
  const absolute = Math.abs(value);
  const precision = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
  return `${value > 0 ? "+" : ""}${value.toFixed(precision)}%`;
}

function chainLabel(chainId?: string | null) {
  const normalized = String(chainId || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "sol" || normalized === "solana") return "Solana";
  if (normalized === "8453" || normalized === "base") return "Base";
  if (normalized === "42161" || normalized === "arb" || normalized === "arbitrum") return "Arbitrum";
  if (normalized === "56" || normalized === "bsc" || normalized === "bnb") return "BSC";
  if (normalized === "1" || normalized === "eth" || normalized === "ethereum") return "Ethereum";
  return String(chainId);
}

function normalizeSymbol(value?: string | null) {
  return String(value || "LIVE").replace(/^\$/, "").trim() || "LIVE";
}

function tokenKey(chainId?: string | null, tokenAddress?: string | null) {
  return `${String(chainId || "").toLowerCase()}:${String(tokenAddress || "").toLowerCase()}`;
}

function battleKey(left: BantahBroBattleDiscoveryTokenProfile, right: BantahBroBattleDiscoveryTokenProfile) {
  return [left.id, right.id].sort().join("__");
}

function stableBattleId(left: BantahBroBattleDiscoveryTokenProfile, right: BantahBroBattleDiscoveryTokenProfile) {
  return `bb-engine-v1-${battleKey(left, right)}`.replace(/[^a-zA-Z0-9:-]/g, "-").slice(0, 180);
}

function battleEmoji(narrative: string, index: number) {
  if (narrative === "ai_agents") return "\uD83E\uDD16";
  if (narrative === "dog_coins") return "\uD83D\uDC36";
  if (narrative === "frog_coins") return "\uD83D\uDC38";
  if (narrative === "politics") return "\uD83C\uDFFB";
  const emojis = ["\uD83D\uDD25", "\u2694\uFE0F", "\uD83D\uDE08", "\uD83D\uDE80", "\uD83D\uDC8E", "\uD83E\uDDEA"];
  return emojis[index % emojis.length];
}

function narrativeForToken(symbol: string | null, name: string | null) {
  const text = `${symbol || ""} ${name || ""}`.toLowerCase();
  if (/(ai|gpt|bot|agent|virtual|aixbt|vader|bankr|clanker|zerebro)/i.test(text)) return "ai_agents";
  if (/(pepe|frog|ribbit|kermit)/i.test(text)) return "frog_coins";
  if (/(bonk|wif|doge|shib|inu|dog|floki|woof)/i.test(text)) return "dog_coins";
  if (/(cat|mew|popcat|kitty)/i.test(text)) return "cat_coins";
  if (/(maga|trump|biden|usa|politic)/i.test(text)) return "politics";
  if (/(wojak|cope|sad)/i.test(text)) return "wojak";
  if (/(game|play|arcade|gamer)/i.test(text)) return "gaming";
  return "memes";
}

function isKnownRivalry(left: BantahBroBattleDiscoveryTokenProfile, right: BantahBroBattleDiscoveryTokenProfile) {
  const pair = [normalizeSymbol(left.actualSymbol), normalizeSymbol(right.actualSymbol)].sort().join("/");
  const known = new Set([
    "BONK/PEPE",
    "PEPE/WOJAK",
    "BONK/WIF",
    "DOGE/SHIB",
    "ETH/SOL",
    "AIXBT/VADER",
    "BRETT/PEPE",
  ]);
  return known.has(pair);
}

function minLiquidityUsd() {
  return Number(process.env.BANTAHBRO_ENGINE_MIN_LIQUIDITY_USD || 50_000);
}

function minVolumeH24() {
  return Number(process.env.BANTAHBRO_ENGINE_MIN_VOLUME_H24_USD || 100_000);
}

function minAgeMinutes() {
  return Number(process.env.BANTAHBRO_ENGINE_MIN_AGE_MINUTES || 0);
}

function safetyFromAnalysis(analysis: BantahBroTokenAnalysis) {
  const pair = analysis.primaryPair;
  const liquidity = safeNumber(pair?.liquidityUsd);
  const volume = safeNumber(pair?.volume.h24);
  const age = pair?.pairAgeMinutes;
  const ageRequirement = minAgeMinutes();
  const flags = {
    liquidity: liquidity >= minLiquidityUsd(),
    volume: volume >= minVolumeH24(),
    age: ageRequirement <= 0 || age === null || age >= ageRequirement,
    rug: analysis.rug.riskLevel !== "high",
    honeypot: "unknown" as const,
    contractRisk: "unknown" as const,
  };
  const eligible = flags.liquidity && flags.volume && flags.age && flags.rug;
  const experimental =
    !eligible &&
    liquidity >= Math.max(10_000, minLiquidityUsd() * 0.2) &&
    volume >= Math.max(25_000, minVolumeH24() * 0.25) &&
    analysis.rug.riskLevel !== "high";

  return {
    flags,
    eligible,
    safetyLabel: eligible ? ("safe" as const) : experimental ? ("experimental" as const) : ("filtered" as const),
  };
}

function profileFromAnalysis(analysis: BantahBroTokenAnalysis, index: number): BantahBroBattleDiscoveryTokenProfile | null {
  const pair = analysis.primaryPair;
  if (!pair) return null;

  const safety = safetyFromAnalysis(analysis);
  const symbol = normalizeSymbol(pair.baseToken.symbol || analysis.tokenSymbol);
  const priceChangeH24 = pair.priceChange.h24;
  const direction = priceChangeH24 > 0 ? ("up" as const) : priceChangeH24 < 0 ? ("down" as const) : ("flat" as const);
  const narrative = narrativeForToken(pair.baseToken.symbol, pair.baseToken.name);

  return {
    id: tokenKey(pair.chainId, pair.baseToken.address),
    emoji: battleEmoji(narrative, index),
    logoUrl: pair.imageUrl,
    displaySymbol: `$${symbol}`,
    actualSymbol: pair.baseToken.symbol || analysis.tokenSymbol,
    tokenName: pair.baseToken.name || analysis.tokenName,
    narrative,
    chainId: pair.chainId,
    chainLabel: chainLabel(pair.chainId),
    tokenAddress: pair.baseToken.address,
    pairAddress: pair.pairAddress,
    pairUrl: pair.url,
    dexId: pair.dexId,
    priceUsd: pair.priceUsd,
    priceDisplay: formatUsd(pair.priceUsd),
    priceChangeM5: pair.priceChange.m5,
    priceChangeH1: pair.priceChange.h1,
    priceChangeH24,
    change: formatPercent(priceChangeH24),
    direction,
    volumeM5: pair.volume.m5,
    volumeH1: pair.volume.h1,
    volumeH24: pair.volume.h24,
    liquidityUsd: pair.liquidityUsd,
    marketCap: pair.marketCap,
    buysM5: pair.txns.m5.buys,
    sellsM5: pair.txns.m5.sells,
    buysH1: pair.txns.h1.buys,
    sellsH1: pair.txns.h1.sells,
    buysH24: pair.txns.h24.buys,
    sellsH24: pair.txns.h24.sells,
    pairAgeMinutes: pair.pairAgeMinutes,
    boostsActive: pair.boostsActive,
    rugScore: analysis.rug.score,
    rugRiskLevel: analysis.rug.riskLevel,
    momentumScore: analysis.momentum.score,
    safetyLabel: safety.safetyLabel,
    eligible: safety.eligible,
    filterFlags: safety.flags,
    source: "dexscreener",
  };
}

async function fetchDexScreenerBoostedTokens() {
  const response = await fetch(`${DEXSCREENER_API_BASE}/token-boosts/top/v1`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(DEXSCREENER_ENGINE_FETCH_TIMEOUT_MS),
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

function scoreCandidate(left: BantahBroBattleDiscoveryTokenProfile, right: BantahBroBattleDiscoveryTokenProfile) {
  const avgAbsH1 = (Math.abs(left.priceChangeH1) + Math.abs(right.priceChangeH1)) / 2;
  const avgAbsH24 = (Math.abs(left.priceChangeH24) + Math.abs(right.priceChangeH24)) / 2;
  const trendSimilarity = clamp(1 - Math.abs(left.priceChangeH1 - right.priceChangeH1) / 100, 0, 1);
  const momentum = clamp(avgAbsH1 * 0.7 + avgAbsH24 * 0.14 + trendSimilarity * 7, 0, 25);

  const combinedVolume = safeNumber(left.volumeH24) + safeNumber(right.volumeH24);
  const combinedLiquidity = safeNumber(left.liquidityUsd) + safeNumber(right.liquidityUsd);
  const volumeLiquidity = clamp(Math.log10(combinedVolume + 1) * 3 + Math.log10(combinedLiquidity + 1) * 2.2, 0, 25);

  const leftM5Txns = left.buysM5 + left.sellsM5;
  const rightM5Txns = right.buysM5 + right.sellsM5;
  const leftBuyRatio = leftM5Txns > 0 ? left.buysM5 / leftM5Txns : 0.5;
  const rightBuyRatio = rightM5Txns > 0 ? right.buysM5 / rightM5Txns : 0.5;
  const buyPressure = clamp((Math.abs(leftBuyRatio - 0.5) + Math.abs(rightBuyRatio - 0.5)) * 24 + Math.log10(leftM5Txns + rightM5Txns + 1) * 4, 0, 20);

  const communityRivalry = clamp(
    (left.narrative === right.narrative ? 8 : 0) +
      (isKnownRivalry(left, right) ? 10 : 0) +
      (left.chainId && right.chainId && left.chainId !== right.chainId ? 3 : 0),
    0,
    10,
  );

  const socialAttention = clamp((left.boostsActive + right.boostsActive) * 4 + Math.max(left.momentumScore, right.momentumScore) * 0.08, 0, 15);
  const whaleSmartMoney = clamp(
    Math.log10(left.volumeM5 + right.volumeM5 + 1) * 1.1 +
      (left.volumeM5 > 50_000 || right.volumeM5 > 50_000 ? 2 : 0),
    0,
    5,
  );

  return {
    momentum: Math.round(momentum),
    volumeLiquidity: Math.round(volumeLiquidity),
    buyPressure: Math.round(buyPressure),
    socialAttention: Math.round(socialAttention),
    communityRivalry: Math.round(communityRivalry),
    whaleSmartMoney: Math.round(whaleSmartMoney),
  };
}

function candidateCategory(left: BantahBroBattleDiscoveryTokenProfile, right: BantahBroBattleDiscoveryTokenProfile): BantahBroBattleCategory {
  if (left.narrative === "ai_agents" || right.narrative === "ai_agents") return "agent_war";
  if (isKnownRivalry(left, right)) return "community_war";
  if (Math.max(left.priceChangeM5, right.priceChangeM5, left.priceChangeH1, right.priceChangeH1) >= 18) {
    return "emerging_war";
  }
  return "hot_war";
}

function winnerRuleForCandidate(category: BantahBroBattleCategory): BantahBroBattleCandidate["winnerRule"] {
  if (category === "emerging_war") return "highest_price_gain";
  if (category === "agent_war") return "hybrid_score";
  return "hybrid_score";
}

function buildCandidate(
  left: BantahBroBattleDiscoveryTokenProfile,
  right: BantahBroBattleDiscoveryTokenProfile,
  index: number,
): BantahBroBattleCandidate {
  const breakdown = scoreCandidate(left, right);
  const score = Math.round(
    breakdown.momentum +
      breakdown.volumeLiquidity +
      breakdown.buyPressure +
      breakdown.socialAttention +
      breakdown.communityRivalry +
      breakdown.whaleSmartMoney,
  );
  const category = candidateCategory(left, right);
  const leftSymbol = normalizeSymbol(left.actualSymbol);
  const rightSymbol = normalizeSymbol(right.actualSymbol);
  const safetyLabel =
    left.safetyLabel === "safe" && right.safetyLabel === "safe"
      ? "safe"
      : left.safetyLabel === "filtered" || right.safetyLabel === "filtered"
        ? "filtered"
        : "experimental";

  const rationale = [
    `${leftSymbol} ${left.change} vs ${rightSymbol} ${right.change} over 24H.`,
    `Combined 24H volume ${formatUsd(safeNumber(left.volumeH24) + safeNumber(right.volumeH24))}.`,
  ];
  if (left.narrative === right.narrative) {
    rationale.push(`Shared narrative: ${left.narrative.replace(/_/g, " ")}.`);
  }
  if (isKnownRivalry(left, right)) {
    rationale.push("Known community rivalry detected.");
  }

  return {
    id: stableBattleId(left, right),
    title: `${left.displaySymbol} VS ${right.displaySymbol}`,
    category,
    status: "candidate",
    durationSeconds: category === "emerging_war" ? 300 : 900,
    winnerRule: winnerRuleForCandidate(category),
    sides: [left, right],
    score,
    scoreBreakdown: breakdown,
    safetyLabel,
    rules: [
      "Users join armies and predict the winning side P2P.",
      "External market activity drives the arena.",
      "Sponsored visibility never controls the winner.",
    ],
    rationale,
    createdFrom: {
      marketData: "dexscreener",
      engineVersion: "v1",
    },
  };
}

export async function buildBattleCandidateFromQueries(params: {
  leftQuery: string;
  rightQuery: string;
  listedIndex?: number;
}): Promise<{
  candidate: BantahBroBattleCandidate;
  resolved: {
    left: BantahBroBattleDiscoveryTokenProfile;
    right: BantahBroBattleDiscoveryTokenProfile;
  };
}> {
  const leftLookup = await lookupMarketByQuery({
    query: params.leftQuery,
    mode: "ticker-first",
  });
  const rightLookup = await lookupMarketByQuery({
    query: params.rightQuery,
    mode: "ticker-first",
  });

  if (!leftLookup.pair) {
    throw new Error(`Could not resolve ${params.leftQuery} to a live Dexscreener pair.`);
  }
  if (!rightLookup.pair) {
    throw new Error(`Could not resolve ${params.rightQuery} to a live Dexscreener pair.`);
  }

  const [leftAnalysis, rightAnalysis] = await Promise.all([
    analyzeToken({
      chainId: leftLookup.pair.chainId,
      tokenAddress: leftLookup.pair.baseToken.address,
    }),
    analyzeToken({
      chainId: rightLookup.pair.chainId,
      tokenAddress: rightLookup.pair.baseToken.address,
    }),
  ]);

  const left = profileFromAnalysis(leftAnalysis, 0);
  const right = profileFromAnalysis(rightAnalysis, 1);

  if (!left) {
    throw new Error(`Could not build a battle profile for ${params.leftQuery}.`);
  }
  if (!right) {
    throw new Error(`Could not build a battle profile for ${params.rightQuery}.`);
  }
  if (left.id === right.id) {
    throw new Error("A battle needs two different live tokens.");
  }

  return {
    candidate: buildCandidate(left, right, params.listedIndex || 0),
    resolved: { left, right },
  };
}

function withAdminOverrides(
  candidates: BantahBroBattleCandidate[],
  overrideMap: Map<string, BantahBroBattleOverride>,
  listedMap: Map<string, BantahBroListedBattle>,
) {
  return candidates.map((candidate) => {
    const override = overrideMap.get(candidate.id);
    const listing = listedMap.get(candidate.id);
    if (!override && !listing) return candidate;
    return {
      ...candidate,
      adminOverride: override
        ? {
            hidden: override.hidden,
            pinned: override.pinned,
            featured: override.featured,
            note: override.note,
            updatedAt: override.updatedAt,
          }
        : undefined,
      officialListing: listing
        ? {
            id: listing.id,
            status: listing.status,
            source: listing.source,
            listedAt: listing.listedAt,
            updatedAt: listing.updatedAt,
          }
        : undefined,
    };
  });
}

function rankWithOverrides(candidates: BantahBroBattleCandidate[]) {
  return [...candidates].sort((left, right) => {
    const leftPinned = left.adminOverride?.pinned ? 1 : 0;
    const rightPinned = right.adminOverride?.pinned ? 1 : 0;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;

    const leftFeatured = left.adminOverride?.featured ? 1 : 0;
    const rightFeatured = right.adminOverride?.featured ? 1 : 0;
    if (leftFeatured !== rightFeatured) return rightFeatured - leftFeatured;

    if (right.safetyLabel !== left.safetyLabel) {
      if (left.safetyLabel === "safe") return -1;
      if (right.safetyLabel === "safe") return 1;
    }

    return right.score - left.score;
  });
}

function buildCandidates(profiles: BantahBroBattleDiscoveryTokenProfile[], limit: number) {
  const accepted = profiles.filter((profile) => profile.safetyLabel !== "filtered");
  const candidates: BantahBroBattleCandidate[] = [];
  const seen = new Set<string>();

  for (let leftIndex = 0; leftIndex < accepted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < accepted.length; rightIndex += 1) {
      const left = accepted[leftIndex];
      const right = accepted[rightIndex];
      if (left.id === right.id) continue;
      const key = battleKey(left, right);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(buildCandidate(left, right, candidates.length));
    }
  }

  return candidates
    .sort((left, right) => {
      if (right.safetyLabel !== left.safetyLabel) {
        if (left.safetyLabel === "safe") return -1;
        if (right.safetyLabel === "safe") return 1;
      }
      return right.score - left.score;
    })
    .slice(0, limit);
}

function selectBattles(candidates: BantahBroBattleCandidate[], limit: number) {
  const selected: BantahBroBattleCandidate[] = [];
  const usedTokens = new Set<string>();

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const [left, right] = candidate.sides;
    const hasTokenOverlap = usedTokens.has(left.id) || usedTokens.has(right.id);
    if (hasTokenOverlap) continue;
    selected.push(candidate);
    usedTokens.add(left.id);
    usedTokens.add(right.id);
  }

  return selected;
}

async function buildFeed(options: {
  scanLimit?: number;
  candidateLimit?: number;
  selectedLimit?: number;
  featuredLimit?: number;
} = {}): Promise<BantahBroBattleEngineFeed> {
  const scanLimit = clamp(Math.round(options.scanLimit || DEFAULT_SCAN_LIMIT), 4, 80);
  const candidateLimit = clamp(Math.round(options.candidateLimit || DEFAULT_CANDIDATE_LIMIT), 4, 240);
  const selectedLimit = clamp(Math.round(options.selectedLimit || DEFAULT_SELECTED_LIMIT), 2, 60);
  const featuredLimit = clamp(Math.round(options.featuredLimit || DEFAULT_FEATURED_LIMIT), 1, 12);

  const boostedTokens = await fetchDexScreenerBoostedTokens();
  const uniqueTokens = Array.from(
    new Map(
      boostedTokens
        .filter((token) => token.chainId && token.tokenAddress)
        .map((token) => [tokenKey(token.chainId, token.tokenAddress), token] as const),
    ).values(),
  ).slice(0, scanLimit);

  const analyses = await mapWithConcurrency(uniqueTokens, 4, async (token, index) => {
    try {
      const analysis = await withTimeout(
        analyzeToken({
          chainId: String(token.chainId),
          tokenAddress: String(token.tokenAddress),
        }),
        TOKEN_ANALYSIS_TIMEOUT_MS,
        `Dexscreener token analysis ${token.chainId}:${token.tokenAddress}`,
      );
      return profileFromAnalysis(analysis, index);
    } catch {
      return null;
    }
  });

  const profiles = analyses.filter((profile): profile is BantahBroBattleDiscoveryTokenProfile => Boolean(profile));
  const [overrideMap, listedMap] = await Promise.all([
    getBantahBroBattleOverrideMap().catch((error) => {
      console.warn("[BantahBro Battle Engine] Admin overrides unavailable; continuing live scan.", error);
      return new Map<string, BantahBroBattleOverride>();
    }),
    getBantahBroListedBattleMap().catch((error) => {
      console.warn("[BantahBro Battle Engine] Listed battle map unavailable; continuing live scan.", error);
      return new Map<string, BantahBroListedBattle>();
    }),
  ]);
  const candidates = withAdminOverrides(buildCandidates(profiles, candidateLimit), overrideMap, listedMap);
  const publicCandidates = rankWithOverrides(candidates.filter((candidate) => !candidate.adminOverride?.hidden));
  const selectedBattles = selectBattles(publicCandidates, selectedLimit);
  const featuredBattles = rankWithOverrides([
    ...selectedBattles.filter((candidate) => candidate.adminOverride?.featured),
    ...selectedBattles.filter((candidate) => !candidate.adminOverride?.featured),
  ]).slice(0, featuredLimit);
  const rejectedTokens = profiles
    .filter((profile) => profile.safetyLabel === "filtered")
    .slice(0, 20)
    .map((profile) => ({
      symbol: profile.actualSymbol,
      chainId: profile.chainId,
      tokenAddress: profile.tokenAddress,
      reason:
        profile.rugRiskLevel === "high"
          ? "High rug-risk score."
          : "Below V1 liquidity/volume battle thresholds.",
    }));

  return {
    updatedAt: new Date().toISOString(),
    scanner: {
      mode: "continuous-market-scanner",
      rawScanPool: boostedTokens.length,
      analyzedTokens: profiles.length,
      battleCandidates: candidates.length,
      selectedLiveBattles: selectedBattles.length,
      featuredBattles: featuredBattles.length,
      scanLimit,
    },
    filters: {
      minLiquidityUsd: minLiquidityUsd(),
      minVolumeH24: minVolumeH24(),
      minAgeMinutes: minAgeMinutes(),
      note:
        "V1 favors quality over quantity. Tokens below thresholds can appear only as experimental candidates, never as guaranteed safe battles.",
    },
    candidates,
    selectedBattles,
    featuredBattles,
    rejectedTokens,
    sources: {
      dexscreener: {
        active: profiles.length > 0,
        message: "Dexscreener boosted/trending tokens power the V1 continuous market scanner.",
      },
      virtuals: {
        active: false,
        message: "Virtuals ACP agent import is planned for the Agent Wars source layer.",
      },
      bankr: {
        active: false,
        message: "Bankr agent registry import is planned for the Agent Wars source layer.",
      },
    },
  };
}

function feedCacheKey(options: {
  scanLimit?: number;
  candidateLimit?: number;
  selectedLimit?: number;
  featuredLimit?: number;
}) {
  return JSON.stringify({
    scanLimit: clamp(Math.round(options.scanLimit || DEFAULT_SCAN_LIMIT), 4, 80),
    candidateLimit: clamp(Math.round(options.candidateLimit || DEFAULT_CANDIDATE_LIMIT), 4, 240),
    selectedLimit: clamp(Math.round(options.selectedLimit || DEFAULT_SELECTED_LIMIT), 2, 60),
    featuredLimit: clamp(Math.round(options.featuredLimit || DEFAULT_FEATURED_LIMIT), 1, 12),
  });
}

export async function getBantahBroBattleEngineFeed(options: {
  scanLimit?: number;
  candidateLimit?: number;
  selectedLimit?: number;
  featuredLimit?: number;
  bypassCache?: boolean;
} = {}) {
  const now = Date.now();
  const key = feedCacheKey(options);
  if (!options.bypassCache && cachedFeed && cachedFeedKey === key && now - cachedAt < ENGINE_CACHE_TTL_MS) {
    return cachedFeed;
  }

  if (!inflightFeedPromise || inflightFeedKey !== key || options.bypassCache) {
    inflightFeedKey = key;
    inflightFeedPromise = buildFeed(options)
      .then((feed) => {
        cachedFeed = feed;
        cachedFeedKey = key;
        cachedAt = Date.now();
        return feed;
      })
      .finally(() => {
        inflightFeedPromise = null;
      });
  }

  return inflightFeedPromise;
}
