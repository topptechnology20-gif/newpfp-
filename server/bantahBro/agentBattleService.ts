import { asc, desc, sql, isNotNull } from "drizzle-orm";
import { botaFighterProfiles } from "@shared/schema.ts";
import type { BotaFighterProfile } from "@shared/botaFighterProfile";
import { db } from "../db";
import {
  getBantahBroBattleEngineFeed,
  type BantahBroBattleCandidate,
  type BantahBroBattleDiscoveryTokenProfile,
} from "./battleDiscoveryEngine";
import { listBantahBroListedBattleCandidates } from "./battleListingsService";
import {
  choosePrimaryPair,
  fetchDexScreenerTokenPairs,
  normalizePair,
} from "./tokenIntelligence";
import { getPublicEnsFighterProfiles } from "./ensPublicFighterService";
import { hydrateAgentBattleFeedLiveStats } from "./botaLiveStatsService";
import { getExternalAgentCatalogProfiles } from "./externalAgentCatalogService";
import { listBotaAgentChallenges, type BotaAgentChallenge } from "./botaAgentChallengeService";
import { getFighterToolLoadoutMap } from "./gen1EconomyService";

const AGENT_BATTLE_CACHE_TTL_MS = 5_000;
const IMPORTED_BATTLE_PROFILE_CACHE_TTL_MS = Math.max(
  10_000,
  Math.min(Number.parseInt(String(process.env.BOTA_IMPORTED_BATTLE_PROFILE_CACHE_TTL_MS || "60000"), 10) || 60_000, 600_000),
);
const IMPORTED_BATTLE_PROFILE_TIMEOUT_MS = Math.max(
  500,
  Math.min(Number.parseInt(String(process.env.BOTA_IMPORTED_BATTLE_PROFILE_TIMEOUT_MS || "5000"), 10) || 5_000, 10_000),
);
const ENS_BATTLE_PROFILE_TIMEOUT_MS = Math.max(
  500,
  Math.min(Number.parseInt(String(process.env.BOTA_ENS_BATTLE_PROFILE_TIMEOUT_MS || "900"), 10) || 900, 15_000),
);
const DEFAULT_BATTLE_WINDOW_MINUTES = 3;
const LISTED_BATTLES_TIMEOUT_MS = Number(process.env.BANTAHBRO_LISTED_BATTLES_TIMEOUT_MS || 3_500);
const LISTED_BATTLE_REFRESH_TIMEOUT_MS = Number(process.env.BANTAHBRO_LISTED_BATTLE_REFRESH_TIMEOUT_MS || 5_000);
const BATTLE_ENGINE_TIMEOUT_MS = Number(process.env.BANTAHBRO_BATTLE_ENGINE_TIMEOUT_MS || 7_500);
const SERVER_ARENA_AGENT_AVATARS = [
  "/2dgame/image/mascots/actions/bantah-punch-avatar-portrait.png",
  "/2dgame/image/mascots/actions/bantah-rival-punch-avatar-portrait.png",
  "/2dgame/image/mascots/actions/bantah-sword-avatar-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-emerald-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-purple-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-red-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-silver-portrait.png",
] as const;

function getBattleWindowMinutes() {
  const configured = Number.parseInt(
    String(process.env.BANTAHBRO_AGENT_BATTLE_DURATION_MINUTES || "").trim(),
    10,
  );
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_BATTLE_WINDOW_MINUTES;
}

function getBattleWindowMs() {
  return getBattleWindowMinutes() * 60 * 1000;
}

function normalizeBattleIdentity(value: string) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9:-]/g, "-")
    .slice(0, 180);
}

function stableIndex(seed: string, length: number) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash % length;
}

function arenaAgentAvatar(seed: string) {
  return SERVER_ARENA_AGENT_AVATARS[stableIndex(seed, SERVER_ARENA_AGENT_AVATARS.length)];
}

function isNonFighterCoverArtUrl(value: string | null | undefined) {
  const avatarUrl = String(value || "").trim().toLowerCase();
  if (!avatarUrl) return true;
  if (avatarUrl.includes("/arena-agents/")) return true;
  if (!avatarUrl.startsWith("/assets/")) return false;
  return (
    avatarUrl.includes("/source-") ||
    avatarUrl.includes("/ens-badge") ||
    avatarUrl.includes("/bota-bantah-icon") ||
    avatarUrl.includes("/bota-external-agent") ||
    avatarUrl.includes("/bota-generated-fighter") ||
    avatarUrl.includes("/base-icon-") ||
    avatarUrl.endsWith(".svg")
  );
}

function normalizeStoredAvatarUrl(value: string | null | undefined, seed: string) {
  const avatarUrl = String(value || "").trim();
  if (isNonFighterCoverArtUrl(avatarUrl)) {
    return arenaAgentAvatar(seed);
  }
  return avatarUrl;
}

type BattleTokenIdentitySide = {
  id?: string | null;
  chainId?: string | null;
  tokenAddress?: string | null;
};

function tokenIdentityForBattleSide(side?: BattleTokenIdentitySide | null) {
  const chainId = String(side?.chainId || "").trim().toLowerCase();
  const tokenAddress = String(side?.tokenAddress || "").trim().toLowerCase();
  if (chainId && tokenAddress) {
    return normalizeBattleIdentity(`${chainId}:${tokenAddress}`);
  }
  return normalizeBattleIdentity(String(side?.id || ""));
}

function collectUniqueBattleTokenIdentities(
  sides: Array<BattleTokenIdentitySide | null | undefined>,
) {
  const tokenIdentities: string[] = [];
  const seen = new Set<string>();
  for (const side of sides) {
    const identity = tokenIdentityForBattleSide(side);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    tokenIdentities.push(identity);
  }
  return tokenIdentities;
}

function candidateTokenIdentities(candidate?: BantahBroBattleCandidate | null) {
  return collectUniqueBattleTokenIdentities(candidate?.sides || []);
}

function battleTokenIdentities(battle?: BantahBroAgentBattle | null) {
  return collectUniqueBattleTokenIdentities(battle?.sides || []);
}

function hasTokenIdentityOverlap(tokenIdentities: string[], usedTokenIdentities: Set<string>) {
  return tokenIdentities.some((identity) => usedTokenIdentities.has(identity));
}

function markTokenIdentitiesUsed(tokenIdentities: string[], usedTokenIdentities: Set<string>) {
  for (const identity of tokenIdentities) {
    usedTokenIdentities.add(identity);
  }
}

export interface BantahBroAgentBattleSide {
  id: string;
  label: string;
  agentName: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  emoji: string;
  logoUrl: string | null;
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
  dataSource: "dexscreener" | "fighter-profile" | "ens-subgraph";
  dataUpdatedAt: string;
  score: number;
  confidence: number;
  leaderboardRank?: number;
  rank?: number;
  bantCreditsEarned?: number | null;
  liveSpectators?: number | null;
  status: "attacking" | "defending" | "staggered" | "holding";
  loadoutTools?: { id: string; name: string; imageUrl: string; type: string }[];
}

export interface BantahBroAgentBattleEvent {
  id: string;
  time: string;
  type: "momentum" | "volume" | "liquidity" | "system";
  severity: "info" | "hot" | "danger";
  sideId: string | null;
  agentName: string;
  message: string;
  metricLabel: string | null;
  metricValue: string | null;
}

