import { sql } from "drizzle-orm";
import { db } from "../db";
import type { RugScorerV2Token } from "./rugScorerV2Service";

type QueryRows<T> = { rows?: T[] } | T[];

export type RugWatchEntry = {
  id: string;
  userKey: string;
  tokenKey: string;
  chainId: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  logoUrl: string | null;
  lastScore: number | null;
  createdAt: string;
  updatedAt: string;
};

export type RugReportEntry = {
  id: string;
  reporterKey: string;
  tokenKey: string;
  chainId: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  severity: "low" | "medium" | "high";
  reason: string;
  notes: string | null;
  status: "open" | "reviewed" | "dismissed";
  createdAt: string;
};

export type RugScanHistoryEntry = {
  id: string;
  tokenKey: string;
  chainId: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  score: number;
  riskLevel: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volumeH24: number | null;
  createdAt: string;
};

let ensureTablePromise: Promise<void> | null = null;

function rowsOf<T>(result: QueryRows<T>): T[] {
  return Array.isArray(result) ? result : Array.isArray(result.rows) ? result.rows : [];
}

function asIso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  return new Date().toISOString();
}

function cleanText(value: unknown, max = 255) {
  return String(value || "").trim().slice(0, max);
}

function tokenKey(chainId: string, tokenAddress: string) {
  return `${cleanText(chainId, 64).toLowerCase()}:${cleanText(tokenAddress, 160).toLowerCase()}`;
}

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hydrateWatch(row: any): RugWatchEntry {
  return {
    id: String(row.id),
    userKey: String(row.user_key),
    tokenKey: String(row.token_key),
    chainId: String(row.chain_id),
    tokenAddress: String(row.token_address),
    tokenSymbol: row.token_symbol ?? null,
    tokenName: row.token_name ?? null,
    logoUrl: row.logo_url ?? null,
    lastScore: numberOrNull(row.last_score),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function hydrateReport(row: any): RugReportEntry {
  const severity = row.severity === "high" || row.severity === "medium" ? row.severity : "low";
  const status = row.status === "reviewed" || row.status === "dismissed" ? row.status : "open";
  return {
    id: String(row.id),
    reporterKey: String(row.reporter_key),
    tokenKey: String(row.token_key),
    chainId: String(row.chain_id),
    tokenAddress: String(row.token_address),
    tokenSymbol: row.token_symbol ?? null,
    tokenName: row.token_name ?? null,
    severity,
    reason: String(row.reason || ""),
    notes: row.notes ?? null,
    status,
    createdAt: asIso(row.created_at),
  };
}

function hydrateHistory(row: any): RugScanHistoryEntry {
  return {
    id: String(row.id),
    tokenKey: String(row.token_key),
    chainId: String(row.chain_id),
    tokenAddress: String(row.token_address),
    tokenSymbol: row.token_symbol ?? null,
    tokenName: row.token_name ?? null,
    score: Number(row.score || 0),
    riskLevel: String(row.risk_level || "low"),
    priceUsd: numberOrNull(row.price_usd),
    liquidityUsd: numberOrNull(row.liquidity_usd),
    volumeH24: numberOrNull(row.volume_h24),
    createdAt: asIso(row.created_at),
  };
}

async function ensureRugScorerV2Tables() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bantahbro_rug_scans" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "token_key" varchar(240) NOT NULL,
        "chain_id" varchar(64) NOT NULL,
        "token_address" varchar(180) NOT NULL,
        "token_symbol" varchar(80),
        "token_name" varchar(180),
        "score" integer NOT NULL DEFAULT 0,
        "risk_level" varchar(32) NOT NULL DEFAULT 'low',
        "source" varchar(32) NOT NULL DEFAULT 'dexscreener',
        "pair_url" text,
        "price_usd" numeric(28, 12),
        "liquidity_usd" numeric(28, 6),
        "volume_h24" numeric(28, 6),
        "txns_h24" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "missing_signals" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_bantahbro_rug_scans_token_created"
        ON "bantahbro_rug_scans" ("token_key", "created_at" DESC);
      CREATE INDEX IF NOT EXISTS "idx_bantahbro_rug_scans_score"
        ON "bantahbro_rug_scans" ("score" DESC);

      CREATE TABLE IF NOT EXISTS "bantahbro_rug_watchlist" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_key" varchar(180) NOT NULL,
        "token_key" varchar(240) NOT NULL,
        "chain_id" varchar(64) NOT NULL,
        "token_address" varchar(180) NOT NULL,
        "token_symbol" varchar(80),
        "token_name" varchar(180),
        "logo_url" text,
        "last_score" integer,
        "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        UNIQUE ("user_key", "token_key")
      );
      CREATE INDEX IF NOT EXISTS "idx_bantahbro_rug_watchlist_user"
        ON "bantahbro_rug_watchlist" ("user_key", "updated_at" DESC);

      CREATE TABLE IF NOT EXISTS "bantahbro_rug_reports" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "reporter_key" varchar(180) NOT NULL,
        "token_key" varchar(240) NOT NULL,
        "chain_id" varchar(64) NOT NULL,
        "token_address" varchar(180) NOT NULL,
        "token_symbol" varchar(80),
        "token_name" varchar(180),
        "severity" varchar(24) NOT NULL DEFAULT 'medium',
        "reason" varchar(180) NOT NULL,
        "notes" text,
        "status" varchar(24) NOT NULL DEFAULT 'open',
        "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_bantahbro_rug_reports_token"
        ON "bantahbro_rug_reports" ("token_key", "created_at" DESC);
      CREATE INDEX IF NOT EXISTS "idx_bantahbro_rug_reports_status"
        ON "bantahbro_rug_reports" ("status", "created_at" DESC);
    `).then(() => undefined);
  }
  return ensureTablePromise;
}

export async function recordRugScorerV2Scan(token: RugScorerV2Token) {
  await ensureRugScorerV2Tables();
  const key = tokenKey(token.chainId, token.tokenAddress);
  await db.execute(sql`
    INSERT INTO "bantahbro_rug_scans" (
      "token_key",
      "chain_id",
      "token_address",
      "token_symbol",
      "token_name",
      "score",
      "risk_level",
      "source",
      "pair_url",
      "price_usd",
      "liquidity_usd",
      "volume_h24",
      "txns_h24",
      "reasons",
      "missing_signals",
      "snapshot"
    ) VALUES (
      ${key},
      ${token.chainId},
      ${token.tokenAddress},
      ${token.tokenSymbol},
      ${token.tokenName},
      ${Math.round(token.rug.score || 0)},
      ${String(token.rug.riskLevel || "low")},
      ${token.source},
      ${token.pairUrl},
      ${token.priceUsd},
      ${token.liquidityUsd},
      ${token.volumeH24},
      ${JSON.stringify(token.txnsH24)}::jsonb,
      ${JSON.stringify(token.rug.reasons || [])}::jsonb,
      ${JSON.stringify(token.rug.missingSignals || [])}::jsonb,
      ${JSON.stringify(token)}::jsonb
    )
  `);
}

export async function recordRugScorerV2ScanBatch(tokens: RugScorerV2Token[]) {
  await Promise.allSettled(tokens.slice(0, 40).map((token) => recordRugScorerV2Scan(token)));
}

export async function listRugScorerV2History(input: {
  chainId: string;
  tokenAddress: string;
  limit?: number;
}) {
  await ensureRugScorerV2Tables();
  const key = tokenKey(input.chainId, input.tokenAddress);
  const limit = Math.max(1, Math.min(Number(input.limit || 24), 100));
  const result = await db.execute(sql`
    SELECT
      "id",
      "token_key",
      "chain_id",
      "token_address",
      "token_symbol",
      "token_name",
      "score",
      "risk_level",
      "price_usd",
      "liquidity_usd",
      "volume_h24",
      "created_at"
    FROM "bantahbro_rug_scans"
    WHERE "token_key" = ${key}
    ORDER BY "created_at" DESC
    LIMIT ${limit}
  `);
  return rowsOf<any>(result as QueryRows<any>).map(hydrateHistory);
}

export async function saveRugScorerV2Watch(input: {
  userKey: string;
  token: RugScorerV2Token;
}) {
  await ensureRugScorerV2Tables();
  const userKey = cleanText(input.userKey, 180);
  if (!userKey) throw new Error("User key is required to watch a token.");
  const key = tokenKey(input.token.chainId, input.token.tokenAddress);
  const result = await db.execute(sql`
    INSERT INTO "bantahbro_rug_watchlist" (
      "user_key",
      "token_key",
      "chain_id",
      "token_address",
      "token_symbol",
      "token_name",
      "logo_url",
      "last_score",
      "snapshot"
    ) VALUES (
      ${userKey},
      ${key},
      ${input.token.chainId},
      ${input.token.tokenAddress},
      ${input.token.tokenSymbol},
      ${input.token.tokenName},
      ${input.token.logoUrl},
      ${Math.round(input.token.rug.score || 0)},
      ${JSON.stringify(input.token)}::jsonb
    )
    ON CONFLICT ("user_key", "token_key") DO UPDATE SET
      "token_symbol" = EXCLUDED."token_symbol",
      "token_name" = EXCLUDED."token_name",
      "logo_url" = EXCLUDED."logo_url",
      "last_score" = EXCLUDED."last_score",
      "snapshot" = EXCLUDED."snapshot",
      "updated_at" = now()
    RETURNING *
  `);
  return hydrateWatch(rowsOf<any>(result as QueryRows<any>)[0]);
}

export async function listRugScorerV2Watchlist(input: { userKey: string; limit?: number }) {
  await ensureRugScorerV2Tables();
  const userKey = cleanText(input.userKey, 180);
  if (!userKey) return [];
  const limit = Math.max(1, Math.min(Number(input.limit || 30), 100));
  const result = await db.execute(sql`
    SELECT *
    FROM "bantahbro_rug_watchlist"
    WHERE "user_key" = ${userKey}
    ORDER BY "updated_at" DESC
    LIMIT ${limit}
  `);
  return rowsOf<any>(result as QueryRows<any>).map(hydrateWatch);
}

export async function deleteRugScorerV2Watch(input: { id: string; userKey: string }) {
  await ensureRugScorerV2Tables();
  const result = await db.execute(sql`
    DELETE FROM "bantahbro_rug_watchlist"
    WHERE "id" = ${cleanText(input.id, 80)}
      AND "user_key" = ${cleanText(input.userKey, 180)}
    RETURNING *
  `);
  const row = rowsOf<any>(result as QueryRows<any>)[0];
  return row ? hydrateWatch(row) : null;
}

export async function saveRugScorerV2Report(input: {
  reporterKey: string;
  token: RugScorerV2Token;
  severity: "low" | "medium" | "high";
  reason: string;
  notes?: string | null;
}) {
  await ensureRugScorerV2Tables();
  const reporterKey = cleanText(input.reporterKey, 180);
  if (!reporterKey) throw new Error("Reporter key is required.");
  const reason = cleanText(input.reason, 180);
  if (!reason) throw new Error("Report reason is required.");
  const key = tokenKey(input.token.chainId, input.token.tokenAddress);
  const result = await db.execute(sql`
    INSERT INTO "bantahbro_rug_reports" (
      "reporter_key",
      "token_key",
      "chain_id",
      "token_address",
      "token_symbol",
      "token_name",
      "severity",
      "reason",
      "notes",
      "snapshot"
    ) VALUES (
      ${reporterKey},
      ${key},
      ${input.token.chainId},
      ${input.token.tokenAddress},
      ${input.token.tokenSymbol},
      ${input.token.tokenName},
      ${input.severity},
      ${reason},
      ${cleanText(input.notes, 1000) || null},
      ${JSON.stringify(input.token)}::jsonb
    )
    RETURNING *
  `);
  return hydrateReport(rowsOf<any>(result as QueryRows<any>)[0]);
}

export async function listRugScorerV2Reports(input: {
  chainId?: string | null;
  tokenAddress?: string | null;
  limit?: number;
}) {
  await ensureRugScorerV2Tables();
  const limit = Math.max(1, Math.min(Number(input.limit || 30), 100));
  if (input.chainId && input.tokenAddress) {
    const key = tokenKey(input.chainId, input.tokenAddress);
    const result = await db.execute(sql`
      SELECT *
      FROM "bantahbro_rug_reports"
      WHERE "token_key" = ${key}
      ORDER BY "created_at" DESC
      LIMIT ${limit}
    `);
    return rowsOf<any>(result as QueryRows<any>).map(hydrateReport);
  }

  const result = await db.execute(sql`
    SELECT *
    FROM "bantahbro_rug_reports"
    ORDER BY "created_at" DESC
    LIMIT ${limit}
  `);
  return rowsOf<any>(result as QueryRows<any>).map(hydrateReport);
}

export async function updateRugScorerV2ReportStatus(input: {
  id: string;
  status: "open" | "reviewed" | "dismissed";
}) {
  await ensureRugScorerV2Tables();
  const result = await db.execute(sql`
    UPDATE "bantahbro_rug_reports"
    SET "status" = ${input.status}
    WHERE "id" = ${cleanText(input.id, 80)}
    RETURNING *
  `);
  const row = rowsOf<any>(result as QueryRows<any>)[0];
  return row ? hydrateReport(row) : null;
}
