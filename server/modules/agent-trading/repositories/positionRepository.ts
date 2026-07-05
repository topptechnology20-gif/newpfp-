import { and, desc, eq, inArray } from "drizzle-orm";

import type { AgentOrder, AgentPosition } from "@shared/agentTrading";
import { agentPositions } from "@shared/schema";
import { db } from "../../../db";
import { parseDecimal, toIsoString } from "../types";

function toAgentPosition(row: typeof agentPositions.$inferSelect): AgentPosition {
  return {
    id: row.id,
    agentId: row.agentId,
    marketId: row.marketId,
    externalMarketId: row.externalMarketId,
    marketQuestion: row.marketQuestion ?? null,
    side: row.side,
    totalShares: parseDecimal(row.totalShares),
    avgEntryPrice: parseDecimal(row.avgEntryPrice),
    currentMarkPrice: row.currentMarkPrice == null ? null : parseDecimal(row.currentMarkPrice),
    realizedPnl: parseDecimal(row.realizedPnl),
    unrealizedPnl: parseDecimal(row.unrealizedPnl),
    status: row.status,
    openedAt: toIsoString(row.openedAt) || new Date().toISOString(),
    closedAt: toIsoString(row.closedAt),
    lastSyncedAt: toIsoString(row.lastSyncedAt),
    updatedAt: toIsoString(row.updatedAt) || new Date().toISOString(),
  };
}

export async function listAgentPositions(agentId: string): Promise<AgentPosition[]> {
  const rows = await db
    .select()
    .from(agentPositions)
    .where(eq(agentPositions.agentId, agentId))
    .orderBy(desc(agentPositions.updatedAt));

  return rows.map(toAgentPosition);
}

export async function countAgentOpenPositions(agentId: string): Promise<number> {
  const rows = await db
    .select({ id: agentPositions.id })
    .from(agentPositions)
    .where(and(eq(agentPositions.agentId, agentId), eq(agentPositions.status, "open")));

  return rows.length;
}

export async function listOpenAgentPositions(limit = 100): Promise<AgentPosition[]> {
  const rows = await db
    .select()
    .from(agentPositions)
    .where(inArray(agentPositions.status, ["open"]))
    .orderBy(desc(agentPositions.updatedAt))
    .limit(limit);

  return rows.map(toAgentPosition);
}

export async function upsertOpenPositionFromOrder(order: AgentOrder): Promise<AgentPosition> {
  const shareCount =
    order.intendedPrice > 0 ? Number((order.intendedStakeUsd / order.intendedPrice).toFixed(6)) : 0;

  const existing = await db
    .select()
    .from(agentPositions)
    .where(
      and(
        eq(agentPositions.agentId, order.agentId),
        eq(agentPositions.externalMarketId, order.externalMarketId),
        eq(agentPositions.side, order.side),
        eq(agentPositions.status, "open"),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const currentShares = parseDecimal(existing[0].totalShares);
    const currentAvg = parseDecimal(existing[0].avgEntryPrice);
    const totalShares = currentShares + shareCount;
    const avgEntryPrice =
      totalShares > 0
        ? ((currentShares * currentAvg + shareCount * order.intendedPrice) / totalShares).toFixed(4)
        : order.intendedPrice.toFixed(4);

    const [updated] = await db
      .update(agentPositions)
      .set({
        marketQuestion: order.marketQuestion ?? existing[0].marketQuestion,
        totalShares: totalShares.toFixed(6),
        avgEntryPrice,
        updatedAt: new Date(),
      })
      .where(eq(agentPositions.id, existing[0].id))
      .returning();

    return toAgentPosition(updated);
  }

  const [created] = await db
    .insert(agentPositions)
    .values({
      agentId: order.agentId,
      marketId: order.marketId,
      externalMarketId: order.externalMarketId,
      marketQuestion: order.marketQuestion ?? null,
      side: order.side,
      totalShares: shareCount.toFixed(6),
      avgEntryPrice: order.intendedPrice.toFixed(4),
      status: "open",
      updatedAt: new Date(),
    })
    .returning();

  return toAgentPosition(created);
}

export async function updateAgentPositionMark(
  positionId: string,
  currentMarkPrice: number | null,
  unrealizedPnl: number,
): Promise<AgentPosition> {
  const [updated] = await db
    .update(agentPositions)
    .set({
      currentMarkPrice: currentMarkPrice == null ? null : currentMarkPrice.toFixed(4),
      unrealizedPnl: unrealizedPnl.toFixed(4),
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentPositions.id, positionId))
    .returning();

  return toAgentPosition(updated);
}
