import type { AgentDecision } from "@shared/agentTrading";
import type { ExternalMarket } from "@shared/externalMarkets";
import type { TradingAgentRecord } from "../types";
import { resolveAgentMaxPositionSizeUsd, resolveProbabilityThresholdConfig } from "../types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildConfidence(price: number, threshold: number): number {
  if (threshold <= 0) return 0.1;
  const gapRatio = Math.max(0, threshold - price) / threshold;
  return clamp(Number((0.45 + gapRatio * 0.5).toFixed(2)), 0.05, 0.95);
}

export function probabilityThresholdStrategy(
  agent: TradingAgentRecord,
  market: ExternalMarket,
): AgentDecision {
  const config = resolveProbabilityThresholdConfig(agent);
  const intendedStakeUsd = resolveAgentMaxPositionSizeUsd(agent);
  const createdAt = new Date().toISOString();
  const yesEligible = market.yesPrice < config.yesBuyBelow;
  const noEligible = market.noPrice < config.noBuyBelow;

  if (!yesEligible && !noEligible) {
    return {
      agentId: agent.agentId,
      marketId: market.id,
      externalMarketId: market.polymarketMarketId,
      marketQuestion: market.question,
      action: "skip",
      confidence: 0.12,
      intendedPrice: null,
      intendedStakeUsd: null,
      reason: `Skipped because YES (${market.yesPrice.toFixed(2)}) and NO (${market.noPrice.toFixed(2)}) are both above the configured buy thresholds.`,
      strategyType: "probability_threshold",
      createdAt,
    };
  }

  if (yesEligible && (!noEligible || market.yesPrice <= market.noPrice)) {
    return {
      agentId: agent.agentId,
      marketId: market.id,
      externalMarketId: market.polymarketMarketId,
      marketQuestion: market.question,
      action: "buy_yes",
      confidence: buildConfidence(market.yesPrice, config.yesBuyBelow),
      intendedPrice: market.yesPrice,
      intendedStakeUsd,
      reason: `YES is trading at ${market.yesPrice.toFixed(2)}, below the configured buy threshold of ${config.yesBuyBelow.toFixed(2)}.`,
      strategyType: "probability_threshold",
      createdAt,
    };
  }

  return {
    agentId: agent.agentId,
    marketId: market.id,
    externalMarketId: market.polymarketMarketId,
    marketQuestion: market.question,
    action: "buy_no",
    confidence: buildConfidence(market.noPrice, config.noBuyBelow),
    intendedPrice: market.noPrice,
    intendedStakeUsd,
    reason: `NO is trading at ${market.noPrice.toFixed(2)}, below the configured buy threshold of ${config.noBuyBelow.toFixed(2)}.`,
    strategyType: "probability_threshold",
    createdAt,
  };
}
