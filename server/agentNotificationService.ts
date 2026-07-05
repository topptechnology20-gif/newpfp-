import { desc, eq } from "drizzle-orm";
import Pusher from "pusher";
import { agents } from "@shared/schema";
import { db } from "./db";
import { storage } from "./storage";

const pusher = new Pusher({
  appId: "1553294",
  key: "decd2cca5e39cf0cbcd4",
  secret: "1dd966e56c465ea285d9",
  cluster: "mt1",
  useTLS: true,
});

type AgentNotificationTarget = {
  agentId: string;
  agentName: string;
  ownerId: string;
};

export type AgentRankSnapshot = AgentNotificationTarget & {
  rank: number | null;
  totalAgents: number;
};

function sanitizePusherChannel(value: string): string {
  return String(value || "").replace(/[^a-zA-Z0-9_\-=@,.;]/g, "_");
}

export async function pushRealtimeNotification(
  userId: string,
  payload: Record<string, unknown>,
) {
  const sanitizedUserId = sanitizePusherChannel(userId);
  if (!sanitizedUserId) return;

  try {
    await pusher.trigger(`user-${sanitizedUserId}`, "notification", payload);
  } catch (error) {
    console.error("Failed to push realtime notification:", error);
  }
}

export async function getAgentNotificationTarget(
  agentId: string,
): Promise<AgentNotificationTarget | null> {
  const agent = await storage.getAgentById(agentId);
  if (!agent) return null;

  return {
    agentId: agent.agentId,
    agentName: agent.agentName,
    ownerId: agent.ownerId,
  };
}

export async function getAgentRankSnapshot(
  agentId: string,
): Promise<AgentRankSnapshot | null> {
  const target = await getAgentNotificationTarget(agentId);
  if (!target) return null;

  const rankedAgents = await db
    .select({
      agentId: agents.agentId,
    })
    .from(agents)
    .where(eq(agents.status, "active"))
    .orderBy(
      desc(agents.points),
      desc(agents.winCount),
      desc(agents.marketCount),
      desc(agents.createdAt),
    );

  const rankIndex = rankedAgents.findIndex((row) => row.agentId === agentId);

  return {
    ...target,
    rank: rankIndex >= 0 ? rankIndex + 1 : null,
    totalAgents: rankedAgents.length,
  };
}

export async function createAndPushAgentOwnerNotification(
  target: AgentNotificationTarget,
  params: {
    type: string;
    title: string;
    message: string;
    data?: Record<string, unknown>;
    priority?: number;
    fomoLevel?: string;
  },
) {
  const notification = await storage.createNotification({
    userId: target.ownerId,
    type: params.type,
    title: params.title,
    message: params.message,
    icon: "agent",
    data: {
      agentId: target.agentId,
      agentName: target.agentName,
      ...params.data,
    },
    priority: params.priority,
    fomoLevel: params.fomoLevel,
  } as any);

  await pushRealtimeNotification(target.ownerId, {
    ...notification,
    event: params.type,
    timestamp: new Date().toISOString(),
    data: {
      ...(notification as any).data,
      agentId: target.agentId,
      agentName: target.agentName,
      ...params.data,
    },
  });

  return notification;
}

function buildRankChangeMessage(
  agentName: string,
  previousRank: number | null,
  nextRank: number | null,
) {
  if (previousRank == null && nextRank != null) {
    return `${agentName} entered the leaderboard at #${nextRank}.`;
  }
  if (previousRank != null && nextRank == null) {
    return `${agentName} is no longer on the active leaderboard.`;
  }
  if (previousRank != null && nextRank != null && nextRank < previousRank) {
    return `${agentName} moved up from #${previousRank} to #${nextRank}.`;
  }
  if (previousRank != null && nextRank != null && nextRank > previousRank) {
    return `${agentName} moved from #${previousRank} to #${nextRank}.`;
  }
  if (nextRank != null) {
    return `${agentName} is now ranked #${nextRank}.`;
  }
  return `${agentName} had a leaderboard update.`;
}

export async function notifyAgentRankChangeIfNeeded(
  agentId: string,
  previousRank: number | null,
  reason: string,
  data?: Record<string, unknown>,
) {
  const snapshot = await getAgentRankSnapshot(agentId);
  if (!snapshot) return null;
  if (snapshot.rank === previousRank) return snapshot;

  await createAndPushAgentOwnerNotification(snapshot, {
    type: "agent_rank_changed",
    title: "Agent ranking updated",
    message: buildRankChangeMessage(snapshot.agentName, previousRank, snapshot.rank),
    data: {
      previousRank,
      newRank: snapshot.rank,
      totalAgents: snapshot.totalAgents,
      reason,
      ...data,
    },
    priority: 2,
    fomoLevel: "medium",
  });

  return snapshot;
}
