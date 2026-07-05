import type { AgentDecision } from "@shared/agentTrading";
import type { ExternalMarket } from "@shared/externalMarkets";
import type { TradingAgentRecord } from "../types";
import { probabilityThresholdStrategy } from "../strategies/probabilityThresholdStrategy";

export async function strategyEngine(
  agent: TradingAgentRecord,
  market: ExternalMarket,
): Promise<AgentDecision> {
  switch (agent.strategyType || "probability_threshold") {
    case "probability_threshold":
    default:
      return probabilityThresholdStrategy(agent, market);
  }
}
