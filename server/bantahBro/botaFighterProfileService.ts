import { asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { createPublicClient, formatUnits, http, isAddress, parseAbi, type Address } from "viem";
import { base, mainnet } from "viem/chains";
import {
  agents,
  botaArenaBattleRecords,
  botaFighterProfiles,
  type BotaArenaBattleRecordRow,
  type BotaFighterProfileRecord,
} from "@shared/schema.ts";
import {
  botaFighterProfileImportSchema,
  botaFighterProfileSchema,
  type BotaFighterClass,
  type BotaFighterOrigin,
  type BotaFighterProfile,
  type BotaFighterProfileImportRequest,
} from "@shared/botaFighterProfile";
import {
  deriveBotaDerivativeFighter,
  getBotaDerivativeFighter,
  type BotaDerivativeFighter,
  type BotaDerivativeTraitInput,
} from "@shared/botaDerivativeFighter";
import type { BotaArenaFighter } from "@shared/botaArena";
import { db } from "../db";
import {
  getLiveBantahBroAgentBattles,
  type BantahBroAgentBattle,
  type BantahBroAgentBattleSide,
} from "./agentBattleService";
import { attachBotaFighterLiveStats } from "./botaLiveStatsService";
import { getExternalAgentCatalogProfiles } from "./externalAgentCatalogService";
import {
  buildBotaEnsAgentIdentity,
  buildBotaEnsAgentIdentityForProfile,
} from "./ensAgentIdentityService";
import { buildBotaBnbAgentIdentity } from "./bnbAgentIdentityService";
import { attachGen1EconomyToProfiles } from "./gen1EconomyService";

const SERVER_ARENA_AGENT_AVATARS = [
  "/2dgame/image/mascots/actions/bantah-punch-avatar-portrait.png",
  "/2dgame/image/mascots/actions/bantah-rival-punch-avatar-portrait.png",
  "/2dgame/image/mascots/actions/bantah-sword-avatar-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-emerald-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-purple-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-red-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-silver-portrait.png",
] as const;

const BASESCAN_API_BASE = String(process.env.BASESCAN_API_BASE || "https://api.basescan.org/api").replace(/\/+$/, "");
const BASESCAN_API_KEY = String(process.env.BASESCAN_API_KEY || "").trim();
const BASE_RPC_URL = String(
  process.env.ONCHAIN_BASE_MAINNET_RPC_URL ||
    process.env.PONDER_RPC_URL_8453 ||
    process.env.BASE_RPC_URL ||
    "https://mainnet.base.org",
).trim();
const ETH_RPC_URL = String(
  process.env.ONCHAIN_ETHEREUM_RPC_URL ||
    process.env.ETHEREUM_RPC_URL ||
    "https://eth.llamarpc.com",
).trim();
const VIRTUALS_AGENT_REGISTRY_URL = String(
  process.env.VIRTUALS_AGENT_REGISTRY_URL ||
    process.env.BOTA_VIRTUALS_AGENT_REGISTRY_URL ||
    process.env.BOTA_VIRTUALS_AGENT_API_URL ||
    "",
).replace(/\/+$/, "");
const BANKR_AGENT_REGISTRY_URL = String(
  process.env.BANKR_AGENT_REGISTRY_URL ||
    process.env.BOTA_BANKR_AGENT_REGISTRY_URL ||
    process.env.BOTA_BANKR_AGENT_API_URL ||
    "",
).replace(/\/+$/, "");
const AGENTKIT_AGENT_REGISTRY_URL = String(
  process.env.AGENTKIT_AGENT_REGISTRY_URL ||
    process.env.BOTA_AGENTKIT_AGENT_REGISTRY_URL ||
    process.env.BOTA_BASE_AGENT_REGISTRY_URL ||
    "",
).replace(/\/+$/, "");
const ALCHEMY_DEFAULT_API_KEY = String(
  process.env.ALCHEMY_API_KEY ||
    process.env.BOTA_ALCHEMY_API_KEY ||
    "",
).trim();
const MORALIS_WALLET_API_KEY = String(
  process.env.MORALIS_API_KEY ||
    process.env.BOTA_MORALIS_API_KEY ||
    "",
).trim();
const MORALIS_EVM_API_BASE = String(
  process.env.MORALIS_EVM_API_BASE ||
    "https://deep-index.moralis.io/api/v2.2",
).replace(/\/+$/, "");
const WALLET_INDEXER_TIMEOUT_MS = Number(
  process.env.BOTA_WALLET_INDEXER_TIMEOUT_MS ||
    process.env.BANTAHBRO_MORALIS_FETCH_TIMEOUT_MS ||
    7000,
);

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

const erc721Abi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

const baseClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL),
});

const ethereumClient = createPublicClient({
  chain: mainnet,
  transport: http(ETH_RPC_URL),
});

const memoryFighterProfiles = new Map<string, BotaFighterProfile>();

let ensureProfilesTablePromise: Promise<void> | null = null;

export type BotaFighterProfileBattleUpdate = {
  winner: {
    agentId: string;
    before: BotaFighterProfile | null;
    after: BotaFighterProfile | null;
  } | null;
  loser: {
    agentId: string;
    before: BotaFighterProfile | null;
    after: BotaFighterProfile | null;
  } | null;
  rankChanges: Array<{
    profile: BotaFighterProfile;
    previousRank: number | null;
    nextRank: number | null;
    reason: string;
  }>;
};

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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

type BotaFighterIdentityKind =
  | "external-agent"
  | "generated-fighter"
  | "bantah-eliza"
  | "hybrid";

const EXTERNAL_AGENT_IDENTITY_LOGO = "/assets/bota-external-agent.svg";
const GENERATED_FIGHTER_IDENTITY_LOGO = "/assets/bota-generated-fighter.svg";
const BANTAH_ELIZA_IDENTITY_LOGO = "/assets/bota-bantah-icon.png";
const SOURCE_LOGOS: Record<string, string> = {
  bota: "/assets/bota-bantah-icon.png",
  eliza: "/assets/source-elizaos.png",
  elizaos: "/assets/source-elizaos.png",
  virtuals: "/assets/source-virtuals.jpg",
  "virtuals protocol": "/assets/source-virtuals.jpg",
  bankr: "/assets/source-bankr.png",
  "bankr bot": "/assets/source-bankr.png",
  "game-sdk": "/assets/source-game-sdk.svg",
  "game sdk": "/assets/source-game-sdk.svg",
  agentkit: "/assets/source-agentkit.svg",
  ens: "/assets/ens-badge.jpg",
  nft: "/assets/bota-bantah-icon.png",
  token: "/assets/bota-bantah-icon.png",
  dexscreener: "/assets/bota-bantah-icon.png",
  manual: "/assets/bota-bantah-icon.png",
};

function isExternalAgentOrigin(origin: BotaFighterOrigin) {
  return origin === "eliza" || origin === "virtuals" || origin === "bankr" || origin === "game-sdk" || origin === "agentkit";
}

function identityLogoForKind(kind: BotaFighterIdentityKind) {
  if (kind === "bantah-eliza" || kind === "hybrid") return BANTAH_ELIZA_IDENTITY_LOGO;
  return kind === "external-agent" ? EXTERNAL_AGENT_IDENTITY_LOGO : GENERATED_FIGHTER_IDENTITY_LOGO;
}

function sourceLogoForFighter(input: {
  origin: BotaFighterOrigin;
  source?: string | null;
  assetType?: BotaWalletAssetType | null;
}) {
  const sourceKey = String(input.source || "").trim().toLowerCase();
  if (sourceKey && SOURCE_LOGOS[sourceKey]) return SOURCE_LOGOS[sourceKey];
  if (sourceKey.includes("virtual")) return SOURCE_LOGOS.virtuals;
  if (sourceKey.includes("bankr")) return SOURCE_LOGOS.bankr;
  if (sourceKey.includes("eliza")) return SOURCE_LOGOS.eliza;
  if (sourceKey.includes("agentkit") || sourceKey.includes("agent kit")) return SOURCE_LOGOS.agentkit;
  if (sourceKey.includes("game")) return SOURCE_LOGOS["game-sdk"];
  if (sourceKey.includes("ens")) return SOURCE_LOGOS.ens;
  return SOURCE_LOGOS[input.origin] || SOURCE_LOGOS[input.assetType || ""] || SOURCE_LOGOS.bota;
}

function buildFighterIdentityMetadata(input: {
  origin: BotaFighterOrigin;
  assetType?: BotaWalletAssetType | null;
  source?: string | null;
  sourceIconUrl?: string | null;
  brain?: "external" | "elizaos-default" | string | null;
}) {
  const external = input.brain === "external" || isExternalAgentOrigin(input.origin);
  const kind: BotaFighterIdentityKind = external ? "external-agent" : "generated-fighter";
  const sourceLabel = String(input.source || input.origin || "Bantah").trim();
  const label = sourceLabel;
  const brainLabel = sourceLabel;
  const sourceLogoUrl = sourceLogoForFighter(input);
  const identityLogoUrl = external ? sourceLogoUrl : identityLogoForKind(kind);

  return {
    kind,
    label,
    sourceLabel,
    brainLabel,
    identityLogoUrl,
    sourceLogoUrl,
    assetLogoUrl: input.sourceIconUrl || null,
    primaryCapability: "arena-fighting",
    activationStatus: external ? "source-attached" : "fighter-ready",
    story: sourceLabel,
  };
}

function inferFighterIdentityMetadata(input: {
  origin: BotaFighterOrigin;
  metadata?: Record<string, unknown> | null;
  badgeLabel?: string | null;
}) {
  const existing =
    input.metadata?.agentIdentity &&
    typeof input.metadata.agentIdentity === "object" &&
    !Array.isArray(input.metadata.agentIdentity)
      ? (input.metadata.agentIdentity as Record<string, unknown>)
      : null;
  if (existing?.kind && existing?.label) return existing;

  const brain =
    input.metadata?.brain &&
    typeof input.metadata.brain === "object" &&
    !Array.isArray(input.metadata.brain)
      ? String((input.metadata.brain as Record<string, unknown>).type || "")
      : null;
  const assetType =
    typeof input.metadata?.assetType === "string"
      ? (input.metadata.assetType as BotaWalletAssetType)
      : null;
  const sourceIconUrl =
    typeof input.metadata?.originIconUrl === "string"
      ? input.metadata.originIconUrl
      : typeof input.metadata?.sourceIconUrl === "string"
        ? input.metadata.sourceIconUrl
        : null;

  return buildFighterIdentityMetadata({
    origin: input.origin,
    assetType,
    source:
      (typeof input.metadata?.sourceHint === "string" && input.metadata.sourceHint) ||
      (typeof input.metadata?.importSource === "string" && input.metadata.importSource) ||
      input.badgeLabel ||
      input.origin,
    sourceIconUrl,
    brain: brain || (isExternalAgentOrigin(input.origin) ? "external" : "elizaos-default"),
  });
}

