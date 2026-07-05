import { and, asc, eq, inArray } from "drizzle-orm";
import { ZodError } from "zod";
import {
  type AgentActionEnvelope,
  type BantahSkillErrorCode,
  type CreateP2PMarketInput,
  type SkillErrorResponse,
  type SkillSuccessEnvelope,
  checkBalanceInputSchema,
  createP2PMarketInputSchema,
  createMarketInputSchema,
  joinMarketInputSchema,
  readLeaderboardInputSchema,
  readMarketInputSchema,
} from "@shared/agentSkill";
import { pairQueue } from "@shared/schema";
import {
  normalizeOnchainTokenSymbol,
  toAtomicUnits,
  type OnchainTokenSymbol,
} from "@shared/onchainConfig";
import { storage } from "./storage";
import { db } from "./db";
import { createPairingEngine } from "./pairingEngine";
import { getOnchainServerConfig } from "./onchainConfig";
import {
  createAndPushAgentOwnerNotification,
  getAgentRankSnapshot,
  pushRealtimeNotification,
  notifyAgentRankChangeIfNeeded,
} from "./agentNotificationService";
import {
  BantahAgentWalletError,
  buildSkillErrorEnvelope,
  buildSkillSuccessEnvelope,
  executeBantahAgentEscrowStakeTx,
  getBantahAgentWalletBalance,
} from "./agentProvisioning";
import { assertAllowedStakeToken } from "./onchainEscrowService";

const ONCHAIN_CONFIG = getOnchainServerConfig();
const pairingEngine = createPairingEngine(db);

export class BantahSkillHttpError extends Error {
  status: number;
  details?: unknown;
  code?: BantahSkillErrorCode;

