import { desc, eq, sql } from "drizzle-orm";
import {
  botaArenaBattleRecords,
  type BotaArenaBattleRecordRow,
} from "@shared/schema.ts";
import {
  botaArenaBattleRecordSchema,
  type BotaArenaBattleRecord,
  type BotaArenaBattleRecordStatus,
} from "@shared/botaArenaBattleRecord";
import { db } from "../db";
import {
  getLiveBantahBroAgentBattles,
  type BantahBroAgentBattle,
  type BantahBroAgentBattleSide,
} from "./agentBattleService";
import { simulateBotaArenaBattleFromLiveBattle } from "./botaArenaEngine";
import {
  applyBotaArenaBattleResultToFighterProfiles,
  getBotaFighterAgentIdForBattleSide,
  syncBotaFighterProfilesFromBattle,
} from "./botaFighterProfileService";
import { notifyBotaArenaBattleOutcome, notifyBotaFighterQueueReentered } from "./botaNotificationService";
import type { BotaFighterProfile } from "@shared/botaFighterProfile";
import { storage } from "../storage";

let ensureBattleRecordsTablePromise: Promise<void> | null = null;

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toDate(value: Date | string | null | undefined) {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function normalizeRecordKey(value: string) {
  return String(value || "bota-arena-record")
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 360);
}

function makeRecordKey(input: {
  battleId: string;
  seed: string;
  maxRounds: number;
  arenaId?: string | null;
  forceNewRecord?: boolean;
}) {
  const base = normalizeRecordKey(
    `${input.battleId}:seed:${input.seed}:rounds:${input.maxRounds}:arena:${input.arenaId || "default"}`,
  );
  return input.forceNewRecord
    ? normalizeRecordKey(`${base}:run:${Date.now()}`)
    : base;
}