function warnFighterProfileFallback(scope: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[WARN] BOTA fighter profile DB unavailable during ${scope}; using in-memory fallback: ${message}`);
}

function upsertMemoryFighterProfile(input: Record<string, unknown> & {
  agentId: string;
  displayName: string;
  origin: BotaFighterOrigin;
  agentClass: BotaFighterClass;
  archetype: BotaArenaFighter["archetype"];
  league: string;
}) {
  const previous = memoryFighterProfiles.get(input.agentId);
  const now = new Date().toISOString();
  const source = { ...previous, ...input };
  const profile = botaFighterProfileSchema.parse({
    agentId: source.agentId,
    displayName: source.displayName,
    origin: source.origin,
    originId: source.originId ?? null,
    agentClass: source.agentClass,
    archetype: source.archetype,
    league: source.league,
    rank: source.rank ?? null,
    avatarUrl: normalizeStoredAvatarUrl(source.avatarUrl as string | null | undefined, `${source.origin}:${source.agentId}:${source.displayName}`),
    badgeLabel: source.badgeLabel ?? null,
    ensName: source.ensName ?? null,
    walletAddress: source.walletAddress ?? null,
    externalUrl: source.externalUrl ?? null,
    tokenSymbol: source.tokenSymbol ?? null,
    tokenName: source.tokenName ?? null,
    chainId: source.chainId ?? null,
    wins: toNumber(source.wins, previous?.wins ?? 0),
    losses: toNumber(source.losses, previous?.losses ?? 0),
    currentStreak: toNumber(source.currentStreak, previous?.currentStreak ?? 0),
    fameScore: toNumber(source.fameScore, previous?.fameScore ?? 0),
    watchers: toNumber(source.watchers, previous?.watchers ?? 0),
    challengeVolume: toNumber(source.challengeVolume, previous?.challengeVolume ?? 0),
    bantCreditsEarned: toNumber(source.bantCreditsEarned, previous?.bantCreditsEarned ?? 0),
    liveSpectators: toNumber(source.liveSpectators, previous?.liveSpectators ?? 0),
    liveStats: source.liveStats || previous?.liveStats,
    titles: Array.isArray(source.titles) ? source.titles : previous?.titles || [],
    tags: Array.isArray(source.tags) ? source.tags : previous?.tags || [],
    lastBattleId: source.lastBattleId ?? null,
    metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : previous?.metadata || {},
    importedAt: toIso(source.importedAt) || previous?.importedAt || now,
    lastSeenAt: now,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  });
  memoryFighterProfiles.set(profile.agentId, profile);
  return profile;
}

function listMemoryFighterProfiles(input: {
  limit?: number;
  origin?: BotaFighterOrigin | null;
} = {}) {
  const requestedLimit = Math.max(1, Math.min(Math.round(input.limit || 40), 100));
  const profiles = Array.from(memoryFighterProfiles.values())
    .filter((profile) => !input.origin || profile.origin === input.origin)
    .sort((left, right) => {
      const fameDelta = right.fameScore - left.fameScore;
      if (fameDelta) return fameDelta;
      return (left.rank || 9999) - (right.rank || 9999);
    })
    .slice(0, requestedLimit);

  return {
    profiles,
    updatedAt: new Date().toISOString(),
  };
}

const BOTA_COMMUNITY_DEFS = [
  { key: "all", label: "All", iconUrl: "/assets/bota-bantah-icon.png" },
  { key: "ens", label: "ENS", iconUrl: "/assets/ens-badge.jpg" },
  { key: "virtuals", label: "Virtuals", iconUrl: "/assets/source-virtuals.jpg" },
  { key: "eliza", label: "ElizaOS", iconUrl: "/assets/source-elizaos.png" },
  { key: "bankr", label: "Bankr", iconUrl: "/assets/source-bankr.png" },
  { key: "agentkit", label: "AgentKit", iconUrl: "/assets/source-agentkit.svg" },
  { key: "game-sdk", label: "GAME SDK", iconUrl: "/assets/source-game-sdk.svg" },
  { key: "meme", label: "Meme", iconUrl: "/assets/bota-bantah-icon.png" },
  { key: "nft", label: "NFT", iconUrl: "/assets/bota-bantah-icon.png" },
  { key: "bota", label: "BOTA", iconUrl: "/assets/bota-bantah-icon.png" },
] as const;

type BotaCommunityKey = (typeof BOTA_COMMUNITY_DEFS)[number]["key"];

type BotaCommunityStats = {
  key: BotaCommunityKey;
  label: string;
  iconUrl: string;
  agents: number;
  wins: number;
  losses: number;
  bantCredits: number;
  score: number;
  topAgent: {
    agentId: string;
    name: string;
    rank: number | null;
    wins: number;
    losses: number;
    bantCredits: number;
    score: number;
    avatarUrl: string | null;
  } | null;
  onchain: {
    battles: number;
    events: number;
    wins: number;
    losses: number;
    spectators: number;
    fighterBantCredits: number;
    spectatorBantCredits: number;
    totalBantCredits: number;
  };
};

function newCommunityStats(definition: (typeof BOTA_COMMUNITY_DEFS)[number]): BotaCommunityStats {
  return {
    ...definition,
    agents: 0,
    wins: 0,
    losses: 0,
    bantCredits: 0,
    score: 0,
    topAgent: null,
    onchain: {
      battles: 0,
      events: 0,
      wins: 0,
      losses: 0,
      spectators: 0,
      fighterBantCredits: 0,
      spectatorBantCredits: 0,
      totalBantCredits: 0,
    },
  };
}

function botaCommunityKeyForProfile(profile: Pick<BotaFighterProfile, "origin" | "metadata" | "tokenSymbol">): BotaCommunityKey {
  const derivative = getBotaDerivativeFighter(profile.metadata);
  const sourceHint =
    typeof profile.metadata?.sourceHint === "string"
      ? profile.metadata.sourceHint.toLowerCase()
      : typeof profile.metadata?.importSource === "string"
        ? profile.metadata.importSource.toLowerCase()
        : typeof profile.metadata?.importedFrom === "string"
          ? profile.metadata.importedFrom.toLowerCase()
          : "";

  if (derivative || profile.origin === "nft") return "nft";
  if (profile.origin === "ens") return "ens";
  if (profile.origin === "virtuals") return "virtuals";
  if (profile.origin === "eliza") return "eliza";
  if (profile.origin === "bankr") return "bankr";
  if (profile.origin === "agentkit") return "agentkit";
  if (profile.origin === "game-sdk") return "game-sdk";
  if (profile.origin === "token" || profile.origin === "dexscreener" || sourceHint.includes("meme") || sourceHint.includes("dex")) {
    return "meme";
  }
  return "bota";
}

function botaCommunityKeyForAgentId(agentId: string): BotaCommunityKey | null {
  const normalized = normalizeBotaFighterAgentId(agentId);
  if (!normalized) return null;
  if (normalized.startsWith("ens:") || normalized.includes("-eth")) return "ens";
  if (normalized.startsWith("virtuals:") || normalized.startsWith("virtuals-")) return "virtuals";
  if (normalized.startsWith("eliza:") || normalized.startsWith("eliza-")) return "eliza";
  if (normalized.startsWith("bankr:") || normalized.startsWith("bankr-")) return "bankr";
  if (normalized.startsWith("agentkit:") || normalized.startsWith("agentkit-")) return "agentkit";
  if (normalized.startsWith("game-sdk:") || normalized.startsWith("game-sdk-")) return "game-sdk";
  if (normalized.startsWith("nft:") || normalized.startsWith("nft-")) return "nft";
  if (normalized.startsWith("token:") || normalized.startsWith("dexscreener:")) return "meme";
  if (normalized.startsWith("bota:") || normalized.startsWith("manual:")) return "bota";
  return null;
}

function betterTopCommunityAgent(
  current: BotaCommunityStats["topAgent"],
  next: NonNullable<BotaCommunityStats["topAgent"]>,
) {
  if (!current) return next;
  const currentRank = current.rank || Number.POSITIVE_INFINITY;
  const nextRank = next.rank || Number.POSITIVE_INFINITY;
  if (nextRank !== currentRank) return nextRank < currentRank ? next : current;
  if (next.score !== current.score) return next.score > current.score ? next : current;
  if (next.wins !== current.wins) return next.wins > current.wins ? next : current;
  return next;
}

function addProfileToCommunityStats(stats: BotaCommunityStats, profile: BotaFighterProfile) {
  const bantCredits = profilePositiveNumber(profile, "bantCreditsEarned");
  const score = Math.max(0, Math.round(Number(profile.fameScore || 0)));
  const wins = Math.max(0, Math.round(Number(profile.wins || 0)));
  const losses = Math.max(0, Math.round(Number(profile.losses || 0)));
  stats.agents += 1;
  stats.wins += wins;
  stats.losses += losses;
  stats.bantCredits += bantCredits;
  stats.score += score;
  stats.topAgent = betterTopCommunityAgent(stats.topAgent, {
    agentId: profile.agentId,
    name: profile.origin === "ens" && profile.ensName ? profile.ensName : profile.displayName,
    rank: profile.rank,
    wins,
    losses,
    bantCredits,
    score,
    avatarUrl: profile.avatarUrl,
  });
}

function communityStatsTimeoutMs() {
  return Math.max(1000, Math.min(Number(process.env.BOTA_COMMUNITY_STATS_DB_TIMEOUT_MS || 8000), 30000));
}

async function withCommunityStatsTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeoutMs = communityStatsTimeoutMs();
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type BotaWalletAssetType = "ai-agent" | "nft" | "ens" | "token";

type BotaWalletFighterAsset = {
  id: string;
  type: BotaWalletAssetType;
  name: string;
  subtitle: string;
  source: string;
  sourceIconUrl: string | null;
  chainId: string;
  contractAddress: string | null;
  tokenId: string | null;
  avatarUrl: string;
  brain: "external" | "elizaos-default";
  fighter: BotaFighterProfileImportRequest;
};

function shortWallet(value: string) {
  const clean = value.trim();
  if (!clean) return "demo";
  return clean.length > 12 ? `${clean.slice(0, 6)}...${clean.slice(-4)}` : clean;
}

function seededNumber(seed: string, min: number, max: number) {
  const range = Math.max(1, max - min + 1);
  return min + stableIndex(seed, range);
}

function tokenAddress(seed: string, index: number) {
  const alphabet = "0123456789abcdef";
  let value = "0x";
  for (let offset = 0; offset < 40; offset += 1) {
    value += alphabet[(stableIndex(`${seed}:${index}:${offset}`, alphabet.length))];
  }
  return value;
}

function derivativeTraitInput(value: unknown): BotaDerivativeTraitInput[] | Record<string, unknown> | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.filter(
      (trait): trait is BotaDerivativeTraitInput =>
        typeof trait === "string" ||
        (Boolean(trait) && typeof trait === "object" && !Array.isArray(trait)),
    );
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return null;
}

function derivativeScalar(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function buildWalletFighterAsset(input: {
  seed: string;
  walletAddress: string | null;
  type: BotaWalletAssetType;
  name: string;
  subtitle: string;
  source: string;
  origin: BotaFighterOrigin;
  chainId: string;
  agentClass: BotaFighterClass;
  archetype: BotaArenaFighter["archetype"];
  tokenSymbol?: string | null;
  tokenName?: string | null;
  collectionName?: string | null;
  traits?: Record<string, unknown> | unknown[] | null;
  rarity?: string | number | null;
  ensName?: string | null;
  externalUrl?: string | null;
  contractAddress?: string | null;
  tokenId?: string | null;
  sourceIconUrl?: string | null;
  brain?: "external" | "elizaos-default";
  title?: string;
  rankOffset?: number;
  metadata?: Record<string, unknown>;
}) {
  const assetSeed = `${input.seed}:${input.type}:${input.name}`;
  const rank = clamp(seededNumber(assetSeed, 4, 88) + (input.rankOffset || 0), 1, 99);
  const derivativeFighter = input.type === "nft"
    ? deriveBotaDerivativeFighter({
        collection: input.collectionName || input.tokenName || input.source || input.name,
        tokenId: derivativeScalar(input.tokenId),
        traits: derivativeTraitInput(input.traits) || derivativeTraitInput(input.metadata?.traits),
        rarity: derivativeScalar(input.rarity) || derivativeScalar(input.metadata?.rarity),
        seed: assetSeed,
      })
    : null;
  const usesBotaFighterAvatar = input.type === "ai-agent" || isExternalAgentOrigin(input.origin);
  const avatarUrl = derivativeFighter
    ? derivativeAvatar(derivativeFighter, assetSeed)
    : usesBotaFighterAvatar
      ? arenaAgentAvatar(assetSeed)
      : input.sourceIconUrl || arenaAgentAvatar(assetSeed);
  const fighterName = derivativeFighter
    ? `${derivativeFighter.speciesLabel}${derivativeFighter.sourceTokenId ? ` #${derivativeFighter.sourceTokenId}` : ""}`
    : input.type === "ens"
      ? input.ensName || input.name
    : input.name.endsWith("Agent") || input.type === "ai-agent"
      ? input.name
      : `${input.name} Fighter`;
  const id = normalizeBotaFighterAgentId(`${input.origin}:${input.contractAddress || input.ensName || input.name}`);
  const titles = derivativeFighter
    ? Array.from(new Set([...derivativeFighter.titles, input.title || "NFT Fighter"]))
    : [input.title || "Imported Fighter"];
  const tags = [
    input.type,
    input.origin,
    input.chainId,
    input.archetype,
    ...(derivativeFighter?.tags || []),
  ].filter(Boolean);
  const agentIdentity = buildFighterIdentityMetadata({
    origin: input.origin,
    assetType: input.type,
    source: input.source,
    sourceIconUrl: input.sourceIconUrl || null,
    brain: input.brain || "elizaos-default",
  });

  const fighter: BotaFighterProfileImportRequest = {
    agentId: id,
    displayName: fighterName,
    origin: input.origin,
    originId: input.contractAddress || input.ensName || input.name,
    agentClass: input.agentClass,
    archetype: input.archetype,
    league: rank <= 12 ? "Elite League" : rank <= 32 ? "Pro League" : "Open League",
    rank,
    avatarUrl,
    badgeLabel: input.source,
    ensName: input.ensName || null,
    walletAddress: input.walletAddress,
    externalUrl: input.externalUrl || null,
    tokenSymbol: input.tokenSymbol || null,
    tokenName: input.tokenName || input.collectionName || input.name,
    chainId: input.chainId,
    titles,
    tags,
    metadata: {
      assetType: input.type,
      importSource: input.source,
      sourceHint: input.source,
      originIconUrl: input.sourceIconUrl || null,
      agentIdentity,
      logoBadge: {
        label: agentIdentity.label,
        imageUrl: agentIdentity.sourceLogoUrl,
      },
      derivativeFighter,
      visualStandard: derivativeFighter ? "70% Bantah / 30% collection inspiration" : "BOTA native fighter",
      sourceAsset: {
        name: input.name,
        subtitle: input.subtitle,
        sourceAvatarUrl: input.sourceIconUrl || null,
        contractAddress: input.contractAddress || null,
        tokenId: input.tokenId || null,
        collection: input.collectionName || input.tokenName || input.source || null,
        traits: input.traits || null,
        rarity: input.rarity || null,
      },
      brain: {
        type: input.brain || "elizaos-default",
        label: input.source,
      },
      adapter: {
        status: "ready",
        pipeline: ["classified", "fighter-created", "adapter-ready"],
      },
      ...(input.metadata || {}),
    },
  };

  return {
    id,
    type: input.type,
    name: input.name,
    subtitle: input.subtitle,
    source: input.source,
    sourceIconUrl: input.sourceIconUrl || null,
    chainId: input.chainId,
    contractAddress: input.contractAddress || null,
    tokenId: input.tokenId || null,
    avatarUrl,
    brain: input.brain || "elizaos-default",
    fighter,
  } satisfies BotaWalletFighterAsset;
}

function derivativeAvatar(derivative: BotaDerivativeFighter, seed: string) {
  const avatarBySpecies: Record<string, string[]> = {
    "bantah-kittie": [
      "/2dgame/image/mascots/actions/bantah-avatar-emerald-portrait.png",
      "/2dgame/image/mascots/actions/bantah-avatar-purple-portrait.png",
      "/2dgame/image/mascots/actions/bantah-avatar-red-portrait.png",
    ],
    "bantah-pengu": [
      "/2dgame/image/mascots/actions/bantah-avatar-silver-portrait.png",
      "/2dgame/image/mascots/actions/bantah-avatar-purple-portrait.png",
    ],
    "bantah-zuki": [
      "/2dgame/image/mascots/actions/bantah-sword-avatar-portrait.png",
      "/2dgame/image/mascots/actions/bantah-avatar-red-portrait.png",
    ],
    "bantah-doodle": [
      "/2dgame/image/mascots/actions/bantah-avatar-purple-portrait.png",
      "/2dgame/image/mascots/actions/bantah-avatar-emerald-portrait.png",
    ],
    "bantah-bird": [
      "/2dgame/image/mascots/actions/bantah-avatar-silver-portrait.png",
      "/2dgame/image/mascots/actions/bantah-avatar-purple-portrait.png",
    ],
    "bantah-ape": [
      "/2dgame/image/mascots/actions/bantah-punch-avatar-portrait.png",
      "/2dgame/image/mascots/actions/bantah-rival-punch-avatar-portrait.png",
    ],
    "bantah-hypurr": [
      "/2dgame/image/mascots/actions/bantah-avatar-emerald-portrait.png",
      "/2dgame/image/mascots/actions/bantah-punch-avatar-portrait.png",
    ],
    "bantah-relic": [
      "/2dgame/image/mascots/actions/bantah-avatar-silver-portrait.png",
      "/2dgame/image/mascots/actions/bantah-avatar-emerald-portrait.png",
      "/2dgame/image/mascots/actions/bantah-avatar-purple-portrait.png",
    ],
  };
  const pool = avatarBySpecies[derivative.species] || avatarBySpecies["bantah-relic"];
  return pool[stableIndex(`${seed}:${derivative.species}:${derivative.colorway}`, pool.length)];
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 7000): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithHeaders<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs = WALLET_INDEXER_TIMEOUT_MS,
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...headers,
      },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function postJsonWithHeaders<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = WALLET_INDEXER_TIMEOUT_MS,
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonZeroHexBalance(value: unknown) {
  const raw = getString(value).toLowerCase();
  if (!raw || raw === "0x" || raw === "0x0") return false;
  try {
    return BigInt(raw) > 0n;
  } catch {
    return false;
  }
}

function providerKey(value: string | null | undefined) {
  const key = String(value || "").trim();
  if (!key || key.toLowerCase().includes("your_") || key.toLowerCase().includes("replace")) {
    return "";
  }
  return key;
}

function uniqueAssets(assets: BotaWalletFighterAsset[]) {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (seen.has(asset.id)) return false;
    seen.add(asset.id);
    return true;
  });
}

function basescanUrl(params: Record<string, string>) {
  const url = new URL(BASESCAN_API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  if (BASESCAN_API_KEY) url.searchParams.set("apikey", BASESCAN_API_KEY);
  return url.toString();
}

function validWallet(value: string | null): value is Address {
  return Boolean(value && isAddress(value));
}

type BasescanTokenTransfer = {
  contractAddress?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  tokenID?: string;
  tokenId?: string;
};

type BasescanResponse<T> = {
  status?: string;
  message?: string;
  result?: T;
};

type WalletIndexerChain = {
  chainId: string;
  label: string;
  alchemyHost: string | null;
  alchemyKeyEnv: string[];
  moralisChain: string;
};

const WALLET_INDEXER_CHAINS: WalletIndexerChain[] = [
  {
    chainId: "ethereum",
    label: "Ethereum",
    alchemyHost: "eth-mainnet",
    alchemyKeyEnv: ["ALCHEMY_ETHEREUM_API_KEY", "BOTA_ALCHEMY_ETHEREUM_API_KEY"],
    moralisChain: "eth",
  },
  {
    chainId: "base",
    label: "Base",
    alchemyHost: "base-mainnet",
    alchemyKeyEnv: ["ALCHEMY_BASE_API_KEY", "BOTA_ALCHEMY_BASE_API_KEY"],
    moralisChain: "base",
  },
  {
    chainId: "arbitrum",
    label: "Arbitrum",
    alchemyHost: "arb-mainnet",
    alchemyKeyEnv: ["ALCHEMY_ARBITRUM_API_KEY", "BOTA_ALCHEMY_ARBITRUM_API_KEY"],
    moralisChain: "arbitrum",
  },
  {
    chainId: "optimism",
    label: "Optimism",
    alchemyHost: "opt-mainnet",
    alchemyKeyEnv: ["ALCHEMY_OPTIMISM_API_KEY", "BOTA_ALCHEMY_OPTIMISM_API_KEY"],
    moralisChain: "optimism",
  },
  {
    chainId: "polygon",
    label: "Polygon",
    alchemyHost: "polygon-mainnet",
    alchemyKeyEnv: ["ALCHEMY_POLYGON_API_KEY", "BOTA_ALCHEMY_POLYGON_API_KEY"],
    moralisChain: "polygon",
  },
  {
    chainId: "bsc",
    label: "BSC",
    alchemyHost: null,
    alchemyKeyEnv: [],
    moralisChain: "bsc",
  },
];

function alchemyApiKeyForChain(chain: WalletIndexerChain) {
  for (const envName of chain.alchemyKeyEnv) {
    const key = providerKey(process.env[envName]);
    if (key) return key;
  }
  return providerKey(ALCHEMY_DEFAULT_API_KEY);
}

function normalizeTokenId(value: unknown) {
  const raw = getString(value);
  if (!raw) return null;
  if (!raw.startsWith("0x")) return raw;
  try {
    return BigInt(raw).toString();
  } catch {
    return raw;
  }
}

function normalizeTraitObject(rawTraits: unknown) {
  const traits = getArray(rawTraits);
  if (!traits.length) return null;
  const normalized: Record<string, unknown> = {};
  for (const rawTrait of traits) {
    const trait = getRecord(rawTrait);
    const key = getString(trait.trait_type || trait.traitType || trait.type || trait.name);
    if (!key) continue;
    normalized[key] = trait.value ?? trait.trait_value ?? trait.traitValue ?? "";
  }
  return Object.keys(normalized).length ? normalized : traits;
}

function normalizeIndexerImage(value: unknown) {
  const record = getRecord(value);
  return getString(
    record.cachedUrl ||
      record.pngUrl ||
      record.thumbnailUrl ||
      record.originalUrl ||
      record.imageUrl ||
      record.url,
  ) || null;
}

type AlchemyTokenBalancesResponse = {
  result?: {
    tokenBalances?: Array<{
      contractAddress?: string;
      tokenBalance?: string;
    }>;
  };
};

type AlchemyTokenMetadataResponse = {
  result?: {
    decimals?: number | null;
    logo?: string | null;
    name?: string | null;
    symbol?: string | null;
  };
};

async function scanAlchemyErc20Assets(wallet: Address, chain: WalletIndexerChain) {
  const apiKey = chain.alchemyHost ? alchemyApiKeyForChain(chain) : "";
  if (!apiKey || !chain.alchemyHost) return [];
  const rpcUrl = `https://${chain.alchemyHost}.g.alchemy.com/v2/${apiKey}`;
  const response = await postJsonWithHeaders<AlchemyTokenBalancesResponse>(
    rpcUrl,
    {
      id: 1,
      jsonrpc: "2.0",
      method: "alchemy_getTokenBalances",
      params: [wallet, "erc20"],
    },
    {},
  );
  const balances = response?.result?.tokenBalances || [];
  const ownedBalances = balances
    .filter((row) => row.contractAddress && isAddress(row.contractAddress) && nonZeroHexBalance(row.tokenBalance))
    .slice(0, 18);

  const assets: BotaWalletFighterAsset[] = [];
  for (const row of ownedBalances) {
    const contractAddress = row.contractAddress as Address;
    const metadata = await postJsonWithHeaders<AlchemyTokenMetadataResponse>(
      rpcUrl,
      {
        id: 1,
        jsonrpc: "2.0",
        method: "alchemy_getTokenMetadata",
        params: [contractAddress],
      },
      {},
    );
    const meta = metadata?.result || {};
    const decimals = typeof meta.decimals === "number" ? meta.decimals : 18;
    const rawBalance = BigInt(row.tokenBalance || "0x0");
    const symbol = getString(meta.symbol, "TOKEN").slice(0, 32);
    const name = getString(meta.name, symbol || `${chain.label} Token`);
    const formatted = formatUnits(rawBalance, decimals);
    const displayBalance = Number(formatted).toLocaleString(undefined, { maximumFractionDigits: 4 });

    assets.push(
      buildWalletFighterAsset({
        seed: `${wallet}:${chain.chainId}`,
        walletAddress: wallet,
        type: "token",
        name: symbol,
        subtitle: `${name} balance ${displayBalance} on ${chain.label}`,
        source: `${chain.label} Token`,
        origin: "token",
        chainId: chain.chainId,
        agentClass: "berserker",
        archetype: "chaos_berserker",
        contractAddress,
        tokenSymbol: symbol,
        tokenName: name,
        sourceIconUrl: meta.logo || null,
        title: "Token Fighter",
        metadata: {
          scanner: "alchemy-erc20",
          provider: "alchemy",
          detectedOnchain: true,
          balance: {
            raw: rawBalance.toString(),
            decimals,
            formatted,
          },
        },
      }),
    );
  }

  return assets;
}