  constructor(
    status: number,
    message: string,
    details?: unknown,
    code?: BantahSkillErrorCode,
  ) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function notifyAgentFollowers(params: {
  agentId: string;
  agentName: string;
  type: "followed_agent_created_market" | "followed_agent_joined_market";
  title: string;
  message: string;
  challengeId: number;
  data?: Record<string, unknown>;
}) {
  const followerIds = await storage.getAgentFollowerIds(params.agentId);
  if (followerIds.length === 0) {
    return;
  }

  await Promise.all(
    followerIds.map(async (followerId) => {
      const notification = await storage.createNotification({
        userId: followerId,
        type: params.type,
        title: params.title,
        message: params.message,
        icon: "agent",
        data: {
          agentId: params.agentId,
          agentName: params.agentName,
          challengeId: params.challengeId,
          ...params.data,
        },
      } as any);

      await pushRealtimeNotification(followerId, {
        ...notification,
        event: params.type,
        challengeId: String(params.challengeId),
        timestamp: new Date().toISOString(),
        data: {
          ...(notification as any).data,
          challengeId: params.challengeId,
        },
      });
    }),
  );
}

function parseRuntimeMarketId(marketId: string): number {
  const numericMarketId = Number.parseInt(String(marketId || "").trim(), 10);
  if (!Number.isInteger(numericMarketId) || numericMarketId <= 0) {
    throw new BantahSkillHttpError(400, "Market id must be a valid Bantah challenge id");
  }
  return numericMarketId;
}

function parseStakeAmount(stakeAmount: string): { parsedAmount: number; roundedAmount: number } {
  const parsedAmount = Number.parseFloat(String(stakeAmount || "").trim());
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new BantahSkillHttpError(400, "Stake amount must be a valid positive number");
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

function buildAgentWalletSnapshot(storedAgent: Awaited<ReturnType<typeof getStoredBantahAgent>>) {
  return {
    agentId: storedAgent.agentId,
    walletProvider: storedAgent.walletProvider ?? null,
    walletNetworkId: storedAgent.walletNetworkId ?? null,
    walletAddress: storedAgent.walletAddress,
    ownerWalletAddress: storedAgent.ownerWalletAddress ?? null,
    walletData: storedAgent.walletData ?? null,
  };
}

function toSkillHttpErrorFromWalletError(
  error: BantahAgentWalletError,
  details?: Record<string, unknown>,
) {
  if (error.code === "insufficient_balance") {
    return new BantahSkillHttpError(409, error.message, details, "insufficient_balance");
  }

  if (error.code === "unsupported_chain") {
    return new BantahSkillHttpError(501, error.message, details, "unsupported_action");
  }

  if (error.code === "wallet_not_provisioned" || error.code === "wallet_provision_failed") {
    return new BantahSkillHttpError(503, error.message, details, "internal_error");
  }

  return new BantahSkillHttpError(502, error.message, details, "internal_error");
}

function resolveOnchainRuntimeToken(chainId: number, currency: string) {
  const tokenSymbol = normalizeOnchainTokenSymbol(currency) as OnchainTokenSymbol;
  const chainConfig = ONCHAIN_CONFIG.chains[String(chainId)];

  if (!chainConfig) {
    throw new BantahSkillHttpError(400, "Unsupported chain for Bantah agent runtime");
  }

  const tokenConfig = chainConfig.tokens[tokenSymbol];
  const isSupportedToken = Array.isArray(chainConfig.supportedTokens)
    ? chainConfig.supportedTokens.includes(tokenSymbol)
    : Boolean(tokenConfig);

  if (!tokenConfig || !isSupportedToken) {
    throw new BantahSkillHttpError(
      400,
      `Token ${tokenSymbol} is not supported on chain ${chainConfig.name}`,
    );
  }

  return { chainConfig, tokenConfig, tokenSymbol };
}

async function getRuntimeMarketSnapshot(challengeId: number) {
  const challenge = await storage.getChallengeById(challengeId);
  if (!challenge) {
    throw new BantahSkillHttpError(404, "Market not found");
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
      participantType === "agent" ? String(entry.agentId || "") : String(entry.userId || "");

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

async function getStoredBantahAgent(agentId: string) {
  const storedAgent = await storage.getAgentById(agentId);
  if (!storedAgent || storedAgent.agentType !== "bantah_created") {
    throw new BantahSkillHttpError(404, "Bantah agent runtime not found");
  }

  return storedAgent;
}

type ResolvedP2POpponent = {
  challengedUserId: string | null;
  challengedAgentId: string | null;
  challengedWalletAddress: string | null;
  challengedType: "human" | "agent";
  challengedLabel: string;
};

async function resolveP2POpponentTarget(
  storedAgent: Awaited<ReturnType<typeof getStoredBantahAgent>>,
  input: CreateP2PMarketInput,
): Promise<ResolvedP2POpponent> {
  if (input.challengedAgentId) {
    const challengedAgent = await storage.getAgentById(input.challengedAgentId);
    if (!challengedAgent) {
      throw new BantahSkillHttpError(404, "Target agent was not found.");
    }

    if (challengedAgent.agentId === storedAgent.agentId) {
      throw new BantahSkillHttpError(400, "Agent cannot challenge itself.");
    }

    return {
      challengedUserId: challengedAgent.ownerId || null,
      challengedAgentId: challengedAgent.agentId,
      challengedWalletAddress: null,
      challengedType: "agent",
      challengedLabel: challengedAgent.agentName || challengedAgent.agentId,
    };
  }

  if (input.challengedUsername) {
    const normalizedTarget = input.challengedUsername.replace(/^@+/, "").trim();
    const challengedUser =
      (await storage.getUser(normalizedTarget)) ||
      (await storage.getUserByUsername(normalizedTarget));

    if (!challengedUser) {
      throw new BantahSkillHttpError(404, "Target user was not found.");
    }

    if (challengedUser.id === storedAgent.ownerId) {
      throw new BantahSkillHttpError(400, "Agent cannot challenge its own owner.");
    }

    return {
      challengedUserId: challengedUser.id,
      challengedAgentId: null,
      challengedWalletAddress: null,
      challengedType: "human",
      challengedLabel:
        challengedUser.username ||
        challengedUser.firstName ||
        challengedUser.lastName ||
        challengedUser.id,
    };
  }

  if (input.challengedWalletAddress) {
    if (
      storedAgent.walletAddress &&
      storedAgent.walletAddress.toLowerCase() === input.challengedWalletAddress.toLowerCase()
    ) {
      throw new BantahSkillHttpError(400, "Agent cannot challenge its own wallet.");
    }

    return {
      challengedUserId: null,
      challengedAgentId: null,
      challengedWalletAddress: input.challengedWalletAddress,
      challengedType: "human",
      challengedLabel: `${input.challengedWalletAddress.slice(0, 6)}...${input.challengedWalletAddress.slice(-4)}`,
    };
  }

  throw new BantahSkillHttpError(
    400,
    "Create P2P market requires an opponent target.",
  );
}

export async function executeBantahSkillEnvelope(
  agentId: string,
  envelope: AgentActionEnvelope,
): Promise<SkillSuccessEnvelope> {
  const storedAgent = await getStoredBantahAgent(agentId);
  const requestId = envelope.requestId;

  switch (envelope.action) {
    case "create_market": {
      const parsed = createMarketInputSchema.safeParse(envelope.payload);
      if (!parsed.success) {
        throw new BantahSkillHttpError(400, "Market payload is invalid.");
      }

      const deadline = new Date(parsed.data.deadline);
      if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
        throw new BantahSkillHttpError(400, "Deadline must be a future ISO datetime.");
      }

      const previousRank = await getAgentRankSnapshot(storedAgent.agentId);
      const { tokenConfig, tokenSymbol, chainConfig } = resolveOnchainRuntimeToken(
        parsed.data.chainId,
        parsed.data.currency,
      );
      const { roundedAmount } = parseStakeAmount(parsed.data.stakeAmount);
      const createdChallenge = await storage.createAdminChallenge({
        title: parsed.data.question.trim(),
        description: `Created by ${storedAgent.agentName} via Bantah agent runtime`,
        category: storedAgent.specialty === "general" ? "general" : storedAgent.specialty,
        amount: roundedAmount,
        status: "open",
        creatorType: "agent",
        creatorAgentId: storedAgent.agentId,
        createdByAgent: true,
        agentInvolved: true,
        dueDate: deadline,
        settlementRail: "onchain",
        chainId: chainConfig.chainId,
        tokenSymbol,
        tokenAddress: tokenConfig.address,
        decimals: tokenConfig.decimals,
        stakeAtomic: toAtomicUnits(parsed.data.stakeAmount, tokenConfig.decimals),
        evidence: {
          source: "bantah_agent_runtime",
          createdByAgentId: storedAgent.agentId,
          marketOptions: parsed.data.options,
        },
      } as any);

      await storage.incrementAgentMarketCount(storedAgent.agentId);
      await createAndPushAgentOwnerNotification(storedAgent, {
        type: "agent_market_created",
        title: "Agent created a market",
        message: `${storedAgent.agentName} created "${createdChallenge.title}".`,
        data: {
          challengeId: createdChallenge.id,
          action: "create_market",
          side: null,
        },
        priority: 2,
        fomoLevel: "medium",
      });
      await notifyAgentFollowers({
        agentId: storedAgent.agentId,
        agentName: storedAgent.agentName,
        type: "followed_agent_created_market",
        title: "Followed agent created a market",
        message: `${storedAgent.agentName} created "${createdChallenge.title}".`,
        challengeId: createdChallenge.id,
        data: {
          action: "create_market",
          side: null,
          },
        });
      await notifyAgentRankChangeIfNeeded(
        storedAgent.agentId,
        previousRank?.rank ?? null,
        "market_created",
        { challengeId: createdChallenge.id },
      );

      return buildSkillSuccessEnvelope(requestId, {
        marketId: String(createdChallenge.id),
        status: "open",
        question: createdChallenge.title,
        options: parsed.data.options.map((label, index) => ({
          id: `option_${index + 1}`,
          label,
        })),
        deadline: deadline.toISOString(),
        stakeAmount: parsed.data.stakeAmount,
        currency: tokenSymbol,
        chainId: chainConfig.chainId,
        creatorWalletAddress: storedAgent.walletAddress,
      });
    }

    case "join_yes":
    case "join_no": {
      const parsed = joinMarketInputSchema.safeParse(envelope.payload);
      if (!parsed.success) {
        throw new BantahSkillHttpError(400, "Join payload is invalid.");
      }

        const numericMarketId = parseRuntimeMarketId(parsed.data.marketId);
        const { challenge, dueDateIso } = await getRuntimeMarketSnapshot(numericMarketId);
        const side = envelope.action === "join_yes" ? "yes" : "no";
        const previousRank = await getAgentRankSnapshot(storedAgent.agentId);
        const { roundedAmount } = parseStakeAmount(parsed.data.stakeAmount);
        const tokenSymbol = normalizeOnchainTokenSymbol(
          challenge.tokenSymbol || ONCHAIN_CONFIG.defaultToken || "USDC",
      ) as OnchainTokenSymbol;
      const chainId = Number(
        challenge.chainId || ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId,
      );

      if (!challenge.adminCreated && challenge.createdByAgent !== true) {
        throw new BantahSkillHttpError(
          501,
          "Agent joins are currently limited to open Bantah market feeds.",
          { marketId: parsed.data.marketId },
        );
      }

      if (String(challenge.status || "").trim().toLowerCase() !== "open") {
        throw new BantahSkillHttpError(409, "Market is no longer open.", {
          marketId: parsed.data.marketId,
        });
      }

      if (dueDateIso && new Date(dueDateIso).getTime() <= Date.now()) {
        throw new BantahSkillHttpError(409, "Market deadline has already passed.", {
          marketId: parsed.data.marketId,
        });
      }

      const isOnchainChallenge =
        String(challenge.settlementRail || "").trim().toLowerCase() === "onchain";
      const { chainConfig, tokenConfig } = resolveOnchainRuntimeToken(chainId, tokenSymbol);
      let joinEscrowTxHash: string | null = null;
      const agentWalletSnapshot = buildAgentWalletSnapshot(storedAgent);

      if (isOnchainChallenge && ONCHAIN_CONFIG.contractEnabled && !tokenConfig.isNative) {
        const resolvedTokenAddress = challenge.tokenAddress || tokenConfig.address;
        if (!resolvedTokenAddress) {
          throw new BantahSkillHttpError(
            400,
            `Token ${tokenSymbol} is not configured on chain ${chainConfig.name}.`,
            { marketId: parsed.data.marketId, side, chainId, currency: tokenSymbol },
          );
        }

        try {
          await assertAllowedStakeToken({
            rpcUrl: chainConfig.rpcUrl,
            tokenAddress: resolvedTokenAddress,
            tokenSymbol,
          });
        } catch (tokenError: any) {
          throw new BantahSkillHttpError(
            400,
            tokenError?.message ||
              `Token ${tokenSymbol} is not allowed for onchain challenge staking.`,
            { marketId: parsed.data.marketId, side, chainId, currency: tokenSymbol },
          );
        }
      }

      const requiredAmount = Number(challenge.amount || 0);
      if (!Number.isInteger(requiredAmount) || requiredAmount <= 0 || roundedAmount !== requiredAmount) {
        throw new BantahSkillHttpError(
          400,
          `Market requires exactly ${requiredAmount} ${tokenSymbol} for each entry.`,
          {
            marketId: parsed.data.marketId,
            requiredAmount: String(requiredAmount),
            currency: tokenSymbol,
          },
        );
      }

      const [existingEntry] = await db
        .select({
          id: pairQueue.id,
          status: pairQueue.status,
        })
        .from(pairQueue)
        .where(
          and(
            eq(pairQueue.challengeId, numericMarketId),
            eq(pairQueue.agentId, storedAgent.agentId),
            inArray(pairQueue.status, ["waiting", "matched"]),
          ),
        )
        .limit(1);

      if (existingEntry) {
        return buildSkillSuccessEnvelope(requestId, {
          marketId: String(numericMarketId),
          side,
          acceptedStakeAmount: String(requiredAmount),
          currency: tokenSymbol,
          chainId,
          status: existingEntry.status === "matched" ? "matched" : "queued",
        });
      }

      const ownerBalance = await storage.getUserBalance(storedAgent.ownerId);
      if (!isOnchainChallenge && Number(ownerBalance.balance || 0) < requiredAmount) {
        throw new BantahSkillHttpError(
          409,
          "Agent owner does not have enough available balance to queue this market.",
          {
            marketId: parsed.data.marketId,
            requiredAmount: String(requiredAmount),
            currency: tokenSymbol,
          },
          "insufficient_balance",
        );
      }

      if (isOnchainChallenge && ONCHAIN_CONFIG.contractEnabled) {
        const requiredAmountAtomic =
          typeof challenge.stakeAtomic === "string" && /^\d+$/.test(challenge.stakeAtomic)
            ? challenge.stakeAtomic
            : toAtomicUnits(String(requiredAmount), tokenConfig.decimals);

        try {
          const walletBalance = await getBantahAgentWalletBalance({
            snapshot: agentWalletSnapshot,
            chainId,
            chainConfig,
            tokenSymbol,
          });
          if (BigInt(walletBalance.amountAtomic) < BigInt(requiredAmountAtomic)) {
            throw new BantahSkillHttpError(
              409,
              `Agent wallet balance is too low for this ${tokenSymbol} stake.`,
              {
                marketId: parsed.data.marketId,
                chainId,
                currency: tokenSymbol,
                walletAddress: walletBalance.walletAddress,
                walletNetworkId: walletBalance.walletNetworkId,
                availableBalance: walletBalance.amountFormatted,
                requiredAmount: String(requiredAmount),
              },
              "insufficient_balance",
            );
          }
        } catch (error) {
          if (error instanceof BantahSkillHttpError) {
            throw error;
          }
          if (error instanceof BantahAgentWalletError) {
            throw toSkillHttpErrorFromWalletError(error, {
              marketId: parsed.data.marketId,
              chainId,
              currency: tokenSymbol,
            });
          }
          throw error;
        }

        try {
          const escrowExecution = await executeBantahAgentEscrowStakeTx({
            snapshot: agentWalletSnapshot,
            chainId,
            chainConfig,
            tokenSymbol,
            amount: String(requiredAmount),
            amountAtomic: requiredAmountAtomic,
          });
          joinEscrowTxHash = escrowExecution.escrowTxHash;
        } catch (error) {
          if (error instanceof BantahAgentWalletError) {
            throw toSkillHttpErrorFromWalletError(error, {
              marketId: parsed.data.marketId,
              chainId,
              currency: tokenSymbol,
            });
          }
          throw error;
        }
      }

      const joinResult = await pairingEngine.joinChallenge(
        storedAgent.ownerId,
        String(numericMarketId),
        side.toUpperCase() as "YES" | "NO",
        requiredAmount,
        {
          participantType: "agent",
          agentId: storedAgent.agentId,
          participantLabel: storedAgent.agentName,
        },
      );

      if (!joinResult.success) {
        throw new BantahSkillHttpError(
          400,
          joinResult.message || "Unable to join market.",
          { marketId: parsed.data.marketId, side, currency: tokenSymbol },
        );
      }

      if (!isOnchainChallenge) {
        await storage.createTransaction({
          userId: storedAgent.ownerId,
          type: "challenge_queue_stake",
          amount: `-${requiredAmount}`,
          description: `Agent ${storedAgent.agentName} queued on challenge #${numericMarketId} (${side.toUpperCase()})`,
          relatedId: numericMarketId,
          status: "completed",
        });
        }

        await storage.incrementAgentMarketCount(storedAgent.agentId);
        await createAndPushAgentOwnerNotification(storedAgent, {
          type: "agent_market_joined",
          title: "Agent joined a market",
          message: `${storedAgent.agentName} joined ${side.toUpperCase()} on "${challenge.title}".`,
          data: {
            challengeId: numericMarketId,
            action: envelope.action,
            side,
          },
          priority: 2,
          fomoLevel: "medium",
        });
        await notifyAgentFollowers({
          agentId: storedAgent.agentId,
          agentName: storedAgent.agentName,
        type: "followed_agent_joined_market",
        title: "Followed agent joined a market",
        message: `${storedAgent.agentName} joined ${side.toUpperCase()} on "${challenge.title}".`,
        challengeId: numericMarketId,
        data: {
          action: envelope.action,
            side,
          },
        });
        await notifyAgentRankChangeIfNeeded(
          storedAgent.agentId,
          previousRank?.rank ?? null,
          "market_joined",
          { challengeId: numericMarketId, side },
        );

        if (joinEscrowTxHash) {
        const refreshedChallenge = await storage.getChallengeById(numericMarketId);
        if (refreshedChallenge) {
          const mergedEscrowHashes = mergeEscrowTxHashes(
            refreshedChallenge.escrowTxHash,
            joinEscrowTxHash,
          );
          if (mergedEscrowHashes !== refreshedChallenge.escrowTxHash) {
            await storage.updateChallenge(numericMarketId, {
              escrowTxHash: mergedEscrowHashes,
            } as any);
          }
        }
      }

      return buildSkillSuccessEnvelope(requestId, {
        marketId: String(numericMarketId),
        side,
        acceptedStakeAmount: String(requiredAmount),
        currency: tokenSymbol,
        chainId,
        status: joinResult.match ? "matched" : "queued",
        escrowTxHash: joinEscrowTxHash,
      });
    }

    case "read_market": {
      const parsed = readMarketInputSchema.safeParse(envelope.payload);
      if (!parsed.success) {
        throw new BantahSkillHttpError(400, "Market lookup payload is invalid.");
      }

      const numericMarketId = parseRuntimeMarketId(parsed.data.marketId);
      const marketSnapshot = await getRuntimeMarketSnapshot(numericMarketId);

      if (!marketSnapshot.dueDateIso) {
        throw new BantahSkillHttpError(
          400,
          "Market exists but does not have a valid deadline.",
          { marketId: parsed.data.marketId },
        );
      }

      const yesOdds = marketSnapshot.totalPool > 0 ? marketSnapshot.yesPool / marketSnapshot.totalPool : 0.5;
      const noOdds = marketSnapshot.totalPool > 0 ? marketSnapshot.noPool / marketSnapshot.totalPool : 0.5;

      return buildSkillSuccessEnvelope(requestId, {
        marketId: String(numericMarketId),
        status: marketSnapshot.status,
        currency: normalizeOnchainTokenSymbol(
          marketSnapshot.challenge.tokenSymbol || ONCHAIN_CONFIG.defaultToken || "USDC",
        ),
        chainId: Number(
          marketSnapshot.challenge.chainId ||
            ONCHAIN_CONFIG.defaultChainId ||
            ONCHAIN_CONFIG.chainId,
        ),
        odds: {
          yes: Number(yesOdds.toFixed(4)),
          no: Number(noOdds.toFixed(4)),
        },
        participants: marketSnapshot.participants.map((participant) => ({
          participantId: participant.participantId,
          participantType: participant.participantType,
          side: participant.side,
          stakeAmount: participant.stakeAmount,
        })),
        deadline: marketSnapshot.dueDateIso,
        totalPool: String(marketSnapshot.totalPool),
        yesPool: String(marketSnapshot.yesPool),
        noPool: String(marketSnapshot.noPool),
      });
    }

    case "check_balance": {
      const parsed = checkBalanceInputSchema.safeParse(envelope.payload);
      if (!parsed.success) {
        throw new BantahSkillHttpError(400, "Balance payload is invalid.");
      }

      const { tokenSymbol, chainConfig } = resolveOnchainRuntimeToken(
        parsed.data.chainId,
        parsed.data.currency,
      );
      const walletBalance = await getBantahAgentWalletBalance({
        snapshot: {
          agentId: storedAgent.agentId,
          walletProvider: storedAgent.walletProvider ?? null,
          walletNetworkId: storedAgent.walletNetworkId ?? null,
          walletAddress: storedAgent.walletAddress,
          ownerWalletAddress: storedAgent.ownerWalletAddress ?? null,
          walletData: storedAgent.walletData ?? null,
        },
        chainId: chainConfig.chainId,
        chainConfig,
        tokenSymbol,
      });

      return buildSkillSuccessEnvelope(requestId, {
        walletAddress: walletBalance.walletAddress,
        currency: tokenSymbol,
        chainId: chainConfig.chainId,
        availableBalance: walletBalance.amountFormatted,
        updatedAt: new Date().toISOString(),
      });
    }

    case "read_leaderboard": {
      const parsed = readLeaderboardInputSchema.safeParse(envelope.payload);
      if (!parsed.success) {
        throw new BantahSkillHttpError(400, "Leaderboard payload is invalid.");
      }

      const leaderboard = await storage.getLeaderboard(parsed.data.limit);

      return buildSkillSuccessEnvelope(requestId, {
        entries: leaderboard.map((entry) => ({
          rank: Number(entry.rank || 0),
          userId: entry.id,
          username: entry.username || null,
          displayName:
            entry.username ||
            entry.firstName ||
            entry.lastName ||
            null,
          points: Number(entry.points || 0),
          coins: Number(entry.coins || 0),
          eventsWon: Number(entry.eventsWon || 0),
          challengesWon: Number(entry.challengesWon || 0),
        })),
        generatedAt: new Date().toISOString(),
      });
    }

    case "create_p2p_market": {
      const parsed = createP2PMarketInputSchema.safeParse(envelope.payload);
      if (!parsed.success) {
        throw new BantahSkillHttpError(400, "P2P market payload is invalid.");
      }

      const deadline = new Date(parsed.data.deadline);
      if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
        throw new BantahSkillHttpError(400, "Deadline must be a future ISO datetime.");
      }

      const previousRank = await getAgentRankSnapshot(storedAgent.agentId);
      const { chainConfig, tokenConfig, tokenSymbol } = resolveOnchainRuntimeToken(
        parsed.data.chainId,
        parsed.data.currency,
      );
      const { roundedAmount } = parseStakeAmount(parsed.data.stakeAmount);
      const challengedSide = parsed.data.challengerSide === "yes" ? "no" : "yes";
      const opponent = await resolveP2POpponentTarget(storedAgent, parsed.data);
      const requiredAmountAtomic = toAtomicUnits(parsed.data.stakeAmount, tokenConfig.decimals);
      const agentWalletSnapshot = buildAgentWalletSnapshot(storedAgent);

      let escrowTxHash: string | null = null;

      try {
        const walletBalance = await getBantahAgentWalletBalance({
          snapshot: agentWalletSnapshot,
          chainId: chainConfig.chainId,
          chainConfig,
          tokenSymbol,
        });

        if (BigInt(walletBalance.amountAtomic) < BigInt(requiredAmountAtomic)) {
          throw new BantahSkillHttpError(
            409,
            `Agent wallet balance is too low for this ${tokenSymbol} stake.`,
            {
              chainId: chainConfig.chainId,
              currency: tokenSymbol,
              walletAddress: walletBalance.walletAddress,
              availableBalance: walletBalance.amountFormatted,
              requiredAmount: parsed.data.stakeAmount,
            },
            "insufficient_balance",
          );
        }
      } catch (error) {
        if (error instanceof BantahSkillHttpError) {
          throw error;
        }
        if (error instanceof BantahAgentWalletError) {
          throw toSkillHttpErrorFromWalletError(error, {
            chainId: chainConfig.chainId,
            currency: tokenSymbol,
          });
        }
        throw error;
      }

      try {
        const escrowExecution = await executeBantahAgentEscrowStakeTx({
          snapshot: agentWalletSnapshot,
          chainId: chainConfig.chainId,
          chainConfig,
          tokenSymbol,
          amount: parsed.data.stakeAmount,
          amountAtomic: requiredAmountAtomic,
        });
        escrowTxHash = escrowExecution.escrowTxHash;
      } catch (error) {
        if (error instanceof BantahAgentWalletError) {
          throw toSkillHttpErrorFromWalletError(error, {
            chainId: chainConfig.chainId,
            currency: tokenSymbol,
          });
        }
        throw error;
      }

      const createdChallenge = await storage.createChallenge({
        challenger: storedAgent.ownerId,
        challenged: opponent.challengedUserId || undefined,
        challengedWalletAddress: opponent.challengedWalletAddress || undefined,
        creatorType: "agent",
        challengerType: "agent",
        challengedType: opponent.challengedType,
        creatorAgentId: storedAgent.agentId,
        challengerAgentId: storedAgent.agentId,
        challengedAgentId: opponent.challengedAgentId || undefined,
        createdByAgent: true,
        agentInvolved: true,
        title: parsed.data.question.trim(),
        description:
          parsed.data.description?.trim() ||
          `P2P market created by ${storedAgent.agentName} via Bantah agent runtime`,
        category: parsed.data.category.trim().toLowerCase(),
        amount: roundedAmount,
        challengerSide: parsed.data.challengerSide.toUpperCase(),
        challengedSide: challengedSide.toUpperCase(),
        status:
          opponent.challengedUserId || opponent.challengedWalletAddress || opponent.challengedAgentId
            ? "pending"
            : "open",
        evidence: {
          source: "bantah_agent_runtime",
          createdByAgentId: storedAgent.agentId,
          marketType: "p2p",
          challengedLabel: opponent.challengedLabel,
        },
        settlementRail: "onchain",
        chainId: chainConfig.chainId,
        tokenSymbol,
        tokenAddress: tokenConfig.address,
        decimals: tokenConfig.decimals,
        stakeAtomic: requiredAmountAtomic,
        escrowTxHash: escrowTxHash || undefined,
        dueDate: deadline,
      } as any);

      await storage.incrementAgentMarketCount(storedAgent.agentId);
      await createAndPushAgentOwnerNotification(storedAgent, {
        type: "agent_market_created",
        title: "Agent opened a P2P market",
        message: `${storedAgent.agentName} challenged ${opponent.challengedLabel} on "${createdChallenge.title}".`,
        data: {
          challengeId: createdChallenge.id,
          action: "create_p2p_market",
          challengedLabel: opponent.challengedLabel,
          challengerSide: parsed.data.challengerSide,
        },
        priority: 2,
        fomoLevel: "high",
      });
      await notifyAgentFollowers({
        agentId: storedAgent.agentId,
        agentName: storedAgent.agentName,
        type: "followed_agent_created_market",
        title: "Followed agent opened a P2P market",
        message: `${storedAgent.agentName} challenged ${opponent.challengedLabel} on "${createdChallenge.title}".`,
        challengeId: createdChallenge.id,
        data: {
          action: "create_p2p_market",
          challengerSide: parsed.data.challengerSide,
          challengedSide,
          challengedLabel: opponent.challengedLabel,
        },
      });
      await notifyAgentRankChangeIfNeeded(
        storedAgent.agentId,
        previousRank?.rank ?? null,
        "market_created",
        {
          challengeId: createdChallenge.id,
          marketType: "p2p",
        },
      );

      if (opponent.challengedUserId) {
        const notification = await storage.createNotification({
          userId: opponent.challengedUserId,
          type: "challenge",
          title: "New P2P market request",
          message: `${storedAgent.agentName} challenged you to "${createdChallenge.title}"`,
          icon: "agent",
          data: {
            challengeId: createdChallenge.id,
            challengerName: storedAgent.agentName,
            challengeTitle: createdChallenge.title,
            amount: createdChallenge.amount,
            category: createdChallenge.category,
            chainId: createdChallenge.chainId,
            tokenSymbol: createdChallenge.tokenSymbol,
          },
        } as any);

        await pushRealtimeNotification(opponent.challengedUserId, {
          ...notification,
          event: "challenge_received",
          challengeId: String(createdChallenge.id),
          timestamp: new Date().toISOString(),
          data: {
            ...(notification as any).data,
            challengeId: createdChallenge.id,
          },
        });
      }

      return buildSkillSuccessEnvelope(requestId, {
        marketId: String(createdChallenge.id),
        status:
          String(createdChallenge.status || "").trim().toLowerCase() === "active"
            ? "active"
            : String(createdChallenge.status || "").trim().toLowerCase() === "open"
              ? "open"
              : "pending",
        question: createdChallenge.title,
        description: createdChallenge.description || null,
        deadline: deadline.toISOString(),
        stakeAmount: String(createdChallenge.amount),
        currency: tokenSymbol,
        chainId: chainConfig.chainId,
        challengerSide: parsed.data.challengerSide,
        challengedSide,
        challengerWalletAddress: storedAgent.walletAddress,
        challengedUserId: opponent.challengedUserId,
        challengedAgentId: opponent.challengedAgentId,
        challengedWalletAddress: opponent.challengedWalletAddress,
        challengedLabel: opponent.challengedLabel,
        escrowTxHash: escrowTxHash || undefined,
      });
    }

    default:
      throw new BantahSkillHttpError(
        501,
        `Action ${envelope.action} is not supported by the Bantah runtime yet.`,
      );
  }
}

export function serializeBantahSkillError(
  requestId: string,
  error: unknown,
): { status: number; envelope: SkillErrorResponse } {
  if (error instanceof ZodError) {
    return {
      status: 400,
      envelope: buildSkillErrorEnvelope(
        requestId,
        "invalid_input",
        "Runtime payload failed validation.",
        { issues: error.issues },
      ),
    };
  }

  if (error instanceof BantahSkillHttpError) {
    const code =
      error.code ||
      (error.status === 401
        ? "unauthorized"
        : error.status === 429
          ? "rate_limited"
          : error.status === 500
            ? "internal_error"
            : error.status === 501
              ? "unsupported_action"
              : error.status === 409
                ? "market_closed"
                : "invalid_input");

    return {
      status: error.status,
      envelope: buildSkillErrorEnvelope(
        requestId,
        code,
        error.message,
        error.details && typeof error.details === "object"
          ? (error.details as Record<string, unknown>)
          : undefined,
      ),
    };
  }

  if (error instanceof BantahAgentWalletError) {
    const status =
      error.code === "unsupported_chain"
        ? 501
        : error.code === "insufficient_balance"
          ? 409
          : error.code === "wallet_not_provisioned" || error.code === "wallet_provision_failed"
            ? 503
          : 500;
    return {
      status,
      envelope: buildSkillErrorEnvelope(
        requestId,
        status === 501
          ? "unsupported_action"
          : status === 409
            ? "insufficient_balance"
            : "internal_error",
        error.message,
      ),
    };
  }

  console.error("Bantah agent runtime error:", error);
  return {
    status: 500,
    envelope: buildSkillErrorEnvelope(
      requestId,
      "internal_error",
      "Failed to execute Bantah agent runtime action",
    ),
  };
}
