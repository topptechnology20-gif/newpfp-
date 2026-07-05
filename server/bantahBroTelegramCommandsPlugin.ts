import type { Content, IAgentRuntime, Plugin } from "@elizaos/core";
import { storage } from "./storage";
import { analyzeToken } from "./bantahBro/tokenIntelligence";
import { buildAlertFromAnalysis, buildReceiptFromAlert } from "./bantahBro/contentEngine";
import { runBantahBroSurfaceScan } from "./bantahBro/rugScorerSurface";
import {
  getBantahBroReceiptBySourceAlert,
  listBantahBroAlerts,
  publishBantahBroAlert,
  publishBantahBroReceipt,
} from "./bantahBro/alertFeed";
import { createBantahBroMarketFromSignal } from "./bantahBro/marketService";
import { getBantahBroBxbtStatus } from "./bantahBro/bxbtUtility";
import { maybeHandleBantahBroCommandSurface } from "./bantahBro/commandSurface";
import { handleTokenLaunchIntent } from "./bantahBro/launchIntent";
import { deployBantahLaunchToken } from "./bantahBro/tokenLauncher";
import { getBantahBroSystemAgentStatus } from "./bantahBro/systemAgent";
import { getBantahBroLeaderboard } from "./bantahBro/communityService";
import {
  buildBantahBroAgentUrl,
  buildBantahBroTelegramAlertMessage,
  buildBantahBroTelegramAlertsDigest,
  buildBantahBroTelegramBxbtMessage,
  buildBantahBroTelegramFriendsMessage,
  buildBantahBroTelegramHelp,
  buildBantahBroTelegramLeaderboardMessage,
  buildBantahBroTelegramMarketsDigest,
  buildBantahBroTelegramReceiptMessage,
  buildBantahBroTelegramStartButtonPrompt,
  defaultBantahBroMarketCurrency,
  parseBantahBroTelegramStartButton,
  parseBantahBroTelegramTokenCommand,
} from "./bantahBro/telegramSupport";
import { db } from "./db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";
import {
  createBotaAgentChallenge,
  acceptBotaAgentChallenge,
  declineBotaAgentChallenge,
  getBotaAgentChallengeByCode,
} from "./bantahBro/botaAgentChallengeService";

type TelegramCallback = (content: Content) => Promise<unknown>;

type TelegramInlineButton = {
  text: string;
  url?: string | null;
  callbackData?: string | null;
};

type TelegramCommandState = {
  pendingAction: "analyze" | "rug" | "runner" | "create" | "receipt";
  createdAt: number;
};