export interface BantahBroAgentBattle {
  id: string;
  title: string;
  battleType: "agent-battle";
  status: "live" | "expired";
  winnerLogic: string;
  startsAt: string;
  endsAt: string;
  timeRemainingSeconds: number;
  spectators: number;
  spectatorBantCredits?: number;
  rewardClaimBantCredits?: number;
  bantCreditsEarned?: number;
  liveStatsUpdatedAt?: string;
  isChallenge?: boolean;
  challengeCode?: string;
  sides: [BantahBroAgentBattleSide, BantahBroAgentBattleSide];
  leadingSideId: string;
  confidenceSpread: number;
  events: BantahBroAgentBattleEvent[];
  updatedAt: string;
}

export interface BantahBroAgentBattlesFeed {
  battles: BantahBroAgentBattle[];
  updatedAt: string;
  sources: {
    marketData: "dexscreener" | "fighter-profiles" | "ens-subgraph";
    note: string;
  };
}

type LiveAgentBattlesOptions = {
  hydrateLiveStats?: boolean;
};

let cachedFeed: BantahBroAgentBattlesFeed | null = null;
let cachedAt = 0;
let cachedLimit = 0;
let inflightFeedPromise: Promise<BantahBroAgentBattlesFeed> | null = null;
let inflightLimit = 0;
let lockedRoundBattleIds: string[] = [];
let lockedRoundCandidateSnapshots: BantahBroBattleCandidate[] = [];
let lockedRoundBattleSnapshots: BantahBroAgentBattle[] = [];
let lastNonEmptyFeed: BantahBroAgentBattlesFeed | null = null;
let cachedImportedBattleProfiles: BotaFighterProfile[] = [];
let cachedImportedBattleProfilesAt = 0;

type BattleTokenEntry = Pick<
  BantahBroBattleDiscoveryTokenProfile,
  | "id"
  | "emoji"
  | "logoUrl"
  | "displaySymbol"
  | "actualSymbol"
  | "tokenName"
  | "change"
  | "direction"
  | "priceChangeH24"
  | "priceUsd"
  | "priceDisplay"
  | "chainId"
  | "chainLabel"
  | "marketCap"
  | "liquidityUsd"
  | "volumeH24"
  | "volumeM5"
  | "volumeH1"
  | "priceChangeM5"
  | "priceChangeH1"
  | "buysM5"
  | "sellsM5"
  | "buysH1"
  | "sellsH1"
  | "buysH24"
  | "sellsH24"
  | "tokenAddress"
  | "pairAddress"
  | "pairUrl"
  | "dexId"
  | "pairAgeMinutes"
>;

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

function normalizeSymbol(entry: BattleTokenEntry) {
  const symbol = entry.actualSymbol || entry.displaySymbol || "LIVE";
  return symbol.replace(/^\$/, "").trim() || "LIVE";
}

function formatUsd(value: number | null | undefined) {
  const resolved = safeNumber(value);
  if (resolved <= 0) return "n/a";
  if (resolved >= 1_000_000_000) return `$${(resolved / 1_000_000_000).toFixed(2)}B`;
  if (resolved >= 1_000_000) return `$${(resolved / 1_000_000).toFixed(2)}M`;
  if (resolved >= 1_000) return `$${(resolved / 1_000).toFixed(1)}K`;
  return `$${resolved.toFixed(2)}`;
}

function formatInteger(value: number | null | undefined) {
  return Math.round(safeNumber(value)).toLocaleString("en-US");
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0.00%";
  const absolute = Math.abs(value);
  const precision = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
  return `${value > 0 ? "+" : ""}${value.toFixed(precision)}%`;
}

