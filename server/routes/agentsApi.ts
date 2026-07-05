import { randomUUID } from "crypto";
import { Router, type Request, type Response } from "express";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { ZodError } from "zod";
import {
  agentImportRequestSchema,
  agentListQuerySchema,
  agentCreateRequestSchema,
  agentOfferingsResponseSchema,
  agentSkillCheckRequestSchema,
  agentFollowStateResponseSchema,
  agentLeaderboardResponseSchema,
  agentRankResponseSchema,
  agentRuntimeStateResponseSchema,
  agentWalletSendRequestSchema,
  agentWalletSendResponseSchema,
  agentWalletProvisionResponseSchema,
  bantahAgentKitSupportedChainIds,
  getBantahAgentKitNetworkIdForChainId,
  getBantahAgentKitChainIdForNetworkId,
  type AgentRegistryProfile,
} from "@shared/agentApi";
import {
  agentActionEnvelopeSchema,
  BANTAH_SKILL_VERSION,
  checkBalanceInputSchema,
  createMarketInputSchema,
  joinMarketInputSchema,
  readMarketInputSchema,
} from "@shared/agentSkill";
import { agents, botaFighterProfiles, challenges, pairQueue, users } from "@shared/schema";
import {
  normalizeOnchainTokenSymbol,
  toAtomicUnits,
  type OnchainChainConfig,
  type OnchainTokenSymbol,
} from "@shared/onchainConfig";
import { storage } from "../storage";
import { db } from "../db";
import { createPairingEngine } from "../pairingEngine";
import { runAgentSkillCheck } from "../agentSkillCheck";
import { PrivyAuthMiddleware } from "../privyAuth";
import { verifyPrivyToken } from "../privyAuth";
import { normalizeEvmAddress } from "@shared/onchainConfig";
import { getOnchainServerConfig } from "../onchainConfig";
import {
  buildBantahElizaCharacter,
  buildBantahElizaRuntimeConfig,
} from "../elizaAgentBuilder";
import {
  executeManagedBantahAgentRuntimeAction,
  getManagedBantahAgentRuntime,
  listManagedBantahAgentRuntimes,
  restartManagedBantahAgentRuntime,
  startManagedBantahAgentRuntime,
  stopManagedBantahAgentRuntime,
} from "../bantahElizaRuntimeManager";
import {
  BantahAgentWalletError,
  buildBantahAgentEndpointUrl,
  executeBantahAgentEscrowStakeTx,
  getBantahAgentWalletBalance,
  sendBantahAgentWalletTransfer,
  buildSkillErrorEnvelope,
  buildSkillSuccessEnvelope,
  DEFAULT_BANTAH_AGENT_SKILLS,
  provisionBantahAgentWallet,
} from "../agentProvisioning";
import { assertAllowedStakeToken } from "../onchainEscrowService";
import { serializeBantahSkillError } from "../bantahAgentSkillExecutor";
import { createAndPushAgentOwnerNotification } from "../agentNotificationService";
import { ensureBotaFighterProfilesTable } from "../bantahBro/botaFighterProfileService";
import agentTradingController from "../modules/agent-trading/controllers/agentTradingController";

const router = Router();
const MAX_AGENT_IMPORTS_PER_DAY = 5;
const ONCHAIN_CONFIG = getOnchainServerConfig();
const pairingEngine = createPairingEngine(db);

router.use("/", agentTradingController);

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
  };
};

class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function getAuthenticatedUserId(req: Request): string {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) {
    throw new HttpError(401, "Unauthorized");
  }
  return userId;
}

async function getOptionalAuthenticatedUserId(req: Request): Promise<string | null> {
  const existingUserId = (req as AuthenticatedRequest).user?.id;
  if (existingUserId) {
    return existingUserId;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return null;
  }

  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) {
    return null;
  }

  try {
    const claims = await verifyPrivyToken(token);
    return claims?.userId || claims?.sub || null;
  } catch {
    return null;
  }
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseRuntimeMarketId(marketId: string): number {
  const numericMarketId = Number.parseInt(String(marketId || "").trim(), 10);
  if (!Number.isInteger(numericMarketId) || numericMarketId <= 0) {
    throw new HttpError(400, "Market id must be a valid Bantah challenge id");
  }
  return numericMarketId;
}

function parseStakeAmount(stakeAmount: string): { parsedAmount: number; roundedAmount: number } {
  const parsedAmount = Number.parseFloat(String(stakeAmount || "").trim());
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new HttpError(400, "Stake amount must be a valid positive number");
  }

  return {
    parsedAmount,
    roundedAmount: Math.max(1, Math.round(parsedAmount)),
  };
}

function mergeEscrowTxHashes(existing: unknown, incomingHash: string): string {
  const incoming = String(incomingHash || "").trim().toLowerCase();
  if (!incoming) return String(existing || "");

  const raw = String(existing || "").trim();
  if (!raw) return incoming;

  if (raw.toLowerCase().includes(incoming)) {
    return raw;
  }

  return `${raw},${incoming}`;
}

function resolveOnchainRuntimeToken(chainId: number, currency: string) {
  const tokenSymbol = normalizeOnchainTokenSymbol(currency) as OnchainTokenSymbol;
  const chainConfig = ONCHAIN_CONFIG.chains[String(chainId)];

  if (!chainConfig) {
    throw new HttpError(400, "Unsupported chain for Bantah agent runtime");
  }

  const tokenConfig = chainConfig.tokens[tokenSymbol];
  const isSupportedToken = Array.isArray(chainConfig.supportedTokens)
    ? chainConfig.supportedTokens.includes(tokenSymbol)
    : Boolean(tokenConfig);

  if (!tokenConfig || !isSupportedToken) {
    throw new HttpError(400, `Token ${tokenSymbol} is not supported on chain ${chainConfig.name}`);
  }

  return { chainConfig, tokenConfig, tokenSymbol };
}

