import {
  getBantahAgentWalletBalance,
  BantahAgentWalletError,
} from "../../../agentProvisioning";
import { getOnchainServerConfig } from "../../../onchainConfig";
import { storage } from "../../../storage";
import { getBantahAgentKitChainIdForNetworkId } from "@shared/agentApi";
import type { TradingReadinessResponse } from "@shared/agentTrading";
import {
  resolveAgentMaxPositionSizeUsd,
  resolveAgentRiskProfile,
  type TradingAgentRecord,
} from "../types";
import { countAgentDailyTrades } from "../repositories/orderRepository";
import { countAgentOpenPositions } from "../repositories/positionRepository";

const ONCHAIN_CONFIG = getOnchainServerConfig();

function startOfToday(): Date {
  const value = new Date();
  value.setHours(0, 0, 0, 0);
  return value;
}

function resolveAgentChainId(agent: TradingAgentRecord): number | null {
  const runtimeChainId =
    agent.runtimeConfig && typeof agent.runtimeConfig === "object"
      ? Number((agent.runtimeConfig as { chainId?: unknown }).chainId || 0)
      : 0;

  if (Number.isInteger(runtimeChainId) && runtimeChainId > 0) {
    return runtimeChainId;
  }

  return agent.walletNetworkId ? getBantahAgentKitChainIdForNetworkId(agent.walletNetworkId) : null;
}

export async function isAgentWalletReady(agent: TradingAgentRecord): Promise<boolean> {
  const readiness = await getAgentTradingReadiness(agent.agentId);
  return readiness.walletReady;
}

export function isAgentTradable(agent: TradingAgentRecord): boolean {
  return agent.status === "active" && agent.canTrade;
}

export async function getAgentTradingReadiness(agentId: string): Promise<TradingReadinessResponse> {
  const agent = (await storage.getAgentById(agentId)) as TradingAgentRecord | undefined;
  if (!agent) {
    throw new Error("Agent not found");
  }

  const openPositionsCount = await countAgentOpenPositions(agent.agentId);
  const dailyTradesUsed = await countAgentDailyTrades(agent.agentId, startOfToday());
  const reasons: string[] = [];

  if (agent.status !== "active") reasons.push("Agent status must be active.");
  if (!agent.canTrade) reasons.push("Trading is disabled for this agent.");
  if (!agent.walletAddress) reasons.push("Agent wallet is missing.");

  const riskProfile = resolveAgentRiskProfile(agent);
  if (!riskProfile) reasons.push("Risk profile is missing.");

  if (openPositionsCount >= Number(agent.maxOpenPositions || 0 || 3)) {
    reasons.push("Agent has reached its max open positions.");
  }

  if (dailyTradesUsed >= Number(agent.dailyTradeLimit || 5)) {
    reasons.push("Agent has reached its daily trade limit.");
  }

  let walletReady = false;
  let balanceAmount: string | null = null;
  let balanceCurrency: string | null = null;

  if (agent.agentType !== "bantah_created") {
    reasons.push("Imported agent wallet routing is not enabled in Phase 1.");
  } else if (agent.walletProvider !== "cdp_smart_wallet") {
    reasons.push("AgentKit wallet provisioning is required before trading.");
  } else {
    const chainId = resolveAgentChainId(agent);
    const chainConfig = chainId ? ONCHAIN_CONFIG.chains[String(chainId)] : undefined;

    if (!chainId || !chainConfig) {
      reasons.push("Agent chain configuration is missing.");
    } else {
      const tokenSymbol = chainConfig.supportedTokens?.includes("USDC")
        ? "USDC"
        : (chainConfig.supportedTokens?.[0] ?? null);

      if (!tokenSymbol) {
        reasons.push("No supported trading token is configured for this agent wallet.");
      } else {
        try {
          const balance = await getBantahAgentWalletBalance({
            snapshot: {
              agentId: agent.agentId,
              walletAddress: agent.walletAddress,
              walletProvider: agent.walletProvider ?? undefined,
              walletNetworkId: agent.walletNetworkId ?? undefined,
              ownerWalletAddress: null,
              walletData: null,
            },
            chainId,
            chainConfig,
            tokenSymbol,
          });

          balanceAmount = balance.amountFormatted;
          balanceCurrency = tokenSymbol;
          walletReady = Number.parseFloat(balance.amountFormatted) >= resolveAgentMaxPositionSizeUsd(agent);

          if (!walletReady) {
            reasons.push("Agent wallet balance is below its max position size.");
          }
        } catch (error) {
          const message =
            error instanceof BantahAgentWalletError
              ? error.message
              : "Failed to read the agent wallet balance.";
          reasons.push(message);
        }
      }
    }
  }

  return {
    agentId: agent.agentId,
    canTrade: reasons.length === 0,
    walletReady,
    balanceSummary: {
      address: agent.walletAddress,
      currency: balanceCurrency,
      amount: balanceAmount,
    },
    openPositionsCount,
    dailyTradesUsed,
    dailyTradeLimit: Number(agent.dailyTradeLimit || 5),
    maxOpenPositions: Number(agent.maxOpenPositions || 3),
    reasons,
  };
}