function formatPrice(value: number | null | undefined) {
  const resolved = safeNumber(value);
  if (resolved <= 0) return "n/a";
  if (resolved >= 1) return `$${resolved.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${resolved.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function scoreEntry(entry: BattleTokenEntry) {
  const change =
    safeNumber(entry.priceChangeM5) * 1.5 +
    safeNumber(entry.priceChangeH1) * 0.85 +
    safeNumber(entry.priceChangeH24) * 0.35;
  const volume = safeNumber(entry.volumeM5) * 18 + safeNumber(entry.volumeH1) * 4 + safeNumber(entry.volumeH24);
  const liquidity = safeNumber(entry.liquidityUsd);
  const shortTrades = safeNumber(entry.buysM5) + safeNumber(entry.sellsM5);
  const h1Trades = safeNumber(entry.buysH1) + safeNumber(entry.sellsH1);
  const buyRatio =
    shortTrades > 0
      ? safeNumber(entry.buysM5) / shortTrades
      : h1Trades > 0
        ? safeNumber(entry.buysH1) / h1Trades
        : 0.5;
  const momentumScore = clamp(50 + change * 1.15, 0, 110);
  const volumeScore = clamp(Math.log10(volume + 1) * 6, 0, 42);
  const liquidityScore = clamp(Math.log10(liquidity + 1) * 4, 0, 28);
  const buyPressureScore = clamp((buyRatio - 0.5) * 38 + Math.log10(shortTrades + h1Trades + 1) * 3, -18, 24);
  const trendBonus = entry.direction === "up" ? 8 : entry.direction === "down" ? -8 : 0;

  return Math.max(1, Math.round(momentumScore + volumeScore + liquidityScore + buyPressureScore + trendBonus));
}

function buildSide(
  entry: BattleTokenEntry,
  confidence: number,
  score: number,
): BantahBroAgentBattleSide {
  const symbol = normalizeSymbol(entry);
  const status =
    confidence >= 58
      ? "attacking"
      : confidence <= 42
        ? "staggered"
        : entry.direction === "up"
          ? "defending"
          : "holding";

  return {
    id: `${String(entry.chainId || "unknown").toLowerCase()}:${String(entry.tokenAddress || entry.id).toLowerCase()}`,
    label: entry.displaySymbol || `$${symbol}`,
    agentName: `${symbol} Agent`,
    tokenSymbol: entry.actualSymbol,
    tokenName: entry.tokenName,
    emoji: entry.emoji,
    logoUrl: entry.logoUrl,
    chainId: entry.chainId,
    chainLabel: entry.chainLabel,
    tokenAddress: entry.tokenAddress,
    pairAddress: entry.pairAddress,
    pairUrl: entry.pairUrl,
    dexId: entry.dexId,
    priceUsd: entry.priceUsd,
    priceDisplay: entry.priceDisplay,
    priceChangeM5: entry.priceChangeM5,
    priceChangeH1: entry.priceChangeH1,
    priceChangeH24: entry.priceChangeH24,
    change: entry.change,
    direction: entry.direction,
    volumeM5: entry.volumeM5,
    volumeH1: entry.volumeH1,
    volumeH24: entry.volumeH24,
    liquidityUsd: entry.liquidityUsd,
    marketCap: entry.marketCap,
    buysM5: entry.buysM5,
    sellsM5: entry.sellsM5,
    buysH1: entry.buysH1,
    sellsH1: entry.sellsH1,
    buysH24: entry.buysH24,
    sellsH24: entry.sellsH24,
    pairAgeMinutes: entry.pairAgeMinutes,
    dataSource: "dexscreener",
    dataUpdatedAt: new Date().toISOString(),
    score,
    confidence,
    status,
  };
}

async function refreshTokenEntry(entry: BattleTokenEntry): Promise<BattleTokenEntry> {
  if (!entry.chainId || !entry.tokenAddress) {
    throw new Error(`Cannot refresh ${entry.displaySymbol}: missing Dexscreener token reference`);
  }

  const rawPairs = await fetchDexScreenerTokenPairs({
    chainId: entry.chainId,
    tokenAddress: entry.tokenAddress,
  });
  const pairs = rawPairs
    .map(normalizePair)
    .filter((pair) => pair.chainId && pair.pairAddress);
  const pair = choosePrimaryPair(pairs);

  if (!pair) {
    throw new Error(`Cannot refresh ${entry.displaySymbol}: no live Dexscreener pair found`);
  }

  const priceChangeH24 = pair.priceChange.h24;
  const direction =
    priceChangeH24 > 0 ? ("up" as const) : priceChangeH24 < 0 ? ("down" as const) : ("flat" as const);
  const actualSymbol = pair.baseToken.symbol || entry.actualSymbol;
  const displaySymbol = actualSymbol ? `$${normalizeSymbol({ ...entry, actualSymbol })}` : entry.displaySymbol;

  return {
    ...entry,
    id: `${String(pair.chainId || entry.chainId).toLowerCase()}:${String(pair.baseToken.address || entry.tokenAddress).toLowerCase()}`,
    logoUrl: pair.imageUrl || entry.logoUrl,
    displaySymbol,
    actualSymbol,
    tokenName: pair.baseToken.name || entry.tokenName,
    chainId: pair.chainId || entry.chainId,
    chainLabel: entry.chainLabel,
    tokenAddress: pair.baseToken.address || entry.tokenAddress,
    pairAddress: pair.pairAddress || entry.pairAddress,
    pairUrl: pair.url || entry.pairUrl,
    dexId: pair.dexId || entry.dexId,
    priceUsd: pair.priceUsd,
    priceDisplay: formatPrice(pair.priceUsd),
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
  };
}

async function refreshListedCandidate(candidate: BantahBroBattleCandidate): Promise<BantahBroBattleCandidate> {
  const [left, right] = await Promise.all(candidate.sides.map((side) => refreshTokenEntry(side)));
  return {
    ...candidate,
    sides: [left, right] as [
      BantahBroBattleDiscoveryTokenProfile,
      BantahBroBattleDiscoveryTokenProfile,
    ],
  };
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

function eventTime(now: Date, offsetSeconds: number) {
  return new Date(now.getTime() - offsetSeconds * 1000).toISOString();
}

function buildEvents(params: {
  battleId: string;
  now: Date;
  left: BantahBroAgentBattleSide;
  right: BantahBroAgentBattleSide;
}): BantahBroAgentBattleEvent[] {
  const { battleId, now, left, right } = params;
  const leader = left.confidence >= right.confidence ? left : right;
  const trailer = leader.id === left.id ? right : left;

  const events: BantahBroAgentBattleEvent[] = [
    {
      id: `${battleId}-lead`,
      time: eventTime(now, 12),
      type: "momentum",
      severity: leader.confidence >= 60 ? "hot" : "info",
      sideId: leader.id,
      agentName: leader.agentName,
      message: `${leader.label} is leading at ${leader.confidence}% confidence on live market strength.`,
      metricLabel: "24H move",
      metricValue: leader.change,
    },
    {
      id: `${battleId}-volume-a`,
      time: eventTime(now, 32),
      type: "volume",
      severity: safeNumber(left.volumeH24) >= safeNumber(right.volumeH24) ? "hot" : "info",
      sideId: left.id,
      agentName: left.agentName,
      message: `${left.label} brings ${formatUsd(left.volumeH24)} in 24H volume into the arena.`,
      metricLabel: "24H volume",
      metricValue: formatUsd(left.volumeH24),
    },
    {
      id: `${battleId}-volume-b`,
      time: eventTime(now, 49),
      type: "volume",
      severity: safeNumber(right.volumeH24) > safeNumber(left.volumeH24) ? "hot" : "info",
      sideId: right.id,
      agentName: right.agentName,
      message: `${right.label} is fighting back with ${formatUsd(right.volumeH24)} in 24H volume.`,
      metricLabel: "24H volume",
      metricValue: formatUsd(right.volumeH24),
    },
    {
      id: `${battleId}-pressure`,
      time: eventTime(now, 68),
      type: "system",
      severity: trailer.direction === "down" ? "danger" : "info",
      sideId: trailer.id,
      agentName: "BantahBro Engine",
      message:
        trailer.direction === "down"
          ? `${trailer.label} is taking pressure with a ${trailer.change} 24H move.`
          : `${trailer.label} is still in range. One live volume burst can flip this battle.`,
      metricLabel: "confidence gap",
      metricValue: `${Math.abs(left.confidence - right.confidence)}%`,
    },
    {
      id: `${battleId}-trades-a`,
      time: eventTime(now, 86),
      type: "momentum",
      severity: left.buysH24 >= left.sellsH24 ? "hot" : "info",
      sideId: left.id,
      agentName: left.agentName,
      message: `${left.label} has ${formatInteger(left.buysH24)} buys vs ${formatInteger(left.sellsH24)} sells in 24H.`,
      metricLabel: "24H buys",
      metricValue: formatInteger(left.buysH24),
    },
    {
      id: `${battleId}-liquidity-b`,
      time: eventTime(now, 104),
      type: "liquidity",
      severity: safeNumber(right.liquidityUsd) >= safeNumber(left.liquidityUsd) ? "hot" : "info",
      sideId: right.id,
      agentName: right.agentName,
      message: `${right.label} is holding ${formatUsd(right.liquidityUsd)} liquidity for the next push.`,
      metricLabel: "liquidity",
      metricValue: formatUsd(right.liquidityUsd),
    },
  ];

  return events;
}

function winnerLogicForCandidate(candidate?: BantahBroBattleCandidate) {
  if (!candidate) {
    return "Hybrid live score: live 5M/1H/24H price movement, volume, buy pressure, and liquidity strength.";
  }

  if (candidate.winnerRule === "highest_price_gain") {
    return "Highest percentage price gain from live market snapshots wins.";
  }
  if (candidate.winnerRule === "buy_pressure") {
    return "Strongest live buy pressure and buy/sell dominance wins.";
  }
  if (candidate.winnerRule === "volume_dominance") {
    return "Highest live volume dominance wins.";
  }
  return "Hybrid live score: live 5M/1H/24H price movement, buy pressure, volume, liquidity, and rivalry strength.";
}

function battleSnapshotKeyFromCandidate(candidate?: BantahBroBattleCandidate | null) {
  return normalizeBattleIdentity(candidate?.id || "");
}

function isBattleSnapshotLive(battle: BantahBroAgentBattle, now: Date) {
  const endsAtMs = new Date(battle.endsAt).getTime();
  return Number.isFinite(endsAtMs) && endsAtMs > now.getTime();
}

function pruneExpiredBattleSnapshots(now: Date) {
  const usedTokenIdentities = new Set<string>();
  lockedRoundBattleSnapshots = lockedRoundBattleSnapshots
    .map((battle) => syncBattleSnapshotToNow(battle, now))
    .filter((battle) => isBattleSnapshotLive(battle, now))
    .filter((battle) => {
      const tokenIdentities = battleTokenIdentities(battle);
      if (hasTokenIdentityOverlap(tokenIdentities, usedTokenIdentities)) {
        return false;
      }
      markTokenIdentitiesUsed(tokenIdentities, usedTokenIdentities);
      return true;
    });
  lockedRoundBattleIds = lockedRoundBattleSnapshots.map((battle) => battle.id);
  const activeIds = new Set(lockedRoundBattleIds);
  lockedRoundCandidateSnapshots = lockedRoundCandidateSnapshots.filter((candidate) =>
    activeIds.has(battleSnapshotKeyFromCandidate(candidate)),
  );
}

function lockCandidatesForRound(
  candidates: BantahBroBattleCandidate[],
  requestedBattles: number,
  now: Date,
) {
  pruneExpiredBattleSnapshots(now);
  const byId = new Map(
    candidates
      .map((candidate) => {
        const key = battleSnapshotKeyFromCandidate(candidate);
        return key ? ([key, candidate] as const) : null;
      })
      .filter((entry): entry is readonly [string, BantahBroBattleCandidate] => Boolean(entry)),
  );

  const activeBattleIds = lockedRoundBattleSnapshots.map((battle) => battle.id);
  const activeCandidates = activeBattleIds
    .map((id) => byId.get(id) || lockedRoundCandidateSnapshots.find((candidate) => battleSnapshotKeyFromCandidate(candidate) === id))
    .filter((candidate): candidate is BantahBroBattleCandidate => Boolean(candidate));
  const usedTokenIdentities = new Set<string>();
  const uniqueActiveCandidates: BantahBroBattleCandidate[] = [];
  for (const candidate of activeCandidates) {
    const tokenIdentities = candidateTokenIdentities(candidate);
    if (hasTokenIdentityOverlap(tokenIdentities, usedTokenIdentities)) continue;
    uniqueActiveCandidates.push(candidate);
    markTokenIdentitiesUsed(tokenIdentities, usedTokenIdentities);
  }

  const activeIdSet = new Set(activeBattleIds);
  const queuedCandidates: BantahBroBattleCandidate[] = [];
  for (const candidate of candidates) {
    const key = battleSnapshotKeyFromCandidate(candidate);
    if (!key || activeIdSet.has(key)) continue;
    const tokenIdentities = candidateTokenIdentities(candidate);
    if (hasTokenIdentityOverlap(tokenIdentities, usedTokenIdentities)) continue;
    queuedCandidates.push(candidate);
    markTokenIdentitiesUsed(tokenIdentities, usedTokenIdentities);
    if (uniqueActiveCandidates.length + queuedCandidates.length >= requestedBattles) break;
  }

  lockedRoundBattleIds = activeBattleIds;
  lockedRoundCandidateSnapshots = [...uniqueActiveCandidates, ...queuedCandidates].slice(0, requestedBattles);
  return lockedRoundCandidateSnapshots;
}

function syncBattleSnapshotToNow(
  battle: BantahBroAgentBattle,
  now: Date,
): BantahBroAgentBattle {
  const endsAtMs = new Date(battle.endsAt).getTime();
  const timeRemainingSeconds = Number.isFinite(endsAtMs)
    ? Math.max(0, Math.ceil((endsAtMs - now.getTime()) / 1000))
    : Math.max(0, Math.round(battle.timeRemainingSeconds || 0));

  return {
    ...battle,
    status: timeRemainingSeconds > 0 ? "live" : "expired",
    timeRemainingSeconds,
  };
}

function sideLeaderboardScore(side: BantahBroAgentBattleSide) {
  const score = safeNumber(side.score);
  const confidence = safeNumber(side.confidence);
  const volume = Math.log10(safeNumber(side.volumeH24) + safeNumber(side.volumeH1) + 1) * 4;
  const liquidity = Math.log10(safeNumber(side.liquidityUsd) + 1) * 2.5;
  const momentum = safeNumber(side.priceChangeM5) * 0.65 + safeNumber(side.priceChangeH24) * 0.25;
  return score * 0.58 + confidence * 0.34 + volume + liquidity + momentum;
}

function applyBattleSideLeaderboardRanks(feed: BantahBroAgentBattlesFeed): BantahBroAgentBattlesFeed {
  const rankedSides = new Map<string, { side: BantahBroAgentBattleSide; score: number }>();

  for (const battle of feed.battles) {
    for (const side of battle.sides) {
      const current = rankedSides.get(side.id);
      const score = sideLeaderboardScore(side);
      if (!current || score > current.score) {
        rankedSides.set(side.id, { side, score });
      }
    }
  }

  const rankBySideId = new Map<string, number>();
  Array.from(rankedSides.values())
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      return a.side.agentName.localeCompare(b.side.agentName);
    })
    .forEach(({ side }, index) => {
      rankBySideId.set(side.id, index + 1);
    });

  return {
    ...feed,
    battles: feed.battles.map((battle) => ({
      ...battle,
      sides: battle.sides.map((side) => {
        const leaderboardRank = rankBySideId.get(side.id) || Math.max(1, Math.round(101 - safeNumber(side.score)));
        return {
          ...side,
          leaderboardRank,
          rank: leaderboardRank,
        };
      }) as [BantahBroAgentBattleSide, BantahBroAgentBattleSide],
    })),
  };
}

function buildLockedRoundFeed(
  now: Date,
  requestedBattles: number,
): BantahBroAgentBattlesFeed {
  return applyBattleSideLeaderboardRanks({
    battles: lockedRoundBattleSnapshots
      .slice(0, requestedBattles)
      .map((battle) => syncBattleSnapshotToNow(battle, now)),
    updatedAt: now.toISOString(),
    sources: {
      marketData: "fighter-profiles",
      note:
        "Arena battles are paired from BOTA fighter profiles first, then real public ENS names fetched from the ENS subgraph.",
    },
  });
}

function feedHasBattles(feed?: BantahBroAgentBattlesFeed | null): feed is BantahBroAgentBattlesFeed {
  return Boolean(feed?.battles?.length);
}

function syncFeedToNow(
  feed: BantahBroAgentBattlesFeed,
  now: Date,
): BantahBroAgentBattlesFeed {
  return applyBattleSideLeaderboardRanks({
    ...feed,
    battles: feed.battles.map((battle) => syncBattleSnapshotToNow(battle, now)),
    updatedAt: now.toISOString(),
  });
}

function mergeFeedsPreservingLiveBattles(
  primaryFeed: BantahBroAgentBattlesFeed,
  fallbackFeed: BantahBroAgentBattlesFeed | null,
  requestedBattles: number,
  now: Date,
): BantahBroAgentBattlesFeed {
  if (!fallbackFeed?.battles?.length) {
    return applyBattleSideLeaderboardRanks({
      ...primaryFeed,
      battles: primaryFeed.battles
        .map((battle) => syncBattleSnapshotToNow(battle, now))
        .filter((battle) => isBattleSnapshotLive(battle, now))
        .slice(0, requestedBattles),
      updatedAt: now.toISOString(),
    });
  }

  const latestById = new Map<string, BantahBroAgentBattle>();
  for (const battle of fallbackFeed.battles) {
    latestById.set(battle.id, battle);
  }
  for (const battle of primaryFeed.battles) {
    latestById.set(battle.id, battle);
  }

  const orderedIds: string[] = [];
  const seenIds = new Set<string>();
  const queueBattleId = (battleId: string) => {
    if (!battleId || seenIds.has(battleId)) return;
    seenIds.add(battleId);
    orderedIds.push(battleId);
  };

  for (const battle of fallbackFeed.battles) {
    queueBattleId(battle.id);
  }
  for (const battle of primaryFeed.battles) {
    queueBattleId(battle.id);
  }

  const battles = orderedIds
    .map((battleId) => latestById.get(battleId))
    .filter((battle): battle is BantahBroAgentBattle => Boolean(battle))
    .map((battle) => syncBattleSnapshotToNow(battle, now))
    .filter((battle) => isBattleSnapshotLive(battle, now))
    .slice(0, requestedBattles);

  return applyBattleSideLeaderboardRanks({
    ...primaryFeed,
    battles,
    updatedAt: now.toISOString(),
  });
}

function buildBattle(
  leftEntry: BattleTokenEntry,
  rightEntry: BattleTokenEntry,
  index: number,
  now: Date,
  candidate?: BantahBroBattleCandidate,
): BantahBroAgentBattle {
  const leftScore = scoreEntry(leftEntry);
  const rightScore = scoreEntry(rightEntry);
  const totalScore = Math.max(1, leftScore + rightScore);
  const leftConfidence = clamp(Math.round((leftScore / totalScore) * 100), 5, 95);
  const rightConfidence = 100 - leftConfidence;
  const left = buildSide(leftEntry, leftConfidence, leftScore);
  const right = buildSide(rightEntry, rightConfidence, rightScore);
  const battleWindowMs = getBattleWindowMs();
  const startsAt = new Date(now.getTime());
  const endsAt = new Date(startsAt.getTime() + battleWindowMs);
  const timeRemainingSeconds = Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000));
  const leadingSideId = left.confidence >= right.confidence ? left.id : right.id;
  const volumeTotal = safeNumber(left.volumeH24) + safeNumber(right.volumeH24);
  const liquidityTotal = safeNumber(left.liquidityUsd) + safeNumber(right.liquidityUsd);
  const spectators = Math.round(clamp(Math.log10(volumeTotal + liquidityTotal + 1) * 180, 120, 2600));
  const battleId =
    battleSnapshotKeyFromCandidate(candidate) ||
    normalizeBattleIdentity(`agent-battle-${index + 1}-${left.id}-${right.id}`);

  return {
    id: battleId,
    title: `${left.label} vs ${right.label}`,
    battleType: "agent-battle",
    status: timeRemainingSeconds > 0 ? "live" : "expired",
    winnerLogic: winnerLogicForCandidate(candidate),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    timeRemainingSeconds,
    spectators,
    sides: [left, right],
    leadingSideId,
    confidenceSpread: Math.abs(left.confidence - right.confidence),
    events: buildEvents({ battleId, now, left, right }),
    updatedAt: now.toISOString(),
  };
}

function normalizeProfileRecord(row: typeof botaFighterProfiles.$inferSelect): BotaFighterProfile {
  return {
    agentId: row.agentId,
    displayName: row.displayName,
    origin: row.origin as BotaFighterProfile["origin"],
    originId: row.originId,
    agentClass: row.agentClass as BotaFighterProfile["agentClass"],
    archetype: row.archetype as BotaFighterProfile["archetype"],
    league: row.league,
    rank: row.rank,
    avatarUrl: normalizeStoredAvatarUrl(row.avatarUrl, `${row.origin}:${row.agentId}:${row.displayName}`),
    badgeLabel: row.badgeLabel,
    ensName: row.ensName,
    walletAddress: row.walletAddress,
    externalUrl: row.externalUrl,
    tokenSymbol: row.tokenSymbol,
    tokenName: row.tokenName,
    chainId: row.chainId,
    wins: row.wins,
    losses: row.losses,
    currentStreak: row.currentStreak,
    fameScore: safeNumber(Number(row.fameScore)),
    watchers: row.watchers,
    challengeVolume: row.challengeVolume,
    bantCreditsEarned: 0,
    liveSpectators: 0,
    titles: Array.isArray(row.titles) ? row.titles : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    lastBattleId: row.lastBattleId,
    metadata: row.metadata || {},
    importedAt: row.importedAt ? row.importedAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

function isImportedBattleProfile(profile: BotaFighterProfile) {
  if (!profile?.agentId || !profile.displayName) return false;
  if (profile.origin === "dexscreener") return false;
  if (profile.origin === "bota" && String(profile.agentId || "").startsWith("external:")) return false;
  const sourceHint = String(
    profile.metadata?.sourceHint ||
      profile.metadata?.importSource ||
      profile.metadata?.importedFrom ||
      "",
  ).toLowerCase();
  if (sourceHint.includes("dexscreener")) return false;
  return true;
}

function hasUserImportOwner(profile: BotaFighterProfile) {
  const metadata =
    profile.metadata && typeof profile.metadata === "object" && !Array.isArray(profile.metadata)
      ? profile.metadata
      : {};
  return Boolean(
    metadata.importedByUserId ||
      metadata.ownerUserId ||
      metadata.importedByWallet ||
      metadata.selectedAssetId,
  );
}

function isEligibleForArenaRound(profile: BotaFighterProfile, roundStartsAtMs: number) {
  if (!hasUserImportOwner(profile)) return true;
  const importedAtMs = new Date(String(profile.importedAt || profile.createdAt || "")).getTime();
  if (!Number.isFinite(importedAtMs)) return true;
  return importedAtMs <= roundStartsAtMs;
}

async function listImportedBattleProfiles(limit: number) {
  const requested = Math.max(2, Math.min(Math.round(limit || 80), 160));
  const now = Date.now();
  if (
    cachedImportedBattleProfiles.length >= requested &&
    now - cachedImportedBattleProfilesAt < IMPORTED_BATTLE_PROFILE_CACHE_TTL_MS
  ) {
    return cachedImportedBattleProfiles.slice(0, requested);
  }
  try {
    const [realRows, randomRows] = await Promise.all([
      db
        .select()
        .from(botaFighterProfiles)
        .where(isNotNull(botaFighterProfiles.walletAddress))
        .orderBy(desc(botaFighterProfiles.createdAt))
        .limit(requested),
      Promise.race([
        db
          .select()
          .from(botaFighterProfiles)
          .orderBy(sql`RANDOM()`)
          .limit(requested),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timed out after ${IMPORTED_BATTLE_PROFILE_TIMEOUT_MS}ms`)),
            IMPORTED_BATTLE_PROFILE_TIMEOUT_MS,
          ),
        ),
      ]),
    ]);
    const rows = [...realRows, ...(randomRows as any[])];
    const profiles = rows.map(normalizeProfileRecord).filter(isImportedBattleProfile);
    if (profiles.length > 0) {
      cachedImportedBattleProfiles = profiles;
      cachedImportedBattleProfilesAt = Date.now();
    }
    return profiles;
  } catch (error) {
    if (cachedImportedBattleProfiles.length > 0) {
      return cachedImportedBattleProfiles.slice(0, requested);
    }
    console.warn("[BOTA] Imported fighter profiles unavailable for arena feed:", error);
    return [];
  }
}

