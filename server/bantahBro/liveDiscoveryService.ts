import { z } from "zod";
import { getBantahBroAutomationStatus } from "./automationService";
import { listBantahBroAlerts } from "./alertFeed";
import { getLiveAgentBattleLeaderboard } from "./agentBattleP2PService";
import { isBantahBroElizaTelegramEnabled } from "./systemAgent";
import { storage } from "../storage";

const ONCHAIN_SOURCE_URL = String(process.env.BANTAHBRO_ONCHAIN_SOURCE_URL || "https://bota.bantah.fun").trim().replace(/\/+$/, "");
const REMOTE_CACHE_TTL_MS = 60_000;

type MarketSource = "onchain" | "telegram" | "twitter" | "agent";
type LeaderboardSource = "onchain" | "bantahbro";
type BantahChainKey = "base" | "arbitrum" | "bsc";

interface BantahChainMeta {
  key: BantahChainKey;
  label: string;
  logoUrl: string;
}

export interface BantahBroLiveMarketEntry {
  id: string;
  challengeId: number | null;
  source: MarketSource;
  sourceLabel: string;
  title: string;
  description: string | null;
  category: string | null;
  status: string;
  createdAt: string;
  dueDate: string | null;
  tokenSymbol: string | null;
  chainId: string | number | null;
  chainKey: BantahChainKey | null;
  chainLabel: string | null;
  chainLogoUrl: string | null;
  escrowLocked: boolean;
  escrowLockedDisplay: "YES" | "NO";
  escrowTxHash: string | null;
  poolAmount: number | null;
  poolDisplay: string;
  yesPercent: number;
  noPercent: number;
  yesDisplay: string;
  noDisplay: string;
  participantCount: number;
  commentCount: number;
  marketUrl: string | null;
  coverImageUrl: string | null;
  creatorName: string | null;
  isAgentMarket: boolean;
}

export interface BantahBroLeaderboardEntry {
  id: string;
  source: LeaderboardSource;
  sourceLabel: string;
  rank: number;
  name: string;
  handle: string | null;
  profileImageUrl: string | null;
  score: number;
  wins: number;
  balance: number;
  balanceDisplay: string;
  points: number;
  coins: number;
  challengesWon: number;
  eventsWon: number;
}

interface FeedSourceStatus {
  available: boolean;
  active: boolean;
  count: number;
  message?: string;
}

export interface BantahBroMarketsFeed {
  entries: BantahBroLiveMarketEntry[];
  updatedAt: string;
  sources: {
    onchain: FeedSourceStatus & { url: string };
    telegram: FeedSourceStatus;
    twitter: FeedSourceStatus;
  };
}

export interface BantahBroLeaderboardFeed {
  entries: BantahBroLeaderboardEntry[];
  updatedAt: string;
  sources: {
    onchain: FeedSourceStatus & { url: string };
    bantahbro: FeedSourceStatus;
  };
}

