import { sql } from "drizzle-orm";
import { db } from "../db";
import { publishOnchainSimBattleRewardsForRecord } from "../onchainSimBattleClaimService";
import { getLiveBantahBroAgentBattles } from "./agentBattleService";
import { recordBotaArenaBattleFromLiveBattle } from "./botaArenaBattleRecordService";

function rowsOf<T = any>(result: any): T[] {
  return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.round(parsed), max));
}

function parseBoolean(value: unknown, fallback: boolean) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

async function getPublishedBattleIds(chainId: number) {
  try {
    const result = await db.execute(sql`
      SELECT DISTINCT "battle_id"
      FROM "onchain_sim_battle_reward_claims"
      WHERE "battle_tx_hash" IS NOT NULL
        AND "batch_tx_hash" IS NOT NULL
        AND "chain_id" = ${chainId}
    `);
    return new Set(rowsOf<{ battle_id: string }>(result).map((row) => String(row.battle_id)));
  } catch (error: any) {
    if (/does not exist|to_regclass/i.test(String(error?.message || ""))) {
      return new Set<string>();
    }
    throw error;
  }
}

export async function runBotaLiveOnchainRecorderOnce(options: {
  limit?: number | null;
  scanLimit?: number | null;
  chainId?: number | null;
  execute?: boolean | null;
} = {}) {
  const limit = clampInteger(
    options.limit ?? process.env.BOTA_ONCHAIN_RECORDER_LIMIT,
    5,
    1,
    8,
  );
  const scanLimit = clampInteger(
    options.scanLimit ?? process.env.BOTA_ONCHAIN_RECORDER_SCAN_LIMIT,
    50,
    limit,
    50,
  );
  const chainId = clampInteger(
    options.chainId ?? process.env.BOTA_ONCHAIN_RECORDER_CHAIN_ID,
    8453,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const execute =
    typeof options.execute === "boolean"
      ? options.execute
      : parseBoolean(process.env.BOTA_ONCHAIN_RECORDER_EXECUTE, true);

  const feed = await getLiveBantahBroAgentBattles(scanLimit);
  const publishedBattleIds = await getPublishedBattleIds(chainId);
  const results: Array<Record<string, unknown>> = [];
  let recorded = 0;
  let skipped = 0;
  let failed = 0;

  for (const battle of feed.battles) {
    if (recorded >= limit) break;

    if (publishedBattleIds.has(battle.id)) {
      skipped += 1;
      results.push({
        battleId: battle.id,
        title: battle.title,
        status: "skipped-already-published",
      });
      continue;
    }

    try {
      const stored = await recordBotaArenaBattleFromLiveBattle({
        battleId: battle.id,
        battle,
        maxRounds: 5,
        arenaId: "bota-main",
      });
      const published = await publishOnchainSimBattleRewardsForRecord({
        record: stored.record,
        battle,
        chainId,
        execute,
      });

      if (published.skippedReason) {
        skipped += 1;
        results.push({
          battleId: battle.id,
          recordId: stored.record.id,
          title: battle.title,
          status: "skipped",
          reason: published.skippedReason,
        });
        continue;
      }

      recorded += 1;
      results.push({
        battleId: battle.id,
        recordId: stored.record.id,
        title: battle.title,
        inserted: stored.inserted,
        status: "recorded",
        mode: published.mode,
        claims: published.claims.length,
        totalBantCredits: published.totalBantCredits,
        recordTxHash: published.recordTxHash,
        rewardBatchTxHash: published.rewardBatchTxHash,
      });
    } catch (error: any) {
      failed += 1;
      results.push({
        battleId: battle.id,
        title: battle.title,
        status: "error",
        error: error?.shortMessage || error?.message || String(error),
      });
    }
  }

  return {
    requested: limit,
    scanLimit,
    liveBattles: feed.battles.length,
    chainId,
    execute,
    recorded,
    skipped,
    failed,
    results,
    updatedAt: new Date().toISOString(),
  };
}
