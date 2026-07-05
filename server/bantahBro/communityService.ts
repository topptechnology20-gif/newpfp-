import { readLeaderboardResultSchema } from "@shared/agentSkill";
import {
  bantahBroAlertSchema,
  type BantahBroCreateP2PMarketRequest,
  type BantahBroMarketLink,
} from "@shared/bantahBro";
import { executeBantahSkillEnvelope } from "../bantahAgentSkillExecutor";
import { getOnchainServerConfig } from "../onchainConfig";
import { getBantahBroAlert, attachMarketToAlert, publishBantahBroAlert } from "./alertFeed";
import { spendBantahBroBxbt, getBxbtConfig } from "./bxbtUtility";
import { buildAlertFromAnalysis, buildMarketQuestionFromAnalysis } from "./contentEngine";
import { ensureBantahBroSystemAgent, getBantahBroSystemAgentSnapshot } from "./systemAgent";
import { analyzeToken } from "./tokenIntelligence";

function buildChallengeUrl(challengeId: number) {
  const baseUrl =
    String(process.env.FRONTEND_URL || "").trim() ||
    String(process.env.RENDER_EXTERNAL_URL || "").trim() ||
    `http://localhost:${Number(process.env.PORT || 5000)}`;
  return new URL(`/challenges/${challengeId}/activity`, baseUrl).toString();
}

function parsePositiveIntegerEnv(name: string): number | null {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveBantahBroExecutionChainId(requestedChainId?: number) {
  const onchain = getOnchainServerConfig();
  const resolvedChainId =
    requestedChainId ||
    parsePositiveIntegerEnv("BANTAHBRO_DEFAULT_EXECUTION_CHAIN_ID") ||
    parsePositiveIntegerEnv("BANTAHBRO_AGENT_CHAIN_ID") ||
    onchain.defaultChainId;
  const chainConfig = onchain.chains[String(resolvedChainId)];
  if (!chainConfig) {
    throw new Error(
      `BantahBro execution chain ${resolvedChainId} is not enabled in ONCHAIN_ENABLED_CHAINS.`,
    );
  }
  return chainConfig.chainId;
}

export async function getBantahBroLeaderboard(limit = 10) {
  const systemAgent = await ensureBantahBroSystemAgent({ preferLiveWallet: true });
  const { agent } = await getBantahBroSystemAgentSnapshot();
  const result = await executeBantahSkillEnvelope(agent.agentId, {
    action: "read_leaderboard",
    requestId: `bantahbro_leaderboard_${Date.now()}`,
    skillVersion: "1.0.0",
    payload: {
      limit,
    },
  } as any);

  const leaderboard = readLeaderboardResultSchema.parse(result.result);
  return {
    ...leaderboard,
    systemAgent,
  };
}

export async function createBantahBroP2PMarket(request: BantahBroCreateP2PMarketRequest) {
  let sourceAlert = request.sourceAlertId ? getBantahBroAlert(request.sourceAlertId) : null;
  let analysis: Awaited<ReturnType<typeof analyzeToken>> | null = null;

  if (request.sourceAlertId && !sourceAlert) {
    const notFoundError = new Error(`Source alert ${request.sourceAlertId} was not found.`);
    (notFoundError as Error & { status?: number }).status = 404;
    throw notFoundError;
  }

  if (sourceAlert) {
    analysis = await analyzeToken({
      chainId: sourceAlert.chainId,
      tokenAddress: sourceAlert.tokenAddress,
    });
  } else if (request.chainId && request.tokenAddress) {
    analysis = await analyzeToken({
      chainId: request.chainId,
      tokenAddress: request.tokenAddress,
    });
    sourceAlert = buildAlertFromAnalysis(analysis);
    publishBantahBroAlert(sourceAlert);
  }

  const systemStatus = await ensureBantahBroSystemAgent({ preferLiveWallet: true });
  const { agent } = await getBantahBroSystemAgentSnapshot();
  const question =
    request.question?.trim() ||
    (analysis
      ? buildMarketQuestionFromAnalysis(analysis, {
          durationHours: request.durationHours,
          stakeAmount: request.stakeAmount,
          currency: request.currency,
        } as any)
      : null);

  if (!question) {
    throw new Error("P2P market creation needs an explicit question or token signal context.");
  }

  const deadline =
    request.deadline ||
    new Date(Date.now() + request.durationHours * 60 * 60 * 1000).toISOString();
  const executionChainId = resolveBantahBroExecutionChainId(request.executionChainId);

  let bxbtCharge = null;
  if (request.chargeBxbt) {
    const { marketCreationCost } = getBxbtConfig();
    bxbtCharge = await spendBantahBroBxbt({
      amount: marketCreationCost,
      reason: `P2P market for ${question.slice(0, 120)}`,
    });
  }

  const envelope = {
    action: "create_p2p_market" as const,
    requestId: `bantahbro_p2p_${Date.now()}`,
    skillVersion: "1.0.0",
    payload: {
      question,
      description: request.description,
      category: request.category,
      deadline,
      stakeAmount: request.stakeAmount,
      currency: request.currency,
      chainId: executionChainId,
      challengerSide: request.challengerSide,
      challengedUsername: request.challengedUsername,
      challengedWalletAddress: request.challengedWalletAddress,
      challengedAgentId: request.challengedAgentId,
    },
  };

  const result = await executeBantahSkillEnvelope(agent.agentId, envelope as any);
  const marketResult = result.result as Record<string, unknown>;
  const challengeId = Number(marketResult.marketId || marketResult.challengeId);
  if (!Number.isInteger(challengeId) || challengeId <= 0) {
    throw new Error("P2P market creation did not return a valid challenge id.");
  }

  const market: BantahBroMarketLink = {
    challengeId,
    url: buildChallengeUrl(challengeId),
  };

  if (sourceAlert) {
    attachMarketToAlert(sourceAlert.id, market);
  }

  let marketAlert = null;
  if (analysis) {
    marketAlert = publishBantahBroAlert(
      bantahBroAlertSchema.parse({
        id: `bb_alert_p2p_${Date.now()}`,
        type: "market_live",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        chainId: analysis.chainId,
        tokenAddress: analysis.tokenAddress,
        tokenSymbol: analysis.tokenSymbol,
        tokenName: analysis.tokenName,
        headline: `${analysis.tokenSymbol ? `$${analysis.tokenSymbol}` : "Token"} P2P market is live.`,
        body: `${question}\n\n${String(marketResult.challengedLabel || "Opponent")} is on the other side.\n${market.url}`,
        sentiment: sourceAlert?.sentiment || "mixed",
        confidence: sourceAlert?.confidence || 0.6,
        rugScore: analysis.rug.score,
        momentumScore: analysis.momentum.score,
        referencePriceUsd: analysis.primaryPair?.priceUsd ?? null,
        sourceAnalysisAt: analysis.generatedAt,
        market,
        boost: null,
        metadata: {
          sourceAlertId: sourceAlert?.id || null,
          chargedBxbt: Boolean(bxbtCharge),
          systemAgentId: systemStatus.agentId,
          executionChainId,
          marketType: "p2p",
          challengedLabel: marketResult.challengedLabel || null,
          challengerSide: marketResult.challengerSide || null,
          challengedSide: marketResult.challengedSide || null,
        },
      }),
    );
  }

  return {
    sourceAlert,
    analysis,
    market,
    marketResult,
    marketAlert,
    bxbtCharge,
    systemAgent: systemStatus,
  };
}
