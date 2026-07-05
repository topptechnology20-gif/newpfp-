import webpush from "web-push";
import { storage } from "../storage";
import { pushRealtimeNotification } from "../agentNotificationService";
import { getBantahBroTelegramBot } from "../telegramBot";
import { recordBantahBroTelegramPost } from "./socialFeedService";
import type { BotaFighterProfile } from "@shared/botaFighterProfile";

type BotaNotificationIntent = {
  userId?: string | null;
  type: string;
  title: string;
  message: string;
  icon?: string | null;
  url?: string | null;
  data?: Record<string, unknown>;
  channels?: string[];
  fomoLevel?: string;
  priority?: number;
  expiresAt?: Date | string | null;
};

export type BotaRankChangeNotification = {
  profile: BotaFighterProfile;
  previousRank: number | null;
  nextRank: number | null;
  reason?: string;
};

let webPushConfigured = false;

function configureWebPush() {
  if (webPushConfigured) return;

  const publicKey =
    process.env.VAPID_PUBLIC_KEY ||
    process.env.WEB_PUSH_PUBLIC_KEY ||
    "BKZ0LNy05CTv807lF4dSwM3wB7nxrBHXDP5AYPvbCCPZYWrK08rTYFQO6BmKrW3f0xmIe5wUxtLN67XOSQ7W--o";
  const privateKey =
    process.env.VAPID_PRIVATE_KEY ||
    process.env.WEB_PUSH_PRIVATE_KEY ||
    "uNkb_1Ntqe1IKeqDeAlbyOJcXTt8wrvwArWSh7GML0A";
  const subject = process.env.VAPID_SUBJECT || "mailto:support@bantah.com";

  webpush.setVapidDetails(subject, publicKey, privateKey);
  webPushConfigured = true;
}

function normalizePublicBaseUrl(value: unknown) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function publicBotaUrl(path = "/bota") {
  const base =
    normalizePublicBaseUrl(process.env.FRONTEND_URL) ||
    normalizePublicBaseUrl(process.env.RENDER_EXTERNAL_URL) ||
    normalizePublicBaseUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) ||
    normalizePublicBaseUrl(process.env.VERCEL_URL) ||
    "https://bota.bantah.fun";

  try {
    const baseUrl = new URL(base);
    const normalizedPath =
      baseUrl.hostname.toLowerCase() === "bota.bantah.fun"
        ? path.replace(/^\/bota(?=\/|\?|$)/i, "") || "/"
        : path;
    return new URL(normalizedPath, baseUrl).toString();
  } catch {
    return path;
  }
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toDate(value: Date | string | null | undefined) {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
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
    const value = String(candidate || "").trim();
    if (value) return value;
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
    currentStreak: profile.currentStreak,
    fameScore: profile.fameScore,
    tokenSymbol: profile.tokenSymbol,
    league: profile.league,
    url: "/bota?section=agents",
  };
}

function formatRank(rank: number | null | undefined) {
  return Number.isFinite(Number(rank)) && Number(rank) > 0 ? `#${Number(rank)}` : "unranked";
}

function formatRecord(profile: BotaFighterProfile | null | undefined) {
  if (!profile) return "0W-0L";
  return `${profile.wins}W-${profile.losses}L`;
}

async function sendBrowserPush(userId: string, intent: BotaNotificationIntent) {
  try {
    configureWebPush();
    const subscriptions = await storage.getPushSubscriptions(userId);
    if (!subscriptions.length) return;

    const url = publicBotaUrl(intent.url || "/bota");
    const payload = JSON.stringify({
      title: intent.title,
      body: intent.message,
      icon: "/assets/bota-bantah-icon.png",
      badge: "/assets/bota-bantah-icon.png",
      type: intent.type,
      data: {
        ...(intent.data || {}),
        url,
      },
    });

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription, payload);
        } catch (error: any) {
          if (error?.statusCode === 404 || error?.statusCode === 410) {
            await storage.removePushSubscription(subscription.endpoint);
          } else {
            console.warn("[BOTA] Browser push failed:", error?.message || error);
          }
        }
      }),
    );
  } catch (error) {
    console.warn("[BOTA] Browser push unavailable:", error);
  }
}

async function sendTelegramDm(userId: string, intent: BotaNotificationIntent) {
  try {
    const bot = getBantahBroTelegramBot();
    if (!bot || typeof bot.sendLinkedUserMessage !== "function") return;

    const url = publicBotaUrl(intent.url || "/bota");
    const text = [intent.title, "", intent.message, "", url].join("\n");

    await bot.sendLinkedUserMessage(userId, text, {
      reply_markup: {
        inline_keyboard: [[{ text: "Open BOTA", url }]],
      },
    });
  } catch (error) {
    console.warn("[BOTA] Telegram DM unavailable:", error);
  }
}

