import { sql } from "drizzle-orm";
import { db } from "../db";
import { BANTCREDIT_BATTLE_WATCH_REWARD_TIERS, BANTCREDIT_BATTLE_WATCH_TRANSACTION_TYPE } from "@shared/bantCredit";
import { normalizeEvmAddress } from "@shared/onchainConfig";
import type { BotaFighterProfile } from "@shared/botaFighterProfile";
import type { BantahBroAgentBattle, BantahBroAgentBattlesFeed } from "./agentBattleService";
import { getFighterToolLoadoutMap } from "./gen1EconomyService";

const LIVE_STATS_QUERY_TIMEOUT_MS = Number(process.env.BOTA_LIVE_STATS_QUERY_TIMEOUT_MS || 1_500);
const LIVE_STATS_CACHE_TTL_MS = Math.max(
  5_000,
  Math.min(Number.parseInt(String(process.env.BOTA_LIVE_STATS_CACHE_TTL_MS || "30000"), 10) || 30_000, 300_000),
);
const SIM_REWARD_TABLE_CACHE_TTL_MS = Math.max(
  30_000,
  Math.min(Number.parseInt(String(process.env.BOTA_SIM_REWARD_TABLE_CACHE_TTL_MS || "60000"), 10) || 60_000, 600_000),
);

type BattleLiveStats = {
  battleId: string;
  spectators: number;
  spectatorBantCredits: number;
  rewardClaimBantCredits: number;
  bantCreditsEarned: number;
  updatedAt: string;
};

type FighterLiveStats = {
  id: string;
  bantCreditsEarned: number;
  currentUserBantCredits: number;
  currentAgentBantCredits: number;
  simRewardBantCredits: number;
  liveSpectators: number;
  updatedAt: string;
};

type FighterRef = {
  id: string;
  walletAddress?: string | null;
  lastBattleId?: string | null;
};

type CachedValue<T> = {
  value: T;
  cachedAt: number;
};

type FighterLiveStatsOptions = {
  includeBattleLiveStats?: boolean;
};

let simRewardClaimTableCache: CachedValue<boolean> | null = null;
let simRewardClaimTableInflight: Promise<boolean> | null = null;
const battleStatsCache = new Map<string, CachedValue<BattleLiveStats>>();
const fighterStatsCache = new Map<string, CachedValue<FighterLiveStats>>();

function rowsOf<T = any>(result: any): T[] {
  return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
}