async function getRuntimeMarketSnapshot(challengeId: number) {
  const challenge = await storage.getChallengeById(challengeId);
  if (!challenge) {
    throw new HttpError(404, "Market not found");
  }

  const queueEntries = await db
    .select({
      userId: pairQueue.userId,
      participantType: pairQueue.participantType,
      agentId: pairQueue.agentId,
      side: pairQueue.side,
      stakeAmount: pairQueue.stakeAmount,
      status: pairQueue.status,
      createdAt: pairQueue.createdAt,
    })
    .from(pairQueue)
    .where(
      and(
        eq(pairQueue.challengeId, challengeId),
        inArray(pairQueue.status, ["waiting", "matched"]),
      ),
    )
    .orderBy(asc(pairQueue.createdAt));

  const participants = queueEntries.map((entry) => {
    const participantType =
      String(entry.participantType || "").trim().toLowerCase() === "agent" && entry.agentId
        ? "agent"
        : "human";
    const participantId =
      participantType === "agent"
        ? String(entry.agentId || "")
        : String(entry.userId || "");

    return {
      participantId,
      participantType: participantType as "agent" | "human",
      side: String(entry.side || "").trim().toLowerCase() === "no" ? "no" : "yes",
      stakeAmount: String(entry.stakeAmount || 0),
      createdAt: entry.createdAt ? new Date(entry.createdAt) : null,
    };
  });

  const yesPool = participants
    .filter((participant) => participant.side === "yes")
    .reduce((total, participant) => total + Number.parseFloat(participant.stakeAmount || "0"), 0);
  const noPool = participants
    .filter((participant) => participant.side === "no")
    .reduce((total, participant) => total + Number.parseFloat(participant.stakeAmount || "0"), 0);
  const totalPool = yesPool + noPool;

  const rawStatus = String(challenge.status || "").trim().toLowerCase();
  const dueDateIso = toIsoString(challenge.dueDate);
  const dueDateMs = dueDateIso ? new Date(dueDateIso).getTime() : NaN;

  let status: "open" | "pending" | "matched" | "settled" | "cancelled" = "open";
  if (rawStatus === "completed") {
    status = "settled";
  } else if (rawStatus === "cancelled" || rawStatus === "disputed") {
    status = "cancelled";
  } else if (rawStatus === "active" || (yesPool > 0 && noPool > 0)) {
    status = "matched";
  } else if ((yesPool > 0 || noPool > 0) || (Number.isFinite(dueDateMs) && dueDateMs <= Date.now())) {
    status = "pending";
  }

  return {
    challenge,
    participants,
    yesPool,
    noPool,
    totalPool,
    dueDateIso,
    status,
  };
}

async function serializeAgent(agentId: string): Promise<AgentRegistryProfile> {
  const storedAgent = await storage.getAgentById(agentId);
  if (!storedAgent) {
    throw new HttpError(404, "Agent not found");
  }

  return {
    agentId: storedAgent.agentId,
    ownerId: storedAgent.ownerId,
    agentName: storedAgent.agentName,
    avatarUrl: (storedAgent as any).avatarUrl ?? null,
    agentType: storedAgent.agentType,
    walletAddress: storedAgent.walletAddress,
    endpointUrl: storedAgent.endpointUrl,
    bantahSkillVersion: storedAgent.bantahSkillVersion,
    specialty: storedAgent.specialty,
    status: storedAgent.status,
    skillActions: Array.isArray((storedAgent as any).skillActions)
      ? (storedAgent as any).skillActions
      : [],
    walletNetworkId: (storedAgent as any).walletNetworkId ?? null,
    walletProvider: (storedAgent as any).walletProvider ?? null,
    runtimeEngine: (storedAgent as any).runtimeEngine ?? null,
    runtimeStatus: (storedAgent as any).runtimeStatus ?? null,
    points: storedAgent.points,
    winCount: storedAgent.winCount,
    lossCount: storedAgent.lossCount,
    marketCount: storedAgent.marketCount,
    isTokenized: storedAgent.isTokenized,
    lastSkillCheckAt: toIsoString(storedAgent.lastSkillCheckAt),
    lastSkillCheckScore: storedAgent.lastSkillCheckScore,
    lastSkillCheckStatus:
      storedAgent.lastSkillCheckStatus === "passed" || storedAgent.lastSkillCheckStatus === "failed"
        ? storedAgent.lastSkillCheckStatus
        : null,
    createdAt: toIsoString(storedAgent.createdAt),
    updatedAt: toIsoString(storedAgent.updatedAt),
    owner: {
      id: storedAgent.owner.id,
      username: storedAgent.owner.username ?? null,
      firstName: storedAgent.owner.firstName ?? null,
      lastName: storedAgent.owner.lastName ?? null,
      profileImageUrl: storedAgent.owner.profileImageUrl ?? null,
    },
  };
}

function buildAgentOfferings(storedAgent: Awaited<ReturnType<typeof storage.getAgentById>>) {
  if (!storedAgent) {
    throw new HttpError(404, "Agent not found");
  }

  const isManagedSeller = storedAgent.agentType === "bantah_created";
  const runtimeEntry = getManagedBantahAgentRuntime(storedAgent.agentId);
  const runtimeStatus =
    runtimeEntry?.config.status || storedAgent.runtimeStatus || null;
  const runtimeHealth = resolveRuntimeHealth(
    storedAgent.agentType,
    runtimeStatus,
    Boolean(runtimeEntry),
  );
  const hasVerifiedSkills = storedAgent.lastSkillCheckStatus === "passed";
  const canSellWithX402 =
    isManagedSeller &&
    storedAgent.status === "active" &&
    hasVerifiedSkills &&
    runtimeHealth !== "error";

  const availabilityReason = !isManagedSeller
    ? "First x402 seller rollout is limited to Bantah-created agents."
    : storedAgent.status !== "active"
      ? "Only active Bantah agents can be listed as x402 sellers."
      : !hasVerifiedSkills
        ? "This Bantah agent needs a passing skill check before it can sell outputs."
        : runtimeHealth === "error"
          ? "Runtime health must recover before this agent can sell paid outputs."
          : "Offerings are catalogued now; x402 charge execution is the next layer.";

  const settlementNetworkId =
    storedAgent.walletNetworkId || "base-mainnet";

  return agentOfferingsResponseSchema.parse({
    agentId: storedAgent.agentId,
    sellerMode: isManagedSeller ? "managed" : "external",
    x402Phase: "catalog",
    canSellWithX402,
    items: [
      {
        productId: `${storedAgent.agentId}:forecast`,
        type: "forecast",
        title: "Agent forecast",
        description:
          "Short-form YES/NO lean with probability, confidence, and a fast market summary.",
        paymentRail: "x402",
        priceUsd: "0.10",
        settlementCurrency: "USDC",
        settlementNetworkId,
        audience: "both",
        estimatedDelivery: "10-30s",
        status: canSellWithX402 ? "draft" : "unavailable",
        availabilityReason,
      },
      {
        productId: `${storedAgent.agentId}:research`,
        type: "research",
        title: "Research report",
        description:
          "Deeper thesis with bull case, bear case, risk factors, and a final market position.",
        paymentRail: "x402",
        priceUsd: "0.50",
        settlementCurrency: "USDC",
        settlementNetworkId,
        audience: "both",
        estimatedDelivery: "30-90s",
        status: canSellWithX402 ? "draft" : "unavailable",
        availabilityReason,
      },
    ],
  });
}

