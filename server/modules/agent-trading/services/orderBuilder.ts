import type { AgentDecision } from "@shared/agentTrading";

export type BuiltAgentOrderRequest = {
  agentId: string;
  marketId: string;
  externalMarketId: string;
  marketQuestion: string | null;
  side: "yes" | "no";
  action: "buy";
  intendedStakeUsd: number;
  intendedPrice: number;
};

export function orderBuilder(decision: AgentDecision): BuiltAgentOrderRequest {
  if (decision.action === "skip" || decision.intendedPrice == null || decision.intendedStakeUsd == null) {
    throw new Error("Cannot build an order from a skipped decision.");
  }

  return {
    agentId: decision.agentId,
    marketId: decision.marketId,
    externalMarketId: decision.externalMarketId,
    marketQuestion: decision.marketQuestion ?? null,
    side: decision.action === "buy_yes" ? "yes" : "no",
    action: "buy",
    intendedStakeUsd: decision.intendedStakeUsd,
    intendedPrice: decision.intendedPrice,
  };
}
