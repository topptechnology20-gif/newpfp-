import { desc, eq } from "drizzle-orm";

import type { AgentPerformanceResponse } from "@shared/agentTrading";
import { decisionLogs } from "@shared/schema";
import { db } from "../../../db";
import { listAgentOrders } from "../../agent-trading/repositories/orderRepository";
import { listAgentPositions } from "../../agent-trading/repositories/positionRepository";
import { toIsoString } from "../../agent-trading/types";

export async function performanceService(agentId: string): Promise<AgentPerformanceResponse> {
  const [orders, positions, latestDecision] = await Promise.all([
    listAgentOrders(agentId, 200),
    listAgentPositions(agentId),
    db
      .select({ createdAt: decisionLogs.createdAt })
      .from(decisionLogs)
      .where(eq(decisionLogs.agentId, agentId))
      .orderBy(desc(decisionLogs.createdAt))
      .limit(1),
  ]);

  const totalTrades = orders.filter((item) =>
    ["submitted", "partially_filled", "filled"].includes(item.status),
  ).length;
  const openPositionsCount = positions.filter((item) => item.status === "open").length;
  const totalSubmittedVolume = Number(
    orders
      .reduce((total, item) => total + item.intendedStakeUsd, 0)
      .toFixed(2),
  );
  const realizedPnl = Number(
    positions.reduce((total, item) => total + item.realizedPnl, 0).toFixed(4),
  );
  const unrealizedPnl = Number(
    positions.reduce((total, item) => total + item.unrealizedPnl, 0).toFixed(4),
  );
  const latestActivityAt =
    orders[0]?.updatedAt ||
    positions[0]?.updatedAt ||
    toIsoString(latestDecision[0]?.createdAt) ||
    null;

  return {
    agentId,
    totalTrades,
    openPositionsCount,
    totalSubmittedVolume,
    realizedPnl,
    unrealizedPnl,
    latestActivityAt,
  };
}
