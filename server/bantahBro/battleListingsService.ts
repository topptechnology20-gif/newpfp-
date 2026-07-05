import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { bantahBroListedBattles } from "@shared/schema";
import type { BantahBroBattleCandidate } from "./battleDiscoveryEngine";

export type BantahBroListedBattle = {
  id: string;
  engineBattleId: string;
  status: "listed";
  source: "engine" | "manual" | "sponsored";
  listedBy: string | null;
  listedAt: string;
  updatedAt: string;
  battle: BantahBroBattleCandidate;
};

let ensureTablePromise: Promise<void> | null = null;

function normalizeId(value: string) {
  return String(value || "").trim().slice(0, 220);
}

function toIsoString(value: Date | string | null | undefined) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  return new Date().toISOString();
}

async function ensureListedBattlesTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bantahbro_listed_battles" (
        "id" varchar(255) PRIMARY KEY NOT NULL,
        "engine_battle_id" varchar(255) NOT NULL UNIQUE,
        "status" varchar(24) NOT NULL DEFAULT 'listed',
        "source" varchar(24) NOT NULL DEFAULT 'engine',
        "listed_by" varchar(255),
        "battle" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "listed_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_bantahbro_listed_battles_engine_id"
        ON "bantahbro_listed_battles" ("engine_battle_id");
      CREATE INDEX IF NOT EXISTS "idx_bantahbro_listed_battles_listed_at"
        ON "bantahbro_listed_battles" ("listed_at");
      CREATE INDEX IF NOT EXISTS "idx_bantahbro_listed_battles_source"
        ON "bantahbro_listed_battles" ("source");
    `).then(() => undefined);
  }
  return ensureTablePromise;
}

function sanitizeBattleSnapshot(candidate: BantahBroBattleCandidate): BantahBroBattleCandidate {
  const battleId = normalizeId(candidate?.id || "");
  if (!battleId) {
    throw new Error("Battle candidate ID is required");
  }
  if (!Array.isArray(candidate.sides) || candidate.sides.length !== 2) {
    throw new Error("Battle candidate must include two sides");
  }

  return {
    ...candidate,
    id: battleId,
    title: String(
      candidate.title ||
        `${candidate.sides[0]?.displaySymbol || "A"} VS ${candidate.sides[1]?.displaySymbol || "B"}`,
    ).slice(0, 180),
    status: "candidate",
    score: Number.isFinite(candidate.score) ? candidate.score : 0,
    rationale: Array.isArray(candidate.rationale) ? candidate.rationale.slice(0, 5) : [],
    rules: Array.isArray(candidate.rules) ? candidate.rules.slice(0, 6) : [],
  };
}

function hydrateListedBattle(
  row: typeof bantahBroListedBattles.$inferSelect,
): BantahBroListedBattle {
  return {
    id: row.id,
    engineBattleId: row.engineBattleId,
    status: "listed",
    source:
      row.source === "manual" || row.source === "sponsored" || row.source === "engine"
        ? row.source
        : "engine",
    listedBy: row.listedBy,
    listedAt: toIsoString(row.listedAt),
    updatedAt: toIsoString(row.updatedAt),
    battle: sanitizeBattleSnapshot(row.battle as BantahBroBattleCandidate),
  };
}

export async function listBantahBroListedBattles() {
  await ensureListedBattlesTable();
  const rows = await db
    .select()
    .from(bantahBroListedBattles)
    .orderBy(desc(bantahBroListedBattles.listedAt));

  return rows.map(hydrateListedBattle);
}

export async function getBantahBroListedBattleMap() {
  const listed = await listBantahBroListedBattles();
  return new Map(listed.map((entry) => [entry.engineBattleId, entry]));
}

export async function listBantahBroListedBattleCandidates(limit = 20) {
  const listed = await listBantahBroListedBattles();
  return listed.slice(0, Math.max(1, Math.min(100, limit))).map((entry) => ({
    ...entry.battle,
    id: entry.engineBattleId,
    officialListing: {
      id: entry.id,
      status: entry.status,
      source: entry.source,
      listedAt: entry.listedAt,
      updatedAt: entry.updatedAt,
    },
  }));
}

export async function publishBantahBroBattleCandidates(
  candidates: BantahBroBattleCandidate[],
  options: { listedBy?: number | string | null; source?: BantahBroListedBattle["source"] } = {},
) {
  await ensureListedBattlesTable();
  const now = new Date();
  const published: BantahBroListedBattle[] = [];

  for (const rawCandidate of candidates) {
    const battle = sanitizeBattleSnapshot(rawCandidate);
    const engineBattleId = battle.id;
    const id = `listed-${engineBattleId}`.slice(0, 255);
    const listedBy =
      options.listedBy === undefined || options.listedBy === null
        ? null
        : String(options.listedBy);

    const [row] = await db
      .insert(bantahBroListedBattles)
      .values({
        id,
        engineBattleId,
        status: "listed",
        source: options.source || "engine",
        listedBy,
        battle: battle as unknown as Record<string, unknown>,
        listedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: bantahBroListedBattles.engineBattleId,
        set: {
          status: "listed",
          source: options.source || "engine",
          listedBy,
          battle: battle as unknown as Record<string, unknown>,
          updatedAt: now,
        },
      })
      .returning();

    published.push(hydrateListedBattle(row));
  }

  return published;
}

export async function unlistBantahBroBattle(engineBattleIdInput: string) {
  await ensureListedBattlesTable();
  const engineBattleId = normalizeId(engineBattleIdInput);
  if (!engineBattleId) throw new Error("Battle ID is required");

  const [existing] = await db
    .delete(bantahBroListedBattles)
    .where(eq(bantahBroListedBattles.engineBattleId, engineBattleId))
    .returning();

  return existing ? hydrateListedBattle(existing) : null;
}