function uniqueBattleProfiles(profiles: BotaFighterProfile[]) {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    const key = String(profile.ensName || profile.originId || profile.agentId || profile.displayName)
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function profileDisplayName(profile: BotaFighterProfile) {
  return profile.origin === "ens" && profile.ensName
    ? profile.ensName
    : profile.displayName || profile.ensName || profile.tokenName || "BOTA Fighter";
}

function profileScore(profile: BotaFighterProfile) {
  const fame = safeNumber(profile.fameScore);
  const wins = safeNumber(profile.wins);
  const losses = safeNumber(profile.losses);
  const challenges = Math.max(0, safeNumber(profile.challengeVolume));
  const watchers = Math.log10(Math.max(1, safeNumber(profile.watchers))) * 8;
  const rankBonus = profile.rank ? clamp(28 - Math.log2(profile.rank + 1) * 4, 0, 28) : 10;
  const winRate = wins + losses > 0 ? (wins / Math.max(1, wins + losses)) * 28 : 12;
  return clamp(Math.round(fame * 0.55 + watchers + rankBonus + winRate + Math.log10(challenges + 1) * 7), 1, 130);
}

function seededDelta(seed: string, min: number, max: number, precision = 1) {
  const raw = min + (stableHash(seed) / 0xffffffff) * (max - min);
  const factor = 10 ** precision;
  return Math.round(raw * factor) / factor;
}

function stableHash(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function profileMetric(profile: BotaFighterProfile, key: string, min: number, max: number) {
  return Math.round(min + (stableHash(`${profile.agentId}:${key}`) / 0xffffffff) * (max - min));
}

function dataSourceForProfile(profile: BotaFighterProfile): BantahBroAgentBattleSide["dataSource"] {
  const sourceHint = String(profile.metadata?.importSource || profile.metadata?.sourceHint || "").toLowerCase();
  return profile.origin === "ens" && sourceHint.includes("subgraph")
    ? "ens-subgraph"
    : "fighter-profile";
}

function buildProfileSide(
  profile: BotaFighterProfile,
  confidence: number,
  score: number,
): BantahBroAgentBattleSide {
  const name = profileDisplayName(profile);
  const seed = `${profile.agentId}:${name}`;
  const dataSource = dataSourceForProfile(profile);

  return {
    id: profile.agentId,
    label: name,
    agentName: name,
    tokenSymbol: profile.origin === "ens" ? null : profile.tokenSymbol,
    tokenName: profile.ensName || profile.tokenName || name,
    emoji: profile.origin === "ens" ? "ENS" : "BOTA",
    logoUrl: normalizeStoredAvatarUrl(profile.avatarUrl, seed),
    chainId: profile.chainId || (profile.origin === "ens" ? "ethereum" : null),
    chainLabel: profile.origin === "ens" ? "ENS" : profile.badgeLabel || profile.league || "BOTA",
    tokenAddress: profile.walletAddress,
    pairAddress: null,
    pairUrl: profile.externalUrl || (profile.ensName ? `https://app.ens.domains/${profile.ensName}` : null),
    dexId: null,
    priceUsd: null,
    priceDisplay: profile.rank ? `#${profile.rank}` : "profile",
    priceChangeM5: 0,
    priceChangeH1: 0,
    priceChangeH24: 0,
    change: formatPercent(0),
    direction: "flat",
    volumeM5: 0,
    volumeH1: 0,
    volumeH24: 0,
    liquidityUsd: null,
    marketCap: null,
    buysM5: 0,
    sellsM5: 0,
    buysH1: 0,
    sellsH1: 0,
    buysH24: 0,
    sellsH24: 0,
    pairAgeMinutes: null,
    dataSource,
    dataUpdatedAt: new Date().toISOString(),
    score,
    confidence,
    leaderboardRank: profile.rank ?? undefined,
    rank: profile.rank ?? undefined,
    status:
      confidence >= 58
        ? "attacking"
        : confidence <= 42
          ? "staggered"
          : profile.currentStreak > 0
            ? "defending"
            : "holding",
  };
}

function buildProfileEvents(params: {
  battleId: string;
  now: Date;
  left: BantahBroAgentBattleSide;
  right: BantahBroAgentBattleSide;
}): BantahBroAgentBattleEvent[] {
  const { battleId, now, left, right } = params;
  const leader = left.confidence >= right.confidence ? left : right;
  const trailer = leader.id === left.id ? right : left;

  return [
    {
      id: `${battleId}-lead`,
      time: eventTime(now, 10),
      type: "momentum",
      severity: leader.confidence >= 60 ? "hot" : "info",
      sideId: leader.id,
      agentName: leader.agentName,
      message: `${leader.agentName} leads ${leader.confidence}-${trailer.confidence} on current Arena form.`,
      metricLabel: "live form",
      metricValue: `${leader.confidence}%`,
    },
    {
      id: `${battleId}-rank`,
      time: eventTime(now, 28),
      type: "system",
      severity: "info",
      sideId: leader.id,
      agentName: "BOTA Engine",
      message: `${leader.agentName} is defending rank ${leader.rank ? `#${leader.rank}` : "position"} in this live matchup.`,
      metricLabel: "rank",
      metricValue: leader.rank ? `#${leader.rank}` : null,
    },
    {
      id: `${battleId}-score`,
      time: eventTime(now, 45),
      type: "system",
      severity: "hot",
      sideId: null,
      agentName: "Arena live",
      message: `${formatInteger(safeNumber(left.score) + safeNumber(right.score))} combined Arena score across both fighters.`,
      metricLabel: "arena score",
      metricValue: formatInteger(safeNumber(left.score) + safeNumber(right.score)),
    },
    {
      id: `${battleId}-gap`,
      time: eventTime(now, 63),
      type: "system",
      severity: Math.abs(left.confidence - right.confidence) <= 12 ? "info" : "hot",
      sideId: trailer.id,
      agentName: "BOTA Engine",
      message:
        Math.abs(left.confidence - right.confidence) <= 12
          ? `${trailer.agentName} is close enough to flip this fight.`
          : `${leader.agentName} has opened a ${Math.abs(left.confidence - right.confidence)}% pressure gap.`,
      metricLabel: "gap",
      metricValue: `${Math.abs(left.confidence - right.confidence)}%`,
    },
  ];
}

function pairProfilesForRound(
  profiles: BotaFighterProfile[],
  requestedBattles: number,
  now: Date,
) {
  const battleWindowMs = getBattleWindowMs();
  const roundBucket = Math.floor(now.getTime() / battleWindowMs);
  const roundStartsAtMs = roundBucket * battleWindowMs;
  const uniqueProfiles = uniqueBattleProfiles(profiles).filter((profile) =>
    isEligibleForArenaRound(profile, roundStartsAtMs),
  );
  if (uniqueProfiles.length < 2) return [];

  const sorted = [...uniqueProfiles].sort((left, right) => {
    const leftSeed = stableHash(`${roundBucket}:${left.agentId}`);
    const rightSeed = stableHash(`${roundBucket}:${right.agentId}`);
    return leftSeed - rightSeed;
  });
  const pairs: Array<[BotaFighterProfile, BotaFighterProfile]> = [];
  const used = new Set<string>();

  for (const left of sorted) {
    if (used.has(left.agentId)) continue;
    const right = sorted.find((candidate) => candidate.agentId !== left.agentId && !used.has(candidate.agentId));
    if (!right) break;
    used.add(left.agentId);
    used.add(right.agentId);
    pairs.push([left, right]);
    if (pairs.length >= requestedBattles) break;
  }
  return pairs;
}

function buildFighterProfileBattle(
  leftProfile: BotaFighterProfile,
  rightProfile: BotaFighterProfile,
  index: number,
  now: Date,
): BantahBroAgentBattle {
  const battleWindowMs = getBattleWindowMs();
  const roundBucket = Math.floor(now.getTime() / battleWindowMs);
  const startsAt = new Date(roundBucket * battleWindowMs);
  const endsAt = new Date(startsAt.getTime() + battleWindowMs);
  const leftScore = profileScore(leftProfile);
  const rightScore = profileScore(rightProfile);
  const totalScore = Math.max(1, leftScore + rightScore);
  const leftConfidence = clamp(Math.round((leftScore / totalScore) * 100), 5, 95);
  const rightConfidence = 100 - leftConfidence;
  const left = buildProfileSide(leftProfile, leftConfidence, leftScore);
  const right = buildProfileSide(rightProfile, rightConfidence, rightScore);
  const battleId = normalizeBattleIdentity(`fighter:${roundBucket}:${left.id}:vs:${right.id}`);
  const leadingSideId = left.confidence >= right.confidence ? left.id : right.id;

  return {
    id: battleId,
    title: `${left.agentName} vs ${right.agentName}`,
    battleType: "agent-battle",
    status: endsAt.getTime() > now.getTime() ? "live" : "expired",
    winnerLogic: "BOTA Arena Engine: agent profile rank, reputation, battle record, watch activity, and deterministic round RNG decide the live simulation.",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    timeRemainingSeconds: Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000)),
    spectators: 0,
    spectatorBantCredits: 0,
    rewardClaimBantCredits: 0,
    bantCreditsEarned: 0,
    sides: [left, right],
    leadingSideId,
    confidenceSpread: Math.abs(left.confidence - right.confidence),
    events: buildProfileEvents({ battleId, now, left, right }),
    updatedAt: now.toISOString(),
  };
}


