import type {
  AgentDecision,
  AgentDecisionAction,
  AgentDecisionResponse,
} from "@shared/agentTrading";
import { storage } from "../../../storage";
import { createDecisionLog, attachOrderToDecisionLog } from "../repositories/decisionLogRepository";
import {
  createPendingAgentOrder,
  updateAgentOrder,
} from "../repositories/orderRepository";
import { upsertOpenPositionFromOrder } from "../repositories/positionRepository";
import { getPolymarketMarketById } from "./externalMarketDataService";
import { orderBuilder } from "./orderBuilder";
import { orderRouter } from "./orderRouter";
import { riskGuardService } from "./riskGuardService";
import { strategyEngine } from "./strategyEngine";
import {
  resolveAgentMaxPositionSizeUsd,
  type TradingAgentRecord,
} from "../types";

function buildManualDecision(
  agent: TradingAgentRecord,
  marketId: string,
  externalMarketId: string,
  marketQuestion: string,
  action: Extract<AgentDecisionAction, "buy_yes" | "buy_no">,
  intendedPrice: number,
): AgentDecision {
  return {
    agentId: agent.agentId,
    marketId,
    externalMarketId,
    marketQuestion,
    action,
    confidence: 0.5,
    intendedPrice,
    intendedStakeUsd: resolveAgentMaxPositionSizeUsd(agent),
    reason: `Manual ${action === "buy_yes" ? "YES" : "NO"} execution requested by the agent owner.`,
    strategyType: "probability_threshold",
    createdAt: new Date().toISOString(),
  };
}

export async function decideForAgentMarket(
  agentId: string,
  marketId: string,
): Promise<AgentDecisionResponse> {
  const agent = (await storage.getAgentById(agentId)) as TradingAgentRecord | undefined;
  if (!agent) {
    throw new Error("Agent not found");
  }

  const market = await getPolymarketMarketById(marketId);
  if (!market) {
    throw new Error("Market not found");
  }

  const decision = await strategyEngine(agent, market);
  const risk = await riskGuardService(agent, market, decision);
  await createDecisionLog(decision, risk, null);

  return {
    decision,
    risk,
    routingAttempted: false,
    order: null,
  };
}

export async function executeAgentDecision(
  agentId: string,
  marketId: string,
  action?: Extract<AgentDecisionAction, "buy_yes" | "buy_no">,
): Promise<AgentDecisionResponse> {
  const agent = (await storage.getAgentById(agentId)) as TradingAgentRecord | undefined;
  if (!agent) {
    throw new Error("Agent not found");
  }

  const market = await getPolymarketMarketById(marketId);
  if (!market) {
    throw new Error("Market not found");
  }

  const decision =
    action != null
      ? buildManualDecision(
          agent,
          market.id,
          market.polymarketMarketId,
          market.question,
          action,
          action === "buy_yes" ? market.yesPrice : market.noPrice,
        )
      : await strategyEngine(agent, market);

  const risk = await riskGuardService(agent, market, decision);
  const decisionLog = await createDecisionLog(decision, risk, null);

  if (!risk.allowed || decision.action === "skip") {
    return {
      decision,
      risk,
      routingAttempted: false,
      order: null,
    };
  }

  const built = orderBuilder(decision);
  let order = await createPendingAgentOrder(built);
  await attachOrderToDecisionLog(decisionLog.id, order.id);

  const routed = await orderRouter(agent, order);
  order = await updateAgentOrder(order.id, {
    status: routed.status,
    externalOrderId: routed.externalOrderId,
    failureReason: routed.failureReason,
    lastSyncedAt: new Date(),
  });

  if (routed.status === "filled") {
    await upsertOpenPositionFromOrder(order);
  }

  return {
    decision,
    risk,
    routingAttempted: routed.routingAttempted,
    order,
  };
}
