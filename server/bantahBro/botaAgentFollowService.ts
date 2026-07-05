import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { pushRealtimeNotification } from "../agentNotificationService";
import {
  getBotaFighterProfile,
  normalizeBotaFighterAgentId,
} from "./botaFighterProfileService";
import type { BotaFighterProfile } from "@shared/botaFighterProfile";
import { notifyBotaUser } from "./botaNotificationService";

type FollowState = {
  agentId: string;
  followerCount: number;
  following: boolean;
};

type ToggleFollowInput = {
  agentId: string;
  userId: string;
  agentName?: string | null;
};

let ensureFollowsTablePromise: Promise<void> | null = null;
const memoryFollows = new Map<string, Set<string>>();

function tableRows(result: unknown): any[] {
  if (Array.isArray(result)) return result;
  const rows = (result as any)?.rows;
  return Array.isArray(rows) ? rows : [];
}

function titleCase(value?: string | null) {
  return String(value || "BOTA Agent")
    .replace(/[-_:]/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function warnFollowFallback(scope: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[BOTA] Agent follow DB unavailable during ${scope}; using in-memory fallback: ${message}`);
}

function getMemoryFollowers(agentId: string) {
  const normalizedAgentId = normalizeBotaFighterAgentId(agentId);
  let followers = memoryFollows.get(normalizedAgentId);
  if (!followers) {
    followers = new Set<string>();
    memoryFollows.set(normalizedAgentId, followers);
  }
  return followers;
}

function memoryFollowState(agentId: string, userId?: string | null): FollowState {
  const normalizedAgentId = normalizeBotaFighterAgentId(agentId);
  const followers = getMemoryFollowers(normalizedAgentId);
  const viewerUserId = String(userId || "").trim();
  return {
    agentId: normalizedAgentId,
    followerCount: followers.size,
    following: viewerUserId ? followers.has(viewerUserId) : false,
  };
}

function toggleMemoryFollow(agentId: string, userId: string) {
  const normalizedAgentId = normalizeBotaFighterAgentId(agentId);
  const followers = getMemoryFollowers(normalizedAgentId);
  const wasFollowing = followers.has(userId);
  if (wasFollowing) {
    followers.delete(userId);
  } else {
    followers.add(userId);
  }
  return {
    agentId: normalizedAgentId,
    following: !wasFollowing,
    followerCount: followers.size,
    updatedAt: new Date().toISOString(),
  };
}

function getProfileOwnerUserId(profile: BotaFighterProfile | null | undefined) {
  const metadata = (profile?.metadata || {}) as Record<string, unknown>;
  const candidates = [
    metadata.importedByUserId,
    metadata.ownerUserId,
    metadata.userId,
    metadata.ownerId,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }

  return null;
}

async function userLabel(userId: string) {
  try {
    const user = await storage.getUser(userId);
    const anyUser = user as any;
    const label =
      anyUser?.username ||
      anyUser?.firstName ||
      anyUser?.email ||
      anyUser?.walletAddress ||
      anyUser?.primaryWalletAddress;
    return label ? String(label).replace(/^@/, "") : "someone";
  } catch {
    return "someone";
  }
}

async function createAndPushFollowNotification(
  userId: string | null | undefined,
  params: {
    type: string;
    title: string;
    message: string;
    agentId: string;
    agentName: string;
    followerUserId?: string | null;
    followerName?: string | null;
    priority?: number;
  },
) {
  const targetUserId = String(userId || "").trim();
  if (!targetUserId) return;

  await notifyBotaUser({
    userId: targetUserId,
    type: params.type,
    title: params.title,
    message: params.message,
    icon: "B",
    url: "/bota?section=agents",
    data: {
      agentId: params.agentId,
      agentName: params.agentName,
      followerId: params.followerUserId || null,
      followerName: params.followerName || null,
      followerUserId: params.followerUserId || null,
    },
    fomoLevel: "medium",
    priority: params.priority || 2,
  });
  return;

  try {
    const notification = await storage.createNotification({
      userId: targetUserId,
      type: params.type,
      title: params.title,
      message: params.message,
      icon: "👥",
      data: {
        agentId: params.agentId,
        agentName: params.agentName,
        followerId: params.followerUserId || null,
        followerName: params.followerName || null,
        followerUserId: params.followerUserId || null,
        url: "/bota?section=agents",
      },
      channels: ["in_app_feed", "push_notification"],
      fomoLevel: "medium",
      priority: params.priority || 2,
      read: false,
    } as any);

    await pushRealtimeNotification(targetUserId, {
      ...notification,
      event: params.type,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[BOTA] Agent follow notification failed:", error);
  }
}

export async function ensureBotaAgentFollowsTable() {
  if (!ensureFollowsTablePromise) {
    ensureFollowsTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bota_agent_follows" (
        "id" varchar(64) PRIMARY KEY NOT NULL,
        "agent_id" varchar(180) NOT NULL,
        "follower_user_id" varchar(180) NOT NULL,
        "agent_owner_user_id" varchar(180),
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "bota_agent_follows_agent_follower_unique"
          UNIQUE ("agent_id", "follower_user_id")
      );
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_follows_agent_id"
        ON "bota_agent_follows" ("agent_id");
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_follows_follower_user_id"
        ON "bota_agent_follows" ("follower_user_id");
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_follows_owner_user_id"
        ON "bota_agent_follows" ("agent_owner_user_id");
    `).then(() => undefined).catch((error) => {
      ensureFollowsTablePromise = null;
      throw error;
    });
  }

  return ensureFollowsTablePromise;
}