function buildChallengeBattle(
  challenge: BotaAgentChallenge,
  now: Date,
  loadoutMap: Map<string, any[]>
): BantahBroAgentBattle {
  const battleWindowMs = getBattleWindowMs();
  const startsAtMs = challenge.scheduledAt ? new Date(challenge.scheduledAt).getTime() : now.getTime();
  const startsAt = new Date(startsAtMs);
  const endsAt = new Date(startsAt.getTime() + battleWindowMs);
  
  const leftId = challenge.challengerAgent.id;
  const rightId = challenge.opponentAgent.id;
  const leftLoadouts = loadoutMap.get(leftId) || [];
  const rightLoadouts = loadoutMap.get(rightId) || [];

  const mapTool = (l: any) => ({
    id: l.tool_id,
    name: l.tool_name || l.name,
    imageUrl: l.tool_metadata?.image_url || l.image_url || l.metadata?.image_url,
    type: l.tool_type || "item",
    rarity: String(l.tool_rarity || "COMMON").toUpperCase(),
  });

  const leftTools = leftLoadouts.map(mapTool);
  const rightTools = rightLoadouts.map(mapTool);

  const calculateToolScore = (tools: any[]) => {
    let score = 100;
    for (const tool of tools) {
      if (tool.rarity === "EPIC") score += 30;
      else if (tool.rarity === "RARE") score += 15;
      else if (tool.rarity === "COMMON") score += 5;
      else score += 10;
    }
    return score;
  };

  const leftScore = calculateToolScore(leftTools);
  const rightScore = calculateToolScore(rightTools);
  const totalScore = Math.max(1, leftScore + rightScore);
  const leftConfidence = Math.max(5, Math.min(95, Math.round((leftScore / totalScore) * 100)));
  const rightConfidence = 100 - leftConfidence;

  const buildSide = (agent: any, confidence: number, tools: any[], score: number): BantahBroAgentBattleSide => ({
    id: agent.id,
    label: agent.name,
    agentName: agent.name,
    tokenSymbol: "BOTA",
    tokenName: agent.name,
    emoji: "⚔️",
    logoUrl: normalizeStoredAvatarUrl(agent.avatarUrl, agent.id),
    chainId: null,
    chainLabel: "BOTA",
    tokenAddress: null,
    pairAddress: null,
    pairUrl: null,
    dexId: null,
    priceUsd: null,
    priceDisplay: "Challenger",
    priceChangeM5: 0,
    priceChangeH1: 0,
    priceChangeH24: 0,
    change: formatPercent(0),
    direction: "flat",
    volumeM5: 0,
    volumeH1: 0,
    volumeH24: 0,
    liquidityUsd: null,
    marketCap: null,
    buysM5: 0,
    sellsM5: 0,
    buysH1: 0,
    sellsH1: 0,
    buysH24: 0,
    sellsH24: 0,
    pairAgeMinutes: null,
    dataSource: "fighter-profile",
    dataUpdatedAt: now.toISOString(),
    score,
    confidence,
    status: "attacking",
    loadoutTools: tools,
  });

  const leftSide = buildSide(challenge.challengerAgent, leftConfidence, leftTools, leftScore);
  const rightSide = buildSide(challenge.opponentAgent, rightConfidence, rightTools, rightScore);

  const battleId = normalizeBattleIdentity(`challenge:${challenge.challengeCode}`);

  return {
    id: battleId,
    title: `${challenge.challengerAgent.name} vs ${challenge.opponentAgent.name}`,
    battleType: "agent-battle",
    status: endsAt.getTime() > now.getTime() ? "live" : "expired",
    winnerLogic: "BOTA Challenge Arena Engine: Live 1v1 PvP combat heavily influenced by equipped Gen1 Tools and Packs (EPIC +30, RARE +15, COMMON +5).",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    timeRemainingSeconds: Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000)),
    spectators: 1500,
    spectatorBantCredits: 0,
    rewardClaimBantCredits: 0,
    bantCreditsEarned: 0,
    isChallenge: true,
    challengeCode: challenge.challengeCode,
    sides: [leftSide, rightSide],
    leadingSideId: leftSide.id,
    confidenceSpread: Math.abs(leftConfidence - rightConfidence),
    events: [
      {
        id: `${battleId}-start`,
        time: eventTime(now, 5),
        type: "system",
        severity: "hot",
        sideId: null,
        agentName: "Main Event",
        message: `Main Event PvP Challenge begins! ${challenge.stakeAmount} ${challenge.stakeCurrency} at stake. Win odds shifted by equipped tools!`,
        metricLabel: "stake",
        metricValue: `${challenge.stakeAmount} ${challenge.stakeCurrency}`,
      }
    ],
    updatedAt: now.toISOString(),
  };
}

