import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { getBotaFighterProfile } from "./botaFighterProfileService";

export const botaAgentChallengeCreateSchema = z.object({
  challengerAgentId: z.string().trim().min(1).max(180),
  opponentAgentId: z.string().trim().min(1).max(180).optional().nullable(),
  matchType: z.enum(["arena", "degen_vs"]).default("arena"),
  stakeAmount: z.coerce.number().min(0).max(1_000_000).default(50),
  stakeCurrency: z.enum(["USDC", "BXBT", "USDT", "ETH", "BNB", "BC"]).default("BC"),
  message: z.string().trim().max(240).default(""),
  visibility: z.enum(["public", "private"]).default("public"),
  predictionEnabled: z.coerce.boolean().default(true),
  source: z.enum(["web", "telegram", "twitter"]).default("web"),
});

export const botaAgentChallengeAcceptSchema = z.object({
  scheduledDelayMinutes: z.coerce.number().int().min(5).max(24 * 60).default(30),
});

export type BotaAgentChallengeStatus =
  | "pending"
  | "accepted"
  | "scheduled"
  | "live"
  | "resolved"
  | "expired"
  | "cancelled";

export type BotaAgentChallenge = {
  id: string;
  challengeCode: string;
  status: BotaAgentChallengeStatus;
  matchType: "arena" | "degen_vs";
  visibility: "public" | "private";
  predictionEnabled: boolean;
  stakeAmount: number;
  stakeCurrency: string;
  message: string | null;
  challengerUserId: string;
  opponentOwnerUserId: string | null;
  challengerAgent: ChallengeAgentSnapshot;
  opponentAgent: ChallengeAgentSnapshot;
  expiresAt: string;
  scheduledAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
  viewerRole: "challenger" | "opponent" | "spectator";
  challengeUrl: string;
  shareCaption: string;
  source: "web" | "telegram" | "twitter";
  winnerAgentId: string | null;
  loserAgentId: string | null;
};

type ChallengeAgentSnapshot = {
  id: string;
  name: string;
  avatarUrl: string | null;
  rank: number | null;
  league: string;
  record: string;
  title: string;
  tokenSymbol: string | null;
};

let ensureTablePromise: Promise<void> | null = null;

function tableRows<T = any>(result: any): T[] {
  return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
}

function toIso(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function titleCase(value?: string | null) {
  return String(value || "BOTA")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function makeChallengeCode() {
  return `BOTA-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

function agentSnapshot(profile: NonNullable<Awaited<ReturnType<typeof getBotaFighterProfile>>>): ChallengeAgentSnapshot {
  return {
    id: profile.agentId,
    name: profile.displayName,
    avatarUrl: profile.avatarUrl,
    rank: profile.rank,
    league: profile.league,
    record: `${profile.wins}-${profile.losses}`,
    title: profile.titles?.[0] || profile.badgeLabel || titleCase(profile.archetype),
    tokenSymbol: profile.tokenSymbol,
  };
}

function profileOwnerUserId(profile: NonNullable<Awaited<ReturnType<typeof getBotaFighterProfile>>>) {
  const metadata = profile.metadata || {};
  const owner = metadata.importedByUserId || metadata.ownerUserId || metadata.userId;
  return typeof owner === "string" && owner.trim() ? owner.trim() : null;
}

function buildChallengeUrl(challengeCode: string) {
  return `/bota?section=challenge&challenge=${encodeURIComponent(challengeCode)}`;
}

function normalizeRow(row: any, viewerUserId?: string | null): BotaAgentChallenge {
  const challengerAgent = row.challenger_agent || {};
  const opponentAgent = row.opponent_agent || {};
  const stakeAmount = toNumber(row.stake_amount);
  const stakeCurrency = String(row.stake_currency || "USDC");
  const challengeCode = String(row.challenge_code);
  const viewerRole =
    viewerUserId && viewerUserId === row.challenger_user_id
      ? "challenger"
      : viewerUserId && viewerUserId === row.opponent_owner_user_id
        ? "opponent"
        : "spectator";

  return {
    id: String(row.id),
    challengeCode,
    status: String(row.status || "pending") as BotaAgentChallengeStatus,
    matchType: row.match_type === "degen_vs" ? "degen_vs" : "arena",
    visibility: row.visibility === "private" ? "private" : "public",
    predictionEnabled: Boolean(row.prediction_enabled),
    stakeAmount,
    stakeCurrency,
    message: row.message || null,
    source: String(row.source || "web") as "web" | "telegram" | "twitter",
    challengerUserId: String(row.challenger_user_id),
    opponentOwnerUserId: row.opponent_owner_user_id || null,
    challengerAgent,
    opponentAgent,
    expiresAt: toIso(row.expires_at) || new Date().toISOString(),
    scheduledAt: toIso(row.scheduled_at),
    acceptedAt: toIso(row.accepted_at),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
    viewerRole,
    challengeUrl: buildChallengeUrl(challengeCode),
    shareCaption:
      `${challengerAgent.name || "A BOTA agent"} challenged ${opponentAgent.name || "another agent"} ` +
      `for ${stakeAmount.toLocaleString()} ${stakeCurrency}.`,
    winnerAgentId: row.metadata?.result?.winnerAgentId || null,
    loserAgentId: row.metadata?.result?.loserAgentId || null,
  };
}

export async function ensureBotaAgentChallengesTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bota_agent_pvp_challenges" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
        "challenge_code" varchar(80) NOT NULL UNIQUE,
        "status" varchar(24) NOT NULL DEFAULT 'pending',
        "match_type" varchar(24) NOT NULL DEFAULT 'arena',
        "visibility" varchar(24) NOT NULL DEFAULT 'public',
        "prediction_enabled" boolean NOT NULL DEFAULT true,
        "stake_amount" numeric(18, 6) NOT NULL DEFAULT 0,
        "stake_currency" varchar(16) NOT NULL DEFAULT 'USDC',
        "message" text,
        "challenger_user_id" varchar(180) NOT NULL,
        "opponent_owner_user_id" varchar(180),
        "challenger_agent_id" varchar(180) NOT NULL,
        "opponent_agent_id" varchar(180) NOT NULL,
        "challenger_agent" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "opponent_agent" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "expires_at" timestamp NOT NULL,
        "scheduled_at" timestamp,
        "accepted_at" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      ALTER TABLE "bota_agent_pvp_challenges" ADD COLUMN IF NOT EXISTS "source" varchar(32) NOT NULL DEFAULT 'web';
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_pvp_challenges_status"
        ON "bota_agent_pvp_challenges" ("status");
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_pvp_challenges_challenger"
        ON "bota_agent_pvp_challenges" ("challenger_user_id");
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_pvp_challenges_opponent_owner"
        ON "bota_agent_pvp_challenges" ("opponent_owner_user_id");
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_pvp_challenges_created_at"
        ON "bota_agent_pvp_challenges" ("created_at");
    `).catch((err) => {
      console.error("[DB ERROR] ensureBotaAgentChallengesTable failed:", err);
      ensureTablePromise = null;
      throw err;
    }).then(() => undefined);
  }
  return ensureTablePromise;
}

