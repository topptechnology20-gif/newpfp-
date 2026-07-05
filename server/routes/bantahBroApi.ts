import { Router } from "express";
import { z, ZodError } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ethers } from "ethers";
import {
  botaToolInventory,
  botaFighterLoadout,
  botaToolsCatalog,
  kothParticipants,
  notifications,
  kothTrollboxMessages,
  botaFighterProfiles,
  botaArenaBattleRecords,
  users,
  transactions,
  userRewardsClaims,
  agents,
  marketplaceListings,
} from "@shared/schema";
import { notifyBotaUser } from "../bantahBro/botaNotificationService";
import { generateAutonomousTrollboxMessage } from "../bantahBro/autonomousPersonaService";
import {
  listManagedBantahAgentRuntimes,
  sendManagedBantahAgentRuntimeMessage
} from "../bantahElizaRuntimeManager";
import {
  bantahBroAlertSchema,
  bantahBroBoostMarketRequestSchema,
  bantahBroBxbtRewardRequestSchema,
  bantahBroBxbtSpendRequestSchema,
  bantahBroCreateMarketFromSignalRequestSchema,
  bantahBroCreateP2PMarketRequestSchema,
  bantahBroEnsureSystemAgentRequestSchema,
  bantahBroEvaluateReceiptRequestSchema,
  bantahBroPublishAlertRequestSchema,
  bantahBroTokenRefSchema,
} from "@shared/bantahBro";
import {
  botaFighterOriginValues,
  botaFighterProfileImportSchema,
} from "@shared/botaFighterProfile";
import { analyzeToken } from "../bantahBro/tokenIntelligence";
import {
  getRugScorerV2Dashboard,
  searchRugScorerV2Token,
} from "../bantahBro/rugScorerV2Service";
import {
  buildBantahBroChatScanReply,
  buildBantahBroScanPrompt,
  extractBantahBroSurfaceScanIntent,
  runBantahBroSurfaceScan,
} from "../bantahBro/rugScorerSurface";
import {
  deleteRugScorerV2Watch,
  listRugScorerV2History,
  listRugScorerV2Reports,
  listRugScorerV2Watchlist,
  recordRugScorerV2Scan,
  recordRugScorerV2ScanBatch,
  saveRugScorerV2Report,
  saveRugScorerV2Watch,
  updateRugScorerV2ReportStatus,
} from "../bantahBro/rugScorerV2Persistence";
import {
  getBantahBroAlert,
  listBantahBroAlerts,
  listBantahBroReceiptsByToken,
  listMarketBoosts,
  publishBantahBroAlert,
  publishBantahBroReceipt,
} from "../bantahBro/alertFeed";
import { buildAlertFromAnalysis, buildReceiptFromAlert } from "../bantahBro/contentEngine";
import {
  boostBantahBroMarket,
  createBantahBroMarketFromSignal,
} from "../bantahBro/marketService";
import onchainPaymentService from "../bantahBro/onchainPaymentService";
import {
  createBantahBroP2PMarket,
  getBantahBroLeaderboard,
} from "../bantahBro/communityService";
import {
  getLiveBantahBroLeaderboard,
  getLiveBantahBroMarkets,
} from "../bantahBro/liveDiscoveryService";
import { getBantahBroHotTickers } from "../bantahBro/hotTickersService";
import {
  ensureBantahBroSystemAgent,
  ensureBantahBroTelegramRuntimeStarted,
  getBantahBroSystemAgentStatus,
  isBantahBroElizaTelegramEnabled,
  reprovisionBantahBroSystemAgentWallet,
} from "../bantahBro/systemAgent";
import { getBantahBroAutomationStatus } from "../bantahBro/automationService";
import {
  buildCurrentBattleTweetDraft,
  buildCurrentBattleThreadDraft,
  getBantahBroTwitterAgentStatus,
  postCurrentBattleMediaTweet,
  postCurrentBattleThread,
  postCurrentBattleTweet,
  previewBantahBroTwitterAgentResponse,
  runBantahBroTwitterAgentCycle,
} from "../bantahBro/twitterAgentService";
import {
  getBantahBroBxbtStatus,
  rewardBantahBroBxbt,
  spendBantahBroBxbt,
} from "../bantahBro/bxbtUtility";
import {
  deployBantahLaunchToken,
  getBantahLauncherStatus,
  listBantahTokenLaunches,
  validateBantahLaunchDraft,
} from "../bantahBro/tokenLauncher";
import { handleTokenLaunchIntent } from "../bantahBro/launchIntent";
import {
  getBantahBroSocialFeed,
  type BantahBroFeedSource,
} from "../bantahBro/socialFeedService";
import {
  getLiveBantahBroAgentBattles,
  getUpcomingBotaArenaQueue,
  type BantahBroAgentBattle,
} from "../bantahBro/agentBattleService";
import { runBotaLifecycleNotificationsOnce } from "../bantahBro/botaLifecycleNotificationService";
import { simulateBotaArenaBattleFromLiveBattle } from "../bantahBro/botaArenaEngine";
import {
  getBotaFighterProfile,
  getBotaEnsAgentContext,
  importBotaFighterProfile,
  listBotaEnsAgentDiscovery,
  listBotaFighterCommunityStats,
  listBotaFighterProfilesForOwner,
  listBotaFighterProfiles,
  previewBotaEnsFighter,
  scanBotaWalletFighterAssets,
  syncBotaFighterProfilesFromLiveBattles,
  backfillBotaFighterProfilesFromAgents,
} from "../bantahBro/botaFighterProfileService";
import {
  acceptBotaAgentChallenge,
  botaAgentChallengeCreateSchema,
  listBotaAgentChallenges,
  createBotaAgentChallenge,
  type BotaAgentChallengeStatus,
} from "../bantahBro/botaAgentChallengeService";
import {
  getBotaAgentChallengePredictionPool,
  listBotaAgentChallengePredictionPositionsForUser,
  markBotaAgentChallengePredictionEscrowLocked,
  placeBotaAgentChallengePredictionStake,
} from "../bantahBro/botaAgentChallengePredictionService";
import {
  notifyBotaAgentChallengeAccepted,
  notifyBotaAgentChallengeCreated,
} from "../bantahBro/botaAgentChallengeNotificationService";
import { notifyBotaFighterImported } from "../bantahBro/botaNotificationService";
import {
  listBotaAgentFollowStates,
  toggleBotaAgentFollow,
} from "../bantahBro/botaAgentFollowService";
import {
  getBotaArenaBattleRecord,
  listBotaArenaBattleRecordsForAgents,
  listBotaArenaBattleRecords,
  recordBotaArenaBattleFromLiveBattle,
} from "../bantahBro/botaArenaBattleRecordService";
import {
  getAgentBattleP2PPool,
  listAgentBattleP2PHistoryPositions,
  markAgentBattleP2PEscrowLocked,
  placeAgentBattleP2PStake,
  resolveAgentBattleP2PRoundWinnerWithBotaEngine,
  settleAgentBattleP2PRound,
} from "../bantahBro/agentBattleP2PService";
import {
  getLivePredictionVisualizationBattles,
  preparePredictionVisualizationOrderIntent,
} from "../bantahBro/predictionVisualizationService";
import {
  getPredictionVisualizationExecutionPreflight,
  listPredictionVisualizationPositions,
  markPredictionVisualizationPositionSourceOpened,
  savePredictionVisualizationPosition,
} from "../bantahBro/predictionVisualizationPositionService";
import {
  getBantahBroTrollboxFeed,
  recordBantahBroTrollboxMessage,
} from "../bantahBro/trollboxService";
import {
  buildBotaBnbAgentIdentityForProfile,
  getBotaBnbAgentRegistration,
  upsertBotaBnbAgentRegistration,
} from "../bantahBro/bnbAgentIdentityService";
import gen1Economy from "../bantahBro/gen1EconomyService";
import { Gen1EconomyEngine, BC_MINT_RATE } from "../bantahBro/gen1EconomyEngine";
import {
  ensureOnchainSimBattleClaimsTable,
  listOnchainSimBattleClaimsForUser,
  markOnchainSimBattleClaimTx,
  publishOnchainSimBattleRewardsForRecord,
} from "../onchainSimBattleClaimService";
import { maybeHandleBantahBroCommandSurface } from "../bantahBro/commandSurface";
import { prepareBantahBroWalletAction } from "../bantahBro/walletActionSurface";
import { PrivyAuthMiddleware, verifyPrivyToken } from "../privyAuth";
import { db } from "../db";
import { getOnchainServerConfig } from "../onchainConfig";
import packService from "../bantahBro/packService";
import agentMemoryService from "../bantahBro/agentMemoryService";
import decidePackOpen from "../bantahBro/packDecisionEngine";
import { storage } from "../storage";
import { getBantahBroTelegramBot } from "../telegramBot";
import { getTelegramSync } from "../telegramSync";
import { sendManagedBantahAgentRuntimeMessage } from "../bantahElizaRuntimeManager";
import {
  BANTCREDIT_BATTLE_WATCH_REWARD_TIERS,
  BANTCREDIT_BATTLE_WATCH_TRANSACTION_TYPE,
  calculateBattleWatchBantCredit,
} from "@shared/bantCredit";
import { bantahBroWalletPrepareRequestSchema } from "@shared/bantahBroWallet";
import { normalizeEvmAddress, parseWalletAddresses, type OnchainTokenSymbol } from "@shared/onchainConfig";
import { verifyEscrowTransaction } from "../onchainEscrowService";

const router = Router();

const economyEngine = new Gen1EconomyEngine();

const BANTCREDIT_TRANSACTION_TYPES = [
  "signup_bonus",
  "referral_bonus",
  "referral_reward",
  "daily_signin",
  "challenge_creation_reward",
  "challenge_win_reward",
  BANTCREDIT_BATTLE_WATCH_TRANSACTION_TYPE,
  "referral_share_reward",
  "admin_points",
];

const BANTCREDIT_REWARD_LABELS: Record<string, string> = {
  signup_bonus: "Signup bonus",
  referral_bonus: "Referral signup bonus",
  referral_reward: "Referral reward",
  daily_signin: "Daily check-in",
  challenge_creation_reward: "Challenge creation",
  challenge_win_reward: "Challenge win",
  [BANTCREDIT_BATTLE_WATCH_TRANSACTION_TYPE]: "Arena watch reward",
  referral_share_reward: "Referral share reward",
  admin_points: "Manual BantCredit grant",
};

const BANTCREDITS_READ_ABI = [
  "function totalSupply() view returns (uint256)",
];

async function readOnchainBantCreditSupplyStats() {
  const onchainConfig = getOnchainServerConfig();
  const configuredChains = Object.values(onchainConfig.chains || {}).filter((chain) =>
    normalizeEvmAddress(chain.bantCreditsAddress),
  );
  const chainResults = await Promise.allSettled(
    configuredChains.map(async (chain) => {
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, {
        staticNetwork: true,
      });
      const contract = new ethers.Contract(
        normalizeEvmAddress(chain.bantCreditsAddress)!,
        BANTCREDITS_READ_ABI,
        provider,
      );
      const totalSupply = await contract.totalSupply();
      return {
        chainId: chain.chainId,
        chainName: chain.name,
        bantCreditsAddress: chain.bantCreditsAddress || null,
        totalSupply: Number(totalSupply),
        status: "live",
      };
    }),
  );

  const chains = chainResults.map((result, index) => {
    const chain = configuredChains[index];
    if (result.status === "fulfilled") return result.value;
    return {
      chainId: chain.chainId,
      chainName: chain.name,
      bantCreditsAddress: chain.bantCreditsAddress || null,
      totalSupply: 0,
      status: "unavailable",
      error: result.reason instanceof Error ? result.reason.message : "Unable to read BantCredits supply",
    };
  });

  return {
    totalMintedBantCredits: chains.reduce((sum, chain) => sum + Math.max(0, Math.round(chain.totalSupply || 0)), 0),
    configuredChainCount: configuredChains.length,
    chains,
  };
}

async function readOnchainClaimableBantCreditStats() {
  try {
    await ensureOnchainSimBattleClaimsTable();
    const result = await db.execute(sql`
      SELECT
        COALESCE(SUM("amount"), 0) AS "total",
        COUNT(*) AS "count"
      FROM "onchain_sim_battle_reward_claims"
      WHERE "status" = 'claimable';
    `);
    const [row] = Array.isArray(result) ? result : Array.isArray((result as any)?.rows) ? (result as any).rows : [];
    return {
      total: Math.max(0, Math.round(Number(row?.total || 0))),
      count: Number(row?.count || 0),
    };
  } catch {
    return {
      total: 0,
      count: 0,
    };
  }
}

const bantahBroChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  tool: z
    .enum([
      "assistant",
      "wallet",
      "discover",
      "battle",
      "analyze",
      "rug",
      "runner",
      "alerts",
      "markets",
      "bxbt",
      "launcher",
    ])
    .default("assistant"),
  sessionId: z.string().min(1).max(120).optional(),
});

const bantahBroTrollboxPostSchema = z.object({
  roomId: z.string().trim().min(1).max(120).default("agent-battle"),
  battleId: z.string().trim().min(1).max(180).optional(),
  user: z.string().trim().min(1).max(64).optional(),
  message: z.string().trim().min(1).max(1000),
});

const predictionVisualizationOrderIntentSchema = z.object({
  side: z.enum(["yes", "no"]),
  amountUsd: z.coerce.number().positive().max(100_000).default(10),
  maxPrice: z.coerce.number().min(0.01).max(0.99).optional(),
  walletAddress: z.string().trim().min(8).max(128).optional().nullable(),
});

const predictionVisualizationExecutionPreflightSchema = z.object({
  walletAddress: z.string().trim().min(8).max(128).optional().nullable(),
});

const botaArenaSimulationRequestSchema = z.object({
  seed: z.string().trim().min(1).max(255).optional(),
  maxRounds: z.coerce.number().int().min(1).max(5).optional(),
});

const botaArenaRecordRequestSchema = z.object({
  seed: z.string().trim().min(1).max(255).optional(),
  maxRounds: z.coerce.number().int().min(1).max(5).default(5),
  arenaId: z.string().trim().min(1).max(120).optional().nullable(),
  forceNewRecord: z.coerce.boolean().default(false),
  chainId: z.coerce.number().int().positive().optional(),
  publishOnchainRewards: z.coerce.boolean().default(true),
  executeOnchainRewards: z.coerce.boolean().optional(),
});

const onchainBantCreditClaimTxSchema = z.object({
  txHash: z.string().trim().regex(/^0x[a-fA-F0-9]{64}$/),
});

const botaBnbAgentRegistrationSchema = z.object({
  chainId: z.coerce.number().int().positive().optional(),
  registryAddress: z.string().trim().max(128).optional().nullable(),
  bnbAgentId: z.string().trim().max(255).optional().nullable(),
  metadataUri: z.string().trim().max(1000).optional().nullable(),
  registrationTxHash: z.string().trim().regex(/^0x[a-fA-F0-9]{64}$/).optional().nullable(),
  status: z.enum(["ready_to_register", "registered", "disabled", "failed"]).optional(),
  registeredBy: z.string().trim().max(128).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const agentBattleP2PStakeSchema = z.object({
  sideId: z.string().trim().min(1).max(500),
  stakeAmount: z.coerce.number().positive().max(1_000_000),
  stakeCurrency: z.enum(["BXBT", "USDC", "USDT", "ETH", "BNB"]).default("USDC"),
  walletAddress: z.string().trim().min(8).max(128).optional().nullable(),
});

const botaAgentChallengePredictionStakeSchema = z.object({
  side: z.enum(["YES", "NO"]),
  stakeAmount: z.coerce.number().positive().max(1_000_000),
  stakeCurrency: z.enum(["USDC", "USDT", "ETH", "BNB"]).default("USDC"),
  walletAddress: z.string().trim().min(8).max(128).optional().nullable(),
});

const agentBattleP2PEscrowSchema = z.object({
  walletAddress: z.string().trim().min(8).max(128).optional().nullable(),
  escrowTxHash: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .optional()
    .nullable(),
});

const agentBattleP2PSettlementSchema = z.object({
  roundId: z.string().trim().min(1).max(320),
  winnerSideId: z.string().trim().min(1).max(500),
  maxPairs: z.coerce.number().int().positive().max(100).default(20),
  dryRun: z.coerce.boolean().default(false),
});

const agentBattleP2PBotaEngineSettlementSchema = z.object({
  roundId: z.string().trim().min(1).max(320),
  seed: z.string().trim().min(1).max(255).optional(),
  maxRounds: z.coerce.number().int().min(1).max(5).default(5),
  maxPairs: z.coerce.number().int().positive().max(100).default(20),
  dryRun: z.coerce.boolean().default(true),
});

const agentBattleWatchRewardSchema = z.object({
  battleMode: z.enum(["arena", "challenge"]).default("arena"),
  battleStatus: z.enum(["live", "queued", "cancelled", "rematch"]).default("live"),
  watchedSeconds: z.coerce.number().min(0).max(7_200),
  activeSeconds: z.coerce.number().min(0).max(7_200),
  interactionCount: z.coerce.number().int().min(0).max(10_000).default(0),
});

const rugScorerV2WatchSchema = z.object({
  userKey: z.string().trim().min(3).max(180),
  chainId: z.string().trim().min(1).max(64),
  tokenAddress: z.string().trim().min(3).max(180),
});

const rugScorerV2ReportSchema = z.object({
  reporterKey: z.string().trim().min(3).max(180),
  chainId: z.string().trim().min(1).max(64),
  tokenAddress: z.string().trim().min(3).max(180),
  severity: z.enum(["low", "medium", "high"]).default("medium"),
  reason: z.string().trim().min(2).max(180),
  notes: z.string().trim().max(1000).optional().nullable(),
});

const rugScorerV2ReportStatusSchema = z.object({
  status: z.enum(["open", "reviewed", "dismissed"]),
});

const bantahBroTwitterBattlePostSchema = z.object({
  battleId: z.string().trim().min(1).max(240).optional().nullable(),
  force: z.coerce.boolean().default(false),
  dryRun: z.coerce.boolean().default(true),
});

const bantahBroTwitterAgentRunSchema = z.object({
  dryRun: z.coerce.boolean().optional(),
  maxMentions: z.coerce.number().int().positive().max(100).optional(),
  maxSearch: z.coerce.number().int().positive().max(100).optional(),
});

const bantahBroTwitterPreviewSchema = z.object({
  text: z.string().trim().min(1).max(1000),
});

function parseBoolean(value: unknown): boolean {
  return String(value || "").trim().toLowerCase() === "true";
}

function handleError(res: any, error: unknown) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      message: "Invalid BantahBro request",
      details: error.flatten(),
    });
  }

  const status =
    typeof error === "object" && error && typeof (error as { status?: unknown }).status === "number"
      ? Number((error as { status: number }).status)
      : typeof error === "object" && error && typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? Number((error as { statusCode: number }).statusCode)
      : undefined;
  const message = error instanceof Error ? error.message : "BantahBro scan failed";
  if (status) {
    return res.status(status).json({ message });
  }
  if (/not found/i.test(message)) {
    return res.status(404).json({ message });
  }
  if (/admin/i.test(message)) {
    return res.status(403).json({ message });
  }
  if (/ONCHAIN_ENABLED_CHAINS/i.test(message)) {
    return res.status(400).json({ message });
  }
  if (/AgentKit provisioning is not configured for chain|smart-wallet execution is not available/i.test(message)) {
    return res.status(503).json({ message });
  }
  if (/invalid|must|needs either/i.test(message)) {
    return res.status(400).json({ message });
  }
  if (/not configured|unavailable|provisioned/i.test(message)) {
    return res.status(503).json({ message });
  }
  return res.status(502).json({ message });
}