async function getFollowerCount(agentId: string) {
  try {
    await ensureBotaAgentFollowsTable();
    const result = await db.execute(sql`
      SELECT COUNT(*)::int AS "followerCount"
      FROM "bota_agent_follows"
      WHERE "agent_id" = ${agentId}
    `);
    return Number(tableRows(result)[0]?.followerCount || 0);
  } catch (error) {
    warnFollowFallback("count", error);
    return memoryFollowState(agentId).followerCount;
  }
}

export async function listBotaAgentFollowStates(params: {
  agentIds: string[];
  viewerUserId?: string | null;
}) {
  const normalizedAgentIds = Array.from(
    new Set(
      (params.agentIds || [])
        .map((agentId) => normalizeBotaFighterAgentId(agentId))
        .filter(Boolean)
        .slice(0, 150),
    ),
  );

  if (normalizedAgentIds.length === 0) {
    return {
      states: [] as FollowState[],
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    await ensureBotaAgentFollowsTable();

    const agentIdList = sql.join(normalizedAgentIds.map((agentId) => sql`${agentId}`), sql`, `);
    const countsResult = await db.execute(sql`
      SELECT "agent_id" AS "agentId", COUNT(*)::int AS "followerCount"
      FROM "bota_agent_follows"
      WHERE "agent_id" IN (${agentIdList})
      GROUP BY "agent_id"
    `);

    const countByAgentId = new Map<string, number>();
    for (const row of tableRows(countsResult)) {
      countByAgentId.set(String(row.agentId), Number(row.followerCount || 0));
    }

    const followingAgentIds = new Set<string>();
    const viewerUserId = String(params.viewerUserId || "").trim();
    if (viewerUserId) {
      const followingResult = await db.execute(sql`
        SELECT "agent_id" AS "agentId"
        FROM "bota_agent_follows"
        WHERE "follower_user_id" = ${viewerUserId}
          AND "agent_id" IN (${agentIdList})
      `);

      for (const row of tableRows(followingResult)) {
        followingAgentIds.add(String(row.agentId));
      }
    }

    return {
      states: normalizedAgentIds.map((agentId) => ({
        agentId,
        followerCount: countByAgentId.get(agentId) || 0,
        following: followingAgentIds.has(agentId),
      })),
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    warnFollowFallback("list", error);
    return {
      states: normalizedAgentIds.map((agentId) => memoryFollowState(agentId, params.viewerUserId)),
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function toggleBotaAgentFollow(input: ToggleFollowInput) {
  const agentId = normalizeBotaFighterAgentId(input.agentId);
  const userId = String(input.userId || "").trim();
  if (!agentId || !userId) {
    throw new Error("Agent and user are required to follow.");
  }

  try {
    await ensureBotaAgentFollowsTable();

    const existingResult = await db.execute(sql`
      SELECT "id"
      FROM "bota_agent_follows"
      WHERE "agent_id" = ${agentId}
        AND "follower_user_id" = ${userId}
      LIMIT 1
    `);
    const existing = tableRows(existingResult)[0];

    if (existing?.id) {
      await db.execute(sql`
        DELETE FROM "bota_agent_follows"
        WHERE "id" = ${String(existing.id)}
      `);

      getMemoryFollowers(agentId).delete(userId);

      return {
        agentId,
        following: false,
        followerCount: await getFollowerCount(agentId),
        updatedAt: new Date().toISOString(),
      };
    }

    const profile = await getBotaFighterProfile(agentId, true).catch(() => null);
    const agentName = profile?.displayName || input.agentName || titleCase(agentId);
    const ownerUserId = getProfileOwnerUserId(profile);

    await db.execute(sql`
      INSERT INTO "bota_agent_follows" (
        "id",
        "agent_id",
        "follower_user_id",
        "agent_owner_user_id",
        "metadata",
        "created_at",
        "updated_at"
      )
      VALUES (
        ${randomUUID()},
        ${agentId},
        ${userId},
        ${ownerUserId},
        ${JSON.stringify({
          agentName,
          agentSource: profile?.origin || null,
        })}::jsonb,
        now(),
        now()
      )
      ON CONFLICT ("agent_id", "follower_user_id") DO NOTHING
    `);

    getMemoryFollowers(agentId).add(userId);

    const followerCount = await getFollowerCount(agentId);
    const followerName = await userLabel(userId);

    if (ownerUserId && ownerUserId !== userId) {
      await createAndPushFollowNotification(ownerUserId, {
        type: "new_follower",
        title: "New agent follower",
        message: `@${followerName} followed ${agentName}.`,
        agentId,
        agentName,
        followerUserId: userId,
        followerName,
        priority: 3,
      });
    }

    return {
      agentId,
      following: true,
      followerCount,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    warnFollowFallback("toggle", error);
    return toggleMemoryFollow(agentId, userId);
  }
}
