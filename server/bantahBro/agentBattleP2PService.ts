import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "../db";
import { agentBattleP2PPositions, agentBattleP2PRounds, users } from "@shared/schema";
import type { BantahBroPairSnapshot } from "@shared/bantahBro";
import {
  getOnchainServerConfig,
} from "../onchainConfig";
import { verifyEscrowTransaction } from "../onchainEscrowService";
import {
  normalizeEvmAddress,
  normalizeOnchainTokenSymbol,
  type OnchainTokenSymbol,
} from "@shared/onchainConfig";
import type {
  AgentBattleP2PHistoryPosition,
  AgentBattleP2PPool,
  AgentBattleP2PPosition,
  AgentBattleP2PStakeResponse,
} from "@shared/agentBattleP2P";
import {
  getLiveBantahBroAgentBattles,
  type BantahBroAgentBattle,
  type BantahBroAgentBattleSide,
} from "./agentBattleService";
import { simulateBotaArenaBattleFromLiveBattle } from "./botaArenaEngine";
import {
  choosePrimaryPair,
  fetchDexScreenerTokenPairs,
  normalizePair,
} from "./tokenIntelligence";
import { broadcastBotaTelegramEvent, notifyBotaUser } from "./botaNotificationService";

const BATTLE_ESCROW_ID_OFFSET = 900_000_000;
const ESCROW_V2_PAYOUT_ABI = [
  "function settleChallengeNativePayout(uint256 challengeId, address winner, address loser) returns (bool)",
  "function settleChallengeTokenPayout(uint256 challengeId, address token, address winner, address loser) returns (bool)",
];

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
  return new Date().toISOString();
}

function roundEndedAtOrBeforeNow(roundEndsAt: Date | string | null | undefined, nowMs = Date.now()) {
  const endsAtMs = new Date(roundEndsAt || 0).getTime();
  return Number.isFinite(endsAtMs) && endsAtMs <= nowMs;
}

function battleSymbol(side: BantahBroAgentBattleSide) {
  return (side.tokenSymbol || side.label || "TOKEN").replace(/^\$/, "").trim() || "TOKEN";
}

function makeRoundId(battle: BantahBroAgentBattle) {
  const startMs = new Date(battle.startsAt).getTime();
  return `${battle.id}:round:${Number.isFinite(startMs) ? startMs : battle.startsAt}`
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .slice(0, 320);
}

function isOnchainTokenSymbol(value: unknown): value is OnchainTokenSymbol {
  return value === "USDC" || value === "USDT" || value === "ETH" || value === "BNB";
}