type TelegramMessageEventPayload = {
  runtime?: IAgentRuntime;
  callback?: TelegramCallback;
  ctx?: {
    chat?: {
      id?: number | string;
      type?: string;
    };
    from?: {
      id?: number;
      first_name?: string;
    };
    reply?: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
    telegram?: {
      sendMessage?: (
        chatId: number | string,
        text: string,
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
      answerCbQuery?: (
        callbackQueryId: string,
        text?: string,
        showAlert?: boolean,
      ) => Promise<unknown>;
    };
  };
  message?: {
    content?: {
      text?: string;
    };
  };
  originalMessage?: {
    from?: {
      id?: number;
    };
  };
};

type TelegramCallbackQueryPayload = {
  id: string;
  data?: string;
  from?: {
    id?: number;
  };
  message?: {
    chat?: {
      id?: number | string;
      type?: string;
    };
  };
};

const telegramCommandStates = new Map<string, TelegramCommandState>();
const attachedTelegramServices = new WeakSet<object>();

function isPrivateTelegramChat(payload: TelegramMessageEventPayload) {
  return String(payload.ctx?.chat?.type || "").trim().toLowerCase() === "private";
}

function cleanIncomingText(text: string) {
  return String(text || "").trim();
}

function matchesSlashCommand(text: string, command: string) {
  const pattern = new RegExp(`^\\/${command}(?:@\\w+)?(?:\\s|$)`, "i");
  return pattern.test(text);
}

function createUrlButtons(buttons: Array<{ text: string; url?: string | null }>) {
  return buttons
    .filter((button) => typeof button.url === "string" && button.url.trim().length > 0)
    .map((button) => ({
      kind: "url" as const,
      text: button.text,
      url: button.url!.trim(),
    }));
}

function getStateKey(chatId: number | string | null | undefined, userId: number | string | null | undefined) {
  if (chatId == null || userId == null) return null;
  return `${chatId}:${userId}`;
}

function setPendingState(
  chatId: number | string | null | undefined,
  userId: number | string | null | undefined,
  pendingAction: TelegramCommandState["pendingAction"],
) {
  const key = getStateKey(chatId, userId);
  if (!key) return;
  telegramCommandStates.set(key, {
    pendingAction,
    createdAt: Date.now(),
  });
}

function consumePendingState(
  chatId: number | string | null | undefined,
  userId: number | string | null | undefined,
) {
  const key = getStateKey(chatId, userId);
  if (!key) return null;
  const state = telegramCommandStates.get(key) || null;
  if (!state) return null;
  telegramCommandStates.delete(key);

  const ttlMs = 10 * 60 * 1000;
  if (Date.now() - state.createdAt > ttlMs) {
    return null;
  }

  return state;
}

function toCommandFromPending(action: TelegramCommandState["pendingAction"], text: string) {
  const tokenText = String(text || "").trim();
  if (!tokenText) return "";
  return `/${action} ${tokenText}`;
}

function callbackButton(text: string, callbackData: string): TelegramInlineButton {
  return { text, callbackData };
}

function urlButton(text: string, url?: string | null): TelegramInlineButton | null {
  if (!url || !url.trim()) return null;
  return { text, url: url.trim() };
}

function buildInlineKeyboard(rows: TelegramInlineButton[][]) {
  return rows
    .map((row) =>
      row
        .filter(Boolean)
        .map((button) =>
          button.url
            ? { text: button.text, url: button.url }
            : { text: button.text, callback_data: button.callbackData || "bb:noop" },
        ),
    )
    .filter((row) => row.length > 0);
}

function buildMainMenuButtons() {
  return [
    [callbackButton("🔎 Analyze Token", "bb:menu:analyze"), callbackButton("⚠️ Rug Score", "bb:menu:rug")],
    [callbackButton("🚀 Runner Score", "bb:menu:runner"), callbackButton("📣 Live Alerts", "bb:run:alerts")],
    [callbackButton("🏟 Live Markets", "bb:run:markets"), callbackButton("🏆 Leaderboard", "bb:run:leaderboard")],
    [callbackButton("🪙 BXBT Status", "bb:run:bxbt"), callbackButton("🎯 Create Market", "bb:menu:create")],
  ];
}

async function handleSharedPowerCommand(
  payload: TelegramMessageEventPayload,
  text: string,
  telegramId: string | null,
) {
  const tool =
    /^\/wallet\b/i.test(text)
      ? "wallet"
      : /^\/discover\b|^\/trending\b/i.test(text)
        ? "discover"
        : /^\/battle\b|^\/battles\b/i.test(text)
          ? "battle"
          : /^\/analyze\b/i.test(text)
            ? "analyze"
            : /^\/rug\b/i.test(text)
              ? "rug"
              : /^\/runner\b/i.test(text)
                ? "runner"
                : null;
  const linkedUser = telegramId ? await storage.getUserByTelegramId(telegramId).catch(() => null) : null;
  const surfaceReply = await withTimeout(
    maybeHandleBantahBroCommandSurface({
      text,
      tool,
      source: "telegram",
      actor: linkedUser
        ? {
            userId: linkedUser.id,
            username: linkedUser.username || null,
            firstName: linkedUser.firstName || null,
            walletAddress: (linkedUser as any).primaryWalletAddress || null,
          }
        : null,
    }),
    "Command surface",
  );

  if (!surfaceReply) {
    return false;
  }

  const linkButtons = surfaceReply.links
    .slice(0, 2)
    .map((link) => urlButton(link.label, link.url))
    .filter(Boolean) as TelegramInlineButton[];

  await sendTelegramText(payload, surfaceReply.reply, [
    ...(linkButtons.length > 0 ? [linkButtons] : []),
    [callbackButton("😎 Main Menu", "bb:menu:main")],
  ]);
  return true;
}

function getTelegramCommandTimeoutMs() {
  const parsed = Number.parseInt(
    String(process.env.BANTAHBRO_TELEGRAM_COMMAND_TIMEOUT_MS || "").trim(),
    10,
  );
  if (Number.isInteger(parsed) && parsed >= 5_000) {
    return parsed;
  }
  return 20_000;
}

async function withTimeout<T>(promise: Promise<T>, label: string) {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label} took too long. Try again in a moment or switch to a smaller/faster token lookup.`,
            ),
          );
        }, getTelegramCommandTimeoutMs());
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function sendContent(
  callback: TelegramCallback | undefined,
  text: string,
  buttons?: Array<{ text: string; url?: string | null }>,
) {
  if (!callback) return false;
  await callback({
    text,
    ...(buttons && buttons.length > 0 ? { buttons: createUrlButtons(buttons) } : {}),
  });
  return true;
}

async function sendTelegramText(
  payload: TelegramMessageEventPayload,
  text: string,
  rows: TelegramInlineButton[][] = [],
) {
  const chatId = payload.ctx?.chat?.id;
  const keyboard = buildInlineKeyboard(rows);
  const options =
    keyboard.length > 0
      ? {
          reply_markup: {
            inline_keyboard: keyboard,
          },
        }
      : undefined;

  if (typeof payload.ctx?.reply === "function") {
    await payload.ctx.reply(text, options);
    return true;
  }

  if (chatId != null && typeof payload.ctx?.telegram?.sendMessage === "function") {
    await payload.ctx.telegram.sendMessage(chatId, text, options);
    return true;
  }

  return sendContent(
    payload.callback,
    text,
    rows
      .flat()
      .filter((button) => Boolean(button.url))
      .map((button) => ({ text: button.text, url: button.url })),
  );
}

async function answerCallback(ctx: any, text: string, showAlert = false) {
  if (typeof ctx?.answerCbQuery === "function") {
    await ctx.answerCbQuery(text, { show_alert: showAlert });
  }
}

async function handleAnalyzeLikeCommand(
  payload: TelegramMessageEventPayload,
  text: string,
  mode: "auto" | "rug" | "runner",
) {
  const tokenRef = parseBantahBroTelegramTokenCommand(text);
  if (!tokenRef) {
    const action = mode === "auto" ? "analyze" : mode;
    setPendingState(payload.ctx?.chat?.id, payload.ctx?.from?.id, action);
    await sendTelegramText(payload, buildBantahBroTelegramStartButtonPrompt(action), [
      [callbackButton("❌ Cancel", "bb:state:clear"), callbackButton("😎 Main Menu", "bb:menu:main")],
    ]);
    return true;
  }

  try {
    const scan = await withTimeout(
      runBantahBroSurfaceScan({
        query: tokenRef.tokenAddress,
        chainId: tokenRef.chainId,
      }),
      "Rug Scorer V2 scan",
    );
    if (!scan) {
      throw new Error("No live Rug Scorer result was returned for that token.");
    }
    const analysis = scan.analysis;
    const alert = publishBantahBroAlert(buildAlertFromAnalysis(analysis, mode));
    const { text: messageText, chartUrl, scanUrl } = buildBantahBroTelegramAlertMessage(alert, analysis);
    const systemAgent = await withTimeout(
      getBantahBroSystemAgentStatus(),
      "System agent lookup",
    ).catch(() => null);
    const marketInstruction = `\n\n🎯 Next: /create ${tokenRef.chainId} ${tokenRef.tokenAddress}`;

    await sendTelegramText(payload, `${messageText}${marketInstruction}`, [
      [
        callbackButton(
          alert.type === "runner_alert" ? "🚀 Open Runner Market" : "⚠️ Open Rug Market",
          `bb:market:${alert.id}:${alert.type === "runner_alert" ? "runner" : "rug"}`,
        ),
      ],
      [
        callbackButton("🧾 Receipt Check", `bb:receipt:${alert.id}`),
        urlButton("🔎 Open Scan", scanUrl) as TelegramInlineButton,
        ...[urlButton("📊 View Chart", chartUrl)].filter(Boolean) as TelegramInlineButton[],
      ],
      [
        urlButton("😎 Open BantahBro", buildBantahBroAgentUrl(systemAgent?.agentId)) as TelegramInlineButton,
      ],
    ]);
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? `⚠️ Analyze failed.\n\n${error.message}` : "⚠️ Analyze failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}

async function handleAlertsCommand(payload: TelegramMessageEventPayload) {
  await sendTelegramText(payload, buildBantahBroTelegramAlertsDigest(listBantahBroAlerts(5)), [
    [callbackButton("🔄 Refresh Alerts", "bb:run:alerts"), callbackButton("😎 Main Menu", "bb:menu:main")],
  ]);
  return true;
}

async function handleMarketsCommand(payload: TelegramMessageEventPayload) {
  await sendTelegramText(payload, buildBantahBroTelegramMarketsDigest(listBantahBroAlerts(10)), [
    [callbackButton("🔄 Refresh Markets", "bb:run:markets"), callbackButton("😎 Main Menu", "bb:menu:main")],
  ]);
  return true;
}

async function handleCreateCommand(payload: TelegramMessageEventPayload, text: string) {
  const tokenRef = parseBantahBroTelegramTokenCommand(text);
  if (!tokenRef) {
    setPendingState(payload.ctx?.chat?.id, payload.ctx?.from?.id, "create");
    await sendTelegramText(payload, "🎯 Usage:\n/create <token>\n/create <chain> <token>", [
      [callbackButton("❌ Cancel", "bb:state:clear"), callbackButton("😎 Main Menu", "bb:menu:main")],
    ]);
    return true;
  }

  try {
    const result = await withTimeout(
      createBantahBroMarketFromSignal({
        chainId: tokenRef.chainId,
        tokenAddress: tokenRef.tokenAddress,
        durationHours: 24,
        stakeAmount: "10",
        currency: defaultBantahBroMarketCurrency(tokenRef.chainId),
        sourcePlatform: "telegram",
        chargeBxbt:
          String(process.env.BANTAHBRO_TELEGRAM_CHARGE_BXBT_MARKETS || "")
            .trim()
            .toLowerCase() === "true",
      }),
      "Market creation",
    );

    await sendTelegramText(payload, `🎯 Market live.\n\n${result.market.url}`, [
      [
        urlButton("🏟 View Market", result.market.url) as TelegramInlineButton,
        urlButton("😎 Open BantahBro", buildBantahBroAgentUrl(result.systemAgent.agentId)) as TelegramInlineButton,
      ],
      [callbackButton("🏟 Live Markets", "bb:run:markets"), callbackButton("😎 Main Menu", "bb:menu:main")],
    ]);
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? `⚠️ Create failed.\n\n${error.message}` : "⚠️ Create failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}

async function handleLaunchCommand(payload: TelegramMessageEventPayload, text: string, telegramId: string | null) {
  const intentText = text.replace(/^\/launch(?:@\w+)?/i, "launch token").trim();
  const launchIntent = handleTokenLaunchIntent(intentText);
  if (!launchIntent.handled) {
    await sendTelegramText(
      payload,
      "🚀 Usage:\n/launch name Bantah Demo symbol BDEMO supply 1000000 owner 0xYourWallet on Base\n\nI will draft first. Add confirm to the same command only when you are ready to deploy.",
      [[callbackButton("😎 Main Menu", "bb:menu:main")]],
    );
    return true;
  }

  const wantsConfirm = /\bconfirm\b/i.test(text);
  if (!wantsConfirm || !launchIntent.launcher?.deployPayload) {
    await sendTelegramText(
      payload,
      `${launchIntent.reply}\n\nTelegram deploy safety: repeat the same /launch command with the word confirm when you are ready.`,
      [[urlButton("🚀 Open Launcher", `${buildBantahBroAgentUrl()}?section=launcher`) as TelegramInlineButton]],
    );
    return true;
  }

  if (!telegramId) {
    await sendTelegramText(payload, "🔐 Link your Telegram account to Bantah first before deploying a token.");
    return true;
  }

  const user = await storage.getUserByTelegramId(telegramId);
  if (!user?.id) {
    await sendTelegramText(payload, "🔐 I could not find a linked Bantah account for this Telegram user.");
    return true;
  }

  try {
    const result = await withTimeout(
      deployBantahLaunchToken(launchIntent.launcher.deployPayload, { userId: user.id }),
      "Token launch",
    );
    await sendTelegramText(
      payload,
      `🚀 Token deployed.\n\nToken: ${result.tokenAddress || result.launch?.tokenAddress || "pending"}${
        result.explorerTokenUrl ? `\nExplorer: ${result.explorerTokenUrl}` : ""
      }`,
      [[callbackButton("😎 Main Menu", "bb:menu:main")]],
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token launch failed.";
    await sendTelegramText(payload, `⚠️ Token launch failed.\n\n${message}`);
    return true;
  }
}

async function handleLeaderboardCommand(payload: TelegramMessageEventPayload) {
  try {
    const leaderboard = await withTimeout(
      getBantahBroLeaderboard(10),
      "Leaderboard fetch",
    );
    await sendTelegramText(payload, buildBantahBroTelegramLeaderboardMessage(leaderboard.entries), [
      [callbackButton("🔄 Refresh Leaderboard", "bb:run:leaderboard"), callbackButton("😎 Main Menu", "bb:menu:main")],
    ]);
    return true;
  } catch (error) {
    const message =
      error instanceof Error
        ? `⚠️ Leaderboard fetch failed.\n\n${error.message}`
        : "⚠️ Leaderboard fetch failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}

async function handleFriendsCommand(
  payload: TelegramMessageEventPayload,
  telegramId: string | null,
) {
  if (!telegramId) {
    await sendTelegramText(
      payload,
      "👥 Link your Telegram account first from Bantah, then /friends will show your circle.",
    );
    return true;
  }

  try {
    const user = await withTimeout(storage.getUserByTelegramId(telegramId), "Friend lookup");
    if (!user) {
      await sendTelegramText(
        payload,
        "👥 Link your Telegram account first from Bantah, then /friends will show your circle.",
      );
      return true;
    }

    const friends = await withTimeout(storage.getFriends(user.id), "Friends fetch");
    const normalizedFriends = friends.map((friend) => {
      const counterpart =
        friend.requesterId === user.id ? friend.addressee : friend.requester;
      return {
        username: counterpart?.username || null,
        firstName: counterpart?.firstName || null,
        connectedAt: friend.createdAt,
      };
    });

    await sendTelegramText(payload, buildBantahBroTelegramFriendsMessage(normalizedFriends), [
      [callbackButton("😎 Main Menu", "bb:menu:main")],
    ]);
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? `⚠️ Friends fetch failed.\n\n${error.message}` : "⚠️ Friends fetch failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}

async function handleBxbtCommand(payload: TelegramMessageEventPayload) {
  try {
    const status = await withTimeout(getBantahBroBxbtStatus(), "BXBT status check");
    await sendTelegramText(payload, buildBantahBroTelegramBxbtMessage(status), [
      [callbackButton("🔄 Refresh BXBT", "bb:run:bxbt"), callbackButton("😎 Main Menu", "bb:menu:main")],
    ]);
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? `⚠️ BXBT check failed.\n\n${error.message}` : "⚠️ BXBT check failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}

async function handleReceiptCommand(
  payload: TelegramMessageEventPayload,
  text: string,
) {
  const tokenRef = parseBantahBroTelegramTokenCommand(text);
  if (!tokenRef) {
    return false;
  }

  const existingAlert = listBantahBroAlerts(25).find(
    (alert) =>
      alert.chainId === tokenRef.chainId &&
      alert.tokenAddress.toLowerCase() === tokenRef.tokenAddress.toLowerCase(),
  );

  if (!existingAlert) {
    await sendTelegramText(
      payload,
      "🧾 No existing BantahBro alert for that token yet.\n\nRun /analyze first, then ask for the receipt.",
    );
    return true;
  }

  try {
    const analysis = await withTimeout(
      analyzeToken({
        chainId: existingAlert.chainId,
        tokenAddress: existingAlert.tokenAddress,
      }),
      "Receipt analysis",
    );
    const receipt =
      getBantahBroReceiptBySourceAlert(existingAlert.id) ||
      publishBantahBroReceipt(buildReceiptFromAlert(existingAlert, analysis));
    await sendTelegramText(payload, buildBantahBroTelegramReceiptMessage(receipt), [
      [callbackButton("📣 Live Alerts", "bb:run:alerts"), callbackButton("😎 Main Menu", "bb:menu:main")],
    ]);
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? `⚠️ Receipt check failed.\n\n${error.message}` : "⚠️ Receipt check failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}

async function handleReceiptForAlert(payload: TelegramMessageEventPayload, alertId: string) {
  const alert = listBantahBroAlerts(50).find((candidate) => candidate.id === alertId);
  if (!alert) {
    await sendTelegramText(payload, "📭 Alert not found. Run /alerts and try from a fresh card.");
    return true;
  }

  try {
    const analysis = await withTimeout(
      analyzeToken({
        chainId: alert.chainId,
        tokenAddress: alert.tokenAddress,
      }),
      "Receipt analysis",
    );
    const receipt =
      getBantahBroReceiptBySourceAlert(alert.id) ||
      publishBantahBroReceipt(buildReceiptFromAlert(alert, analysis));
    await sendTelegramText(payload, buildBantahBroTelegramReceiptMessage(receipt), [
      [callbackButton("📣 Live Alerts", "bb:run:alerts"), callbackButton("😎 Main Menu", "bb:menu:main")],
    ]);
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? `⚠️ Receipt check failed.\n\n${error.message}` : "⚠️ Receipt check failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}

async function handleMarketForAlert(
  payload: TelegramMessageEventPayload,
  alertId: string,
  mode: "rug" | "runner",
) {
  const alert = listBantahBroAlerts(50).find((candidate) => candidate.id === alertId);
  if (!alert) {
    await sendTelegramText(payload, "📭 Alert not found. Run /alerts and try from a fresh card.");
    return true;
  }

  try {
    const result = await withTimeout(
      createBantahBroMarketFromSignal({
        sourceAlertId: alertId,
        durationHours: mode === "runner" ? 24 : 6,
        stakeAmount: "10",
        currency: defaultBantahBroMarketCurrency(alert.chainId),
        sourcePlatform: "telegram",
        chargeBxbt:
          String(process.env.BANTAHBRO_TELEGRAM_CHARGE_BXBT_MARKETS || "")
            .trim()
            .toLowerCase() === "true",
      }),
      "Market creation",
    );

    await sendTelegramText(payload, `🎯 Market live.\n\n${result.market.url}`, [
      [urlButton("🏟 View Market", result.market.url) as TelegramInlineButton],
      [callbackButton("🏟 Live Markets", "bb:run:markets"), callbackButton("😎 Main Menu", "bb:menu:main")],
    ]);
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? `⚠️ Market failed.\n\n${error.message}` : "⚠️ Market failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}


async function handleChallengeCommand(
  payload: TelegramMessageEventPayload,
  text: string,
  telegramId: string | null,
) {
  if (!telegramId) {
    await sendTelegramText(payload, "🔐 Link your Telegram account to Bantah first before challenging someone.");
    return true;
  }

  const user = await storage.getUserByTelegramId(telegramId);
  if (!user?.id) {
    await sendTelegramText(payload, "🔐 I could not find a linked Bantah account for this Telegram user.");
    return true;
  }

  // Parse: /challenge @username 100
  const parts = text.split(/\s+/);
  const targetUsernameRaw = parts[1];
  const amountRaw = parts[2];

  if (!targetUsernameRaw || !targetUsernameRaw.startsWith("@") || !amountRaw) {
    await sendTelegramText(payload, "🎯 Usage:\n/challenge @username [amount]\nExample: /challenge @vitalik 100");
    return true;
  }

  const targetUsername = targetUsernameRaw.substring(1);
  const amount = Number(amountRaw);

  if (isNaN(amount) || amount <= 0) {
    await sendTelegramText(payload, "⚠️ Invalid stake amount.");
    return true;
  }

  // Find opponent by telegram username
  const opponentRes = await db.select().from(users).where(eq(users.telegramUsername, targetUsername)).limit(1);
  const opponentUser = opponentRes[0];

  if (user.id === opponentUser?.id) {
    await sendTelegramText(payload, "⚠️ You cannot challenge yourself.");
    return true;
  }

  if (!opponentUser) {
    await sendTelegramText(payload, "⚠️ User not found. They must have linked their Telegram to Bantah first.");
    return true;
  }

  const opponentId = opponentUser.id;

  try {
    await sendTelegramText(
      payload,
      `⚔️ You are challenging @${targetUsername} for ${amount} BC.\n\nOpen Bantah to finalize your agent selection and confirm the challenge!`,
      [[urlButton("🚀 Finalize Challenge", `${buildBantahBroAgentUrl()}?section=challenge&opponent=${opponentId}&amount=${amount}&source=telegram`) as TelegramInlineButton]]
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? `⚠️ Challenge failed.\n\n${error.message}` : "⚠️ Challenge failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}

async function handleAcceptCommand(
  payload: TelegramMessageEventPayload,
  text: string,
  telegramId: string | null,
) {
  if (!telegramId) {
    await sendTelegramText(payload, "🔐 Link your Telegram account to Bantah first.");
    return true;
  }

  const user = await storage.getUserByTelegramId(telegramId);
  if (!user?.id) {
    await sendTelegramText(payload, "🔐 I could not find a linked Bantah account.");
    return true;
  }

  // Normally /accept <challenge_code>
  const parts = text.split(/\s+/);
  const challengeCode = parts[1];

  if (!challengeCode) {
    await sendTelegramText(payload, "🎯 Usage: /accept [challenge_code]");
    return true;
  }

  try {
    const challenge = await acceptBotaAgentChallenge({
      challengeCode,
      userId: user.id,
      scheduledDelayMinutes: 5,
    });
    
    await sendTelegramText(payload, `⚔️ Challenge accepted! Battle starts soon.`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? `⚠️ Accept failed.\n\n${error.message}` : "⚠️ Accept failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}

async function handleDeclineCommand(
  payload: TelegramMessageEventPayload,
  text: string,
  telegramId: string | null,
) {
  if (!telegramId) {
    await sendTelegramText(payload, "🔐 Link your Telegram account to Bantah first.");
    return true;
  }

  const user = await storage.getUserByTelegramId(telegramId);
  if (!user?.id) {
    await sendTelegramText(payload, "🔐 I could not find a linked Bantah account.");
    return true;
  }

  const parts = text.split(/\s+/);
  const challengeCode = parts[1];

  if (!challengeCode) {
    await sendTelegramText(payload, "🎯 Usage: /decline [challenge_code]");
    return true;
  }

  try {
    const challenge = await declineBotaAgentChallenge({
      challengeCode,
      userId: user.id,
    });
    
    await sendTelegramText(payload, `❌ Challenge declined.`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? `⚠️ Decline failed.\n\n${error.message}` : "⚠️ Decline failed.";
    await sendTelegramText(payload, message);
    return true;
  }
}

export async function handleBantahBroTelegramCommandEvent(
  payload: TelegramMessageEventPayload,
) {
  const callback = payload.callback;
  const text = cleanIncomingText(payload.message?.content?.text || "");
  const telegramIdValue = payload.ctx?.from?.id ?? payload.originalMessage?.from?.id;
  const telegramId =
    typeof telegramIdValue === "number" && Number.isFinite(telegramIdValue)
      ? String(telegramIdValue)
      : null;
  const startButtonAction = parseBantahBroTelegramStartButton(text);
  const isPrivateChat = isPrivateTelegramChat(payload);

  if (!text || (!callback && !payload.ctx)) {
    return false;
  }

  const pending = consumePendingState(payload.ctx?.chat?.id, payload.ctx?.from?.id);
  if (pending && !text.startsWith("/")) {
    return handleBantahBroTelegramCommandEvent({
      ...payload,
      message: {
        ...payload.message,
        content: {
          ...payload.message?.content,
          text: toCommandFromPending(pending.pendingAction, text),
        },
      },
    });
  }

  if (matchesSlashCommand(text, "help")) {
    await sendTelegramText(payload, buildBantahBroTelegramHelp(), buildMainMenuButtons());
    return true;
  }

  if (matchesSlashCommand(text, "analyze")) {
    return handleAnalyzeLikeCommand(payload, text, "auto");
  }

  if (matchesSlashCommand(text, "rug")) {
    return handleAnalyzeLikeCommand(payload, text, "rug");
  }

  if (matchesSlashCommand(text, "runner")) {
    return handleAnalyzeLikeCommand(payload, text, "runner");
  }

  if (matchesSlashCommand(text, "alerts")) {
    return handleAlertsCommand(payload);
  }

  if (matchesSlashCommand(text, "markets")) {
    return handleMarketsCommand(payload);
  }

  if (matchesSlashCommand(text, "create")) {
    return handleCreateCommand(payload, text);
  }

  if (matchesSlashCommand(text, "launch")) {
    return handleLaunchCommand(payload, text, telegramId);
  }

  if (matchesSlashCommand(text, "leaderboard")) {
    return handleLeaderboardCommand(payload);
  }

  if (matchesSlashCommand(text, "friends")) {
    return handleFriendsCommand(payload, telegramId);
  }

  if (matchesSlashCommand(text, "bxbt")) {
    return handleBxbtCommand(payload);
  }

  if (matchesSlashCommand(text, "receipt")) {
    return handleReceiptCommand(payload, text);
  }

  if (matchesSlashCommand(text, "balance")) {
    return handleSharedPowerCommand(payload, "what is my wallet balance", telegramId);
  }

  if (matchesSlashCommand(text, "wallet")) {
    return handleSharedPowerCommand(payload, text, telegramId);
  }

  if (matchesSlashCommand(text, "discover") || matchesSlashCommand(text, "trending")) {
    return handleSharedPowerCommand(payload, text, telegramId);
  }

  if (matchesSlashCommand(text, "battle") || matchesSlashCommand(text, "battles")) {
    return handleSharedPowerCommand(payload, text, telegramId);
  }

  if (matchesSlashCommand(text, "challenge")) {
    return handleChallengeCommand(payload, text, telegramId);
  }

  if (matchesSlashCommand(text, "accept")) {
    return handleAcceptCommand(payload, text, telegramId);
  }

  if (matchesSlashCommand(text, "decline")) {
    return handleDeclineCommand(payload, text, telegramId);
  }

  if (
    matchesSlashCommand(text, "buy") ||
    matchesSlashCommand(text, "sell") ||
    matchesSlashCommand(text, "swap") ||
    matchesSlashCommand(text, "send") ||
    matchesSlashCommand(text, "bridge") ||
    matchesSlashCommand(text, "approve") ||
    matchesSlashCommand(text, "revoke")
  ) {
    return handleSharedPowerCommand(payload, text, telegramId);
  }

  if (!isPrivateChat) {
    return false;
  }

  if (startButtonAction === "analyze" || startButtonAction === "rug" || startButtonAction === "runner") {
    setPendingState(payload.ctx?.chat?.id, payload.ctx?.from?.id, startButtonAction);
    await sendTelegramText(payload, buildBantahBroTelegramStartButtonPrompt(startButtonAction), [
      [callbackButton("❌ Cancel", "bb:state:clear"), callbackButton("😎 Main Menu", "bb:menu:main")],
    ]);
    return true;
  }

  if (startButtonAction === "alerts") {
    return handleAlertsCommand(payload);
  }

  if (startButtonAction === "markets") {
    return handleMarketsCommand(payload);
  }

  if (startButtonAction === "leaderboard") {
    return handleLeaderboardCommand(payload);
  }

  return handleSharedPowerCommand(payload, text, telegramId);
}

async function handleCallbackAction(ctx: any, runtime: IAgentRuntime) {
  const query = ctx?.callbackQuery as TelegramCallbackQueryPayload | undefined;
  const data = String(query?.data || "");
  if (!data.startsWith("bb:")) return;

  const payload: TelegramMessageEventPayload = {
    runtime,
    ctx: {
      chat: {
        id: query?.message?.chat?.id,
        type: query?.message?.chat?.type || "private",
      },
      from: {
        id: query?.from?.id,
      },
      reply: ctx.reply?.bind(ctx),
      telegram: {
        sendMessage: ctx.telegram?.sendMessage?.bind(ctx.telegram),
      },
    },
    message: {
      content: {
        text: data,
      },
    },
  };

  const [, family, actionOrId, maybeMode] = data.split(":");
  await answerCallback(ctx, "😎 BantahBro is on it.");

  if (family === "menu") {
    if (actionOrId === "main") {
      await sendTelegramText(payload, "😎 BantahBro command center.", buildMainMenuButtons());
      return;
    }
    if (actionOrId === "analyze" || actionOrId === "rug" || actionOrId === "runner" || actionOrId === "create") {
      setPendingState(query?.message?.chat?.id, query?.from?.id, actionOrId);
      const prompt =
        actionOrId === "create"
          ? "Paste a token to open a market from its current signal.\n\nExample:\n/create solana So11111111111111111111111111111111111111112"
          : buildBantahBroTelegramStartButtonPrompt(actionOrId);
      await sendTelegramText(payload, prompt, [
        [callbackButton("❌ Cancel", "bb:state:clear"), callbackButton("😎 Main Menu", "bb:menu:main")],
      ]);
      return;
    }
  }

  if (family === "run") {
    if (actionOrId === "alerts") {
      await handleAlertsCommand(payload);
      return;
    }
    if (actionOrId === "markets") {
      await handleMarketsCommand(payload);
      return;
    }
    if (actionOrId === "leaderboard") {
      await handleLeaderboardCommand(payload);
      return;
    }
    if (actionOrId === "bxbt") {
      await handleBxbtCommand(payload);
      return;
    }
  }

  if (family === "market" && actionOrId) {
    await handleMarketForAlert(payload, actionOrId, maybeMode === "runner" ? "runner" : "rug");
    return;
  }

  if (family === "receipt" && actionOrId) {
    await handleReceiptForAlert(payload, actionOrId);
    return;
  }

  if (family === "state" && actionOrId === "clear") {
    const key = getStateKey(query?.message?.chat?.id, query?.from?.id);
    if (key) telegramCommandStates.delete(key);
    await sendTelegramText(payload, "🧹 Cleared. Pick the next move.", buildMainMenuButtons());
  }
}

async function attachCallbackBridge(runtime: IAgentRuntime) {
  const service = runtime.getService("telegram") as any;
  const bot = service?.bot || service?.messageManager?.bot;
  if (!service || !bot || attachedTelegramServices.has(service)) {
    return Boolean(bot);
  }

  attachedTelegramServices.add(service);
  if (typeof bot.action === "function") {
    bot.action(/^bb:/, async (ctx: any) => {
      try {
        await handleCallbackAction(ctx, runtime);
      } catch (error) {
        await answerCallback(ctx, "⚠️ That action failed. Try again.", true).catch(() => null);
        const chatId = ctx?.callbackQuery?.message?.chat?.id;
        if (chatId && typeof ctx?.telegram?.sendMessage === "function") {
          await ctx.telegram.sendMessage(
            chatId,
            error instanceof Error ? `⚠️ Action failed.\n\n${error.message}` : "⚠️ Action failed.",
          );
        }
      }
    });
  }

  return true;
}

async function attachCallbackBridgeWhenReady(runtime: IAgentRuntime) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await attachCallbackBridge(runtime)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export const bantahBroTelegramCommandsPlugin: Plugin = {
  name: "bantahbro-telegram-commands",
  description:
    "Handles BantahBro Telegram slash commands and quick-reply task buttons inside the Eliza runtime.",
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    void attachCallbackBridgeWhenReady(runtime);
  },
  events: {
    TELEGRAM_MESSAGE_RECEIVED: [
      async (payload: TelegramMessageEventPayload) => {
        await handleBantahBroTelegramCommandEvent(payload);
      },
    ],
  },
};
