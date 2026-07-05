import { sql } from 'drizzle-orm'
import { db } from '../db'
import decidePackOpen, { AgentMetrics } from './packDecisionEngine'
import gen1Economy from './gen1EconomyService'
import crypto from 'crypto'

// Seeded PRNG (mulberry32) - deterministic from 32-bit integer seed
function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rowsFromResult(result: unknown): any[] {
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object' && Array.isArray((result as any).rows)) return (result as any).rows
  return []
}

let ensurePackTablesPromise: Promise<void> | null = null

export async function ensurePackTables() {
  if (!ensurePackTablesPromise) {
    ensurePackTablesPromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "pack_catalog" (
        "pack_id" varchar(180) PRIMARY KEY NOT NULL,
        "type" varchar(80) NOT NULL,
        "display_name" varchar(180) NOT NULL,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "initial_supply" integer DEFAULT 0,
        "remaining_supply" integer DEFAULT 0,
        "price_bc" integer DEFAULT 0,
        "price_usd" numeric DEFAULT 0,
        "saleable" boolean DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS "pack_ownership" (
        "pack_instance_id" varchar(180) PRIMARY KEY NOT NULL,
        "pack_id" varchar(180) NOT NULL REFERENCES "pack_catalog" ("pack_id"),
        "owner_user_id" varchar(180) NOT NULL,
        "status" varchar(40) NOT NULL DEFAULT 'unopened',
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamp NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "pack_open_events" (
        "event_id" varchar(180) PRIMARY KEY NOT NULL,
        "pack_instance_id" varchar(180) NOT NULL REFERENCES "pack_ownership" ("pack_instance_id"),
        "agent_id" varchar(180) NULL,
        "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "tool_inventory_id" uuid NULL,
        "tool_catalog_id" text NULL,
        "tool_role" text NULL,
        "tool_tier" text NULL,
        "compatible_trait" text NULL,
        "created_at" timestamp NOT NULL DEFAULT now()
      );
    `).then(() => undefined)
  }
  return ensurePackTablesPromise
}

export async function getPackCatalog() {
  await ensurePackTables()
  const r = await db.execute(sql`SELECT * FROM "pack_catalog" ORDER BY display_name LIMIT 100;`)
  const rows = rowsFromResult(r)
  if (rows.length) return rows

  // seed minimal catalog if empty
  const seed = [
    {
      pack_id: 'tactical-pack',
      type: 'tactical',
      display_name: 'Tactical Pack',
      metadata: { tier: 'tactical' },
      initial_supply: 0,
      remaining_supply: 0,
      price_bc: 100,
      price_usd: 0,
      saleable: true,
    },
    {
      pack_id: 'elite-pack',
      type: 'elite',
      display_name: 'Elite Pack',
      metadata: { tier: 'elite' },
      initial_supply: 0,
      remaining_supply: 0,
      price_bc: 240,
      price_usd: 0,
      saleable: true,
    },
  ]
  for (const p of seed) {
    await db.execute(sql`
      INSERT INTO "pack_catalog" ("pack_id","type","display_name","metadata","initial_supply","remaining_supply","price_bc","price_usd","saleable")
      VALUES (${p.pack_id}, ${p.type}, ${p.display_name}, ${JSON.stringify(p.metadata)}::jsonb, ${p.initial_supply}, ${p.remaining_supply}, ${p.price_bc}, ${p.price_usd}, ${p.saleable})
      ON CONFLICT ("pack_id") DO NOTHING;
    `)
  }
  const r2 = await db.execute(sql`SELECT * FROM "pack_catalog" ORDER BY display_name LIMIT 100;`)
  return rowsFromResult(r2)
}

export async function buyPack(packId: string, buyerUserId: string, opts?: { metadata?: Record<string, unknown> }) {
  await ensurePackTables()
  const instanceId = `pack_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  await db.execute(sql`
    INSERT INTO "pack_ownership" ("pack_instance_id","pack_id","owner_user_id","status","metadata")
    VALUES (${instanceId}, ${packId}, ${buyerUserId}, 'unopened', ${JSON.stringify(opts?.metadata || {})}::jsonb)
  `)
  return { packInstanceId: instanceId }
}

export async function openPack(packInstanceId: string, openerUserId: string, opts?: { mode?: 'manual'|'autonomous', agentMetrics?: AgentMetrics, autoEquip?: boolean }) {
  await ensurePackTables()
  // simple guard: ensure ownership
  const ownerRes = await db.execute(sql`SELECT * FROM "pack_ownership" WHERE "pack_instance_id" = ${packInstanceId} LIMIT 1;`)
  const ownerRows = rowsFromResult(ownerRes)
  if (!ownerRows.length) throw new Error('pack instance not found')
  const owner = ownerRows[0]
  if (String(owner.owner_user_id) !== String(openerUserId)) {
    const err: any = new Error('unauthorized')
    err.statusCode = 401
    throw err
  }

  // run decision engine if autonomous
  let decision: any = null
  if (opts?.mode === 'autonomous' && opts?.agentMetrics) {
    decision = decidePackOpen(opts.agentMetrics)
  }

  // build drop table for pack type (could be loaded from DB/catalog)
  const packCatalogRes = await db.execute(sql`
    UPDATE "pack_catalog" SET "remaining_supply" = "remaining_supply" - 1 WHERE "pack_id" = ${owner.pack_id};
    SELECT * FROM "pack_catalog" WHERE "pack_id" = ${owner.pack_id} LIMIT 1;
  `)
  const packCatalog = rowsFromResult(packCatalogRes)[0] || null
  const packType = packCatalog?.type || 'tactical'

  // Load BOTA V2 tools catalog
  const catalogRes = await db.execute(sql`SELECT * FROM "bota_tools_catalog"`);
  const catalogTools = rowsFromResult(catalogRes);
  
  if (!catalogTools.length) {
    throw new Error("BOTA tools catalog is empty. Run Phase 1 seeding.");
  }

  // deterministic RNG: generate a secure seed, then use seeded PRNG for picks
  const rngSeed = crypto.randomBytes(16).toString('hex')
  // derive a 32-bit integer from the hex seed
  const seedInt = parseInt(rngSeed.slice(0, 8), 16) >>> 0
  const rnd = mulberry32(seedInt)

  // V2 RNG Weights:
  // Rarity: 70% Common, 25% Rare, 5% Epic
  let selectedTier = "common";
  const rarityRoll = rnd() * 100;
  if (rarityRoll >= 95) selectedTier = "epic";
  else if (rarityRoll >= 70) selectedTier = "rare";

  // Role: 40% Primary, 30% Secondary, 30% Passive
  let selectedRole = "primary";
  const roleRoll = rnd() * 100;
  if (roleRoll >= 70) selectedRole = "passive";
  else if (roleRoll >= 40) selectedRole = "secondary";

  let candidates = catalogTools.filter((t: any) => t.tier === selectedTier && t.role === selectedRole);
  if (!candidates.length) candidates = catalogTools.filter((t: any) => t.tier === selectedTier);
  if (!candidates.length) candidates = catalogTools;

  const chosenTool = candidates[Math.floor(rnd() * candidates.length)];
  const inventoryId = crypto.randomUUID();

  // Insert into bota_tool_inventory
  await db.execute(sql`
    INSERT INTO "bota_tool_inventory" ("id", "tool_catalog_id", "owner_wallet", "acquired_from")
    VALUES (${inventoryId}, ${chosenTool.id}, ${owner.owner_user_id}, 'pack_open')
  `);

  const generatedItems = [{ toolId: chosenTool.id, name: chosenTool.name, rarity: chosenTool.tier }];
  const finalPicks = [{ id: chosenTool.id, role: chosenTool.role, tier: chosenTool.tier, compatibleTrait: chosenTool.compatible_trait }];

  // record open event with RNG seed for auditability
  const eventId = `open_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  await db.execute(sql`
    INSERT INTO "pack_open_events" ("event_id","pack_instance_id","agent_id","result","tool_catalog_id","tool_role","tool_tier","compatible_trait")
    VALUES (
      ${eventId},
      ${packInstanceId},
      ${opts?.agentMetrics?.agentId || null},
      ${JSON.stringify({ drops: finalPicks, mode: opts?.mode || 'manual' })}::jsonb,
      ${finalPicks[0]?.id || null},
      ${finalPicks[0]?.role || null},
      ${finalPicks[0]?.tier || null},
      ${finalPicks[0]?.compatibleTrait || null}
    );
  `);

  // mark pack ownership as opened
  await db.execute(sql`UPDATE "pack_ownership" SET "status" = 'opened' WHERE "pack_instance_id" = ${packInstanceId};`)

  return { eventId, items: generatedItems, decision, rngSeed, seedInt }
}

export default {
  ensurePackTables,
  getPackCatalog,
  buyPack,
  openPack,
}