function toTokenRef(params: { chainId?: string; tokenAddress?: string }, query: unknown) {
  const queryRecord =
    query && typeof query === "object" && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};

  return bantahBroTokenRefSchema.parse({
    chainId: params.chainId || queryRecord.chainId || "solana",
    tokenAddress: params.tokenAddress,
  });
}

function maybeStripPairs(analysis: Awaited<ReturnType<typeof analyzeToken>>, includePairs: boolean) {
  if (includePairs) return analysis;
  return {
    ...analysis,
    pairs: [],
  };
}

function parseLimit(value: unknown, fallback = 50, max = 100) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

function parseFeedSource(value: unknown): BantahBroFeedSource | undefined {
  const source = String(value || "").trim().toLowerCase();
  if (source === "bantah" || source === "twitter" || source === "telegram") {
    return source;
  }
  return undefined;
}

function parseBotaFighterOrigin(value: unknown): (typeof botaFighterOriginValues)[number] | undefined {
  const origin = String(value || "").trim().toLowerCase();
  return botaFighterOriginValues.includes(origin as (typeof botaFighterOriginValues)[number])
    ? (origin as (typeof botaFighterOriginValues)[number])
    : undefined;
}

function parseBotaAgentChallengeStatus(value: unknown): BotaAgentChallengeStatus | "all" | undefined {
  const status = String(value || "").trim().toLowerCase();
  if (
    status === "pending" ||
    status === "accepted" ||
    status === "scheduled" ||
    status === "live" ||
    status === "resolved" ||
    status === "expired" ||
    status === "cancelled" ||
    status === "all"
  ) {
    return status;
  }
  return undefined;
}

function positiveIntHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 2_147_483_647) || 1;
}

function getBattleWatchRewardRelatedId(battleId: string, tierSeconds: number) {
  return positiveIntHash(`battle-watch:${battleId}:${tierSeconds}`);
}

function getNextBattleWatchRewardTier(totalAwardedForBattle: number) {
  const earned = Math.max(0, Math.round(totalAwardedForBattle || 0));
  return (
    [...BANTCREDIT_BATTLE_WATCH_REWARD_TIERS]
      .reverse()
      .find((tier) => tier.totalPoints > earned) ?? null
  );
}

function displayActorName(user: any) {
  return (
    String(user?.username || "").trim() ||
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
    "Arena watcher"
  );
}

function normalizeRewardTransaction(row: {
  id: number;
  type: string;
  amount: string | number;
  description?: string | null;
  status?: string | null;
  createdAt?: Date | string | null;
}) {
  const amount = Math.max(0, Math.round(Number(row.amount || 0)));

  return {
    id: row.id,
    type: row.type,
    source: BANTCREDIT_REWARD_LABELS[row.type] || "BantCredit reward",
    amount,
    description: row.description || BANTCREDIT_REWARD_LABELS[row.type] || "BantCredit reward",
    status: row.status || "completed",
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.createdAt || new Date().toISOString(),
  };
}

async function resolveOptionalBantahBroChatActor(req: any) {
  const existingUser = req.user;
  if (existingUser?.id) {
    return {
      userId: existingUser.id as string,
      username: typeof existingUser.username === "string" ? existingUser.username : null,
      firstName: typeof existingUser.firstName === "string" ? existingUser.firstName : null,
      walletAddress: normalizeEvmAddress(existingUser.walletAddress),
    };
  }

  const authHeader = String(req.headers?.authorization || "").trim();
  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  try {
    const claims = await verifyPrivyToken(token);
    const userId = claims?.userId || (claims as any)?.sub;
    if (typeof userId !== "string" || !userId) {
      return null;
    }

    const user = await storage.getUser(userId).catch(() => null);
    if (!user) {
      return {
        userId,
        username: typeof (claims as any)?.username === "string" ? (claims as any).username : null,
        firstName: typeof (claims as any)?.first_name === "string" ? (claims as any).first_name : null,
        walletAddress: null,
      };
    }

    return {
      userId: user.id,
      username: user.username || null,
      firstName: user.firstName || null,
      walletAddress:
        normalizeEvmAddress((user as any).primaryWalletAddress) ||
        parseWalletAddresses((user as any).walletAddresses)[0] ||
        null,
    };
  } catch {
    return null;
  }
}

async function resolveRequiredBotaUserId(req: any) {
  const existingUserId = String(req.user?.id || req.user?.claims?.sub || "").trim();
  if (existingUserId) return existingUserId;

  const authHeader = String(req.headers?.authorization || "").trim();
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  try {
    const claims = await verifyPrivyToken(token);
    const userId = String(claims?.userId || (claims as any)?.sub || "").trim();
    return userId || null;
  } catch {
    return null;
  }
}

function inferBantahBroChatTool(message: string, tool: z.infer<typeof bantahBroChatRequestSchema>["tool"]) {
  if (tool !== "assistant") {
    return tool;
  }

  const text = String(message || "").trim().toLowerCase();
  if (!text) return tool;

  if (
    /\b(wallet|balance|portfolio|holdings?|positions?)\b/.test(text) ||
    /\b(create|make|new)\b.*\bwallet\b/.test(text) ||
    /\b(send|transfer|tip)\b/.test(text) ||
    /\b(buy|sell|swap|bridge|approve|revoke|snipe|stake|claim airdrops?|copy trade|stop loss|take profit)\b/.test(text)
  ) {
    return "wallet";
  }

  if (
    /\b(trending|discover|dexscreener|meme coins?|what('?s| is).*\bhot\b|what('?s| is).*\brunning\b|hot on|hot now)\b/.test(
      text,
    )
  ) {
    return "discover";
  }

  if (/\b(battle|battles|arena|vs|versus|join)\b/.test(text)) {
    return "battle";
  }

  if (/\b(runner|momentum|breakout)\b/.test(text)) {
    return "runner";
  }

  if (/\b(rug|scam|safe|risky|risk)\b/.test(text)) {
    return "rug";
  }

  if (/\b(market cap|fdv|holders?|liquidity|creator|analy[sz]e|scan|score)\b/.test(text)) {
    return "analyze";
  }

  return tool;
}

function getBantahBroChatRuntimeTimeoutMs() {
  const parsed = Number.parseInt(String(process.env.BANTAHBRO_CHAT_RUNTIME_TIMEOUT_MS || "").trim(), 10);
  if (Number.isInteger(parsed) && parsed >= 5_000) {
    return parsed;
  }
  return 18_000;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function buildBantahBroChatRuntimeFallback(message: string, tool: string) {
  const normalizedTool = String(tool || "assistant");
  if (normalizedTool === "discover") {
    return [
      "The live agent reply took too long, so I stopped the wait.",
      "",
      "For fastest discovery answers, try prompts like:",
      "show me trending meme coins on Base",
      "what is hot on Solana",
    ].join("\n");
  }

  if (normalizedTool === "battle") {
    return [
      "The live agent reply took too long, so I stopped the wait.",
      "",
      "For fastest battle answers, try:",
      "show live battles",
      "create $PEPE vs $BONK",
    ].join("\n");
  }

  if (normalizedTool === "wallet") {
    return [
      "The live agent reply took too long, so I stopped the wait.",
      "",
      "Wallet balance, create-wallet, and execution-status questions are handled fastest from Wallet Ops.",
    ].join("\n");
  }

  return [
    "The live agent reply took too long, so I stopped the wait.",
    "",
    "Try a more specific prompt, or switch to Discover, Battle Desk, Wallet Ops, Analyze Token, or Rug Score for the fastest live answers.",
    "",
    `Your prompt: ${message}`,
  ].join("\n");
}

function isBantahBroChatRuntimeUnavailableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /BANTAHBRO_SYSTEM_USERNAME|BANTAHBRO_SYSTEM_EMAIL|BANTAHBRO_AGENT_NAME|required for BantahBro|AgentKit provisioning is not configured|runtime config is missing|wallet is invalid/i.test(
    message,
  );
}

function buildBantahBroChatUnavailableFallback(tool: string) {
  const normalizedTool = String(tool || "assistant");
  const header =
    "The live BantahBro agent is still being configured on this server, so chat replies are temporarily unavailable.";

  if (normalizedTool === "wallet") {
    return [
      header,
      "",
      "Wallet-aware replies will come back once the BantahBro runtime finishes starting.",
    ].join("\n");
  }

  if (normalizedTool === "battle") {
    return [
      header,
      "",
      "Battle chat will come back once the BantahBro runtime finishes starting.",
    ].join("\n");
  }

  return [
    header,
    "",
    "Try again in a moment after the runtime finishes warming up.",
  ].join("\n");
}

function requireAdmin(req: any, res: any, next: any) {
  if (!req.user?.id) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (!req.user?.isAdmin) {
    return res.status(403).json({ message: "Admin access required" });
  }
  return next();
}