const remoteChallengesSchema = z.array(
  z.object({
    id: z.coerce.number().int().positive(),
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    status: z.string().min(1),
    createdAt: z.string(),
    dueDate: z.string().nullable().optional(),
    tokenSymbol: z.string().nullable().optional(),
    chainId: z.union([z.coerce.number().int(), z.string()]).nullable().optional(),
    amount: z.union([z.coerce.number(), z.string()]).nullable().optional(),
    settlementRail: z.string().nullable().optional(),
    escrowTxHash: z.string().nullable().optional(),
    challengerSide: z.string().nullable().optional(),
    challengedSide: z.string().nullable().optional(),
    yesStakeTotal: z.coerce.number().nullable().optional(),
    noStakeTotal: z.coerce.number().nullable().optional(),
    participantCount: z.coerce.number().nullable().optional(),
    commentCount: z.coerce.number().nullable().optional(),
    coverImageUrl: z.string().nullable().optional(),
    coverImage: z.string().nullable().optional(),
    cover_image_url: z.string().nullable().optional(),
    image: z.string().nullable().optional(),
    imageUrl: z.string().nullable().optional(),
    thumbnailUrl: z.string().nullable().optional(),
    createdByAgent: z.boolean().nullable().optional(),
    agentInvolved: z.boolean().nullable().optional(),
    creatorType: z.string().nullable().optional(),
    creatorAgentId: z.string().nullable().optional(),
    evidence: z.record(z.string(), z.unknown()).nullable().optional(),
    challengerUser: z
      .object({
        username: z.string().nullable().optional(),
        firstName: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
);

const remoteCache = new Map<string, { expiresAt: number; value: unknown }>();

const BANTAH_CHAIN_META_BY_ID: Record<string, BantahChainMeta> = {
  "8453": {
    key: "base",
    label: "Base",
    logoUrl: "/assets/chain-base.svg",
  },
  "84532": {
    key: "base",
    label: "Base",
    logoUrl: "/assets/chain-base.svg",
  },
  "42161": {
    key: "arbitrum",
    label: "Arbitrum",
    logoUrl: "/assets/chain-arbitrum.svg",
  },
  "421614": {
    key: "arbitrum",
    label: "Arbitrum",
    logoUrl: "/assets/chain-arbitrum.svg",
  },
  "56": {
    key: "bsc",
    label: "BSC",
    logoUrl: "/assets/chain-bsc.svg",
  },
  "97": {
    key: "bsc",
    label: "BSC",
    logoUrl: "/assets/chain-bsc.svg",
  },
};

function parseNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 100 ? 0 : 2,
    notation: value >= 1000 ? "compact" : "standard",
  }).format(value);
}

function formatTokenAmount(value: number | null, symbol?: string | null) {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return symbol ? `0 ${symbol}` : "n/a";
  }
  return `${toCompactNumber(value)}${symbol ? ` ${symbol}` : ""}`;
}

function trimBody(body: string) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^https?:\/\//i.test(line))
    .join(" ");
}

function normalizeChainId(chainId: string | number | null | undefined) {
  return String(chainId || "").trim().toLowerCase();
}

function getBantahChainMeta(chainId: string | number | null | undefined) {
  const normalized = normalizeChainId(chainId);
  if (!normalized) return null;
  if (normalized === "base") return BANTAH_CHAIN_META_BY_ID["8453"];
  if (normalized === "arb" || normalized === "arbitrum") return BANTAH_CHAIN_META_BY_ID["42161"];
  if (normalized === "bsc" || normalized === "bnb") return BANTAH_CHAIN_META_BY_ID["56"];
  return BANTAH_CHAIN_META_BY_ID[normalized] || null;
}

function chainLabel(chainId: string | number | null | undefined) {
  const chainMeta = getBantahChainMeta(chainId);
  if (chainMeta) return chainMeta.label;

  const normalized = normalizeChainId(chainId);
  if (!normalized) return null;
  if (normalized === "sol" || normalized === "solana") return "Solana";
  return String(chainId);
}

function resolveRemoteCoverImageUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  try {
    return new URL(raw, `${ONCHAIN_SOURCE_URL}/`).toString();
  } catch {
    return null;
  }
}

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (raw) return raw;
  }
  return null;
}