async function buildBattleFighterPool(requestedBattles: number) {
  const importedLimit = Math.max(32, requestedBattles * 4);
  const externalLimit = Math.max(24, requestedBattles * 3);
  const ensLimit = Math.max(18, requestedBattles * 2 + 8);
  const [imported, externalCatalog, publicEns] = await Promise.all([
    listImportedBattleProfiles(importedLimit),
    getExternalAgentCatalogProfiles({ limit: externalLimit }).catch((error) => {
      console.warn("[BOTA] External agent catalog unavailable for arena feed:", error);
      return { profiles: [], sources: [], updatedAt: new Date().toISOString() };
    }),
    withTimeout(
      getPublicEnsFighterProfiles(ensLimit),
      ENS_BATTLE_PROFILE_TIMEOUT_MS,
      "ENS public fighter profiles",
    ).catch((error) => {
      console.warn("[BOTA] ENS public fighter profiles unavailable for arena feed:", error);
      return [];
    }),
  ]);
  return uniqueBattleProfiles([...externalCatalog.profiles, ...imported, ...publicEns]);
}

async function buildFeed(limit: number): Promise<BantahBroAgentBattlesFeed> {
  const requestedBattles = clamp(Math.round(limit || 20), 1, 20);
  const now = new Date();
  pruneExpiredBattleSnapshots(now);
  lockedRoundBattleSnapshots = lockedRoundBattleSnapshots.filter((battle) =>
    battle.isChallenge || battle.sides.some((side) => side.dataSource === "fighter-profile" || side.dataSource === "ens-subgraph"),
  );
  
  if (lockedRoundBattleSnapshots.length >= requestedBattles) {
    return buildLockedRoundFeed(now, requestedBattles);
  }

  // 1. Fetch pending User Challenges
  const pendingChallengesResponse = await listBotaAgentChallenges({ limit: 5, status: "all" });
  const activeChallenges = pendingChallengesResponse.challenges.filter(c => c.status !== "resolved" && c.status !== "cancelled" && c.status !== "expired");

  const loadoutMap = new Map<string, any[]>();
  if (activeChallenges.length > 0) {
    const agentIds = activeChallenges.flatMap(c => [c.challengerAgent.id, c.opponentAgent.id]);
    const map = await getFighterToolLoadoutMap(agentIds);
    map.forEach((value, key) => loadoutMap.set(key, value));
  }

  const challengeBattles = activeChallenges.map(challenge => buildChallengeBattle(challenge, now, loadoutMap));

  const fighterPool = await buildBattleFighterPool(requestedBattles);
  const pairs = pairProfilesForRound(fighterPool, requestedBattles, now);
  const autoBattles = pairs.map(([left, right], index) =>
    buildFighterProfileBattle(left, right, index, now),
  );
  
  const battles = [...challengeBattles, ...autoBattles];
  lockedRoundBattleSnapshots = battles;
  lockedRoundBattleIds = battles.map((battle) => battle.id);
  lockedRoundCandidateSnapshots = [];

  return buildLockedRoundFeed(now, requestedBattles);
}

