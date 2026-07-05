import { and, eq, inArray, sql } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "./db";
import { getOnchainServerConfig } from "./onchainConfig";
import {
  buildRewardBatch,
  computeSimBattleEventRoot,
  computeSimBattleMetadataHash,
  recordSimulatedBattleOnchain,
  setBantCreditRewardBatchOnchain,
  type RewardLeaf,
  type SimBattleReceiptPayload,
  type SimBattleRewardEntry,
} from "./onchainSimRewards";
import { transactions, users } from "@shared/schema";
import {
  BANTCREDIT_AGENT_WIN_REWARD,
  BANTCREDIT_BATTLE_WATCH_REWARD_TIERS,
  BANTCREDIT_BATTLE_WATCH_TRANSACTION_TYPE,
} from "@shared/bantCredit";
import {
  normalizeEvmAddress,
  parseWalletAddresses,
  type OnchainChainConfig,
} from "@shared/onchainConfig";
import type { BotaArenaBattleRecord } from "@shared/botaArenaBattleRecord";
import type {
  BantahBroAgentBattle,
  BantahBroAgentBattleSide,
} from "./bantahBro/agentBattleService";

type ClaimRow = {
  id: string;
  batch_id: string;
  battle_id: string;
  record_id: string | null;
  chain_id: number;
  chain_name: string | null;
  account: string;
  user_id: string | null;
  amount: number;
  role: string;
  match_id: string;
  role_bytes32: string;
  match_id_bytes32: string;
  leaf_hash: string;
  proof: unknown;
  reward_root: string;
  metadata_hash: string;
  battle_tx_hash: string | null;
  batch_tx_hash: string | null;
  claim_tx_hash: string | null;
  status: string;
  created_at: Date | string | null;
  updated_at: Date | string | null;
};

export type OnchainSimBattleClaim = {
  id: string;
  batchId: string;
  battleId: string;
  recordId: string | null;
  chainId: number;
  chainName: string | null;
  account: string;
  userId: string | null;
  amount: number;
  role: string;
  matchId: string;
  roleBytes32: string;
  matchIdBytes32: string;
  leaf: string;
  proof: string[];
  rewardRoot: string;
  metadataHash: string;
  battleTxHash: string | null;
  batchTxHash: string | null;
  claimTxHash: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

let ensureClaimsTablePromise: Promise<void> | null = null;

function rowsOf<T = any>(result: any): T[] {
  return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function positiveIntHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 2_147_483_647) || 1;
}

function getBattleWatchRewardRelatedId(battleId: string, tierSeconds: number) {
  return positiveIntHash(`battle-watch:${battleId}:${tierSeconds}`);
}

function safeJsonArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizeClaimRow(row: ClaimRow): OnchainSimBattleClaim {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    battleId: String(row.battle_id),
    recordId: row.record_id ? String(row.record_id) : null,
    chainId: Number(row.chain_id),
    chainName: row.chain_name ? String(row.chain_name) : null,
    account: normalizeEvmAddress(row.account) || String(row.account),
    userId: row.user_id ? String(row.user_id) : null,
    amount: Math.max(0, Math.round(Number(row.amount || 0))),
    role: String(row.role || "SPECTATOR"),
    matchId: String(row.match_id || row.battle_id),
    roleBytes32: String(row.role_bytes32),
    matchIdBytes32: String(row.match_id_bytes32),
    leaf: String(row.leaf_hash),
    proof: safeJsonArray(row.proof),
    rewardRoot: String(row.reward_root),
    metadataHash: String(row.metadata_hash),
    battleTxHash: row.battle_tx_hash ? String(row.battle_tx_hash) : null,
    batchTxHash: row.batch_tx_hash ? String(row.batch_tx_hash) : null,
    claimTxHash: row.claim_tx_hash ? String(row.claim_tx_hash) : null,
    status: String(row.status || "claimable"),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function ensureOnchainSimBattleClaimsTable() {
  if (!ensureClaimsTablePromise) {
    ensureClaimsTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "onchain_sim_battle_reward_claims" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "batch_id" varchar(80) NOT NULL,
        "battle_id" varchar(255) NOT NULL,
        "record_id" varchar(80),
        "chain_id" integer NOT NULL,
        "chain_name" varchar(120),
        "account" varchar(64) NOT NULL,
        "user_id" varchar(255),
        "amount" integer NOT NULL,
        "role" varchar(40) NOT NULL,
        "match_id" varchar(255) NOT NULL,
        "role_bytes32" varchar(80) NOT NULL,
        "match_id_bytes32" varchar(80) NOT NULL,
        "leaf_hash" varchar(80) NOT NULL,
        "proof" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "reward_root" varchar(80) NOT NULL,
        "metadata_hash" varchar(80) NOT NULL,
        "battle_tx_hash" varchar(90),
        "batch_tx_hash" varchar(90),
        "claim_tx_hash" varchar(90),
        "status" varchar(32) NOT NULL DEFAULT 'claimable',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "onchain_sim_battle_claim_unique" UNIQUE (
          "chain_id",
          "batch_id",
          "account",
          "role",
          "match_id"
        )
      );
      CREATE INDEX IF NOT EXISTS "idx_onchain_sim_claims_account"
        ON "onchain_sim_battle_reward_claims" ("account");
      CREATE INDEX IF NOT EXISTS "idx_onchain_sim_claims_user_id"
        ON "onchain_sim_battle_reward_claims" ("user_id");
      CREATE INDEX IF NOT EXISTS "idx_onchain_sim_claims_battle_id"
        ON "onchain_sim_battle_reward_claims" ("battle_id");
    `).then(() => undefined);
  }
  return ensureClaimsTablePromise;
}

function isEnsSide(side: BantahBroAgentBattleSide | null | undefined) {
  if (!side) return false;
  return (
    side.dataSource === "ens-subgraph" ||
    String(side.chainLabel || "").toUpperCase() === "ENS" ||
    String(side.emoji || "").toUpperCase() === "ENS" ||
    String(side.tokenName || side.agentName || "").toLowerCase().includes(".eth")
  );
}

const EXTERNAL_AGENT_OWNER_SOURCES = new Set(["eliza", "virtuals", "bankr", "game-sdk", "agentkit"]);
const EXTERNAL_AGENT_SOURCE_LABELS: Record<string, string> = {
  eliza: "ElizaOS",
  virtuals: "Virtuals Protocol",
  bankr: "Bankr",
  "game-sdk": "Game SDK",
  agentkit: "AgentKit",
};

function resolveWinnerSide(record: BotaArenaBattleRecord, battle: BantahBroAgentBattle) {
  return record.winnerSideId
    ? battle.sides.find((side) => side.id === record.winnerSideId) || null
    : null;
}

function externalAgentSourceKey(side: BantahBroAgentBattleSide | null | undefined) {
  if (!side || isEnsSide(side)) return null;
  const idMatch = String(side.id || "")
    .toLowerCase()
    .match(/^external:([^:]+):/);
  if (idMatch?.[1] && EXTERNAL_AGENT_OWNER_SOURCES.has(idMatch[1])) {
    return idMatch[1];
  }

  const haystack = [
    side.chainLabel,
    side.chainId,
    side.label,
    side.agentName,
    side.tokenName,
    side.tokenSymbol,
    side.emoji,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (haystack.includes("eliza")) return "eliza";
  if (haystack.includes("virtuals") || haystack.includes("virtual protocol")) return "virtuals";
  if (haystack.includes("bankr")) return "bankr";
  if (haystack.includes("agentkit") || haystack.includes("agent kit")) return "agentkit";
  if (haystack.includes("game sdk") || haystack.includes("game-sdk")) return "game-sdk";
  return null;
}

function resolveOwnerForSide(side: BantahBroAgentBattleSide | null | undefined) {
  const account = normalizeEvmAddress(side?.tokenAddress);
  if (!side || !account) return null;
  if (isEnsSide(side)) {
    return {
      side,
      account,
      role: "ENS_OWNER" as const,
      matchSuffix: "ens-owner",
      sourceLabel: "ENS",
    };
  }

  const sourceKey = externalAgentSourceKey(side);
  if (!sourceKey) return null;
  return {
    side,
    account,
    role: "EXTERNAL_AGENT_OWNER" as const,
    matchSuffix: `${sourceKey}-owner`,
    sourceLabel: EXTERNAL_AGENT_SOURCE_LABELS[sourceKey] || "External Agent",
  };
}

function resolvePrimaryRewardOwner(record: BotaArenaBattleRecord, battle: BantahBroAgentBattle) {
  const winnerOwner = resolveOwnerForSide(resolveWinnerSide(record, battle));
  if (winnerOwner) return winnerOwner;
  for (const side of battle.sides) {
    const owner = resolveOwnerForSide(side);
    if (owner) return owner;
  }
  return null;
}

function resolveWinnerAddress(record: BotaArenaBattleRecord, battle: BantahBroAgentBattle) {
  const winnerSide = resolveWinnerSide(record, battle);
  return normalizeEvmAddress(winnerSide?.tokenAddress) || null;
}

function fighterNames(record: BotaArenaBattleRecord, battle: BantahBroAgentBattle) {
  const fromRecord = record.fighters
    .map((fighter) => {
      const name = fighter?.name;
      return typeof name === "string" && name.trim() ? name.trim() : null;
    })
    .filter((name): name is string => Boolean(name));
  return fromRecord.length > 0
    ? fromRecord
    : battle.sides.map((side) => side.agentName || side.label || side.id);
}

function recordEvents(record: BotaArenaBattleRecord) {
  return record.roundLog.map((entry, index) => ({
    id: typeof entry.id === "string" ? entry.id : `${record.id}:event:${index}`,
    type: typeof entry.actionType === "string" ? entry.actionType : "round_event",
    actor: typeof entry.actorId === "string" ? entry.actorId : null,
    message: typeof entry.message === "string" ? entry.message : null,
    value:
      typeof entry.damage === "number" || typeof entry.damage === "string"
        ? entry.damage
        : null,
    timestamp: record.resolvedAt || record.updatedAt || record.createdAt || null,
  }));
}

async function getSpectatorRewardsForBattle(battleId: string): Promise<SimBattleRewardEntry[]> {
  const relatedIds = BANTCREDIT_BATTLE_WATCH_REWARD_TIERS.map((tier) =>
    getBattleWatchRewardRelatedId(battleId, tier.minSeconds),
  );

  const rows = await db
    .select({
      userId: transactions.userId,
      amount: sql<string>`COALESCE(SUM(${transactions.amount}::numeric), 0)`,
      primaryWalletAddress: users.primaryWalletAddress,
      walletAddresses: users.walletAddresses,
    })
    .from(transactions)
    .leftJoin(users, eq(users.id, transactions.userId))
    .where(
      and(
        eq(transactions.type, BANTCREDIT_BATTLE_WATCH_TRANSACTION_TYPE),
        eq(transactions.status, "completed"),
        inArray(transactions.relatedId, relatedIds),
      ),
    )
    .groupBy(transactions.userId, users.primaryWalletAddress, users.walletAddresses);

  return rows
    .map<SimBattleRewardEntry | null>((row) => {
      const account =
        normalizeEvmAddress(row.primaryWalletAddress) ||
        parseWalletAddresses(row.walletAddresses)[0] ||
        null;
      const amount = Math.max(0, Math.round(Number(row.amount || 0)));
      if (!account || amount <= 0) return null;
      return {
        account,
        amount,
        role: "SPECTATOR" as const,
        matchId: `${battleId}:spectator:${row.userId}`,
      };
    })
    .filter((entry): entry is SimBattleRewardEntry => Boolean(entry));
}

export async function buildSimBattleReceiptPayloadForRecord(params: {
  record: BotaArenaBattleRecord;
  battle: BantahBroAgentBattle;
}): Promise<{
  payload: SimBattleReceiptPayload | null;
  skippedReason: string | null;
}> {
  const primaryOwner = resolvePrimaryRewardOwner(params.record, params.battle);
  if (!primaryOwner) {
    return {
      payload: null,
      skippedReason: "No ENS or external agent owner wallet was available for this simulated battle.",
    };
  }

  const winnerAddress = resolveWinnerAddress(params.record, params.battle);
  const rewards: SimBattleRewardEntry[] = [
    {
      account: primaryOwner.account,
      amount: BANTCREDIT_AGENT_WIN_REWARD,
      role: primaryOwner.role,
      matchId: `${params.record.battleId}:${primaryOwner.matchSuffix}`,
    },
    ...(await getSpectatorRewardsForBattle(params.record.battleId)),
  ];

  return {
    payload: {
      version: 1,
      battleId: params.record.id || params.record.recordKey || params.record.battleId,
      ensName: primaryOwner.side.tokenName || primaryOwner.side.agentName || null,
      ensNamehash: null,
      ensOwner: primaryOwner.account,
      ownerRole: primaryOwner.role,
      ownerSource: primaryOwner.sourceLabel,
      winner: winnerAddress || primaryOwner.account,
      fighters: fighterNames(params.record, params.battle),
      events: recordEvents(params.record),
      rewards,
      finishedAt:
        params.record.resolvedAt ||
        params.record.endedAt ||
        params.record.updatedAt ||
        new Date().toISOString(),
    },
    skippedReason: null,
  };
}

function resolveChain(chainId?: number | null): OnchainChainConfig | null {
  const config = getOnchainServerConfig();
  const preferred = Number(chainId || config.defaultChainId || config.chainId || 0);
  return (
    config.chains[String(preferred)] ||
    config.chains[String(config.defaultChainId)] ||
    config.chains[String(config.chainId)] ||
    Object.values(config.chains || {})[0] ||
    null
  );
}

async function storeClaimLeaves(params: {
  chain: OnchainChainConfig;
  record: BotaArenaBattleRecord;
  leaves: RewardLeaf[];
  rewardRoot: string;
  metadataHash: string;
  battleTxHash: string | null;
  batchTxHash: string | null;
}) {
  await ensureOnchainSimBattleClaimsTable();
  const stored: OnchainSimBattleClaim[] = [];

  for (const leaf of params.leaves) {
    const result = await db.execute(sql`
      INSERT INTO "onchain_sim_battle_reward_claims" (
        "batch_id",
        "battle_id",
        "record_id",
        "chain_id",
        "chain_name",
        "account",
        "user_id",
        "amount",
        "role",
        "match_id",
        "role_bytes32",
        "match_id_bytes32",
        "leaf_hash",
        "proof",
        "reward_root",
        "metadata_hash",
        "battle_tx_hash",
        "batch_tx_hash",
        "status",
        "updated_at"
      )
      VALUES (
        ${leaf.batchId},
        ${params.record.battleId},
        ${params.record.id},
        ${params.chain.chainId},
        ${params.chain.name},
        ${leaf.account},
        (
          SELECT "id"
          FROM "users"
          WHERE lower("primary_wallet_address") = lower(${leaf.account})
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements_text(COALESCE("wallet_addresses", '[]'::jsonb)) AS wallet(value)
               WHERE lower(wallet.value) = lower(${leaf.account})
             )
          LIMIT 1
        ),
        ${Number(leaf.amount)},
        ${String(leaf.role)},
        ${String(leaf.matchId)},
        ${leaf.roleBytes32},
        ${leaf.matchIdBytes32},
        ${leaf.leaf},
        ${JSON.stringify(leaf.proof)}::jsonb,
        ${params.rewardRoot},
        ${params.metadataHash},
        ${params.battleTxHash},
        ${params.batchTxHash},
        ${params.batchTxHash ? "claimable" : "draft"},
        now()
      )
      ON CONFLICT ("chain_id", "batch_id", "account", "role", "match_id")
      DO UPDATE SET
        "user_id" = COALESCE(EXCLUDED."user_id", "onchain_sim_battle_reward_claims"."user_id"),
        "amount" = EXCLUDED."amount",
        "role_bytes32" = EXCLUDED."role_bytes32",
        "match_id_bytes32" = EXCLUDED."match_id_bytes32",
        "leaf_hash" = EXCLUDED."leaf_hash",
        "proof" = EXCLUDED."proof",
        "reward_root" = EXCLUDED."reward_root",
        "metadata_hash" = EXCLUDED."metadata_hash",
        "battle_tx_hash" = COALESCE(EXCLUDED."battle_tx_hash", "onchain_sim_battle_reward_claims"."battle_tx_hash"),
        "batch_tx_hash" = COALESCE(EXCLUDED."batch_tx_hash", "onchain_sim_battle_reward_claims"."batch_tx_hash"),
        "status" = CASE
          WHEN "onchain_sim_battle_reward_claims"."claim_tx_hash" IS NOT NULL THEN "onchain_sim_battle_reward_claims"."status"
          ELSE EXCLUDED."status"
        END,
        "updated_at" = now()
      RETURNING *;
    `);
    const [row] = rowsOf<ClaimRow>(result);
    if (row) stored.push(normalizeClaimRow(row));
  }

  return stored;
}

export async function publishOnchainSimBattleRewardsForRecord(params: {
  record: BotaArenaBattleRecord;
  battle: BantahBroAgentBattle;
  chainId?: number | null;
  execute?: boolean | null;
  active?: boolean;
}) {
  const chain = resolveChain(params.chainId);
  if (!chain) {
    return {
      configured: false,
      skippedReason: "No onchain chain config is available.",
      payload: null,
      claims: [] as OnchainSimBattleClaim[],
    };
  }

  const built = await buildSimBattleReceiptPayloadForRecord({
    record: params.record,
    battle: params.battle,
  });
  if (!built.payload) {
    return {
      configured: false,
      skippedReason: built.skippedReason,
      chainId: chain.chainId,
      chainName: chain.name,
      payload: null,
      claims: [] as OnchainSimBattleClaim[],
    };
  }

  const config = getOnchainServerConfig();
  const contractsConfigured = chain.key.startsWith("solana") || Boolean(
    normalizeEvmAddress(chain.simBattleRegistryAddress) &&
      normalizeEvmAddress(chain.bantCreditRewardsAddress),
  );
  const execute = params.execute === true || (params.execute !== false && config.contractEnabled);
  const dryRun = !execute || !contractsConfigured;
  const metadata = computeSimBattleMetadataHash(built.payload);
  const eventRoot = computeSimBattleEventRoot(built.payload.events);
  const rewardBatch = buildRewardBatch({
    batchId: built.payload.battleId,
    rewards: built.payload.rewards,
  });

  const recordResult = contractsConfigured
    ? await recordSimulatedBattleOnchain({
        chain,
        payload: built.payload,
        eventRoot,
        rewardRoot: rewardBatch.root,
        totalBantCredits: rewardBatch.totalBantCredits,
        dryRun,
      })
    : null;
  const rewardResult = (chain.key.startsWith("solana") || normalizeEvmAddress(chain.bantCreditRewardsAddress))
    ? await setBantCreditRewardBatchOnchain({
        chain,
        batchId: built.payload.battleId,
        rewards: built.payload.rewards,
        metadataHash: metadata.hash,
        active: params.active !== false,
        dryRun,
      })
    : null;

  const claims = await storeClaimLeaves({
    chain,
    record: params.record,
    leaves: rewardBatch.leaves,
    rewardRoot: rewardBatch.root,
    metadataHash: metadata.hash,
    battleTxHash: recordResult?.txHash && recordResult.txHash !== "dry-run" ? recordResult.txHash : null,
    batchTxHash: rewardResult?.txHash && rewardResult.txHash !== "dry-run" ? rewardResult.txHash : null,
  });

  return {
    configured: contractsConfigured,
    mode: dryRun ? "dry_run" : "executed",
    skippedReason: contractsConfigured ? null : "Sim reward contracts are not configured for this chain.",
    chainId: chain.chainId,
    chainName: chain.name,
    contracts: {
      bantCreditsAddress: chain.bantCreditsAddress || null,
      simBattleRegistryAddress: chain.simBattleRegistryAddress || null,
      bantCreditRewardsAddress: chain.bantCreditRewardsAddress || null,
    },
    payload: built.payload,
    eventRoot,
    rewardRoot: rewardBatch.root,
    metadataHash: metadata.hash,
    totalBantCredits: rewardBatch.totalBantCredits.toString(),
    recordTxHash: recordResult?.txHash || null,
    rewardBatchTxHash: rewardResult?.txHash || null,
    claims,
  };
}

export async function listOnchainSimBattleClaimsForUser(params: {
  userId: string;
  walletAddresses?: unknown;
  primaryWalletAddress?: string | null;
}) {
  await ensureOnchainSimBattleClaimsTable();
  const walletSet = new Set<string>();
  const primary = normalizeEvmAddress(params.primaryWalletAddress);
  if (primary) walletSet.add(primary);
  parseWalletAddresses(params.walletAddresses).forEach((wallet) => walletSet.add(wallet));

  const walletList = Array.from(walletSet);
  const byWallet = walletList.length
    ? await db.execute(sql`
        SELECT *
        FROM "onchain_sim_battle_reward_claims"
        WHERE lower("account") IN (
          SELECT lower(wallet.value)
          FROM unnest(${walletList}::text[]) AS wallet(value)
        )
        ORDER BY "created_at" DESC
        LIMIT 100;
      `)
    : { rows: [] };

  const byUser = await db.execute(sql`
    SELECT *
    FROM "onchain_sim_battle_reward_claims"
    WHERE "user_id" = ${params.userId}
    ORDER BY "created_at" DESC
    LIMIT 100;
  `);

  const claimsById = new Map<string, OnchainSimBattleClaim>();
  [...rowsOf<ClaimRow>(byWallet), ...rowsOf<ClaimRow>(byUser)].forEach((row) => {
    const claim = normalizeClaimRow(row);
    claimsById.set(claim.id, claim);
  });
  const claims = Array.from(claimsById.values()).sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const claimable = claims.filter((claim) => claim.status === "claimable");

  return {
    wallets: walletList,
    claims,
    claimableCount: claimable.length,
    claimableBantCredits: claimable.reduce((sum, claim) => sum + claim.amount, 0),
    updatedAt: new Date().toISOString(),
  };
}

export async function markOnchainSimBattleClaimTx(params: {
  userId: string;
  claimId: string;
  txHash: string;
}) {
  await ensureOnchainSimBattleClaimsTable();
  const txHash = String(params.txHash || "").trim().toLowerCase();
  if (!ethers.isHexString(txHash, 32)) {
    const error = new Error("Valid claim transaction hash is required");
    (error as { status?: number }).status = 400;
    throw error;
  }

  const result = await db.execute(sql`
    UPDATE "onchain_sim_battle_reward_claims"
    SET
      "claim_tx_hash" = ${txHash},
      "status" = 'claimed',
      "updated_at" = now()
    WHERE "id" = ${params.claimId}
      AND (
        "user_id" = ${params.userId}
        OR lower("account") IN (
          SELECT lower("primary_wallet_address")
          FROM "users"
          WHERE "id" = ${params.userId}
            AND "primary_wallet_address" IS NOT NULL
          UNION
          SELECT lower(wallet.value)
          FROM "users", jsonb_array_elements_text(COALESCE("wallet_addresses", '[]'::jsonb)) AS wallet(value)
          WHERE "users"."id" = ${params.userId}
        )
      )
    RETURNING *;
  `);
  const [row] = rowsOf<ClaimRow>(result);
  if (!row) {
    const error = new Error("Claim not found for this user");
    (error as { status?: number }).status = 404;
    throw error;
  }
  return normalizeClaimRow(row);
}
