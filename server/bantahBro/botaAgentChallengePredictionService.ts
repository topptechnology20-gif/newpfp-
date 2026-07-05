import { sql } from "drizzle-orm";
import { db } from "../db";
import { getOnchainServerConfig } from "../onchainConfig";
import { verifyEscrowTransaction } from "../onchainEscrowService";
import {
  normalizeEvmAddress,
  normalizeOnchainTokenSymbol,
  type OnchainTokenSymbol,
} from "@shared/onchainConfig";
import type {
  BotaAgentChallengePredictionPool,
  BotaAgentChallengePredictionPosition,
  BotaAgentChallengePredictionSide,
  BotaAgentChallengePredictionStakeResponse,
} from "@shared/botaAgentChallengePrediction";
import { getBotaAgentChallengeByCode, type BotaAgentChallenge } from "./botaAgentChallengeService";
import { broadcastBotaTelegramEvent, notifyBotaUser } from "./botaNotificationService";

const PVP_CHALLENGE_PREDICTION_ESCROW_OFFSET = 800_000_000;

let ensureTablePromise: Promise<void> | null = null;

function tableRows<T = any>(result: any): T[] {
  return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIso(value: unknown) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function isOnchainTokenSymbol(value: unknown): value is OnchainTokenSymbol {
  return value === "USDC" || value === "USDT" || value === "ETH" || value === "BNB";
}

function normalizePredictionSide(value: unknown): BotaAgentChallengePredictionSide {
  return String(value || "").trim().toUpperCase() === "NO" ? "NO" : "YES";
}

function resolveChallengeEscrowDefaults(input?: {
  stakeCurrency?: string | null;
  chainId?: number | null;
}) {
  const config = getOnchainServerConfig();
  const chains = Object.values(config.chains || {});
  const requestedChain = input?.chainId
    ? config.chains[String(input.chainId)] || null
    : null;
  const chain =
    requestedChain ||
    config.chains[String(config.defaultChainId)] ||
    chains[0] ||
    null;
  const requestedToken = isOnchainTokenSymbol(input?.stakeCurrency)
    ? input.stakeCurrency
    : normalizeOnchainTokenSymbol(config.defaultToken || "USDC");
  const tokenSymbol =
    chain && chain.supportedTokens?.includes(requestedToken)
      ? requestedToken
      : chain?.supportedTokens?.find(isOnchainTokenSymbol) || requestedToken;

  return {
    chainId: chain?.chainId || config.defaultChainId || null,
    tokenSymbol,
    contractEnabled: config.contractEnabled === true,
    supportsChallengeLock: chain?.escrowSupportsChallengeLock === true,
  };
}

export async function ensureBotaAgentChallengePredictionTables() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bota_agent_pvp_prediction_markets" (
        "id" serial PRIMARY KEY,
        "challenge_code" varchar(80) NOT NULL UNIQUE,
        "escrow_challenge_id" integer UNIQUE,
        "escrow_chain_id" integer NOT NULL,
        "escrow_token_symbol" varchar(16) NOT NULL,
        "status" varchar(32) NOT NULL DEFAULT 'open',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS "bota_agent_pvp_prediction_positions" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
        "user_id" varchar(255) NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "challenge_code" varchar(80) NOT NULL,
        "side" varchar(3) NOT NULL,
        "side_agent_id" varchar(180) NOT NULL,
        "side_agent_name" varchar(180) NOT NULL,
        "stake_amount" numeric(18, 6) NOT NULL,
        "stake_currency" varchar(16) NOT NULL DEFAULT 'USDC',
        "escrow_challenge_id" integer,
        "escrow_chain_id" integer,
        "escrow_token_symbol" varchar(16),
        "wallet_address" varchar(128),
        "escrow_status" varchar(32) NOT NULL DEFAULT 'escrow_required',
        "escrow_tx_hash" varchar(80),
        "winner_side" varchar(3),
        "payout_amount" numeric(18, 6),
        "payout_tx_hash" varchar(80),
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "bota_agent_pvp_prediction_positions_user_challenge_unique"
        ON "bota_agent_pvp_prediction_positions" ("user_id", "challenge_code");
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_pvp_prediction_positions_challenge"
        ON "bota_agent_pvp_prediction_positions" ("challenge_code");
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_pvp_prediction_positions_user"
        ON "bota_agent_pvp_prediction_positions" ("user_id");
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_pvp_prediction_positions_escrow_status"
        ON "bota_agent_pvp_prediction_positions" ("escrow_status");
      CREATE INDEX IF NOT EXISTS "idx_bota_agent_pvp_prediction_positions_tx"
        ON "bota_agent_pvp_prediction_positions" ("escrow_tx_hash");
    `).then(() => undefined);
  }
  return ensureTablePromise;
}

async function getOrCreatePredictionMarket(input: {
  challengeCode: string;
  stakeCurrency?: string | null;
}) {
  await ensureBotaAgentChallengePredictionTables();
  const defaults = resolveChallengeEscrowDefaults({ stakeCurrency: input.stakeCurrency });
  if (!defaults.chainId || !defaults.tokenSymbol) {
    const error = new Error("Challenge prediction escrow chain/token is not configured");
    (error as { status?: number }).status = 503;
    throw error;
  }

  const inserted = await db.execute(sql`
    INSERT INTO "bota_agent_pvp_prediction_markets" (
      "challenge_code",
      "escrow_chain_id",
      "escrow_token_symbol"
    )
    VALUES (${input.challengeCode}, ${defaults.chainId}, ${defaults.tokenSymbol})
    ON CONFLICT ("challenge_code") DO NOTHING
    RETURNING *;
  `);

  const createdOrExisting =
    tableRows(inserted)[0] ||
    tableRows(
      await db.execute(sql`
        SELECT * FROM "bota_agent_pvp_prediction_markets"
        WHERE "challenge_code" = ${input.challengeCode}
        LIMIT 1;
      `),
    )[0];

  if (!createdOrExisting) {
    throw new Error("Unable to reserve challenge prediction market");
  }

  if (createdOrExisting.escrow_challenge_id) {
    return createdOrExisting;
  }

  const escrowChallengeId =
    PVP_CHALLENGE_PREDICTION_ESCROW_OFFSET + Number(createdOrExisting.id);
  const updated = await db.execute(sql`
    UPDATE "bota_agent_pvp_prediction_markets"
    SET
      "escrow_challenge_id" = ${escrowChallengeId},
      "updated_at" = now()
    WHERE "id" = ${createdOrExisting.id}
    RETURNING *;
  `);

  return tableRows(updated)[0] || createdOrExisting;
}

function getPredictionSideAgent(
  challenge: BotaAgentChallenge,
  side: BotaAgentChallengePredictionSide,
) {
  return side === "YES" ? challenge.challengerAgent : challenge.opponentAgent;
}

function getBettingCloseReason(challenge: BotaAgentChallenge) {
  if (challenge.visibility !== "public") return "Private challenges do not open public YES/NO markets.";
  if (!challenge.predictionEnabled) return "Predictions are disabled for this challenge.";
  if (challenge.status === "pending") return "Predictions open after the opponent accepts.";
  if (challenge.status === "cancelled") return "This challenge was cancelled.";
  if (challenge.status === "expired") return "This challenge expired.";
  if (challenge.status === "resolved") return "This challenge has already settled.";
  if (challenge.status === "live") return "This fight is already live; the market is closed.";
  const scheduledAtMs = challenge.scheduledAt ? new Date(challenge.scheduledAt).getTime() : null;
  if (scheduledAtMs && Number.isFinite(scheduledAtMs) && scheduledAtMs <= Date.now()) {
    return "This fight has started; the market is closed.";
  }
  return null;
}

function hydratePosition(row: any): BotaAgentChallengePredictionPosition {
  const token = isOnchainTokenSymbol(row.escrow_token_symbol)
    ? row.escrow_token_symbol
    : isOnchainTokenSymbol(row.stake_currency)
      ? row.stake_currency
      : "USDC";
  return {
    id: String(row.id),
    userId: String(row.user_id),
    challengeCode: String(row.challenge_code),
    side: normalizePredictionSide(row.side),
    sideAgentId: String(row.side_agent_id),
    sideAgentName: String(row.side_agent_name),
    stakeAmount: toNumber(row.stake_amount),
    stakeCurrency: token,
    escrowChallengeId: row.escrow_challenge_id === null ? null : toNumber(row.escrow_challenge_id),
    escrowChainId: row.escrow_chain_id === null ? null : toNumber(row.escrow_chain_id),
    escrowTokenSymbol: token,
    walletAddress: row.wallet_address || null,
    escrowStatus: row.escrow_status || "escrow_required",
    escrowTxHash: row.escrow_tx_hash || null,
    winnerSide: row.winner_side ? normalizePredictionSide(row.winner_side) : null,
    payoutAmount: row.payout_amount === null ? null : toNumber(row.payout_amount),
    payoutTxHash: row.payout_tx_hash || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function buildPoolFromRows(input: {
  challenge: BotaAgentChallenge;
  market: any;
  rows: any[];
  userId?: string | null;
}): BotaAgentChallengePredictionPool {
  const activeRows = input.rows.filter(
    (row) => row.escrow_status !== "cancelled" && row.escrow_status !== "failed",
  );
  const totalStake = activeRows.reduce((sum, row) => sum + toNumber(row.stake_amount), 0);
  const userRow = input.userId ? activeRows.find((row) => row.user_id === input.userId) : null;
  const defaults = resolveChallengeEscrowDefaults({
    stakeCurrency: input.market?.escrow_token_symbol,
    chainId: input.market?.escrow_chain_id,
  });
  const closeReason = getBettingCloseReason(input.challenge);
  const token = isOnchainTokenSymbol(input.market?.escrow_token_symbol)
    ? input.market.escrow_token_symbol
    : defaults.tokenSymbol || "USDC";
  const escrowLocked =
    activeRows.length > 0 && activeRows.every((row) => row.escrow_status === "escrow_locked");

  const buildSide = (side: BotaAgentChallengePredictionSide) => {
    const agent = getPredictionSideAgent(input.challenge, side);
    const sideRows = activeRows.filter((row) => normalizePredictionSide(row.side) === side);
    const sideStake = sideRows.reduce((sum, row) => sum + toNumber(row.stake_amount), 0);
    return {
      side,
      label: `${side} ${agent.name}`,
      agentId: agent.id,
      agentName: agent.name,
      avatarUrl: agent.avatarUrl,
      totalStake: sideStake,
      bettorCount: sideRows.length,
      sharePercent: totalStake > 0 ? Math.round((sideStake / totalStake) * 100) : 50,
    };
  };

  return {
    challengeCode: input.challenge.challengeCode,
    status: closeReason ? "closed" : "betting_open",
    closeReason,
    stakeCurrency: token,
    escrowMode: escrowLocked
      ? "escrow_locked"
      : defaults.contractEnabled && defaults.supportsChallengeLock
        ? "contract_escrow"
        : "intent_tracking",
    escrowChallengeId: input.market?.escrow_challenge_id ?? null,
    escrowChainId: input.market?.escrow_chain_id ?? defaults.chainId ?? null,
    escrowTokenSymbol: token,
    totalStake,
    positionCount: activeRows.length,
    sides: [buildSide("YES"), buildSide("NO")],
    userPosition: userRow ? hydratePosition(userRow) : null,
    updatedAt: new Date().toISOString(),
    message:
      defaults.contractEnabled && defaults.supportsChallengeLock
        ? "PvP YES/NO stakes lock through the existing Bantah onchain escrow contract."
        : "PvP prediction escrow needs Bantah V2 challenge-lock config before real staking.",
  };
}

export async function getBotaAgentChallengePredictionPool(input: {
  challengeCode: string;
  userId?: string | null;
}): Promise<BotaAgentChallengePredictionPool> {
  await ensureBotaAgentChallengePredictionTables();
  const challenge = await getBotaAgentChallengeByCode({
    challengeCode: input.challengeCode,
    viewerUserId: input.userId || null,
  });
  if (!challenge) {
    const error = new Error("Agent challenge not found");
    (error as { status?: number }).status = 404;
    throw error;
  }

  const market = await getOrCreatePredictionMarket({
    challengeCode: challenge.challengeCode,
    stakeCurrency: challenge.stakeCurrency,
  });
  const rows = tableRows(
    await db.execute(sql`
      SELECT * FROM "bota_agent_pvp_prediction_positions"
      WHERE "challenge_code" = ${challenge.challengeCode}
      ORDER BY "updated_at" DESC;
    `),
  );

  return buildPoolFromRows({ challenge, market, rows, userId: input.userId || null });
}

export async function listBotaAgentChallengePredictionPositionsForUser(
  userId: string,
  limit = 20,
): Promise<BotaAgentChallengePredictionPosition[]> {
  await ensureBotaAgentChallengePredictionTables();
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return [];

  const rows = tableRows(
    await db.execute(sql`
      SELECT *
      FROM "bota_agent_pvp_prediction_positions"
      WHERE "user_id" = ${normalizedUserId}
      ORDER BY "updated_at" DESC, "created_at" DESC
      LIMIT ${Math.max(1, Math.min(Math.round(Number(limit || 20)), 100))};
    `),
  );

  return rows.map(hydratePosition);
}

export async function placeBotaAgentChallengePredictionStake(input: {
  userId: string;
  challengeCode: string;
  side: BotaAgentChallengePredictionSide;
  stakeAmount: number;
  stakeCurrency?: OnchainTokenSymbol | null;
  walletAddress?: string | null;
}): Promise<BotaAgentChallengePredictionStakeResponse> {
  await ensureBotaAgentChallengePredictionTables();
  const challenge = await getBotaAgentChallengeByCode({
    challengeCode: input.challengeCode,
    viewerUserId: input.userId,
  });
  if (!challenge) {
    const error = new Error("Agent challenge not found");
    (error as { status?: number }).status = 404;
    throw error;
  }

  const closeReason = getBettingCloseReason(challenge);
  if (closeReason) {
    const error = new Error(closeReason);
    (error as { status?: number }).status = 409;
    throw error;
  }

  const stakeAmount = Number(input.stakeAmount);
  if (!Number.isFinite(stakeAmount) || stakeAmount <= 0) {
    throw new Error("Stake amount must be greater than zero");
  }

  const side = normalizePredictionSide(input.side);
  const sideAgent = getPredictionSideAgent(challenge, side);
  const market = await getOrCreatePredictionMarket({
    challengeCode: challenge.challengeCode,
    stakeCurrency: input.stakeCurrency || challenge.stakeCurrency,
  });
  const token = isOnchainTokenSymbol(market.escrow_token_symbol)
    ? market.escrow_token_symbol
    : "USDC";

  const inserted = await db.execute(sql`
    INSERT INTO "bota_agent_pvp_prediction_positions" (
      "user_id",
      "challenge_code",
      "side",
      "side_agent_id",
      "side_agent_name",
      "stake_amount",
      "stake_currency",
      "escrow_challenge_id",
      "escrow_chain_id",
      "escrow_token_symbol",
      "wallet_address",
      "escrow_status",
      "escrow_tx_hash",
      "updated_at"
    )
    VALUES (
      ${input.userId},
      ${challenge.challengeCode},
      ${side},
      ${sideAgent.id},
      ${sideAgent.name},
      ${String(stakeAmount)},
      ${token},
      ${market.escrow_challenge_id},
      ${market.escrow_chain_id},
      ${token},
      ${input.walletAddress || null},
      'escrow_required',
      NULL,
      now()
    )
    ON CONFLICT ("user_id", "challenge_code") DO UPDATE
    SET
      "side" = EXCLUDED."side",
      "side_agent_id" = EXCLUDED."side_agent_id",
      "side_agent_name" = EXCLUDED."side_agent_name",
      "stake_amount" = EXCLUDED."stake_amount",
      "stake_currency" = EXCLUDED."stake_currency",
      "escrow_challenge_id" = EXCLUDED."escrow_challenge_id",
      "escrow_chain_id" = EXCLUDED."escrow_chain_id",
      "escrow_token_symbol" = EXCLUDED."escrow_token_symbol",
      "wallet_address" = EXCLUDED."wallet_address",
      "escrow_status" = 'escrow_required',
      "escrow_tx_hash" = NULL,
      "winner_side" = NULL,
      "payout_amount" = NULL,
      "payout_tx_hash" = NULL,
      "updated_at" = now()
    RETURNING *;
  `);

  const row = tableRows(inserted)[0];
  const rows = tableRows(
    await db.execute(sql`
      SELECT * FROM "bota_agent_pvp_prediction_positions"
      WHERE "challenge_code" = ${challenge.challengeCode}
      ORDER BY "updated_at" DESC;
    `),
  );

  return {
    position: hydratePosition(row),
    pool: buildPoolFromRows({ challenge, market, rows, userId: input.userId }),
    message:
      `PvP prediction ticket reserved. Lock ${stakeAmount.toLocaleString()} ${token} in the existing Bantah escrow contract to activate it.`,
  };
}

export async function markBotaAgentChallengePredictionEscrowLocked(input: {
  userId: string;
  positionId: string;
  walletAddress?: string | null;
  escrowTxHash?: string | null;
}): Promise<BotaAgentChallengePredictionPosition> {
  await ensureBotaAgentChallengePredictionTables();
  const existing = tableRows(
    await db.execute(sql`
      SELECT * FROM "bota_agent_pvp_prediction_positions"
      WHERE "id" = ${input.positionId} AND "user_id" = ${input.userId}
      LIMIT 1;
    `),
  )[0];

  if (!existing) {
    const error = new Error("PvP prediction position not found");
    (error as { status?: number }).status = 404;
    throw error;
  }

  const txHash = input.escrowTxHash || existing.escrow_tx_hash;
  const wallet = input.walletAddress || existing.wallet_address;
  if (!txHash) {
    throw new Error("escrowTxHash is required to mark this PvP prediction escrow-locked");
  }
  const normalizedWallet = normalizeEvmAddress(wallet || "");
  if (!normalizedWallet) {
    throw new Error("Wallet address is required to verify PvP prediction escrow");
  }

  const config = getOnchainServerConfig();
  const chainId = toNumber(existing.escrow_chain_id, config.defaultChainId);
  const chain = config.chains[String(chainId)];
  const escrowContract = normalizeEvmAddress(chain?.escrowContractAddress);
  const tokenSymbol = isOnchainTokenSymbol(existing.escrow_token_symbol)
    ? existing.escrow_token_symbol
    : normalizeOnchainTokenSymbol(config.defaultToken || "USDC");

  if (!config.contractEnabled || !chain || !escrowContract || chain.escrowSupportsChallengeLock !== true) {
    const error = new Error("Bantah PvP prediction escrow contract is not configured");
    (error as { status?: number }).status = 503;
    throw error;
  }

  const verified = await verifyEscrowTransaction({
    rpcUrl: chain.rpcUrl,
    expectedChainId: chain.chainId,
    expectedFrom: normalizedWallet,
    expectedEscrowContract: escrowContract,
    tokenSymbol,
    txHash,
  });

  const duplicateOwn = tableRows(
    await db.execute(sql`
      SELECT "id" FROM "bota_agent_pvp_prediction_positions"
      WHERE "escrow_tx_hash" = ${verified.txHash}
      LIMIT 1;
    `),
  )[0];
  if (duplicateOwn && duplicateOwn.id !== existing.id) {
    const error = new Error("This escrow transaction hash is already attached to another PvP prediction");
    (error as { status?: number }).status = 409;
    throw error;
  }

  const duplicateBattle = tableRows(
    await db.execute(sql`
      SELECT "id" FROM "agent_battle_p2p_positions"
      WHERE "escrow_tx_hash" = ${verified.txHash}
      LIMIT 1;
    `),
  )[0];
  if (duplicateBattle) {
    const error = new Error("This escrow transaction hash is already attached to another battle stake");
    (error as { status?: number }).status = 409;
    throw error;
  }

  const updated = tableRows(
    await db.execute(sql`
      UPDATE "bota_agent_pvp_prediction_positions"
      SET
        "wallet_address" = ${verified.from},
        "escrow_tx_hash" = ${verified.txHash},
        "escrow_status" = 'escrow_locked',
        "updated_at" = now()
      WHERE "id" = ${existing.id} AND "user_id" = ${input.userId}
      RETURNING *;
    `),
  )[0];

  const position = hydratePosition(updated);
  const challenge = await getBotaAgentChallengeByCode({
    challengeCode: position.challengeCode,
    viewerUserId: input.userId,
  });
  const opponentAgent =
    position.side === "YES" ? challenge?.opponentAgent?.name : challenge?.challengerAgent?.name;

  await Promise.allSettled([
    notifyBotaUser({
      userId: input.userId,
      type: "bota_pvp_prediction_locked",
      title: "PvP prediction locked",
      message:
        `${position.side} on ${position.sideAgentName} is active for ` +
        `${position.stakeAmount.toLocaleString()} ${tokenSymbol}.`,
      icon: "B",
      url: `/bota?section=challenge&challenge=${encodeURIComponent(position.challengeCode)}`,
      data: {
        position,
        challengeCode: position.challengeCode,
      },
      priority: 3,
      fomoLevel: "high",
    }),
    broadcastBotaTelegramEvent({
      id: `telegram-bota-pvp-prediction-${position.id}`,
      title: "BOTA PVP PREDICTION LOCKED",
      lines: [
        `${position.side} on ${position.sideAgentName}.`,
        opponentAgent ? `Opponent: ${opponentAgent}` : `Challenge: ${position.challengeCode}`,
        `Stake: ${position.stakeAmount.toLocaleString()} ${tokenSymbol}`,
      ],
      url: `/bota?section=challenge&challenge=${encodeURIComponent(position.challengeCode)}`,
      tags: ["BOTA", "PvP", "Prediction"],
      market: `${position.sideAgentName}${opponentAgent ? ` vs ${opponentAgent}` : ""}`,
    }),
  ]);

  return position;
}