export async function getLiveBantahBroAgentBattles(limit = 3, options: LiveAgentBattlesOptions = {}) {
  const now = Date.now();
  const requestedLimit = clamp(Math.round(limit || 20), 1, 20);
  const hydrateLiveStats = options.hydrateLiveStats !== false;
  const trimFeed = (feed: BantahBroAgentBattlesFeed): BantahBroAgentBattlesFeed => ({
    ...feed,
    battles: feed.battles.slice(0, requestedLimit),
  });
  const syncTrimmedFeed = (feed: BantahBroAgentBattlesFeed) =>
    syncFeedToNow(trimFeed(feed), new Date());
  const maybeHydrateLiveStats = (feed: BantahBroAgentBattlesFeed) =>
    hydrateLiveStats ? hydrateAgentBattleFeedLiveStats(feed) : Promise.resolve(feed);
  const refreshFeed = (limitToRefresh: number) => {
    inflightLimit = limitToRefresh;
    const currentPromise = buildFeed(limitToRefresh)
      .then((feed) => {
        const fallbackNow = new Date();
        const mergedWithCache = mergeFeedsPreservingLiveBattles(
          feed,
          cachedFeed,
          limitToRefresh,
          fallbackNow,
        );
        const mergedFeed = mergeFeedsPreservingLiveBattles(
          mergedWithCache,
          lastNonEmptyFeed,
          limitToRefresh,
          fallbackNow,
        );
        const resolvedFeed = feedHasBattles(mergedFeed)
          ? mergedFeed
          : feedHasBattles(cachedFeed)
            ? syncFeedToNow(cachedFeed, fallbackNow)
            : feedHasBattles(lastNonEmptyFeed)
              ? syncFeedToNow(lastNonEmptyFeed, fallbackNow)
              : mergedFeed;
        cachedFeed = resolvedFeed;
        cachedAt = Date.now();
        cachedLimit = limitToRefresh;
        if (feedHasBattles(resolvedFeed)) {
          lastNonEmptyFeed = resolvedFeed;
        }
        return resolvedFeed;
      })
      .catch((error) => {
        if (cachedFeed) return cachedFeed;
        throw error;
      })
      .finally(() => {
        if (inflightFeedPromise === currentPromise) {
          inflightFeedPromise = null;
          inflightLimit = 0;
        }
      });
    inflightFeedPromise = currentPromise;
    return currentPromise;
  };

  if (cachedFeed && cachedLimit >= requestedLimit && now - cachedAt < AGENT_BATTLE_CACHE_TTL_MS) {
    return maybeHydrateLiveStats(syncTrimmedFeed(cachedFeed));
  }

  if (cachedFeed && cachedLimit >= requestedLimit) {
    if (!inflightFeedPromise || inflightLimit < requestedLimit) {
      void refreshFeed(requestedLimit);
    }
    return maybeHydrateLiveStats(syncTrimmedFeed(cachedFeed));
  }

  if (!inflightFeedPromise || inflightLimit < requestedLimit) {
    refreshFeed(requestedLimit);
  }

  const pendingFeedPromise = inflightFeedPromise || refreshFeed(requestedLimit);
  return pendingFeedPromise.then(syncTrimmedFeed).then(maybeHydrateLiveStats);
}

export async function getUpcomingBotaArenaQueue(limit = 5) {
  const requestedBattles = clamp(Math.round(limit || 20), 1, 20);
  const now = new Date();
  const battleWindowMs = getBattleWindowMs();
  const nextRoundBucket = Math.floor(now.getTime() / battleWindowMs) + 1;
  const nextStartsAt = new Date(nextRoundBucket * battleWindowMs);
  const fighterPool = await buildBattleFighterPool(requestedBattles);
  const pairs = pairProfilesForRound(fighterPool, requestedBattles, nextStartsAt);
  const battles = pairs.map(([left, right], index) =>
    buildFighterProfileBattle(left, right, index, nextStartsAt),
  );

  return {
    battles,
    queueStartsAt: nextStartsAt.toISOString(),
    queueEndsAt: new Date(nextStartsAt.getTime() + battleWindowMs).toISOString(),
    updatedAt: now.toISOString(),
  };
}
