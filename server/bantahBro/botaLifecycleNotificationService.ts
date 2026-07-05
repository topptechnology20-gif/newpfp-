import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { transactions, users } from "@shared/schema";
import type { BotaFighterProfile } from "@shared/botaFighterProfile";
import { BANTCREDIT_AGENT_WIN_REWARD } from "@shared/bantCredit";
import {
  getLiveBantahBroAgentBattles,
  getUpcomingBotaArenaQueue,
  type BantahBroAgentBattle,
  type BantahBroAgentBattleSide,
} from "./agentBattleService";
import {
  applyBotaArenaBattleResultToFighterProfiles,
  getBotaFighterAgentIdForBattleSide,
  getBotaFighterProfile,
} from "./botaFighterProfileService";
import { simulateBotaArenaBattleFromLiveBattle } from "./botaArenaEngine";
import {
  broadcastBotaTelegramEvent,
  notifyBotaLeaderboardRankChange,
  notifyBotaUser,
} from "./botaNotificationService";
import {
  ensureBotaAgentChallengesTable,
  getBotaAgentChallengeByCode,
  type BotaAgentChallenge,
} from "./botaAgentChallengeService";
import { recordLiveBotaArenaBattles } from "./botaArenaBattleRecordService";
import {
  notifyBotaAgentChallengeBantCreditUpdated,
  notifyBotaAgentChallengeFinished,
  notifyBotaAgentChallengeStartingNow,
  notifyBotaAgentChallengeStartingSoon,
} from "./botaAgentChallengeNotificationService";

type TableResult<T = Record<string, unknown>> = T[] | { rows?: T[] };

type ArenaLifecycleStage =
  | "queue_entered"
  | "matched"
  | "starting_soon"
  | "starting_now";

type ChallengeLifecycleResult = {
  startingSoon: number;
  startingNow: number;
  resolved: number;
  bantCreditAwards: number;
};

type RunLifecycleOptions = {
  liveBattles?: BantahBroAgentBattle[];
  includeUpcomingArena?: boolean;
  includeLiveArena?: boolean;
  includeArenaRecording?: boolean;
  includeChallenges?: boolean;
  limit?: number;
};

let ensureDeliveryTablePromise: Promise<void> | null = null;

function tableRows<T = Record<string, unknown>>(result: TableResult<T>): T[] {
  return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
}

