import { and, desc, eq, gte, inArray } from "drizzle-orm";

import type { AgentOrder } from "@shared/agentTrading";
import { agentOrders } from "@shared/schema";
import { db } from "../../../db";
import { parseDecimal, toIsoString } from "../types";

type CreateAgentOrderInput = {
  agentId: string;
  marketId: string;
  externalMarketId: string;
  marketQuestion?: string | null;
  side: "yes" | "no";
  intendedStakeUsd: number;
  intendedPrice: number;
};

function toAgentOrder(row: typeof agentOrders.$inferSelect): AgentOrder {
  return {
    id: row.id,
    agentId: row.agentId,
    marketId: row.marketId,
    externalMarketId: row.externalMarketId,
    marketQuestion: row.marketQuestion ?? null,
    side: row.side,
    action: "buy",
    intendedStakeUsd: parseDecimal(row.intendedStakeUsd),
    intendedPrice: parseDecimal(row.intendedPrice),
    externalOrderId: row.externalOrderId ?? null,
    status: row.status,
    failureReason: row.failureReason ?? null,
    lastSyncedAt: toIsoString(row.lastSyncedAt),
    createdAt: toIsoString(row.createdAt) || new Date().toISOString(),
    updatedAt: toIsoString(row.updatedAt) || new Date().toISOString(),
  };
}

export async function createPendingAgentOrder(input: CreateAgentOrderInput): Promise<AgentOrder> {
  const [created] = await db
    .insert(agentOrders)
    .values({
      agentId: input.agentId,
      marketId: input.marketId,
      externalMarketId: input.externalMarketId,
      marketQuestion: input.marketQuestion ?? null,
      side: input.side,
      action: "buy",
      intendedStakeUsd: input.intendedStakeUsd.toFixed(2),
      intendedPrice: input.intendedPrice.toFixed(4),
      status: "pending",
      updatedAt: new Date(),
    })
    .returning();

  return toAgentOrder(created);
}

export async function updateAgentOrder(
  orderId: string,
  updates: {
    status?: AgentOrder["status"];
    externalOrderId?: string | null;
    failureReason?: string | null;
    lastSyncedAt?: Date | null;
  },
): Promise<AgentOrder> {
  const [updated] = await db
    .update(agentOrders)
    .set({
      status: updates.status,
      externalOrderId: updates.externalOrderId ?? undefined,
      failureReason: updates.failureReason ?? undefined,
      lastSyncedAt: updates.lastSyncedAt ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(agentOrders.id, orderId))
    .returning();

  return toAgentOrder(updated);
}

export async function listAgentOrders(agentId: string, limit = 50): Promise<AgentOrder[]> {
  const rows = await db
    .select()
    .from(agentOrders)
    .where(eq(agentOrders.agentId, agentId))
    .orderBy(desc(agentOrders.createdAt))
    .limit(limit);

  return rows.map(toAgentOrder);
}

export async function countAgentDailyTrades(agentId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ id: agentOrders.id })
    .from(agentOrders)
    .where(
      and(
        eq(agentOrders.agentId, agentId),
        gte(agentOrders.createdAt, since),
        inArray(agentOrders.status, ["pending", "submitted", "partially_filled", "filled"]),
      ),
    );

  return rows.length;
}

export async function listAgentOrderSyncCandidates(limit = 100): Promise<AgentOrder[]> {
  const rows = await db
    .select()
    .from(agentOrders)
    .where(inArray(agentOrders.status, ["submitted", "partially_filled"]))
    .orderBy(desc(agentOrders.updatedAt))
    .limit(limit);

  return rows.map(toAgentOrder);
}
