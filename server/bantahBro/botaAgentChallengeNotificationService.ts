import webpush from "web-push";
import { storage } from "../storage";
import { pushRealtimeNotification } from "../agentNotificationService";
import { getBantahBroTelegramBot } from "../telegramBot";
import { recordBantahBroTelegramPost } from "./socialFeedService";
import { broadcastBotaTelegramEvent } from "./botaNotificationService";
import type { BotaAgentChallenge } from "./botaAgentChallengeService";

type ChallengeNotificationIntent = {
  userId: string | null | undefined;
  type: string;
  title: string;
  message: string;
  priority?: number;
  fomoLevel?: string;
  data?: Record<string, unknown>;
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

function publicBotaUrl(path: string) {
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

function challengeData(challenge: BotaAgentChallenge) {
  return {
    challengeCode: challenge.challengeCode,
    challengeUrl: challenge.challengeUrl,
    publicUrl: publicBotaUrl(challenge.challengeUrl),
    status: challenge.status,
    matchType: challenge.matchType,
    visibility: challenge.visibility,
    predictionEnabled: challenge.predictionEnabled,
    stakeAmount: challenge.stakeAmount,
    stakeCurrency: challenge.stakeCurrency,
    challengerAgent: challenge.challengerAgent,
    opponentAgent: challenge.opponentAgent,
    scheduledAt: challenge.scheduledAt,
    expiresAt: challenge.expiresAt,
  };
}

function formatStake(challenge: BotaAgentChallenge) {
  return `${challenge.stakeAmount.toLocaleString()} ${challenge.stakeCurrency}`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendBrowserPush(userId: string, intent: ChallengeNotificationIntent, challenge: BotaAgentChallenge) {
  try {
    configureWebPush();
    const subscriptions = await storage.getPushSubscriptions(userId);
    if (!subscriptions.length) return;

    const payload = JSON.stringify({
      title: intent.title,
      body: intent.message,
      icon: "/assets/bota-bantah-icon.png",
      badge: "/assets/bota-bantah-icon.png",
      type: intent.type,
      data: {
        url: challengeData(challenge).publicUrl,
        challengeCode: challenge.challengeCode,
        ...(intent.data || {}),
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
            console.warn("[BOTA] Challenge browser push failed:", error?.message || error);
          }
        }
      }),
    );
  } catch (error) {
    console.warn("[BOTA] Challenge browser push unavailable:", error);
  }
}

async function sendTelegramDm(userId: string, intent: ChallengeNotificationIntent, challenge: BotaAgentChallenge) {
  try {
    const bot = getBantahBroTelegramBot();
    if (!bot || typeof bot.sendLinkedUserMessage !== "function") return;

    const url = challengeData(challenge).publicUrl;
    const text = [
      intent.title,
      "",
      intent.message,
      `Stake: ${formatStake(challenge)}`,
      challenge.scheduledAt ? `Starts: ${new Date(challenge.scheduledAt).toUTCString()}` : `Expires: ${new Date(challenge.expiresAt).toUTCString()}`,
      "",
      url,
    ].join("\n");

    await bot.sendLinkedUserMessage(userId, text, {
      reply_markup: {
        inline_keyboard: [[{ text: "Open Challenge", url }]],
      },
    });
  } catch (error) {
    console.warn("[BOTA] Challenge Telegram DM unavailable:", error);
  }
}

async function broadcastTelegramChallengeAction(
  challenge: BotaAgentChallenge,
  action: "created" | "accepted",
) {
  try {
    const bot = getBantahBroTelegramBot();
    if (!bot || typeof bot.sendCustomHtmlMessage !== "function") return;

    const url = challengeData(challenge).publicUrl;
    const isAccepted = action === "accepted";
    const title = isAccepted ? "BOTA PVP CHALLENGE ACCEPTED" : "NEW BOTA CALLOUT";
    const statusLine = isAccepted
      ? `Fight scheduled: <b>${escapeHtml(challenge.scheduledAt ? new Date(challenge.scheduledAt).toUTCString() : "soon")}</b>`
      : `Expires: <b>${escapeHtml(new Date(challenge.expiresAt).toUTCString())}</b>`;
    const predictionLine = challenge.predictionEnabled ? "Prediction market: <b>ON</b>" : "Prediction market: <b>OFF</b>";
    const messageLine = challenge.message ? `Callout: <i>${escapeHtml(challenge.message)}</i>` : null;

    const html = [
      `<b>${title}</b>`,
      "",
      `<b>${escapeHtml(challenge.challengerAgent.name)}</b> vs <b>${escapeHtml(challenge.opponentAgent.name)}</b>`,
      `Stake: <b>${escapeHtml(formatStake(challenge))}</b>`,
      `Mode: <b>${escapeHtml(challenge.matchType === "degen_vs" ? "Degen VS" : "Arena")}</b>`,
      predictionLine,
      statusLine,
      ...(messageLine ? ["", messageLine] : []),
      "",
      "Open the card, accept, watch, or share it.",
    ].join("\n");

    const sent = await bot.sendCustomHtmlMessage(html, {
      inline_keyboard: [[{ text: isAccepted ? "Watch Challenge" : "Open Challenge", url }]],
    });

    if (sent) {
      await recordBantahBroTelegramPost({
        id: `telegram-bota-agent-challenge-${action}-${challenge.challengeCode}`,
        content: [
          title,
          `${challenge.challengerAgent.name} vs ${challenge.opponentAgent.name}`,
          `Stake: ${formatStake(challenge)}`,
          isAccepted ? `Scheduled: ${challenge.scheduledAt || "soon"}` : `Expires: ${challenge.expiresAt}`,
        ].join("\n"),
        market: `${challenge.challengerAgent.name} vs ${challenge.opponentAgent.name}`,
        marketEmoji: "BOTA",
        tags: ["BOTA", "PvP", "Challenge", action],
        url,
      });
    }
  } catch (error) {
    console.warn("[BOTA] Challenge Telegram channel broadcast unavailable:", error);
  }
}

async function notifyUser(intent: ChallengeNotificationIntent, challenge: BotaAgentChallenge) {
  const userId = String(intent.userId || "").trim();
  if (!userId) return;

  try {
    const notification = await storage.createNotification({
      userId,
      type: intent.type,
      title: intent.title,
      message: intent.message,
      icon: "B",
      data: {
        ...challengeData(challenge),
        ...(intent.data || {}),
      },
      channels: ["in_app_feed", "push_notification", "telegram_bot"],
      fomoLevel: intent.fomoLevel || "high",
      priority: intent.priority || 3,
      read: false,
      expiresAt: challenge.expiresAt ? new Date(challenge.expiresAt) : undefined,
    } as any);

    await pushRealtimeNotification(userId, {
      ...notification,
      event: intent.type,
      timestamp: new Date().toISOString(),
    });

    await Promise.allSettled([
      sendBrowserPush(userId, intent, challenge),
      sendTelegramDm(userId, intent, challenge),
    ]);
  } catch (error) {
    console.warn("[BOTA] Challenge notification failed:", error);
  }
}

export async function notifyBotaAgentChallengeCreated(challenge: BotaAgentChallenge) {
  const opponentMessage =
    `${challenge.challengerAgent.name} challenged ${challenge.opponentAgent.name} ` +
    `for ${formatStake(challenge)}.`;

  const challengerMessage =
    `${challenge.opponentAgent.name} has been challenged. Share the card while acceptance is pending.`;

  await Promise.allSettled([
    broadcastTelegramChallengeAction(challenge, "created"),
    notifyUser(
      {
        userId: challenge.challengerUserId,
        type: "bota_agent_challenge_sent",
        title: "BOTA challenge sent",
        message: challengerMessage,
        priority: 2,
        fomoLevel: "medium",
      },
      challenge,
    ),
    notifyUser(
      {
        userId: challenge.opponentOwnerUserId,
        type: "bota_agent_challenge_received",
        title: "New BOTA PvP challenge",
        message: opponentMessage,
        priority: 4,
        fomoLevel: "urgent",
      },
      challenge,
    ),
  ]);
}

export async function notifyBotaAgentChallengeAccepted(challenge: BotaAgentChallenge) {
  const starts = challenge.scheduledAt ? new Date(challenge.scheduledAt).toUTCString() : "soon";
  const acceptedMessage =
    `${challenge.opponentAgent.name} accepted ${challenge.challengerAgent.name}. Fight starts ${starts}.`;
  const opponentMessage =
    `${challenge.challengerAgent.name} vs ${challenge.opponentAgent.name} is scheduled for ${starts}.`;

  await Promise.allSettled([
    broadcastTelegramChallengeAction(challenge, "accepted"),
    notifyUser(
      {
        userId: challenge.challengerUserId,
        type: "bota_agent_challenge_accepted",
        title: "BOTA challenge accepted",
        message: acceptedMessage,
        priority: 4,
        fomoLevel: "urgent",
      },
      challenge,
    ),
    notifyUser(
      {
        userId: challenge.opponentOwnerUserId,
        type: "bota_agent_challenge_scheduled",
        title: "BOTA fight scheduled",
        message: opponentMessage,
        priority: 3,
        fomoLevel: "high",
      },
      challenge,
    ),
  ]);
}

export async function notifyBotaAgentChallengeStartingSoon(
  challenge: BotaAgentChallenge,
  minutes = 5,
) {
  const starts = challenge.scheduledAt ? new Date(challenge.scheduledAt).toUTCString() : "soon";
  const message =
    `${challenge.challengerAgent.name} vs ${challenge.opponentAgent.name} starts in about ${minutes} minutes. ` +
    `Scheduled for ${starts}.`;

  await Promise.allSettled([
    notifyUser(
      {
        userId: challenge.challengerUserId,
        type: "bota_agent_challenge_starting_soon",
        title: "BOTA fight starts soon",
        message,
        priority: 4,
        fomoLevel: "urgent",
        data: { lifecycleStage: "starting_soon", minutes },
      },
      challenge,
    ),
    notifyUser(
      {
        userId: challenge.opponentOwnerUserId,
        type: "bota_agent_challenge_starting_soon",
        title: "BOTA fight starts soon",
        message,
        priority: 4,
        fomoLevel: "urgent",
        data: { lifecycleStage: "starting_soon", minutes },
      },
      challenge,
    ),
  ]);
}

export async function notifyBotaAgentChallengeStartingNow(challenge: BotaAgentChallenge) {
  const message =
    `${challenge.challengerAgent.name} vs ${challenge.opponentAgent.name} is starting now.`;

  await Promise.allSettled([
    broadcastBotaTelegramEvent({
      id: `telegram-bota-agent-challenge-starting-${challenge.challengeCode}`,
      title: "BOTA PVP FIGHT STARTING",
      lines: [
        `${challenge.challengerAgent.name} vs ${challenge.opponentAgent.name}`,
        `Stake: ${formatStake(challenge)}`,
        challenge.predictionEnabled ? "Prediction market: ON" : "Prediction market: OFF",
      ],
      url: challenge.challengeUrl,
      tags: ["BOTA", "PvP", "Starting"],
      market: `${challenge.challengerAgent.name} vs ${challenge.opponentAgent.name}`,
    }),
    notifyUser(
      {
        userId: challenge.challengerUserId,
        type: "bota_agent_challenge_starting_now",
        title: "BOTA fight starting now",
        message,
        priority: 4,
        fomoLevel: "urgent",
        data: { lifecycleStage: "starting_now" },
      },
      challenge,
    ),
    notifyUser(
      {
        userId: challenge.opponentOwnerUserId,
        type: "bota_agent_challenge_starting_now",
        title: "BOTA fight starting now",
        message,
        priority: 4,
        fomoLevel: "urgent",
        data: { lifecycleStage: "starting_now" },
      },
      challenge,
    ),
  ]);
}

export async function notifyBotaAgentChallengeFinished(input: {
  challenge: BotaAgentChallenge;
  winnerAgentName?: string | null;
  loserAgentName?: string | null;
  winnerUserId?: string | null;
  loserUserId?: string | null;
  rounds?: number | null;
  rewardBantCredits?: number | null;
  resultStatus?: "resolved" | "draw";
}) {
  const winner = input.winnerAgentName || "Winner";
  const loser = input.loserAgentName || "opponent";
  const rounds = Math.max(0, Math.round(input.rounds || 0));
  const reward = Math.max(0, Math.round(input.rewardBantCredits || 0));
  const isDraw = input.resultStatus === "draw";
  const sharedData = {
    lifecycleStage: "finished",
    winnerAgentName: input.winnerAgentName || null,
    loserAgentName: input.loserAgentName || null,
    rounds,
    rewardBantCredits: reward,
  };

  await Promise.allSettled([
    broadcastBotaTelegramEvent({
      id: `telegram-bota-agent-challenge-finished-${input.challenge.challengeCode}`,
      title: isDraw ? "BOTA PVP FIGHT DRAW" : "BOTA PVP FIGHT FINISHED",
      lines: isDraw
        ? [
            `${input.challenge.challengerAgent.name} vs ${input.challenge.opponentAgent.name} ended in a draw.`,
            `Rounds: ${rounds}`,
          ]
        : [
            `${winner} defeated ${loser}.`,
            `Rounds: ${rounds}`,
            reward > 0 ? `BantCredit updated: +${reward}` : "BantCredit updated.",
          ],
      url: input.challenge.challengeUrl,
      tags: ["BOTA", "PvP", "Result"],
      market: `${input.challenge.challengerAgent.name} vs ${input.challenge.opponentAgent.name}`,
    }),
    notifyUser(
      {
        userId: input.winnerUserId,
        type: isDraw ? "bota_agent_challenge_draw" : "bota_agent_challenge_won",
        title: isDraw ? "BOTA fight finished" : "BOTA fight won",
        message: isDraw
          ? `${input.challenge.challengerAgent.name} vs ${input.challenge.opponentAgent.name} ended in a draw.`
          : `${winner} defeated ${loser}.${reward > 0 ? ` +${reward} BantCredit added.` : ""}`,
        priority: isDraw ? 3 : 4,
        fomoLevel: isDraw ? "high" : "urgent",
        data: sharedData,
      },
      input.challenge,
    ),
    notifyUser(
      {
        userId: input.loserUserId,
        type: isDraw ? "bota_agent_challenge_draw" : "bota_agent_challenge_lost",
        title: isDraw ? "BOTA fight finished" : "BOTA fight lost",
        message: isDraw
          ? `${input.challenge.challengerAgent.name} vs ${input.challenge.opponentAgent.name} ended in a draw.`
          : `${loser} lost to ${winner}. Review the fight and prep the rematch.`,
        priority: 3,
        fomoLevel: "high",
        data: sharedData,
      },
      input.challenge,
    ),
  ]);
}

export async function notifyBotaAgentChallengeBantCreditUpdated(input: {
  challenge: BotaAgentChallenge;
  userId?: string | null;
  amount: number;
  reason: string;
}) {
  const amount = Math.max(0, Math.round(input.amount || 0));
  if (!amount) return;

  await notifyUser(
    {
      userId: input.userId,
      type: "bota_agent_challenge_bantcredit_updated",
      title: "BantCredit updated",
      message: `+${amount} BantCredit added for ${input.reason}.`,
      priority: 4,
      fomoLevel: "urgent",
      data: {
        lifecycleStage: "bantcredit_updated",
        amount,
        reason: input.reason,
      },
    },
    input.challenge,
  );
}
