import type { AgentDecision, RiskCheckResult } from "@shared/agentTrading";
import type { ExternalMarket } from "@shared/externalMarkets";
import { getAgentTradingReadiness } from "./tradingReadinessService";
import { isMarketTradable } from "./marketEligibilityService";
import {
  resolveAgentMaxPositionSizeUsd,
  resolveAgentRiskProfile,
  type TradingAgentRecord,
} from "../types";

export async function riskGuardService(
  agent: TradingAgentRecord,
  market: ExternalMarket,
  decision: AgentDecision,
): Promise<RiskCheckResult> {
  const readiness = await getAgentTradingReadiness(agent.agentId);
  const reasons = [...readiness.reasons];
  const riskProfile = resolveAgentRiskProfile(agent);

  if (!isMarketTradable(market, agent)) {
    reasons.push("Market is not tradable for this agent right now.");
  }

  if (decision.intendedStakeUsd != null && decision.intendedStakeUsd > resolveAgentMaxPositionSizeUsd(agent)) {
    reasons.push("Stake exceeds this agent's max position size.");
  }

  if (
    market.category &&
    riskProfile.blockedCategories
      .map((entry) => entry.trim().toLowerCase())
      .includes(market.category.trim().toLowerCase())
  ) {
    reasons.push("Agent is blocked from this market category.");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