async function safeRows<T = any>(query: Promise<any>, scope: string): Promise<T[]> {
  try {
    const result = await Promise.race([
      query,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${LIVE_STATS_QUERY_TIMEOUT_MS}ms`)), LIVE_STATS_QUERY_TIMEOUT_MS),
      ),
    ]);
    return rowsOf<T>(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[BOTA live stats] ${scope} unavailable: ${message}`);
    return [];
  }
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

function normalizePositiveNumber(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric);
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function estimateBattleWatchBantCredits(spectators: number) {
  const fullWatchReward =
    BANTCREDIT_BATTLE_WATCH_REWARD_TIERS.find((tier) => tier.minSeconds >= 120)?.totalPoints ||
    BANTCREDIT_BATTLE_WATCH_REWARD_TIERS[0]?.totalPoints ||
    0;
  return normalizePositiveNumber(spectators) * fullWatchReward;
}

function uniqueValues(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(values.map((value) => String(value || "").trim()).filter(Boolean)),
  );
}

function sqlTextArray(values: string[]) {
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

function sqlIntArray(values: number[]) {
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::int[]`;
}

function isCacheFresh(cachedAt: number, ttlMs = LIVE_STATS_CACHE_TTL_MS) {
  return Date.now() - cachedAt < ttlMs;
}

function getCachedBattleStats(battleId: string, updatedAt: string): BattleLiveStats {
  const cached = battleStatsCache.get(battleId);
  if (cached && isCacheFresh(cached.cachedAt)) {
    return { ...cached.value };
  }
  return {
    battleId,
    spectators: 0,
    spectatorBantCredits: 0,
    rewardClaimBantCredits: 0,
    bantCreditsEarned: 0,
    updatedAt,
  };
}

function getCachedFighterStats(id: string, updatedAt: string): FighterLiveStats {
  const cached = fighterStatsCache.get(id);
  if (cached && isCacheFresh(cached.cachedAt)) {
    return { ...cached.value };
  }
  return {
    id,
    bantCreditsEarned: 0,
    currentUserBantCredits: 0,
    currentAgentBantCredits: 0,
    simRewardBantCredits: 0,
    liveSpectators: 0,
    updatedAt,
  };
}

function hasPositiveBattleStats(stats: BattleLiveStats) {
  return (
    stats.spectators > 0 ||
    stats.spectatorBantCredits > 0 ||
    stats.rewardClaimBantCredits > 0 ||
    stats.bantCreditsEarned > 0
  );
}

function hasPositiveFighterStats(stats: FighterLiveStats) {
  return (
    stats.bantCreditsEarned > 0 ||
    stats.currentUserBantCredits > 0 ||
    stats.currentAgentBantCredits > 0 ||
    stats.simRewardBantCredits > 0 ||
    stats.liveSpectators > 0
  );
}

async function hasSimRewardClaimTable() {
  const now = Date.now();
  if (simRewardClaimTableCache && now - simRewardClaimTableCache.cachedAt < SIM_REWARD_TABLE_CACHE_TTL_MS) {
    return simRewardClaimTableCache.value;
  }
  if (simRewardClaimTableInflight) return simRewardClaimTableInflight;
  simRewardClaimTableInflight = safeRows<{ exists: boolean }>(
    db.execute(sql`SELECT to_regclass('public.onchain_sim_battle_reward_claims') IS NOT NULL AS "exists"`),
    "sim reward claim table check",
  )
    .then((rows) => rows[0]?.exists === true)
    .then((exists) => {
      simRewardClaimTableCache = { value: exists, cachedAt: Date.now() };
      return exists;
    })
    .finally(() => {
      simRewardClaimTableInflight = null;
    });
  return simRewardClaimTableInflight;
}

export async function getBotaBattleLiveStats(battleIds: string[]): Promise<Map<string, BattleLiveStats>> {
  const ids = uniqueValues(battleIds);
  const updatedAt = new Date().toISOString();
  const stats = new Map<string, BattleLiveStats>(
    ids.map((battleId) => [battleId, getCachedBattleStats(battleId, updatedAt)]),
  );
  if (ids.length === 0) return stats;

  const relatedIdToBattleId = new Map<number, string>();
  for (const battleId of ids) {
    for (const tier of BANTCREDIT_BATTLE_WATCH_REWARD_TIERS) {
      relatedIdToBattleId.set(getBattleWatchRewardRelatedId(battleId, tier.minSeconds), battleId);
    }
  }
  const relatedIds = Array.from(relatedIdToBattleId.keys());

  const relatedIdArray = relatedIds.length > 0 ? sqlIntArray(relatedIds) : null;
  const rewardRowsPromise = relatedIdArray
    ? safeRows<{
      related_id: number;
      spectators: string | number;
      bantcredits: string | number;
      }>(
        db.execute(sql`
          SELECT
            "related_id",
            COUNT(DISTINCT "user_id") AS "spectators",
            COALESCE(SUM("amount"::numeric), 0) AS "bantcredits"
          FROM "transactions"
          WHERE "status" = 'completed'
            AND "type" = ${BANTCREDIT_BATTLE_WATCH_TRANSACTION_TYPE}
            AND "related_id" = ANY(${relatedIdArray})
          GROUP BY "related_id"
        `),
        "battle watch reward stats",
      )
    : Promise.resolve([]);

  const battleIdArray = sqlTextArray(ids);
  const claimRowsPromise = hasSimRewardClaimTable().then((hasTable) =>
    hasTable
      ? safeRows<{
      battle_id: string;
      spectator_accounts: string | number;
      bantcredits: string | number;
        }>(
          db.execute(sql`
            SELECT
              "battle_id",
              COUNT(DISTINCT "account") FILTER (WHERE "role" = 'SPECTATOR') AS "spectator_accounts",
              COALESCE(SUM("amount"), 0) AS "bantcredits"
            FROM "onchain_sim_battle_reward_claims"
            WHERE "battle_id" = ANY(${battleIdArray})
              AND "status" IN ('draft', 'claimable', 'claimed')
            GROUP BY "battle_id"
          `),
          "battle sim reward claim stats",
        )
      : Promise.resolve([]),
  );

  const [rewardRows, claimRows] = await Promise.all([rewardRowsPromise, claimRowsPromise]);

  for (const row of rewardRows) {
    const battleId = relatedIdToBattleId.get(Number(row.related_id));
    const current = battleId ? stats.get(battleId) : null;
    if (!current) continue;
    current.spectators += normalizePositiveNumber(row.spectators);
    current.spectatorBantCredits += normalizePositiveNumber(row.bantcredits);
    current.bantCreditsEarned = current.spectatorBantCredits + current.rewardClaimBantCredits;
  }

  for (const row of claimRows) {
    const current = stats.get(String(row.battle_id));
    if (!current) continue;
    current.spectators = Math.max(current.spectators, normalizePositiveNumber(row.spectator_accounts));
    current.rewardClaimBantCredits += normalizePositiveNumber(row.bantcredits);
    current.bantCreditsEarned = current.spectatorBantCredits + current.rewardClaimBantCredits;
  }

  for (const [battleId, value] of stats) {
    if (hasPositiveBattleStats(value) || !battleStatsCache.has(battleId)) {
      battleStatsCache.set(battleId, { value: { ...value }, cachedAt: Date.now() });
    }
  }

  return stats;
}

async function getFighterLiveStats(
  refs: FighterRef[],
  options: FighterLiveStatsOptions = {},
): Promise<Map<string, FighterLiveStats>> {
  const includeBattleLiveStats = options.includeBattleLiveStats !== false;
  const updatedAt = new Date().toISOString();
  const normalizedRefs = refs
    .map((ref) => ({
      id: String(ref.id || "").trim(),
      walletAddress: normalizeEvmAddress(ref.walletAddress),
      lastBattleId: String(ref.lastBattleId || "").trim() || null,
    }))
    .filter((ref) => ref.id);
  const ids = uniqueValues(normalizedRefs.map((ref) => ref.id));
  const wallets = uniqueValues(normalizedRefs.map((ref) => ref.walletAddress)).map((wallet) => wallet.toLowerCase());
  const idArray = sqlTextArray(ids);
  const walletArray = sqlTextArray(wallets);
  const stats = new Map<string, FighterLiveStats>(
    ids.map((id) => [id, getCachedFighterStats(id, updatedAt)]),
  );
  if (ids.length === 0) return stats;

  const walletToIds = new Map<string, string[]>();
  for (const ref of normalizedRefs) {
    if (!ref.walletAddress) continue;
    const wallet = ref.walletAddress.toLowerCase();
    walletToIds.set(wallet, [...(walletToIds.get(wallet) || []), ref.id]);
  }

  const agentRowsPromise = safeRows<{
    agent_id: string;
    wallet_address: string | null;
    owner_wallet_address: string | null;
    points: string | number;
  }>(
    db.execute(sql`
      SELECT
        "agent_id"::text,
        lower("wallet_address") AS "wallet_address",
        lower("owner_wallet_address") AS "owner_wallet_address",
        COALESCE("points", 0) AS "points"
      FROM "agents"
      WHERE "agent_id"::text = ANY(${idArray})
         OR (${wallets.length > 0} AND lower("wallet_address") = ANY(${walletArray}))
         OR (${wallets.length > 0} AND lower("owner_wallet_address") = ANY(${walletArray}))
    `),
    "fighter agent BantCredit stats",
  );

  const userRowsPromise =
    wallets.length > 0
      ? safeRows<{
      primary_wallet_address: string | null;
      wallet_addresses: unknown;
      points: string | number;
        }>(
          db.execute(sql`
            SELECT
              lower("primary_wallet_address") AS "primary_wallet_address",
              "wallet_addresses",
              COALESCE("points", 0) AS "points"
            FROM "users"
            WHERE lower("primary_wallet_address") = ANY(${walletArray})
               OR EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements_text(COALESCE("wallet_addresses", '[]'::jsonb)) AS wallet(value)
                 WHERE lower(wallet.value) = ANY(${walletArray})
               )
          `),
          "fighter owner BantCredit stats",
        )
      : Promise.resolve([]);

  const simRewardRowsPromise =
    wallets.length > 0
      ? hasSimRewardClaimTable().then((hasTable) =>
          hasTable
            ? safeRows<{ account: string; amount: string | number }>(
        db.execute(sql`
          SELECT lower("account") AS "account", COALESCE(SUM("amount"), 0) AS "amount"
          FROM "onchain_sim_battle_reward_claims"
          WHERE lower("account") = ANY(${walletArray})
            AND "role" IN ('ENS_OWNER', 'EXTERNAL_AGENT_OWNER', 'FIGHTER_OWNER', 'BONUS')
            AND "status" IN ('draft', 'claimable', 'claimed')
          GROUP BY lower("account")
        `),
        "fighter sim reward BantCredit stats",
              )
            : Promise.resolve([]),
        )
      : Promise.resolve([]);

  const battleIds = uniqueValues(normalizedRefs.map((ref) => ref.lastBattleId));
  const battleStatsPromise = includeBattleLiveStats
    ? getBotaBattleLiveStats(battleIds)
    : Promise.resolve(new Map<string, BattleLiveStats>());

  const [agentRows, userRows, claimRows, battleStats] = await Promise.all([
    agentRowsPromise,
    userRowsPromise,
    simRewardRowsPromise,
    battleStatsPromise,
  ]);

  for (const row of agentRows) {
    const points = normalizePositiveNumber(row.points);
    const matchedIds = new Set<string>();
    if (stats.has(row.agent_id)) matchedIds.add(row.agent_id);
    for (const wallet of [row.wallet_address, row.owner_wallet_address]) {
      for (const id of wallet ? walletToIds.get(wallet) || [] : []) matchedIds.add(id);
    }
    for (const id of matchedIds) {
      const current = stats.get(id);
      if (!current) continue;
      current.currentAgentBantCredits += points;
      current.bantCreditsEarned += points;
    }
  }

  for (const row of userRows) {
    const points = normalizePositiveNumber(row.points);
    const matchedIds = new Set<string>();
    const walletCandidates = [
      row.primary_wallet_address,
      ...(Array.isArray(row.wallet_addresses) ? row.wallet_addresses : []),
    ];
    for (const value of walletCandidates) {
      const wallet = normalizeEvmAddress(String(value || ""))?.toLowerCase();
      for (const id of wallet ? walletToIds.get(wallet) || [] : []) matchedIds.add(id);
    }
    for (const id of matchedIds) {
      const current = stats.get(id);
      if (!current) continue;
      current.currentUserBantCredits += points;
      current.bantCreditsEarned += points;
    }
  }

  for (const row of claimRows) {
    const points = normalizePositiveNumber(row.amount);
    for (const id of walletToIds.get(String(row.account || "").toLowerCase()) || []) {
      const current = stats.get(id);
      if (!current) continue;
      current.simRewardBantCredits += points;
      current.bantCreditsEarned += points;
    }
  }

  for (const ref of normalizedRefs) {
    if (!ref.lastBattleId) continue;
    const current = stats.get(ref.id);
    const battle = battleStats.get(ref.lastBattleId);
    if (current && battle) current.liveSpectators = battle.spectators;
  }

  for (const [id, value] of stats) {
    if (hasPositiveFighterStats(value) || !fighterStatsCache.has(id)) {
      fighterStatsCache.set(id, { value: { ...value }, cachedAt: Date.now() });
    }
  }

  return stats;
}

export async function attachBotaFighterLiveStats<T extends BotaFighterProfile>(profiles: T[]): Promise<T[]> {
  const stats = await getFighterLiveStats(
    profiles.map((profile) => ({
      id: profile.agentId,
      walletAddress: profile.walletAddress,
      lastBattleId: profile.lastBattleId,
    })),
  );

  return profiles.map((profile) => {
    const live = stats.get(profile.agentId);
    const profileMetadata = metadataRecord(profile.metadata);
    const existingLiveStats = metadataRecord(profileMetadata.liveStats);
    const existingBantCredits = Math.max(
      normalizePositiveNumber(profile.bantCreditsEarned),
      normalizePositiveNumber(profileMetadata.bantCreditsEarned),
      normalizePositiveNumber(existingLiveStats.bantCreditsEarned),
    );
    const existingLiveSpectators = Math.max(
      normalizePositiveNumber(profile.liveSpectators),
      normalizePositiveNumber(profileMetadata.liveSpectators),
      normalizePositiveNumber(existingLiveStats.liveSpectators),
    );
    const liveStats = {
      bantCreditsEarned: Math.max(existingBantCredits, normalizePositiveNumber(live?.bantCreditsEarned)),
      currentUserBantCredits: live?.currentUserBantCredits || 0,
      currentAgentBantCredits: live?.currentAgentBantCredits || 0,
      simRewardBantCredits: live?.simRewardBantCredits || 0,
      liveSpectators: Math.max(existingLiveSpectators, normalizePositiveNumber(live?.liveSpectators)),
      updatedAt: live?.updatedAt || new Date().toISOString(),
    };
    return {
      ...profile,
      bantCreditsEarned: liveStats.bantCreditsEarned,
      liveSpectators: liveStats.liveSpectators,
      liveStats,
      metadata: {
        ...profile.metadata,
        bantCreditsEarned: liveStats.bantCreditsEarned,
        liveSpectators: liveStats.liveSpectators,
        liveStats,
      },
    };
  });
}

export async function hydrateAgentBattleFeedLiveStats(feed: BantahBroAgentBattlesFeed): Promise<BantahBroAgentBattlesFeed> {
  const [battleStats, fighterStats, loadoutMap] = await Promise.all([
    getBotaBattleLiveStats(feed.battles.map((battle) => battle.id)),
    getFighterLiveStats(
      feed.battles.flatMap((battle) =>
        battle.sides.map((side) => ({
          id: side.id,
          walletAddress: side.tokenAddress,
          lastBattleId: battle.id,
        })),
      ),
      { includeBattleLiveStats: false },
    ),
    getFighterToolLoadoutMap(
      feed.battles.flatMap((battle) => battle.sides.map((side) => side.id)),
    ),
  ]);

  return {
    ...feed,
    battles: feed.battles.map((battle) => {
      const live = battleStats.get(battle.id);
      const spectatorCount = Math.max(
        normalizePositiveNumber(battle.spectators),
        normalizePositiveNumber(live?.spectators),
      );
      const spectatorBantCredits = Math.max(
        normalizePositiveNumber(battle.spectatorBantCredits),
        normalizePositiveNumber(live?.spectatorBantCredits),
      );
      const rewardClaimBantCredits = Math.max(
        normalizePositiveNumber(battle.rewardClaimBantCredits),
        normalizePositiveNumber(live?.rewardClaimBantCredits),
      );
      const bantCreditsEarned = Math.max(
        normalizePositiveNumber(battle.bantCreditsEarned),
        normalizePositiveNumber(live?.bantCreditsEarned),
        spectatorBantCredits + rewardClaimBantCredits,
      );
      return {
        ...battle,
        spectators: spectatorCount,
        spectatorBantCredits,
        rewardClaimBantCredits,
        bantCreditsEarned,
        liveStatsUpdatedAt: live?.updatedAt || new Date().toISOString(),
        sides: battle.sides.map((side) => {
          const sideStats = fighterStats.get(side.id);
          const rawLoadouts = loadoutMap.get(side.id) || [];
          const loadoutTools = rawLoadouts.map((row) => {
            const metadata = (row.tool_metadata && typeof row.tool_metadata === 'object' && !Array.isArray(row.tool_metadata)) ? row.tool_metadata as any : {};
            return {
              id: String(row.tool_id || ""),
              name: String(row.tool_name || ""),
              imageUrl: String(metadata.imageUrl || ""),
              type: String(metadata.tacticalEffect || ""),
            };
          });

          return {
            ...side,
            bantCreditsEarned: Math.max(
              normalizePositiveNumber(side.bantCreditsEarned),
              normalizePositiveNumber(sideStats?.bantCreditsEarned),
            ),
            liveSpectators: Math.max(
              normalizePositiveNumber(side.liveSpectators),
              normalizePositiveNumber(sideStats?.liveSpectators),
              spectatorCount,
            ),
            loadoutTools,
          };
        }) as BantahBroAgentBattle["sides"],
      };
    }),
  };
}