export async function createBotaAgentChallenge(input: z.infer<typeof botaAgentChallengeCreateSchema> & {
  challengerUserId: string;
}) {
  await ensureBotaAgentChallengesTable();
  const parsed = botaAgentChallengeCreateSchema.parse(input);
  if (parsed.challengerAgentId === parsed.opponentAgentId) {
    throw new Error("Choose two different agents for a PvP challenge.");
  }

  const [challengerProfile, opponentProfile] = await Promise.all([
    getBotaFighterProfile(parsed.challengerAgentId, true),
    getBotaFighterProfile(parsed.opponentAgentId, true),
  ]);
  if (!challengerProfile) throw new Error("Your selected agent was not found.");
  if (!opponentProfile) throw new Error("Opponent agent was not found.");

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const challengeCode = makeChallengeCode();
  const opponentOwnerUserId = profileOwnerUserId(opponentProfile);
  const result = await db.execute(sql`
    INSERT INTO "bota_agent_pvp_challenges" (
      "challenge_code",
      "status",
      "match_type",
      "visibility",
      "prediction_enabled",
      "stake_amount",
      "stake_currency",
      "message",
      "challenger_user_id",
      "opponent_owner_user_id",
      "challenger_agent_id",
      "opponent_agent_id",
      "challenger_agent",
      "opponent_agent",
      "expires_at",
      "metadata",
      "source"
    )
    VALUES (
      ${challengeCode},
      'pending',
      ${parsed.matchType},
      ${parsed.visibility},
      ${parsed.predictionEnabled},
      ${String(parsed.stakeAmount)},
      ${parsed.stakeCurrency},
      ${parsed.message || null},
      ${input.challengerUserId},
      ${opponentOwnerUserId},
      ${challengerProfile.agentId},
      ${opponentProfile.agentId},
      ${JSON.stringify(agentSnapshot(challengerProfile))}::jsonb,
      ${JSON.stringify(agentSnapshot(opponentProfile))}::jsonb,
      ${expiresAt},
      ${JSON.stringify({ posterStatus: "queued", escrowStatus: "awaiting_acceptance" })}::jsonb,
      ${parsed.source}
    )
    RETURNING *;
  `);

  const row = tableRows(result)[0];
  return normalizeRow(row, input.challengerUserId);
}