function ensureBotaLifecycleDeliveryTable() {
  if (!ensureDeliveryTablePromise) {
    ensureDeliveryTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bota_lifecycle_notification_deliveries" (
        "delivery_key" varchar(420) PRIMARY KEY NOT NULL,
        "user_id" varchar(255),
        "type" varchar(96) NOT NULL,
        "subject_id" varchar(255) NOT NULL,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "delivered_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_bota_lifecycle_notification_deliveries_user"
        ON "bota_lifecycle_notification_deliveries" ("user_id");
      CREATE INDEX IF NOT EXISTS "idx_bota_lifecycle_notification_deliveries_subject"
        ON "bota_lifecycle_notification_deliveries" ("subject_id");
      CREATE INDEX IF NOT EXISTS "idx_bota_lifecycle_notification_deliveries_delivered"
        ON "bota_lifecycle_notification_deliveries" ("delivered_at");
    `).then(() => undefined);
  }
  return ensureDeliveryTablePromise;
}

function compactDeliveryKey(value: string) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 420);
}

async function claimLifecycleDelivery(input: {
  key: string;
  userId?: string | null;
  type: string;
  subjectId: string;
  metadata?: Record<string, unknown>;
}) {
  await ensureBotaLifecycleDeliveryTable();
  const result = await db.execute(sql`
    INSERT INTO "bota_lifecycle_notification_deliveries" (
      "delivery_key",
      "user_id",
      "type",
      "subject_id",
      "metadata"
    )
    VALUES (
      ${compactDeliveryKey(input.key)},
      ${input.userId || null},
      ${input.type},
      ${input.subjectId},
      ${JSON.stringify(input.metadata || {})}::jsonb
    )
    ON CONFLICT ("delivery_key") DO NOTHING
    RETURNING "delivery_key";
  `);

  return tableRows(result).length > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function ownerUserIdForProfile(profile: BotaFighterProfile | null | undefined) {
  const metadata = asRecord(profile?.metadata);
  const candidates = [
    metadata.importedByUserId,
    metadata.ownerUserId,
    metadata.userId,
    metadata.ownerId,
  ];

  for (const candidate of candidates) {
    const userId = String(candidate || "").trim();
    if (userId) return userId;
  }

  return null;
}

function fighterData(profile: BotaFighterProfile | null | undefined) {
  if (!profile) return null;
  return {
    agentId: profile.agentId,
    displayName: profile.displayName,
    origin: profile.origin,
    rank: profile.rank,
    wins: profile.wins,
    losses: profile.losses,
    bantCreditsEarned: profile.bantCreditsEarned,
  };
}

function formatStartTime(value: string | Date | null | undefined) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "soon";
  return date.toUTCString();
}

function stablePositiveInteger(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash % 2_000_000_000);
}

function parseBooleanEnv(name: string, fallback: boolean) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function getChallengeDurationMinutes() {
  const configured = Number.parseInt(
    String(process.env.BANTAHBRO_AGENT_BATTLE_DURATION_MINUTES || "").trim(),
    10,
  );
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
}

async function profileForBattleSide(side: BantahBroAgentBattleSide) {
  const agentId = getBotaFighterAgentIdForBattleSide(side);
  return getBotaFighterProfile(agentId, false);
}

function arenaStageMessage(input: {
  stage: ArenaLifecycleStage;
  fighterName: string;
  opponentName: string;
  startsAt: string;
}) {
  const starts = formatStartTime(input.startsAt);
  if (input.stage === "queue_entered") {
    return {
      type: "bota_fighter_queue_entered",
      title: "Arena queue",
      message: `${input.fighterName} has entered the next Arena queue.`,
      priority: 3,
      fomoLevel: "high",
    };
  }
  if (input.stage === "matched") {
    return {
      type: "bota_fighter_matched",
      title: "Arena match found",
      message: `${input.fighterName} is matched against ${input.opponentName}. Fight starts ${starts}.`,
      priority: 4,
      fomoLevel: "urgent",
    };
  }
  if (input.stage === "starting_soon") {
    return {
      type: "bota_fighter_fight_starting_soon",
      title: "Arena starts in 3 minutes",
      message: `${input.fighterName} faces ${input.opponentName} in about 3 minutes.`,
      priority: 4,
      fomoLevel: "urgent",
    };
  }
  return {
    type: "bota_fighter_fight_starting_now",
    title: "Arena fight starting now",
    message: `${input.fighterName} vs ${input.opponentName} is live now.`,
    priority: 4,
    fomoLevel: "urgent",
  };
}

async function notifyArenaBattleStage(battle: BantahBroAgentBattle, stage: ArenaLifecycleStage) {
  const [leftProfile, rightProfile] = await Promise.all(
    battle.sides.map((side) => profileForBattleSide(side)),
  );
  const profiles = [leftProfile, rightProfile] as const;
  const notifications: Array<Promise<unknown>> = [];

  for (let index = 0; index < battle.sides.length; index += 1) {
    const profile = profiles[index];
    const opponent = profiles[index === 0 ? 1 : 0];
    const side = battle.sides[index];
    const opponentSide = battle.sides[index === 0 ? 1 : 0];
    const userId = ownerUserIdForProfile(profile);
    if (!profile || !userId) continue;

    const opponentName = opponent?.displayName || opponentSide.agentName || opponentSide.label;
    const intent = arenaStageMessage({
      stage,
      fighterName: profile.displayName || side.agentName,
      opponentName,
      startsAt: battle.startsAt,
    });
    const deliveryKey = [
      "arena",
      stage,
      battle.id,
      battle.startsAt,
      profile.agentId,
      userId,
    ].join(":");

    const shouldSend = await claimLifecycleDelivery({
      key: deliveryKey,
      userId,
      type: intent.type,
      subjectId: battle.id,
      metadata: {
        battleId: battle.id,
        stage,
        startsAt: battle.startsAt,
        fighterAgentId: profile.agentId,
        opponentAgentId: opponent?.agentId || opponentSide.id,
      },
    });
    if (!shouldSend) continue;

    notifications.push(
      notifyBotaUser({
        userId,
        type: intent.type,
        title: intent.title,
        message: intent.message,
        icon: "B",
        url: `/bota?section=battles&battle=${encodeURIComponent(battle.id)}`,
        data: {
          battleId: battle.id,
          stage,
          startsAt: battle.startsAt,
          endsAt: battle.endsAt,
          fighter: fighterData(profile),
          opponent: fighterData(opponent),
        },
        priority: intent.priority,
        fomoLevel: intent.fomoLevel,
      }),
    );
  }

  await Promise.allSettled(notifications);
  return notifications.length;
}

async function notifyUpcomingArenaQueue(battles: BantahBroAgentBattle[]) {
  let sent = 0;
  const now = Date.now();
  for (const battle of battles) {
    sent += await notifyArenaBattleStage(battle, "queue_entered");
    sent += await notifyArenaBattleStage(battle, "matched");

    const startsAtMs = new Date(battle.startsAt).getTime();
    const startsInMs = startsAtMs - now;
    if (Number.isFinite(startsInMs) && startsInMs > 0 && startsInMs <= 3 * 60 * 1000 + 30_000) {
      sent += await notifyArenaBattleStage(battle, "starting_soon");
    }
  }
  return sent;
}

async function notifyLiveArenaStarts(battles: BantahBroAgentBattle[]) {
  let sent = 0;
  const now = Date.now();
  for (const battle of battles) {
    const startsAtMs = new Date(battle.startsAt).getTime();
    const endsAtMs = new Date(battle.endsAt).getTime();
    if (
      Number.isFinite(startsAtMs) &&
      Number.isFinite(endsAtMs) &&
      startsAtMs <= now &&
      endsAtMs > now
    ) {
      sent += await notifyArenaBattleStage(battle, "starting_now");
    }
  }
  return sent;
}

function parseChallengeRecord(record: string | null | undefined) {
  const [wins, losses] = String(record || "0-0")
    .split("-")
    .map((value) => Number.parseInt(value, 10));
  return {
    wins: Number.isFinite(wins) ? wins : 0,
    losses: Number.isFinite(losses) ? losses : 0,
  };
}

function challengeAgentScore(agent: BotaAgentChallenge["challengerAgent"]) {
  const record = parseChallengeRecord(agent.record);
  const rankScore = agent.rank ? Math.max(0, 120 - agent.rank) : 40;
  return Math.max(1, Math.round(rankScore + record.wins * 8 - record.losses * 3));
}

function challengeSide(
  challenge: BotaAgentChallenge,
  side: "challenger" | "opponent",
  confidence: number,
): BantahBroAgentBattleSide {
  const agent = side === "challenger" ? challenge.challengerAgent : challenge.opponentAgent;
  const score = challengeAgentScore(agent);
  return {
    id: agent.id,
    label: side === "challenger" ? "YES" : "NO",
    agentName: agent.name,
    tokenSymbol: agent.tokenSymbol,
    tokenName: agent.name,
    emoji: side === "challenger" ? "YES" : "NO",
    logoUrl: agent.avatarUrl,
    chainId: null,
    chainLabel: "BOTA",
    tokenAddress: null,
    pairAddress: null,
    pairUrl: null,
    dexId: null,
    priceUsd: null,
    priceDisplay: agent.rank ? `#${agent.rank}` : agent.league,
    priceChangeM5: 0,
    priceChangeH1: 0,
    priceChangeH24: 0,
    change: "0%",
    direction: "flat",
    volumeM5: 0,
    volumeH1: 0,
    volumeH24: 0,
    liquidityUsd: 0,
    marketCap: null,
    buysM5: parseChallengeRecord(agent.record).wins,
    sellsM5: parseChallengeRecord(agent.record).losses,
    buysH1: 0,
    sellsH1: 0,
    buysH24: parseChallengeRecord(agent.record).wins,
    sellsH24: parseChallengeRecord(agent.record).losses,
    pairAgeMinutes: null,
    dataSource: "fighter-profile",
    dataUpdatedAt: new Date().toISOString(),
    score,
    confidence,
    leaderboardRank: agent.rank || undefined,
    rank: agent.rank || undefined,
    status: side === "challenger" ? "attacking" : "defending",
  };
}