async function listRankedAgents() {
  const rows = await db
    .select({
      agent: agents,
      owner: {
        id: users.id,
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        profileImageUrl: users.profileImageUrl,
      },
    })
    .from(agents)
    .innerJoin(users, eq(agents.ownerId, users.id))
    .where(eq(agents.status, "active"))
    .orderBy(
      desc(agents.points),
      desc(agents.winCount),
      desc(agents.marketCount),
      desc(agents.createdAt),
    );

  const items = await Promise.all(
    rows.map(async (row, index) => {
      const followState = await storage.getAgentFollowState(row.agent.agentId, null);

      return {
        rank: index + 1,
        agentId: row.agent.agentId,
        agentName: row.agent.agentName,
        avatarUrl: (row.agent as any).avatarUrl ?? null,
        specialty: row.agent.specialty,
        points: row.agent.points,
        winCount: row.agent.winCount,
        lossCount: row.agent.lossCount,
        marketCount: row.agent.marketCount,
        battlesCount: row.agent.winCount + row.agent.lossCount,
        followerCount: followState.followerCount,
        lastSkillCheckStatus:
          row.agent.lastSkillCheckStatus === "passed" ||
          row.agent.lastSkillCheckStatus === "failed"
            ? row.agent.lastSkillCheckStatus
            : null,
        owner: {
          id: row.owner.id,
          username: row.owner.username ?? null,
          firstName: row.owner.firstName ?? null,
          lastName: row.owner.lastName ?? null,
          profileImageUrl: row.owner.profileImageUrl ?? null,
        },
      };
    }),
  );

  return items;
}

async function assertAgentOwner(req: Request, agentId: string) {
  const userId = getAuthenticatedUserId(req);
  const storedAgent = await storage.getAgentById(agentId);

  if (!storedAgent) {
    throw new HttpError(404, "Agent not found");
  }

  if (storedAgent.ownerId !== userId) {
    throw new HttpError(403, "Only the owning Bantah user can manage this agent");
  }

  return storedAgent;
}

function resolveRuntimeHealth(
  agentType: string,
  runtimeStatus: string | null | undefined,
  isManagedRuntimeLive: boolean,
) {
  if (agentType !== "bantah_created") {
    return "external" as const;
  }

  if (runtimeStatus === "starting") {
    return "starting" as const;
  }

  if (runtimeStatus === "active" && isManagedRuntimeLive) {
    return "healthy" as const;
  }

  if (runtimeStatus === "inactive" || !runtimeStatus) {
    return "stopped" as const;
  }

  return "error" as const;
}

function resolveRuntimeWalletToken(chainId: number) {
  const chainConfig = ONCHAIN_CONFIG.chains[String(chainId)];
  if (!chainConfig) return null;

  const preferred = normalizeOnchainTokenSymbol(
    ONCHAIN_CONFIG.defaultToken || "USDC",
  ) as OnchainTokenSymbol;
  if (chainConfig.tokens[preferred]) {
    return {
      chainConfig,
      tokenSymbol: preferred,
    };
  }

  const fallbackSymbol =
    (Array.isArray(chainConfig.supportedTokens) && chainConfig.supportedTokens[0]) ||
    Object.keys(chainConfig.tokens || {})[0];

  if (!fallbackSymbol) return null;

  return {
    chainConfig,
    tokenSymbol: fallbackSymbol as OnchainTokenSymbol,
  };
}

function resolveAgentWalletChainConfig(params: {
  chainId?: number | null;
  walletNetworkId?: string | null;
}) {
  const directChainId =
    typeof params.chainId === "number" && Number.isInteger(params.chainId) && params.chainId > 0
      ? params.chainId
      : null;
  const derivedChainId =
    !directChainId && params.walletNetworkId
      ? getBantahAgentKitChainIdForNetworkId(params.walletNetworkId)
      : null;
  const resolvedChainId = directChainId || derivedChainId;

  if (!resolvedChainId) return null;
  return ONCHAIN_CONFIG.chains[String(resolvedChainId)] || null;
}

function buildAddressExplorerUrl(address: string, chainConfig?: OnchainChainConfig | null) {
  if (!chainConfig?.blockExplorerUrl) return null;
  return `${chainConfig.blockExplorerUrl.replace(/\/$/, "")}/address/${address}`;
}

function buildTxExplorerUrl(txHash: string, chainConfig?: OnchainChainConfig | null) {
  if (!chainConfig?.blockExplorerUrl) return null;
  return `${chainConfig.blockExplorerUrl.replace(/\/$/, "")}/tx/${txHash}`;
}

function handleError(res: Response, error: unknown) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      message: "Validation failed",
      details: error.issues,
    });
  }

  if (error instanceof BantahAgentWalletError) {
    const status =
      error.code === "insufficient_balance"
        ? 422
        : error.code === "unsupported_chain" || error.code === "wallet_not_provisioned"
          ? 409
          : error.code === "wallet_provision_failed" || error.code === "wallet_restore_failed"
            ? 502
            : 400;
    return res.status(status).json({
      message: error.message,
      details: {
        code: error.code,
      },
    });
  }

  if (error instanceof HttpError) {
    return res.status(error.status).json({
      message: error.message,
      details: error.details,
    });
  }

  console.error("Agents API error:", error);
  return res.status(500).json({ message: "Failed to process agent request" });
}

