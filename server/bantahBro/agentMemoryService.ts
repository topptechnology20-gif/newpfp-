import { sql } from 'drizzle-orm'
import { db } from '../db'

function rowsFromResult(result: unknown): any[] {
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object' && Array.isArray((result as any).rows)) return (result as any).rows
  return []
}

let ensureAgentMemoryTablePromise: Promise<void> | null = null

export async function ensureAgentMemoryTables() {
  if (!ensureAgentMemoryTablePromise) {
    ensureAgentMemoryTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "agent_memories" (
        "id" varchar(180) PRIMARY KEY NOT NULL,
        "agent_id" varchar(180) NOT NULL,
        "kind" varchar(80) NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "score" numeric DEFAULT 0,
        "created_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_agent_memories_agent" ON "agent_memories" ("agent_id");
      CREATE INDEX IF NOT EXISTS "idx_agent_memories_kind" ON "agent_memories" ("kind");
    `).then(() => undefined)
  }
  return ensureAgentMemoryTablePromise
}

export async function appendAgentMemory(params: {
  id: string
  agentId: string
  kind: string
  payload?: Record<string, unknown>
  score?: number
}) {
  await ensureAgentMemoryTables()
  const result = await db.execute(sql`
    INSERT INTO "agent_memories" ("id","agent_id","kind","payload","score")
    VALUES (${params.id}, ${params.agentId}, ${params.kind}, ${JSON.stringify(params.payload || {})}::jsonb, ${params.score || 0})
    RETURNING *;
  `)
  return rowsFromResult(result)[0] || null
}

export async function getAgentMemorySummary(agentId: string) {
  await ensureAgentMemoryTables()
  // simple summary: last 20 entries and average score per kind
  const rowsRes = await db.execute(sql`
    SELECT kind, count(*) as cnt, avg(score::numeric) as avg_score FROM "agent_memories" WHERE "agent_id" = ${agentId} GROUP BY kind;
  `)
  const listRes = await db.execute(sql`
    SELECT * FROM "agent_memories" WHERE "agent_id" = ${agentId} ORDER BY created_at DESC LIMIT 20;
  `)
  return {
    aggregates: rowsFromResult(rowsRes),
    recent: rowsFromResult(listRes),
  }
}

export default {
  ensureAgentMemoryTables,
  appendAgentMemory,
  getAgentMemorySummary,
}