async function scanAlchemyNftAssets(wallet: Address, chain: WalletIndexerChain) {
  const apiKey = chain.alchemyHost ? alchemyApiKeyForChain(chain) : "";
  if (!apiKey || !chain.alchemyHost) return [];
  const url = new URL(`https://${chain.alchemyHost}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`);
  url.searchParams.set("owner", wallet);
  url.searchParams.set("withMetadata", "true");
  url.searchParams.set("pageSize", "30");
  const response = await fetchJsonWithHeaders<Record<string, unknown>>(url.toString(), {});
  const rows = getArray(response?.ownedNfts).slice(0, 18);

  return rows.map((raw, index) => {
    const nft = getRecord(raw);
    const contract = getRecord(nft.contract);
    const collection = getRecord(nft.collection);
    const contractMetadata = getRecord(nft.contractMetadata);
    const openSeaMetadata = getRecord(contractMetadata.openSea);
    const metadata = getRecord(nft.metadata || nft.rawMetadata);
    const tokenId = normalizeTokenId(nft.tokenId || nft.id || getRecord(nft.id).tokenId);
    const contractAddress = getString(contract.address);
    const collectionName = getString(
      collection.name ||
        contractMetadata.name ||
        openSeaMetadata.collectionName ||
        openSeaMetadata.name ||
        metadata.collection ||
        metadata.name,
      "NFT Collection",
    );
    const title = getString(nft.name || nft.title || metadata.name, `${collectionName} #${tokenId || index + 1}`);
    const traits = normalizeTraitObject(metadata.attributes || nft.attributes || nft.traits);
    const rarityRecord = getRecord(nft.rarity);

    return buildWalletFighterAsset({
      seed: `${wallet}:${chain.chainId}:alchemy-nft:${index}`,
      walletAddress: wallet,
      type: "nft",
      name: title,
      subtitle: `Owned ${chain.label} NFT converted into a BOTA derivative fighter`,
      source: "NFT",
      origin: "nft",
      chainId: chain.chainId,
      agentClass: "guardian",
      archetype: "liquidity_guardian",
      contractAddress: isAddress(contractAddress) ? contractAddress : null,
      tokenId,
      tokenName: title,
      collectionName,
      traits,
      rarity: derivativeScalar(rarityRecord.rank) || derivativeScalar(rarityRecord.score) || derivativeScalar(metadata.rarity),
      title: "Derivative Fighter",
      metadata: {
        scanner: "alchemy-nft",
        provider: "alchemy",
        detectedOnchain: true,
        originalAssetImage: normalizeIndexerImage(nft.image || nft.media || metadata.image),
        collection,
      },
    });
  });
}

async function scanAlchemyWalletAssets(wallet: Address) {
  const configuredChains = WALLET_INDEXER_CHAINS.filter((chain) => chain.alchemyHost && alchemyApiKeyForChain(chain));
  if (!configuredChains.length) return [];
  const chainAssets = await Promise.all(
    configuredChains.map(async (chain) => {
      const [tokens, nfts] = await Promise.all([
        scanAlchemyErc20Assets(wallet, chain),
        scanAlchemyNftAssets(wallet, chain),
      ]);
      return [...nfts, ...tokens];
    }),
  );
  return uniqueAssets(chainAssets.flat()).slice(0, 60);
}

type MoralisErc20Asset = {
  token_address?: string;
  address?: string;
  name?: string;
  symbol?: string;
  logo?: string;
  thumbnail?: string;
  decimals?: string | number;
  balance?: string;
};

type MoralisNftAsset = {
  token_address?: string;
  token_id?: string;
  tokenId?: string;
  name?: string;
  normalized_metadata?: Record<string, unknown>;
  metadata?: string | Record<string, unknown>;
  collection?: string;
  collection_name?: string;
  symbol?: string;
  rarity_rank?: string | number;
  rarity?: string | number;
};

function parseMoralisMetadata(value: unknown) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return getRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return getRecord(value);
}

async function scanMoralisErc20Assets(wallet: Address, chain: WalletIndexerChain) {
  if (!providerKey(MORALIS_WALLET_API_KEY)) return [];
  const url = new URL(`${MORALIS_EVM_API_BASE}/${wallet}/erc20`);
  url.searchParams.set("chain", chain.moralisChain);
  const rows = await fetchJsonWithHeaders<MoralisErc20Asset[]>(
    url.toString(),
    { "X-API-Key": MORALIS_WALLET_API_KEY },
  );
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      const balance = getString(row.balance);
      try {
        return row.token_address && isAddress(row.token_address) && BigInt(balance || "0") > 0n;
      } catch {
        return false;
      }
    })
    .slice(0, 18)
    .map((row) => {
      const rawBalance = BigInt(row.balance || "0");
      const decimals = getNumber(row.decimals, 18);
      const symbol = getString(row.symbol, "TOKEN").slice(0, 32);
      const name = getString(row.name, symbol || `${chain.label} Token`);
      const formatted = formatUnits(rawBalance, decimals);
      return buildWalletFighterAsset({
        seed: `${wallet}:${chain.chainId}:moralis-token`,
        walletAddress: wallet,
        type: "token",
        name: symbol,
        subtitle: `${name} balance ${Number(formatted).toLocaleString(undefined, { maximumFractionDigits: 4 })} on ${chain.label}`,
        source: `${chain.label} Token`,
        origin: "token",
        chainId: chain.chainId,
        agentClass: "berserker",
        archetype: "chaos_berserker",
        contractAddress: row.token_address || null,
        tokenSymbol: symbol,
        tokenName: name,
        sourceIconUrl: row.logo || row.thumbnail || null,
        title: "Token Fighter",
        metadata: {
          scanner: "moralis-erc20",
          provider: "moralis",
          detectedOnchain: true,
          balance: {
            raw: rawBalance.toString(),
            decimals,
            formatted,
          },
        },
      });
    });
}

async function scanMoralisNftAssets(wallet: Address, chain: WalletIndexerChain) {
  if (!providerKey(MORALIS_WALLET_API_KEY)) return [];
  const url = new URL(`${MORALIS_EVM_API_BASE}/${wallet}/nft`);
  url.searchParams.set("chain", chain.moralisChain);
  url.searchParams.set("format", "decimal");
  url.searchParams.set("normalizeMetadata", "true");
  url.searchParams.set("limit", "30");
  const response = await fetchJsonWithHeaders<Record<string, unknown>>(
    url.toString(),
    { "X-API-Key": MORALIS_WALLET_API_KEY },
  );
  const rows = getArray(response?.result).slice(0, 18);

  return rows.map((raw, index) => {
    const nft = raw as MoralisNftAsset;
    const normalizedMetadata = getRecord(nft.normalized_metadata);
    const metadata = {
      ...parseMoralisMetadata(nft.metadata),
      ...normalizedMetadata,
    };
    const collectionName = getString(nft.collection_name || nft.collection || nft.name || metadata.collection, "NFT Collection");
    const tokenId = getString(nft.token_id || nft.tokenId, String(index + 1));
    const title = getString(metadata.name || nft.name, `${collectionName} #${tokenId}`);
    const traits = normalizeTraitObject(metadata.attributes || metadata.traits);

    return buildWalletFighterAsset({
      seed: `${wallet}:${chain.chainId}:moralis-nft:${index}`,
      walletAddress: wallet,
      type: "nft",
      name: title,
      subtitle: `Owned ${chain.label} NFT converted into a BOTA derivative fighter`,
      source: "NFT",
      origin: "nft",
      chainId: chain.chainId,
      agentClass: "guardian",
      archetype: "liquidity_guardian",
      contractAddress: nft.token_address && isAddress(nft.token_address) ? nft.token_address : null,
      tokenId,
      tokenName: title,
      collectionName,
      traits,
      rarity: derivativeScalar(nft.rarity_rank) || derivativeScalar(nft.rarity) || derivativeScalar(metadata.rarity),
      title: "Derivative Fighter",
      metadata: {
        scanner: "moralis-nft",
        provider: "moralis",
        detectedOnchain: true,
        originalAssetImage: getString(metadata.image || metadata.image_url || metadata.thumbnail) || null,
        collection: collectionName,
      },
    });
  });
}

async function scanMoralisWalletAssets(wallet: Address) {
  if (!providerKey(MORALIS_WALLET_API_KEY)) return [];
  const chainAssets = await Promise.all(
    WALLET_INDEXER_CHAINS.map(async (chain) => {
      const [tokens, nfts] = await Promise.all([
        scanMoralisErc20Assets(wallet, chain),
        scanMoralisNftAssets(wallet, chain),
      ]);
      return [...nfts, ...tokens];
    }),
  );
  return uniqueAssets(chainAssets.flat()).slice(0, 80);
}

