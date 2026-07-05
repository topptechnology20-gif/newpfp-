import { executeBantahSkillEnvelope } from "../bantahAgentSkillExecutor";
import { analyzeToken } from "./tokenIntelligence";
import { getBantahBroAlert, attachMarketToAlert, attachBoostToAlert, publishBantahBroAlert, registerMarketBoost } from "./alertFeed";
import { buildAlertFromAnalysis, buildMarketQuestionFromAnalysis } from "./contentEngine";
import { ensureBantahBroSystemAgent, getBantahBroSystemAgentSnapshot } from "./systemAgent";
import { calculateBoostBxbtSpend, getBxbtConfig, spendBantahBroBxbt } from "./bxbtUtility";
import { getOnchainServerConfig } from "../onchainConfig";
import { bantahBroAlertSchema, bantahBroBoostSchema, type BantahBroBoostMarketRequest, type BantahBroCreateMarketFromSignalRequest, type BantahBroMarketLink } from "@shared/bantahBro";

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

export async function createBantahBroMarketFromSignal(
  request: BantahBroCreateMarketFromSignalRequest,
) {
  let sourceAlert = request.sourceAlertId ? getBantahBroAlert(request.sourceAlertId) : null;
  let analysis;

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
  } else {
    throw new Error("Create market needs either sourceAlertId or chainId plus tokenAddress.");
  }

  const systemStatus = await ensureBantahBroSystemAgent({ preferLiveWallet: true });
  const { agent } = await getBantahBroSystemAgentSnapshot();
  const question = buildMarketQuestionFromAnalysis(analysis, request);
  const deadline = new Date(Date.now() + request.durationHours * 60 * 60 * 1000).toISOString();
  const executionChainId = resolveBantahBroExecutionChainId(request.executionChainId);

  let bxbtCharge = null;
  if (request.chargeBxbt) {
    const { marketCreationCost } = getBxbtConfig();
    bxbtCharge = await spendBantahBroBxbt({
      amount: marketCreationCost,
      reason: `Market creation for ${analysis.tokenSymbol || analysis.tokenAddress}`,
    });
  }

  const envelope = {
    action: "create_market" as const,
    requestId: `bantahbro_market_${Date.now()}`,
    skillVersion: "1.0.0",
    payload: {
      question,
      options: ["YES", "NO"],
      deadline,
      stakeAmount: request.stakeAmount,
      currency: request.currency,
      chainId: executionChainId,
    },
  };
  const result = await executeBantahSkillEnvelope(agent.agentId, envelope as any);
  const marketResult = result.result as Record<string, unknown>;
  const challengeId = Number(marketResult.marketId || marketResult.challengeId);
  if (!Number.isInteger(challengeId) || challengeId <= 0) {
    throw new Error("Market creation did not return a valid challenge id.");
  }

  const market: BantahBroMarketLink = {
    challengeId,
    url: buildChallengeUrl(challengeId),
  };

  if (sourceAlert) {
    attachMarketToAlert(sourceAlert.id, market);
  }

  const marketAlert = publishBantahBroAlert(
    bantahBroAlertSchema.parse({
      id: `bb_alert_market_${Date.now()}`,
      type: "market_live",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chainId: analysis.chainId,
      tokenAddress: analysis.tokenAddress,
      tokenSymbol: analysis.tokenSymbol,
      tokenName: analysis.tokenName,
      headline: `${analysis.tokenSymbol ? `$${analysis.tokenSymbol}` : "Token"} market is live.`,
      body: `${question}\n\nMarket live: ${market.url}`,
      sentiment: sourceAlert?.sentiment || "mixed",
      confidence: sourceAlert?.confidence || 0.5,
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
        sourcePlatform: request.sourcePlatform || "agent",
        origin: request.sourcePlatform || "agent",
      },
    }),
  );

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

export async function boostBantahBroMarket(request: BantahBroBoostMarketRequest) {
  let bxbtSpend = null;
  if (request.chargeBxbt) {
    bxbtSpend = await spendBantahBroBxbt({
      amount: calculateBoostBxbtSpend(request.multiplier, request.durationHours),
      reason: `Market boost for ${request.marketId}`,
    });
  }

  const now = new Date();
  const boost = bantahBroBoostSchema.parse({
    id: `bb_boost_${Date.now()}`,
    marketId: request.marketId,
    multiplier: request.multiplier,
    durationHours: request.durationHours,
    bxbtSpent: bxbtSpend?.amount || null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + request.durationHours * 60 * 60 * 1000).toISOString(),
  });
  registerMarketBoost(boost);

  if (request.sourceAlertId) {
    const updatedAlert = attachBoostToAlert(request.sourceAlertId, boost);
    if (updatedAlert) {
      const boostAlert = publishBantahBroAlert(
        bantahBroAlertSchema.parse({
          ...updatedAlert,
          id: `bb_alert_boost_${Date.now()}`,
          type: "boost_live",
          headline: `${updatedAlert.tokenSymbol ? `$${updatedAlert.tokenSymbol}` : "Market"} boost is live.`,
          body: `Boosted ${request.marketId} at ${request.multiplier}x for ${request.durationHours}h.`,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          boost,
        }),
      );

      return {
        boost,
        boostAlert,
        bxbtSpend,
      };
    }
  }

  return {
    boost,
    boostAlert: null,
    bxbtSpend,
  };
}