export async function notifyBotaUser(intent: BotaNotificationIntent) {
  const userId = String(intent.userId || "").trim();
  if (!userId) return;

  const url = intent.url || "/bota";
  const data = {
    ...(intent.data || {}),
    url,
    publicUrl: publicBotaUrl(url),
  };

  try {
    const notification = await storage.createNotification({
      userId,
      type: intent.type,
      title: intent.title,
      message: intent.message,
      icon: intent.icon || "B",
      data,
      channels: intent.channels || ["in_app_feed", "push_notification", "telegram_bot"],
      fomoLevel: intent.fomoLevel || "medium",
      priority: intent.priority || 2,
      read: false,
      expiresAt: toDate(intent.expiresAt),
    } as any);

    await pushRealtimeNotification(userId, {
      ...notification,
      event: intent.type,
      timestamp: new Date().toISOString(),
    });

    await Promise.allSettled([
      sendBrowserPush(userId, { ...intent, data, url }),
      sendTelegramDm(userId, { ...intent, data, url }),
    ]);
  } catch (error) {
    console.warn("[BOTA] User notification failed:", error);
  }
}

export async function broadcastBotaTelegramEvent(input: {
  id: string;
  title: string;
  lines: string[];
  url?: string | null;
  tags?: string[];
  market?: string | null;
  marketEmoji?: string | null;
}) {
  try {
    const bot = getBantahBroTelegramBot();
    if (!bot || typeof bot.sendCustomHtmlMessage !== "function") return;

    const url = publicBotaUrl(input.url || "/bota");
    const html = [
      `<b>${escapeHtml(input.title)}</b>`,
      "",
      ...input.lines.map((line) => escapeHtml(line)),
      "",
      "Open BOTA to watch, challenge, or follow the fighters.",
    ].join("\n");

    const sent = await bot.sendCustomHtmlMessage(html, {
      inline_keyboard: [[{ text: "Open BOTA", url }]],
    });

    if (sent) {
      await recordBantahBroTelegramPost({
        id: input.id,
        content: [input.title, ...input.lines].join("\n"),
        market: input.market || undefined,
        marketEmoji: input.marketEmoji || "B",
        tags: input.tags || ["BOTA"],
        url,
      });
    }
  } catch (error) {
    console.warn("[BOTA] Telegram group broadcast unavailable:", error);
  }
}

export async function notifyBotaFighterImported(
  profile: BotaFighterProfile,
  actorUserId?: string | null,
) {
  const userId = String(actorUserId || ownerUserIdForProfile(profile) || "").trim();
  const origin = profile.badgeLabel || profile.origin;
  const message =
    `${profile.displayName} is now registered for BOTA Arena from ${origin}. ` +
    `Current rank: ${formatRank(profile.rank)}.`;

  await Promise.allSettled([
    notifyBotaUser({
      userId,
      type: "bota_fighter_imported",
      title: "Fighter imported",
      message,
      icon: "B",
      url: "/bota?section=agents",
      data: { fighter: fighterData(profile) },
      priority: 3,
      fomoLevel: "high",
    }),
    notifyBotaUser({
      userId,
      type: "bota_fighter_queue_entered",
      title: "Arena queue",
      message: `${profile.displayName} has entered the next Arena queue.`,
      icon: "B",
      url: "/bota?section=profile",
      data: {
        fighter: fighterData(profile),
        queueState: "waiting",
      },
      priority: 3,
      fomoLevel: "high",
    }),
    broadcastBotaTelegramEvent({
      id: `telegram-bota-fighter-imported-${profile.agentId}-${Date.now()}`,
      title: "BOTA FIGHTER IMPORTED",
      lines: [
        `${profile.displayName} entered the Arena.`,
        `Source: ${origin}`,
        `Rank: ${formatRank(profile.rank)} | Record: ${formatRecord(profile)}`,
      ],
      url: "/bota?section=agents",
      tags: ["BOTA", "Fighter", "Import", profile.origin],
      market: profile.displayName,
    }),
  ]);
}

export async function notifyBotaFighterQueueReentered(input: {
  fighter: BotaFighterProfile;
  recordId: string;
  outcome: "win" | "loss" | "draw";
}) {
  const userId = ownerUserIdForProfile(input.fighter);
  if (!userId) return;

  const resultLabel =
    input.outcome === "win"
      ? "won and is ready"
      : input.outcome === "loss"
      ? "lost and is ready"
      : "drew and is ready";

  await notifyBotaUser({
    userId,
    type: "bota_fighter_queue_reentered",
    title: "Arena queue ready",
    message: `${input.fighter.displayName} ${resultLabel} for the next Arena queue.`,
    icon: "B",
    url: "/bota?section=profile",
    data: {
      fighter: fighterData(input.fighter),
      recordId: input.recordId,
      outcome: input.outcome,
    },
    priority: 3,
    fomoLevel: "high",
  });
}