function statusForSimulation(input: {
  status: string;
  winnerSideId: string | null;
}): BotaArenaBattleRecordStatus {
  if (input.status === "draw") return "draw";
  if (input.winnerSideId) return "resolved";
  return "invalid";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeBattleRecord(row: BotaArenaBattleRecordRow): BotaArenaBattleRecord {
  return botaArenaBattleRecordSchema.parse({
    id: row.id,
    recordKey: row.recordKey,
    battleId: row.battleId,
    sourceBattleId: row.sourceBattleId,
    title: row.title,
    arenaId: row.arenaId,
    status: row.status,
    winnerAgentId: row.winnerAgentId,
    winnerSideId: row.winnerSideId,
    loserAgentId: row.loserAgentId,
    loserSideId: row.loserSideId,
    provider: row.provider,
    adapterVersion: row.adapterVersion,
    engineVersion: row.engineVersion,
    seed: row.seed,
    rounds: row.rounds,
    spectators: row.spectators,
    fighters: Array.isArray(row.fighters) ? row.fighters : [],
    roundLog: Array.isArray(row.roundLog) ? row.roundLog : [],
    simulation: asRecord(row.simulation),
    battleSnapshot: asRecord(row.battleSnapshot),
    metadata: asRecord(row.metadata),
    startedAt: toIso(row.startedAt),
    endedAt: toIso(row.endedAt),
    resolvedAt: toIso(row.resolvedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  });
}

function normalizeAgentId(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180);
}

function recordAgentIds(record: BotaArenaBattleRecord) {
  const ids = new Set<string>();
  [record.winnerAgentId, record.loserAgentId, record.winnerSideId, record.loserSideId].forEach((value) => {
    const normalized = normalizeAgentId(value);
    if (normalized) ids.add(normalized);
  });
  for (const fighter of record.fighters || []) {
    const source = fighter && typeof fighter === "object" ? fighter : {};
    [
      (source as Record<string, unknown>).agentId,
      (source as Record<string, unknown>).id,
      (source as Record<string, unknown>).sideId,
    ].forEach((value) => {
      const normalized = normalizeAgentId(value);
      if (normalized) ids.add(normalized);
    });
  }
  const snapshot = record.battleSnapshot || {};
  const sides = Array.isArray(snapshot.sides) ? snapshot.sides : [];
  for (const side of sides) {
    const source = side && typeof side === "object" ? side : {};
    const normalized = normalizeAgentId((source as Record<string, unknown>).id);
    if (normalized) ids.add(normalized);
  }
  return ids;
}

export async function ensureBotaArenaBattleRecordsTable() {
  if (!ensureBattleRecordsTablePromise) {
    ensureBattleRecordsTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bota_arena_battle_records" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "record_key" varchar(360) NOT NULL UNIQUE,
        "battle_id" varchar(255) NOT NULL,
        "source_battle_id" varchar(255),
        "title" varchar(255) NOT NULL,
        "arena_id" varchar(120),
        "status" varchar(24) NOT NULL DEFAULT 'resolved',
        "winner_agent_id" varchar(180),
        "winner_side_id" varchar(180),
        "loser_agent_id" varchar(180),
        "loser_side_id" varchar(180),
        "provider" varchar(40) NOT NULL,
        "adapter_version" varchar(40) NOT NULL,
        "engine_version" varchar(40) NOT NULL,
        "seed" varchar(255) NOT NULL,
        "rounds" integer NOT NULL DEFAULT 0,
        "spectators" integer NOT NULL DEFAULT 0,
        "fighters" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "round_log" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "simulation" jsonb NOT NULL,
        "battle_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "started_at" timestamp,
        "ended_at" timestamp,
        "resolved_at" timestamp DEFAULT now(),
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_bota_arena_battle_records_record_key"
        ON "bota_arena_battle_records" ("record_key");
      CREATE INDEX IF NOT EXISTS "idx_bota_arena_battle_records_battle_id"
        ON "bota_arena_battle_records" ("battle_id");
      CREATE INDEX IF NOT EXISTS "idx_bota_arena_battle_records_winner_agent_id"
        ON "bota_arena_battle_records" ("winner_agent_id");
      CREATE INDEX IF NOT EXISTS "idx_bota_arena_battle_records_created_at"
        ON "bota_arena_battle_records" ("created_at");
    `).then(() => undefined);
  }
  return ensureBattleRecordsTablePromise;
}

function loserForWinner(
  battle: BantahBroAgentBattle,
  winnerSideId: string | null,
): BantahBroAgentBattleSide | null {
  if (!winnerSideId) return null;
  return battle.sides.find((side) => side.id !== winnerSideId) || null;
}

async function findLiveBattleOrThrow(battleId: string) {
  const feed = await getLiveBantahBroAgentBattles(40);
  const battle = feed.battles.find((candidate) => candidate.id === battleId);
  if (!battle) {
    const error = new Error("Live Arena battle not found");
    (error as { status?: number }).status = 404;
    throw error;
  }
  return battle;
}

export async function recordBotaArenaBattleFromLiveBattle(input: {
  battleId: string;
  battle?: BantahBroAgentBattle | null;
  seed?: string | null;
  maxRounds?: number | null;
  arenaId?: string | null;
  forceNewRecord?: boolean;
}) {
  await ensureBotaArenaBattleRecordsTable();
  const battleId = String(input.battleId || input.battle?.id || "").trim();
  if (!battleId) throw new Error("battleId is required");

  const battle = input.battle || await findLiveBattleOrThrow(battleId);
  if (battle.id !== battleId) {
    throw new Error(`Battle ID mismatch: expected ${battleId}, received ${battle.id}`);
  }
  const maxRounds = Math.max(1, Math.min(Math.round(input.maxRounds || 5), 5));
  const seed = String(input.seed || `${battle.id}:${battle.startsAt}`).trim().slice(0, 255);
  const recordKey = makeRecordKey({
    battleId: battle.id,
    seed,
    maxRounds,
    arenaId: input.arenaId,
    forceNewRecord: input.forceNewRecord,
  });

  if (!input.forceNewRecord) {
    const [existing] = await db
      .select()
      .from(botaArenaBattleRecords)
      .where(eq(botaArenaBattleRecords.recordKey, recordKey))
      .limit(1);
    if (existing) {
      return {
        record: normalizeBattleRecord(existing),
        battle,
        inserted: false,
      };
    }
  }

  await syncBotaFighterProfilesFromBattle(battle);
  const simulation = await simulateBotaArenaBattleFromLiveBattle(battle, {
    seed,
    maxRounds,
  });
  const winnerSideId = simulation.finalState.winnerId;
  const winnerSide = winnerSideId
    ? battle.sides.find((side) => side.id === winnerSideId) || null
    : null;
  const loserSide = loserForWinner(battle, winnerSideId);
  const winnerAgentId = winnerSide ? getBotaFighterAgentIdForBattleSide(winnerSide) : null;
  const loserAgentId = loserSide ? getBotaFighterAgentIdForBattleSide(loserSide) : null;
  const now = new Date();

  const [inserted] = await db
    .insert(botaArenaBattleRecords)
    .values({
      recordKey,
      battleId: battle.id,
      sourceBattleId: battle.id,
      title: battle.title,
      arenaId: input.arenaId || null,
      status: statusForSimulation({
        status: simulation.finalState.status,
        winnerSideId,
      }),
      winnerAgentId,
      winnerSideId,
      loserAgentId,
      loserSideId: loserSide?.id || null,
      provider: simulation.provider,
      adapterVersion: simulation.adapterVersion,
      engineVersion: simulation.engineVersion,
      seed,
      rounds: simulation.finalState.round,
      spectators: Math.max(0, Math.round(battle.spectators || 0)),
      fighters: simulation.finalState.fighters as unknown as Record<string, unknown>[],
      roundLog: simulation.finalState.log as unknown as Record<string, unknown>[],
      simulation: simulation as unknown as Record<string, unknown>,
      battleSnapshot: battle as unknown as Record<string, unknown>,
      metadata: {
        winnerName: winnerSide?.agentName || null,
        loserName: loserSide?.agentName || null,
        resolutionReason: simulation.finalState.resolutionReason,
      },
      startedAt: toDate(battle.startsAt),
      endedAt: toDate(battle.endsAt),
      resolvedAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: botaArenaBattleRecords.recordKey,
    })
    .returning();

  if (!inserted) {
    const [existing] = await db
      .select()
      .from(botaArenaBattleRecords)
      .where(eq(botaArenaBattleRecords.recordKey, recordKey))
      .limit(1);
    if (existing) {
      return {
        record: normalizeBattleRecord(existing),
        battle,
        inserted: false,
      };
    }
    throw new Error("Arena battle record could not be stored");
  }

  const profileUpdate = await applyBotaArenaBattleResultToFighterProfiles({
    battle,
    winnerSideId,
    loserSideId: loserSide?.id || null,
    recordId: inserted.id,
  });
  const record = normalizeBattleRecord(inserted);

  await notifyBotaArenaBattleOutcome({
    record,
    winnerProfile: profileUpdate.winner?.after || null,
    loserProfile: profileUpdate.loser?.after || null,
    rankChanges: profileUpdate.rankChanges,
  });

  // Automatically trigger BC payout if this battle was tied to a P2P challenge
  const resolvedWinnerAgentId = winnerSideId ? getBotaFighterAgentIdForBattleSide(battle, winnerSideId) : null;
  storage.resolveChallengeFromArenaMatch(battle.id, resolvedWinnerAgentId || null).catch((err) => {
    console.error("Failed to automatically resolve challenge from arena match:", err);
  });

  await Promise.allSettled([
    profileUpdate.winner?.after
      ? notifyBotaFighterQueueReentered({
          fighter: profileUpdate.winner.after,
          recordId: record.id,
          outcome: winnerSideId ? "win" : "draw",
        })
      : Promise.resolve(),
    profileUpdate.loser?.after
      ? notifyBotaFighterQueueReentered({
          fighter: profileUpdate.loser.after,
          recordId: record.id,
          outcome: loserSide?.id ? "loss" : "draw",
        })
      : Promise.resolve(),
  ]);

  return {
    record,
    battle,
    simulation,
    inserted: true,
  };
}

export async function recordLiveBotaArenaBattles(input: {
  battles?: BantahBroAgentBattle[] | null;
  limit?: number | null;
  arenaId?: string | null;
  maxRounds?: number | null;
}) {
  const limit = Math.max(1, Math.min(Math.round(input.limit || 50), 50));
  const battles =
    Array.isArray(input.battles) && input.battles.length > 0
      ? input.battles.slice(0, limit)
      : (await getLiveBantahBroAgentBattles(limit)).battles;
  const results: Array<{
    battleId: string;
    title: string;
    inserted: boolean;
    recordId?: string;
    recordKey?: string;
    status?: string;
    error?: string;
  }> = [];
  let inserted = 0;
  let existing = 0;
  let failed = 0;

  for (const battle of battles.slice(0, limit)) {
    try {
      const result = await recordBotaArenaBattleFromLiveBattle({
        battleId: battle.id,
        battle,
        maxRounds: input.maxRounds,
        arenaId: input.arenaId || "bota-main",
      });

      if (result.inserted) inserted += 1;
      else existing += 1;

      results.push({
        battleId: battle.id,
        title: battle.title,
        inserted: result.inserted,
        recordId: result.record.id,
        recordKey: result.record.recordKey,
        status: result.record.status,
      });
    } catch (error) {
      failed += 1;
      results.push({
        battleId: battle.id,
        title: battle.title,
        inserted: false,
        error: error instanceof Error ? error.message : "Unknown record error",
      });
    }
  }

  return {
    requested: limit,
    liveBattles: battles.length,
    inserted,
    existing,
    failed,
    results,
    updatedAt: new Date().toISOString(),
  };
}

export async function listBotaArenaBattleRecords(limit = 20) {
  await ensureBotaArenaBattleRecordsTable();
  const rows = await db
    .select()
    .from(botaArenaBattleRecords)
    .orderBy(desc(botaArenaBattleRecords.createdAt))
    .limit(Math.max(1, Math.min(Math.round(limit || 20), 100)));

  return {
    records: rows.map(normalizeBattleRecord),
    updatedAt: new Date().toISOString(),
  };
}

export async function listBotaArenaBattleRecordsForAgents(agentIds: string[], limit = 50) {
  await ensureBotaArenaBattleRecordsTable();
  const wanted = new Set(agentIds.map(normalizeAgentId).filter(Boolean));
  if (!wanted.size) {
    return {
      records: [] as BotaArenaBattleRecord[],
      updatedAt: new Date().toISOString(),
    };
  }

  const scanLimit = Math.max(100, Math.min(Math.round(limit || 50) * 8, 1000));
  const rows = await db
    .select()
    .from(botaArenaBattleRecords)
    .orderBy(desc(botaArenaBattleRecords.createdAt))
    .limit(scanLimit);

  return {
    records: rows
      .map(normalizeBattleRecord)
      .filter((record) => {
        const ids = recordAgentIds(record);
        return Array.from(wanted).some((agentId) => ids.has(agentId));
      })
      .slice(0, Math.max(1, Math.min(Math.round(limit || 50), 100))),
    updatedAt: new Date().toISOString(),
  };
}

export async function getBotaArenaBattleRecord(recordId: string) {
  await ensureBotaArenaBattleRecordsTable();
  const id = String(recordId || "").trim();
  if (!id) return null;

  const [byId] = await db
    .select()
    .from(botaArenaBattleRecords)
    .where(eq(botaArenaBattleRecords.id, id))
    .limit(1);
  if (byId) return normalizeBattleRecord(byId);

  const [byKey] = await db
    .select()
    .from(botaArenaBattleRecords)
    .where(eq(botaArenaBattleRecords.recordKey, id))
    .limit(1);
  return byKey ? normalizeBattleRecord(byKey) : null;
}