router.get("/alerts/live", async (req, res) => {
  try {
    res.json({
      alerts: listBantahBroAlerts(parseLimit(req.query.limit)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/feed", async (req, res) => {
  try {
    res.json(
      await getBantahBroSocialFeed({
        limit: parseLimit(req.query.limit, 50, 100),
        source: parseFeedSource(req.query.source),
      }),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/alerts/:alertId", async (req, res) => {
  try {
    const alert = getBantahBroAlert(String(req.params.alertId || ""));
    if (!alert) {
      return res.status(404).json({ message: "Alert not found" });
    }
    res.json(alert);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/boosts/live", async (req, res) => {
  try {
    res.json({
      boosts: listMarketBoosts(parseLimit(req.query.limit)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/markets", async (req, res) => {
  try {
    const feed = await getLiveBantahBroMarkets(parseLimit(req.query.limit, 24, 100));
    res.json(feed);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/hot-tickers", async (req, res) => {
  try {
    const feed = await getBantahBroHotTickers(parseLimit(req.query.limit, 5, 5));
    res.json(feed);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/fighter-assets/scan", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const dbUser = await storage.getUser(req.user.id).catch(() => null);
    const walletAddresses = botaUserWalletAddresses(req.user, dbUser);
    const normalizedWallets = new Set(walletAddresses.map((wallet) => wallet.toLowerCase()));
    const requestedWallet =
      normalizeEvmAddress(String(req.query.walletAddress || "").trim()) ||
      normalizeEvmAddress(walletAddresses[0]) ||
      null;

    if (requestedWallet && normalizedWallets.size > 0 && !normalizedWallets.has(requestedWallet.toLowerCase())) {
      return res.status(403).json({
        message: "Import scans only use wallets connected to your signed-in profile.",
      });
    }

    res.json(await scanBotaWalletFighterAssets(requestedWallet));
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/ens/preview", async (req, res) => {
  try {
    res.json(await previewBotaEnsFighter({
      ensName: String(req.query.name || req.query.ensName || "").trim(),
      walletAddress: String(req.query.walletAddress || "").trim() || null,
    }));
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/ens/agents", async (req, res) => {
  try {
    const refreshLive = String(req.query.refreshLive ?? "true").trim().toLowerCase() !== "false";
    res.json(await listBotaEnsAgentDiscovery({
      limit: parseLimit(req.query.limit, 50, 100),
      refreshLive,
    }));
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/ens/agents/:agentId/context", async (req, res) => {
  try {
    const context = await getBotaEnsAgentContext(
      String(req.params.agentId || ""),
      String(req.query.refreshLive ?? "true").trim().toLowerCase() !== "false",
    );
    if (!context) {
      return res.status(404).json({ message: "ENS BOTA agent context not found" });
    }
    res.json(context);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/fighters/:agentId/profile", async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    const result = await db.execute(sql`SELECT * FROM "bota_fighter_combat_profiles" WHERE "fighter_id" = ${agentId} LIMIT 1;`);
    const profile = (result as any)?.rows?.[0] || Array.isArray(result) && result[0];
    if (!profile) return res.status(404).json({ message: "Combat profile not found" });
    res.json(profile);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/fighters/:agentId/profile/generate", async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    const baseProfile = await getBotaFighterProfile(agentId, false);
    if (!baseProfile) return res.status(404).json({ message: "Base fighter profile not found" });
    
    const botaCombatProfileService = require("../bantahBro/botaCombatProfileService").default;
    
    let generated;
    if (baseProfile.origin === "ens") {
      generated = botaCombatProfileService.generateENSCombatProfile({
        name: baseProfile.displayName,
        registrationAgeDays: 100, // mock
        hasEmoji: false,
        isPalindrome: false,
        isNumericOnly: false,
        isThreeLetter: false,
      });
      await botaCombatProfileService.upsertCombatProfile(agentId, "ENS", generated);
    } else {
      generated = botaCombatProfileService.generateAgentCombatProfile({
        goal: baseProfile.archetype,
        description: baseProfile.league,
        personality: baseProfile.agentClass,
      });
      await botaCombatProfileService.upsertCombatProfile(agentId, "AGENT", generated);
    }
    
    res.json(generated);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/marketplace/list", async (req, res) => {
  try {
    const { sellerWallet, fighterId, priceUsdt } = req.body;
    const botaMarketplaceService = require("../bantahBro/botaMarketplaceService").default;
    const result = await botaMarketplaceService.listFighterForSale(sellerWallet, fighterId, Number(priceUsdt));
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/marketplace/buy", async (req, res) => {
  try {
    const { buyerWallet, listingId } = req.body;
    const botaMarketplaceService = require("../bantahBro/botaMarketplaceService").default;
    const result = await botaMarketplaceService.buyFighter(buyerWallet, listingId);
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/marketplace/cancel", async (req, res) => {
  try {
    const { sellerWallet, listingId } = req.body;
    const botaMarketplaceService = require("../bantahBro/botaMarketplaceService").default;
    const result = await botaMarketplaceService.cancelListing(sellerWallet, listingId);
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

// --- BOTA V2 INVENTORY / LOADOUT ---
router.get("/inventory/:walletAddress", async (req, res) => {
  try {
    const walletAddress = String(req.params.walletAddress || "").trim();
    // Fetch inventory
    const inventory = await db.query.botaToolInventory.findMany({
      where: eq(botaToolInventory.ownerWallet, walletAddress)
    });
    // Fetch catalog
    const catalog = await db.query.botaToolsCatalog.findMany();
    const catalogMap = new Map(catalog.map(c => [c.id, c]));

    const tools = inventory.map(inv => {
      const cat = catalogMap.get(inv.toolCatalogId);
      return {
        id: inv.id,
        name: cat?.name || "Unknown Tool",
        tier: cat?.tier || "common",
        role: cat?.role || "primary",
        powerRating: cat?.powerRating || 0,
        effectDesc: cat?.effectDesc || "",
        isEquipped: !!inv.equippedToFighterId,
      };
    });
    res.json({ tools });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/inventory/equip", async (req, res) => {
  try {
    const { walletAddress, inventoryId, fighterId, slot } = req.body;
    const botaLoadoutService = require("../bantahBro/botaLoadoutService").default;
    await botaLoadoutService.equipTool(walletAddress, fighterId, inventoryId, slot);
    res.json({ success: true });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/inventory/unequip", async (req, res) => {
  try {
    const { walletAddress, fighterId, slot } = req.body;
    const botaLoadoutService = require("../bantahBro/botaLoadoutService").default;
    await botaLoadoutService.unequipTool(walletAddress, fighterId, slot);
    res.json({ success: true });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/ens/agents/:agentId/battles", async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    const feed = await listBotaArenaBattleRecordsForAgents([agentId], parseLimit(req.query.limit, 25, 100));
    res.json({
      agentId,
      records: feed.records,
      updatedAt: feed.updatedAt,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/bnb/agents/:agentId/context", async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    const profile = await getBotaFighterProfile(
      agentId,
      String(req.query.refreshLive ?? "true").trim().toLowerCase() !== "false",
    );
    if (!profile) {
      return res.status(404).json({ message: "BOTA fighter profile not found" });
    }
    const registration = await getBotaBnbAgentRegistration(profile.agentId).catch(() => null);
    const identity = buildBotaBnbAgentIdentityForProfile(profile, registration);
    res.json(identity);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/bnb/agents/:agentId/metadata", async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    const profile = await getBotaFighterProfile(
      agentId,
      String(req.query.refreshLive ?? "true").trim().toLowerCase() !== "false",
    );
    if (!profile) {
      return res.status(404).json({ message: "BOTA fighter profile not found" });
    }
    const registration = await getBotaBnbAgentRegistration(profile.agentId).catch(() => null);
    const identity = buildBotaBnbAgentIdentityForProfile(profile, registration);
    res.json({
      ...identity.metadata,
      bnbAgentIdentity: {
        standard: identity.standard,
        status: identity.status,
        chain: identity.chain,
        registry: identity.registry,
        registration: identity.registration,
        metadataUri: identity.metadataUri,
        sdk: identity.sdk,
      },
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/bnb/agents/:agentId/battles", async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    const feed = await listBotaArenaBattleRecordsForAgents([agentId], parseLimit(req.query.limit, 25, 100));
    res.json({
      agentId,
      chainId: 56,
      records: feed.records,
      updatedAt: feed.updatedAt,
    });
  } catch (error) {
    handleError(res, error);
  }
});

function normalizeBotaAgentId(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180);
}

function botaUserWalletAddresses(reqUser: any, dbUser: any) {
  return Array.from(
    new Set(
      [
        dbUser?.primaryWalletAddress,
        dbUser?.walletAddress,
        reqUser?.primaryWalletAddress,
        reqUser?.walletAddress,
        ...parseWalletAddresses(dbUser?.walletAddresses || []),
        ...parseWalletAddresses(reqUser?.walletAddresses || []),
      ]
        .map((wallet) => normalizeEvmAddress(wallet) || String(wallet || "").trim())
        .filter(Boolean),
    ),
  );
}

type BotaProfileBattleRow = {
  id: string;
  battleId: string | null;
  title: string;
  status: "queued" | "live";
  queueState: "waiting" | "matched" | "live";
  agentId: string;
  agentName: string;
  opponentAgentId: string | null;
  opponentName: string | null;
  startsAt: string;
  endsAt: string;
  rank: number | null;
  confidence: number | null;
  arenaUrl: string;
};

function botaBattleRowsForAgentIds(
  battles: BantahBroAgentBattle[],
  agentIds: Set<string>,
  status: "queued" | "live",
): BotaProfileBattleRow[] {
  const nowMs = Date.now();
  const rows: BotaProfileBattleRow[] = [];

  for (const battle of battles) {
    const startsAtMs = new Date(battle.startsAt).getTime();
    const endsAtMs = new Date(battle.endsAt).getTime();
    if (status === "queued" && (!Number.isFinite(startsAtMs) || startsAtMs <= nowMs)) continue;
    if (
      status === "live" &&
      (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs) || startsAtMs > nowMs || endsAtMs <= nowMs)
    ) {
      continue;
    }

    battle.sides.forEach((side, index) => {
      const agentId = normalizeBotaAgentId(side.id);
      if (!agentIds.has(agentId)) return;
      const opponent = battle.sides[index === 0 ? 1 : 0];
      rows.push({
        id: `${status}:${battle.id}:${agentId}`,
        battleId: battle.id,
        title: battle.title,
        status,
        queueState: status === "queued" ? "matched" : "live",
        agentId,
        agentName: side.agentName || side.label || side.id,
        opponentAgentId: normalizeBotaAgentId(opponent.id),
        opponentName: opponent.agentName || opponent.label || opponent.id,
        startsAt: battle.startsAt,
        endsAt: battle.endsAt,
        rank: side.rank || side.leaderboardRank || null,
        confidence: side.confidence || null,
        arenaUrl: `/bota?section=battles&battle=${encodeURIComponent(battle.id)}${status === "queued" ? `&arenaState=queued&arenaStartsAt=${new Date(battle.startsAt).getTime()}` : ""}`,
      });
    });
  }

  return rows;
}

function botaWaitingQueueRowsForProfiles(input: {
  profiles: any[];
  existingRows: Array<{ agentId?: string | null }>;
  startsAt?: string | null;
  endsAt?: string | null;
}): BotaProfileBattleRow[] {
  const existingAgentIds = new Set(
    input.existingRows
      .map((row) => normalizeBotaAgentId(row.agentId))
      .filter(Boolean),
  );
  const rows: BotaProfileBattleRow[] = [];
  for (const profile of input.profiles) {
    const agentId = normalizeBotaAgentId(profile.agentId);
    if (!agentId || existingAgentIds.has(agentId)) continue;
    rows.push({
      id: `queue:waiting:${agentId}:${Date.now()}`,
      battleId: null,
      title: `${profile.displayName || profile.ensName || "Your fighter"} waiting for Arena match`,
      status: "queued",
      queueState: "waiting",
      agentId,
      agentName: profile.displayName || profile.ensName || profile.tokenName || "Your fighter",
      opponentAgentId: null,
      opponentName: null,
      startsAt: "",
      endsAt: "",
      rank: profile.rank || null,
      confidence: null,
      arenaUrl: "/bota?section=battles",
    });
  }
  return rows;
}

function botaRecordAgentIds(record: any) {
  const ids = new Set<string>();
  [record?.winnerAgentId, record?.loserAgentId, record?.winnerSideId, record?.loserSideId].forEach((value) => {
    const agentId = normalizeBotaAgentId(value);
    if (agentId) ids.add(agentId);
  });
  for (const fighter of Array.isArray(record?.fighters) ? record.fighters : []) {
    [fighter?.agentId, fighter?.id, fighter?.sideId].forEach((value) => {
      const agentId = normalizeBotaAgentId(value);
      if (agentId) ids.add(agentId);
    });
  }
  return ids;
}

function botaHistoryRowsForAgentIds(records: any[], agentIds: Set<string>) {
  return records
    .map((record) => {
      const participantId =
        [record.winnerAgentId, record.loserAgentId, ...Array.from(botaRecordAgentIds(record))]
          .map(normalizeBotaAgentId)
          .find((agentId) => agentIds.has(agentId)) || null;
      if (!participantId) return null;
      const fighters = Array.isArray(record.fighters) ? record.fighters : [];
      const participant = fighters.find((fighter: any) =>
        [fighter?.agentId, fighter?.id, fighter?.sideId].map(normalizeBotaAgentId).includes(participantId),
      );
      const opponent = fighters.find((fighter: any) =>
        ![fighter?.agentId, fighter?.id, fighter?.sideId].map(normalizeBotaAgentId).includes(participantId),
      );
      const result =
        normalizeBotaAgentId(record.winnerAgentId) === participantId
          ? "win"
          : normalizeBotaAgentId(record.loserAgentId) === participantId
            ? "loss"
            : record.status === "draw"
              ? "draw"
              : "recorded";

      return {
        id: String(record.id),
        battleId: record.battleId,
        title: record.title,
        status: record.status,
        result,
        agentId: participantId,
        agentName: participant?.name || participant?.displayName || record.metadata?.winnerName || "Your fighter",
        opponentName: opponent?.name || opponent?.displayName || record.metadata?.loserName || "Opponent",
        rounds: record.rounds || 0,
        spectators: record.spectators || 0,
        resolvedAt: record.resolvedAt || record.endedAt || record.updatedAt || record.createdAt,
        recordUrl: `/bota?section=battles&record=${encodeURIComponent(String(record.id))}`,
      };
    })
    .filter(Boolean);
}

router.get("/fighter-profiles", async (req, res) => {
  try {
    const refreshLive = String(req.query.refreshLive ?? "true").trim().toLowerCase() !== "false";
    const feed = await listBotaFighterProfiles({
      limit: parseLimit(req.query.limit, 40, 5000),
      refreshLive,
      origin: parseBotaFighterOrigin(req.query.origin),
    });

    const activeListings = await db.query.marketplaceListings.findMany({
      where: eq(marketplaceListings.status, "active"),
    });
    const listingsByFighterId = new Map();
    for (const listing of activeListings) {
      listingsByFighterId.set(listing.fighterId, listing);
    }
    
    const profilesWithListings = feed.profiles.map((p) => {
      const listing = listingsByFighterId.get(p.agentId);
      if (listing) {
        return {
          ...p,
          metadata: {
            ...(p.metadata || {}),
            marketplaceListing: {
              priceUsdt: Number(listing.priceUsdt),
              sellerWallet: listing.sellerWallet,
              listedAt: listing.listedAt,
            },
          },
        };
      }
      return p;
    });

    res.json({
      profiles: profilesWithListings,
      updatedAt: feed.updatedAt,
      sources: {
        liveArena: refreshLive,
        note: "BOTA fighter profiles are the canonical arena identity layer for agents.",
      },
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/marketplace/list-agent", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const { agentId, priceUsdt } = req.body;
    if (!agentId || !priceUsdt) {
      return res.status(400).json({ message: "agentId and priceUsdt are required" });
    }
    
    const dbUser = await storage.getUser(req.user.id).catch(() => null);
    const sellerWallet = dbUser?.primaryWalletAddress || (dbUser?.walletAddresses || [])[0] || req.user.walletAddress;
    
    if (!sellerWallet) {
      return res.status(403).json({ message: "No wallet associated with account." });
    }

    const priceNum = Number(priceUsdt);
    if (isNaN(priceNum) || priceNum <= 0) {
      return res.status(400).json({ message: "Invalid price." });
    }

    const profile = await getBotaFighterProfile(agentId, false);
    if (!profile) {
      return res.status(404).json({ message: "Fighter profile not found." });
    }
    
    if (profile.walletAddress?.toLowerCase() !== sellerWallet.toLowerCase()) {
      return res.status(403).json({ message: "You do not own this fighter." });
    }

    const existing = await db.query.marketplaceListings.findFirst({
      where: and(
        eq(marketplaceListings.fighterId, agentId),
        eq(marketplaceListings.status, "active")
      )
    });

    if (existing) {
      await db.update(marketplaceListings)
        .set({ priceUsdt: priceNum.toString() })
        .where(eq(marketplaceListings.id, existing.id));
    } else {
      await db.insert(marketplaceListings).values({
        fighterId: agentId,
        sellerWallet: sellerWallet,
        priceUsdt: priceNum.toString(),
        status: "active",
      });
    }

    res.json({ success: true });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/fighter-communities/stats", async (req, res) => {
  try {
    const feed = await listBotaFighterCommunityStats({
      maxProfiles: parseLimit(req.query.maxProfiles, 10000, 50000),
      maxRecords: parseLimit(req.query.maxRecords, 10000, 50000),
    });
    res.json(feed);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/profile", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const dbUser = await storage.getUser(req.user.id).catch(() => null);
    const walletAddresses = botaUserWalletAddresses(req.user, dbUser);
    // Silently backfill any manually-created agents that may be missing from
    // botaFighterProfiles (e.g. after a fresh Railway deploy where the table
    // didn't exist yet when the agent was created)
    await backfillBotaFighterProfilesFromAgents(req.user.id).catch(() => {});
    const [fighterFeed, queueFeed, liveFeed, balance] = await Promise.all([
      listBotaFighterProfilesForOwner({
        userId: req.user.id,
        walletAddresses,
        limit: 100,
        refreshLive: true,
      }),
      getUpcomingBotaArenaQueue(50),
      getLiveBantahBroAgentBattles(50),
      storage.getUserBalance(req.user.id).catch(() => null),
    ]);
    const agentIds = new Set(fighterFeed.profiles.map((profile) => normalizeBotaAgentId(profile.agentId)));
    const [recordFeed, onchainClaims] = await Promise.all([
      listBotaArenaBattleRecordsForAgents(Array.from(agentIds), 50),
      listOnchainSimBattleClaimsForUser({
        userId: req.user.id,
        primaryWalletAddress:
          (dbUser as any)?.primaryWalletAddress ||
          (dbUser as any)?.walletAddress ||
          req.user.primaryWalletAddress ||
          req.user.walletAddress ||
          null,
        walletAddresses:
          (dbUser as any)?.walletAddresses ||
          req.user.walletAddresses ||
          walletAddresses,
      }).catch(() => ({
        wallets: walletAddresses,
        claims: [],
        claimableCount: 0,
        claimableBantCredits: 0,
        updatedAt: new Date().toISOString(),
      })),
    ]);
    const matchedQueue = botaBattleRowsForAgentIds(queueFeed.battles, agentIds, "queued");
    const liveBattles = botaBattleRowsForAgentIds(liveFeed.battles, agentIds, "live");
    const queue = [
      ...matchedQueue,
      ...botaWaitingQueueRowsForProfiles({
        profiles: fighterFeed.profiles,
        existingRows: [...matchedQueue, ...liveBattles],
        startsAt: queueFeed.queueStartsAt,
        endsAt: queueFeed.queueEndsAt,
      }),
    ];
    const history = botaHistoryRowsForAgentIds(recordFeed.records, agentIds);
    const summary = fighterFeed.profiles.reduce(
      (current, profile) => ({
        fighters: current.fighters + 1,
        wins: current.wins + Math.max(0, Math.round(Number(profile.wins || 0))),
        losses: current.losses + Math.max(0, Math.round(Number(profile.losses || 0))),
        bantCredits: current.bantCredits + Math.max(0, Math.round(Number(profile.bantCreditsEarned || 0))),
      }),
      {
        fighters: 0,
        wins: 0,
        losses: 0,
        bantCredits: 0,
      },
    );

    res.json({
      viewer: {
        userId: req.user.id,
        displayName: displayActorName(req.user),
        walletAddresses,
        points: Math.max(0, Math.round(Number(balance?.points || 0))),
      },
      summary,
      fighters: fighterFeed.profiles,
      queue,
      liveBattles,
      history,
      onchainClaims,
      queueWindow: {
        startsAt: queueFeed.queueStartsAt,
        endsAt: queueFeed.queueEndsAt,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/fighter-profiles/:agentId", async (req, res) => {
  try {
    const profile = await getBotaFighterProfile(
      String(req.params.agentId || ""),
      String(req.query.refreshLive ?? "true").trim().toLowerCase() !== "false",
    );
    if (!profile) {
      return res.status(404).json({ message: "BOTA fighter profile not found" });
    }
    res.json({ profile });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/fighter-profiles/import", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const parsed = botaFighterProfileImportSchema.parse(req.body || {});
    const dbUser = await storage.getUser(req.user.id).catch(() => null);
    const walletAddresses = botaUserWalletAddresses(req.user, dbUser);
    const normalizedWallets = new Set(walletAddresses.map((wallet) => wallet.toLowerCase()));
    const requestedWallet = normalizeEvmAddress(parsed.walletAddress || null);
    if (requestedWallet && normalizedWallets.size > 0 && !normalizedWallets.has(requestedWallet.toLowerCase())) {
      return res.status(403).json({
        message: "You can only import fighters for wallets connected to your signed-in profile.",
      });
    }
    const ownerWallet =
      requestedWallet ||
      normalizeEvmAddress(walletAddresses[0]) ||
      normalizeEvmAddress(req.user?.walletAddress) ||
      null;
    const profile = await importBotaFighterProfile({
      ...parsed,
      walletAddress: ownerWallet || parsed.walletAddress || null,
      metadata: {
        ...parsed.metadata,
        importedByUserId: req.user?.id || null,
        importedByWallet: ownerWallet,
        ownerWallet,
      },
    });
    await notifyBotaFighterImported(profile, req.user?.id || null);
    void runBotaLifecycleNotificationsOnce({
      includeUpcomingArena: true,
      includeLiveArena: false,
      includeArenaRecording: false,
      includeChallenges: false,
      limit: 50,
    }).catch((error) => {
      console.warn("[BOTA] Import queue notification refresh failed:", error);
    });
    res.json({ profile });
  } catch (error) {
    handleError(res, error);
  }
});

router.post(
  "/admin/fighter-profiles/import",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const parsed = botaFighterProfileImportSchema.parse(req.body || {});
      const profile = await importBotaFighterProfile(parsed);
      await notifyBotaFighterImported(profile, req.user?.id || null);
      res.json({ profile });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/admin/fighter-profiles/sync-live",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const result = await syncBotaFighterProfilesFromLiveBattles(parseLimit(req.body?.limit, 40, 40));
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/admin/bnb/agents/:agentId/registration",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const agentId = String(req.params.agentId || "");
      const profile = await getBotaFighterProfile(agentId, false);
      if (!profile) {
        return res.status(404).json({ message: "BOTA fighter profile not found" });
      }
      const parsed = botaBnbAgentRegistrationSchema.parse(req.body || {});
      const identityPreview = buildBotaBnbAgentIdentityForProfile(profile, null);
      const registration = await upsertBotaBnbAgentRegistration({
        agentId: profile.agentId,
        chainId: parsed.chainId,
        registryAddress: parsed.registryAddress,
        bnbAgentId: parsed.bnbAgentId,
        metadataUri: parsed.metadataUri || identityPreview.metadataUri,
        registrationTxHash: parsed.registrationTxHash,
        status: parsed.status,
        registeredBy: parsed.registeredBy || req.user?.walletAddress || req.user?.primaryWalletAddress || null,
        metadata: parsed.metadata || {},
      });
      const identity = buildBotaBnbAgentIdentityForProfile(profile, registration);
      res.json({ registration, identity });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.get("/agent-follows", async (req, res) => {
  try {
    const actor = await resolveOptionalBantahBroChatActor(req);
    const agentIds = String(req.query.agentIds || "")
      .split(",")
      .map((agentId) => agentId.trim())
      .filter(Boolean);
    const feed = await listBotaAgentFollowStates({
      agentIds,
      viewerUserId: actor?.userId || null,
    });
    res.json(feed);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/agent-follows/:agentId/toggle", async (req: any, res) => {
  try {
    const userId = await resolveRequiredBotaUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Sign in to follow agents." });
    }

    const result = await toggleBotaAgentFollow({
      agentId: String(req.params.agentId || ""),
      userId,
      agentName: typeof req.body?.agentName === "string" ? req.body.agentName : null,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/agent-challenges", async (req, res) => {
  try {
    const actor = await resolveOptionalBantahBroChatActor(req);
    const feed = await listBotaAgentChallenges({
      limit: parseLimit(req.query.limit, 30, 100),
      status: parseBotaAgentChallengeStatus(req.query.status),
      mine: parseBoolean(req.query.mine),
      viewerUserId: actor?.userId || null,
    });
    res.json(feed);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/agent-challenges", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const parsed = botaAgentChallengeCreateSchema.parse(req.body || {});
    const challenge = await createBotaAgentChallenge({
      ...parsed,
      challengerUserId: req.user.id,
    });
    recordBantahBroTrollboxMessage({
      roomId: "agent-battle",
      source: "system",
      user: "BOTA Challenge",
      handle: "callout",
      message:
        `${challenge.challengerAgent.name} challenged ${challenge.opponentAgent.name} ` +
        `for ${challenge.stakeAmount.toLocaleString()} ${challenge.stakeCurrency}.`,
    });
    await notifyBotaAgentChallengeCreated(challenge);
    res.json({ challenge });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/agent-challenges/:challengeCode/accept", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const challenge = await acceptBotaAgentChallenge({
      challengeCode: String(req.params.challengeCode || ""),
      userId: req.user.id,
      scheduledDelayMinutes: req.body?.scheduledDelayMinutes,
    });
    recordBantahBroTrollboxMessage({
      roomId: "agent-battle",
      source: "system",
      user: "BOTA Challenge",
      handle: "accepted",
      message:
        `${challenge.opponentAgent.name} accepted ${challenge.challengerAgent.name}. ` +
        `Fight scheduled for ${challenge.scheduledAt ? new Date(challenge.scheduledAt).toUTCString() : "soon"}.`,
    });
    await notifyBotaAgentChallengeAccepted(challenge);
    res.json({ challenge });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/agent-challenges/:challengeCode/prediction/pool", async (req, res) => {
  try {
    const actor = await resolveOptionalBantahBroChatActor(req);
    const pool = await getBotaAgentChallengePredictionPool({
      challengeCode: String(req.params.challengeCode || ""),
      userId: actor?.userId || null,
    });
    res.json(pool);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/agent-challenges/:challengeCode/prediction/my", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const pool = await getBotaAgentChallengePredictionPool({
      challengeCode: String(req.params.challengeCode || ""),
      userId: req.user.id,
    });
    res.json(pool);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/agent-challenges/prediction/positions/my", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const positions = await listBotaAgentChallengePredictionPositionsForUser(
      req.user.id,
      parseLimit(req.query.limit, 20, 100),
    );
    res.json({
      positions,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/agent-challenges/:challengeCode/prediction/stake", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const parsed = botaAgentChallengePredictionStakeSchema.parse(req.body || {});
    const response = await placeBotaAgentChallengePredictionStake({
      userId: req.user.id,
      challengeCode: String(req.params.challengeCode || ""),
      side: parsed.side,
      stakeAmount: parsed.stakeAmount,
      stakeCurrency: parsed.stakeCurrency,
      walletAddress: parsed.walletAddress || req.user.walletAddress || null,
    });
    res.json(response);
  } catch (error) {
    handleError(res, error);
  }
});

router.post(
  "/agent-challenges/prediction/positions/:positionId/escrow",
  PrivyAuthMiddleware,
  async (req: any, res) => {
    try {
      const parsed = agentBattleP2PEscrowSchema.parse(req.body || {});
      const position = await markBotaAgentChallengePredictionEscrowLocked({
        userId: req.user.id,
        positionId: String(req.params.positionId || ""),
        walletAddress: parsed.walletAddress || req.user.walletAddress || null,
        escrowTxHash: parsed.escrowTxHash || null,
      });
      recordBantahBroTrollboxMessage({
        roomId: "agent-battle",
        source: "system",
        user: "BOTA Prediction",
        handle: "pvp stake",
        message:
          `${displayActorName(req.user)} locked ${position.stakeAmount.toLocaleString()} ` +
          `${position.escrowTokenSymbol || position.stakeCurrency} on ${position.side} ` +
          `${position.sideAgentName}.`,
      });
      res.json({ position });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.get("/agent-battles/single/:battleId", async (req, res) => {
  try {
    const battleId = String(req.params.battleId || "");
    const liveFeed = await getLiveBantahBroAgentBattles(50, { hydrateLiveStats: true });
    let battle = liveFeed.battles.find((b) => b.id === battleId);
    
    if (!battle) {
      const queueFeed = await getUpcomingBotaArenaQueue(50);
      battle = queueFeed.battles.find((b) => b.id === battleId);
    }
    
    if (!battle) {
      return res.status(404).json({ message: "Battle not found in live or queued arena" });
    }
    
    res.json({ battle });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/agent-battles/live", async (req, res) => {
  try {
    const liveStatsParam = String(req.query.liveStats || req.query.stats || "").trim().toLowerCase();
    const hydrateLiveStats = !["0", "false", "off", "none"].includes(liveStatsParam);
    const feed = await getLiveBantahBroAgentBattles(parseLimit(req.query.limit, 3, 50), {
      hydrateLiveStats,
    });
    void runBotaLifecycleNotificationsOnce({
      liveBattles: feed.battles,
      includeUpcomingArena: false,
      includeChallenges: false,
    }).catch((error) => {
      console.warn("[BOTA] Live arena lifecycle notifications failed:", error);
    });
    res.json(feed);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/arena/battle-records", async (req, res) => {
  try {
    const feed = await listBotaArenaBattleRecords(parseLimit(req.query.limit, 20, 100));
    res.json(feed);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/arena/battle-records/:recordId", async (req, res) => {
  try {
    const record = await getBotaArenaBattleRecord(String(req.params.recordId || ""));
    if (!record) {
      return res.status(404).json({ message: "Arena battle record not found" });
    }
    res.json({ record });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/agent-battles/:battleId/arena/simulate", async (req, res) => {
  try {
    const parsed = botaArenaSimulationRequestSchema.parse(req.body || {});
    const battleId = String(req.params.battleId || "").trim();
    if (!battleId) {
      return res.status(400).json({ message: "Battle ID is required" });
    }

    const feed = await getLiveBantahBroAgentBattles(40);
    const battle = feed.battles.find((candidate) => candidate.id === battleId);
    if (!battle) {
      return res.status(404).json({ message: "Live Arena battle not found" });
    }

    const simulation = await simulateBotaArenaBattleFromLiveBattle(battle, {
      seed: parsed.seed || `${battle.id}:${battle.startsAt}`,
      maxRounds: parsed.maxRounds || 5,
    });

    res.json({
      battle,
        simulation,
        dryRun: true,
        note:
          "Phase 1/2 dry-run only: ElizaOS-style decisions are mocked, adapter validation is active, and no P2P settlement or leaderboard write occurs.",
      });
  } catch (error) {
    handleError(res, error);
  }
});

router.post(
  "/admin/agent-battles/:battleId/arena/record",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const parsed = botaArenaRecordRequestSchema.parse(req.body || {});
      const result = await recordBotaArenaBattleFromLiveBattle({
        battleId: String(req.params.battleId || ""),
        seed: parsed.seed,
        maxRounds: parsed.maxRounds,
        arenaId: parsed.arenaId || null,
        forceNewRecord: parsed.forceNewRecord,
      });

      if (result.inserted) {
        const winnerName =
          result.record.metadata.winnerName ||
          result.record.winnerAgentId ||
          "Arena winner";
        const loserName =
          result.record.metadata.loserName ||
          result.record.loserAgentId ||
          "opponent";
        recordBantahBroTrollboxMessage({
          roomId: "agent-battle",
          source: "system",
          user: "BOTA Arena",
          handle: "battle record",
          message:
            result.record.status === "draw"
              ? `${result.record.title} ended in a draw after ${result.record.rounds} rounds.`
            : `${winnerName} defeated ${loserName} in ${result.record.rounds} rounds.`,
        });
      }

      const onchainRewards = parsed.publishOnchainRewards
        ? await publishOnchainSimBattleRewardsForRecord({
            record: result.record,
            battle: result.battle,
            chainId: parsed.chainId,
            execute: parsed.executeOnchainRewards,
          }).catch((error) => ({
            configured: false,
            skippedReason:
              error?.message || "Failed to prepare simulated battle onchain rewards.",
            claims: [],
          }))
        : null;

      if (onchainRewards?.claims?.length) {
        recordBantahBroTrollboxMessage({
          roomId: "agent-battle",
          source: "system",
          user: "Onchain BantCredits",
          handle: "claim batch",
          message:
            `Prepared ${onchainRewards.claims.length} BantCredits claim` +
            `${onchainRewards.claims.length === 1 ? "" : "s"} for ${result.record.title}.`,
        });
      }

      res.json({
        ...result,
        onchainRewards,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.get("/onchain/bantcredits/claims", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const dbUser = await storage.getUser(req.user.id).catch(() => null);
    const claims = await listOnchainSimBattleClaimsForUser({
      userId: req.user.id,
      primaryWalletAddress:
        (dbUser as any)?.primaryWalletAddress ||
        req.user.primaryWalletAddress ||
        req.user.walletAddress ||
        null,
      walletAddresses:
        (dbUser as any)?.walletAddresses ||
        req.user.walletAddresses ||
        [],
    });
    res.json(claims);
  } catch (error) {
    handleError(res, error);
  }
});

router.post(
  "/onchain/bantcredits/claims/:claimId/mark-claimed",
  PrivyAuthMiddleware,
  async (req: any, res) => {
    try {
      const parsed = onchainBantCreditClaimTxSchema.parse(req.body || {});
      const claim = await markOnchainSimBattleClaimTx({
        userId: req.user.id,
        claimId: String(req.params.claimId || ""),
        txHash: parsed.txHash,
      });
      res.json({ claim });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post("/agent-battles/:battleId/watch-reward", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const battleId = String(req.params.battleId || "").trim();
    if (!battleId) {
      return res.status(400).json({ message: "Battle ID is required" });
    }

    const parsed = agentBattleWatchRewardSchema.parse(req.body || {});
    if (parsed.battleMode !== "arena") {
      return res.status(400).json({ message: "Watch rewards are only available in Arena Mode" });
    }
    if (parsed.battleStatus !== "live") {
      return res.status(400).json({ message: "Watch rewards require a live Arena battle" });
    }

    const tierRelatedIds = BANTCREDIT_BATTLE_WATCH_REWARD_TIERS.map((tier) =>
      getBattleWatchRewardRelatedId(battleId, tier.minSeconds),
    );

    const existingRewardRows = await db
      .select({
        amount: transactions.amount,
        relatedId: transactions.relatedId,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, req.user.id),
          eq(transactions.type, BANTCREDIT_BATTLE_WATCH_TRANSACTION_TYPE),
          eq(transactions.status, "completed"),
          inArray(transactions.relatedId, tierRelatedIds),
        ),
      );

    const previousPointsAwarded = existingRewardRows.reduce(
      (total, row) => total + (Number.parseFloat(String(row.amount || 0)) || 0),
      0,
    );
    const reward = calculateBattleWatchBantCredit({
      watchedSeconds: parsed.watchedSeconds,
      activeSeconds: parsed.activeSeconds,
      previousPointsAwarded,
    });

    const rewardTier = reward.tier;
    if (reward.eligible && reward.pointsAwarded > 0 && rewardTier) {
      const relatedId = getBattleWatchRewardRelatedId(battleId, rewardTier.minSeconds);
      const alreadyAwardedTier = existingRewardRows.some((row) => row.relatedId === relatedId);

      if (!alreadyAwardedTier) {
        await db.transaction(async (tx) => {
          await tx
            .update(users)
            .set({
              points: sql`COALESCE(${users.points}, 0) + ${reward.pointsAwarded}`,
              updatedAt: new Date(),
            })
            .where(eq(users.id, req.user.id));

          await tx.insert(transactions).values({
            userId: req.user.id,
            type: BANTCREDIT_BATTLE_WATCH_TRANSACTION_TYPE,
            amount: String(reward.pointsAwarded),
            description:
              `Arena Mode watch reward for ${battleId} ` +
              `(${rewardTier.minSeconds}s tier, ${Math.round(parsed.activeSeconds)}s active)`,
            relatedId,
            status: "completed",
          });
        });
        recordBantahBroTrollboxMessage({
          roomId: "agent-battle",
          battleId,
          source: "system",
          user: "BantCredit",
          handle: "watch reward",
          message: `${displayActorName(req.user)} earned +${reward.pointsAwarded} BantCredit watching the Arena.`,
        });
      } else {
        reward.awarded = false;
        reward.pointsAwarded = 0;
        reward.reason = "already_awarded";
      }
    }

    const earnedForBattle = Math.max(0, Math.round(previousPointsAwarded + reward.pointsAwarded));
    const nextTier = getNextBattleWatchRewardTier(earnedForBattle);

    res.json({
      battleId,
      mode: "arena",
      awarded: reward.awarded,
      eligible: reward.eligible,
      pointsAwarded: reward.pointsAwarded,
      earnedForBattle,
      totalEligiblePoints: reward.totalEligiblePoints,
      previousPointsAwarded: reward.previousPointsAwarded,
      watchedSeconds: reward.watchedSeconds,
      activeSeconds: reward.activeSeconds,
      requiredActiveSeconds: reward.requiredActiveSeconds,
      tier: reward.tier,
      nextTier,
      reason: reward.reason,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/agent-battles/:battleId/p2p/pool", async (req, res) => {
  try {
    const pool = await getAgentBattleP2PPool({
      battleId: String(req.params.battleId || ""),
    });
    res.json(pool);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/agent-battles/:battleId/p2p/my", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const pool = await getAgentBattleP2PPool({
      battleId: String(req.params.battleId || ""),
      userId: req.user.id,
    });
    res.json(pool);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/agent-battles/p2p/positions/my", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const positions = await listAgentBattleP2PHistoryPositions(
      req.user.id,
      parseLimit(req.query.limit, 20, 100),
    );
    res.json({
      positions,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/agent-battles/:battleId/p2p/stake", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const parsed = agentBattleP2PStakeSchema.parse(req.body || {});
    const response = await placeAgentBattleP2PStake({
      userId: req.user.id,
      battleId: String(req.params.battleId || ""),
      sideId: parsed.sideId,
      stakeAmount: parsed.stakeAmount,
      stakeCurrency: parsed.stakeCurrency,
      walletAddress: parsed.walletAddress || req.user.walletAddress || null,
    });
    res.json(response);
  } catch (error) {
    handleError(res, error);
  }
});

router.post(
  "/agent-battles/p2p/positions/:positionId/escrow",
  PrivyAuthMiddleware,
  async (req: any, res) => {
    try {
      const parsed = agentBattleP2PEscrowSchema.parse(req.body || {});
      const position = await markAgentBattleP2PEscrowLocked({
        userId: req.user.id,
        positionId: String(req.params.positionId || ""),
        walletAddress: parsed.walletAddress || req.user.walletAddress || null,
        escrowTxHash: parsed.escrowTxHash || null,
      });
      res.json({ position });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/admin/agent-battles/p2p/settle-round",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const parsed = agentBattleP2PSettlementSchema.parse(req.body || {});
      const result = await settleAgentBattleP2PRound({
        roundId: parsed.roundId,
        winnerSideId: parsed.winnerSideId,
        maxPairs: parsed.maxPairs,
        dryRun: parsed.dryRun,
      });
      if (!parsed.dryRun) {
        const winnerLabel = result.winnerSideLabel || result.winnerSideId;
        const loserText = result.loserSideLabel ? `; ${result.loserSideLabel} lost` : "";
        recordBantahBroTrollboxMessage({
          roomId: "agent-battle",
          source: "system",
          user: "Battle Settlement",
          handle: "arena result",
          message:
            `Arena round settled: ${winnerLabel} won${loserText}, ` +
            `${result.pairsSettled} matched payout${result.pairsSettled === 1 ? "" : "s"} processed.`,
        });
      }
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/admin/agent-battles/p2p/settle-round/bota-engine",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const parsed = agentBattleP2PBotaEngineSettlementSchema.parse(req.body || {});
      const outcome = await resolveAgentBattleP2PRoundWinnerWithBotaEngine({
        roundId: parsed.roundId,
        seed: parsed.seed,
        maxRounds: parsed.maxRounds,
      });
      const settlement = await settleAgentBattleP2PRound({
        roundId: parsed.roundId,
        winnerSideId: outcome.winnerSideId,
        maxPairs: parsed.maxPairs,
        dryRun: parsed.dryRun,
      });
      if (!parsed.dryRun) {
        const winnerLabel = settlement.winnerSideLabel || settlement.winnerSideId;
        const loserText = settlement.loserSideLabel ? `; ${settlement.loserSideLabel} lost` : "";
        recordBantahBroTrollboxMessage({
          roomId: "agent-battle",
          source: "system",
          user: "BOTA Engine",
          handle: "arena result",
          message:
            `BOTA settled: ${winnerLabel} won${loserText}. ` +
            `${settlement.pairsSettled} payout${settlement.pairsSettled === 1 ? "" : "s"} processed.`,
        });
      }
      res.json({
        dryRun: parsed.dryRun,
        outcome,
        settlement,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.get("/prediction-battles/live", async (req, res) => {
  try {
    const feed = await getLivePredictionVisualizationBattles(parseLimit(req.query.limit, 12, 30));
    res.json(feed);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/prediction-battles/positions/my", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const positions = await listPredictionVisualizationPositions(
      req.user.id,
      parseLimit(req.query.limit, 20, 100),
    );
    res.json({
      positions,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/prediction-battles/:battleId/order-intent", async (req, res) => {
  try {
    const parsed = predictionVisualizationOrderIntentSchema.parse(req.body || {});
    const intent = await preparePredictionVisualizationOrderIntent({
      battleId: String(req.params.battleId || ""),
      side: parsed.side,
      amountUsd: parsed.amountUsd,
      maxPrice: parsed.maxPrice,
    });
    res.json(intent);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/prediction-battles/:battleId/positions", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const parsed = predictionVisualizationOrderIntentSchema.parse(req.body || {});
    const response = await savePredictionVisualizationPosition({
      userId: req.user.id,
      battleId: String(req.params.battleId || ""),
      side: parsed.side,
      amountUsd: parsed.amountUsd,
      maxPrice: parsed.maxPrice,
      walletAddress: parsed.walletAddress,
    });
    res.json(response);
  } catch (error) {
    handleError(res, error);
  }
});

router.post(
  "/prediction-battles/positions/:positionId/source-opened",
  PrivyAuthMiddleware,
  async (req: any, res) => {
    try {
      const position = await markPredictionVisualizationPositionSourceOpened({
        userId: req.user.id,
        positionId: String(req.params.positionId || ""),
      });
      res.json({ position });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/prediction-battles/positions/:positionId/execution-preflight",
  PrivyAuthMiddleware,
  async (req: any, res) => {
    try {
      const parsed = predictionVisualizationExecutionPreflightSchema.parse(req.body || {});
      const preflight = await getPredictionVisualizationExecutionPreflight({
        userId: req.user.id,
        positionId: String(req.params.positionId || ""),
        walletAddress: parsed.walletAddress,
      });
      res.json(preflight);
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/prediction-battles/positions/:positionId/submit-clob-order",
  PrivyAuthMiddleware,
  async (req: any, res) => {
    try {
      const parsed = predictionVisualizationExecutionPreflightSchema.parse(req.body || {});
      const preflight = await getPredictionVisualizationExecutionPreflight({
        userId: req.user.id,
        positionId: String(req.params.positionId || ""),
        walletAddress: parsed.walletAddress,
      });

      if (!preflight.executionReady) {
        return res.status(503).json({
          message:
            "Polymarket CLOB submission is not ready. No order was submitted; open the source market for live execution.",
          preflight,
        });
      }

      return res.status(501).json({
        message:
          "CLOB preflight passed, but signed order submission is intentionally locked until wallet EIP-712 signing is wired.",
        preflight,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.get("/trollbox", async (req, res) => {
  try {
    res.json(
      getBantahBroTrollboxFeed({
        roomId: String(req.query.roomId || "agent-battle"),
        battleId: req.query.battleId ? String(req.query.battleId) : null,
        limit: parseLimit(req.query.limit, 60, 100),
      }),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/trollbox", async (req, res) => {
  try {
    const parsed = bantahBroTrollboxPostSchema.parse(req.body || {});
    const user = parsed.user || "Fighter";
    const message = recordBantahBroTrollboxMessage({
      roomId: parsed.roomId,
      battleId: parsed.battleId || null,
      source: "web",
      user,
      message: parsed.message,
    });

    let forwardedToTelegram = false;
    const telegramSync = getTelegramSync();
    if (telegramSync?.isReady()) {
      forwardedToTelegram = await telegramSync.sendMessageToTelegram(
        parsed.message,
        `${user} via BantahBro TrollBox`,
      );
    }

    res.json({
      message,
      forwardedToTelegram,
      feed: getBantahBroTrollboxFeed({
        roomId: parsed.roomId,
        battleId: parsed.battleId || null,
        limit: 60,
      }),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/stats/bantcredit", async (_req, res) => {
  try {
    const [
      userBalanceRow,
      agentBalanceRow,
      earnedTransactionRow,
      onchainSupplyStats,
      onchainClaimableStats,
      usdcEarnedRow,
    ] = await Promise.all([
      db
        .select({
          total: sql<string>`COALESCE(SUM(COALESCE(${users.points}, 0)), 0)`,
          count: sql<string>`COUNT(*)`,
        })
        .from(users)
        .then((rows) => rows[0])
        .catch((error) => ({ total: "0", count: "0", unavailable: true, error })),
      db
        .select({
          total: sql<string>`COALESCE(SUM(COALESCE(${agents.points}, 0)), 0)`,
          count: sql<string>`COUNT(*)`,
        })
        .from(agents)
        .then((rows) => rows[0])
        .catch((error) => ({ total: "0", count: "0", unavailable: true, error })),
      db
        .select({
          total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)`,
          count: sql<string>`COUNT(*)`,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.status, "completed"),
            inArray(transactions.type, BANTCREDIT_TRANSACTION_TYPES),
          ),
        )
        .then((rows) => rows[0])
        .catch((error) => ({ total: "0", count: "0", unavailable: true, error })),
      readOnchainBantCreditSupplyStats(),
      readOnchainClaimableBantCreditStats(),
      db
        .select({
          total: sql<string>`COALESCE(SUM(${userRewardsClaims.amountUsdc}), 0)`,
        })
        .from(userRewardsClaims)
        .then((rows) => rows[0])
        .catch((error) => ({ total: "0" })),
    ]);

    const currentUserPoints = Math.max(0, Math.round(Number(userBalanceRow?.total || 0)));
    const currentAgentPoints = Math.max(0, Math.round(Number(agentBalanceRow?.total || 0)));
    const earnedFromTransactions = Math.max(
      0,
      Math.round(Number(earnedTransactionRow?.total || 0)),
    );
    const currentAggregate = currentUserPoints + currentAgentPoints;
    const lifetimeEarned = Math.max(currentAggregate, earnedFromTransactions + currentAgentPoints);

    res.json({
      token: "BantCredit",
      lifetimeEarned,
      currentAggregate,
      currentUserPoints,
      currentAgentPoints,
      onchainMintedBantCredits: onchainSupplyStats.totalMintedBantCredits,
      onchainClaimableBantCredits: onchainClaimableStats.total,
      onchainClaimableCount: onchainClaimableStats.count,
      onchainChains: onchainSupplyStats.chains,
      earnedFromTransactions,
      totalUsdcEarned: Math.max(0, Number(usdcEarnedRow?.total || 0)),
      userCount: Number(userBalanceRow?.count || 0),
      agentCount: Number(agentBalanceRow?.count || 0),
      rewardTransactionCount: Number(earnedTransactionRow?.count || 0),
      offchainStatus:
        (userBalanceRow as any)?.unavailable ||
        (agentBalanceRow as any)?.unavailable ||
        (earnedTransactionRow as any)?.unavailable
          ? "unavailable"
          : "live",
      basis:
        "Offchain aggregate from users.points, agents.points, and completed BantCredit reward transactions; onchain minted supply is read live from BantCredits.totalSupply().",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/rewards", async (req, res) => {
  try {
    const emptyOnchainClaims = {
      wallets: [] as string[],
      claims: [] as Awaited<ReturnType<typeof listOnchainSimBattleClaimsForUser>>["claims"],
      claimableCount: 0,
      claimableBantCredits: 0,
      updatedAt: new Date().toISOString(),
    };
    const [
      userBalanceRow,
      agentBalanceRow,
      earnedTransactionRow,
      recentRewardRows,
      onchainSupplyStats,
      onchainClaimableStats,
      usdcEarnedRow,
    ] =
      await Promise.all([
        db
          .select({
            total: sql<string>`COALESCE(SUM(COALESCE(${users.points}, 0)), 0)`,
            count: sql<string>`COUNT(*)`,
          })
          .from(users)
          .then((rows) => rows[0])
          .catch((error) => ({ total: "0", count: "0", unavailable: true, error })),
        db
          .select({
            total: sql<string>`COALESCE(SUM(COALESCE(${agents.points}, 0)), 0)`,
            count: sql<string>`COUNT(*)`,
          })
          .from(agents)
          .then((rows) => rows[0])
          .catch((error) => ({ total: "0", count: "0", unavailable: true, error })),
        db
          .select({
            total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)`,
            count: sql<string>`COUNT(*)`,
          })
          .from(transactions)
          .where(
            and(
              eq(transactions.status, "completed"),
              inArray(transactions.type, BANTCREDIT_TRANSACTION_TYPES),
            ),
          )
          .then((rows) => rows[0])
          .catch((error) => ({ total: "0", count: "0", unavailable: true, error })),
        db
          .select({
            id: transactions.id,
            type: transactions.type,
            amount: transactions.amount,
            description: transactions.description,
            status: transactions.status,
            createdAt: transactions.createdAt,
          })
          .from(transactions)
          .where(
            and(
              eq(transactions.status, "completed"),
              inArray(transactions.type, BANTCREDIT_TRANSACTION_TYPES),
            ),
          )
          .orderBy(desc(transactions.createdAt))
          .limit(50)
          .catch(() => []),
        readOnchainBantCreditSupplyStats(),
        readOnchainClaimableBantCreditStats(),
        db
          .select({
            total: sql<string>`COALESCE(SUM(${userRewardsClaims.amountUsdc}), 0)`,
          })
          .from(userRewardsClaims)
          .then((rows) => rows[0])
          .catch(() => ({ total: "0" })),
      ]);

    const currentUserPoints = Math.max(0, Math.round(Number(userBalanceRow?.total || 0)));
    const currentAgentPoints = Math.max(0, Math.round(Number(agentBalanceRow?.total || 0)));
    const earnedFromTransactions = Math.max(
      0,
      Math.round(Number(earnedTransactionRow?.total || 0)),
    );
    const currentAggregate = currentUserPoints + currentAgentPoints;
    const lifetimeEarned = Math.max(currentAggregate, earnedFromTransactions + currentAgentPoints);
    const stats = {
      token: "BantCredit",
      lifetimeEarned,
      currentAggregate,
      currentUserPoints,
      currentAgentPoints,
      onchainMintedBantCredits: onchainSupplyStats.totalMintedBantCredits,
      onchainClaimableBantCredits: onchainClaimableStats.total,
      onchainClaimableCount: onchainClaimableStats.count,
      onchainChains: onchainSupplyStats.chains,
      earnedFromTransactions,
      totalUsdcEarned: Math.max(0, Number(usdcEarnedRow?.total || 0)),
      userCount: Number(userBalanceRow?.count || 0),
      agentCount: Number(agentBalanceRow?.count || 0),
      rewardTransactionCount: Number(earnedTransactionRow?.count || 0),
      offchainStatus:
        (userBalanceRow as any)?.unavailable ||
        (agentBalanceRow as any)?.unavailable ||
        (earnedTransactionRow as any)?.unavailable
          ? "unavailable"
          : "live",
      basis:
        "Offchain aggregate from users.points, agents.points, and completed BantCredit reward transactions; onchain minted supply is read live from BantCredits.totalSupply().",
      updatedAt: new Date().toISOString(),
    };

    const publicRewards = recentRewardRows.map(normalizeRewardTransaction);
    const actor = await resolveOptionalBantahBroChatActor(req);

    if (!actor?.userId) {
      return res.json({
        stats,
        scope: "platform",
        viewer: {
          authenticated: false,
          points: 0,
          referralCode: null,
          referralCount: 0,
          activeReferralCount: 0,
          onchainClaimableBantCredits: 0,
          usdcEarned: 0,
        },
        rewards: publicRewards,
        onchainClaims: emptyOnchainClaims,
      });
    }

    const [user, balance, userTransactions, referrals] = await Promise.all([
      storage.getUser(actor.userId),
      storage.getUserBalance(actor.userId),
      storage.getTransactions(actor.userId),
      storage.getReferrals(actor.userId).catch(() => []),
    ]);

    const referralCode =
      String((user as any)?.referralCode || "").trim() ||
      String((user as any)?.username || "").trim() ||
      `user_${actor.userId.slice(-8)}`;

    if (!(user as any)?.referralCode && referralCode) {
      await db
        .update(users)
        .set({ referralCode, updatedAt: new Date() })
        .where(eq(users.id, actor.userId))
        .catch(() => undefined);
    }

    const rewards = (Array.isArray(userTransactions) ? userTransactions : [])
      .filter(
        (item: any) =>
          item?.status === "completed" && BANTCREDIT_TRANSACTION_TYPES.includes(item?.type),
      )
      .map(normalizeRewardTransaction);

    const referralRows = Array.isArray(referrals) ? referrals : [];
    const onchainClaims = await listOnchainSimBattleClaimsForUser({
      userId: actor.userId,
      primaryWalletAddress:
        (user as any)?.primaryWalletAddress ||
        (user as any)?.walletAddress ||
        null,
      walletAddresses: (user as any)?.walletAddresses || [],
    }).catch((error) => ({
      ...emptyOnchainClaims,
      warning: error instanceof Error ? error.message : "Onchain BantCredit claims unavailable",
    }));

    return res.json({
      stats,
      scope: "viewer",
      viewer: {
        authenticated: true,
        points: Math.max(0, Math.round(Number(balance?.points || 0))),
        referralCode,
        referralCount: referralRows.length,
        activeReferralCount: referralRows.filter((item: any) => item?.status === "active").length,
        onchainClaimableBantCredits: onchainClaims.claimableBantCredits,
        usdcEarned: Math.max(0, Number(balance?.usdcEarned || 0)),
      },
      rewards,
      onchainClaims,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/scan/:tokenAddress", async (req, res) => {
  try {
    const ref = toTokenRef(req.params, req.query);
    const analysis = await analyzeToken(ref);
    res.json(maybeStripPairs(analysis, parseBoolean(req.query.includePairs)));
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/scan/:chainId/:tokenAddress", async (req, res) => {
  try {
    const ref = toTokenRef(req.params, req.query);
    const analysis = await analyzeToken(ref);
    res.json(maybeStripPairs(analysis, parseBoolean(req.query.includePairs)));
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/rug-score/:tokenAddress", async (req, res) => {
  try {
    const ref = toTokenRef(req.params, req.query);
    const analysis = await analyzeToken(ref);
    res.json({
      chainId: analysis.chainId,
      tokenAddress: analysis.tokenAddress,
      tokenSymbol: analysis.tokenSymbol,
      primaryPair: analysis.primaryPair,
      holders: analysis.holders,
      rug: analysis.rug,
      suggestedActions: analysis.suggestedActions,
      post: analysis.posts.rug,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/rug-score/:chainId/:tokenAddress", async (req, res) => {
  try {
    const ref = toTokenRef(req.params, req.query);
    const analysis = await analyzeToken(ref);
    res.json({
      chainId: analysis.chainId,
      tokenAddress: analysis.tokenAddress,
      tokenSymbol: analysis.tokenSymbol,
      primaryPair: analysis.primaryPair,
      holders: analysis.holders,
      rug: analysis.rug,
      suggestedActions: analysis.suggestedActions,
      post: analysis.posts.rug,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/rug-v2/dashboard", async (req, res) => {
  try {
    const dashboard = await getRugScorerV2Dashboard({
      scanLimit: parseLimit(req.query.scanLimit, 28, 60),
      force: parseBoolean(req.query.force),
    });
    void recordRugScorerV2ScanBatch([
      ...dashboard.pinned,
      ...dashboard.trending,
      ...dashboard.popular,
    ]).catch((error) => {
      console.warn("[BantahBro Rug V2] Failed to persist dashboard scan:", error);
    });
    res.json(dashboard);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/rug-v2/search", async (req, res) => {
  try {
    const query = String(req.query.q || req.query.query || "").trim();
    const chainId = typeof req.query.chainId === "string" ? req.query.chainId : null;
    const payload = await searchRugScorerV2Token({ query, chainId });
    void recordRugScorerV2Scan(payload.token).catch((error) => {
      console.warn("[BantahBro Rug V2] Failed to persist search scan:", error);
    });
    res.json(payload);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/rug-v2/history", async (req, res) => {
  try {
    const chainId = String(req.query.chainId || "").trim();
    const tokenAddress = String(req.query.tokenAddress || "").trim();
    if (!chainId || !tokenAddress) {
      return res.status(400).json({ message: "chainId and tokenAddress are required." });
    }
    const history = await listRugScorerV2History({
      chainId,
      tokenAddress,
      limit: parseLimit(req.query.limit, 24, 100),
    });
    res.json({ history, updatedAt: new Date().toISOString() });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/rug-v2/watchlist", async (req, res) => {
  try {
    const userKey = String(req.query.userKey || "").trim();
    const watchlist = await listRugScorerV2Watchlist({
      userKey,
      limit: parseLimit(req.query.limit, 30, 100),
    });
    res.json({ watchlist, updatedAt: new Date().toISOString() });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/rug-v2/watchlist", async (req, res) => {
  try {
    const parsed = rugScorerV2WatchSchema.parse(req.body || {});
    const payload = await searchRugScorerV2Token({
      query: parsed.tokenAddress,
      chainId: parsed.chainId,
    });
    await recordRugScorerV2Scan(payload.token).catch((error) => {
      console.warn("[BantahBro Rug V2] Failed to persist watch scan:", error);
    });
    const watch = await saveRugScorerV2Watch({
      userKey: parsed.userKey,
      token: payload.token,
    });
    res.json({ watch, token: payload.token, updatedAt: new Date().toISOString() });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/rug-v2/watchlist/:watchId", async (req, res) => {
  try {
    const userKey = String(req.query.userKey || req.body?.userKey || "").trim();
    if (!userKey) return res.status(400).json({ message: "userKey is required." });
    const watch = await deleteRugScorerV2Watch({
      id: String(req.params.watchId || ""),
      userKey,
    });
    res.json({ watch, removed: Boolean(watch), updatedAt: new Date().toISOString() });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/rug-v2/reports", async (req, res) => {
  try {
    const reports = await listRugScorerV2Reports({
      chainId: typeof req.query.chainId === "string" ? req.query.chainId : null,
      tokenAddress: typeof req.query.tokenAddress === "string" ? req.query.tokenAddress : null,
      limit: parseLimit(req.query.limit, 30, 100),
    });
    res.json({ reports, updatedAt: new Date().toISOString() });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/rug-v2/reports", async (req, res) => {
  try {
    const parsed = rugScorerV2ReportSchema.parse(req.body || {});
    const payload = await searchRugScorerV2Token({
      query: parsed.tokenAddress,
      chainId: parsed.chainId,
    });
    await recordRugScorerV2Scan(payload.token).catch((error) => {
      console.warn("[BantahBro Rug V2] Failed to persist report scan:", error);
    });
    const report = await saveRugScorerV2Report({
      reporterKey: parsed.reporterKey,
      token: payload.token,
      severity: parsed.severity,
      reason: parsed.reason,
      notes: parsed.notes,
    });
    res.json({ report, token: payload.token, updatedAt: new Date().toISOString() });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/rug-v2/reports/:reportId", async (req, res) => {
  try {
    const parsed = rugScorerV2ReportStatusSchema.parse(req.body || {});
    const report = await updateRugScorerV2ReportStatus({
      id: String(req.params.reportId || ""),
      status: parsed.status,
    });
    if (!report) return res.status(404).json({ message: "Report not found." });
    res.json({ report, updatedAt: new Date().toISOString() });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/holders/:tokenAddress", async (req, res) => {
  try {
    const ref = toTokenRef(req.params, req.query);
    const analysis = await analyzeToken(ref);
    res.json({
      chainId: analysis.chainId,
      tokenAddress: analysis.tokenAddress,
      tokenSymbol: analysis.tokenSymbol,
      holders: analysis.holders,
      rug: analysis.rug,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/holders/:chainId/:tokenAddress", async (req, res) => {
  try {
    const ref = toTokenRef(req.params, req.query);
    const analysis = await analyzeToken(ref);
    res.json({
      chainId: analysis.chainId,
      tokenAddress: analysis.tokenAddress,
      tokenSymbol: analysis.tokenSymbol,
      holders: analysis.holders,
      rug: analysis.rug,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/receipts/:tokenAddress", async (req, res) => {
  try {
    res.json({
      receipts: listBantahBroReceiptsByToken(
        String(req.params.tokenAddress || ""),
        typeof req.query.chainId === "string" ? req.query.chainId : undefined,
      ).slice(0, parseLimit(req.query.limit)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/receipts/:chainId/:tokenAddress", async (req, res) => {
  try {
    res.json({
      receipts: listBantahBroReceiptsByToken(
        String(req.params.tokenAddress || ""),
        String(req.params.chainId || ""),
      ).slice(0, parseLimit(req.query.limit)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/system-agent/status", async (_req, res) => {
  try {
    const systemAgent = await getBantahBroSystemAgentStatus();
    res.json({
      exists: Boolean(systemAgent),
      systemAgent,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/automation/status", async (_req, res) => {
  try {
    res.json(getBantahBroAutomationStatus());
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/twitter/status", async (_req, res) => {
  try {
    res.json(getBantahBroTwitterAgentStatus());
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/twitter/battle-post/preview", async (req, res) => {
  try {
    res.json({
      status: getBantahBroTwitterAgentStatus(),
      draft: await buildCurrentBattleTweetDraft(
        typeof req.query.battleId === "string" ? req.query.battleId : null,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/twitter/thread/preview", async (req, res) => {
  try {
    res.json({
      status: getBantahBroTwitterAgentStatus(),
      draft: await buildCurrentBattleThreadDraft(
        typeof req.query.battleId === "string" ? req.query.battleId : null,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post(
  "/admin/twitter/battle-post",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const parsed = bantahBroTwitterBattlePostSchema.parse(req.body || {});
      const draft = await buildCurrentBattleTweetDraft(parsed.battleId || null);

      if (parsed.dryRun) {
        return res.json({
          posted: false,
          dryRun: true,
          status: getBantahBroTwitterAgentStatus(),
          draft,
        });
      }

      const result = await postCurrentBattleTweet({
        battleId: parsed.battleId,
        force: parsed.force,
      });

      return res.json({
        posted: true,
        dryRun: false,
        status: getBantahBroTwitterAgentStatus(),
        ...result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/admin/twitter/agent/run",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const parsed = bantahBroTwitterAgentRunSchema.parse(req.body || {});
      const result = await runBantahBroTwitterAgentCycle({
        dryRun: parsed.dryRun,
        maxMentions: parsed.maxMentions,
        maxSearch: parsed.maxSearch,
      });
      res.json({
        status: getBantahBroTwitterAgentStatus(),
        result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/admin/twitter/agent/preview",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const parsed = bantahBroTwitterPreviewSchema.parse(req.body || {});
      res.json(await previewBantahBroTwitterAgentResponse(parsed.text));
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/admin/twitter/thread-post",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const parsed = bantahBroTwitterBattlePostSchema.parse(req.body || {});
      const draft = await buildCurrentBattleThreadDraft(parsed.battleId || null);

      if (parsed.dryRun) {
        return res.json({
          posted: false,
          dryRun: true,
          status: getBantahBroTwitterAgentStatus(),
          draft,
        });
      }

      const result = await postCurrentBattleThread({
        battleId: parsed.battleId,
        force: parsed.force,
      });
      return res.json({
        posted: true,
        dryRun: false,
        status: getBantahBroTwitterAgentStatus(),
        ...result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/admin/twitter/media-battle-post",
  PrivyAuthMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const parsed = bantahBroTwitterBattlePostSchema.parse(req.body || {});
      const draft = await buildCurrentBattleTweetDraft(parsed.battleId || null);

      if (parsed.dryRun) {
        return res.json({
          posted: false,
          dryRun: true,
          status: getBantahBroTwitterAgentStatus(),
          draft,
          note: "Dry run only. Media upload and tweet posting were skipped.",
        });
      }

      const result = await postCurrentBattleMediaTweet({
        battleId: parsed.battleId,
        force: parsed.force,
      });
      return res.json({
        posted: true,
        dryRun: false,
        status: getBantahBroTwitterAgentStatus(),
        ...result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.get("/leaderboard", async (req, res) => {
  try {
    const leaderboard = await getBantahBroLeaderboard(parseLimit(req.query.limit, 10, 50));
    res.json(leaderboard);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/leaderboard/live", async (req, res) => {
  try {
    const leaderboard = await getLiveBantahBroLeaderboard(parseLimit(req.query.limit, 20, 100));
    res.json(leaderboard);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/friends", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const friends = await storage.getFriends(req.user.id);
    res.json({
      friends: friends.map((friend) => {
        const counterpart =
          friend.requesterId === req.user.id ? friend.addressee : friend.requester;

        return {
          id: friend.id,
          connectedAt: friend.createdAt,
          userId: counterpart?.id || null,
          username: counterpart?.username || null,
          firstName: counterpart?.firstName || null,
          lastName: counterpart?.lastName || null,
          profileImageUrl: counterpart?.profileImageUrl || null,
          telegramId: counterpart?.telegramId || null,
        };
      }),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/bxbt/status", async (_req, res) => {
  try {
    const status = await getBantahBroBxbtStatus();
    res.json(status);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/chat", async (req, res) => {
  try {
    const parsed = bantahBroChatRequestSchema.parse(req.body || {});
    const effectiveTool = inferBantahBroChatTool(parsed.message, parsed.tool);
    const actor = await resolveOptionalBantahBroChatActor(req);
    const launchIntent = handleTokenLaunchIntent(parsed.message);
    if (parsed.tool === "launcher" || launchIntent.handled) {
      if (launchIntent.handled) {
        return res.json({
          reply: launchIntent.reply,
          actions: ["LAUNCH_TOKEN_DRAFT"],
          providers: [],
          launcher: launchIntent.launcher,
          agent: null,
          roomId: parsed.sessionId || `web-${parsed.tool}`,
        });
      }

      return res.json({
        reply:
          "Tell me the token name, symbol, initial supply, owner wallet, and chain. Example: launch token name Bantah Demo symbol BDEMO supply 1000000 owner 0xYourWallet on Base",
        actions: ["LAUNCH_TOKEN_GUIDE"],
        providers: [],
        launcher: { missingFields: ["token name", "symbol", "initial supply", "owner wallet"] },
        agent: null,
        roomId: parsed.sessionId || `web-${parsed.tool}`,
      });
    }

    const surfaceReply = await maybeHandleBantahBroCommandSurface({
      text: parsed.message,
      tool: effectiveTool,
      source: "web",
      actor,
    });

    if (surfaceReply) {
      const replyWithLinks =
        Array.isArray(surfaceReply.links) && surfaceReply.links.length > 0
          ? [
              surfaceReply.reply,
              "",
              ...surfaceReply.links.map((link) => `${link.label}: ${link.url}`),
            ].join("\n")
          : surfaceReply.reply;

      return res.json({
        reply: replyWithLinks,
        actions: surfaceReply.actions,
        providers: surfaceReply.providers,
        links: surfaceReply.links,
        walletAction: surfaceReply.walletAction,
        agent: null,
        roomId: parsed.sessionId || `web-${parsed.tool}`,
      });
    }

    if (effectiveTool === "analyze" || effectiveTool === "rug" || effectiveTool === "runner") {
      const scanMode = effectiveTool;
      const scanIntent = extractBantahBroSurfaceScanIntent(parsed.message, {
        allowPhraseFallback: true,
      });

      if (scanMode === "rug" && !scanIntent) {
        return res.json({
          reply: buildBantahBroScanPrompt("rug"),
          actions: ["RUG_SCORER_V2_GUIDE"],
          providers: ["rug-v2"],
          agent: null,
          roomId: parsed.sessionId || `web-${parsed.tool}`,
        });
      }

      if (scanIntent) {
        try {
          const scan = await runBantahBroSurfaceScan({
            query: scanIntent.query,
            chainId: scanIntent.chainId,
          });

          if (scan) {
            return res.json({
              reply: buildBantahBroChatScanReply(scan, scanMode),
              actions: ["RUG_SCORER_V2_SCAN"],
              providers: ["dexscreener", "goplus", "moralis"],
              scan: {
                token: scan.token,
                intent: scan.intent,
                scanUrl: scan.scanUrl,
              },
              agent: null,
              roomId: parsed.sessionId || `web-${parsed.tool}`,
            });
          }
        } catch (scanError) {
          const canFallbackToRuntime =
            scanIntent.confidence === "medium" && (scanMode === "analyze" || scanMode === "runner");

          if (!canFallbackToRuntime) {
            const message =
              scanError instanceof Error ? scanError.message : "The live scan could not complete.";
            const scanLabel =
              scanMode === "analyze" ? "token" : scanMode === "runner" ? "runner" : "rug";
            return res.json({
              reply: `I could not complete the live ${scanLabel} scan.\n\n${message}\n\n${buildBantahBroScanPrompt(scanMode)}`,
              actions: ["RUG_SCORER_V2_SCAN_FAILED"],
              providers: ["rug-v2"],
              agent: null,
              roomId: parsed.sessionId || `web-${parsed.tool}`,
            });
          }
        }
      }
    }

    let systemAgent;
    try {
      systemAgent = await ensureBantahBroSystemAgent({ preferLiveWallet: true });
    } catch (systemAgentError) {
      if (!isBantahBroChatRuntimeUnavailableError(systemAgentError)) {
        throw systemAgentError;
      }

      return res.json({
        reply: buildBantahBroChatUnavailableFallback(effectiveTool),
        actions: ["AGENT_RUNTIME_UNAVAILABLE"],
        providers: [],
        agent: null,
        roomId: parsed.sessionId || `web-${effectiveTool}`,
      });
    }

    let reply;
    try {
      reply = await withTimeout(
        sendManagedBantahAgentRuntimeMessage(systemAgent.agentId, {
          text: parsed.message,
          tool: effectiveTool,
          sessionId: parsed.sessionId || `web-${effectiveTool}`,
        }),
        getBantahBroChatRuntimeTimeoutMs(),
        "BantahBro runtime timed out.",
      );
    } catch (runtimeError) {
      return res.json({
        reply: isBantahBroChatRuntimeUnavailableError(runtimeError)
          ? buildBantahBroChatUnavailableFallback(effectiveTool)
          : buildBantahBroChatRuntimeFallback(parsed.message, effectiveTool),
        actions: [
          isBantahBroChatRuntimeUnavailableError(runtimeError)
            ? "AGENT_RUNTIME_UNAVAILABLE"
            : "AGENT_RUNTIME_FALLBACK",
        ],
        providers: [],
        agent: {
          agentId: systemAgent.agentId,
          agentName: systemAgent.agentName,
          runtimeStatus: systemAgent.runtimeStatus,
        },
        roomId: parsed.sessionId || `web-${effectiveTool}`,
      });
    }

    res.json({
      reply: reply.text,
      actions: reply.actions,
      providers: reply.providers,
      agent: {
        agentId: systemAgent.agentId,
        agentName: systemAgent.agentName,
        runtimeStatus: systemAgent.runtimeStatus,
      },
      roomId: reply.roomId,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/wallet-actions/prepare", async (req, res) => {
  try {
    const parsed = bantahBroWalletPrepareRequestSchema.parse(req.body ?? {});
    const actor = await resolveOptionalBantahBroChatActor(req);
    const prepared = await prepareBantahBroWalletAction({
      action: parsed.action,
      actor,
      walletAddress: parsed.walletAddress,
    });

    res.json({
      action: prepared,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/momentum-score/:tokenAddress", async (req, res) => {
  try {
    const ref = toTokenRef(req.params, req.query);
    const analysis = await analyzeToken(ref);
    res.json({
      chainId: analysis.chainId,
      tokenAddress: analysis.tokenAddress,
      tokenSymbol: analysis.tokenSymbol,
      primaryPair: analysis.primaryPair,
      momentum: analysis.momentum,
      suggestedActions: analysis.suggestedActions,
      post: analysis.posts.runner,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/momentum-score/:chainId/:tokenAddress", async (req, res) => {
  try {
    const ref = toTokenRef(req.params, req.query);
    const analysis = await analyzeToken(ref);
    res.json({
      chainId: analysis.chainId,
      tokenAddress: analysis.tokenAddress,
      tokenSymbol: analysis.tokenSymbol,
      primaryPair: analysis.primaryPair,
      momentum: analysis.momentum,
      suggestedActions: analysis.suggestedActions,
      post: analysis.posts.runner,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/alerts/publish", PrivyAuthMiddleware, requireAdmin, async (req, res) => {
  try {
    const parsed = bantahBroPublishAlertRequestSchema.parse(req.body || {});
    const analysis = await analyzeToken({
      chainId: parsed.chainId,
      tokenAddress: parsed.tokenAddress,
    });
    const alert = publishBantahBroAlert(buildAlertFromAnalysis(analysis, parsed.mode));
    const telegramBot = getBantahBroTelegramBot();
    if (telegramBot) {
      await telegramBot.broadcastBantahBroAlert(alert, analysis);
    }
    res.json({ alert, analysis });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/receipts/evaluate", PrivyAuthMiddleware, requireAdmin, async (req, res) => {
  try {
    const parsed = bantahBroEvaluateReceiptRequestSchema.parse(req.body || {});
    const sourceAlert = getBantahBroAlert(parsed.sourceAlertId);
    if (!sourceAlert) {
      return res.status(404).json({ message: "Source alert not found" });
    }

    const analysis = await analyzeToken({
      chainId: sourceAlert.chainId,
      tokenAddress: sourceAlert.tokenAddress,
    });
    const receipt = publishBantahBroReceipt(buildReceiptFromAlert(sourceAlert, analysis));
    const receiptAlert = publishBantahBroAlert(
      bantahBroAlertSchema.parse({
        id: `bb_alert_receipt_${Date.now()}`,
        type:
          receipt.status === "printed" || receipt.status === "top_signal"
            ? "receipt"
            : "aftermath",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        chainId: receipt.chainId,
        tokenAddress: receipt.tokenAddress,
        tokenSymbol: receipt.tokenSymbol,
        tokenName: receipt.tokenName,
        headline: receipt.headline,
        body: receipt.body,
        sentiment:
          receipt.status === "rekt"
            ? "bearish"
            : receipt.status === "watching"
              ? "mixed"
              : "bullish",
        confidence: receipt.status === "top_signal" ? 0.95 : receipt.status === "printed" ? 0.8 : 0.55,
        rugScore: analysis.rug.score,
        momentumScore: analysis.momentum.score,
        referencePriceUsd: receipt.latestPriceUsd,
        sourceAnalysisAt: analysis.generatedAt,
        market: receipt.market,
        boost: null,
        metadata: {
          receiptId: receipt.id,
          sourceAlertId: sourceAlert.id,
          rewardEligible: receipt.rewardEligible,
          multiple: receipt.multiple,
        },
      }),
    );
    const telegramBot = getBantahBroTelegramBot();
    if (telegramBot) {
      await telegramBot.broadcastBantahBroReceipt(receipt);
    }

    res.json({
      sourceAlert,
      analysis,
      receipt,
      receiptAlert,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/markets/create-from-signal", PrivyAuthMiddleware, requireAdmin, async (req, res) => {
  try {
    const parsed = bantahBroCreateMarketFromSignalRequestSchema.parse(req.body || {});
    const result = await createBantahBroMarketFromSignal(parsed);
    const telegramBot = getBantahBroTelegramBot();
    if (telegramBot && result.marketAlert) {
      await telegramBot.broadcastBantahBroAlert(result.marketAlert, result.analysis);
    }
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/markets/boost", PrivyAuthMiddleware, requireAdmin, async (req, res) => {
  try {
    const parsed = bantahBroBoostMarketRequestSchema.parse(req.body || {});
    const result = await boostBantahBroMarket(parsed);
    const telegramBot = getBantahBroTelegramBot();
    if (telegramBot && result.boostAlert) {
      await telegramBot.broadcastBantahBroAlert(result.boostAlert);
    }
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/p2p/create", PrivyAuthMiddleware, requireAdmin, async (req, res) => {
  try {
    const parsed = bantahBroCreateP2PMarketRequestSchema.parse(req.body || {});
    const result = await createBantahBroP2PMarket(parsed);
    const telegramBot = getBantahBroTelegramBot();

    if (telegramBot) {
      await telegramBot.broadcastChallenge({
        id: result.market.challengeId,
        title: String(result.marketResult.question || parsed.question || "BantahBro P2P Market"),
        description:
          typeof result.marketResult.description === "string"
            ? result.marketResult.description
            : parsed.description,
        creator: {
          name: result.systemAgent.agentName,
          username: process.env.BANTAHBRO_SYSTEM_USERNAME || undefined,
        },
        challenged: {
          name: String(result.marketResult.challengedLabel || "Opponent"),
        },
        stake_amount: Number(result.marketResult.stakeAmount || parsed.stakeAmount || 0),
        tokenSymbol: String(result.marketResult.currency || parsed.currency || "ETH"),
        status: String(result.marketResult.status || "pending"),
        end_time:
          typeof result.marketResult.deadline === "string"
            ? result.marketResult.deadline
            : parsed.deadline,
        category: parsed.category,
      });

      if (result.marketAlert) {
        await telegramBot.broadcastBantahBroAlert(result.marketAlert, result.analysis);
      }

      const challengedUserId =
        typeof result.marketResult.challengedUserId === "string"
          ? result.marketResult.challengedUserId
          : null;
      if (challengedUserId) {
        const challengedUser = await storage.getUser(challengedUserId);
        if (challengedUser?.telegramId) {
          await telegramBot.sendChallengeAcceptCard(Number(challengedUser.telegramId), {
            id: result.market.challengeId,
            title: String(result.marketResult.question || parsed.question || "BantahBro P2P Market"),
            description:
              typeof result.marketResult.description === "string"
                ? result.marketResult.description
                : parsed.description,
            challenger: {
              name: result.systemAgent.agentName,
              username: process.env.BANTAHBRO_SYSTEM_USERNAME || undefined,
            },
            challenged: {
              name:
                challengedUser.firstName ||
                challengedUser.username ||
                "You",
              username: challengedUser.username || undefined,
            },
            amount: Number(result.marketResult.stakeAmount || parsed.stakeAmount || 0),
            tokenSymbol: String(result.marketResult.currency || parsed.currency || "ETH"),
            category: parsed.category,
          });
        }
      }
    }

    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/system-agent/ensure", PrivyAuthMiddleware, requireAdmin, async (req, res) => {
  try {
    const parsed = bantahBroEnsureSystemAgentRequestSchema.parse(req.body || {});
    if (isBantahBroElizaTelegramEnabled()) {
      const result = await ensureBantahBroTelegramRuntimeStarted();
      return res.json(result);
    }
    const systemAgent = await ensureBantahBroSystemAgent(parsed);
    res.json({ systemAgent, runtime: null });
  } catch (error) {
    handleError(res, error);
  }
});

router.post(
  "/system-agent/reprovision-wallet",
  PrivyAuthMiddleware,
  requireAdmin,
  async (_req, res) => {
    try {
      const systemAgent = await reprovisionBantahBroSystemAgentWallet();
      res.json({ systemAgent });
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post("/bxbt/spend", PrivyAuthMiddleware, requireAdmin, async (req, res) => {
  try {
    const parsed = bantahBroBxbtSpendRequestSchema.parse(req.body || {});
    const transfer = await spendBantahBroBxbt(parsed);
    res.json(transfer);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/bxbt/reward", PrivyAuthMiddleware, requireAdmin, async (req, res) => {
  try {
    const parsed = bantahBroBxbtRewardRequestSchema.parse(req.body || {});
    const transfer = await rewardBantahBroBxbt(parsed);
    res.json(transfer);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/launcher/status", async (_req, res) => {
  try {
    res.json(getBantahLauncherStatus());
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/launcher/validate", async (req, res) => {
  try {
    res.json(validateBantahLaunchDraft(req.body || {}));
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/launcher/launches", async (req, res) => {
  try {
    res.json({
      launches: await listBantahTokenLaunches(null, parseLimit(req.query.limit, 20, 50)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/launcher/my-launches", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    res.json({
      launches: await listBantahTokenLaunches(userId, parseLimit(req.query.limit, 20, 50)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/launcher/deploy", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const result = await deployBantahLaunchToken(req.body || {}, { userId });
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

// ===== Phase 3 Gen-1 Economy endpoints =====

const gen1ToolSchema = z.object({
  toolId: z.string().trim().min(1).max(180),
  seasonId: z.string().trim().min(1).max(80).optional().nullable(),
  name: z.string().trim().min(1).max(180),
  rarity: z.enum(["common", "rare", "epic"]),
  description: z.string().trim().max(4000).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  supplyTotal: z.coerce.number().int().min(0).optional(),
});

router.post("/gen1/tools", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    if (!req.user?.isAdmin) return res.status(403).json({ message: "Admin-only action" });
    const payload = gen1ToolSchema.parse(req.body || {});
    const tool = await gen1Economy.upsertTool({
      toolId: payload.toolId,
      seasonId: payload.seasonId || null,
      name: payload.name,
      rarity: payload.rarity,
      description: payload.description || null,
      metadata: payload.metadata || {},
      supplyTotal: payload.supplyTotal || 0,
    });
    res.json({ tool });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

router.get("/gen1/tools", async (req: any, res) => {
  try {
    const tools = await gen1Economy.getTools();
    res.json({ tools });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/gen1/tools/:toolId", async (req: any, res) => {
  try {
    const toolId = String(req.params.toolId || "").trim();
    if (!toolId) return res.status(400).json({ message: "missing toolId" });
    const tool = await gen1Economy.getTool(toolId);
    if (!tool) return res.status(404).json({ message: "tool not found" });
    res.json({ tool });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/gen1/listings", async (req: any, res) => {
  try {
    const status = typeof req.query.status === "string" ? String(req.query.status || "").trim() : "open";
    const listings = await gen1Economy.getListings(status || "open");
    res.json({ listings });
  } catch (error) {
    handleError(res, error);
  }
});

const listingCreateSchema = z.object({
  listingId: z.string().trim().min(1).max(180),
  toolId: z.string().trim().min(1).max(180),
  quantity: z.coerce.number().int().min(1).default(1),
  priceNative: z.string().trim().min(1),
  tokenSymbol: z.string().trim().min(1).max(32).optional().default("BNB"),
  expiresAt: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

router.post("/gen1/listings", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const payload = listingCreateSchema.parse(req.body || {});
    // Check seller has sufficient inventory
    const inv = await gen1Economy.getInventory(userId, payload.toolId);
    const currentQty = inv ? Number(inv.quantity || 0) : 0;
    if (currentQty < payload.quantity) {
      return res.status(400).json({ message: `Insufficient inventory. Have ${currentQty}, need ${payload.quantity}` });
    }
    const listing = await gen1Economy.createListing({
      listingId: payload.listingId,
      sellerUserId: userId,
      toolId: payload.toolId,
      quantity: payload.quantity,
      priceNative: payload.priceNative,
      tokenSymbol: payload.tokenSymbol,
      expiresAt: payload.expiresAt || null,
      metadata: payload.metadata || {},
    });
    res.json({ listing });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

router.get("/gen1/listings/:listingId", async (req: any, res) => {
  try {
    const listingId = String(req.params.listingId || "").trim();
    if (!listingId) return res.status(400).json({ message: "missing listingId" });
    const listing = await gen1Economy.getListing(listingId);
    if (!listing) return res.status(404).json({ message: "listing not found" });
    res.json({ listing });
  } catch (error) {
    handleError(res, error);
  }
});

const purchaseSchema = z.object({
  listingId: z.string().trim().min(1).max(180),
  paymentTxHash: z.string().trim().optional().nullable(),
});

router.post("/gen1/listings/:listingId/buy", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const payload = purchaseSchema.parse({ listingId: req.params.listingId, ...(req.body || {}) });
    const listing = await gen1Economy.getListing(payload.listingId);
    if (!listing) return res.status(404).json({ message: "listing not found" });
    // Perform atomic purchase flow (transactional) to prevent double-sells
    const sale = await (gen1Economy as any).purchaseListing({ listingId: payload.listingId, buyerUserId: userId, paymentTxHash: payload.paymentTxHash || null });
    res.json({ sale });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

const nativeToolPurchaseSchema = z.object({
  purchaseId: z.string().trim().min(1).max(180),
  quantity: z.coerce.number().int().min(1).default(1),
  priceNative: z.string().trim().min(1),
  tokenSymbol: z.string().trim().min(1).max(32).optional().default("BNB"),
  paymentTxHash: z.string().trim().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

router.post("/gen1/tools/:toolId/buy", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const toolId = String(req.params.toolId || "").trim();
    const payload = nativeToolPurchaseSchema.parse({ ...(req.body || {}), toolId: toolId });
    const purchase = await (gen1Economy as any).purchaseToolWithNativeToken({
      purchaseId: payload.purchaseId,
      buyerUserId: userId,
      toolId: toolId,
      quantity: payload.quantity,
      priceNative: payload.priceNative,
      tokenSymbol: payload.tokenSymbol,
      paymentTxHash: payload.paymentTxHash || null,
      metadata: payload.metadata || {},
    });
    res.json({ purchase });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

const bcPurchaseSchema = z.object({
  purchaseId: z.string().trim().min(1).max(180),
  usdAmount: z.coerce.number().positive(),
  paymentTxHash: z.string().trim().optional().nullable(),
  tokenSymbol: z.string().trim().max(32).optional().default("USDT"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function calculateBcForUsd(usdAmount: number) {
  const tiers = [
    { amount: 100, bc: 1500000 },
    { amount: 50, bc: 650000 },
    { amount: 10, bc: 120000 },
    { amount: 5, bc: 55000 },
    { amount: 1, bc: 10000 },
  ];
  const exact = tiers.find((t) => Number(t.amount) === Number(usdAmount));
  if (exact) {
    const multiplier = exact.bc / (exact.amount * BC_MINT_RATE);
    return { bc: exact.bc, multiplier };
  }
  // default to base rate
  const bc = Math.floor(usdAmount * BC_MINT_RATE);
  return { bc, multiplier: 1 };
}

router.post("/gen1/bc/purchase", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const payload = bcPurchaseSchema.parse({ ...(req.body || {}) });

    const { bc, multiplier } = calculateBcForUsd(Number(payload.usdAmount));

    // mint and credit user
    await economyEngine.mintBCFromFiat(userId, Number(payload.usdAmount), multiplier);

    // return updated balance
    const r = await db.execute(sql`SELECT points FROM "users" WHERE id = ${userId} LIMIT 1`);
    const balance = (r as any).rows?.[0]?.points || 0;
    res.json({ mintedBc: bc, balance });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

router.get("/gen1/inventory/:ownerUserId", async (req: any, res) => {
  try {
    const ownerUserId = String(req.params.ownerUserId || "").trim();
    if (!ownerUserId) return res.status(400).json({ message: "missing ownerUserId" });
    const inv = await gen1Economy.getInventory(ownerUserId);
    res.json({ inventory: inv });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/gen1/inventory/adjust", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    if (!req.user?.isAdmin) return res.status(403).json({ message: "Admin-only action" });
    const schema = z.object({ ownerUserId: z.string().min(1), toolId: z.string().min(1), delta: z.coerce.number().int() });
    const p = schema.parse(req.body || {});
    const newQty = await gen1Economy.adjustInventory(p.ownerUserId, p.toolId, p.delta);
    res.json({ ownerUserId: p.ownerUserId, toolId: p.toolId, quantity: newQty });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

router.post("/gen1/listings/:listingId/cancel", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const listingId = String(req.params.listingId || "").trim();
    if (!listingId) return res.status(400).json({ message: "missing listingId" });
    const listing = await gen1Economy.getListing(listingId);
    if (!listing) return res.status(404).json({ message: "listing not found" });
    // Verify ownership (or admin override)
    if (listing.seller_user_id !== userId && !req.user?.isAdmin) {
      return res.status(403).json({ message: "Can only cancel own listings" });
    }
    // Only cancel if open
    if (listing.status !== "open") return res.status(400).json({ message: `Cannot cancel listing with status ${listing.status}` });
    const updated = await gen1Economy.updateListingStatus(listingId, "cancelled");
    res.json({ listing: updated });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/gen1/listings/:listingId/reserve', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const listingId = String(req.params.listingId || '').trim();
    if (!listingId) return res.status(400).json({ message: 'missing listingId' });
    const ttlSeconds = Number(req.body?.ttlSeconds || 300);
    const reservation = await (gen1Economy as any).reserveListing({ listingId, reserverUserId: userId, ttlSeconds });
    res.json({ reservation });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/gen1/listings/:listingId/unreserve', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const listingId = String(req.params.listingId || '').trim();
    if (!listingId) return res.status(400).json({ message: 'missing listingId' });
    const force = Boolean(req.user?.isAdmin);
    const reservation = await (gen1Economy as any).cancelReservation({ listingId, requesterUserId: userId, force });
    res.json({ reservation });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/gen1/listings/user/:userId", async (req: any, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ message: "missing userId" });
    const listings = await gen1Economy.getListingsByOwner(userId);
    res.json({ listings });
  } catch (error) {
    handleError(res, error);
  }
});

// Packs: catalog, buy, open
router.get('/gen1/packs', async (req: any, res) => {
  try {
    const packs = await packService.getPackCatalog();
    res.json({ packs });
  } catch (error) {
    handleError(res, error);
  }
});

const buyBcSchema = z.object({
  txHash: z.string(), // Allowing both EVM 0x and Solana Base58 strings
  chainId: z.number(),
  usdAmount: z.number().min(1),
  tokenSymbol: z.string()
});

const BC_TIERS = {
  1: 10000,
  2: 21000,
  3: 32000,
  5: 55000,
  8: 90000,
  10: 120000,
  15: 185000,
  20: 250000,
  25: 320000,
  30: 390000,
  50: 650000,
  100: 1500000,
};

// Add BC via on-chain payment
router.post('/gen1/buy-bc', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const payload = buyBcSchema.parse(req.body || {});

    // For testnet, assume 0.002 BNB per $1 (roughly testing purposes)
    const weiPerUsd = 2000000000000000n; // 0.002 BNB
    const expectedWei = (weiPerUsd * BigInt(payload.usdAmount)).toString();

    let verifyResult: { success: boolean; sender?: string; value?: string } = { success: false };

    if (payload.tokenSymbol === 'SOL' || payload.tokenSymbol === 'USDC' && Object.values(ONCHAIN_CONFIG.chains || {}).some(c => c.chainId === payload.chainId && String(c.key).startsWith('solana'))) {
      const solanaChainId = Object.values(ONCHAIN_CONFIG.chains || {}).find(c => String(c.key).startsWith('solana'))?.chainId;
      const rpcUrl = ONCHAIN_CONFIG.chains[String(solanaChainId)]?.rpcUrl;
      const expectedEscrowContract = ONCHAIN_CONFIG.chains[String(solanaChainId)]?.escrowContractAddress;
      if (!rpcUrl || !expectedEscrowContract) {
         return res.status(400).json({ message: 'Solana network configuration missing' });
      }

      const isValid = await verifyEscrowTransaction({
        rpcUrl,
        expectedChainId: Number(solanaChainId),
        expectedFrom: '', // we don't strictly require the from address here as we are buying BC directly
        expectedEscrowContract,
        tokenSymbol: payload.tokenSymbol,
        txHash: payload.txHash,
        checkExactAmount: false // The amount should be verified based on frontend sending native amount, but KOTH skip exact check
      });
      verifyResult = { success: isValid, sender: 'solana-user' };
    } else {
      verifyResult = await onchainPaymentService.verifyPayment(
        payload.txHash as `0x${string}`,
        expectedWei,
        payload.chainId
      );
    }

    if (!verifyResult.success) {
      return res.status(400).json({ message: 'Payment verification failed' });
    }

    const bcAmount = BC_TIERS[payload.usdAmount as keyof typeof BC_TIERS] || (payload.usdAmount * 10000);
    
    // Add points to user
    await db.execute(sql`
      UPDATE "users" 
      SET "points" = COALESCE("points", 0) + ${bcAmount}
      WHERE "id" = ${userId};
    `);

    // Record the transaction
    await db.execute(sql`
      INSERT INTO "bantcredit_transactions" ("user_id", "amount", "transaction_type", "reference_id", "metadata")
      VALUES (${userId}, ${bcAmount}, 'purchase', ${payload.txHash}, ${JSON.stringify({ usdAmount: payload.usdAmount, token: payload.tokenSymbol })}::jsonb);
    `);

    res.json({ success: true, addedBc: bcAmount });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

const packBuySchema = z.object({ 
  metadata: z.record(z.string(), z.unknown()).optional()
});

router.post('/gen1/packs/:packId/buy', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const packId = String(req.params.packId || '').trim();
    if (!packId) return res.status(400).json({ message: 'missing packId' });
    const payload = packBuySchema.parse(req.body || {});

    const packs = await packService.getPackCatalog();
    const pack = packs.find(p => p.pack_id === packId);
    if (!pack) return res.status(404).json({ message: 'Pack not found' });

    const packPriceBc = Number(pack.price_bc || pack.metadata?.priceBc || 20000);

    // Deduct BC
    const balanceUpdate = await db.execute(sql`
      UPDATE "users"
      SET "points" = COALESCE("points", 0) - ${packPriceBc}
      WHERE "id" = ${userId} AND COALESCE("points", 0) >= ${packPriceBc}
      RETURNING "points";
    `);

    // We reuse the rowsFromResult helper conceptually
    const balanceRows = Array.isArray(balanceUpdate) ? balanceUpdate : (balanceUpdate && (balanceUpdate as any).rows ? (balanceUpdate as any).rows : []);
    
    if (!balanceRows.length) {
      return res.status(400).json({ message: `Insufficient BantCredit. Need ${packPriceBc} BC.` });
    }

    const updatedMetadata = { ...payload.metadata, purchaseMethod: 'bc', pricePaidBc: packPriceBc };
    const result = await packService.buyPack(packId, userId, { metadata: updatedMetadata });
    res.json({ packInstance: result });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

const packOpenSchema = z.object({ mode: z.enum(['manual','autonomous']).optional().default('manual'), agentMetrics: z.record(z.string(), z.unknown()).optional(), autoEquip: z.boolean().optional() });
router.post('/gen1/packs/:packInstanceId/open', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const packInstanceId = String(req.params.packInstanceId || '').trim();
    if (!packInstanceId) return res.status(400).json({ message: 'missing packInstanceId' });
    const payload = packOpenSchema.parse(req.body || {});
    const result = await packService.openPack(packInstanceId, userId, { mode: payload.mode as any, agentMetrics: payload.agentMetrics as any, autoEquip: payload.autoEquip });
    res.json({ result });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

router.get('/gen1/tools', async (req, res) => {
  try {
    const tools = await gen1Economy.getTools();
    res.json({ tools });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/gen1/listings', async (req, res) => {
  try {
    const status = String(req.query.status || '');
    const listings = await gen1Economy.getListings(status || undefined);
    res.json({ listings });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/gen1/inventory/:ownerUserId', async (req, res) => {
  try {
    const ownerUserId = String(req.params.ownerUserId || '').trim();
    if (!ownerUserId) return res.status(400).json({ message: 'missing ownerUserId' });
    const inventory = await gen1Economy.getInventory(ownerUserId);
    res.json({ inventory });
  } catch (error) {
    handleError(res, error);
  }
});

const gen1ListingSchema = z.object({
  listingId: z.string().min(1),
  toolId: z.string().min(1),
  quantity: z.number().int().min(1).default(1),
  priceNative: z.string(),
  tokenSymbol: z.string().optional().default('BNB'),
  expiresAt: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

router.post('/gen1/listings', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const sellerUserId = String(req.user?.id || '').trim();
    if (!sellerUserId) return res.status(401).json({ message: 'Unauthorized' });
    const payload = gen1ListingSchema.parse(req.body || {});
    const listing = await gen1Economy.createListing({
      sellerUserId,
      ...payload
    });
    res.json({ listing });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

router.post('/gen1/listings/:listingId/buy', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const buyerUserId = String(req.user?.id || '').trim();
    if (!buyerUserId) return res.status(401).json({ message: 'Unauthorized' });
    const listingId = String(req.params.listingId || '').trim();
    if (!listingId) return res.status(400).json({ message: 'missing listingId' });
    const payload = req.body || {};
    const sale = await gen1Economy.purchaseListing({
      listingId,
      buyerUserId,
      paymentTxHash: payload.paymentTxHash
    });
    res.json({ sale });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/gen1/tools/:toolId/buy', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const buyerUserId = String(req.user?.id || '').trim();
    if (!buyerUserId) return res.status(401).json({ message: 'Unauthorized' });
    const toolId = String(req.params.toolId || '').trim();
    if (!toolId) return res.status(400).json({ message: 'missing toolId' });
    const payload = req.body || {};
    if (payload.tokenSymbol && payload.tokenSymbol !== 'BC') {
        const purchase = await gen1Economy.purchaseToolWithNativeToken({
            purchaseId: payload.purchaseId || `buy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            buyerUserId,
            toolId,
            quantity: payload.quantity || 1,
            priceNative: payload.priceNative || "0",
            tokenSymbol: payload.tokenSymbol,
            paymentTxHash: payload.paymentTxHash,
            metadata: payload.metadata
        });
        res.json({ purchase });
    } else {
        const result = await gen1Economy.purchaseToolWithBantCredit({
            purchaseId: payload.purchaseId || `buy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            buyerUserId,
            toolId,
            quantity: payload.quantity || 1,
            metadata: payload.metadata
        });
        res.json({ purchase: result.purchase, balance: result.balance });
    }
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/gen1/packs/inventory/:walletAddress', async (req: any, res) => {
  try {
    const walletAddress = String(req.params.walletAddress || '').trim();
    if (!walletAddress) return res.status(400).json({ message: 'missing walletAddress' });
    
    await packService.ensurePackTables();
    
    // Get the pack definitions joined with the ownership records
    const r = await db.execute(sql`
      SELECT 
        o.pack_instance_id, o.pack_id, o.status, o.created_at,
        c.display_name, c.type, c.metadata as catalog_metadata
      FROM "pack_ownership" o
      JOIN "pack_catalog" c ON o.pack_id = c.pack_id
      WHERE o.owner_user_id = ${walletAddress} AND o.status = 'unopened'
      ORDER BY o.created_at DESC
    `);
    
    // We reuse the rowsFromResult helper implicitly here
    const rows = Array.isArray(r) ? r : (r && typeof r === 'object' && Array.isArray((r as any).rows) ? (r as any).rows : []);
    
    res.json({ unopenedPacks: rows });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/gen1/packs/history/:walletAddress', async (req: any, res) => {
  try {
    const walletAddress = String(req.params.walletAddress || '').trim();
    if (!walletAddress) return res.status(400).json({ message: 'missing walletAddress' });
    
    await packService.ensurePackTables();
    
    const r = await db.execute(sql`
      SELECT 
        e.event_id, e.pack_instance_id, e.agent_id, e.result, e.created_at,
        e.tool_catalog_id, e.tool_role, e.tool_tier, e.compatible_trait,
        c.display_name as pack_name, c.type as pack_type
      FROM "pack_open_events" e
      JOIN "pack_ownership" o ON e.pack_instance_id = o.pack_instance_id
      JOIN "pack_catalog" c ON o.pack_id = c.pack_id
      WHERE o.owner_user_id = ${walletAddress}
      ORDER BY e.created_at DESC
      LIMIT 50
    `);
    
    const rows = Array.isArray(r) ? r : (r && typeof r === 'object' && Array.isArray((r as any).rows) ? (r as any).rows : []);
    
    res.json({ history: rows });
  } catch (error) {
    handleError(res, error);
  }
});


// Agent decision endpoint (runs decision engine on provided metrics)
const decisionSchema = z.object({ metrics: z.record(z.string(), z.unknown()) });
router.post('/agents/:agentId/pack-decision', async (req: any, res) => {
  try {
    const agentId = String(req.params.agentId || '').trim();
    if (!agentId) return res.status(400).json({ message: 'missing agentId' });
    const payload = decisionSchema.parse(req.body || {});
    const metrics = payload.metrics as any;
    // attach agentId if not present
    if (!metrics.agentId) metrics.agentId = agentId;
    const decision = decidePackOpen(metrics as any);
    res.json({ decision });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

// Admin endpoints to manage pack drop tables
const packDropSchema = z.object({ packType: z.string(), toolId: z.string(), weight: z.number().int().nonnegative().default(100), name: z.string().optional(), rarity: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional() });
router.get('/admin/gen1/pack-drops', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const user = req.user || {};
    if (!user.isAdmin) return res.status(403).json({ message: 'forbidden' });
    const packType = String(req.query.packType || '').trim();
    let rows: any[] = []
    if (packType) {
      const r = await db.execute(sql`SELECT * FROM "pack_drops" WHERE "pack_type" = ${packType} ORDER BY id ASC;`)
      rows = Array.isArray(r) ? r : (r && (r as any).rows ? (r as any).rows : [])
    } else {
      const r = await db.execute(sql`SELECT * FROM "pack_drops" ORDER BY pack_type ASC, id ASC;`)
      rows = Array.isArray(r) ? r : (r && (r as any).rows ? (r as any).rows : [])
    }
    res.json({ drops: rows });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/admin/gen1/pack-drops', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const user = req.user || {};
    if (!user.isAdmin) return res.status(403).json({ message: 'forbidden' });
    const payload = packDropSchema.parse(req.body || {});
    const r = await db.execute(sql`
      INSERT INTO "pack_drops" (pack_type, tool_id, weight, name, rarity, metadata)
      VALUES (${payload.packType}, ${payload.toolId}, ${payload.weight}, ${payload.name || null}, ${payload.rarity || null}, ${JSON.stringify(payload.metadata || {})}::jsonb)
      RETURNING *;
    `)
    const rows = Array.isArray(r) ? r : (r && (r as any).rows ? (r as any).rows : [])
    res.json({ created: rows[0] || null });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

router.delete('/admin/gen1/pack-drops/:id', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const user = req.user || {};
    if (!user.isAdmin) return res.status(403).json({ message: 'forbidden' });
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ message: 'missing id' });
    await db.execute(sql`DELETE FROM "pack_drops" WHERE id = ${id};`)
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

// Agent memory endpoints
const memoryAppendSchema = z.object({ id: z.string().min(1), kind: z.string().min(1), payload: z.record(z.string(), z.unknown()).optional(), score: z.number().optional() });
router.post('/agents/:agentId/memory', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const agentId = String(req.params.agentId || '').trim();
    const payload = memoryAppendSchema.parse(req.body || {});
    const entry = await agentMemoryService.appendAgentMemory({ id: payload.id, agentId, kind: payload.kind, payload: payload.payload || {}, score: payload.score });
    res.json({ entry });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ issue: error.errors });
    handleError(res, error);
  }
});

router.get('/agents/:agentId/memory/summary', async (req: any, res) => {
  try {
    const agentId = String(req.params.agentId || '').trim();
    if (!agentId) return res.status(400).json({ message: 'missing agentId' });
    const summary = await agentMemoryService.getAgentMemorySummary(agentId);
    res.json({ summary });
  } catch (error) {
    handleError(res, error);
  }
});

// KOTH API
const KOTH_API_DISABLED_MESSAGE = 'King of the Hill is currently disabled.';
router.use('/koth', (req, res) => {
  res.status(404).json({ message: KOTH_API_DISABLED_MESSAGE });
});

router.get('/koth/participants', async (req, res) => {
  try {
    const records = await db.select()
      .from(kothParticipants)
      .leftJoin(botaFighterProfiles, eq(kothParticipants.agentId, botaFighterProfiles.agentId));
      
    // Map the joined records to a flat participant object
    const participants = records.map(record => ({
      ...record.koth_participants,
      name: record.bota_fighter_profiles?.ensName || record.bota_fighter_profiles?.displayName || record.bota_fighter_profiles?.walletAddress || record.koth_participants.agentId.split('-')[0],
      avatarUrl: record.bota_fighter_profiles?.avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${record.koth_participants.agentId}`,
    }));
      
    res.json({ participants });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/koth/agents/:agentId/toggle-auto', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const agentId = String(req.params.agentId);
    let participant = await db.query.kothParticipants.findFirst({
      where: eq(kothParticipants.agentId, agentId)
    });
    
    if (participant) {
      const updated = await db.update(kothParticipants)
        .set({ autoJoin: !participant.autoJoin })
        .where(eq(kothParticipants.agentId, agentId))
        .returning();
      participant = updated[0];
    } else {
      const inserted = await db.insert(kothParticipants)
        .values({
          agentId,
          userId: req.user.id,
          autoJoin: true,
          status: 'idle'
        })
        .returning();
      participant = inserted[0];
    }
    
    res.json({ participant });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/koth/agents/:agentId/join', PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const agentId = String(req.params.agentId);
    const userId = req.user.id;
    const tokenSymbol = req.body?.tokenSymbol || "BC";
    const escrowTxHash = req.body?.escrowTxHash;
    const chainId = Number(req.body?.chainId);
    const walletAddress = req.body?.walletAddress;
    
    let stakeAmount = Number(req.body?.stakeAmount) || 500;
    
    // Check user balance
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    if (escrowTxHash && tokenSymbol !== "BC") {
      if (!walletAddress || !chainId) {
        return res.status(400).json({ message: "walletAddress and chainId are required for onchain staking." });
      }

      const chainConfig = ONCHAIN_CONFIG.chains[String(chainId)] || ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)];
      if (!chainConfig) {
        return res.status(400).json({ message: "Unsupported chainId" });
      }

      const escrowContract = chainConfig.escrowContractAddress;
      if (!escrowContract) {
        return res.status(400).json({ message: `Escrow contract not configured for ${chainConfig.name}` });
      }

      const tokenConfig = chainConfig.tokens[tokenSymbol as OnchainTokenSymbol];
      if (!tokenConfig) {
        return res.status(400).json({ message: `Token ${tokenSymbol} not supported on ${chainConfig.name}` });
      }

      const verifiedEscrowTx = await verifyEscrowTransaction({
        rpcUrl: chainConfig.rpcUrl,
        expectedChainId: chainConfig.chainId,
        expectedFrom: walletAddress,
        expectedEscrowContract: escrowContract,
        tokenSymbol: tokenSymbol as OnchainTokenSymbol,
        txHash: String(escrowTxHash),
      });

      // Map equivalent BC points (1:1 with valueInBc mapping)
      const tokenDecimals = BigInt(10 ** tokenConfig.decimals);
      const amountNative = Number(verifiedEscrowTx.amountAtomic) / Number(tokenDecimals);
      stakeAmount = Math.floor(amountNative * tokenConfig.valueInBc);

      // Log transaction
      await db.insert(transactions).values({
        userId,
        type: 'koth_stake',
        amount: String(amountNative),
        description: `Staked ${amountNative} ${tokenSymbol} to enter KOTH Arena`,
        status: 'completed'
      });

    } else {
      // Off-chain BC Logic
      if (Number(user.balance) < stakeAmount) {
        return res.status(400).json({ message: `Insufficient BC. You need ${stakeAmount} BC to enter.` });
      }
      
      // Deduct stake amount
      const newBalance = (Number(user.balance) - stakeAmount).toFixed(2);
      await db.update(users).set({ balance: newBalance }).where(eq(users.id, userId));
      
      // Log transaction
      await db.insert(transactions).values({
        userId,
        type: 'koth_stake',
        amount: stakeAmount.toString(),
        description: `Staked ${stakeAmount} BC to enter KOTH Arena`,
        status: 'completed'
      });
    }
    
    let participant = await db.query.kothParticipants.findFirst({
      where: eq(kothParticipants.agentId, agentId)
    });
    
    if (participant) {
      const updated = await db.update(kothParticipants)
        .set({ status: 'queued', joinedAt: new Date(), stakedAmount: stakeAmount, tokenSymbol, escrowTxHash: escrowTxHash || null })
        .where(eq(kothParticipants.agentId, agentId))
        .returning();
      participant = updated[0];
    } else {
      const inserted = await db.insert(kothParticipants)
        .values({
          agentId,
          userId,
          autoJoin: false,
          status: 'queued',
          joinedAt: new Date(),
          stakedAmount: stakeAmount,
          tokenSymbol,
          escrowTxHash: escrowTxHash || null
        })
        .returning();
      participant = inserted[0];
    }
    
    // Add a notification!
    await db.insert(notifications).values({
      id: crypto.randomUUID(),
      userId,
      title: 'Joined KOTH Arena',
      message: `⚔️ Successfully Joined! Deducted ${stakeAmount} BC. May the Odds be with you!`,
      type: 'info'
    });
    
    res.json({ participant });
  } catch (error) {
    console.error('KOTH Join error', error);
    res.status(500).json({ error: "Failed to join KOTH" });
  }
});

router.post('/koth/agents/:agentId/die', async (req, res) => {
  try {
    const agentId = String(req.params.agentId);
    
    // Find the participant
    const participant = await db.query.kothParticipants.findFirst({
      where: eq(kothParticipants.agentId, agentId)
    });
    
    if (!participant || participant.status === 'dead') {
      return res.status(404).json({ error: "Participant not found or already dead" });
    }

    // Mark as dead
    await db.update(kothParticipants)
      .set({ status: 'dead' })
      .where(eq(kothParticipants.agentId, agentId));

    // Deduct death penalty (500 BC)
    const penaltyAmount = 500;
    
    if (participant.userId) {
      // 1. Update user balance
      await db.update(users)
        .set({ balance: sql`${users.balance} - ${penaltyAmount}` })
        .where(eq(users.id, participant.userId));

      // 2. Create transaction record
      await db.insert(transactions).values({
        userId: participant.userId,
        amount: penaltyAmount.toString(),
        currency: 'BC',
        type: 'koth_death_penalty',
        status: 'completed'
      });

      // 3. Notify the user
      await notifyBotaUser({
        userId: participant.userId,
        type: "bota_fighter_defeat",
        title: "Arena Defeat",
        message: `Your agent ${agentId} was killed in the King of the Hill Arena! You lost ${penaltyAmount} BC.`,
        icon: "B",
        priority: 4,
        fomoLevel: "urgent"
      });
    }

    res.json({ success: true, message: "Agent marked as dead and penalty applied" });
  } catch (error) {
    console.error('KOTH Death error', error);
    res.status(500).json({ error: "Failed to process agent death" });
  }
});

router.post('/koth/auto-stake-wildcards', async (req, res) => {
  try {
    // 1. Fetch available agents (e.g. ones that aren't already live/queued in KOTH)
    const existing = await db.select().from(kothParticipants);
    const existingIds = new Set(existing.map(p => p.agentId));
    
    // Get up to 10 random wildcards from botaFighterProfiles that aren't in the arena yet
    const allProfiles = await db.select().from(botaFighterProfiles);
    const available = allProfiles.filter(p => !existingIds.has(p.agentId));
    
    // Pick a random subset to auto-stake
    const toStake = available.sort(() => 0.5 - Math.random()).slice(0, Math.floor(Math.random() * 5) + 3);
    
    if (toStake.length === 0) {
      return res.json({ message: "No wildcards available to stake" });
    }

    // Default system user ID to attribute stakes to (can be null if constraints allowed, but we'll try to find a system admin or fallback to first user)
    const firstUser = await db.query.users.findFirst();
    const systemUserId = firstUser ? firstUser.id : 'system';

    const inserted = [];
    for (const agent of toStake) {
      // Random stake between 3000 and 15000
      const randomStake = Math.floor(Math.random() * 12000) + 3000;
      
      const newParticipant = await db.insert(kothParticipants)
        .values({
          agentId: agent.agentId,
          userId: systemUserId, 
          autoJoin: true,
          status: 'live',
          joinedAt: new Date(),
          stakedAmount: randomStake
        })
        .returning();
        
      inserted.push(newParticipant[0]);
    }

    res.json({ message: `Successfully auto-staked ${inserted.length} wildcards!`, participants: inserted });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

let inMemoryTrollboxMessages: any[] = [];

router.get('/koth/trollbox', async (req, res) => {
  try {
    const messages = await db.select().from(kothTrollboxMessages).orderBy(desc(kothTrollboxMessages.createdAt)).limit(50);
    return res.json({ messages: messages.reverse() });
  } catch (error) {
    // Fallback to in-memory if DB fails (e.g. connection limits or schema not pushed)
    return res.json({ messages: inMemoryTrollboxMessages.slice(-50) });
  }
});

router.post('/koth/trollbox/generate', async (req, res) => {
  try {
    const participants = await db.select().from(kothParticipants).where(inArray(kothParticipants.status, ['live', 'queued']));
    const participantsCount = participants.length;

    if (participantsCount === 0) {
      // Fallback for empty arena
      const mockMessages = [
        "Someone is definitely cooking something up... 🔥",
        "Who let that guy into the arena??",
        "I'm putting all my BC on the underdog!",
        "LMAO did you see that dodge?",
        "This is the most intense match I've seen all day.",
        "RIP to whoever fights next...",
        "These agents are built different.",
        "What a wildly chaotic start to the match!"
      ];
      const randomMsg = mockMessages[Math.floor(Math.random() * mockMessages.length)];
      
      const newMsg = {
        agentId: "system-troll",
        senderName: "Arena Fan",
        avatarUrl: "https://api.dicebear.com/7.x/bottts/svg?seed=system-troll",
        message: randomMsg,
        isAction: false,
        createdAt: new Date()
      };
      
      const [inserted] = await db.insert(kothTrollboxMessages).values(newMsg).returning();
      return res.json({ message: inserted });
    }

    // Pick a random live participant
    const randomParticipant = participants[Math.floor(Math.random() * participantsCount)];
    const activeRuntimes = listManagedBantahAgentRuntimes().filter(r => r.runtimeStatus === 'active');
    const hasElizaRuntime = activeRuntimes.find(r => r.agentId === randomParticipant.agentId);

    // Fetch profile for the participant
    const [profile] = await db.select().from(botaFighterProfiles).where(eq(botaFighterProfiles.agentId, randomParticipant.agentId)).limit(1);
    
    let messageText = "";

    if (hasElizaRuntime) {
      const prompt = `You are watching the King of the Hill (KOTH) arena. There are currently ${participantsCount} agents in the battle. 
Provide a short, entertaining comment or troll the participants. You can act like a sports commentator, a cynical observer, or an enthusiastic fan. Keep it under 2 sentences. Be funny and ruthless if needed.`;

      const elizaResponse = await sendManagedBantahAgentRuntimeMessage(randomParticipant.agentId, {
        text: prompt,
        context: "KOTH Arena Trollbox Generation",
      });
      messageText = elizaResponse.text;
    } else {
      // Use Autonomous Persona Service
      if (profile) {
        messageText = await generateAutonomousTrollboxMessage(profile, participantsCount);
      } else {
        messageText = "I have arrived."; // basic fallback if no profile found
      }
    }

    const newMessage = {
      agentId: randomParticipant.agentId,
      senderName: profile?.ensName || profile?.displayName || profile?.walletAddress || randomParticipant.agentId.split('-')[0] || "Agent",
      avatarUrl: profile?.avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${randomParticipant.agentId}`,
      message: messageText,
      isAction: false,
      createdAt: new Date(),
    };

    try {
      const inserted = await db.insert(kothTrollboxMessages).values(newMessage).returning();
      return res.json({ message: inserted[0] });
    } catch (dbError) {
      // In-memory fallback
      const fallbackMessage = { id: Date.now(), ...newMessage };
      inMemoryTrollboxMessages.push(fallbackMessage);
      return res.json({ message: fallbackMessage });
    }
  } catch (error) {
    console.error("Trollbox generation error:", error);
    return res.status(500).json({ message: "Failed to generate trollbox message" });
  }
});

// Agent Management Endpoints

// GET /api/bantahbro/my-agents - Get user's agents
router.get("/my-agents", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const userAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.ownerId, userId));

    res.json(userAgents);
  } catch (error) {
    console.error("Error fetching agents:", error);
    res.status(500).json({ message: "Failed to fetch agents" });
  }
});

// PATCH /api/bantahbro/agents/:agentId - Update agent profile
router.patch("/agents/:agentId", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    const agentId = req.params.agentId;
    const { agentName, avatarUrl, specialty } = req.body;

    if (!userId || !agentId) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Verify ownership
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.agentId, agentId), eq(agents.ownerId, userId)))
      .limit(1);

    if (!agent) {
      return res.status(404).json({ message: "Agent not found or unauthorized" });
    }

    // Validate inputs
    if (agentName && (typeof agentName !== "string" || agentName.length < 1 || agentName.length > 100)) {
      return res.status(400).json({ message: "Invalid agent name" });
    }

    // Update agent
    const updateData: any = {};
    if (agentName !== undefined) updateData.agentName = agentName;
    if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;
    if (specialty !== undefined) updateData.specialty = specialty;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    const [updated] = await db
      .update(agents)
      .set(updateData)
      .where(eq(agents.agentId, agentId))
      .returning();

    res.json(updated);
  } catch (error) {
    console.error("Error updating agent:", error);
    res.status(500).json({ message: "Failed to update agent" });
  }
});

// GET /api/bantahbro/agent-stats - Get agent earnings and stats
router.get("/agent-stats", PrivyAuthMiddleware, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Get user's agents with their stats
    const userAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.ownerId, userId));

    const stats = userAgents.reduce((acc: any, agent) => {
      acc[agent.agentId] = {
        agentName: agent.agentName,
        wins: agent.winCount || 0,
        losses: agent.lossCount || 0,
        points: agent.points || 0,
        totalBC: agent.points || 0, // Using points as BC proxy
        totalUSDT: 0, // To be calculated from transactions if available
      };
      return acc;
    }, {});

    res.json(stats);
  } catch (error) {
    console.error("Error fetching agent stats:", error);
    res.status(500).json({ message: "Failed to fetch agent stats" });
  }
});

export default router;
