import { eq, desc } from "drizzle-orm";

import type { AgentDecision, RiskCheckResult } from "@shared/agentTrading";
import { decisionLogs } from "@shared/schema";
import { db } from "../../../db";
import { toIsoString, parseDecimal } from "../types";

export type DecisionLogEntry = {
  id: string;
  agentId: string;
  marketId: string;
  externalMarketId: string;
  marketQuestion: string | null;
  strategyType: string;
  action: string;
  confidence: number;
  intendedPrice: number | null;
  intendedStakeUsd: number | null;
  reason: string;
  riskAllowed: boolean;
  riskReasons: string[];
  linkedOrderId: string | null;
  createdAt: string;
};

function toDecisionLogEntry(row: typeof decisionLogs.$inferSelect): DecisionLogEntry {
  return {
    id: row.id,
    agentId: row.agentId,
    marketId: row.marketId,
    externalMarketId: row.externalMarketId,
    marketQuestion: row.marketQuestion ?? null,
    strategyType: row.strategyType,
    action: row.action,
    confidence: parseDecimal(row.confidence),
    intendedPrice: row.intendedPrice == null ? null : parseDecimal(row.intendedPrice),
    intendedStakeUsd: row.intendedStakeUsd == null ? null : parseDecimal(row.intendedStakeUsd),
    reason: row.reason,
    riskAllowed: row.riskAllowed,
    riskReasons: Array.isArray(row.riskReasons) ? row.riskReasons.map(String) : [],
    linkedOrderId: row.linkedOrderId ?? null,
    createdAt: toIsoString(row.createdAt) || new Date().toISOString(),
  };
}

export async function createDecisionLog(
  decision: AgentDecision,
  risk: RiskCheckResult,
  linkedOrderId?: string | null,
): Promise<DecisionLogEntry> {
  const [created] = await db
    .insert(decisionLogs)
    .values({
      agentId: decision.agentId,
      marketId: decision.marketId,
      externalMarketId: decision.externalMarketId,
      marketQuestion: decision.marketQuestion ?? null,
      strategyType: decision.strategyType,
      action: decision.action,
      confidence: decision.confidence.toFixed(4),
      intendedPrice: decision.intendedPrice == null ? null : decision.intendedPrice.toFixed(4),
      intendedStakeUsd:
        decision.intendedStakeUsd == null ? null : decision.intendedStakeUsd.toFixed(2),
      reason: decision.reason,
      riskAllowed: risk.allowed,
      riskReasons: risk.reasons,
      linkedOrderId: linkedOrderId ?? null,
    })
    .returning();

  return toDecisionLogEntry(created);
}

export async function attachOrderToDecisionLog(
  decisionLogId: string,
  linkedOrderId: string,
): Promise<DecisionLogEntry> {
  const [updated] = await db
    .update(decisionLogs)
    .set({ linkedOrderId })
    .where(eq(decisionLogs.id, decisionLogId))
    .returning();

  return toDecisionLogEntry(updated);
}

export async function listRecentDecisionLogs(agentId: string, limit = 10): Promise<DecisionLogEntry[]> {
  const rows = await db
    .select()
    .from(decisionLogs)
    .where(eq(decisionLogs.agentId, agentId))
    .orderBy(desc(decisionLogs.createdAt))
    .limit(limit);

  return rows.map(toDecisionLogEntry);
}