async function readBaseErc20Balance(wallet: Address, contractAddress: Address) {
  try {
    const [balance, decimals, symbol, name] = await Promise.all([
      baseClient.readContract({ address: contractAddress, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
      baseClient.readContract({ address: contractAddress, abi: erc20Abi, functionName: "decimals" }),
      baseClient.readContract({ address: contractAddress, abi: erc20Abi, functionName: "symbol" }),
      baseClient.readContract({ address: contractAddress, abi: erc20Abi, functionName: "name" }),
    ]);
    const amount = BigInt(balance.toString());
    if (amount <= 0n) return null;
    return {
      balance: amount,
      decimals: Number(decimals),
      symbol: String(symbol || "TOKEN"),
      name: String(name || symbol || "Base Token"),
      balanceLabel: formatUnits(amount, Number(decimals)),
    };
  } catch {
    return null;
  }
}

async function scanBaseErc20Assets(wallet: Address) {
  const transfers = await fetchJsonWithTimeout<BasescanResponse<BasescanTokenTransfer[]>>(
    basescanUrl({
      module: "account",
      action: "tokentx",
      address: wallet,
      startblock: "0",
      endblock: "999999999",
      sort: "desc",
      page: "1",
      offset: "30",
    }),
  );

  const rows = Array.isArray(transfers?.result) ? transfers.result : [];
  const contracts = uniqueAssets(
    rows
      .filter((row) => row.contractAddress && isAddress(row.contractAddress))
      .map((row) =>
        buildWalletFighterAsset({
          seed: wallet,
          walletAddress: wallet,
          type: "token",
          name: row.tokenSymbol || row.tokenName || "Base Token",
          subtitle: `${row.tokenName || row.tokenSymbol || "Token"} held on Base`,
          source: "Base Token",
          origin: "token",
          chainId: "base",
          agentClass: "berserker",
          archetype: "chaos_berserker",
          contractAddress: row.contractAddress!,
          tokenSymbol: row.tokenSymbol || null,
          tokenName: row.tokenName || row.tokenSymbol || null,
          title: "Base Asset",
          metadata: {
            scanner: "basescan-erc20",
            detectedOnchain: true,
          },
        }),
      ),
  ).slice(0, 8);

  const verified: BotaWalletFighterAsset[] = [];
  for (const asset of contracts) {
    const balance = asset.contractAddress && isAddress(asset.contractAddress)
      ? await readBaseErc20Balance(wallet, asset.contractAddress)
      : null;
    if (!balance) continue;
    verified.push({
      ...asset,
      name: balance.symbol,
      subtitle: `${balance.name} balance ${Number(balance.balanceLabel).toLocaleString(undefined, { maximumFractionDigits: 4 })}`,
      fighter: {
        ...asset.fighter,
        displayName: `${balance.symbol} Fighter`,
        tokenSymbol: balance.symbol,
        tokenName: balance.name,
        metadata: {
          ...asset.fighter.metadata,
          balance: {
            raw: balance.balance.toString(),
            decimals: balance.decimals,
            formatted: balance.balanceLabel,
          },
        },
      },
    });
  }

  return verified;
}

async function scanBaseNftAssets(wallet: Address) {
  const transfers = await fetchJsonWithTimeout<BasescanResponse<BasescanTokenTransfer[]>>(
    basescanUrl({
      module: "account",
      action: "tokennfttx",
      address: wallet,
      startblock: "0",
      endblock: "999999999",
      sort: "desc",
      page: "1",
      offset: "25",
    }),
  );

  const rows = Array.isArray(transfers?.result) ? transfers.result : [];
  const candidates = rows
    .filter((row) => row.contractAddress && isAddress(row.contractAddress) && (row.tokenID || row.tokenId))
    .slice(0, 10);

  const owned: BotaWalletFighterAsset[] = [];
  for (const row of candidates) {
    const contractAddress = row.contractAddress as Address;
    const tokenId = String(row.tokenID || row.tokenId || "0");
    try {
      const owner = await baseClient.readContract({
        address: contractAddress,
        abi: erc721Abi,
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      });
      if (String(owner).toLowerCase() !== wallet.toLowerCase()) continue;
    } catch {
      continue;
    }

    owned.push(
      buildWalletFighterAsset({
        seed: wallet,
        walletAddress: wallet,
        type: "nft",
        name: `${row.tokenName || "Base NFT"} #${tokenId}`,
        subtitle: "Owned Base NFT converted into fighter identity",
        source: "Base NFT",
        origin: "nft",
        chainId: "base",
        agentClass: "guardian",
        archetype: "liquidity_guardian",
        contractAddress,
        tokenId,
        tokenName: row.tokenName || "Base NFT",
        collectionName: row.tokenName || "Base NFT",
        title: "NFT Fighter",
        metadata: {
          scanner: "basescan-erc721-ownerOf",
          detectedOnchain: true,
        },
      }),
    );
  }

  return uniqueAssets(owned).slice(0, 6);
}

async function scanEnsAsset(wallet: Address) {
  try {
    const ensName = await ethereumClient.getEnsName({ address: wallet });
    if (!ensName) return [];
    const agentId = normalizeBotaFighterAgentId(`ens:${ensName}`);
    const ensAgentIdentity = buildBotaEnsAgentIdentity({
      agentId,
      displayName: ensName,
      ensName,
      walletAddress: wallet,
      resolvedAddress: wallet,
      avatarUrl: "/assets/ens-badge.jpg",
      rank: null,
      wins: 0,
      losses: 0,
      currentStreak: 0,
      bantCreditsEarned: 0,
      fameScore: 0,
      titles: ["ENS Mask"],
      tags: ["ens", "wallet-import"],
    });
    return [
      buildWalletFighterAsset({
        seed: wallet,
        walletAddress: wallet,
        type: "ens",
        name: ensName,
        subtitle: "ENS reverse record identity fighter",
        source: "ENS",
        origin: "ens",
        chainId: "ethereum",
        agentClass: "oracle",
        archetype: "oracle_duelist",
        ensName,
        sourceIconUrl: "/assets/ens-badge.jpg",
        title: "ENS Mask",
        metadata: {
          scanner: "viem-ens-reverse",
          detectedOnchain: true,
          ensAgentIdentity,
          ensIdentity: {
            name: ensName,
            resolvedAddress: wallet,
            avatarUrl: null,
            textRecords: {},
          },
        },
      }),
    ];
  } catch {
    return [];
  }
}

function normalizeEnsNameInput(value: string) {
  const clean = String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
  if (!clean) return "";
  return clean.includes(".") ? clean : `${clean}.eth`;
}

function isLikelyEnsName(value: string) {
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => label.length > 0 && !/\s/.test(label));
}

async function readEnsText(name: string, key: string) {
  try {
    return await (ethereumClient as any).getEnsText({ name, key });
  } catch {
    return null;
  }
}

export async function previewBotaEnsFighter(input: {
  ensName: string;
  walletAddress?: string | null;
}) {
  const ensName = normalizeEnsNameInput(input.ensName);
  if (!isLikelyEnsName(ensName)) {
    throw new Error("Enter a valid ENS name, for example vitalik.eth.");
  }

  let resolvedAddress: string | null = null;
  let avatarUrl: string | null = null;
  try {
    const address = await (ethereumClient as any).getEnsAddress({ name: ensName });
    resolvedAddress = address ? String(address) : null;
  } catch {
    resolvedAddress = null;
  }

  try {
    const avatar = await (ethereumClient as any).getEnsAvatar({ name: ensName });
    avatarUrl = typeof avatar === "string" && avatar.trim() ? avatar.trim() : null;
  } catch {
    avatarUrl = null;
  }

  const [description, url, twitter, github] = await Promise.all([
    readEnsText(ensName, "description"),
    readEnsText(ensName, "url"),
    readEnsText(ensName, "com.twitter"),
    readEnsText(ensName, "com.github"),
  ]);
  const agentId = normalizeBotaFighterAgentId(`ens:${ensName}`);
  const sourceTextRecords = {
    description,
    url,
    twitter,
    github,
  };
  const draftEnsAgentIdentity = buildBotaEnsAgentIdentity({
    agentId,
    displayName: ensName,
    ensName,
    walletAddress: input.walletAddress || resolvedAddress,
    resolvedAddress,
    avatarUrl,
    rank: null,
    wins: 0,
    losses: 0,
    currentStreak: 0,
    bantCreditsEarned: 0,
    fameScore: 0,
    titles: ["ENS Fighter"],
    tags: ["ens", "manual-preview"],
    sourceTextRecords,
  });
  const [
    publishedContext,
    publishedWebEndpoint,
    publishedBotaContextEndpoint,
    publishedBotaBattlesEndpoint,
    publishedA2AEndpoint,
    publishedMcpEndpoint,
    publishedVerification,
  ] = await Promise.all([
    readEnsText(ensName, "agent-context"),
    readEnsText(ensName, "agent-endpoint[web]"),
    readEnsText(ensName, "agent-endpoint[bota-context]"),
    readEnsText(ensName, "agent-endpoint[bota-battles]"),
    readEnsText(ensName, "agent-endpoint[a2a]"),
    readEnsText(ensName, "agent-endpoint[mcp]"),
    draftEnsAgentIdentity.registry.verificationKey
      ? readEnsText(ensName, draftEnsAgentIdentity.registry.verificationKey)
      : Promise.resolve(null),
  ]);
  const ensAgentIdentity = buildBotaEnsAgentIdentity({
    agentId,
    displayName: ensName,
    ensName,
    walletAddress: input.walletAddress || resolvedAddress,
    resolvedAddress,
    avatarUrl,
    rank: null,
    wins: 0,
    losses: 0,
    currentStreak: 0,
    bantCreditsEarned: 0,
    fameScore: 0,
    titles: ["ENS Fighter"],
    tags: ["ens", "manual-preview"],
    sourceTextRecords,
    publishedTextRecords: {
      "agent-context": publishedContext,
      "agent-endpoint[web]": publishedWebEndpoint,
      "agent-endpoint[bota-context]": publishedBotaContextEndpoint,
      "agent-endpoint[bota-battles]": publishedBotaBattlesEndpoint,
      "agent-endpoint[a2a]": publishedA2AEndpoint,
      "agent-endpoint[mcp]": publishedMcpEndpoint,
      ...(draftEnsAgentIdentity.registry.verificationKey
        ? { [draftEnsAgentIdentity.registry.verificationKey]: publishedVerification }
        : {}),
    },
  });

  const asset = buildWalletFighterAsset({
    seed: ensName,
    walletAddress: input.walletAddress || resolvedAddress,
    type: "ens",
    name: ensName,
    subtitle: resolvedAddress
      ? `ENS identity resolved to ${shortWallet(resolvedAddress)}`
      : "ENS identity preview",
    source: "ENS",
    origin: "ens",
    chainId: "ethereum",
    agentClass: "oracle",
    archetype: "oracle_duelist",
    ensName,
    externalUrl: `https://app.ens.domains/${encodeURIComponent(ensName)}`,
    sourceIconUrl: "/assets/ens-badge.jpg",
    title: "ENS Fighter",
    metadata: {
      scanner: "viem-ens-forward",
      detectedOnchain: Boolean(resolvedAddress),
      ensAgentIdentity,
      ensIdentity: {
        name: ensName,
        resolvedAddress,
        avatarUrl,
        textRecords: sourceTextRecords,
      },
    },
  });

  return {
    asset: {
      ...asset,
      avatarUrl: avatarUrl || asset.avatarUrl,
      fighter: {
        ...asset.fighter,
        displayName: ensName,
        ensName,
        walletAddress: input.walletAddress || resolvedAddress,
        avatarUrl: avatarUrl || asset.fighter.avatarUrl,
        badgeLabel: "ENS",
        externalUrl: `https://app.ens.domains/${encodeURIComponent(ensName)}`,
      },
    },
    resolution: {
      ensName,
      resolvedAddress,
      avatarUrl,
      textRecords: {
        description,
        url,
        twitter,
        github,
        "agent-context": publishedContext,
        "agent-endpoint[web]": publishedWebEndpoint,
        "agent-endpoint[bota-context]": publishedBotaContextEndpoint,
        "agent-endpoint[bota-battles]": publishedBotaBattlesEndpoint,
        "agent-endpoint[a2a]": publishedA2AEndpoint,
        "agent-endpoint[mcp]": publishedMcpEndpoint,
        ...(draftEnsAgentIdentity.registry.verificationKey
          ? { [draftEnsAgentIdentity.registry.verificationKey]: publishedVerification }
          : {}),
      },
    },
    ensAgentIdentity,
    updatedAt: new Date().toISOString(),
  };
}

async function scanRegistryAgents(input: {
  wallet: Address;
  endpoint: string;
  source: "Virtuals Protocol" | "Bankr" | "AgentKit";
  origin: BotaFighterOrigin;
}) {
  if (!input.endpoint) return [];
  const url = new URL(input.endpoint);
  url.searchParams.set("walletAddress", input.wallet);
  url.searchParams.set("owner", input.wallet);
  const response = await fetchJsonWithTimeout<unknown>(url.toString(), 8000);
  const rawAgents = Array.isArray(response)
    ? response
    : Array.isArray((response as Record<string, unknown> | null)?.agents)
      ? ((response as Record<string, unknown>).agents as unknown[])
      : Array.isArray((response as Record<string, unknown> | null)?.data)
        ? ((response as Record<string, unknown>).data as unknown[])
        : [];

  return rawAgents.slice(0, 8).map((raw, index) => {
    const agent = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const name = String(agent.name || agent.displayName || agent.agentName || `${input.source} Agent ${index + 1}`);
    const id = String(agent.id || agent.agentId || agent.address || name);
    const image = typeof agent.image === "string"
      ? agent.image
      : typeof agent.avatarUrl === "string"
        ? agent.avatarUrl
        : null;
    const externalUrl = typeof agent.url === "string"
      ? agent.url
      : typeof agent.externalUrl === "string"
        ? agent.externalUrl
        : null;

    return buildWalletFighterAsset({
      seed: input.wallet,
      walletAddress: input.wallet,
      type: "ai-agent",
      name,
      subtitle: `${input.source} agent detected from registry`,
      source: input.source,
      origin: input.origin,
      chainId: "base",
      agentClass: input.origin === "virtuals" || input.origin === "bankr" ? "oracle" : "scout",
      archetype: input.origin === "virtuals" || input.origin === "bankr" ? "oracle_duelist" : "momentum_scout",
      contractAddress: isAddress(id) ? id : null,
      externalUrl,
      sourceIconUrl: image,
      brain: "external",
      title: input.origin === "virtuals" ? "Virtuals Import" : input.origin === "bankr" ? "Bankr Import" : "Wallet Operator",
      metadata: {
        scanner: input.origin === "virtuals" ? "virtuals-registry" : input.origin === "bankr" ? "bankr-registry" : "agentkit-registry",
        detectedOnchain: true,
        registryAgent: agent,
      },
    });
  });
}

export async function scanBotaWalletFighterAssets(walletAddress?: string | null) {
  const wallet = String(walletAddress || "").trim() || null;
  const scannerNotes: string[] = [];
  let assets: BotaWalletFighterAsset[] = [];

  if (validWallet(wallet)) {
    const [alchemyAssets, moralisAssets, baseTokens, baseNfts, ensAssets, virtualsAgents, bankrAgents, agentKitAgents] = await Promise.all([
      scanAlchemyWalletAssets(wallet),
      scanMoralisWalletAssets(wallet),
      scanBaseErc20Assets(wallet),
      scanBaseNftAssets(wallet),
      scanEnsAsset(wallet),
      scanRegistryAgents({
        wallet,
        endpoint: VIRTUALS_AGENT_REGISTRY_URL,
        source: "Virtuals Protocol",
        origin: "virtuals",
      }),
      Promise.resolve([]),
      scanRegistryAgents({
        wallet,
        endpoint: AGENTKIT_AGENT_REGISTRY_URL,
        source: "AgentKit",
        origin: "agentkit",
      }),
    ]);

    assets = uniqueAssets([
      ...virtualsAgents,
      ...bankrAgents,
      ...agentKitAgents,
      ...ensAssets,
      ...alchemyAssets,
      ...moralisAssets,
      ...baseNfts,
      ...baseTokens,
    ]);

    const alchemyNfts = alchemyAssets.filter((asset) => asset.type === "nft").length;
    const alchemyTokens = alchemyAssets.filter((asset) => asset.type === "token").length;
    const moralisNfts = moralisAssets.filter((asset) => asset.type === "nft").length;
    const moralisTokens = moralisAssets.filter((asset) => asset.type === "token").length;
    if (alchemyAssets.length) scannerNotes.push(`${alchemyTokens} Alchemy token${alchemyTokens === 1 ? "" : "s"} / ${alchemyNfts} NFT${alchemyNfts === 1 ? "" : "s"}`);
    if (moralisAssets.length) scannerNotes.push(`${moralisTokens} Moralis token${moralisTokens === 1 ? "" : "s"} / ${moralisNfts} NFT${moralisNfts === 1 ? "" : "s"}`);
    if (baseTokens.length) scannerNotes.push(`${baseTokens.length} Base token${baseTokens.length === 1 ? "" : "s"}`);
    if (baseNfts.length) scannerNotes.push(`${baseNfts.length} Base NFT${baseNfts.length === 1 ? "" : "s"}`);
    if (ensAssets.length) scannerNotes.push("ENS reverse record");
    if (virtualsAgents.length) scannerNotes.push(`${virtualsAgents.length} Virtuals agent${virtualsAgents.length === 1 ? "" : "s"}`);
    if (bankrAgents.length) scannerNotes.push(`${bankrAgents.length} Bankr agent${bankrAgents.length === 1 ? "" : "s"}`);
    if (agentKitAgents.length) scannerNotes.push(`${agentKitAgents.length} AgentKit agent${agentKitAgents.length === 1 ? "" : "s"}`);
  }

  const realAssetCount = assets.length;

  const counts = assets.reduce(
    (current, asset) => ({
      ...current,
      [asset.type]: (current[asset.type] || 0) + 1,
    }),
    {} as Record<BotaWalletAssetType, number>,
  );

  return {
    walletAddress: wallet,
    displayWallet: wallet ? shortWallet(wallet) : "Connect wallet",
    assets,
    counts,
    scanner: {
      mode: realAssetCount > 0 ? "real-wallet-scan" : wallet ? "no-assets-detected" : "idle",
      providers: {
        alchemy: WALLET_INDEXER_CHAINS.some((chain) => chain.alchemyHost && alchemyApiKeyForChain(chain)),
        moralis: Boolean(providerKey(MORALIS_WALLET_API_KEY)),
        basescan: Boolean(BASESCAN_API_KEY),
        registry: Boolean(VIRTUALS_AGENT_REGISTRY_URL || AGENTKIT_AGENT_REGISTRY_URL),
      },
      note: realAssetCount > 0
        ? `Detected ${scannerNotes.join(", ")}. Assets are normalized into BOTA fighter candidates.`
        : wallet
          ? "No owned assets were detected from the enabled live scanners for this wallet."
          : "Connect or enter a wallet to scan owned assets.",
    },
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeBotaFighterAgentId(value: string) {
  return String(value || "bota-agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180) || "bota-agent";
}

function symbolForSide(side: BantahBroAgentBattleSide) {
  return (side.tokenSymbol || side.label || "BOTA").replace(/^\$/, "").trim() || "BOTA";
}

function originForSide(side: BantahBroAgentBattleSide): BotaFighterOrigin {
  if (side.dataSource === "ens-subgraph") return "ens";
  if (side.dataSource === "fighter-profile") {
    const idParts = String(side.id || "").split(":");
    const prefix = (idParts[0] === "external" ? idParts[1] : idParts[0]) as BotaFighterOrigin;
    if (
      [
        "bota",
        "eliza",
        "virtuals",
        "bankr",
        "game-sdk",
        "agentkit",
        "ens",
        "nft",
        "token",
        "manual",
      ].includes(prefix)
    ) {
      return prefix;
    }
    return "bota";
  }
  const haystack = [side.chainLabel, side.chainId, side.label, side.tokenName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (haystack.includes("ens")) return "ens";
  return "dexscreener";
}

function archetypeForSide(side: BantahBroAgentBattleSide): BotaArenaFighter["archetype"] {
  if (side.liquidityUsd && side.liquidityUsd > 750_000) return "liquidity_guardian";
  if (Math.abs(side.priceChangeH24 || 0) >= 100) return "chaos_berserker";
  if ((side.buysH24 || 0) + (side.sellsH24 || 0) > 5_000) return "momentum_scout";
  if (originForSide(side) === "ens") return "oracle_duelist";
  return "signal_striker";
}

function classForArchetype(archetype: BotaArenaFighter["archetype"]): BotaFighterClass {
  if (archetype === "liquidity_guardian") return "guardian";
  if (archetype === "momentum_scout") return "scout";
  if (archetype === "oracle_duelist") return "oracle";
  if (archetype === "chaos_berserker") return "berserker";
  return "striker";
}

function leagueForScore(score: number) {
  if (score >= 90) return "Elite League";
  if (score >= 75) return "Pro League";
  if (score >= 55) return "Open League";
  return "Qualifier League";
}

function titleForSide(side: BantahBroAgentBattleSide, battle: BantahBroAgentBattle) {
  if (battle.leadingSideId === side.id) return "Current Leader";
  if (side.confidence >= 60) return "Crowd Favorite";
  if (side.priceChangeH24 >= 100) return "Momentum Breaker";
  if ((side.liquidityUsd || 0) >= 750_000) return "Liquidity Wall";
  return "Arena Contender";
}

function fameScoreForSide(side: BantahBroAgentBattleSide, battle: BantahBroAgentBattle) {
  const confidence = clamp(side.confidence || 50, 0, 100);
  const score = clamp(side.score || 0, 0, 150);
  const volume = Math.log10(Math.max(1, side.volumeH24 || 0)) * 9;
  const liquidity = Math.log10(Math.max(1, side.liquidityUsd || 0)) * 5;
  const spectators = Math.log10(Math.max(1, battle.spectators || 0)) * 6;
  const leaderBonus = battle.leadingSideId === side.id ? 8 : 0;
  return clamp(confidence * 0.32 + score * 0.28 + volume + liquidity + spectators + leaderBonus, 1, 100);
}

function profileFromBattleSide(
  battle: BantahBroAgentBattle,
  side: BantahBroAgentBattleSide,
) {
  const origin = originForSide(side);
  const symbol = symbolForSide(side);
  const archetype = archetypeForSide(side);
  const fameScore = fameScoreForSide(side, battle);
  const rank = Math.max(1, Math.round(101 - clamp(side.score || fameScore, 1, 100)));
  const title = titleForSide(side, battle);
  const agentId =
    side.dataSource === "fighter-profile" || side.dataSource === "ens-subgraph"
      ? normalizeBotaFighterAgentId(side.id)
      : normalizeBotaFighterAgentId(`${origin}:${side.id}`);
  const sourceIconUrl = origin === "ens"
    ? "/assets/ens-badge.jpg"
    : isExternalAgentOrigin(origin)
      ? sourceLogoForFighter({ origin, source: side.chainLabel || side.dataSource })
      : side.logoUrl;
  const sourceHint = origin === "ens" ? "ens-subgraph" : side.dataSource;
  const importSource =
    origin === "ens" ? "ens-subgraph" : side.dataSource === "fighter-profile" ? "fighter-profile" : "meme-token";
  const agentIdentity = buildFighterIdentityMetadata({
    origin,
    assetType: origin === "ens" ? "ens" : origin === "nft" ? "nft" : "token",
    source: importSource,
    sourceIconUrl,
    brain: isExternalAgentOrigin(origin) ? "external" : "elizaos-default",
  });

  return {
    agentId,
    displayName: side.agentName || `${symbol} Agent`,
    origin,
    originId: side.id,
    agentClass: classForArchetype(archetype),
    archetype,
    league: leagueForScore(side.score || fameScore),
    rank,
    avatarUrl: normalizeStoredAvatarUrl(side.logoUrl, `${origin}:${side.id}:${side.agentName || side.label || symbol}`),
    badgeLabel: side.chainLabel ? `${side.chainLabel} League` : "BOTA League",
    ensName: origin === "ens" ? side.tokenName || null : null,
    walletAddress: side.tokenAddress,
    externalUrl: side.pairUrl,
    tokenSymbol: side.tokenSymbol || symbol,
    tokenName: side.tokenName,
    chainId: side.chainId,
    fameScore: fameScore.toFixed(2),
    watchers: Math.max(0, Math.round(battle.spectators || 0)),
    challengeVolume: Math.max(0, Math.round((side.buysH24 || 0) + (side.sellsH24 || 0))),
    titles: [title],
    tags: [
      origin,
      classForArchetype(archetype),
      side.chainLabel || side.chainId || "arena",
    ].filter(Boolean).slice(0, 6),
    lastBattleId: battle.id,
    metadata: {
      sourceIconUrl,
      originIconUrl: sourceIconUrl,
      sourceHint,
      importSource,
      agentIdentity,
      logoBadge: {
        label: agentIdentity.label,
        imageUrl: agentIdentity.sourceLogoUrl,
      },
      token: {
        logoUrl: side.logoUrl,
        symbol: side.tokenSymbol || symbol,
        name: side.tokenName,
      },
      ens: origin === "ens"
        ? {
            name: side.tokenName || side.agentName,
            owner: side.tokenAddress,
            source: side.dataSource === "ens-subgraph" ? "ENS Subgraph" : "Imported ENS Fighter",
          }
        : null,
      liveBattle: {
        id: battle.id,
        title: battle.title,
        status: battle.status,
        leadingSideId: battle.leadingSideId,
        confidenceSpread: battle.confidenceSpread,
      },
      market: {
        confidence: side.confidence,
        score: side.score,
        priceChangeM5: side.priceChangeM5,
        priceChangeH1: side.priceChangeH1,
        priceChangeH24: side.priceChangeH24,
        volumeH24: side.volumeH24,
        liquidityUsd: side.liquidityUsd,
      },
    },
  };
}

export function getBotaFighterAgentIdForBattleSide(side: BantahBroAgentBattleSide) {
  if (side.dataSource === "fighter-profile" || side.dataSource === "ens-subgraph") {
    return normalizeBotaFighterAgentId(side.id);
  }
  return normalizeBotaFighterAgentId(`${originForSide(side)}:${side.id}`);
}

function normalizeProfileRecord(row: BotaFighterProfileRecord): BotaFighterProfile {
  const baseMetadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  const agentIdentity = inferFighterIdentityMetadata({
    origin: row.origin as BotaFighterOrigin,
    metadata: baseMetadata,
    badgeLabel: row.badgeLabel || row.tokenName || row.displayName,
  });
  const existingEnsIdentity =
    baseMetadata.ensIdentity && typeof baseMetadata.ensIdentity === "object" && !Array.isArray(baseMetadata.ensIdentity)
      ? (baseMetadata.ensIdentity as Record<string, unknown>)
      : {};
  const existingEnsTextRecords =
    existingEnsIdentity.textRecords &&
    typeof existingEnsIdentity.textRecords === "object" &&
    !Array.isArray(existingEnsIdentity.textRecords)
      ? (existingEnsIdentity.textRecords as Record<string, string | null | undefined>)
      : {};
  const existingEnsAgentIdentity =
    baseMetadata.ensAgentIdentity &&
    typeof baseMetadata.ensAgentIdentity === "object" &&
    !Array.isArray(baseMetadata.ensAgentIdentity)
      ? (baseMetadata.ensAgentIdentity as { published?: Record<string, string | null | undefined> })
      : {};
  const ensAgentIdentity = row.origin === "ens" || row.ensName
    ? buildBotaEnsAgentIdentity({
        agentId: row.agentId,
        displayName: row.displayName,
        ensName: row.ensName || row.originId || row.displayName,
        walletAddress: row.walletAddress,
        resolvedAddress:
          typeof existingEnsIdentity.resolvedAddress === "string"
            ? existingEnsIdentity.resolvedAddress
            : row.walletAddress,
        avatarUrl:
          typeof existingEnsIdentity.avatarUrl === "string"
            ? existingEnsIdentity.avatarUrl
            : row.avatarUrl,
        rank: row.rank,
        wins: row.wins,
        losses: row.losses,
        currentStreak: row.currentStreak,
        bantCreditsEarned: toNumber(row.bantCreditsEarned),
        fameScore: toNumber(row.fameScore),
        titles: Array.isArray(row.titles) ? row.titles : [],
        tags: Array.isArray(row.tags) ? row.tags : [],
        sourceTextRecords: existingEnsTextRecords,
        publishedTextRecords: existingEnsAgentIdentity.published || {},
      })
    : null;
  const bnbAgentIdentity = buildBotaBnbAgentIdentity({
    agentId: row.agentId,
    displayName: row.displayName,
    origin: row.origin as BotaFighterOrigin,
    originId: row.originId,
    ownerAddress: row.walletAddress,
    avatarUrl: row.avatarUrl,
    rank: row.rank,
    wins: row.wins,
    losses: row.losses,
    currentStreak: row.currentStreak,
    bantCreditsEarned: toNumber(row.bantCreditsEarned),
    fameScore: toNumber(row.fameScore),
    titles: Array.isArray(row.titles) ? row.titles : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    externalUrl: row.externalUrl,
    tokenSymbol: row.tokenSymbol,
    tokenName: row.tokenName,
    sourceLabel:
      typeof agentIdentity.sourceLabel === "string"
        ? agentIdentity.sourceLabel
        : typeof agentIdentity.label === "string"
          ? agentIdentity.label
          : null,
  });
  const metadata = {
    ...baseMetadata,
    ...(ensAgentIdentity ? { ensAgentIdentity } : {}),
    bnbAgentIdentity,
    agentIdentity,
    logoBadge: {
      label: String(agentIdentity.label || "Fighter"),
      imageUrl: String(agentIdentity.sourceLogoUrl || GENERATED_FIGHTER_IDENTITY_LOGO),
    },
  };

  return botaFighterProfileSchema.parse({
    agentId: row.agentId,
    displayName: row.displayName,
    origin: row.origin,
    originId: row.originId,
    agentClass: row.agentClass,
    archetype: row.archetype,
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
    fameScore: toNumber(row.fameScore),
    watchers: row.watchers,
    challengeVolume: row.challengeVolume,
    bantCreditsEarned: toNumber(row.bantCreditsEarned),
    liveSpectators: 0,
    titles: Array.isArray(row.titles) ? row.titles : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    lastBattleId: row.lastBattleId,
    metadata,
    importedAt: toIso(row.importedAt),
    lastSeenAt: toIso(row.lastSeenAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  });
}

async function getStoredBotaFighterProfile(agentId: string) {
  const [row] = await db
    .select()
    .from(botaFighterProfiles)
    .where(eq(botaFighterProfiles.agentId, normalizeBotaFighterAgentId(agentId)))
    .limit(1);

  return row ? normalizeProfileRecord(row) : null;
}

export async function ensureBotaFighterProfilesTable() {
  if (!ensureProfilesTablePromise) {
    ensureProfilesTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bota_fighter_profiles" (
        "agent_id" varchar(180) PRIMARY KEY NOT NULL,
        "display_name" varchar(120) NOT NULL,
        "origin" varchar(32) NOT NULL DEFAULT 'bota',
        "origin_id" varchar(180),
        "agent_class" varchar(40) NOT NULL DEFAULT 'striker',
        "archetype" varchar(40) NOT NULL DEFAULT 'signal_striker',
        "league" varchar(80) NOT NULL DEFAULT 'Open League',
        "rank" integer,
        "avatar_url" text,
        "badge_label" varchar(80),
        "ens_name" varchar(160),
        "wallet_address" varchar(128),
        "external_url" text,
        "token_symbol" varchar(64),
        "token_name" varchar(160),
        "chain_id" varchar(64),
        "wins" integer NOT NULL DEFAULT 0,
        "losses" integer NOT NULL DEFAULT 0,
        "current_streak" integer NOT NULL DEFAULT 0,
        "fame_score" numeric(12, 2) NOT NULL DEFAULT 0,
        "watchers" integer NOT NULL DEFAULT 0,
        "challenge_volume" integer NOT NULL DEFAULT 0,
        "titles" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "last_battle_id" varchar(255),
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "imported_at" timestamp DEFAULT now(),
        "last_seen_at" timestamp DEFAULT now(),
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_bota_fighter_profiles_origin"
        ON "bota_fighter_profiles" ("origin");
      CREATE INDEX IF NOT EXISTS "idx_bota_fighter_profiles_rank"
        ON "bota_fighter_profiles" ("rank");
      CREATE INDEX IF NOT EXISTS "idx_bota_fighter_profiles_fame_score"
        ON "bota_fighter_profiles" ("fame_score");
      CREATE INDEX IF NOT EXISTS "idx_bota_fighter_profiles_last_seen_at"
        ON "bota_fighter_profiles" ("last_seen_at");
    `).then(() => undefined).catch((error) => {
      ensureProfilesTablePromise = null;
      throw error;
    });
  }
  return ensureProfilesTablePromise;
}

export async function recalculateBotaFighterLeaderboardRanks() {
  await ensureBotaFighterProfilesTable();
  const beforeRows = await db
    .select({
      agentId: botaFighterProfiles.agentId,
      rank: botaFighterProfiles.rank,
    })
    .from(botaFighterProfiles);
  const previousRankByAgentId = new Map(
    beforeRows.map((row) => [row.agentId, row.rank ?? null]),
  );

  await db.execute(sql`
    WITH ranked AS (
      SELECT
        "agent_id",
        ROW_NUMBER() OVER (
          ORDER BY
            "fame_score" DESC,
            "wins" DESC,
            "current_streak" DESC,
            "challenge_volume" DESC,
            "display_name" ASC
        )::int AS "next_rank"
      FROM "bota_fighter_profiles"
    )
    UPDATE "bota_fighter_profiles" AS profile
    SET
      "rank" = ranked."next_rank",
      "updated_at" = CASE
        WHEN profile."rank" IS DISTINCT FROM ranked."next_rank" THEN now()
        ELSE profile."updated_at"
      END
    FROM ranked
    WHERE profile."agent_id" = ranked."agent_id";
  `);

  const afterRows = await db
    .select()
    .from(botaFighterProfiles)
    .orderBy(asc(botaFighterProfiles.rank));

  return afterRows
    .map((row) => {
      const profile = normalizeProfileRecord(row);
      const previousRank = previousRankByAgentId.get(profile.agentId) ?? null;
      const nextRank = profile.rank ?? null;
      return {
        profile,
        previousRank,
        nextRank,
      };
    })
    .filter((change) => change.previousRank !== change.nextRank);
}

async function upsertProfileSeed(profile: ReturnType<typeof profileFromBattleSide>) {
  const now = new Date();
  await db
    .insert(botaFighterProfiles)
    .values({
      ...profile,
      lastSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: botaFighterProfiles.agentId,
      set: {
        displayName: profile.displayName,
        origin: profile.origin,
        originId: profile.originId,
        agentClass: profile.agentClass,
        archetype: profile.archetype,
        league: profile.league,
        rank: profile.rank,
        avatarUrl: profile.avatarUrl,
        badgeLabel: profile.badgeLabel,
        ensName: profile.ensName,
        walletAddress: profile.walletAddress,
        externalUrl: profile.externalUrl,
        tokenSymbol: profile.tokenSymbol,
        tokenName: profile.tokenName,
        chainId: profile.chainId,
        fameScore: profile.fameScore,
        watchers: profile.watchers,
        challengeVolume: profile.challengeVolume,
        titles: profile.titles,
        tags: profile.tags,
        lastBattleId: profile.lastBattleId,
        metadata: profile.metadata,
        lastSeenAt: now,
        updatedAt: now,
      },
    });
}

export async function syncBotaFighterProfilesFromLiveBattles(limit = 40) {
  const feed = await getLiveBantahBroAgentBattles(Math.max(1, Math.min(Math.round(limit || 40), 50)));
  const profileSeeds = feed.battles.flatMap((battle) =>
    battle.sides.map((side) => profileFromBattleSide(battle, side)),
  );
  const seen = new Set<string>();
  const uniqueSeeds = profileSeeds.filter((seed) => {
    if (seen.has(seed.agentId)) return false;
    seen.add(seed.agentId);
    return true;
  });

  let useDatabase = true;
  try {
    await ensureBotaFighterProfilesTable();
  } catch (error) {
    useDatabase = false;
    warnFighterProfileFallback("live sync", error);
  }

  for (const profile of uniqueSeeds) {
    if (useDatabase) {
      try {
        await upsertProfileSeed(profile);
        continue;
      } catch (error) {
        useDatabase = false;
        warnFighterProfileFallback("live profile upsert", error);
      }
    }
    upsertMemoryFighterProfile(profile);
  }

  return {
    synced: uniqueSeeds.length,
    battleCount: feed.battles.length,
    updatedAt: new Date().toISOString(),
  };
}

function profileCatalogKey(profile: BotaFighterProfile) {
  return String(profile.agentId || profile.originId || profile.ensName || profile.displayName)
    .trim()
    .toLowerCase();
}

function isGeneratedExternalCatalogProfile(profile: BotaFighterProfile) {
  const metadata = profile.metadata || {};
  if (profile.origin === "bota" && String(profile.agentId || "").startsWith("external:")) {
    return true;
  }
  return Boolean(
    metadata.sourceCatalog &&
      (metadata.catalogSeed === true || !metadata.registryAgent),
  );
}

function mergeFighterProfiles(primary: BotaFighterProfile[], secondary: BotaFighterProfile[], limit: number) {
  const seen = new Set<string>();
  return [...primary, ...secondary]
    .filter((profile) => {
      if (isGeneratedExternalCatalogProfile(profile)) return false;
      const key = profileCatalogKey(profile);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => {
      const fameDelta = right.fameScore - left.fameScore;
      if (fameDelta) return fameDelta;
      return (left.rank || 9999) - (right.rank || 9999);
    })
    .slice(0, limit);
}

type BotaFighterArenaRecordStats = {
  wins: number;
  losses: number;
  matches: number;
  spectators: number;
  rounds: number;
  bantCreditsEarned: number;
  simRewardBantCredits: number;
  spectatorBantCredits: number;
  currentStreak: number;
  lastBattleId: string | null;
  latestRecordId: string | null;
  latestResult: "win" | "loss" | "draw" | null;
  latestBattleAt: string | null;
};

type BotaArenaRecordRewardRow = {
  record_id: string;
  fighter_bantcredits: string | number;
  spectator_bantcredits: string | number;
  spectator_count: string | number;
};

function rowsOf<T = any>(result: any): T[] {
  return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
}

function sqlTextArray(values: string[]) {
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

function newArenaRecordStats(): BotaFighterArenaRecordStats {
  return {
    wins: 0,
    losses: 0,
    matches: 0,
    spectators: 0,
    rounds: 0,
    bantCreditsEarned: 0,
    simRewardBantCredits: 0,
    spectatorBantCredits: 0,
    currentStreak: 0,
    lastBattleId: null,
    latestRecordId: null,
    latestResult: null,
    latestBattleAt: null,
  };
}

function profilePositiveNumber(profile: BotaFighterProfile, key: string) {
  const metadata = profile.metadata || {};
  const liveStats =
    metadata.liveStats && typeof metadata.liveStats === "object" && !Array.isArray(metadata.liveStats)
      ? (metadata.liveStats as Record<string, unknown>)
      : {};
  return Math.max(
    0,
    Math.round(
      Math.max(
        Number((profile as unknown as Record<string, unknown>)[key]) || 0,
        Number(metadata[key]) || 0,
        Number(liveStats[key]) || 0,
      ),
    ),
  );
}

function positiveRecordNumber(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric);
}

function recordIso(value: Date | string | null | undefined) {
  return toIso(value) || new Date().toISOString();
}

function recordParticipantIds(record: BotaArenaBattleRecordRow) {
  const ids = new Set<string>();
  if (record.winnerAgentId) ids.add(normalizeBotaFighterAgentId(record.winnerAgentId));
  if (record.loserAgentId) ids.add(normalizeBotaFighterAgentId(record.loserAgentId));
  for (const fighter of Array.isArray(record.fighters) ? record.fighters : []) {
    const rawId = typeof fighter?.id === "string" ? fighter.id : typeof fighter?.sourceAgentId === "string" ? fighter.sourceAgentId : "";
    if (rawId) ids.add(normalizeBotaFighterAgentId(rawId));
  }
  return Array.from(ids);
}

async function loadRewardStatsByArenaRecordId(records: BotaArenaBattleRecordRow[]) {
  const recordIds = Array.from(new Set(records.map((record) => String(record.id || "").trim()).filter(Boolean)));
  if (!recordIds.length) return new Map<string, BotaArenaRecordRewardRow>();
  const recordIdArray = sqlTextArray(recordIds);

  try {
    const result = await db.execute(sql`
      SELECT
        b."id"::text AS "record_id",
        COALESCE(SUM(c."amount") FILTER (
          WHERE c."role" IN ('ENS_OWNER', 'EXTERNAL_AGENT_OWNER', 'FIGHTER_OWNER', 'BONUS')
        ), 0) AS "fighter_bantcredits",
        COALESCE(SUM(c."amount") FILTER (WHERE c."role" = 'SPECTATOR'), 0) AS "spectator_bantcredits",
        COUNT(DISTINCT c."account") FILTER (WHERE c."role" = 'SPECTATOR') AS "spectator_count"
      FROM "bota_arena_battle_records" b
      LEFT JOIN "onchain_sim_battle_reward_claims" c
        ON (
          c."battle_id" = b."battle_id"
          OR c."record_id" = b."id"::text
        )
        AND c."status" IN ('draft', 'claimable', 'claimed')
      WHERE b."id" = ANY(${recordIdArray}::uuid[])
      GROUP BY b."id"
    `);
    return new Map(
      rowsOf<BotaArenaRecordRewardRow>(result).map((row) => [String(row.record_id), row]),
    );
  } catch (error) {
    warnFighterProfileFallback("arena reward stats", error);
    return new Map<string, BotaArenaRecordRewardRow>();
  }
}

async function loadArenaRecordStatsForProfiles(profiles: BotaFighterProfile[]) {
  const requestedIds = new Set(profiles.map((profile) => normalizeBotaFighterAgentId(profile.agentId)));
  const statsByAgentId = new Map<string, BotaFighterArenaRecordStats>();
  if (!requestedIds.size) return statsByAgentId;

  let records: BotaArenaBattleRecordRow[] = [];
  try {
    const sqlIds = Array.from(requestedIds);
    const partialRecords = await db
      .select({
        id: botaArenaBattleRecords.id,
        battleId: botaArenaBattleRecords.battleId,
        status: botaArenaBattleRecords.status,
        winnerAgentId: botaArenaBattleRecords.winnerAgentId,
        loserAgentId: botaArenaBattleRecords.loserAgentId,
        fighters: botaArenaBattleRecords.fighters,
        spectators: botaArenaBattleRecords.spectators,
        rounds: botaArenaBattleRecords.rounds,
        resolvedAt: botaArenaBattleRecords.resolvedAt,
        endedAt: botaArenaBattleRecords.endedAt,
        updatedAt: botaArenaBattleRecords.updatedAt,
        createdAt: botaArenaBattleRecords.createdAt,
      })
      .from(botaArenaBattleRecords)
      .orderBy(asc(botaArenaBattleRecords.createdAt))
      .limit(5000);
    
    records = partialRecords as unknown as BotaArenaBattleRecordRow[];
  } catch (error) {
    warnFighterProfileFallback("arena record stats", error);
    return statsByAgentId;
  }

  const relevantRecords = records.filter((record) =>
    recordParticipantIds(record).some((agentId) => requestedIds.has(agentId)),
  );
  const rewardsByRecordId = await loadRewardStatsByArenaRecordId(relevantRecords);

  for (const record of relevantRecords) {
    const winnerId = record.winnerAgentId ? normalizeBotaFighterAgentId(record.winnerAgentId) : null;
    const loserId = record.loserAgentId ? normalizeBotaFighterAgentId(record.loserAgentId) : null;
    const participantIds = recordParticipantIds(record).filter((agentId) => requestedIds.has(agentId));
    const rewardStats = rewardsByRecordId.get(String(record.id));
    const fighterBantCredits = positiveRecordNumber(rewardStats?.fighter_bantcredits);
    const spectatorBantCredits = positiveRecordNumber(rewardStats?.spectator_bantcredits);
    const spectatorCount = positiveRecordNumber(rewardStats?.spectator_count);
    const spectators = Math.max(positiveRecordNumber(record.spectators), spectatorCount);
    const rounds = positiveRecordNumber(record.rounds);
    const latestAt = recordIso(record.resolvedAt || record.endedAt || record.updatedAt || record.createdAt);

    for (const agentId of participantIds) {
      const current = statsByAgentId.get(agentId) || newArenaRecordStats();
      const result = winnerId === agentId ? "win" : loserId === agentId ? "loss" : record.status === "draw" ? "draw" : null;
      current.matches += 1;
      current.rounds += rounds;
      current.spectators += spectators;
      current.spectatorBantCredits += spectatorBantCredits;
      current.lastBattleId = record.battleId;
      current.latestRecordId = String(record.id);
      current.latestResult = result;
      current.latestBattleAt = latestAt;

      if (result === "win") {
        current.wins += 1;
        current.currentStreak = Math.max(0, current.currentStreak) + 1;
        current.bantCreditsEarned += fighterBantCredits;
        current.simRewardBantCredits += fighterBantCredits;
      } else if (result === "loss") {
        current.losses += 1;
        current.currentStreak = Math.min(0, current.currentStreak) - 1;
      } else if (result === "draw") {
        current.currentStreak = 0;
      }

      statsByAgentId.set(agentId, current);
    }
  }

  return statsByAgentId;
}

function arenaRecordFameScore(profile: BotaFighterProfile, stats: BotaFighterArenaRecordStats) {
  if (stats.matches <= 0) return 0;
  const historyScore =
    50 +
    stats.wins * 12 +
    stats.losses * 3 +
    stats.matches * 2 +
    Math.max(0, stats.currentStreak) * 4 +
    Math.min(30, Math.floor(stats.bantCreditsEarned / 10)) +
    Math.min(20, Math.floor(stats.spectators / 5));
  return Math.round(historyScore);
}

async function attachBotaFighterArenaRecordStats<T extends BotaFighterProfile>(
  profiles: T[],
  options: { assignRanks?: boolean; limit?: number } = {},
): Promise<T[]> {
  const statsByAgentId = await loadArenaRecordStatsForProfiles(profiles);
  const withStats = profiles.map((profile) => {
    const agentId = normalizeBotaFighterAgentId(profile.agentId);
    const stats = statsByAgentId.get(agentId);
    if (!stats) {
      const recordedMatches = Math.max(0, profile.wins + profile.losses);
      return {
        ...profile,
        fameScore: recordedMatches > 0 ? profile.fameScore : 0,
        challengeVolume: recordedMatches,
      };
    }
    const bantCreditsEarned = Math.max(
      profilePositiveNumber(profile, "bantCreditsEarned"),
      stats.bantCreditsEarned,
    );
    const liveSpectators = Math.max(
      profilePositiveNumber(profile, "liveSpectators"),
      stats.spectators,
    );
    const metadataLiveStats =
      profile.metadata?.liveStats && typeof profile.metadata.liveStats === "object" && !Array.isArray(profile.metadata.liveStats)
        ? (profile.metadata.liveStats as Record<string, unknown>)
        : {};
    const profileLiveStats = profile.liveStats || {};
    const metadata = {
      ...profile.metadata,
      bantCreditsEarned,
      liveSpectators,
      arenaRecordStats: {
        wins: stats.wins,
        losses: stats.losses,
        matches: stats.matches,
        rounds: stats.rounds,
        spectators: stats.spectators,
        bantCreditsEarned: stats.bantCreditsEarned,
        simRewardBantCredits: stats.simRewardBantCredits,
        spectatorBantCredits: stats.spectatorBantCredits,
        latestResult: stats.latestResult,
        latestRecordId: stats.latestRecordId,
        latestBattleAt: stats.latestBattleAt,
      },
      latestArenaResult: stats.latestResult
        ? {
            result: stats.latestResult,
            recordId: stats.latestRecordId,
            battleId: stats.lastBattleId,
            at: stats.latestBattleAt,
          }
        : profile.metadata?.latestArenaResult,
    };
    const liveStats =
      profile.liveStats || Object.keys(metadataLiveStats).length
        ? {
            ...metadataLiveStats,
            ...profileLiveStats,
            bantCreditsEarned,
            simRewardBantCredits: Math.max(
              positiveRecordNumber(profile.liveStats?.simRewardBantCredits),
              stats.simRewardBantCredits,
            ),
            liveSpectators,
            updatedAt: new Date().toISOString(),
          }
        : undefined;

    return {
      ...profile,
      wins: stats.wins,
      losses: stats.losses,
      currentStreak: stats.currentStreak,
      challengeVolume: stats.matches,
      watchers: stats.spectators,
      fameScore: arenaRecordFameScore(profile, stats),
      bantCreditsEarned,
      liveSpectators,
      liveStats: liveStats as T["liveStats"],
      lastBattleId: stats.lastBattleId || profile.lastBattleId,
      metadata: {
        ...metadata,
        liveStats,
      },
    };
  });

  if (!options.assignRanks) return withStats as T[];
  return withStats
    .sort((left, right) =>
      right.fameScore - left.fameScore ||
      right.wins - left.wins ||
      right.bantCreditsEarned - left.bantCreditsEarned ||
      right.challengeVolume - left.challengeVolume ||
      String(left.displayName).localeCompare(String(right.displayName)),
    )
    .slice(0, options.limit || withStats.length)
    .map((profile, index) => ({
      ...profile,
      rank: index + 1,
    })) as T[];
}

export async function listBotaFighterCommunityStats(input: {
  maxProfiles?: number;
  maxRecords?: number;
} = {}) {
  const maxProfiles = Math.max(100, Math.min(Math.round(input.maxProfiles || 10000), 50000));
  const maxRecords = Math.max(100, Math.min(Math.round(input.maxRecords || 10000), 50000));
  const statsByKey = new Map<BotaCommunityKey, BotaCommunityStats>(
    BOTA_COMMUNITY_DEFS.map((definition) => [definition.key, newCommunityStats(definition)]),
  );
  const profileCommunityByAgentId = new Map<string, BotaCommunityKey>();
  let profileSource: "database" | "memory" = "database";
  let recordSource: "database" | "unavailable" = "database";
  let warning: string | undefined;

  let profiles: BotaFighterProfile[] = [];
  try {
    await withCommunityStatsTimeout(ensureBotaFighterProfilesTable(), "community profile table check");
    const rows = await withCommunityStatsTimeout(
      Promise.resolve(
        db
          .select()
          .from(botaFighterProfiles)
          .orderBy(desc(botaFighterProfiles.fameScore), asc(botaFighterProfiles.rank))
          .limit(maxProfiles),
      ),
      "community profile query",
    );
    profiles = rows.map(normalizeProfileRecord);
  } catch (error) {
    profileSource = "memory";
    warning = "Fighter profile database unavailable; using in-memory profile cache.";
    warnFighterProfileFallback("community profile stats", error);
    profiles = Array.from(memoryFighterProfiles.values()).slice(0, maxProfiles);
  }

  for (const profile of profiles) {
    const key = botaCommunityKeyForProfile(profile);
    profileCommunityByAgentId.set(normalizeBotaFighterAgentId(profile.agentId), key);
    addProfileToCommunityStats(statsByKey.get("all")!, profile);
    addProfileToCommunityStats(statsByKey.get(key)!, profile);
  }

  try {
    const records = await withCommunityStatsTimeout(
      Promise.resolve(
        db
          .select()
          .from(botaArenaBattleRecords)
          .orderBy(desc(botaArenaBattleRecords.createdAt))
          .limit(maxRecords),
      ),
      "community battle record query",
    );
    const rewardsByRecordId = await withCommunityStatsTimeout(
      loadRewardStatsByArenaRecordId(records),
      "community reward stats query",
    );

    const addOnchainRecord = (stats: BotaCommunityStats, record: BotaArenaBattleRecordRow) => {
      const rewardStats = rewardsByRecordId.get(String(record.id));
      const fighterBantCredits = positiveRecordNumber(rewardStats?.fighter_bantcredits);
      const spectatorBantCredits = positiveRecordNumber(rewardStats?.spectator_bantcredits);
      stats.onchain.battles += 1;
      stats.onchain.events += 1;
      stats.onchain.spectators += positiveRecordNumber(record.spectators);
      stats.onchain.fighterBantCredits += fighterBantCredits;
      stats.onchain.spectatorBantCredits += spectatorBantCredits;
      stats.onchain.totalBantCredits += fighterBantCredits + spectatorBantCredits;
    };

    for (const record of records) {
      addOnchainRecord(statsByKey.get("all")!, record);
      const communityKeys = new Set<BotaCommunityKey>();
      for (const agentId of recordParticipantIds(record)) {
        const key = profileCommunityByAgentId.get(agentId) || botaCommunityKeyForAgentId(agentId);
        if (key && key !== "all") communityKeys.add(key);
      }

      for (const key of communityKeys) {
        addOnchainRecord(statsByKey.get(key)!, record);
      }

      const winnerKey =
        (record.winnerAgentId && (profileCommunityByAgentId.get(normalizeBotaFighterAgentId(record.winnerAgentId)) ||
          botaCommunityKeyForAgentId(record.winnerAgentId))) ||
        null;
      const loserKey =
        (record.loserAgentId && (profileCommunityByAgentId.get(normalizeBotaFighterAgentId(record.loserAgentId)) ||
          botaCommunityKeyForAgentId(record.loserAgentId))) ||
        null;

      if (winnerKey && winnerKey !== "all") statsByKey.get(winnerKey)!.onchain.wins += 1;
      if (loserKey && loserKey !== "all") statsByKey.get(loserKey)!.onchain.losses += 1;
      if (record.winnerAgentId) statsByKey.get("all")!.onchain.wins += 1;
      if (record.loserAgentId) statsByKey.get("all")!.onchain.losses += 1;
    }
  } catch (error) {
    recordSource = "unavailable";
    warning = warning || "Arena battle record database unavailable.";
    warnFighterProfileFallback("community onchain battle stats", error);
  }

  const communities = BOTA_COMMUNITY_DEFS.map((definition) => statsByKey.get(definition.key)!);
  return {
    communities,
    totals: statsByKey.get("all")!,
    sources: {
      profiles: profileSource,
      arenaRecords: recordSource,
      profileRowsScanned: profiles.length,
      maxProfiles,
      maxRecords,
    },
    warning,
    updatedAt: new Date().toISOString(),
  };
}

export async function listBotaFighterProfiles(input: {
  limit?: number;
  refreshLive?: boolean;
  origin?: BotaFighterOrigin | null;
} = {}) {
  if (input.refreshLive !== false) {
    try {
      await syncBotaFighterProfilesFromLiveBattles(Math.max(10, input.limit || 40));
    } catch (error) {
      warnFighterProfileFallback("live profile refresh", error);
    }
  }

  const requestedLimit = Math.max(1, Math.min(Math.round(input.limit || 40), 5000));
  const mergeLimit = Math.max(requestedLimit * 3, 160);
  const shouldLoadExternalCatalog =
    !input.origin ||
    input.origin === "eliza" ||
    input.origin === "virtuals" ||
    input.origin === "bankr" ||
    input.origin === "agentkit" ||
    input.origin === "game-sdk";
  const catalog = shouldLoadExternalCatalog
    ? await getExternalAgentCatalogProfiles({ limit: Math.max(mergeLimit, 120) })
    : { profiles: [] as BotaFighterProfile[] };
  const catalogProfiles = input.origin
    ? catalog.profiles.filter((profile) => profile.origin === input.origin)
    : catalog.profiles;
  try {
    await ensureBotaFighterProfilesTable();
    const rows = input.origin
      ? await db
          .select()
          .from(botaFighterProfiles)
          .where(eq(botaFighterProfiles.origin, input.origin))
          .orderBy(desc(botaFighterProfiles.fameScore), asc(botaFighterProfiles.rank))
          .limit(mergeLimit)
      : await db
          .select()
          .from(botaFighterProfiles)
          .orderBy(desc(botaFighterProfiles.fameScore), asc(botaFighterProfiles.rank))
          .limit(mergeLimit);

    const profiles = await attachGen1EconomyToProfiles(await attachBotaFighterArenaRecordStats(
      await attachBotaFighterLiveStats(
        mergeFighterProfiles(rows.map(normalizeProfileRecord), catalogProfiles, mergeLimit),
      ),
      { assignRanks: true, limit: requestedLimit },
    ));
    return {
      profiles,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    warnFighterProfileFallback("profile list", error);
    const memoryFeed = listMemoryFighterProfiles({
      limit: requestedLimit,
      origin: input.origin,
    });
    return {
      ...memoryFeed,
      profiles: await attachGen1EconomyToProfiles(await attachBotaFighterArenaRecordStats(
        await attachBotaFighterLiveStats(
          mergeFighterProfiles(memoryFeed.profiles, catalogProfiles, mergeLimit),
        ),
        { assignRanks: true, limit: requestedLimit },
      )),
    };
  }
}

export async function listBotaFighterProfilesForOwner(input: {
  userId: string;
  walletAddresses?: string[];
  limit?: number;
  refreshLive?: boolean;
}) {
  const userId = String(input.userId || "").trim();
  const wallets = Array.from(
    new Set(
      (input.walletAddresses || [])
        .map((wallet) => String(wallet || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const requestedLimit = Math.max(1, Math.min(Math.round(input.limit || 100), 5000));
  if (!userId && wallets.length === 0) {
    return {
      profiles: [] as BotaFighterProfile[],
      updatedAt: new Date().toISOString(),
    };
  }

  if (input.refreshLive !== false) {
    try {
      await syncBotaFighterProfilesFromLiveBattles(Math.max(10, requestedLimit));
    } catch (error) {
      warnFighterProfileFallback("owner profile live refresh", error);
    }
  }

  const ownerConditions: SQL[] = [
    userId ? sql`${botaFighterProfiles.metadata}->>'importedByUserId' = ${userId}` : null,
    userId ? sql`${botaFighterProfiles.metadata}->>'ownerUserId' = ${userId}` : null,
    ...wallets.flatMap((wallet) => [
      sql`LOWER(COALESCE(${botaFighterProfiles.walletAddress}, '')) = ${wallet}`,
      sql`LOWER(COALESCE(${botaFighterProfiles.metadata}->>'importedByWallet', '')) = ${wallet}`,
      sql`LOWER(COALESCE(${botaFighterProfiles.metadata}->>'ownerWallet', '')) = ${wallet}`,
    ]),
  ].filter((condition): condition is SQL => Boolean(condition));

  if (!ownerConditions.length) {
    return {
      profiles: [] as BotaFighterProfile[],
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    await ensureBotaFighterProfilesTable();
    const rows = await db
      .select()
      .from(botaFighterProfiles)
      .where(or(...ownerConditions))
      .orderBy(desc(botaFighterProfiles.updatedAt))
      .limit(requestedLimit);
    const profiles = await attachGen1EconomyToProfiles(await attachBotaFighterArenaRecordStats(
      await attachBotaFighterLiveStats(rows.map(normalizeProfileRecord)),
    ));
    return {
      profiles,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    warnFighterProfileFallback("owner profile list", error);
    
    const memoryFeed = Array.from(memoryFighterProfiles.values()).filter(profile => {
      const pUserId = profile.metadata?.importedByUserId || profile.metadata?.ownerUserId;
      const pWallet1 = String(profile.walletAddress || '').toLowerCase();
      const pWallet2 = String(profile.metadata?.importedByWallet || '').toLowerCase();
      const pWallet3 = String(profile.metadata?.ownerWallet || '').toLowerCase();
      
      if (userId && pUserId === userId) return true;
      if (wallets.some(w => w === pWallet1 || w === pWallet2 || w === pWallet3)) return true;
      return false;
    });

    return {
      profiles: memoryFeed.slice(0, requestedLimit),
      updatedAt: new Date().toISOString(),
      warning: "Owner fighter profile store is unavailable; using memory fallback for local development.",
    };
  }
}

export async function getBotaFighterProfile(agentId: string, refreshLive = true) {
  const normalizedAgentId = normalizeBotaFighterAgentId(agentId);
  try {
    await ensureBotaFighterProfilesTable();
    let [row] = await db
      .select()
      .from(botaFighterProfiles)
      .where(eq(botaFighterProfiles.agentId, normalizedAgentId))
      .limit(1);

    if (!row && refreshLive) {
      await syncBotaFighterProfilesFromLiveBattles(40);
      [row] = await db
        .select()
        .from(botaFighterProfiles)
        .where(eq(botaFighterProfiles.agentId, normalizedAgentId))
        .limit(1);
    }

    if (!row) return null;
    const [profile] = await attachGen1EconomyToProfiles(await attachBotaFighterArenaRecordStats(
      await attachBotaFighterLiveStats([normalizeProfileRecord(row)]),
    ));
    return profile || null;
  } catch (error) {
    warnFighterProfileFallback("profile get", error);
    if (refreshLive && !memoryFighterProfiles.has(normalizedAgentId)) {
      try {
        await syncBotaFighterProfilesFromLiveBattles(40);
      } catch {
        // Already warned above; keep returning whatever the memory store has.
      }
    }
    const profile = memoryFighterProfiles.get(normalizedAgentId) || null;
    if (!profile) return null;
    const [withStats] = await attachGen1EconomyToProfiles(await attachBotaFighterArenaRecordStats(
      await attachBotaFighterLiveStats([profile]),
    ));
    return withStats || profile;
  }
}

export async function listBotaEnsAgentDiscovery(input: {
  limit?: number;
  refreshLive?: boolean;
} = {}) {
  const requestedLimit = Math.max(1, Math.min(Math.round(input.limit || 50), 100));
  let profiles: BotaFighterProfile[] = [];
  let source: "database" | "memory" = "database";
  let warning: string | undefined;

  try {
    if (input.refreshLive) {
      await withCommunityStatsTimeout(syncBotaFighterProfilesFromLiveBattles(Math.max(10, requestedLimit)), "ENS live profile refresh");
    }
    await withCommunityStatsTimeout(ensureBotaFighterProfilesTable(), "ENS profile table check");
    const rows = await withCommunityStatsTimeout(
      Promise.resolve(
        db
          .select()
          .from(botaFighterProfiles)
          .where(eq(botaFighterProfiles.origin, "ens"))
          .orderBy(desc(botaFighterProfiles.fameScore), asc(botaFighterProfiles.rank))
          .limit(requestedLimit),
      ),
      "ENS profile discovery query",
    );
    profiles = rows.map(normalizeProfileRecord);
  } catch (error) {
    source = "memory";
    warning = "ENS fighter profile database unavailable; using in-memory ENS fighters.";
    warnFighterProfileFallback("ENS agent discovery", error);
    profiles = Array.from(memoryFighterProfiles.values())
      .filter((profile) => profile.origin === "ens" || Boolean(profile.ensName))
      .sort((left, right) => right.fameScore - left.fameScore)
      .slice(0, requestedLimit);
  }

  const agents = profiles.map((profile) => ({
    agentId: profile.agentId,
    ensName: profile.ensName || profile.displayName,
    displayName: profile.displayName,
    rank: profile.rank,
    wins: profile.wins,
    losses: profile.losses,
    bantCreditsEarned: profile.bantCreditsEarned,
    walletAddress: profile.walletAddress,
    avatarUrl: profile.avatarUrl,
    profile,
    ensAgentIdentity: buildBotaEnsAgentIdentityForProfile(profile),
  }));

  return {
    agents,
    standards: {
      ensip25: "agent-registration[<registry>][<agentId>] when a real AI agent registry is configured",
      ensip26: [
        "agent-context",
        "agent-endpoint[web]",
        "agent-endpoint[bota-context]",
        "agent-endpoint[bota-battles]",
      ],
    },
    sources: {
      profiles: source,
      note: "ENS discovery is generated from live BOTA fighter profiles. ENS text records must still be published by the ENS name/root owner.",
    },
    warning,
    updatedAt: new Date().toISOString(),
  };
}

export async function getBotaEnsAgentContext(agentId: string, refreshLive = true) {
  const normalizedAgentId = normalizeBotaFighterAgentId(agentId);
  let profile: BotaFighterProfile | null = null;

  try {
    if (refreshLive) {
      await withCommunityStatsTimeout(syncBotaFighterProfilesFromLiveBattles(10), "ENS context live profile refresh");
    }
    await withCommunityStatsTimeout(ensureBotaFighterProfilesTable(), "ENS context table check");
    const [row] = await withCommunityStatsTimeout(
      Promise.resolve(
        db
          .select()
          .from(botaFighterProfiles)
          .where(eq(botaFighterProfiles.agentId, normalizedAgentId))
          .limit(1),
      ),
      "ENS context profile query",
    );
    profile = row ? normalizeProfileRecord(row) : null;
  } catch (error) {
    warnFighterProfileFallback("ENS agent context", error);
    profile = memoryFighterProfiles.get(normalizedAgentId) || null;
  }

  if (!profile) return null;
  if (profile.origin !== "ens" && !profile.ensName) return null;
  const ensAgentIdentity = buildBotaEnsAgentIdentityForProfile(profile);
  return {
    agentId: profile.agentId,
    ensName: profile.ensName || profile.displayName,
    displayName: profile.displayName,
    profile,
    ensAgentIdentity,
    context: ensAgentIdentity.context,
    textRecords: ensAgentIdentity.textRecords,
    updatedAt: new Date().toISOString(),
  };
}

export async function importBotaFighterProfile(input: BotaFighterProfileImportRequest) {
  const parsed = botaFighterProfileImportSchema.parse(input);
  const now = new Date();
  const existingDerivative = getBotaDerivativeFighter(parsed.metadata);
  const sourceAsset = parsed.metadata?.sourceAsset && typeof parsed.metadata.sourceAsset === "object"
    ? (parsed.metadata.sourceAsset as Record<string, unknown>)
    : {};
  const derivativeFighter = parsed.origin === "nft"
    ? existingDerivative || deriveBotaDerivativeFighter({
        collection:
          String(sourceAsset.collection || parsed.tokenName || parsed.badgeLabel || parsed.displayName || "NFT").trim(),
        tokenId:
          derivativeScalar(sourceAsset.tokenId) ||
          derivativeScalar(parsed.originId) ||
          derivativeScalar(parsed.displayName),
        traits:
          derivativeTraitInput(sourceAsset.traits) ||
          derivativeTraitInput(parsed.metadata?.traits) ||
          null,
        rarity: derivativeScalar(sourceAsset.rarity) || derivativeScalar(parsed.metadata?.rarity),
        seed: `${parsed.origin}:${parsed.originId || parsed.displayName}`,
      })
    : null;
  const agentId = normalizeBotaFighterAgentId(
    parsed.agentId ||
      `${parsed.origin}:${parsed.originId || parsed.ensName || parsed.walletAddress || parsed.displayName}`,
  );
  const baseMetadata = derivativeFighter
    ? {
        ...parsed.metadata,
        derivativeFighter,
        fighterId: agentId,
        visualStandard: "70% Bantah / 30% collection inspiration",
      }
    : parsed.metadata;
  const baseEnsIdentity =
    baseMetadata?.ensIdentity &&
    typeof baseMetadata.ensIdentity === "object" &&
    !Array.isArray(baseMetadata.ensIdentity)
      ? (baseMetadata.ensIdentity as Record<string, unknown>)
      : {};
  const baseEnsAgentIdentity =
    baseMetadata?.ensAgentIdentity &&
    typeof baseMetadata.ensAgentIdentity === "object" &&
    !Array.isArray(baseMetadata.ensAgentIdentity)
      ? (baseMetadata.ensAgentIdentity as { published?: Record<string, string | null | undefined> })
      : {};
  const baseEnsTextRecords =
    baseEnsIdentity.textRecords &&
    typeof baseEnsIdentity.textRecords === "object" &&
    !Array.isArray(baseEnsIdentity.textRecords)
      ? (baseEnsIdentity.textRecords as Record<string, string | null | undefined>)
      : {};
  const ensAgentIdentity = parsed.origin === "ens" || parsed.ensName
    ? buildBotaEnsAgentIdentity({
        agentId,
        displayName: parsed.displayName,
        ensName: parsed.ensName || parsed.originId || parsed.displayName,
        walletAddress: parsed.walletAddress || null,
        resolvedAddress:
          typeof baseEnsIdentity.resolvedAddress === "string"
            ? baseEnsIdentity.resolvedAddress
            : parsed.walletAddress || null,
        avatarUrl:
          typeof baseEnsIdentity.avatarUrl === "string"
            ? baseEnsIdentity.avatarUrl
            : parsed.avatarUrl || null,
        rank: parsed.rank || null,
        wins: 0,
        losses: 0,
        currentStreak: 0,
        bantCreditsEarned: 0,
        fameScore: 1,
        titles: parsed.titles,
        tags: parsed.tags,
        sourceTextRecords: baseEnsTextRecords,
        publishedTextRecords: baseEnsAgentIdentity.published || {},
      })
    : null;
  const agentIdentity = inferFighterIdentityMetadata({
    origin: parsed.origin,
    metadata: baseMetadata,
    badgeLabel: parsed.badgeLabel || parsed.tokenName || parsed.displayName,
  });
  const metadata = {
    ...baseMetadata,
    ...(ensAgentIdentity ? { ensAgentIdentity } : {}),
    agentIdentity,
    logoBadge: {
      label: String(agentIdentity.label || "Fighter"),
      imageUrl: String(agentIdentity.sourceLogoUrl || GENERATED_FIGHTER_IDENTITY_LOGO),
    },
  };

  const values = {
    agentId,
    displayName: derivativeFighter && /^nft|base nft|crystal bot/i.test(parsed.displayName)
      ? `${derivativeFighter.speciesLabel}${derivativeFighter.sourceTokenId ? ` #${derivativeFighter.sourceTokenId}` : ""}`
      : parsed.displayName,
    origin: parsed.origin,
    originId: parsed.originId || null,
    agentClass: parsed.agentClass,
    archetype: parsed.archetype,
    league: parsed.league,
    rank: parsed.rank || null,
    avatarUrl: parsed.avatarUrl || (derivativeFighter ? derivativeAvatar(derivativeFighter, agentId) : arenaAgentAvatar(`${parsed.origin}:${parsed.displayName}`)),
    badgeLabel: derivativeFighter?.speciesLabel || parsed.badgeLabel || `${parsed.origin.toUpperCase()} Agent`,
    ensName: parsed.ensName || null,
    walletAddress: parsed.walletAddress || null,
    externalUrl: parsed.externalUrl || null,
    tokenSymbol: parsed.tokenSymbol || null,
    tokenName: parsed.tokenName || null,
    chainId: parsed.chainId || null,
    titles: derivativeFighter ? Array.from(new Set([...derivativeFighter.titles, ...parsed.titles])) : parsed.titles,
    tags: derivativeFighter
      ? Array.from(new Set([...parsed.tags, ...derivativeFighter.tags]))
      : parsed.tags.length ? parsed.tags : [parsed.origin, parsed.agentClass],
    metadata,
    lastSeenAt: now,
    updatedAt: now,
  };

  try {
    await ensureBotaFighterProfilesTable();
    const [row] = await db
      .insert(botaFighterProfiles)
      .values(values)
      .onConflictDoUpdate({
        target: botaFighterProfiles.agentId,
        set: {
          ...values,
          importedAt: now,
        },
      })
      .returning();

    await recalculateBotaFighterLeaderboardRanks();
    return (await getStoredBotaFighterProfile(agentId)) || normalizeProfileRecord(row);
  } catch (error) {
    warnFighterProfileFallback("profile import", error);
    return upsertMemoryFighterProfile({
      ...values,
      importedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      fameScore: 1,
      watchers: 0,
      challengeVolume: 0,
      wins: 0,
      losses: 0,
      currentStreak: 0,
    });
  }
}

export async function syncBotaFighterProfilesFromBattle(battle: BantahBroAgentBattle) {
  const seeds = battle.sides.map((side) => profileFromBattleSide(battle, side));
  let useDatabase = true;
  try {
    await ensureBotaFighterProfilesTable();
  } catch (error) {
    useDatabase = false;
    warnFighterProfileFallback("single battle sync", error);
  }
  for (const seed of seeds) {
    if (useDatabase) {
      try {
        await upsertProfileSeed(seed);
        continue;
      } catch (error) {
        useDatabase = false;
        warnFighterProfileFallback("single battle upsert", error);
      }
    }
    upsertMemoryFighterProfile(seed);
  }
  return seeds.map((seed) => seed.agentId);
}

export async function applyBotaArenaBattleResultToFighterProfiles(input: {
  battle: BantahBroAgentBattle;
  winnerSideId: string | null;
  loserSideId: string | null;
  recordId: string;
}): Promise<BotaFighterProfileBattleUpdate> {
  await ensureBotaFighterProfilesTable();
  await syncBotaFighterProfilesFromBattle(input.battle);

  const now = new Date();
  const winnerSide = input.winnerSideId
    ? input.battle.sides.find((side) => side.id === input.winnerSideId) || null
    : null;
  const loserSide = input.loserSideId
    ? input.battle.sides.find((side) => side.id === input.loserSideId) || null
    : null;
  const winnerAgentId = winnerSide ? getBotaFighterAgentIdForBattleSide(winnerSide) : null;
  const loserAgentId = loserSide ? getBotaFighterAgentIdForBattleSide(loserSide) : null;
  const winnerBefore = winnerAgentId ? await getStoredBotaFighterProfile(winnerAgentId) : null;
  const loserBefore = loserAgentId ? await getStoredBotaFighterProfile(loserAgentId) : null;

  if (winnerAgentId) {
    await db
      .update(botaFighterProfiles)
      .set({
        wins: sql`${botaFighterProfiles.wins} + 1`,
        currentStreak: sql`GREATEST(${botaFighterProfiles.currentStreak}, 0) + 1`,
        fameScore: sql`LEAST(${botaFighterProfiles.fameScore} + 5, 100)`,
        lastBattleId: input.battle.id,
        metadata: sql`${botaFighterProfiles.metadata} || ${JSON.stringify({
          latestArenaResult: {
            result: "win",
            recordId: input.recordId,
            battleId: input.battle.id,
            at: now.toISOString(),
          },
        })}::jsonb`,
        updatedAt: now,
      })
      .where(eq(botaFighterProfiles.agentId, winnerAgentId));
  }

  if (loserAgentId) {
    await db
      .update(botaFighterProfiles)
      .set({
        losses: sql`${botaFighterProfiles.losses} + 1`,
        currentStreak: sql`LEAST(${botaFighterProfiles.currentStreak}, 0) - 1`,
        fameScore: sql`GREATEST(${botaFighterProfiles.fameScore} + 1, 0)`,
        lastBattleId: input.battle.id,
        metadata: sql`${botaFighterProfiles.metadata} || ${JSON.stringify({
          latestArenaResult: {
            result: "loss",
            recordId: input.recordId,
            battleId: input.battle.id,
            at: now.toISOString(),
          },
        })}::jsonb`,
        updatedAt: now,
      })
      .where(eq(botaFighterProfiles.agentId, loserAgentId));
  }

  const rankChanges = await recalculateBotaFighterLeaderboardRanks();
  const winnerAfter = winnerAgentId ? await getStoredBotaFighterProfile(winnerAgentId) : null;
  const loserAfter = loserAgentId ? await getStoredBotaFighterProfile(loserAgentId) : null;
  const affectedAgentIds = new Set([winnerAgentId, loserAgentId].filter(Boolean));

  return {
    winner: winnerAgentId
      ? {
          agentId: winnerAgentId,
          before: winnerBefore,
          after: winnerAfter,
        }
      : null,
    loser: loserAgentId
      ? {
          agentId: loserAgentId,
          before: loserBefore,
          after: loserAfter,
        }
      : null,
    rankChanges: rankChanges
      .filter((change) => affectedAgentIds.has(change.profile.agentId))
      .map((change) => ({
        ...change,
        reason: "arena_result",
      })),
  };
}

/**
 * Backfill: ensure every agent in the `agents` table (owned by this user)
 * has a corresponding row in `botaFighterProfiles`. This repairs the gap
 * that occurs on fresh Railway deploys when the table didn't exist at
 * agent-creation time and the insert silently did nothing.
 */
export async function backfillBotaFighterProfilesFromAgents(ownerId: string): Promise<void> {
  if (!ownerId) return;
  try {
    await ensureBotaFighterProfilesTable();
    const ownedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.ownerId, ownerId))
      .limit(200);
    if (!ownedAgents.length) return;

    const agentIds = ownedAgents.map((a) => a.agentId);
    const existingProfiles = await db
      .select({ agentId: botaFighterProfiles.agentId })
      .from(botaFighterProfiles)
      .where(inArray(botaFighterProfiles.agentId, agentIds));
    const existingSet = new Set(existingProfiles.map((p) => p.agentId));

    const missing = ownedAgents.filter((a) => !existingSet.has(a.agentId));
    if (!missing.length) return;

    const now = new Date();
    for (const agent of missing) {
      await db.insert(botaFighterProfiles).values({
        agentId: agent.agentId,
        displayName: agent.agentName,
        origin: "bota",
        originId: null,
        agentClass: "striker",
        archetype: "signal_striker",
        league: "Open League",
        fameScore: 50,
        avatarUrl: agent.avatarUrl ?? null,
        walletAddress: agent.walletAddress ?? null,
        metadata: { ownerUserId: ownerId },
        lastSeenAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
    }
  } catch (error) {
    // Non-fatal — log and continue so the profile page still loads
    console.warn("[botaFighterProfileService] backfill from agents failed:", error);
  }
}