function buildChallengeBattle(challenge: BotaAgentChallenge): BantahBroAgentBattle {
  const leftScore = challengeAgentScore(challenge.challengerAgent);
  const rightScore = challengeAgentScore(challenge.opponentAgent);
  const total = Math.max(1, leftScore + rightScore);
  const leftConfidence = Math.max(5, Math.min(95, Math.round((leftScore / total) * 100)));
  const rightConfidence = 100 - leftConfidence;
  const scheduledAt = challenge.scheduledAt || challenge.acceptedAt || challenge.createdAt;
  const startsAt = new Date(scheduledAt);
  const endsAt = new Date(startsAt.getTime() + getChallengeDurationMinutes() * 60_000);
  const left = challengeSide(challenge, "challenger", leftConfidence);
  const right = challengeSide(challenge, "opponent", rightConfidence);

  return {
    id: `challenge:${challenge.challengeCode}`,
    title: `${challenge.challengerAgent.name} vs ${challenge.opponentAgent.name}`,
    battleType: "agent-battle",
    status: endsAt.getTime() > Date.now() ? "live" : "expired",
    winnerLogic:
      "BOTA Challenge Engine: challenger/opponent fighter rank, record, and deterministic battle simulation decide this challenge.",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    timeRemainingSeconds: Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 1000)),
    spectators: 0,
    spectatorBantCredits: 0,
    rewardClaimBantCredits: 0,
    bantCreditsEarned: 0,
    sides: [left, right],
    leadingSideId: leftConfidence >= rightConfidence ? left.id : right.id,
    confidenceSpread: Math.abs(leftConfidence - rightConfidence),
    events: [],
    updatedAt: new Date().toISOString(),
  };
}