function resolveBattleEscrowDefaults(input?: {
  stakeCurrency?: string | null;
  chainId?: number | null;
}): {
  chainId: number | null;
  tokenSymbol: OnchainTokenSymbol | null;
  contractEnabled: boolean;
  supportsChallengeLock: boolean;
} {
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

async function ensureAgentBattleP2PPositionsTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "agent_battle_p2p_positions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" varchar(255) NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "battle_id" varchar(255) NOT NULL,
        "round_id" varchar(320) NOT NULL,
        "round_starts_at" timestamp NOT NULL,
        "round_ends_at" timestamp NOT NULL,
        "side_id" text NOT NULL,
        "side_label" varchar(160) NOT NULL,
        "side_symbol" varchar(64),
        "side_logo_url" text,
        "opponent_side_id" text,
        "stake_amount" numeric(18, 6) NOT NULL,
        "stake_currency" varchar(16) NOT NULL DEFAULT 'BXBT',
        "escrow_challenge_id" integer,
        "escrow_chain_id" integer,
        "escrow_token_symbol" varchar(16),
        "wallet_address" varchar(128),
        "escrow_status" varchar(32) NOT NULL DEFAULT 'intent_saved',
        "escrow_tx_hash" varchar(80),
        "winner_side_id" text,
        "payout_amount" numeric(18, 6),
        "payout_tx_hash" varchar(80),
        "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS "agent_battle_p2p_rounds" (
        "id" serial PRIMARY KEY,
        "battle_id" varchar(255) NOT NULL,
        "round_id" varchar(320) NOT NULL UNIQUE,
        "round_starts_at" timestamp NOT NULL,
        "round_ends_at" timestamp NOT NULL,
        "escrow_challenge_id" integer UNIQUE,
        "escrow_chain_id" integer NOT NULL,
        "escrow_token_symbol" varchar(16) NOT NULL,
        "settlement_status" varchar(32) NOT NULL DEFAULT 'open',
        "winner_side_id" text,
        "settlement_tx_hashes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "settlement_error" text,
        "settled_at" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_agent_battle_p2p_rounds_battle_id"
        ON "agent_battle_p2p_rounds" ("battle_id");
      CREATE INDEX IF NOT EXISTS "idx_agent_battle_p2p_rounds_round_id"
        ON "agent_battle_p2p_rounds" ("round_id");
      CREATE INDEX IF NOT EXISTS "idx_agent_battle_p2p_rounds_escrow_challenge_id"
        ON "agent_battle_p2p_rounds" ("escrow_challenge_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "agent_battle_p2p_positions_user_round_unique"
        ON "agent_battle_p2p_positions" ("user_id", "round_id");
      CREATE INDEX IF NOT EXISTS "idx_agent_battle_p2p_positions_user_id"
        ON "agent_battle_p2p_positions" ("user_id");
      CREATE INDEX IF NOT EXISTS "idx_agent_battle_p2p_positions_battle_id"
        ON "agent_battle_p2p_positions" ("battle_id");
      CREATE INDEX IF NOT EXISTS "idx_agent_battle_p2p_positions_round_id"
        ON "agent_battle_p2p_positions" ("round_id");
      CREATE INDEX IF NOT EXISTS "idx_agent_battle_p2p_positions_escrow_status"
        ON "agent_battle_p2p_positions" ("escrow_status");
      CREATE INDEX IF NOT EXISTS "idx_agent_battle_p2p_positions_updated_at"
        ON "agent_battle_p2p_positions" ("updated_at");
      ALTER TABLE "agent_battle_p2p_positions"
        ADD COLUMN IF NOT EXISTS "escrow_challenge_id" integer;
      ALTER TABLE "agent_battle_p2p_positions"
        ADD COLUMN IF NOT EXISTS "escrow_chain_id" integer;
      ALTER TABLE "agent_battle_p2p_positions"
        ADD COLUMN IF NOT EXISTS "escrow_token_symbol" varchar(16);
      ALTER TABLE "agent_battle_p2p_positions"
        ADD COLUMN IF NOT EXISTS "wallet_address" varchar(128);
      ALTER TABLE "agent_battle_p2p_positions"
        ADD COLUMN IF NOT EXISTS "escrow_tx_hash" varchar(80);
      ALTER TABLE "agent_battle_p2p_positions"
        ADD COLUMN IF NOT EXISTS "winner_side_id" text;
      ALTER TABLE "agent_battle_p2p_positions"
        ADD COLUMN IF NOT EXISTS "payout_amount" numeric(18, 6);
      ALTER TABLE "agent_battle_p2p_positions"
        ADD COLUMN IF NOT EXISTS "payout_tx_hash" varchar(80);
      ALTER TABLE "agent_battle_p2p_rounds"
        ADD COLUMN IF NOT EXISTS "settlement_status" varchar(32) NOT NULL DEFAULT 'open';
      ALTER TABLE "agent_battle_p2p_rounds"
        ADD COLUMN IF NOT EXISTS "winner_side_id" text;
      ALTER TABLE "agent_battle_p2p_rounds"
        ADD COLUMN IF NOT EXISTS "settlement_tx_hashes" jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE "agent_battle_p2p_rounds"
        ADD COLUMN IF NOT EXISTS "settlement_error" text;
      ALTER TABLE "agent_battle_p2p_rounds"
        ADD COLUMN IF NOT EXISTS "settled_at" timestamp;
    `).then(() => undefined);
  }
  return ensureTablePromise;
}

async function getOrCreateBattleP2PRound(input: {
  battle: BantahBroAgentBattle;
  roundId: string;
  stakeCurrency?: string | null;
}) {
  const existing = await db
    .select()
    .from(agentBattleP2PRounds)
    .where(eq(agentBattleP2PRounds.roundId, input.roundId))
    .limit(1);
  if (existing[0]?.escrowChallengeId) {
    return existing[0];
  }

  const defaults = resolveBattleEscrowDefaults({ stakeCurrency: input.stakeCurrency });
  if (!defaults.chainId || !defaults.tokenSymbol) {
    const error = new Error("Battle escrow chain/token is not configured");
    (error as { status?: number }).status = 503;
    throw error;
  }

  const now = new Date();
  const inserted = await db
    .insert(agentBattleP2PRounds)
    .values({
      battleId: input.battle.id,
      roundId: input.roundId,
      roundStartsAt: new Date(input.battle.startsAt),
      roundEndsAt: new Date(input.battle.endsAt),
      escrowChainId: defaults.chainId,
      escrowTokenSymbol: defaults.tokenSymbol,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: agentBattleP2PRounds.roundId })
    .returning();

  const createdOrExisting =
    inserted[0] ||
    (
      await db
        .select()
        .from(agentBattleP2PRounds)
        .where(eq(agentBattleP2PRounds.roundId, input.roundId))
        .limit(1)
    )[0];

  if (!createdOrExisting) {
    throw new Error("Unable to reserve battle escrow round");
  }

  const escrowChallengeId =
    createdOrExisting.escrowChallengeId || BATTLE_ESCROW_ID_OFFSET + Number(createdOrExisting.id);

  const [updated] = await db
    .update(agentBattleP2PRounds)
    .set({
      escrowChallengeId,
      updatedAt: now,
    })
    .where(eq(agentBattleP2PRounds.id, createdOrExisting.id))
    .returning();

  return updated || createdOrExisting;
}

function hydratePosition(
  row: typeof agentBattleP2PPositions.$inferSelect,
): AgentBattleP2PPosition {
  return {
    id: row.id,
    userId: row.userId,
    battleId: row.battleId,
    roundId: row.roundId,
    roundStartsAt: toIsoString(row.roundStartsAt),
    roundEndsAt: toIsoString(row.roundEndsAt),
    sideId: row.sideId,
    sideLabel: row.sideLabel,
    sideSymbol: row.sideSymbol,
    sideLogoUrl: row.sideLogoUrl,
    opponentSideId: row.opponentSideId,
    stakeAmount: toNumber(row.stakeAmount),
    stakeCurrency: (row.stakeCurrency || "BXBT") as AgentBattleP2PPosition["stakeCurrency"],
    escrowChallengeId: row.escrowChallengeId ?? null,
    escrowChainId: row.escrowChainId ?? null,
    escrowTokenSymbol: isOnchainTokenSymbol(row.escrowTokenSymbol) ? row.escrowTokenSymbol : null,
    walletAddress: row.walletAddress,
    escrowStatus: row.escrowStatus,
    escrowTxHash: row.escrowTxHash,
    winnerSideId: row.winnerSideId,
    payoutAmount: row.payoutAmount === null ? null : toNumber(row.payoutAmount),
    payoutTxHash: row.payoutTxHash,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

async function getLiveBattle(battleId: string) {
  const normalizedBattleId = String(battleId || "").trim();
  if (!normalizedBattleId) {
    throw new Error("Battle ID is required");
  }

  const feed = await getLiveBantahBroAgentBattles(40);
  const battle = feed.battles.find((candidate) => candidate.id === normalizedBattleId);
  if (!battle) {
    const error = new Error("Agent Battle is not in the current live round");
    (error as { status?: number }).status = 404;
    throw error;
  }
  return battle;
}

function buildSnapshot(battle: BantahBroAgentBattle, side: BantahBroAgentBattleSide) {
  const opponent = battle.sides.find((candidate) => candidate.id !== side.id) || null;
  const serializeSide = (candidate: BantahBroAgentBattleSide) => ({
    id: candidate.id,
    label: candidate.label,
    agentName: candidate.agentName,
    tokenSymbol: candidate.tokenSymbol,
    tokenName: candidate.tokenName,
    emoji: candidate.emoji,
    logoUrl: candidate.logoUrl,
    chainId: candidate.chainId,
    chainLabel: candidate.chainLabel,
    tokenAddress: candidate.tokenAddress,
    pairAddress: candidate.pairAddress,
    pairUrl: candidate.pairUrl,
    dexId: candidate.dexId,
    priceUsd: candidate.priceUsd,
    priceDisplay: candidate.priceDisplay,
    priceChangeM5: candidate.priceChangeM5,
    priceChangeH1: candidate.priceChangeH1,
    priceChangeH24: candidate.priceChangeH24,
    change: candidate.change,
    direction: candidate.direction,
    volumeM5: candidate.volumeM5,
    volumeH1: candidate.volumeH1,
    volumeH24: candidate.volumeH24,
    liquidityUsd: candidate.liquidityUsd,
    marketCap: candidate.marketCap,
    buysM5: candidate.buysM5,
    sellsM5: candidate.sellsM5,
    buysH1: candidate.buysH1,
    sellsH1: candidate.sellsH1,
    buysH24: candidate.buysH24,
    sellsH24: candidate.sellsH24,
    pairAgeMinutes: candidate.pairAgeMinutes,
    dataSource: candidate.dataSource,
    dataUpdatedAt: candidate.dataUpdatedAt,
    score: candidate.score,
    confidence: candidate.confidence,
    status: candidate.status,
  });

  return {
    battle: {
      id: battle.id,
      title: battle.title,
      winnerLogic: battle.winnerLogic,
      startsAt: battle.startsAt,
      endsAt: battle.endsAt,
      leadingSideId: battle.leadingSideId,
      updatedAt: battle.updatedAt,
    },
    side: serializeSide(side),
    opponent: opponent ? serializeSide(opponent) : null,
  };
}

function buildPoolFromRows(params: {
  battle: BantahBroAgentBattle;
  rows: Array<typeof agentBattleP2PPositions.$inferSelect>;
  userId?: string | null;
  round?: typeof agentBattleP2PRounds.$inferSelect | null;
}): AgentBattleP2PPool {
  const { battle, rows, userId, round } = params;
  const roundId = makeRoundId(battle);
  const activeRows = rows.filter(
    (row) => row.escrowStatus !== "cancelled" && row.escrowStatus !== "failed",
  );
  const [left, right] = battle.sides;
  const sideRows = new Map<string, Array<typeof agentBattleP2PPositions.$inferSelect>>([
    [left.id, []],
    [right.id, []],
  ]);

  for (const row of activeRows) {
    if (!sideRows.has(row.sideId)) continue;
    sideRows.get(row.sideId)?.push(row);
  }

  const sideTotals = battle.sides.map((side) => {
    const entries = sideRows.get(side.id) || [];
    return {
      side,
      totalStake: entries.reduce((sum, row) => sum + toNumber(row.stakeAmount), 0),
      bettorCount: entries.length,
    };
  }) as [
    { side: BantahBroAgentBattleSide; totalStake: number; bettorCount: number },
    { side: BantahBroAgentBattleSide; totalStake: number; bettorCount: number },
  ];
  const totalStake = sideTotals.reduce((sum, item) => sum + item.totalStake, 0);
  const userRow = userId ? activeRows.find((row) => row.userId === userId) : null;
  const escrowLocked = activeRows.length > 0 && activeRows.every((row) => row.escrowStatus === "escrow_locked");
  const escrowDefaults = resolveBattleEscrowDefaults({
    stakeCurrency: round?.escrowTokenSymbol || rows[0]?.escrowTokenSymbol,
    chainId: round?.escrowChainId || rows[0]?.escrowChainId,
  });
  const escrowTokenSymbol = isOnchainTokenSymbol(round?.escrowTokenSymbol)
    ? round.escrowTokenSymbol
    : escrowDefaults.tokenSymbol;
  const now = Date.now();
  const endsAtMs = new Date(battle.endsAt).getTime();
  const status = Number.isFinite(endsAtMs) && endsAtMs > now ? "betting_open" : "closed";

  return {
    battleId: battle.id,
    roundId,
    roundStartsAt: battle.startsAt,
    roundEndsAt: battle.endsAt,
    status,
    stakeCurrency: (escrowTokenSymbol || "USDC") as AgentBattleP2PPool["stakeCurrency"],
    escrowMode: escrowLocked
      ? "escrow_locked"
      : escrowDefaults.contractEnabled && escrowDefaults.supportsChallengeLock
        ? "contract_escrow"
        : "intent_tracking",
    escrowChallengeId: round?.escrowChallengeId ?? rows[0]?.escrowChallengeId ?? null,
    escrowChainId: round?.escrowChainId ?? rows[0]?.escrowChainId ?? escrowDefaults.chainId ?? null,
    escrowTokenSymbol,
    totalStake,
    positionCount: activeRows.length,
    sides: sideTotals.map(({ side, totalStake: sideStake, bettorCount }) => ({
      sideId: side.id,
      label: side.label,
      tokenSymbol: side.tokenSymbol,
      logoUrl: side.logoUrl,
      confidence: side.confidence,
      totalStake: sideStake,
      bettorCount,
      sharePercent: totalStake > 0 ? Math.round((sideStake / totalStake) * 100) : side.confidence,
    })) as AgentBattleP2PPool["sides"],
    userPosition: userRow ? hydratePosition(userRow) : null,
    updatedAt: new Date().toISOString(),
    message:
      escrowDefaults.contractEnabled && escrowDefaults.supportsChallengeLock
        ? "P2P battle stakes lock through the existing Bantah onchain escrow contract for this 3-minute round."
        : "Battle escrow needs the existing Bantah V2 challenge-lock contract before real staking.",
  };
}

export async function getAgentBattleP2PPool(input: {
  battleId: string;
  userId?: string | null;
}): Promise<AgentBattleP2PPool> {
  await ensureAgentBattleP2PPositionsTable();
  const battle = await getLiveBattle(input.battleId);
  const roundId = makeRoundId(battle);
  const round = await getOrCreateBattleP2PRound({ battle, roundId });
  const rows = await db
    .select()
    .from(agentBattleP2PPositions)
    .where(eq(agentBattleP2PPositions.roundId, roundId))
    .orderBy(desc(agentBattleP2PPositions.updatedAt));

  return buildPoolFromRows({ battle, rows, userId: input.userId, round });
}

export async function placeAgentBattleP2PStake(input: {
  userId: string;
  battleId: string;
  sideId: string;
  stakeAmount: number;
  walletAddress?: string | null;
  stakeCurrency?: AgentBattleP2PPosition["stakeCurrency"];
}): Promise<AgentBattleP2PStakeResponse> {
  await ensureAgentBattleP2PPositionsTable();
  const battle = await getLiveBattle(input.battleId);
  const now = new Date();
  const endsAtMs = new Date(battle.endsAt).getTime();
  if (!Number.isFinite(endsAtMs) || endsAtMs <= now.getTime()) {
    const error = new Error("This Agent Battle round is closed");
    (error as { status?: number }).status = 409;
    throw error;
  }

  const stakeAmount = Number(input.stakeAmount);
  if (!Number.isFinite(stakeAmount) || stakeAmount <= 0) {
    throw new Error("Stake amount must be greater than zero");
  }

  const side = battle.sides.find((candidate) => candidate.id === input.sideId);
  if (!side) {
    throw new Error("Selected battle side is not available in the current round");
  }
  const opponent = battle.sides.find((candidate) => candidate.id !== side.id) || null;
  const roundId = makeRoundId(battle);
  const round = await getOrCreateBattleP2PRound({
    battle,
    roundId,
    stakeCurrency: input.stakeCurrency,
  });
  const escrowTokenSymbol = isOnchainTokenSymbol(round.escrowTokenSymbol)
    ? round.escrowTokenSymbol
    : "USDC";
  const roundStartsAt = new Date(battle.startsAt);
  const roundEndsAt = new Date(battle.endsAt);

  const [row] = await db
    .insert(agentBattleP2PPositions)
    .values({
      userId: input.userId,
      battleId: battle.id,
      roundId,
      roundStartsAt,
      roundEndsAt,
      sideId: side.id,
      sideLabel: side.label,
      sideSymbol: battleSymbol(side),
      sideLogoUrl: side.logoUrl,
      opponentSideId: opponent?.id || null,
      stakeAmount: String(stakeAmount),
      stakeCurrency: escrowTokenSymbol,
      escrowChallengeId: round.escrowChallengeId,
      escrowChainId: round.escrowChainId,
      escrowTokenSymbol,
      walletAddress: input.walletAddress || null,
      escrowStatus: "escrow_required",
      escrowTxHash: null,
      winnerSideId: null,
      payoutAmount: null,
      snapshot: buildSnapshot(battle, side),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [agentBattleP2PPositions.userId, agentBattleP2PPositions.roundId],
      set: {
        sideId: side.id,
        sideLabel: side.label,
        sideSymbol: battleSymbol(side),
        sideLogoUrl: side.logoUrl,
        opponentSideId: opponent?.id || null,
        stakeAmount: String(stakeAmount),
        stakeCurrency: escrowTokenSymbol,
        escrowChallengeId: round.escrowChallengeId,
        escrowChainId: round.escrowChainId,
        escrowTokenSymbol,
        walletAddress: input.walletAddress || null,
        escrowStatus: "escrow_required",
        escrowTxHash: null,
        winnerSideId: null,
        payoutAmount: null,
        snapshot: buildSnapshot(battle, side),
        updatedAt: now,
      },
    })
    .returning();

  const rows = await db
    .select()
    .from(agentBattleP2PPositions)
    .where(eq(agentBattleP2PPositions.roundId, roundId))
    .orderBy(desc(agentBattleP2PPositions.updatedAt));

  return {
    position: hydratePosition(row),
    pool: buildPoolFromRows({ battle, rows, userId: input.userId, round }),
    message:
      `P2P stake ticket reserved. Lock ${stakeAmount.toLocaleString()} ${escrowTokenSymbol} in the existing Bantah escrow contract to activate it.`,
  };
}

export async function markAgentBattleP2PEscrowLocked(input: {
  userId: string;
  positionId: string;
  walletAddress?: string | null;
  escrowTxHash?: string | null;
}): Promise<AgentBattleP2PPosition> {
  await ensureAgentBattleP2PPositionsTable();
  const [existing] = await db
    .select()
    .from(agentBattleP2PPositions)
    .where(
      and(
        eq(agentBattleP2PPositions.id, input.positionId),
        eq(agentBattleP2PPositions.userId, input.userId),
      ),
    )
    .limit(1);

  if (!existing) {
    const error = new Error("P2P battle position not found");
    (error as { status?: number }).status = 404;
    throw error;
  }

  const txHash = input.escrowTxHash || existing.escrowTxHash;
  const wallet = input.walletAddress || existing.walletAddress;
  if (!txHash) {
    throw new Error("escrowTxHash is required to mark this battle stake escrow-locked");
  }
  const normalizedWallet = normalizeEvmAddress(wallet || "");
  if (!normalizedWallet) {
    throw new Error("Wallet address is required to verify battle escrow");
  }
  const config = getOnchainServerConfig();
  const chainId = existing.escrowChainId || config.defaultChainId;
  const chain = config.chains[String(chainId)];
  const escrowContract = normalizeEvmAddress(chain?.escrowContractAddress);
  const tokenSymbol = isOnchainTokenSymbol(existing.escrowTokenSymbol)
    ? existing.escrowTokenSymbol
    : normalizeOnchainTokenSymbol(config.defaultToken || "USDC");

  if (!config.contractEnabled || !chain || !escrowContract || chain.escrowSupportsChallengeLock !== true) {
    const error = new Error("Bantah battle escrow contract is not configured for this round");
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
  const duplicate = await db
    .select()
    .from(agentBattleP2PPositions)
    .where(eq(agentBattleP2PPositions.escrowTxHash, verified.txHash))
    .limit(1);
  if (duplicate[0] && duplicate[0].id !== existing.id) {
    const error = new Error("This escrow transaction hash is already attached to another battle stake");
    (error as { status?: number }).status = 409;
    throw error;
  }

  const [row] = await db
    .update(agentBattleP2PPositions)
    .set({
      walletAddress: verified.from,
      escrowTxHash: verified.txHash,
      escrowStatus: "escrow_locked",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentBattleP2PPositions.id, input.positionId),
        eq(agentBattleP2PPositions.userId, input.userId),
      ),
    )
    .returning();

  return hydratePosition(row);
}

function compareStakeRows(
  left: typeof agentBattleP2PPositions.$inferSelect,
  right: typeof agentBattleP2PPositions.$inferSelect,
) {
  const createdDiff =
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
  return String(left.id).localeCompare(String(right.id));
}

function calculatePairPayout(
  winner: typeof agentBattleP2PPositions.$inferSelect,
  loser: typeof agentBattleP2PPositions.$inferSelect,
) {
  // Current BantahEscrowV2 charges fee only from the losing stake. The default
  // deployed contract fee is expected onchain, but UI/admin accounting should
  // not block if fee config changes. Store gross expected payout here; the
  // onchain event remains the source of truth for exact fee-adjusted payout.
  return toNumber(winner.stakeAmount) + toNumber(loser.stakeAmount);
}

type SettlementSnapshotSide = {
  id: string;
  label: string | null;
  tokenSymbol: string | null;
  tokenName: string | null;
  logoUrl: string | null;
  chainId: string | null;
  chainLabel: string | null;
  tokenAddress: string | null;
  pairAddress: string | null;
  pairUrl: string | null;
  dexId: string | null;
  priceUsd: number | null;
  priceChangeM5: number;
  priceChangeH1: number;
  priceChangeH24: number;
  volumeM5: number;
  volumeH1: number;
  volumeH24: number;
  liquidityUsd: number;
  buysM5: number;
  sellsM5: number;
  buysH1: number;
  sellsH1: number;
  buysH24: number;
  sellsH24: number;
  score: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSettlementSnapshotSide(value: unknown): SettlementSnapshotSide | null {
  const record = asRecord(value);
  const id = stringOrNull(record.id);
  if (!id) return null;

  return {
    id,
    label: stringOrNull(record.label),
    tokenSymbol: stringOrNull(record.tokenSymbol),
    tokenName: stringOrNull(record.tokenName),
    logoUrl: stringOrNull(record.logoUrl),
    chainId: stringOrNull(record.chainId),
    chainLabel: stringOrNull(record.chainLabel),
    tokenAddress: stringOrNull(record.tokenAddress),
    pairAddress: stringOrNull(record.pairAddress),
    pairUrl: stringOrNull(record.pairUrl),
    dexId: stringOrNull(record.dexId),
    priceUsd: numberOrNull(record.priceUsd),
    priceChangeM5: toNumber(record.priceChangeM5),
    priceChangeH1: toNumber(record.priceChangeH1),
    priceChangeH24: toNumber(record.priceChangeH24),
    volumeM5: toNumber(record.volumeM5),
    volumeH1: toNumber(record.volumeH1),
    volumeH24: toNumber(record.volumeH24),
    liquidityUsd: toNumber(record.liquidityUsd),
    buysM5: toNumber(record.buysM5),
    sellsM5: toNumber(record.sellsM5),
    buysH1: toNumber(record.buysH1),
    sellsH1: toNumber(record.sellsH1),
    buysH24: toNumber(record.buysH24),
    sellsH24: toNumber(record.sellsH24),
    score: toNumber(record.score, 1),
  };
}

function collectRoundSettlementSides(rows: Array<typeof agentBattleP2PPositions.$inferSelect>) {
  const byId = new Map<string, SettlementSnapshotSide>();

  for (const row of rows) {
    const snapshot = asRecord(row.snapshot);
    const side = normalizeSettlementSnapshotSide(snapshot.side);
    const opponent = normalizeSettlementSnapshotSide(snapshot.opponent);
    if (side) byId.set(side.id, side);
    if (opponent) byId.set(opponent.id, opponent);

    if (!side && row.sideId) {
      byId.set(row.sideId, {
        id: row.sideId,
        label: row.sideLabel,
        tokenSymbol: row.sideSymbol,
        tokenName: null,
        logoUrl: row.sideLogoUrl,
        chainId: null,
        chainLabel: null,
        tokenAddress: null,
        pairAddress: null,
        pairUrl: null,
        dexId: null,
        priceUsd: null,
        priceChangeM5: 0,
        priceChangeH1: 0,
        priceChangeH24: 0,
        volumeM5: 0,
        volumeH1: 0,
        volumeH24: 0,
        liquidityUsd: 0,
        buysM5: 0,
        sellsM5: 0,
        buysH1: 0,
        sellsH1: 0,
        buysH24: 0,
        sellsH24: 0,
        score: 1,
      });
    }
  }

  return Array.from(byId.values());
}

function pairToSettlementSide(
  side: SettlementSnapshotSide,
  pair: BantahBroPairSnapshot,
): SettlementSnapshotSide {
  return {
    ...side,
    label: pair.baseToken.symbol ? `$${pair.baseToken.symbol}` : side.label,
    tokenSymbol: pair.baseToken.symbol || side.tokenSymbol,
    tokenName: pair.baseToken.name || side.tokenName,
    logoUrl: pair.imageUrl || side.logoUrl,
    chainId: pair.chainId || side.chainId,
    tokenAddress: pair.baseToken.address || side.tokenAddress,
    pairAddress: pair.pairAddress || side.pairAddress,
    pairUrl: pair.url || side.pairUrl,
    dexId: pair.dexId || side.dexId,
    priceUsd: pair.priceUsd,
    priceChangeM5: pair.priceChange.m5,
    priceChangeH1: pair.priceChange.h1,
    priceChangeH24: pair.priceChange.h24,
    volumeM5: pair.volume.m5,
    volumeH1: pair.volume.h1,
    volumeH24: pair.volume.h24,
    liquidityUsd: pair.liquidityUsd,
    buysM5: pair.txns.m5.buys,
    sellsM5: pair.txns.m5.sells,
    buysH1: pair.txns.h1.buys,
    sellsH1: pair.txns.h1.sells,
    buysH24: pair.txns.h24.buys,
    sellsH24: pair.txns.h24.sells,
  };
}

async function refreshSettlementSideFromDexscreener(
  side: SettlementSnapshotSide,
): Promise<SettlementSnapshotSide> {
  if (!side.chainId || !side.tokenAddress) {
    throw new Error(`Cannot resolve ${side.label || side.id}: missing Dexscreener token reference`);
  }

  const rawPairs = await fetchDexScreenerTokenPairs({
    chainId: side.chainId,
    tokenAddress: side.tokenAddress,
  });
  const pairs = rawPairs
    .map(normalizePair)
    .filter((pair) => pair.chainId && pair.pairAddress);
  const preferredPair = side.pairAddress
    ? pairs.find(
        (pair) => pair.pairAddress.toLowerCase() === side.pairAddress?.toLowerCase(),
      )
    : null;
  const pair = preferredPair || choosePrimaryPair(pairs);
  if (!pair) {
    throw new Error(`Cannot resolve ${side.label || side.id}: no live Dexscreener pair found`);
  }

  const refreshed = pairToSettlementSide(side, pair);
  return {
    ...refreshed,
    score: calculateSettlementSideScore(refreshed),
  };
}

function buyPressurePercent(side: SettlementSnapshotSide) {
  const m5Trades = side.buysM5 + side.sellsM5;
  if (m5Trades > 0) return (side.buysM5 / m5Trades) * 100;
  const h1Trades = side.buysH1 + side.sellsH1;
  if (h1Trades > 0) return (side.buysH1 / h1Trades) * 100;
  const h24Trades = side.buysH24 + side.sellsH24;
  if (h24Trades > 0) return (side.buysH24 / h24Trades) * 100;
  return 50;
}

function calculateSettlementSideScore(side: SettlementSnapshotSide) {
  const change = side.priceChangeM5 * 1.5 + side.priceChangeH1 * 0.85 + side.priceChangeH24 * 0.35;
  const volume = side.volumeM5 * 18 + side.volumeH1 * 4 + side.volumeH24;
  const shortTrades = side.buysM5 + side.sellsM5;
  const h1Trades = side.buysH1 + side.sellsH1;
  const buyRatio =
    shortTrades > 0
      ? side.buysM5 / shortTrades
      : h1Trades > 0
        ? side.buysH1 / h1Trades
        : 0.5;
  const momentumScore = Math.max(0, Math.min(110, 50 + change * 1.15));
  const volumeScore = Math.max(0, Math.min(42, Math.log10(volume + 1) * 6));
  const liquidityScore = Math.max(0, Math.min(28, Math.log10(side.liquidityUsd + 1) * 4));
  const buyPressureScore = Math.max(
    -18,
    Math.min(24, (buyRatio - 0.5) * 38 + Math.log10(shortTrades + h1Trades + 1) * 3),
  );
  return Math.max(1, Math.round(momentumScore + volumeScore + liquidityScore + buyPressureScore));
}

function settlementWinnerMetric(rule: string, side: SettlementSnapshotSide) {
  const normalizedRule = rule.toLowerCase();
  if (normalizedRule.includes("buy pressure")) return buyPressurePercent(side);
  if (normalizedRule.includes("volume")) return side.volumeM5 || side.volumeH1 || side.volumeH24;
  if (normalizedRule.includes("liquidity")) return side.liquidityUsd;
  if (normalizedRule.includes("price")) {
    return side.priceChangeM5 || side.priceChangeH1 || side.priceChangeH24;
  }
  return side.score || calculateSettlementSideScore(side);
}

function resolveSnapshotWinnerLogic(rows: Array<typeof agentBattleP2PPositions.$inferSelect>) {
  for (const row of rows) {
    const battle = asRecord(asRecord(row.snapshot).battle);
    const winnerLogic = stringOrNull(battle.winnerLogic);
    if (winnerLogic) return winnerLogic;
  }
  return "Hybrid live score";
}

function normalizeRoundSettlementStatus(value: unknown): AgentBattleP2PHistoryPosition["settlementStatus"] {
  return value === "open" ||
    value === "settling" ||
    value === "settled" ||
    value === "partially_settled" ||
    value === "settlement_failed"
    ? value
    : null;
}

function getHistoryBattleTitle(row: typeof agentBattleP2PPositions.$inferSelect) {
  const snapshot = asRecord(row.snapshot);
  const battle = asRecord(snapshot.battle);
  const snapshotTitle = stringOrNull(battle.title);
  if (snapshotTitle) return snapshotTitle;

  const opponent = asRecord(snapshot.opponent);
  const opponentLabel = stringOrNull(opponent.label) || stringOrNull(opponent.tokenSymbol);
  if (row.sideLabel && opponentLabel) {
    return `${row.sideLabel} vs ${opponentLabel}`;
  }
  if (row.sideLabel) {
    return row.sideLabel;
  }
  return "Agent Battle";
}

function getSnapshotOpponentDetails(row: typeof agentBattleP2PPositions.$inferSelect) {
  const snapshot = asRecord(row.snapshot);
  const opponent = asRecord(snapshot.opponent);
  return {
    label: stringOrNull(opponent.label),
    symbol: stringOrNull(opponent.tokenSymbol),
    logoUrl: stringOrNull(opponent.logoUrl),
  };
}

function resolveHistoryResultStatus(params: {
  position: typeof agentBattleP2PPositions.$inferSelect;
  settlementStatus: AgentBattleP2PHistoryPosition["settlementStatus"];
  nowMs: number;
}): AgentBattleP2PHistoryPosition["resultStatus"] {
  const { position, settlementStatus, nowMs } = params;
  const roundEnded = roundEndedAtOrBeforeNow(position.roundEndsAt, nowMs);

  if (position.escrowStatus === "cancelled") return "cancelled";
  if (position.escrowStatus === "failed" || settlementStatus === "settlement_failed") return "failed";
  if (position.escrowStatus === "settled") {
    return position.winnerSideId === position.sideId ? "won" : "lost";
  }
  if (position.escrowStatus === "intent_saved" || position.escrowStatus === "escrow_required") {
    return "needs_escrow";
  }
  if (position.escrowStatus === "escrow_locked") {
    if (!roundEnded) return "live";
    if (settlementStatus === "partially_settled") return "unmatched";
    if (settlementStatus === "settled" && position.winnerSideId) {
      return position.winnerSideId === position.sideId ? "won" : "lost";
    }
    return "awaiting_settlement";
  }
  return roundEnded ? "awaiting_settlement" : "live";
}

function hydrateHistoryPosition(
  row: typeof agentBattleP2PPositions.$inferSelect,
  round?: typeof agentBattleP2PRounds.$inferSelect | null,
): AgentBattleP2PHistoryPosition {
  const base = hydratePosition(row);
  const opponent = getSnapshotOpponentDetails(row);
  const settlementStatus = normalizeRoundSettlementStatus(round?.settlementStatus);
  const didWin =
    row.winnerSideId && row.escrowStatus === "settled"
      ? row.winnerSideId === row.sideId
      : null;
  const winningPayoutAmount = row.payoutAmount === null ? null : toNumber(row.payoutAmount);
  const earnedAmount =
    didWin === null
      ? null
      : didWin
        ? winningPayoutAmount
        : 0;
  const resultStatus = resolveHistoryResultStatus({
    position: row,
    settlementStatus,
    nowMs: Date.now(),
  });

  return {
    ...base,
    battleTitle: getHistoryBattleTitle(row),
    opponentSideLabel: opponent.label,
    opponentSideSymbol: opponent.symbol,
    opponentSideLogoUrl: opponent.logoUrl,
    settlementStatus,
    settlementError: stringOrNull(round?.settlementError),
    settledAt: round?.settledAt ? toIsoString(round.settledAt) : null,
    resultStatus,
    didWin,
    earnedAmount,
    winningPayoutAmount,
  };
}

export async function listAgentBattleP2PHistoryPositions(
  userId: string,
  limit = 20,
): Promise<AgentBattleP2PHistoryPosition[]> {
  await ensureAgentBattleP2PPositionsTable();
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return [];

  const rows = await db
    .select({
      position: agentBattleP2PPositions,
      round: agentBattleP2PRounds,
    })
    .from(agentBattleP2PPositions)
    .leftJoin(
      agentBattleP2PRounds,
      eq(agentBattleP2PRounds.roundId, agentBattleP2PPositions.roundId),
    )
    .where(eq(agentBattleP2PPositions.userId, normalizedUserId))
    .orderBy(desc(agentBattleP2PPositions.updatedAt), desc(agentBattleP2PPositions.createdAt))
    .limit(Math.max(1, Math.min(Number(limit || 20), 100)));

  return rows.map(({ position, round }) => hydrateHistoryPosition(position, round));
}

type AgentBattleLeaderboardEntry = {
  userId: string;
  name: string;
  handle: string | null;
  profileImageUrl: string | null;
  score: number;
  wins: number;
  balance: number;
  balanceDisplay: string;
  points: number;
  coins: number;
  challengesWon: number;
  eventsWon: number;
  battleJoins: number;
  liveBattles: number;
  totalStake: number;
  stakeDisplay: string;
  currentBattleTitle: string | null;
  activeSideLabel: string | null;
};

function compactAmount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K`;
  return value.toLocaleString(undefined, {
    maximumFractionDigits: value >= 100 ? 0 : 2,
  });
}

function userDisplayName(rowUser: typeof users.$inferSelect | null, userId: string) {
  const name =
    rowUser?.username ||
    [rowUser?.firstName, rowUser?.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  const compactId = userId.replace(/^did:privy:/, "").replace(/^user[-_:]/i, "");
  return compactId ? `user_${compactId.slice(0, 8)}` : "Arena user";
}

function stakeStatusWeight(status: AgentBattleP2PPosition["escrowStatus"]) {
  if (status === "settled") return 1.25;
  if (status === "escrow_locked") return 1;
  if (status === "escrow_required" || status === "intent_saved") return 0.35;
  return 0;
}

function buildLiveBattleSideLeaderboard(
  liveBattles: BantahBroAgentBattle[],
  limit: number,
): AgentBattleLeaderboardEntry[] {
  return liveBattles
    .flatMap((battle) =>
      battle.sides.map((side) => ({
        userId: `agent:${battle.id}:${side.id}`,
        name: side.agentName || side.label,
        handle: side.tokenSymbol ? `$${side.tokenSymbol}` : null,
        profileImageUrl: side.logoUrl,
        score: Math.round(side.score + side.confidence + (battle.leadingSideId === side.id ? 25 : 0)),
        wins: battle.leadingSideId === side.id ? 1 : 0,
        balance: side.confidence,
        balanceDisplay: `${side.confidence}% confidence`,
        points: Math.round(side.score),
        coins: 0,
        challengesWon: 0,
        eventsWon: battle.leadingSideId === side.id ? 1 : 0,
        battleJoins: 0,
        liveBattles: 1,
        totalStake: 0,
        stakeDisplay: `${side.confidence}% confidence`,
        currentBattleTitle: battle.title,
        activeSideLabel: side.label,
      })),
    )
    .sort((left, right) => right.score - left.score || right.wins - left.wins)
    .slice(0, limit);
}

export async function getLiveAgentBattleLeaderboard(limit = 25): Promise<{
  entries: AgentBattleLeaderboardEntry[];
  updatedAt: string;
  activeBattleCount: number;
}> {
  const requestedLimit = Math.max(1, Math.min(Math.round(limit || 25), 100));
  const liveFeed = await getLiveBantahBroAgentBattles(40);
  const liveBattles = liveFeed.battles.filter((battle) => {
    const endsAtMs = new Date(battle.endsAt).getTime();
    return Number.isFinite(endsAtMs) && endsAtMs > Date.now();
  });
  const liveRoundIds = new Set(liveBattles.map((battle) => makeRoundId(battle)));
  const battleTitleById = new Map(liveFeed.battles.map((battle) => [battle.id, battle.title]));

  let rows: Array<{
    position: typeof agentBattleP2PPositions.$inferSelect;
    user: typeof users.$inferSelect | null;
  }>;
  try {
    await ensureAgentBattleP2PPositionsTable();
    rows = await db
      .select({
        position: agentBattleP2PPositions,
        user: users,
      })
      .from(agentBattleP2PPositions)
      .leftJoin(users, eq(users.id, agentBattleP2PPositions.userId))
      .orderBy(desc(agentBattleP2PPositions.updatedAt), desc(agentBattleP2PPositions.createdAt))
      .limit(Math.max(250, requestedLimit * 20));
  } catch {
    return {
      entries: [],
      updatedAt: new Date().toISOString(),
      activeBattleCount: liveBattles.length,
    };
  }

  const entriesByUser = new Map<string, AgentBattleLeaderboardEntry & { latestUpdatedAt: number }>();

  for (const { position, user } of rows) {
    if (position.escrowStatus === "cancelled" || position.escrowStatus === "failed") continue;

    const stakeAmount = toNumber(position.stakeAmount);
    const weightedStake = stakeAmount * stakeStatusWeight(position.escrowStatus);
    const didWin = position.escrowStatus === "settled" && position.winnerSideId === position.sideId;
    const isLive = liveRoundIds.has(position.roundId);
    const updatedAtMs = new Date(position.updatedAt).getTime();
    const currency = position.escrowTokenSymbol || position.stakeCurrency || "USDC";
    const existing = entriesByUser.get(position.userId);
    const userBantCredits = Math.max(0, Math.round(Number(user?.points || 0)));
    const entry =
      existing ||
      ({
        userId: position.userId,
        name: userDisplayName(user, position.userId),
        handle: user?.username ? `@${user.username}` : null,
        profileImageUrl: user?.profileImageUrl || null,
        score: userBantCredits,
        wins: 0,
        balance: 0,
        balanceDisplay: "0 stake",
        points: userBantCredits,
        coins: 0,
        challengesWon: 0,
        eventsWon: 0,
        battleJoins: 0,
        liveBattles: 0,
        totalStake: 0,
        stakeDisplay: "0 stake",
        currentBattleTitle: null,
        activeSideLabel: null,
        latestUpdatedAt: 0,
      } satisfies AgentBattleLeaderboardEntry & { latestUpdatedAt: number });

    entry.battleJoins += 1;
    entry.liveBattles += isLive ? 1 : 0;
    entry.totalStake += stakeAmount;
    entry.balance += toNumber(position.payoutAmount) + weightedStake;
    entry.wins += didWin ? 1 : 0;
    entry.eventsWon = entry.wins;
    entry.score += Math.round(weightedStake + (didWin ? 500 : 0) + (isLive ? 50 : 0) + 15);
    entry.points = userBantCredits;
    entry.coins = 0;

    if (!existing || (Number.isFinite(updatedAtMs) && updatedAtMs >= entry.latestUpdatedAt)) {
      entry.latestUpdatedAt = Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now();
      entry.currentBattleTitle = battleTitleById.get(position.battleId) || getHistoryBattleTitle(position);
      entry.activeSideLabel = position.sideLabel || position.sideSymbol || null;
      entry.stakeDisplay = `${compactAmount(entry.totalStake)} ${currency}`;
      entry.balanceDisplay = `${compactAmount(entry.balance)} ${currency}`;
    } else {
      entry.stakeDisplay = `${compactAmount(entry.totalStake)} ${currency}`;
      entry.balanceDisplay = `${compactAmount(entry.balance)} ${currency}`;
    }

    entriesByUser.set(position.userId, entry);
  }

  const entries = Array.from(entriesByUser.values())
    .sort((left, right) => {
      if (right.liveBattles !== left.liveBattles) return right.liveBattles - left.liveBattles;
      if (right.score !== left.score) return right.score - left.score;
      if (right.wins !== left.wins) return right.wins - left.wins;
      return right.balance - left.balance;
    })
    .slice(0, requestedLimit)
    .map(({ latestUpdatedAt: _latestUpdatedAt, ...entry }) => entry);

  return {
    entries,
    updatedAt: new Date().toISOString(),
    activeBattleCount: liveBattles.length,
  };
}

export async function resolveAgentBattleP2PRoundWinner(input: {
  roundId: string;
  preloadedRows?: Array<typeof agentBattleP2PPositions.$inferSelect>;
}): Promise<{
  roundId: string;
  winnerSideId: string;
  winner: SettlementSnapshotSide;
  loser: SettlementSnapshotSide;
  winnerMetric: number;
  loserMetric: number;
  winnerLogic: string;
}> {
  await ensureAgentBattleP2PPositionsTable();
  const roundId = String(input.roundId || "").trim();
  if (!roundId) throw new Error("roundId is required");

  const rows =
    input.preloadedRows ||
    (await db
      .select()
      .from(agentBattleP2PPositions)
      .where(
        and(
          eq(agentBattleP2PPositions.roundId, roundId),
          eq(agentBattleP2PPositions.escrowStatus, "escrow_locked"),
        ),
      )
      .orderBy(asc(agentBattleP2PPositions.createdAt)));

  if (rows.length === 0) {
    throw new Error("No escrow-locked battle positions are available for settlement");
  }

  const sides = collectRoundSettlementSides(rows);
  if (sides.length < 2) {
    throw new Error("Battle round needs two Dexscreener-backed sides before settlement");
  }

  const [left, right] = await Promise.all([
    refreshSettlementSideFromDexscreener(sides[0]),
    refreshSettlementSideFromDexscreener(sides[1]),
  ]);
  const winnerLogic = resolveSnapshotWinnerLogic(rows);
  let leftMetric = settlementWinnerMetric(winnerLogic, left);
  let rightMetric = settlementWinnerMetric(winnerLogic, right);

  if (leftMetric === rightMetric) {
    leftMetric = left.score || calculateSettlementSideScore(left);
    rightMetric = right.score || calculateSettlementSideScore(right);
  }
  if (leftMetric === rightMetric) {
    leftMetric = left.liquidityUsd;
    rightMetric = right.liquidityUsd;
  }

  const leftWins = leftMetric >= rightMetric;
  const winner = leftWins ? left : right;
  const loser = leftWins ? right : left;

  return {
    roundId,
    winnerSideId: winner.id,
    winner,
    loser,
    winnerMetric: leftWins ? leftMetric : rightMetric,
    loserMetric: leftWins ? rightMetric : leftMetric,
    winnerLogic,
  };
}

function clampSettlementValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function settlementSideSymbol(side: SettlementSnapshotSide) {
  return (
    side.tokenSymbol ||
    side.label?.replace(/^\$/, "") ||
    side.tokenName ||
    side.id.split(":").slice(-1)[0] ||
    "BOTA"
  )
    .replace(/^\$/, "")
    .trim()
    .slice(0, 32) || "BOTA";
}

function settlementSideConfidence(
  side: SettlementSnapshotSide,
  opponent: SettlementSnapshotSide,
) {
  const sideScore = Math.max(1, side.score || calculateSettlementSideScore(side));
  const opponentScore = Math.max(1, opponent.score || calculateSettlementSideScore(opponent));
  return clampSettlementValue(Math.round((sideScore / (sideScore + opponentScore)) * 100), 1, 99);
}

function settlementSideStatus(confidence: number): BantahBroAgentBattleSide["status"] {
  if (confidence >= 58) return "attacking";
  if (confidence <= 42) return "staggered";
  return "holding";
}

function settlementSideToAgentBattleSide(
  side: SettlementSnapshotSide,
  opponent: SettlementSnapshotSide,
): BantahBroAgentBattleSide {
  const symbol = settlementSideSymbol(side);
  const confidence = settlementSideConfidence(side, opponent);
  const direction =
    side.priceChangeH24 > 0
      ? "up"
      : side.priceChangeH24 < 0
        ? "down"
        : ("flat" as const);
  const priceDisplay =
    side.priceUsd && side.priceUsd > 0
      ? `$${side.priceUsd.toFixed(side.priceUsd >= 1 ? 4 : 8).replace(/0+$/, "").replace(/\.$/, "")}`
      : "n/a";

  return {
    id: side.id,
    label: side.label || `$${symbol}`,
    agentName: `${symbol} Agent`,
    tokenSymbol: side.tokenSymbol || symbol,
    tokenName: side.tokenName,
    emoji: "BOTA",
    logoUrl: side.logoUrl,
    chainId: side.chainId,
    chainLabel: side.chainLabel,
    tokenAddress: side.tokenAddress,
    pairAddress: side.pairAddress,
    pairUrl: side.pairUrl,
    dexId: side.dexId,
    priceUsd: side.priceUsd,
    priceDisplay,
    priceChangeM5: side.priceChangeM5,
    priceChangeH1: side.priceChangeH1,
    priceChangeH24: side.priceChangeH24,
    change: `${side.priceChangeH24 >= 0 ? "+" : ""}${side.priceChangeH24.toFixed(1)}%`,
    direction,
    volumeM5: side.volumeM5,
    volumeH1: side.volumeH1,
    volumeH24: side.volumeH24,
    liquidityUsd: side.liquidityUsd,
    marketCap: null,
    buysM5: side.buysM5,
    sellsM5: side.sellsM5,
    buysH1: side.buysH1,
    sellsH1: side.sellsH1,
    buysH24: side.buysH24,
    sellsH24: side.sellsH24,
    pairAgeMinutes: null,
    dataSource: "dexscreener",
    dataUpdatedAt: new Date().toISOString(),
    score: side.score || calculateSettlementSideScore(side),
    confidence,
    status: settlementSideStatus(confidence),
  };
}

async function refreshSettlementSideForEngine(side: SettlementSnapshotSide) {
  try {
    return await refreshSettlementSideFromDexscreener(side);
  } catch {
    return {
      ...side,
      score: side.score || calculateSettlementSideScore(side),
    };
  }
}

function buildSettlementBattleForBotaEngine(input: {
  round: typeof agentBattleP2PRounds.$inferSelect;
  left: SettlementSnapshotSide;
  right: SettlementSnapshotSide;
  spectatorCount: number;
  winnerLogic: string;
}): BantahBroAgentBattle {
  const leftSide = settlementSideToAgentBattleSide(input.left, input.right);
  const rightSide = settlementSideToAgentBattleSide(input.right, input.left);
  const leadingSideId = leftSide.confidence >= rightSide.confidence ? leftSide.id : rightSide.id;

  return {
    id: input.round.battleId || input.round.roundId,
    title: `${leftSide.label} vs ${rightSide.label}`,
    battleType: "agent-battle",
    status: "expired",
    winnerLogic: input.winnerLogic,
    startsAt: toIsoString(input.round.roundStartsAt),
    endsAt: toIsoString(input.round.roundEndsAt),
    timeRemainingSeconds: 0,
    spectators: Math.max(0, input.spectatorCount),
    sides: [leftSide, rightSide],
    leadingSideId,
    confidenceSpread: Math.abs(leftSide.confidence - rightSide.confidence),
    events: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function resolveAgentBattleP2PRoundWinnerWithBotaEngine(input: {
  roundId: string;
  seed?: string | null;
  maxRounds?: number | null;
  preloadedRows?: Array<typeof agentBattleP2PPositions.$inferSelect>;
}) {
  await ensureAgentBattleP2PPositionsTable();
  const roundId = String(input.roundId || "").trim();
  if (!roundId) throw new Error("roundId is required");

  const [round] = await db
    .select()
    .from(agentBattleP2PRounds)
    .where(eq(agentBattleP2PRounds.roundId, roundId))
    .limit(1);
  if (!round) {
    const error = new Error("Battle P2P round not found");
    (error as { status?: number }).status = 404;
    throw error;
  }

  const rows =
    input.preloadedRows ||
    (await db
      .select()
      .from(agentBattleP2PPositions)
      .where(
        and(
          eq(agentBattleP2PPositions.roundId, roundId),
          eq(agentBattleP2PPositions.escrowStatus, "escrow_locked"),
        ),
      )
      .orderBy(asc(agentBattleP2PPositions.createdAt)));

  if (rows.length === 0) {
    throw new Error("No escrow-locked battle positions are available for settlement");
  }

  const sides = collectRoundSettlementSides(rows);
  if (sides.length < 2) {
    throw new Error("Battle round needs two sides before BOTA engine settlement");
  }

  const [left, right] = await Promise.all([
    refreshSettlementSideForEngine(sides[0]),
    refreshSettlementSideForEngine(sides[1]),
  ]);
  const winnerLogic = `BOTA Arena Engine (${resolveSnapshotWinnerLogic(rows)})`;
  const battle = buildSettlementBattleForBotaEngine({
    round,
    left,
    right,
    spectatorCount: rows.length,
    winnerLogic,
  });
  const simulation = await simulateBotaArenaBattleFromLiveBattle(battle, {
    seed: input.seed || `bota-engine:${roundId}:${toIsoString(round.roundStartsAt)}`,
    maxRounds: input.maxRounds || 5,
  });
  const leftFinal = simulation.finalState.fighters.find((fighter) => fighter.id === left.id);
  const rightFinal = simulation.finalState.fighters.find((fighter) => fighter.id === right.id);
  let winnerSideId = simulation.finalState.winnerId;

  if (!winnerSideId) {
    const leftHealth = leftFinal?.health ?? 0;
    const rightHealth = rightFinal?.health ?? 0;
    if (leftHealth !== rightHealth) {
      winnerSideId = leftHealth > rightHealth ? left.id : right.id;
    } else {
      winnerSideId = (left.score || calculateSettlementSideScore(left)) >=
        (right.score || calculateSettlementSideScore(right))
        ? left.id
        : right.id;
    }
  }

  const winner = winnerSideId === left.id ? left : right;
  const loser = winnerSideId === left.id ? right : left;

  return {
    roundId,
    winnerSideId,
    winner,
    loser,
    winnerLogic,
    battle,
    simulation,
  };
}

export async function settleAgentBattleP2PRound(input: {
  roundId: string;
  winnerSideId: string;
  maxPairs?: number;
  dryRun?: boolean;
}): Promise<{
  roundId: string;
  escrowChallengeId: number;
  winnerSideId: string;
  winnerSideLabel: string;
  loserSideLabel: string | null;
  tokenSymbol: OnchainTokenSymbol;
  chainId: number;
  dryRun: boolean;
  pairsPrepared: number;
  pairsSettled: number;
  unmatchedWinners: number;
  unmatchedLosers: number;
  txHashes: string[];
}> {
  await ensureAgentBattleP2PPositionsTable();
  const roundId = String(input.roundId || "").trim();
  const winnerSideId = String(input.winnerSideId || "").trim();
  if (!roundId) throw new Error("roundId is required");
  if (!winnerSideId) throw new Error("winnerSideId is required");

  const [round] = await db
    .select()
    .from(agentBattleP2PRounds)
    .where(eq(agentBattleP2PRounds.roundId, roundId))
    .limit(1);
  if (!round) {
    const error = new Error("Battle P2P round not found");
    (error as { status?: number }).status = 404;
    throw error;
  }
  if (!round.escrowChallengeId) {
    throw new Error("Battle round does not have an escrow challenge ID");
  }
  const now = Date.now();
  const endsAt = new Date(round.roundEndsAt).getTime();
  if (Number.isFinite(endsAt) && endsAt > now) {
    const error = new Error("This battle round is still live; settlement waits for countdown end");
    (error as { status?: number }).status = 409;
    throw error;
  }

  const lockedRows = await db
    .select()
    .from(agentBattleP2PPositions)
    .where(
      and(
        eq(agentBattleP2PPositions.roundId, roundId),
        eq(agentBattleP2PPositions.escrowStatus, "escrow_locked"),
      ),
    )
    .orderBy(asc(agentBattleP2PPositions.createdAt));

  const winners = lockedRows
    .filter((row) => row.sideId === winnerSideId && normalizeEvmAddress(row.walletAddress || ""))
    .sort(compareStakeRows);
  const losers = lockedRows
    .filter((row) => row.sideId !== winnerSideId && normalizeEvmAddress(row.walletAddress || ""))
    .sort(compareStakeRows);
  const winnerSideLabel =
    lockedRows.find((row) => row.sideId === winnerSideId)?.sideLabel || winnerSideId;
  const loserSideLabel = lockedRows.find((row) => row.sideId !== winnerSideId)?.sideLabel || null;
  const maxPairs = Math.max(1, Math.min(Number(input.maxPairs || 20), 100));
  const pairCount = Math.min(winners.length, losers.length, maxPairs);
  if (pairCount < 1) {
    throw new Error("No matched opposite-side escrow positions are available for this round");
  }

  const config = getOnchainServerConfig();
  const chain = config.chains[String(round.escrowChainId)];
  const escrowContract = normalizeEvmAddress(chain?.escrowContractAddress);
  const tokenSymbol = isOnchainTokenSymbol(round.escrowTokenSymbol)
    ? round.escrowTokenSymbol
    : normalizeOnchainTokenSymbol(config.defaultToken || "USDC");
  const token = chain?.tokens?.[tokenSymbol];
  if (!config.contractEnabled || !chain || !escrowContract || chain.escrowSupportsChallengeLock !== true) {
    const error = new Error("Bantah V2 escrow payout contract is not configured for this battle round");
    (error as { status?: number }).status = 503;
    throw error;
  }
  if (!token) {
    throw new Error(`Escrow token ${tokenSymbol} is not configured on ${chain.name}`);
  }
  const tokenAddress = normalizeEvmAddress(token.address || "");
  if (!token.isNative && !tokenAddress) {
    throw new Error(`Escrow token ${tokenSymbol} contract address is not configured on ${chain.name}`);
  }

  const dryRun = input.dryRun === true;
  const txHashes: string[] = [];
  let contract: ethers.Contract | null = null;
  if (!dryRun) {
    const adminKey = String(process.env.ADMIN_PRIVATE_KEY || "").trim();
    if (!adminKey) {
      throw new Error("ADMIN_PRIVATE_KEY is required for battle payout settlement");
    }
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, {
      staticNetwork: true,
    });
    const signer = new ethers.Wallet(adminKey, provider);
    contract = new ethers.Contract(escrowContract, ESCROW_V2_PAYOUT_ABI, signer);
  }

  const settledNotifications: Array<{
    userId: string;
    outcome: "won" | "lost";
    sideLabel: string;
    opponentLabel: string;
    stakeAmount: number;
    payoutAmount: number;
    txHash: string;
  }> = [];

  for (let index = 0; index < pairCount; index += 1) {
    const winner = winners[index];
    const loser = losers[index];
    const winnerWallet = normalizeEvmAddress(winner.walletAddress || "");
    const loserWallet = normalizeEvmAddress(loser.walletAddress || "");
    if (!winnerWallet || !loserWallet || winnerWallet === loserWallet) continue;

    let payoutTxHash = `dry-run:${winner.id}:${loser.id}`;
    if (!dryRun && contract) {
      const tx = token.isNative
        ? await contract.settleChallengeNativePayout(
            round.escrowChallengeId,
            winnerWallet,
            loserWallet,
          )
        : await contract.settleChallengeTokenPayout(
            round.escrowChallengeId,
            tokenAddress,
            winnerWallet,
            loserWallet,
          );
      const receipt = await tx.wait();
      payoutTxHash = String(receipt?.hash || tx.hash);
    }

    txHashes.push(payoutTxHash);
    if (!dryRun) {
      const payoutAmount = String(calculatePairPayout(winner, loser));
      await db
        .update(agentBattleP2PPositions)
        .set({
          escrowStatus: "settled",
          winnerSideId,
          payoutAmount,
          payoutTxHash,
          updatedAt: new Date(),
        })
        .where(inArray(agentBattleP2PPositions.id, [winner.id, loser.id]));

      settledNotifications.push(
        {
          userId: winner.userId,
          outcome: "won",
          sideLabel: winner.sideLabel || winner.sideId,
          opponentLabel: loser.sideLabel || loser.sideId,
          stakeAmount: toNumber(winner.stakeAmount),
          payoutAmount: toNumber(payoutAmount),
          txHash: payoutTxHash,
        },
        {
          userId: loser.userId,
          outcome: "lost",
          sideLabel: loser.sideLabel || loser.sideId,
          opponentLabel: winner.sideLabel || winner.sideId,
          stakeAmount: toNumber(loser.stakeAmount),
          payoutAmount: 0,
          txHash: payoutTxHash,
        },
      );
    }
  }

  if (!dryRun) {
    const remainingLocked = await db
      .select()
      .from(agentBattleP2PPositions)
      .where(
        and(
          eq(agentBattleP2PPositions.roundId, roundId),
          eq(agentBattleP2PPositions.escrowStatus, "escrow_locked"),
        ),
      )
      .limit(1);
    await db
      .update(agentBattleP2PRounds)
      .set({
        settlementStatus: remainingLocked.length > 0 ? "partially_settled" : "settled",
        winnerSideId,
        settlementTxHashes: txHashes,
        settlementError: null,
        settledAt: remainingLocked.length > 0 ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentBattleP2PRounds.id, round.id));

    await Promise.allSettled([
      ...settledNotifications.map((entry) =>
        notifyBotaUser({
          userId: entry.userId,
          type: entry.outcome === "won" ? "bota_p2p_battle_won" : "bota_p2p_battle_lost",
          title: entry.outcome === "won" ? "Battle prediction won" : "Battle prediction lost",
          message:
            entry.outcome === "won"
              ? `${entry.sideLabel} beat ${entry.opponentLabel}. Payout: ${entry.payoutAmount.toLocaleString()} ${tokenSymbol}.`
              : `${entry.sideLabel} lost to ${entry.opponentLabel}. Stake: ${entry.stakeAmount.toLocaleString()} ${tokenSymbol}.`,
          icon: "B",
          url: "/bota?section=battles",
          data: {
            roundId,
            escrowChallengeId: round.escrowChallengeId,
            winnerSideId,
            sideLabel: entry.sideLabel,
            opponentLabel: entry.opponentLabel,
            stakeAmount: entry.stakeAmount,
            payoutAmount: entry.payoutAmount,
            payoutTxHash: entry.txHash,
          },
          priority: entry.outcome === "won" ? 4 : 3,
          fomoLevel: entry.outcome === "won" ? "urgent" : "high",
        }),
      ),
      broadcastBotaTelegramEvent({
        id: `telegram-bota-p2p-settlement-${roundId}-${winnerSideId}`,
        title: "BOTA P2P ROUND SETTLED",
        lines: [
          `${winnerSideLabel} won${loserSideLabel ? ` against ${loserSideLabel}` : ""}.`,
          `${txHashes.length} payout${txHashes.length === 1 ? "" : "s"} processed.`,
          `Escrow challenge: ${round.escrowChallengeId}`,
        ],
        url: "/bota?section=battles",
        tags: ["BOTA", "P2P", "Settlement"],
        market: `${winnerSideLabel}${loserSideLabel ? ` vs ${loserSideLabel}` : ""}`,
      }),
    ]);
  }

  return {
    roundId,
    escrowChallengeId: round.escrowChallengeId,
    winnerSideId,
    winnerSideLabel,
    loserSideLabel,
    tokenSymbol,
    chainId: chain.chainId,
    dryRun,
    pairsPrepared: pairCount,
    pairsSettled: txHashes.length,
    unmatchedWinners: Math.max(0, winners.length - pairCount),
    unmatchedLosers: Math.max(0, losers.length - pairCount),
    txHashes,
  };
}

export async function settleDueAgentBattleP2PRounds(input?: {
  limit?: number;
  maxPairsPerRound?: number;
  dryRun?: boolean;
}): Promise<{
  scanned: number;
  processed: number;
  settled: number;
  partiallySettled: number;
  skipped: number;
  failed: number;
  results: Array<{
    roundId: string;
    status: "settled" | "partially_settled" | "skipped" | "failed" | "dry_run";
    winnerSideId?: string;
    pairsSettled?: number;
    reason?: string;
  }>;
}> {
  await ensureAgentBattleP2PPositionsTable();
  const limit = Math.max(1, Math.min(Number(input?.limit || 5), 25));
  const maxPairsPerRound = Math.max(1, Math.min(Number(input?.maxPairsPerRound || 20), 100));
  const dryRun = input?.dryRun === true;

  const dueRounds = await db
    .select()
    .from(agentBattleP2PRounds)
    .where(sql`
      ${agentBattleP2PRounds.roundEndsAt} <= now()
      AND ${agentBattleP2PRounds.settlementStatus} IN ('open', 'partially_settled')
    `)
    .orderBy(asc(agentBattleP2PRounds.roundEndsAt))
    .limit(limit);

  const results: Array<{
    roundId: string;
    status: "settled" | "partially_settled" | "skipped" | "failed" | "dry_run";
    winnerSideId?: string;
    pairsSettled?: number;
    reason?: string;
  }> = [];

  let processed = 0;
  let settled = 0;
  let partiallySettled = 0;
  let skipped = 0;
  let failed = 0;

  for (const round of dueRounds) {
    processed += 1;
    const roundId = round.roundId;

    try {
      if (!dryRun) {
        await db
          .update(agentBattleP2PRounds)
          .set({
            settlementStatus: "settling",
            settlementError: null,
            updatedAt: new Date(),
          })
          .where(eq(agentBattleP2PRounds.id, round.id));
      }

      const lockedRows = await db
        .select()
        .from(agentBattleP2PPositions)
        .where(
          and(
            eq(agentBattleP2PPositions.roundId, roundId),
            eq(agentBattleP2PPositions.escrowStatus, "escrow_locked"),
          ),
        )
        .orderBy(asc(agentBattleP2PPositions.createdAt));

      if (lockedRows.length === 0) {
        if (!dryRun) {
          await db
            .update(agentBattleP2PRounds)
            .set({
              settlementStatus: "settled",
              settlementError: null,
              settledAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(agentBattleP2PRounds.id, round.id));
        }
        skipped += 1;
        results.push({
          roundId,
          status: "skipped",
          reason: "no escrow-locked positions",
        });
        continue;
      }

      const winnerSideId =
        round.winnerSideId ||
        (
          await resolveAgentBattleP2PRoundWinner({
            roundId,
            preloadedRows: lockedRows,
          })
        ).winnerSideId;

      const settlement = await settleAgentBattleP2PRound({
        roundId,
        winnerSideId,
        maxPairs: maxPairsPerRound,
        dryRun,
      });

      const status = dryRun
        ? "dry_run"
        : settlement.unmatchedLosers > 0 || settlement.unmatchedWinners > 0
          ? "partially_settled"
          : "settled";
      if (status === "settled") settled += 1;
      if (status === "partially_settled") partiallySettled += 1;
      if (status === "dry_run") skipped += 1;
      results.push({
        roundId,
        status,
        winnerSideId,
        pairsSettled: settlement.pairsSettled,
      });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "Battle settlement failed";
      if (!dryRun) {
        await db
          .update(agentBattleP2PRounds)
          .set({
            settlementStatus: "settlement_failed",
            settlementError: message,
            updatedAt: new Date(),
          })
          .where(eq(agentBattleP2PRounds.id, round.id));
      }
      results.push({
        roundId,
        status: "failed",
        reason: message,
      });
    }
  }

  return {
    scanned: dueRounds.length,
    processed,
    settled,
    partiallySettled,
    skipped,
    failed,
    results,
  };
}