export async function notifyBotaLeaderboardRankChange(input: BotaRankChangeNotification) {
  const previousRank = input.previousRank;
  const nextRank = input.nextRank;
  if (!nextRank || previousRank === nextRank) return;

  const improved = !previousRank || nextRank < previousRank;
  const userId = ownerUserIdForProfile(input.profile);
  const message = improved
    ? `${input.profile.displayName} climbed to ${formatRank(nextRank)} on the BOTA leaderboard.`
    : `${input.profile.displayName} moved to ${formatRank(nextRank)} on the BOTA leaderboard.`;
  const shouldBroadcast = improved && nextRank <= 25;

  await Promise.allSettled([
    notifyBotaUser({
      userId,
      type: "bota_leaderboard_rank_changed",
      title: "Leaderboard rank updated",
      message,
      icon: "B",
      url: "/bota?section=leaderboard",
      data: {
        fighter: fighterData(input.profile),
        previousRank,
        nextRank,
        reason: input.reason || null,
      },
      priority: improved ? 3 : 2,
      fomoLevel: improved ? "high" : "medium",
    }),
    shouldBroadcast
      ? broadcastBotaTelegramEvent({
          id: `telegram-bota-rank-${input.profile.agentId}-${previousRank || "new"}-${nextRank}`,
          title: "BOTA LEADERBOARD MOVE",
          lines: [
            `${input.profile.displayName} is now ${formatRank(nextRank)}.`,
            previousRank ? `Previous rank: ${formatRank(previousRank)}` : "New ranked fighter.",
            `Record: ${formatRecord(input.profile)}`,
          ],
          url: "/bota?section=leaderboard",
          tags: ["BOTA", "Leaderboard", "Rank"],
          market: input.profile.displayName,
        })
      : Promise.resolve(),
  ]);
}

export async function notifyBotaArenaBattleOutcome(input: {
  record: {
    id: string;
    title: string;
    status: string;
    rounds: number;
    spectators?: number | null;
    winnerAgentId?: string | null;
    loserAgentId?: string | null;
    metadata?: Record<string, unknown>;
  };
  winnerProfile?: BotaFighterProfile | null;
  loserProfile?: BotaFighterProfile | null;
  rankChanges?: BotaRankChangeNotification[];
}) {
  const winnerName =
    input.winnerProfile?.displayName ||
    String(input.record.metadata?.winnerName || input.record.winnerAgentId || "Arena winner");
  const loserName =
    input.loserProfile?.displayName ||
    String(input.record.metadata?.loserName || input.record.loserAgentId || "opponent");
  const isDraw = input.record.status === "draw";
  const url = `/bota?section=battles&record=${encodeURIComponent(input.record.id)}`;

  const userNotifications = isDraw
    ? []
    : [
        notifyBotaUser({
          userId: ownerUserIdForProfile(input.winnerProfile),
          type: "bota_fighter_win",
          title: "Arena win",
          message: `${winnerName} defeated ${loserName} in ${input.record.rounds} rounds.`,
          icon: "B",
          url,
          data: {
            recordId: input.record.id,
            winner: fighterData(input.winnerProfile),
            loser: fighterData(input.loserProfile),
          },
          priority: 4,
          fomoLevel: "urgent",
        }),
        notifyBotaUser({
          userId: ownerUserIdForProfile(input.loserProfile),
          type: "bota_fighter_defeat",
          title: "Arena defeat",
          message: `${loserName} lost to ${winnerName}. Review the fight and prep the rematch.`,
          icon: "B",
          url,
          data: {
            recordId: input.record.id,
            winner: fighterData(input.winnerProfile),
            loser: fighterData(input.loserProfile),
          },
          priority: 3,
          fomoLevel: "high",
        }),
      ];

  await Promise.allSettled([
    broadcastBotaTelegramEvent({
      id: `telegram-bota-arena-result-${input.record.id}`,
      title: isDraw ? "BOTA ARENA DRAW" : "BOTA ARENA RESULT",
      lines: isDraw
        ? [
            `${input.record.title} ended in a draw.`,
            `Rounds: ${input.record.rounds}`,
            `Spectators: ${Number(input.record.spectators || 0).toLocaleString()}`,
          ]
        : [
            `${winnerName} defeated ${loserName}.`,
            `Rounds: ${input.record.rounds}`,
            `Spectators: ${Number(input.record.spectators || 0).toLocaleString()}`,
          ],
      url,
      tags: ["BOTA", "Arena", isDraw ? "Draw" : "Result"],
      market: input.record.title,
    }),
    ...userNotifications,
    ...((input.rankChanges || []).map((change) =>
      notifyBotaLeaderboardRankChange(change),
    )),
  ]);
}