async function awardChallengeWinBantCredit(input: {
  challenge: BotaAgentChallenge;
  userId?: string | null;
  amount: number;
}) {
  const userId = String(input.userId || "").trim();
  const amount = Math.max(0, Math.round(input.amount || 0));
  if (!userId || amount <= 0) return false;

  await ensureBotaLifecycleDeliveryTable();
  const deliveryKey = compactDeliveryKey(
    `challenge:bantcredit:${input.challenge.challengeCode}:${userId}`,
  );
  const transactionRelatedId = stablePositiveInteger(
    `bota-challenge-win:${input.challenge.challengeCode}:${userId}`,
  );

  return db.transaction(async (tx) => {
    const inserted = tableRows(
      await tx.execute(sql`
        INSERT INTO "bota_lifecycle_notification_deliveries" (
          "delivery_key",
          "user_id",
          "type",
          "subject_id",
          "metadata"
        )
        VALUES (
          ${deliveryKey},
          ${userId},
          'bota_agent_challenge_bantcredit_awarded',
          ${input.challenge.challengeCode},
          ${JSON.stringify({ amount, challengeCode: input.challenge.challengeCode })}::jsonb
        )
        ON CONFLICT ("delivery_key") DO NOTHING
        RETURNING "delivery_key";
      `),
    );

    if (!inserted.length) return false;

    await tx
      .update(users)
      .set({
        points: sql`COALESCE(${users.points}, 0) + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    await tx.insert(transactions).values({
      userId,
      type: "challenge_win_reward",
      amount: String(amount),
      description: `BOTA challenge win reward for ${input.challenge.challengeCode}`,
      relatedId: transactionRelatedId,
      status: "completed",
    });

    return true;
  });
}

async function notifyScheduledChallengesStartingSoon(limit: number) {
  await ensureBotaAgentChallengesTable();
  const rows = tableRows<{ challenge_code: string }>(
    await db.execute(sql`
      SELECT "challenge_code"
      FROM "bota_agent_pvp_challenges"
      WHERE "status" = 'scheduled'
        AND "scheduled_at" IS NOT NULL
        AND "scheduled_at" > now()
        AND "scheduled_at" <= now() + interval '5 minutes'
      ORDER BY "scheduled_at" ASC
      LIMIT ${limit};
    `),
  );
  let sent = 0;

  for (const row of rows) {
    const challengeCode = String(row.challenge_code || "").trim();
    const challenge = await getBotaAgentChallengeByCode({ challengeCode });
    if (!challenge) continue;

    const claimed = await claimLifecycleDelivery({
      key: `challenge:starting-soon:${challenge.challengeCode}`,
      userId: challenge.challengerUserId,
      type: "bota_agent_challenge_starting_soon",
      subjectId: challenge.challengeCode,
      metadata: { challengeCode: challenge.challengeCode, scheduledAt: challenge.scheduledAt },
    });
    if (!claimed) continue;

    await notifyBotaAgentChallengeStartingSoon(challenge, 5);
    sent += 1;
  }

  return sent;
}

async function notifyScheduledChallengesStartingNow(limit: number) {
  await ensureBotaAgentChallengesTable();
  const rows = tableRows<{ challenge_code: string }>(
    await db.execute(sql`
      UPDATE "bota_agent_pvp_challenges"
      SET
        "status" = 'live',
        "updated_at" = now(),
        "metadata" = "metadata" || ${JSON.stringify({ lifecycleStatus: "live" })}::jsonb
      WHERE "status" = 'scheduled'
        AND "scheduled_at" IS NOT NULL
        AND "scheduled_at" <= now()
      RETURNING "challenge_code";
    `),
  );
  let sent = 0;

  for (const row of rows.slice(0, limit)) {
    const challengeCode = String(row.challenge_code || "").trim();
    const challenge = await getBotaAgentChallengeByCode({ challengeCode });
    if (!challenge) continue;

    const claimed = await claimLifecycleDelivery({
      key: `challenge:starting-now:${challenge.challengeCode}`,
      userId: challenge.challengerUserId,
      type: "bota_agent_challenge_starting_now",
      subjectId: challenge.challengeCode,
      metadata: { challengeCode: challenge.challengeCode, scheduledAt: challenge.scheduledAt },
    });
    if (!claimed) continue;

    await notifyBotaAgentChallengeStartingNow(challenge);
    sent += 1;
  }

  return sent;
}

async function resolveDueLiveChallenges(limit: number) {
  await ensureBotaAgentChallengesTable();
  const durationMinutes = getChallengeDurationMinutes();
  const rows = tableRows<{ challenge_code: string }>(
    await db.execute(sql`
      SELECT "challenge_code"
      FROM "bota_agent_pvp_challenges"
      WHERE "status" = 'live'
        AND "scheduled_at" IS NOT NULL
        AND "scheduled_at" <= now() - (${durationMinutes} * interval '1 minute')
      ORDER BY "scheduled_at" ASC
      LIMIT ${limit};
    `),
  );

  let resolved = 0;
  let bantCreditAwards = 0;

  for (const row of rows) {
    const challengeCode = String(row.challenge_code || "").trim();
    const challenge = await getBotaAgentChallengeByCode({ challengeCode });
    if (!challenge) continue;

    const battle = buildChallengeBattle(challenge);
    const simulation = await simulateBotaArenaBattleFromLiveBattle(battle, {
      seed: `bota-challenge:${challenge.challengeCode}:${challenge.scheduledAt || challenge.acceptedAt}`,
      maxRounds: 5,
    });
    const winnerSideId = simulation.finalState.winnerId;
    const winnerSide = winnerSideId
      ? battle.sides.find((side) => side.id === winnerSideId) || null
      : null;
    const loserSide = winnerSideId
      ? battle.sides.find((side) => side.id !== winnerSideId) || null
      : null;
    const winnerUserId =
      winnerSide?.id === challenge.challengerAgent.id
        ? challenge.challengerUserId
        : winnerSide?.id === challenge.opponentAgent.id
          ? challenge.opponentOwnerUserId
          : null;
    const loserUserId =
      loserSide?.id === challenge.challengerAgent.id
        ? challenge.challengerUserId
        : loserSide?.id === challenge.opponentAgent.id
          ? challenge.opponentOwnerUserId
          : null;
    const status = winnerSideId ? "resolved" : "draw";
    const metadata = {
      lifecycleStatus: "resolved",
      result: {
        status,
        winnerSideId,
        winnerAgentId: winnerSide?.id || null,
        winnerAgentName: winnerSide?.agentName || null,
        loserAgentId: loserSide?.id || null,
        loserAgentName: loserSide?.agentName || null,
        rounds: simulation.finalState.round,
        resolutionReason: simulation.finalState.resolutionReason,
        resolvedAt: new Date().toISOString(),
      },
    };

    const updated = tableRows(
      await db.execute(sql`
        UPDATE "bota_agent_pvp_challenges"
        SET
          "status" = 'resolved',
          "updated_at" = now(),
          "metadata" = "metadata" || ${JSON.stringify(metadata)}::jsonb
        WHERE "challenge_code" = ${challenge.challengeCode}
          AND "status" = 'live'
        RETURNING "challenge_code";
      `),
    );
    if (!updated.length) continue;

    const profileUpdate = await applyBotaArenaBattleResultToFighterProfiles({
      battle,
      winnerSideId,
      loserSideId: loserSide?.id || null,
      recordId: `challenge:${challenge.challengeCode}`,
    });

    const awarded =
      winnerSideId && winnerUserId
        ? await awardChallengeWinBantCredit({
            challenge,
            userId: winnerUserId,
            amount: BANTCREDIT_AGENT_WIN_REWARD,
          })
        : false;
    if (awarded) bantCreditAwards += 1;

    await notifyBotaAgentChallengeFinished({
      challenge,
      winnerAgentName: winnerSide?.agentName || null,
      loserAgentName: loserSide?.agentName || null,
      winnerUserId: winnerSideId ? winnerUserId : challenge.challengerUserId,
      loserUserId: winnerSideId ? loserUserId : challenge.opponentOwnerUserId,
      rounds: simulation.finalState.round,
      rewardBantCredits: awarded ? BANTCREDIT_AGENT_WIN_REWARD : 0,
      resultStatus: status,
    });

    if (awarded) {
      await notifyBotaAgentChallengeBantCreditUpdated({
        challenge,
        userId: winnerUserId,
        amount: BANTCREDIT_AGENT_WIN_REWARD,
        reason: `BOTA challenge win: ${winnerSide?.agentName || "winner"}`,
      });
    }

    await Promise.allSettled(
      (profileUpdate.rankChanges || []).map((change) =>
        notifyBotaLeaderboardRankChange({ ...change, reason: "challenge_result" }),
      ),
    );

    resolved += 1;
  }

  return { resolved, bantCreditAwards };
}

async function runChallengeLifecycle(limit: number): Promise<ChallengeLifecycleResult> {
  const startingSoon = await notifyScheduledChallengesStartingSoon(limit);
  const startingNow = await notifyScheduledChallengesStartingNow(limit);
  const finish = await resolveDueLiveChallenges(limit);

  return {
    startingSoon,
    startingNow,
    resolved: finish.resolved,
    bantCreditAwards: finish.bantCreditAwards,
  };
}

export async function runBotaLifecycleNotificationsOnce(options: RunLifecycleOptions = {}) {
  await ensureBotaLifecycleDeliveryTable();
  const limit = Math.max(1, Math.min(Math.round(options.limit || 50), 50));
  let arenaQueueNotifications = 0;
  let arenaStartNotifications = 0;
  let liveArenaBattles: BantahBroAgentBattle[] | null = null;
  let arenaRecording:
    | Awaited<ReturnType<typeof recordLiveBotaArenaBattles>>
    | {
        requested: number;
        liveBattles: number;
        inserted: number;
        existing: number;
        failed: number;
        results: unknown[];
        skippedReason: string;
        updatedAt: string;
      } = {
        requested: limit,
        liveBattles: 0,
        inserted: 0,
        existing: 0,
        failed: 0,
        results: [],
        skippedReason: "not_run",
        updatedAt: new Date().toISOString(),
      };

  if (options.includeUpcomingArena !== false) {
    const upcoming = await getUpcomingBotaArenaQueue(limit);
    arenaQueueNotifications = await notifyUpcomingArenaQueue(upcoming.battles);
  }

  if (options.includeLiveArena !== false) {
    liveArenaBattles =
      options.liveBattles ||
      (await getLiveBantahBroAgentBattles(limit)).battles;
    arenaStartNotifications = await notifyLiveArenaStarts(liveArenaBattles);

    if (arenaStartNotifications > 0) {
      await broadcastBotaTelegramEvent({
        id: `telegram-bota-arena-starting-${new Date().toISOString().slice(0, 16)}`,
        title: "BOTA ARENA LIVE",
        lines: [
          `${arenaStartNotifications} fighter start notification${arenaStartNotifications === 1 ? "" : "s"} delivered.`,
          "Open BOTA to watch the current round.",
        ],
        url: "/bota?section=battles",
        tags: ["BOTA", "Arena", "Live"],
        market: "BOTA Arena",
      });
    }
  }

  if (
    options.includeArenaRecording !== false &&
    parseBooleanEnv("BOTA_ARENA_AUTO_RECORD_ENABLED", true)
  ) {
    const battlesToRecord =
      liveArenaBattles ||
      options.liveBattles ||
      (await getLiveBantahBroAgentBattles(limit)).battles;

    arenaRecording = await recordLiveBotaArenaBattles({
      battles: battlesToRecord,
      limit,
      arenaId: "bota-main",
      maxRounds: 5,
    });
  }

  const challengeLifecycle =
    options.includeChallenges === false
      ? {
          startingSoon: 0,
          startingNow: 0,
          resolved: 0,
          bantCreditAwards: 0,
        }
      : await runChallengeLifecycle(limit);

  return {
    arenaQueueNotifications,
    arenaStartNotifications,
    arenaRecording,
    challengeLifecycle,
    updatedAt: new Date().toISOString(),
  };
}