async function listAgentActivity(agentId: string, limit = 6) {
  const safeLimit = Math.min(Math.max(Number(limit) || 6, 1), 20);

  const [createdMarkets, joinedMarkets, settledMarkets] = await Promise.all([
    db
      .select({
        challengeId: challenges.id,
        title: challenges.title,
        category: challenges.category,
        occurredAt: challenges.createdAt,
      })
      .from(challenges)
      .where(eq(challenges.creatorAgentId, agentId))
      .orderBy(desc(challenges.createdAt))
      .limit(safeLimit),
    db
      .select({
        queueId: pairQueue.id,
        challengeId: challenges.id,
        title: challenges.title,
        category: challenges.category,
        side: pairQueue.side,
        occurredAt: pairQueue.createdAt,
      })
      .from(pairQueue)
      .innerJoin(challenges, eq(pairQueue.challengeId, challenges.id))
      .where(eq(pairQueue.agentId, agentId))
      .orderBy(desc(pairQueue.createdAt))
      .limit(safeLimit),
    db
      .select({
        challengeId: challenges.id,
        title: challenges.title,
        category: challenges.category,
        result: challenges.result,
        challengerAgentId: challenges.challengerAgentId,
        challengedAgentId: challenges.challengedAgentId,
        occurredAt: challenges.completedAt,
      })
      .from(challenges)
      .where(
        and(
          or(
            eq(challenges.challengerAgentId, agentId),
            eq(challenges.challengedAgentId, agentId),
          ),
          inArray(challenges.result, ["challenger_won", "challenged_won"]),
        ),
      )
      .orderBy(desc(challenges.completedAt))
      .limit(safeLimit),
  ]);

  const items = [
    ...createdMarkets.map((item) => ({
      activityId: `created_${item.challengeId}`,
      type: "created_market" as const,
      challengeId: item.challengeId,
      title: item.title,
      category: item.category,
      side: null,
      occurredAt: toIsoString(item.occurredAt),
    })),
    ...joinedMarkets.map((item) => ({
      activityId: `joined_${item.queueId}`,
      type: "joined_market" as const,
      challengeId: item.challengeId,
      title: item.title,
      category: item.category,
      side: String(item.side || "").trim().toLowerCase() === "no" ? "no" : "yes",
      occurredAt: toIsoString(item.occurredAt),
    })),
    ...settledMarkets
      .map((item) => {
        const won =
          (item.result === "challenger_won" && item.challengerAgentId === agentId) ||
          (item.result === "challenged_won" && item.challengedAgentId === agentId);
        return {
          activityId: `${won ? "won" : "lost"}_${item.challengeId}`,
          type: won ? ("won_market" as const) : ("lost_market" as const),
          challengeId: item.challengeId,
          title: item.title,
          category: item.category,
          side: null,
          occurredAt: toIsoString(item.occurredAt),
        };
      }),
  ]
    .sort((a, b) => {
      const aTime = a.occurredAt ? new Date(a.occurredAt).getTime() : 0;
      const bTime = b.occurredAt ? new Date(b.occurredAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, safeLimit);

  return items;
}

router.post("/skill-check", async (req, res) => {
  try {
    const parsedBody = agentSkillCheckRequestSchema.parse(req.body ?? {});
    const skillCheck = await runAgentSkillCheck(parsedBody.endpointUrl);
    res.json(skillCheck);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/import", PrivyAuthMiddleware, async (req, res) => {
  try {
    const ownerId = getAuthenticatedUserId(req);
    const parsedBody = agentImportRequestSchema.parse(req.body ?? {});
    const normalizedWalletAddress = normalizeEvmAddress(parsedBody.walletAddress);

    if (!normalizedWalletAddress) {
      throw new HttpError(400, "Wallet address must be a valid EVM address");
    }

    const normalizedEndpointUrl = new URL(parsedBody.endpointUrl).toString();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const importCount = await storage.countImportedAgentsByOwnerSince(ownerId, startOfDay);
    if (importCount >= MAX_AGENT_IMPORTS_PER_DAY) {
      throw new HttpError(429, "Daily import limit reached", {
        limit: MAX_AGENT_IMPORTS_PER_DAY,
      });
    }

    const [existingByWallet, existingByEndpoint] = await Promise.all([
      storage.getAgentByWalletAddress(normalizedWalletAddress),
      storage.getAgentByEndpointUrl(normalizedEndpointUrl),
    ]);

    if (existingByWallet) {
      throw new HttpError(409, "An agent with this wallet address is already registered");
    }

    if (existingByEndpoint) {
      throw new HttpError(409, "An agent with this endpoint URL is already registered");
    }

    const skillCheck = await runAgentSkillCheck(normalizedEndpointUrl);
    if (!skillCheck.overallPassed) {
      throw new HttpError(422, "Agent did not pass Bantah skill verification", skillCheck);
    }

    const createdAgent = await storage.createAgent({
      ownerId,
      agentName: parsedBody.agentName,
      agentType: "imported",
      walletAddress: normalizedWalletAddress,
      endpointUrl: normalizedEndpointUrl,
      bantahSkillVersion: "1.0.0",
      specialty: parsedBody.specialty,
      status: "active",
      isTokenized: parsedBody.isTokenized,
      lastSkillCheckAt: new Date(skillCheck.checkedAt),
      lastSkillCheckScore: skillCheck.complianceScore,
      lastSkillCheckStatus: "passed",
    });

    const agent = await serializeAgent(createdAgent.agentId);
    res.status(201).json({ agent, skillCheck });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/create", PrivyAuthMiddleware, async (req, res) => {
  try {
    const ownerId = getAuthenticatedUserId(req);
    const parsedBody = agentCreateRequestSchema.parse(req.body ?? {});
    const agentId = randomUUID();
    const endpointUrl = buildBantahAgentEndpointUrl(agentId);
    const requestedChainId = Number(parsedBody.chainId || ONCHAIN_CONFIG.defaultChainId || 8453);
    const requestedChainConfig = ONCHAIN_CONFIG.chains[String(requestedChainId)];
    const requestedNetworkId = getBantahAgentKitNetworkIdForChainId(requestedChainId);

    if (!requestedNetworkId) {
      throw new HttpError(
        422,
        `Coinbase AgentKit smart-wallet provisioning is not available on ${
          requestedChainConfig?.name || `chain ${requestedChainId}`
        } yet.`,
        {
          chainId: requestedChainId,
          supportedChainIds: bantahAgentKitSupportedChainIds,
        },
      );
    }

    const existingByEndpoint = await storage.getAgentByEndpointUrl(endpointUrl);
    if (existingByEndpoint) {
      throw new HttpError(409, "A Bantah agent with this endpoint already exists");
    }

    let provisionedWallet;
    try {
      provisionedWallet = await provisionBantahAgentWallet(agentId, requestedNetworkId);
    } catch (error: any) {
      if (error instanceof BantahAgentWalletError) {
        throw new HttpError(502, error.message, {
          provider: "agentkit",
          code: error.code,
          chainId: requestedChainId,
          networkId: requestedNetworkId,
        });
      }
      throw error;
    }
    const existingByWallet = await storage.getAgentByWalletAddress(provisionedWallet.walletAddress);
    if (existingByWallet) {
      throw new HttpError(409, "A Bantah agent wallet collision occurred. Please try again.");
    }

    const elizaCharacter = buildBantahElizaCharacter({
      agentId,
      agentName: parsedBody.agentName.trim(),
      specialty: parsedBody.specialty,
      walletAddress: provisionedWallet.walletAddress,
      chainId: requestedChainId,
      chainName: requestedChainConfig?.name || `Chain ${requestedChainId}`,
      walletNetworkId: provisionedWallet.walletNetworkId,
      skillActions: [...DEFAULT_BANTAH_AGENT_SKILLS],
      endpointUrl,
    });
    const elizaRuntime = buildBantahElizaRuntimeConfig({
      agentId,
      endpointUrl,
      chainId: requestedChainId,
      chainName: requestedChainConfig?.name || `Chain ${requestedChainId}`,
      walletAddress: provisionedWallet.walletAddress,
      walletNetworkId: provisionedWallet.walletNetworkId,
      walletProvider: provisionedWallet.walletProvider,
      skillActions: [...DEFAULT_BANTAH_AGENT_SKILLS],
      character: elizaCharacter,
    });

    await storage.createAgent({
      agentId,
      ownerId,
      agentName: parsedBody.agentName.trim(),
      avatarUrl: parsedBody.avatarUrl ? parsedBody.avatarUrl.trim() : null,
      agentType: "bantah_created",
      walletAddress: provisionedWallet.walletAddress,
      endpointUrl,
      bantahSkillVersion: BANTAH_SKILL_VERSION,
      specialty: parsedBody.specialty,
      status: "active",
      skillActions: DEFAULT_BANTAH_AGENT_SKILLS,
      walletNetworkId: provisionedWallet.walletNetworkId,
      walletProvider: provisionedWallet.walletProvider,
      ownerWalletAddress: provisionedWallet.ownerWalletAddress,
      walletData: provisionedWallet.walletData,
      runtimeEngine: elizaRuntime.engine,
      runtimeStatus: elizaRuntime.status,
      runtimeConfig: elizaRuntime,
      isTokenized: false,
    });

    // Ensure the table exists on fresh Railway deploys before inserting
    await ensureBotaFighterProfilesTable();
    await db.insert(botaFighterProfiles).values({
      agentId,
      displayName: parsedBody.agentName.trim(),
      origin: "bota",
      originId: null,
      agentClass: "striker",
      archetype: "signal_striker",
      league: "Open League",
      fameScore: 50,
      avatarUrl: parsedBody.avatarUrl ? parsedBody.avatarUrl.trim() : null,
      walletAddress: provisionedWallet.walletAddress,
      metadata: { ownerUserId: ownerId },
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();

    let activeRuntimeConfig = elizaRuntime;
    try {
      activeRuntimeConfig = await startManagedBantahAgentRuntime(agentId);
    } catch (error: any) {
      // Roll back both tables on runtime failure
      await db.delete(agents).where(eq(agents.agentId, agentId));
      await db.delete(botaFighterProfiles).where(eq(botaFighterProfiles.agentId, agentId)).catch(() => {});
      throw new HttpError(
        502,
        error?.message || "Failed to start Bantah Eliza runtime.",
      );
    }

    let skillCheck;
    try {
      skillCheck = await runAgentSkillCheck(endpointUrl);
    } catch (error) {
      await stopManagedBantahAgentRuntime(agentId, { persist: false });
      await db.delete(agents).where(eq(agents.agentId, agentId));
      throw error;
    }
    await storage.updateAgentSkillCheck(agentId, {
      bantahSkillVersion: BANTAH_SKILL_VERSION,
      lastSkillCheckAt: new Date(skillCheck.checkedAt),
      lastSkillCheckScore: skillCheck.complianceScore,
      lastSkillCheckStatus: skillCheck.overallPassed ? "passed" : "failed",
    });

    const agent = await serializeAgent(agentId);
    await createAndPushAgentOwnerNotification(
      {
        agentId,
        agentName: agent.agentName,
        ownerId,
      },
      {
        type: "agent_wallet_ready",
        title: "Agent wallet ready",
        message: `${agent.agentName} now has a live AgentKit wallet on ${requestedChainConfig?.name || "the selected chain"}.`,
        data: {
          walletAddress: provisionedWallet.walletAddress,
          walletNetworkId: provisionedWallet.walletNetworkId,
          chainId: requestedChainId,
        },
        priority: 2,
        fomoLevel: "medium",
      },
    );
    res.status(201).json({
      agent,
      provisioned: {
        walletAddress: provisionedWallet.walletAddress,
        endpointUrl,
        chainId: requestedChainId,
        walletNetworkId: provisionedWallet.walletNetworkId,
        walletProvider: provisionedWallet.walletProvider,
        skillActions: DEFAULT_BANTAH_AGENT_SKILLS,
      },
      runtime: activeRuntimeConfig,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/", async (req, res) => {
  try {
    const parsedQuery = agentListQuerySchema.parse(req.query ?? {});
    const status = parsedQuery.status ?? "active";
    const { items, total } = await storage.listAgents({
      ...parsedQuery,
      status,
    });

    const serializedItems = items.map((item) => ({
      agentId: item.agentId,
      ownerId: item.ownerId,
      agentName: item.agentName,
      avatarUrl: (item as any).avatarUrl ?? null,
      agentType: item.agentType,
      walletAddress: item.walletAddress,
      endpointUrl: item.endpointUrl,
      bantahSkillVersion: item.bantahSkillVersion,
      specialty: item.specialty,
      status: item.status,
      skillActions: Array.isArray((item as any).skillActions) ? (item as any).skillActions : [],
      walletNetworkId: (item as any).walletNetworkId ?? null,
      walletProvider: (item as any).walletProvider ?? null,
      runtimeEngine: (item as any).runtimeEngine ?? null,
      runtimeStatus: (item as any).runtimeStatus ?? null,
      points: item.points,
      winCount: item.winCount,
      lossCount: item.lossCount,
      marketCount: item.marketCount,
      isTokenized: item.isTokenized,
      lastSkillCheckAt: toIsoString(item.lastSkillCheckAt),
      lastSkillCheckScore: item.lastSkillCheckScore,
      lastSkillCheckStatus:
        item.lastSkillCheckStatus === "passed" || item.lastSkillCheckStatus === "failed"
          ? item.lastSkillCheckStatus
          : null,
      createdAt: toIsoString(item.createdAt),
      updatedAt: toIsoString(item.updatedAt),
      owner: {
        id: item.owner.id,
        username: item.owner.username ?? null,
        firstName: item.owner.firstName ?? null,
        lastName: item.owner.lastName ?? null,
        profileImageUrl: item.owner.profileImageUrl ?? null,
      },
    }));

    res.json({
      items: serializedItems,
      pagination: {
        page: parsedQuery.page,
        limit: parsedQuery.limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / parsedQuery.limit),
      },
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/leaderboard", async (_req, res) => {
  try {
    const rankedAgents = await listRankedAgents();
    const payload = agentLeaderboardResponseSchema.parse({
      items: rankedAgents.slice(0, 10),
      totalAgents: rankedAgents.length,
    });
    res.json(payload);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/health/managed-runtimes", async (_req, res) => {
  try {
    const runtimeRows = await db
      .select({
        agentId: agents.agentId,
        agentName: agents.agentName,
        agentType: agents.agentType,
        runtimeEngine: agents.runtimeEngine,
        runtimeStatus: agents.runtimeStatus,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(eq(agents.agentType, "bantah_created"))
      .orderBy(desc(agents.updatedAt));

    const liveRuntimeMap = new Map(
      listManagedBantahAgentRuntimes().map((item) => [item.agentId, item]),
    );

    const items = runtimeRows.map((row) => {
      const live = liveRuntimeMap.get(row.agentId);
      const health = resolveRuntimeHealth(
        row.agentType,
        live?.runtimeStatus || row.runtimeStatus,
        Boolean(live),
      );

      return {
        agentId: row.agentId,
        agentName: row.agentName,
        runtimeEngine: row.runtimeEngine ?? live?.runtimeEngine ?? null,
        runtimeStatus: live?.runtimeStatus || row.runtimeStatus || null,
        health,
        isManagedRuntimeLive: Boolean(live),
        startedAt: live?.startedAt || null,
        updatedAt: toIsoString(row.updatedAt),
        chainId: live?.chainId ?? null,
        chainName: live?.chainName ?? null,
      };
    });

    const summary = {
      total: items.length,
      live: items.filter((item) => item.isManagedRuntimeLive).length,
      healthy: items.filter((item) => item.health === "healthy").length,
      starting: items.filter((item) => item.health === "starting").length,
      stopped: items.filter((item) => item.health === "stopped").length,
      error: items.filter((item) => item.health === "error").length,
    };

    res.json({
      summary,
      items,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:agentId/rank", async (req, res) => {
  try {
    await serializeAgent(req.params.agentId);
    const rankedAgents = await listRankedAgents();
    const rankedAgent = rankedAgents.find((item) => item.agentId === req.params.agentId) || null;
    const followerState = await storage.getAgentFollowState(req.params.agentId, null);
    const payload = agentRankResponseSchema.parse({
      agentId: req.params.agentId,
      rank: rankedAgent?.rank ?? null,
      totalAgents: rankedAgents.length,
      followerCount: followerState.followerCount,
    });
    res.json(payload);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:agentId/activity", async (req, res) => {
  try {
    await serializeAgent(req.params.agentId);
    const limitRaw = Number(req.query.limit ?? 6);
    const items = await listAgentActivity(req.params.agentId, limitRaw);
    res.json({
      agentId: req.params.agentId,
      items,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:agentId/follow-state", async (req, res) => {
  try {
    await serializeAgent(req.params.agentId);
    const userId = await getOptionalAuthenticatedUserId(req);
    const state = await storage.getAgentFollowState(req.params.agentId, userId);
    const payload = agentFollowStateResponseSchema.parse({
      agentId: req.params.agentId,
      isFollowing: state.isFollowing,
      followerCount: state.followerCount,
    });
    res.json(payload);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:agentId/offerings", async (req, res) => {
  try {
    const storedAgent = await storage.getAgentById(req.params.agentId);
    const payload = buildAgentOfferings(storedAgent);
    res.json(payload);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:agentId/runtime-state", async (req, res) => {
  try {
    const storedAgent = await storage.getAgentById(req.params.agentId);
    if (!storedAgent) {
      throw new HttpError(404, "Agent not found");
    }

    const runtimeConfig = storedAgent.runtimeConfig ?? null;
    const runtimeEntry = getManagedBantahAgentRuntime(req.params.agentId);
    const isManagedRuntimeLive = Boolean(runtimeEntry);
    const runtimeStatus =
      runtimeEntry?.config.status ||
      (storedAgent.runtimeStatus ?? runtimeConfig?.status ?? null);
    const chainId =
      Number(runtimeEntry?.config.chainId || runtimeConfig?.chainId || 0) || null;
    const chainName =
      runtimeEntry?.config.chainName || runtimeConfig?.chainName || null;
    const walletProvider =
      runtimeEntry?.config.walletProvider ||
      storedAgent.walletProvider ||
      runtimeConfig?.walletProvider ||
      null;
    const walletNetworkId =
      runtimeEntry?.config.walletNetworkId ||
      storedAgent.walletNetworkId ||
      runtimeConfig?.walletNetworkId ||
      null;

    const walletChainConfig = resolveAgentWalletChainConfig({
      chainId,
      walletNetworkId,
    });

    let wallet: {
      address: string;
      provider: string | null;
      networkId: string | null;
      balance: string | null;
      currency: string | null;
      status: "ready" | "external" | "error" | "unavailable";
      message: string | null;
      explorerUrl: string | null;
      supportedTokens: OnchainTokenSymbol[];
    } = {
      address: storedAgent.walletAddress,
      provider: walletProvider,
      networkId: walletNetworkId,
      balance: null,
      currency: null,
      status: storedAgent.agentType === "bantah_created" ? "unavailable" : "external",
      explorerUrl: buildAddressExplorerUrl(storedAgent.walletAddress, walletChainConfig),
      supportedTokens: walletChainConfig?.supportedTokens || [],
      message:
        storedAgent.agentType === "bantah_created"
          ? "Wallet balance not fetched yet."
          : "Imported agents manage wallet execution outside Bantah.",
    };

    if (
      storedAgent.agentType === "bantah_created" &&
      storedAgent.walletProvider &&
      storedAgent.walletProvider !== "cdp_smart_wallet"
    ) {
      wallet = {
        address: storedAgent.walletAddress,
        provider: walletProvider,
        networkId: walletNetworkId,
        balance: null,
        currency: null,
        status: "unavailable",
        explorerUrl: buildAddressExplorerUrl(storedAgent.walletAddress, walletChainConfig),
        supportedTokens: walletChainConfig?.supportedTokens || [],
        message:
          storedAgent.walletProvider === "local_demo_wallet"
            ? "This agent is using a local demo wallet while AgentKit provisioning is unavailable."
            : "This Bantah agent does not have a live AgentKit wallet provider yet.",
      };
    } else if (storedAgent.agentType === "bantah_created" && chainId) {
      const walletToken = resolveRuntimeWalletToken(chainId);
      if (walletToken) {
        try {
          const balance = await getBantahAgentWalletBalance({
            snapshot: {
              agentId: storedAgent.agentId,
              walletAddress: storedAgent.walletAddress,
              walletProvider: storedAgent.walletProvider ?? undefined,
              walletNetworkId: storedAgent.walletNetworkId ?? undefined,
              ownerWalletAddress: storedAgent.ownerWalletAddress ?? undefined,
              walletData: storedAgent.walletData ?? undefined,
            },
            chainId,
            chainConfig: walletToken.chainConfig,
            tokenSymbol: walletToken.tokenSymbol,
          });

          wallet = {
            address: storedAgent.walletAddress,
            provider: walletProvider,
            networkId: walletNetworkId,
            balance: balance.amountFormatted,
            currency: walletToken.tokenSymbol,
            status: "ready",
            explorerUrl: buildAddressExplorerUrl(storedAgent.walletAddress, walletChainConfig),
            supportedTokens: walletChainConfig?.supportedTokens || [],
            message: null,
          };
        } catch (error: any) {
          wallet = {
            address: storedAgent.walletAddress,
            provider: walletProvider,
            networkId: walletNetworkId,
            balance: null,
            currency: walletToken.tokenSymbol,
            status: "error",
            explorerUrl: buildAddressExplorerUrl(storedAgent.walletAddress, walletChainConfig),
            supportedTokens: walletChainConfig?.supportedTokens || [],
            message: error?.message || "Failed to load wallet status.",
          };
        }
      }
    }

    const payload = agentRuntimeStateResponseSchema.parse({
      agentId: storedAgent.agentId,
      runtimeEngine: storedAgent.runtimeEngine ?? runtimeConfig?.engine ?? null,
      runtimeStatus,
      health: resolveRuntimeHealth(
        storedAgent.agentType,
        runtimeStatus,
        isManagedRuntimeLive,
      ),
      isManagedRuntimeLive,
      startedAt: runtimeEntry?.startedAt || null,
      updatedAt: toIsoString(storedAgent.updatedAt),
      chainId,
      chainName,
      wallet,
      controls: {
        canPause: storedAgent.agentType === "bantah_created" && runtimeStatus === "active",
        canResume:
          storedAgent.agentType === "bantah_created" &&
          (runtimeStatus === "inactive" || runtimeStatus === "error"),
        canRestart: storedAgent.agentType === "bantah_created",
      },
    });

    res.json(payload);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:agentId/follow", PrivyAuthMiddleware, async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    await serializeAgent(req.params.agentId);
    const result = await storage.toggleAgentFollow(userId, req.params.agentId);
    const state = await storage.getAgentFollowState(req.params.agentId, userId);

    res.json({
      ...result,
      agentId: req.params.agentId,
      isFollowing: state.isFollowing,
      followerCount: state.followerCount,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:agentId/runtime/pause", PrivyAuthMiddleware, async (req, res) => {
  try {
    const storedAgent = await assertAgentOwner(req, req.params.agentId);
    if (storedAgent.agentType !== "bantah_created") {
      throw new HttpError(422, "Only Bantah-created agents support managed runtime controls");
    }

    await stopManagedBantahAgentRuntime(req.params.agentId, { persist: true });
    const agent = await serializeAgent(req.params.agentId);
    res.json({
      action: "paused",
      agent,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:agentId/runtime/resume", PrivyAuthMiddleware, async (req, res) => {
  try {
    const storedAgent = await assertAgentOwner(req, req.params.agentId);
    if (storedAgent.agentType !== "bantah_created") {
      throw new HttpError(422, "Only Bantah-created agents support managed runtime controls");
    }

    const runtime = await startManagedBantahAgentRuntime(req.params.agentId);
    const agent = await serializeAgent(req.params.agentId);
    res.json({
      action: "resumed",
      agent,
      runtime,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:agentId/runtime/restart", PrivyAuthMiddleware, async (req, res) => {
  try {
    const storedAgent = await assertAgentOwner(req, req.params.agentId);
    if (storedAgent.agentType !== "bantah_created") {
      throw new HttpError(422, "Only Bantah-created agents support managed runtime controls");
    }

    const runtime = await restartManagedBantahAgentRuntime(req.params.agentId);
    const agent = await serializeAgent(req.params.agentId);
    res.json({
      action: "restarted",
      agent,
      runtime,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:agentId/wallet/reprovision", PrivyAuthMiddleware, async (req, res) => {
  try {
    const storedAgent = await assertAgentOwner(req, req.params.agentId);
    if (storedAgent.agentType !== "bantah_created") {
      throw new HttpError(422, "Only Bantah-created agents support AgentKit wallet provisioning");
    }

    const requestedChainId =
      Number((storedAgent.runtimeConfig as any)?.chainId || 0) ||
      getBantahAgentKitChainIdForNetworkId(String(storedAgent.walletNetworkId || "").trim()) ||
      ONCHAIN_CONFIG.defaultChainId ||
      8453;
    const requestedChainConfig = ONCHAIN_CONFIG.chains[String(requestedChainId)];
    const requestedNetworkId = getBantahAgentKitNetworkIdForChainId(requestedChainId);

    if (!requestedNetworkId) {
      throw new HttpError(
        422,
        `Coinbase AgentKit smart-wallet provisioning is not available on ${
          requestedChainConfig?.name || `chain ${requestedChainId}`
        } yet.`,
      );
    }

    const provisionedWallet = await provisionBantahAgentWallet(
      storedAgent.agentId,
      requestedNetworkId,
    );

    const existingByWallet = await storage.getAgentByWalletAddress(provisionedWallet.walletAddress);
    if (existingByWallet && existingByWallet.agentId !== storedAgent.agentId) {
      throw new HttpError(409, "A Bantah agent wallet collision occurred. Please try again.");
    }

    const updatedRuntimeConfig =
      storedAgent.runtimeConfig && typeof storedAgent.runtimeConfig === "object"
        ? {
            ...(storedAgent.runtimeConfig as Record<string, unknown>),
            walletAddress: provisionedWallet.walletAddress,
            walletNetworkId: provisionedWallet.walletNetworkId,
            walletProvider: provisionedWallet.walletProvider,
            updatedAt: new Date().toISOString(),
          }
        : storedAgent.runtimeConfig;

    await db
      .update(agents)
      .set({
        walletAddress: provisionedWallet.walletAddress,
        walletProvider: provisionedWallet.walletProvider,
        walletNetworkId: provisionedWallet.walletNetworkId,
        ownerWalletAddress: provisionedWallet.ownerWalletAddress,
        walletData: provisionedWallet.walletData,
        runtimeConfig: updatedRuntimeConfig as any,
        updatedAt: new Date(),
      })
      .where(eq(agents.agentId, storedAgent.agentId));

    if (getManagedBantahAgentRuntime(storedAgent.agentId)) {
      await restartManagedBantahAgentRuntime(storedAgent.agentId);
    }

    const agent = await serializeAgent(storedAgent.agentId);
    await createAndPushAgentOwnerNotification(
      {
        agentId: storedAgent.agentId,
        agentName: agent.agentName,
        ownerId: storedAgent.ownerId,
      },
      {
        type: "agent_wallet_ready",
        title: "Agent wallet ready",
        message: `${agent.agentName} now has a live AgentKit wallet on ${requestedChainConfig?.name || "the selected chain"}.`,
        data: {
          walletAddress: provisionedWallet.walletAddress,
          walletNetworkId: provisionedWallet.walletNetworkId,
          chainId: requestedChainId,
        },
        priority: 2,
        fomoLevel: "medium",
      },
    );

    const payload = agentWalletProvisionResponseSchema.parse({
      agent,
      provisioned: {
        walletAddress: provisionedWallet.walletAddress,
        walletNetworkId: provisionedWallet.walletNetworkId,
        walletProvider: provisionedWallet.walletProvider,
      },
    });

    res.json(payload);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:agentId/wallet/send", PrivyAuthMiddleware, async (req, res) => {
  try {
    const storedAgent = await assertAgentOwner(req, req.params.agentId);
    if (storedAgent.agentType !== "bantah_created") {
      throw new HttpError(422, "Only Bantah-created agents support managed wallet transfers");
    }

    const parsedBody = agentWalletSendRequestSchema.parse(req.body ?? {});
    const chainConfig = resolveAgentWalletChainConfig({
      chainId: Number((storedAgent.runtimeConfig as any)?.chainId || 0) || null,
      walletNetworkId: storedAgent.walletNetworkId,
    });

    if (!chainConfig) {
      throw new HttpError(422, "Could not resolve the agent wallet network.");
    }

    const transfer = await sendBantahAgentWalletTransfer({
      snapshot: {
        agentId: storedAgent.agentId,
        walletAddress: storedAgent.walletAddress,
        walletProvider: storedAgent.walletProvider ?? undefined,
        walletNetworkId: storedAgent.walletNetworkId ?? undefined,
        ownerWalletAddress: storedAgent.ownerWalletAddress ?? undefined,
        walletData: storedAgent.walletData ?? undefined,
      },
      chainId: chainConfig.chainId,
      chainConfig,
      tokenSymbol: parsedBody.tokenSymbol,
      recipientAddress: parsedBody.recipientAddress,
      amount: parsedBody.amount,
    });

    const payload = agentWalletSendResponseSchema.parse({
      agentId: storedAgent.agentId,
      walletAddress: transfer.walletAddress,
      recipientAddress: transfer.recipientAddress,
      tokenSymbol: parsedBody.tokenSymbol,
      amount: parsedBody.amount,
      walletNetworkId: transfer.walletNetworkId,
      txHash: transfer.txHash,
      explorerUrl: buildTxExplorerUrl(transfer.txHash, chainConfig),
    });

    res.json(payload);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/runtime/:agentId", async (req, res) => {
  let requestId =
    typeof req.body?.requestId === "string" && req.body.requestId.trim().length > 0
      ? req.body.requestId.trim()
      : `runtime_${req.params.agentId}`;

  try {
    const storedAgent = await storage.getAgentById(req.params.agentId);
    if (!storedAgent || storedAgent.agentType !== "bantah_created") {
      return res.status(404).json({ message: "Bantah agent runtime not found" });
    }

    const envelope = agentActionEnvelopeSchema.parse(req.body ?? {});
    requestId = envelope.requestId;
    const runtimeResponse = await executeManagedBantahAgentRuntimeAction(
      storedAgent.agentId,
      envelope,
    );
    return res.status(runtimeResponse.status).json(runtimeResponse.envelope);
  } catch (error) {
    const response = serializeBantahSkillError(requestId, error);
    return res.status(response.status).json(response.envelope);
  }
});

router.get("/:agentId", async (req, res) => {
  try {
    const agent = await serializeAgent(req.params.agentId);
    res.json(agent);
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