function readEvidenceField(evidence: Record<string, unknown> | null | undefined, ...keys: string[]) {
  if (!evidence) return null;
  for (const key of keys) {
    const value = evidence[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickRemoteChallengeCoverImageUrl(challenge: {
  coverImageUrl?: string | null;
  coverImage?: string | null;
  cover_image_url?: string | null;
  image?: string | null;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  evidence?: Record<string, unknown> | null;
}) {
  return resolveRemoteCoverImageUrl(
    pickFirstString(
      challenge.coverImageUrl,
      challenge.coverImage,
      challenge.cover_image_url,
      challenge.image,
      challenge.imageUrl,
      challenge.thumbnailUrl,
      readEvidenceField(
        challenge.evidence,
        "coverImageUrl",
        "coverImage",
        "cover_image_url",
        "image",
        "imageUrl",
        "thumbnailUrl",
      ),
    ),
  );
}

function normalizeLocalCoverImageUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || null;
}

function pickLocalChallengeCoverImageUrl(challenge: unknown) {
  const record =
    challenge && typeof challenge === "object"
      ? (challenge as Record<string, unknown>)
      : {};
  const evidence =
    record.evidence && typeof record.evidence === "object"
      ? (record.evidence as Record<string, unknown>)
      : null;

  return normalizeLocalCoverImageUrl(
    pickFirstString(
      record.coverImageUrl,
      record.coverImage,
      record.cover_image_url,
      record.image,
      record.imageUrl,
      record.thumbnailUrl,
      readEvidenceField(
        evidence,
        "coverImageUrl",
        "coverImage",
        "cover_image_url",
        "image",
        "imageUrl",
        "thumbnailUrl",
      ),
    ),
  );
}

function buildFixedP2PPricing(poolAmount: number, tokenSymbol?: string | null) {
  const sideAmount = poolAmount > 0 ? poolAmount / 2 : 0;
  return {
    yesPercent: 50,
    noPercent: 50,
    yesDisplay: formatTokenAmount(sideAmount, tokenSymbol || null),
    noDisplay: formatTokenAmount(sideAmount, tokenSymbol || null),
  };
}

function normalizePercentages(params: {
  yesPool: number;
  noPool: number;
  confidence?: number | null;
  sentiment?: string | null;
}) {
  const totalPool = params.yesPool + params.noPool;
  if (totalPool > 0) {
    const yesPercent = Math.max(0, Math.min(100, Math.round((params.yesPool / totalPool) * 100)));
    return {
      yesPercent,
      noPercent: 100 - yesPercent,
    };
  }

  if (params.sentiment === "bullish") {
    const yesPercent = Math.max(55, Math.min(95, Math.round((params.confidence || 0.65) * 100)));
    return { yesPercent, noPercent: 100 - yesPercent };
  }

  if (params.sentiment === "bearish") {
    const noPercent = Math.max(55, Math.min(95, Math.round((params.confidence || 0.65) * 100)));
    return { yesPercent: 100 - noPercent, noPercent };
  }

  return { yesPercent: 50, noPercent: 50 };
}

function inferChallengePools(challenge: {
  amount?: unknown;
  challengerSide?: string | null;
  challengedSide?: string | null;
  yesStakeTotal?: number | null;
  noStakeTotal?: number | null;
}) {
  let yesPool = Number(challenge.yesStakeTotal || 0);
  let noPool = Number(challenge.noStakeTotal || 0);
  const amount = parseNumber(challenge.amount);

  if (yesPool <= 0 && noPool <= 0 && amount > 0) {
    const challengerSide = String(challenge.challengerSide || "").trim().toUpperCase();
    const challengedSide = String(challenge.challengedSide || "").trim().toUpperCase();

    if (challengerSide === "YES") yesPool += amount;
    if (challengerSide === "NO") noPool += amount;
    if (challengedSide === "YES") yesPool += amount;
    if (challengedSide === "NO") noPool += amount;

    if (yesPool <= 0 && noPool <= 0) {
      yesPool = amount / 2;
      noPool = amount / 2;
    }
  }

  return { yesPool, noPool, totalPool: yesPool + noPool };
}

function buildMarketChainFields(chainId: string | number | null | undefined) {
  const chainMeta = getBantahChainMeta(chainId);

  return {
    chainId: chainId ?? null,
    chainKey: chainMeta?.key || null,
    chainLabel: chainMeta?.label || chainLabel(chainId),
    chainLogoUrl: chainMeta?.logoUrl || null,
  };
}

function buildRemoteChallengeUrl(challengeId: number) {
  return `${ONCHAIN_SOURCE_URL}/challenges/${challengeId}/activity`;
}

function inferAlertSource(metadata: Record<string, unknown> | undefined): MarketSource {
  const sourceHint = String(
    metadata?.origin ||
      metadata?.source ||
      metadata?.sourcePlatform ||
      metadata?.platform ||
      metadata?.channel ||
      "",
  )
    .trim()
    .toLowerCase();

  if (sourceHint.includes("telegram")) return "telegram";
  if (sourceHint.includes("twitter") || sourceHint.includes("tweet") || sourceHint.includes("x")) {
    return "twitter";
  }
  return "agent";
}

function sourceLabel(source: MarketSource) {
  switch (source) {
    case "telegram":
      return "Telegram";
    case "twitter":
      return "Twitter";
    case "agent":
      return "BantahBro Agent";
    default:
      return "Onchain";
  }
}

async function fetchRemoteJson<T>(path: string, schema: z.ZodType<T>) {
  const url = `${ONCHAIN_SOURCE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const now = Date.now();
  const cached = remoteCache.get(url);
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Remote fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }

  const payload = schema.parse(await response.json());
  remoteCache.set(url, {
    expiresAt: now + REMOTE_CACHE_TTL_MS,
    value: payload,
  });
  return payload;
}

async function getRemoteMarkets(limit: number) {
  const remoteChallenges = await fetchRemoteJson("/api/challenges", remoteChallengesSchema);

  return remoteChallenges
    .filter((challenge) => ["open", "active", "pending"].includes(String(challenge.status || "").toLowerCase()))
    .map((challenge) => {
      const pools = inferChallengePools(challenge);
      const poolAmount = pools.totalPool > 0 ? pools.totalPool : parseNumber(challenge.amount);
      const p2pPricing = buildFixedP2PPricing(poolAmount, challenge.tokenSymbol || null);
      const chainFields = buildMarketChainFields(challenge.chainId);
      const isAgentMarket = Boolean(
        challenge.createdByAgent ||
          challenge.agentInvolved ||
          String(challenge.creatorType || "").toLowerCase() === "agent" ||
          challenge.creatorAgentId,
      );
      const source: MarketSource = isAgentMarket ? "agent" : "onchain";
      const creatorName =
        challenge.challengerUser?.username ||
        challenge.challengerUser?.firstName ||
        (isAgentMarket ? "Bantah Agent" : "Onchain User");

      return {
        id: `onchain-${challenge.id}`,
        challengeId: challenge.id,
        source,
        sourceLabel: sourceLabel(source),
        title: challenge.title,
        description: challenge.description || null,
        category: challenge.category || null,
        status: challenge.status,
        createdAt: challenge.createdAt,
        dueDate: challenge.dueDate || null,
        tokenSymbol: challenge.tokenSymbol || null,
        ...chainFields,
        escrowLocked: true,
        escrowLockedDisplay: "YES",
        escrowTxHash: challenge.escrowTxHash || null,
        poolAmount,
        poolDisplay: formatTokenAmount(poolAmount, challenge.tokenSymbol || null),
        yesPercent: p2pPricing.yesPercent,
        noPercent: p2pPricing.noPercent,
        yesDisplay: p2pPricing.yesDisplay,
        noDisplay: p2pPricing.noDisplay,
        participantCount: Number(challenge.participantCount || 0),
        commentCount: Number(challenge.commentCount || 0),
        marketUrl: buildRemoteChallengeUrl(challenge.id),
        coverImageUrl: pickRemoteChallengeCoverImageUrl(challenge),
        creatorName,
        isAgentMarket,
      } satisfies BantahBroLiveMarketEntry;
    })
    .sort((left, right) => {
      const rightScore =
        (right.participantCount * 12) +
        (right.commentCount * 6) +
        (right.poolAmount || 0) +
        (right.isAgentMarket ? 50 : 0);
      const leftScore =
        (left.participantCount * 12) +
        (left.commentCount * 6) +
        (left.poolAmount || 0) +
        (left.isAgentMarket ? 50 : 0);
      return rightScore - leftScore;
    })
    .slice(0, limit);
}

async function getSocialMarkets(limit: number) {
  const alerts = listBantahBroAlerts(limit * 3).filter((alert) => Boolean(alert.market?.url));

  const challengeLookups = await Promise.all(
    alerts.map(async (alert) => {
      const challengeId = alert.market?.challengeId;
      if (!challengeId) return null;

      try {
        return await storage.getChallengeById(challengeId);
      } catch {
        return null;
      }
    }),
  );

  return alerts.map((alert, index) => {
    const challenge = challengeLookups[index];
    const pools = inferChallengePools({
      amount: challenge?.amount,
      challengerSide: challenge?.challengerSide,
      challengedSide: challenge?.challengedSide,
      yesStakeTotal: challenge?.yesStakeTotal as number | null | undefined,
      noStakeTotal: challenge?.noStakeTotal as number | null | undefined,
    });
    const source = inferAlertSource(alert.metadata as Record<string, unknown> | undefined);
    const tokenSymbol = challenge?.tokenSymbol || alert.tokenSymbol || null;
    const poolAmount = pools.totalPool > 0 ? pools.totalPool : null;
    const p2pPricing = buildFixedP2PPricing(poolAmount || 0, tokenSymbol);
    const chainFields = buildMarketChainFields((challenge as any)?.chainId || alert.chainId);

    return {
      id: `social-${alert.id}`,
      challengeId: alert.market?.challengeId || null,
      source,
      sourceLabel: sourceLabel(source),
      title: challenge?.title || alert.headline,
      description: challenge?.description || trimBody(alert.body) || null,
      category: challenge?.category || "bantahbro",
      status: challenge?.status || "live",
      createdAt: alert.createdAt,
      dueDate: challenge?.dueDate ? new Date(challenge.dueDate).toISOString() : null,
      tokenSymbol,
      ...chainFields,
      escrowLocked: true,
      escrowLockedDisplay: "YES",
      escrowTxHash: (challenge as any)?.escrowTxHash || null,
      poolAmount,
      poolDisplay:
        poolAmount != null
          ? formatTokenAmount(poolAmount, tokenSymbol)
          : "Bantah signal",
      yesPercent: p2pPricing.yesPercent,
      noPercent: p2pPricing.noPercent,
      yesDisplay: poolAmount != null ? p2pPricing.yesDisplay : "50% event price",
      noDisplay: poolAmount != null ? p2pPricing.noDisplay : "50% event price",
      participantCount: Number((challenge as any)?.participantCount || 0),
      commentCount: Number((challenge as any)?.commentCount || 0),
      marketUrl: alert.market?.url || null,
      coverImageUrl: pickLocalChallengeCoverImageUrl(challenge),
      creatorName:
        (challenge as any)?.challengerUser?.username ||
        (challenge as any)?.challengerUser?.firstName ||
        "BantahBro user",
      isAgentMarket: true,
    } satisfies BantahBroLiveMarketEntry;
  });
}

export async function getLiveBantahBroMarkets(limit = 24): Promise<BantahBroMarketsFeed> {
  const automationStatus = getBantahBroAutomationStatus();
  const [remoteResult, socialResult] = await Promise.allSettled([
    getRemoteMarkets(limit),
    getSocialMarkets(limit),
  ]);

  const socialMarkets = socialResult.status === "fulfilled" ? socialResult.value : [];
  const socialChallengeIds = new Set(
    socialMarkets
      .map((entry) => entry.challengeId)
      .filter((challengeId): challengeId is number => Number.isInteger(challengeId)),
  );

  const remoteMarkets =
    remoteResult.status === "fulfilled"
      ? remoteResult.value.filter((entry) => !entry.challengeId || !socialChallengeIds.has(entry.challengeId))
      : [];

  const entries = [...socialMarkets, ...remoteMarkets]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, limit);

  const telegramCount = entries.filter((entry) => entry.source === "telegram").length;
  const twitterCount = entries.filter((entry) => entry.source === "twitter").length;

  return {
    entries,
    updatedAt: new Date().toISOString(),
    sources: {
      onchain: {
        available: remoteResult.status === "fulfilled",
        active: remoteResult.status === "fulfilled",
        count: remoteMarkets.length,
        message: remoteResult.status === "rejected" ? remoteResult.reason instanceof Error ? remoteResult.reason.message : "Remote onchain feed unavailable" : undefined,
        url: ONCHAIN_SOURCE_URL,
      },
      telegram: {
        available: true,
        active: isBantahBroElizaTelegramEnabled(),
        count: telegramCount,
      },
      twitter: {
        available: true,
        active: Boolean(automationStatus.twitterLoop.enabled),
        count: twitterCount,
        message:
          twitterCount > 0
            ? undefined
            : automationStatus.twitterLoop.reason || "Twitter BantahBro feed is not active yet.",
      },
    },
  };
}

export async function getLiveBantahBroLeaderboard(limit = 25): Promise<BantahBroLeaderboardFeed> {
  const arenaResult = await getLiveAgentBattleLeaderboard(limit).catch((error) => ({
    entries: [],
    updatedAt: new Date().toISOString(),
    activeBattleCount: 0,
    errorMessage:
      error instanceof Error ? error.message : "Arena leaderboard is temporarily unavailable.",
  }));
  const entries = arenaResult.entries
    .map((entry, index) => ({
      id: `arena-${entry.userId}`,
      source: "bantahbro",
      sourceLabel: "Arena",
      rank: index + 1,
      name: entry.name,
      handle: entry.handle,
      profileImageUrl: entry.profileImageUrl,
      score: entry.score,
      wins: entry.wins,
      balance: entry.balance,
      balanceDisplay: entry.balanceDisplay,
      points: entry.points,
      coins: entry.coins,
      challengesWon: entry.challengesWon,
      eventsWon: entry.eventsWon,
      battleJoins: entry.battleJoins,
      liveBattles: entry.liveBattles,
      totalStake: entry.totalStake,
      stakeDisplay: entry.stakeDisplay,
      currentBattleTitle: entry.currentBattleTitle,
      activeSideLabel: entry.activeSideLabel,
    } satisfies BantahBroLeaderboardEntry & {
      battleJoins: number;
      liveBattles: number;
      totalStake: number;
      stakeDisplay: string;
      currentBattleTitle: string | null;
      activeSideLabel: string | null;
    }))
    .sort((left, right) => {
      if ((right.liveBattles || 0) !== (left.liveBattles || 0)) {
        return (right.liveBattles || 0) - (left.liveBattles || 0);
      }
      if (right.score !== left.score) return right.score - left.score;
      if (right.wins !== left.wins) return right.wins - left.wins;
      return right.balance - left.balance;
    })
    .slice(0, limit)
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));

  return {
    entries,
    updatedAt: arenaResult.updatedAt,
    sources: {
      onchain: {
        available: false,
        active: false,
        count: 0,
        message: "Disabled for BOTA Arena. Rankings now come from current Agent Battle activity.",
        url: ONCHAIN_SOURCE_URL,
      },
      bantahbro: {
        available: !("errorMessage" in arenaResult),
        active: !("errorMessage" in arenaResult),
        count: entries.length,
        message: "errorMessage" in arenaResult
          ? arenaResult.errorMessage
          : arenaResult.activeBattleCount > 0
            ? `Tracking ${arenaResult.activeBattleCount} current Agent Battle${arenaResult.activeBattleCount === 1 ? "" : "s"}.`
            : "No current Agent Battles are open yet.",
      },
    },
  };
}