export async function listBotaAgentChallenges(input: {
  limit?: number;
  status?: BotaAgentChallengeStatus | "all" | null;
  viewerUserId?: string | null;
  mine?: boolean;
} = {}) {
  await ensureBotaAgentChallengesTable();
  const limit = Math.max(1, Math.min(Math.round(input.limit || 30), 100));
  const status = input.status && input.status !== "all" ? input.status : null;
  const viewerUserId = input.viewerUserId || null;

  const result = input.mine && viewerUserId
    ? status
      ? await db.execute(sql`
          SELECT * FROM "bota_agent_pvp_challenges"
          WHERE "status" = ${status}
            AND ("challenger_user_id" = ${viewerUserId} OR "opponent_owner_user_id" = ${viewerUserId})
          ORDER BY "created_at" DESC
          LIMIT ${limit};
        `)
      : await db.execute(sql`
          SELECT * FROM "bota_agent_pvp_challenges"
          WHERE "challenger_user_id" = ${viewerUserId} OR "opponent_owner_user_id" = ${viewerUserId}
          ORDER BY "created_at" DESC
          LIMIT ${limit};
        `)
    : status
      ? await db.execute(sql`
          SELECT * FROM "bota_agent_pvp_challenges"
          WHERE "status" = ${status} AND "visibility" = 'public'
          ORDER BY "created_at" DESC
          LIMIT ${limit};
        `)
      : await db.execute(sql`
          SELECT * FROM "bota_agent_pvp_challenges"
          WHERE "visibility" = 'public'
          ORDER BY "created_at" DESC
          LIMIT ${limit};
        `);

  const rows = tableRows(result);
  return {
    challenges: rows.map((row) => normalizeRow(row, viewerUserId)),
    updatedAt: new Date().toISOString(),
  };
}

export async function getBotaAgentChallengeByCode(input: {
  challengeCode: string;
  viewerUserId?: string | null;
}) {
  await ensureBotaAgentChallengesTable();
  const challengeCode = String(input.challengeCode || "").trim();
  if (!challengeCode) return null;

  const result = await db.execute(sql`
    SELECT * FROM "bota_agent_pvp_challenges"
    WHERE "challenge_code" = ${challengeCode}
    LIMIT 1;
  `);

  const row = tableRows(result)[0];
  return row ? normalizeRow(row, input.viewerUserId || null) : null;
}

export async function acceptBotaAgentChallenge(input: {
  challengeCode: string;
  userId: string;
  scheduledDelayMinutes?: number;
}) {
  await ensureBotaAgentChallengesTable();
  const parsed = botaAgentChallengeAcceptSchema.parse({
    scheduledDelayMinutes: input.scheduledDelayMinutes,
  });
  const now = new Date();
  const scheduledAt = new Date(now.getTime() + parsed.scheduledDelayMinutes * 60 * 1000);
  const result = await db.execute(sql`
    UPDATE "bota_agent_pvp_challenges"
    SET
      "status" = 'scheduled',
      "accepted_at" = ${now},
      "scheduled_at" = ${scheduledAt},
      "updated_at" = ${now},
      "metadata" = "metadata" || ${JSON.stringify({ escrowStatus: "awaiting_lock", acceptedByUserId: input.userId })}::jsonb
    WHERE "challenge_code" = ${input.challengeCode}
      AND "status" = 'pending'
      AND ("opponent_owner_user_id" IS NULL OR "opponent_owner_user_id" = ${input.userId})
    RETURNING *;
  `);

  const row = tableRows(result)[0];
  if (!row) {
    throw new Error("Challenge is not available for acceptance.");
  }
  return normalizeRow(row, input.userId);
}

export async function declineBotaAgentChallenge(input: {
  challengeCode: string;
  userId: string;
}) {
  await ensureBotaAgentChallengesTable();
  const now = new Date();
  const result = await db.execute(sql`
    UPDATE "bota_agent_pvp_challenges"
    SET
      "status" = 'cancelled',
      "updated_at" = ${now},
      "metadata" = "metadata" || ${JSON.stringify({ declinedByUserId: input.userId })}::jsonb
    WHERE "challenge_code" = ${input.challengeCode}
      AND "status" = 'pending'
      AND ("opponent_owner_user_id" IS NULL OR "opponent_owner_user_id" = ${input.userId})
    RETURNING *;
  `);

  const row = tableRows(result)[0];
  if (!row) {
    throw new Error("Challenge is not available or you are not authorized to decline it.");
  }
  return normalizeRow(row, input.userId);
}

export async function updateBotaAgentChallengeMetadata(input: {
  challengeCode: string;
  metadata: Record<string, unknown>;
}) {
  await ensureBotaAgentChallengesTable();
  const now = new Date();
  const result = await db.execute(sql`
    UPDATE "bota_agent_pvp_challenges"
    SET
      "updated_at" = ${now},
      "metadata" = "metadata" || ${JSON.stringify(input.metadata)}::jsonb
    WHERE "challenge_code" = ${input.challengeCode}
    RETURNING *;
  `);

  const row = tableRows(result)[0];
  if (!row) {
    throw new Error("Challenge not found.");
  }
  return normalizeRow(row);
}
