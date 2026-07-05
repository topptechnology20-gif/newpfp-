import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { predictionVisualizationPositions } from "@shared/schema";
import type {
  PredictionVisualizationBattle,
  PredictionVisualizationExecutionCheck,
  PredictionVisualizationExecutionPreflight,
  PredictionVisualizationOrderIntent,
  PredictionVisualizationPositionResponse,
  PredictionVisualizationUserPosition,
} from "@shared/predictionVisualization";
import {
  getLivePredictionVisualizationBattles,
  preparePredictionVisualizationOrderIntent,
} from "./predictionVisualizationService";

let ensureTablePromise: Promise<void> | null = null;

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIsoString(value: Date | string | null | undefined) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  return null;
}

async function ensurePredictionVisualizationPositionsTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "prediction_visualization_positions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" varchar(255) NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "battle_id" varchar(255) NOT NULL,
        "source_platform" varchar(64) NOT NULL,
        "source_market_id" varchar(255) NOT NULL,
        "source_market_url" text NOT NULL,
        "market_title" text NOT NULL,
        "side" varchar(8) NOT NULL,
        "outcome" varchar(8) NOT NULL,
        "faction_name" varchar(160) NOT NULL,
        "source_token_id" text,
        "wallet_address" varchar(96),
        "amount_usd" numeric(12, 2) NOT NULL,
        "max_price" numeric(8, 4) NOT NULL,
        "estimated_shares" numeric(18, 6) NOT NULL,
        "status" varchar(24) NOT NULL DEFAULT 'intent_saved',
        "execution_status" varchar(32) NOT NULL DEFAULT 'clob-planned',
        "external_order_id" varchar(255),
        "external_status" varchar(64),
        "last_error" text,
        "source_opened_at" timestamp,
        "fill_synced_at" timestamp,
        "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "prediction_visualization_positions_user_battle_unique"
        ON "prediction_visualization_positions" ("user_id", "battle_id");
      CREATE INDEX IF NOT EXISTS "idx_prediction_visualization_positions_user_id"
        ON "prediction_visualization_positions" ("user_id");
      CREATE INDEX IF NOT EXISTS "idx_prediction_visualization_positions_battle_id"
        ON "prediction_visualization_positions" ("battle_id");
      CREATE INDEX IF NOT EXISTS "idx_prediction_visualization_positions_source_market_id"
        ON "prediction_visualization_positions" ("source_market_id");
      CREATE INDEX IF NOT EXISTS "idx_prediction_visualization_positions_status"
        ON "prediction_visualization_positions" ("status");
      CREATE INDEX IF NOT EXISTS "idx_prediction_visualization_positions_updated_at"
        ON "prediction_visualization_positions" ("updated_at");
      ALTER TABLE "prediction_visualization_positions"
        ADD COLUMN IF NOT EXISTS "wallet_address" varchar(96);
      ALTER TABLE "prediction_visualization_positions"
        ADD COLUMN IF NOT EXISTS "external_order_id" varchar(255);
      ALTER TABLE "prediction_visualization_positions"
        ADD COLUMN IF NOT EXISTS "external_status" varchar(64);
      ALTER TABLE "prediction_visualization_positions"
        ADD COLUMN IF NOT EXISTS "last_error" text;
    `).then(() => undefined);
  }
  return ensureTablePromise;
}

function hydratePosition(
  row: typeof predictionVisualizationPositions.$inferSelect,
): PredictionVisualizationUserPosition {
  return {
    id: row.id,
    userId: row.userId,
    battleId: row.battleId,
    sourcePlatform: row.sourcePlatform as PredictionVisualizationUserPosition["sourcePlatform"],
    sourceMarketId: row.sourceMarketId,
    sourceMarketUrl: row.sourceMarketUrl,
    marketTitle: row.marketTitle,
    side: row.side,
    outcome: row.outcome,
    factionName: row.factionName,
    sourceTokenId: row.sourceTokenId,
    walletAddress: row.walletAddress,
    amountUsd: toNumber(row.amountUsd),
    maxPrice: toNumber(row.maxPrice),
    estimatedShares: toNumber(row.estimatedShares),
    status: row.status,
    executionStatus: row.executionStatus,
    externalOrderId: row.externalOrderId,
    externalStatus: row.externalStatus,
    lastError: row.lastError,
    sourceOpenedAt: toIsoString(row.sourceOpenedAt),
    fillSyncedAt: toIsoString(row.fillSyncedAt),
    createdAt: toIsoString(row.createdAt) || new Date().toISOString(),
    updatedAt: toIsoString(row.updatedAt) || new Date().toISOString(),
  };
}

function buildSnapshot(battle: PredictionVisualizationBattle, intent: PredictionVisualizationOrderIntent) {
  return {
    battle: {
      id: battle.id,
      title: battle.title,
      marketTitle: battle.marketTitle,
      category: battle.category,
      sourceStatus: battle.sourceStatus,
      volume: battle.volume,
      liquidity: battle.liquidity,
      endDate: battle.endDate,
      sides: battle.sides,
      updatedAt: battle.updatedAt,
    },
    intent: {
      side: intent.side,
      outcome: intent.outcome,
      amountUsd: intent.amountUsd,
      maxPrice: intent.maxPrice,
      estimatedShares: intent.estimatedShares,
      executionReady: intent.executionReady,
      nextAction: intent.nextAction,
      warnings: intent.warnings,
    },
  };
}

export async function listPredictionVisualizationPositions(userId: string, limit = 20) {
  await ensurePredictionVisualizationPositionsTable();
  const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
  const rows = await db
    .select()
    .from(predictionVisualizationPositions)
    .where(eq(predictionVisualizationPositions.userId, userId))
    .orderBy(desc(predictionVisualizationPositions.updatedAt))
    .limit(safeLimit);

  return rows.map(hydratePosition);
}

export async function savePredictionVisualizationPosition(input: {
  userId: string;
  battleId: string;
  side: "yes" | "no";
  amountUsd: number;
  maxPrice?: number;
  walletAddress?: string | null;
}): Promise<PredictionVisualizationPositionResponse> {
  await ensurePredictionVisualizationPositionsTable();

  const feed = await getLivePredictionVisualizationBattles(30);
  const battle = feed.battles.find((candidate) => candidate.id === input.battleId);
  if (!battle) {
    throw new Error("Prediction visualization battle not found in the live feed");
  }

  const intent = await preparePredictionVisualizationOrderIntent({
    battleId: input.battleId,
    side: input.side,
    amountUsd: input.amountUsd,
    maxPrice: input.maxPrice,
  });
  const now = new Date();

  const [row] = await db
    .insert(predictionVisualizationPositions)
    .values({
      userId: input.userId,
      battleId: intent.battleId,
      sourcePlatform: intent.sourcePlatform,
      sourceMarketId: intent.sourceMarketId,
      sourceMarketUrl: intent.sourceMarketUrl,
      marketTitle: battle.marketTitle,
      side: intent.side,
      outcome: intent.outcome,
      factionName: intent.factionName,
      sourceTokenId: intent.sourceTokenId,
      walletAddress: input.walletAddress || null,
      amountUsd: String(intent.amountUsd),
      maxPrice: String(intent.maxPrice),
      estimatedShares: String(intent.estimatedShares),
      status: "intent_saved",
      executionStatus: intent.executionStatus,
      externalOrderId: null,
      externalStatus: null,
      lastError: null,
      sourceOpenedAt: null,
      fillSyncedAt: null,
      snapshot: buildSnapshot(battle, intent),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [predictionVisualizationPositions.userId, predictionVisualizationPositions.battleId],
      set: {
        sourcePlatform: intent.sourcePlatform,
        sourceMarketId: intent.sourceMarketId,
        sourceMarketUrl: intent.sourceMarketUrl,
        marketTitle: battle.marketTitle,
        side: intent.side,
        outcome: intent.outcome,
        factionName: intent.factionName,
        sourceTokenId: intent.sourceTokenId,
        walletAddress: input.walletAddress || null,
        amountUsd: String(intent.amountUsd),
        maxPrice: String(intent.maxPrice),
        estimatedShares: String(intent.estimatedShares),
        status: "intent_saved",
        executionStatus: intent.executionStatus,
        externalOrderId: null,
        externalStatus: null,
        lastError: null,
        sourceOpenedAt: null,
        fillSyncedAt: null,
        snapshot: buildSnapshot(battle, intent),
        updatedAt: now,
      },
    })
    .returning();

  return {
    position: hydratePosition(row),
    intent,
    battle,
  };
}

function getClobConfig() {
  const host = String(process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com").trim();
  const chainId = Number(process.env.POLYMARKET_CHAIN_ID || "137");
  const executionEnabled = String(process.env.POLYMARKET_CLOB_EXECUTION_ENABLED || "")
    .trim()
    .toLowerCase() === "true";
  const serverCredentialsConfigured = Boolean(
    process.env.POLYMARKET_CLOB_API_KEY &&
      process.env.POLYMARKET_CLOB_API_SECRET &&
      process.env.POLYMARKET_CLOB_API_PASSPHRASE,
  );

  return {
    host: host || null,
    chainId: Number.isFinite(chainId) ? chainId : null,
    executionEnabled,
    serverCredentialsConfigured,
    sdkAvailable: false,
  };
}

function check(
  id: string,
  label: string,
  ready: boolean,
  detail: string,
): PredictionVisualizationExecutionCheck {
  return { id, label, ready, detail };
}

function resolveNextAction(checks: PredictionVisualizationExecutionCheck[]) {
  const failed = checks.find((item) => !item.ready);
  if (!failed) return "submit-clob-order" as const;
  if (failed.id === "wallet") return "connect-wallet" as const;
  if (failed.id === "clob-config" || failed.id === "clob-credentials" || failed.id === "clob-sdk") {
    return "configure-clob" as const;
  }
  if (failed.id === "wallet-signer") return "wire-wallet-signer" as const;
  return "open-source-market" as const;
}

export async function getPredictionVisualizationExecutionPreflight(input: {
  userId: string;
  positionId: string;
  walletAddress?: string | null;
}): Promise<PredictionVisualizationExecutionPreflight> {
  await ensurePredictionVisualizationPositionsTable();
  const [row] = await db
    .select()
    .from(predictionVisualizationPositions)
    .where(
      and(
        eq(predictionVisualizationPositions.id, input.positionId),
        eq(predictionVisualizationPositions.userId, input.userId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error("Tracked prediction position not found");
  }

  const position = hydratePosition(row);
  const walletAddress = input.walletAddress || position.walletAddress || null;
  const clob = getClobConfig();
  const checks = [
    check("wallet", "Wallet connected", Boolean(walletAddress), walletAddress || "No wallet address supplied yet."),
    check(
      "outcome-token",
      "Outcome token ID",
      Boolean(position.sourceTokenId),
      position.sourceTokenId || "Polymarket did not expose a CLOB outcome token for this side.",
    ),
    check(
      "price-protection",
      "Price protected",
      position.maxPrice > 0 && position.maxPrice <= 0.99,
      `Max price ${position.maxPrice.toFixed(4)} for a marketable limit ticket.`,
    ),
    check(
      "clob-config",
      "CLOB host configured",
      Boolean(clob.host && clob.chainId),
      clob.host ? `${clob.host} on chain ${clob.chainId}` : "Set POLYMARKET_CLOB_HOST and POLYMARKET_CHAIN_ID.",
    ),
    check(
      "clob-sdk",
      "CLOB SDK available",
      clob.sdkAvailable,
      "Polymarket CLOB SDK is not installed/wired in this app yet.",
    ),
    check(
      "wallet-signer",
      "Wallet signer wired",
      false,
      "Frontend EIP-712 order signing and allowance checks are not wired yet.",
    ),
    check(
      "clob-credentials",
      "CLOB submission credentials",
      clob.executionEnabled && clob.serverCredentialsConfigured,
      clob.executionEnabled
        ? "CLOB execution flag is on; credentials still must be present."
        : "Set POLYMARKET_CLOB_EXECUTION_ENABLED=true only after signer and credential flow is ready.",
    ),
  ];
  const executionReady = checks.every((item) => item.ready);
  const nextAction = resolveNextAction(checks);
  const now = new Date();

  const [updated] = await db
    .update(predictionVisualizationPositions)
    .set({
      walletAddress,
      status: "execution_checked",
      externalStatus: executionReady ? "ready_to_submit" : nextAction,
      lastError: executionReady ? null : checks.find((item) => !item.ready)?.detail || null,
      updatedAt: now,
    })
    .where(eq(predictionVisualizationPositions.id, position.id))
    .returning();

  const refreshed = hydratePosition(updated || row);

  return {
    positionId: refreshed.id,
    battleId: refreshed.battleId,
    sourcePlatform: refreshed.sourcePlatform,
    sourceMarketId: refreshed.sourceMarketId,
    side: refreshed.side,
    outcome: refreshed.outcome,
    walletAddress: refreshed.walletAddress,
    amountUsd: refreshed.amountUsd,
    maxPrice: refreshed.maxPrice,
    sourceTokenId: refreshed.sourceTokenId,
    estimatedShares: refreshed.estimatedShares,
    orderType: "marketable-limit",
    executionReady,
    nextAction,
    checks,
    message: executionReady
      ? "Execution preflight passed. The next step can submit a signed CLOB order."
      : "Execution preflight saved, but live CLOB submission remains locked until every safety check passes.",
    warnings: executionReady
      ? []
      : [
          "No Polymarket order was submitted.",
          "Open the source market for live trading until BantahBro wallet signing and CLOB submission are enabled.",
        ],
    clob,
  };
}

export async function markPredictionVisualizationPositionSourceOpened(input: {
  userId: string;
  positionId: string;
}) {
  await ensurePredictionVisualizationPositionsTable();
  const now = new Date();
  const [row] = await db
    .update(predictionVisualizationPositions)
    .set({
      status: "source_opened",
      sourceOpenedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(predictionVisualizationPositions.id, input.positionId),
        eq(predictionVisualizationPositions.userId, input.userId),
      ),
    )
    .returning();

  if (!row) {
    throw new Error("Tracked prediction position not found");
  }

  return hydratePosition(row);
}
