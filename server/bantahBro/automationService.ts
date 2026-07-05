import { elizaLogger } from "@elizaos/core";
import { bantahBroAlertSchema, type BantahBroAlert, type BantahBroTokenRef } from "@shared/bantahBro";
import {
  getBantahBroAlert,
  getBantahBroReceiptBySourceAlert,
  listBantahBroAlerts,
  publishBantahBroAlert,
  publishBantahBroReceipt,
} from "./alertFeed";
import { buildAlertFromAnalysis, buildReceiptFromAlert } from "./contentEngine";
import { createBantahBroMarketFromSignal } from "./marketService";
import { analyzeToken } from "./tokenIntelligence";
import { defaultBantahBroMarketCurrency } from "./telegramSupport";
import { getBantahBroTelegramBot } from "../telegramBot";
import {
  getBantahBroTwitterAgentStatus,
  postCurrentBattleTweet,
  runBantahBroTwitterAgentCycle,
} from "./twitterAgentService";

type AutomationConfig = {
  enabled: boolean;
  watchlist: BantahBroTokenRef[];
  tokenMonitorIntervalMs: number;
  alertSchedulerIntervalMs: number;
  marketTriggerIntervalMs: number;
  twitterMonitorIntervalMs: number;
  alertCooldownMs: number;
  receiptDelayMs: number;
  autoMarketEnabled: boolean;
  autoMarketMinConfidence: number;
  autoMarketMaxPerCycle: number;
  autoMarketStakeAmount: string;
  rugMarketDurationHours: number;
  runnerMarketDurationHours: number;
  chargeBxbtForAutoMarkets: boolean;
  enableWatchAlerts: boolean;
  telegramBroadcastsEnabled: boolean;
  twitterMonitorEnabled: boolean;
  twitterReplyLoopEnabled: boolean;
  twitterReadEnabled: boolean;
  twitterSearchEnabled: boolean;
};

type LoopName = "tokenMonitor" | "alertScheduler" | "marketTrigger" | "twitterMonitor";

type AutomationStatus = {
  started: boolean;
  enabled: boolean;
  watchlistSize: number;
  lastTokenMonitorAt: string | null;
  lastAlertSchedulerAt: string | null;
  lastMarketTriggerAt: string | null;
  lastTwitterLoopAt: string | null;
  publishedAlerts: number;
  createdMarkets: number;
  publishedReceipts: number;
  twitterLoop: {
    enabled: boolean;
    active: boolean;
    reason: string;
  };
};

type PublishedAlertState = {
  publishedAt: number;
  rugScore: number | null;
  momentumScore: number | null;
  confidence: number;
};

const DEFAULT_WATCHLIST = "";
const DEFAULT_TOKEN_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_ALERT_SCHEDULER_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_MARKET_TRIGGER_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_TWITTER_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_ALERT_COOLDOWN_MS = 90 * 60 * 1000;
const DEFAULT_RECEIPT_DELAY_MS = 2 * 60 * 60 * 1000;

const loopTimers = new Map<LoopName, NodeJS.Timeout>();
const loopRunning = new Map<LoopName, boolean>();
const publishedAlertState = new Map<string, PublishedAlertState>();
const marketTriggeredAlertIds = new Set<string>();
let twitterWarningPrinted = false;

const automationStatus: AutomationStatus = {
  started: false,
  enabled: false,
  watchlistSize: 0,
  lastTokenMonitorAt: null,
  lastAlertSchedulerAt: null,
  lastMarketTriggerAt: null,
  lastTwitterLoopAt: null,
  publishedAlerts: 0,
  createdMarkets: 0,
  publishedReceipts: 0,
  twitterLoop: {
    enabled: false,
    active: false,
    reason: "disabled",
  },
};

function parseBooleanEnv(name: string, fallback: boolean) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function parseIntegerEnv(name: string, fallback: number) {
  const raw = Number.parseInt(String(process.env[name] || "").trim(), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function parseNumberEnv(name: string, fallback: number) {
  const raw = Number(String(process.env[name] || "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function parseWatchlistEntry(entry: string): BantahBroTokenRef | null {
  const normalized = entry.trim();
  if (!normalized) return null;

  const parts = normalized
    .split(/[:|]/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return {
      chainId: parts[0],
      tokenAddress: parts.slice(1).join(":"),
    };
  }

  return {
    chainId: "solana",
    tokenAddress: normalized,
  };
}

function parseWatchlist(value: string) {
  const entries = value
    .split(/[,\n;\r]+/)
    .map((entry) => parseWatchlistEntry(entry))
    .filter((entry): entry is BantahBroTokenRef => Boolean(entry));

  const deduped = new Map<string, BantahBroTokenRef>();
  for (const entry of entries) {
    deduped.set(`${entry.chainId.toLowerCase()}:${entry.tokenAddress.toLowerCase()}`, entry);
  }

  return Array.from(deduped.values());
}

function loadAutomationConfig(): AutomationConfig {
  const watchlist = parseWatchlist(
    String(process.env.BANTAHBRO_TOKEN_WATCHLIST || DEFAULT_WATCHLIST),
  );

  return {
    enabled: parseBooleanEnv("BANTAHBRO_AUTOMATION_ENABLED", true),
    watchlist,
    tokenMonitorIntervalMs:
      parseIntegerEnv("BANTAHBRO_TOKEN_MONITOR_INTERVAL_SECONDS", 300) * 1000 ||
      DEFAULT_TOKEN_MONITOR_INTERVAL_MS,
    alertSchedulerIntervalMs:
      parseIntegerEnv("BANTAHBRO_ALERT_SCHEDULER_INTERVAL_SECONDS", 600) * 1000 ||
      DEFAULT_ALERT_SCHEDULER_INTERVAL_MS,
    marketTriggerIntervalMs:
      parseIntegerEnv("BANTAHBRO_MARKET_TRIGGER_INTERVAL_SECONDS", 180) * 1000 ||
      DEFAULT_MARKET_TRIGGER_INTERVAL_MS,
    twitterMonitorIntervalMs:
      parseIntegerEnv("BANTAHBRO_TWITTER_MONITOR_INTERVAL_SECONDS", 300) * 1000 ||
      DEFAULT_TWITTER_MONITOR_INTERVAL_MS,
    alertCooldownMs:
      parseIntegerEnv("BANTAHBRO_ALERT_COOLDOWN_MINUTES", 90) * 60 * 1000 ||
      DEFAULT_ALERT_COOLDOWN_MS,
    receiptDelayMs:
      parseIntegerEnv("BANTAHBRO_RECEIPT_DELAY_MINUTES", 120) * 60 * 1000 ||
      DEFAULT_RECEIPT_DELAY_MS,
    autoMarketEnabled: parseBooleanEnv("BANTAHBRO_AUTO_MARKET_ENABLED", true),
    autoMarketMinConfidence: Math.max(
      0,
      Math.min(1, parseNumberEnv("BANTAHBRO_AUTO_MARKET_MIN_CONFIDENCE", 0.78)),
    ),
    autoMarketMaxPerCycle: parseIntegerEnv("BANTAHBRO_AUTO_MARKET_MAX_PER_CYCLE", 2),
    autoMarketStakeAmount: String(
      process.env.BANTAHBRO_AUTO_MARKET_STAKE_AMOUNT || "10",
    ).trim() || "10",
    rugMarketDurationHours: parseIntegerEnv("BANTAHBRO_RUG_MARKET_DURATION_HOURS", 6),
    runnerMarketDurationHours: parseIntegerEnv(
      "BANTAHBRO_RUNNER_MARKET_DURATION_HOURS",
      24,
    ),
    chargeBxbtForAutoMarkets: parseBooleanEnv(
      "BANTAHBRO_AUTO_MARKET_CHARGE_BXBT",
      false,
    ),
    enableWatchAlerts: parseBooleanEnv("BANTAHBRO_ENABLE_WATCH_ALERTS", false),
    // Automation is allowed to observe and build internal state, but Telegram
    // sends must stay opt-in so scanner/test loops never look like real usage.
    telegramBroadcastsEnabled: parseBooleanEnv(
      "BANTAHBRO_TELEGRAM_AUTOMATION_BROADCAST_ENABLED",
      false,
    ),
    twitterMonitorEnabled: parseBooleanEnv(
      "BANTAHBRO_TWITTER_MONITOR_ENABLED",
      false,
    ),
    twitterReplyLoopEnabled: parseBooleanEnv(
      "BANTAHBRO_TWITTER_REPLY_LOOP_ENABLED",
      false,
    ),
    twitterReadEnabled: parseBooleanEnv("BANTAHBRO_TWITTER_READ_ENABLED", false),
    twitterSearchEnabled: parseBooleanEnv("BANTAHBRO_TWITTER_SEARCH_ENABLED", false),
  };
}

function buildPublishedAlertKey(alert: BantahBroAlert) {
  return `${alert.chainId.toLowerCase()}:${alert.tokenAddress.toLowerCase()}:${alert.type}`;
}

function shouldPublishAutomatedAlert(
  alert: BantahBroAlert,
  config: AutomationConfig,
) {
  if (alert.type === "watch_alert" && !config.enableWatchAlerts) {
    return false;
  }

  if (alert.type !== "rug_alert" && alert.type !== "runner_alert" && alert.type !== "watch_alert") {
    return false;
  }

  if (alert.type !== "watch_alert" && alert.confidence < 0.55) {
    return false;
  }

  const key = buildPublishedAlertKey(alert);
  const existing = publishedAlertState.get(key);
  if (!existing) return true;

  const now = Date.now();
  if (now - existing.publishedAt >= config.alertCooldownMs) {
    return true;
  }

  const rugDelta = Math.abs((alert.rugScore ?? 0) - (existing.rugScore ?? 0));
  const momentumDelta = Math.abs((alert.momentumScore ?? 0) - (existing.momentumScore ?? 0));
  const confidenceDelta = Math.abs(alert.confidence - existing.confidence);

  return rugDelta >= 8 || momentumDelta >= 8 || confidenceDelta >= 0.1;
}

async function broadcastAlertIfPossible(
  config: AutomationConfig,
  alert: BantahBroAlert,
  analysis?: Awaited<ReturnType<typeof analyzeToken>>,
) {
  if (!config.telegramBroadcastsEnabled) return;
  const telegramBot = getBantahBroTelegramBot();
  if (!telegramBot) return;
  await telegramBot.broadcastBantahBroAlert(alert, analysis);
}

async function broadcastReceiptIfPossible(
  config: AutomationConfig,
  receipt: ReturnType<typeof buildReceiptFromAlert>,
) {
  if (!config.telegramBroadcastsEnabled) return;
  const telegramBot = getBantahBroTelegramBot();
  if (!telegramBot) return;
  await telegramBot.broadcastBantahBroReceipt(receipt);
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function publishReceiptAlert(
  sourceAlert: BantahBroAlert,
  analysis: Awaited<ReturnType<typeof analyzeToken>>,
  receipt: ReturnType<typeof buildReceiptFromAlert>,
) {
  return publishBantahBroAlert(
    bantahBroAlertSchema.parse({
      id: `bb_alert_receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type:
        receipt.status === "printed" || receipt.status === "top_signal"
          ? "receipt"
          : "aftermath",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chainId: receipt.chainId,
      tokenAddress: receipt.tokenAddress,
      tokenSymbol: receipt.tokenSymbol,
      tokenName: receipt.tokenName,
      headline: receipt.headline,
      body: receipt.body,
      sentiment:
        receipt.status === "rekt"
          ? "bearish"
          : receipt.status === "watching"
            ? "mixed"
            : "bullish",
      confidence:
        receipt.status === "top_signal"
          ? 0.95
          : receipt.status === "printed"
            ? 0.8
            : 0.55,
      rugScore: analysis.rug.score,
      momentumScore: analysis.momentum.score,
      referencePriceUsd: receipt.latestPriceUsd,
      sourceAnalysisAt: analysis.generatedAt,
      market: receipt.market,
      boost: null,
      metadata: {
        receiptId: receipt.id,
        sourceAlertId: sourceAlert.id,
        rewardEligible: receipt.rewardEligible,
        multiple: receipt.multiple,
        source: "automation",
      },
    }),
  );
}

async function runTokenMonitorCycle(config: AutomationConfig) {
  automationStatus.lastTokenMonitorAt = new Date().toISOString();

  if (config.watchlist.length === 0) {
    return;
  }

  for (const token of config.watchlist) {
    try {
      const analysis = await analyzeToken(token);
      const alert = buildAlertFromAnalysis(analysis, "auto");

      if (!shouldPublishAutomatedAlert(alert, config)) {
        continue;
      }

      const published = publishBantahBroAlert(alert);
      publishedAlertState.set(buildPublishedAlertKey(published), {
        publishedAt: Date.now(),
        rugScore: published.rugScore,
        momentumScore: published.momentumScore,
        confidence: published.confidence,
      });
      automationStatus.publishedAlerts += 1;
      await broadcastAlertIfPossible(config, published, analysis);

      elizaLogger.info(
        `[BantahBro Automation] Published ${published.type} for ${published.chainId}:${published.tokenAddress}`,
      );
    } catch (error) {
      elizaLogger.error(
        `[BantahBro Automation] Token monitor failed for ${token.chainId}:${token.tokenAddress}: ${toErrorMessage(error)}`,
      );
    }
  }
}

async function runAlertSchedulerCycle(config: AutomationConfig) {
  automationStatus.lastAlertSchedulerAt = new Date().toISOString();
  const dueAlerts = listBantahBroAlerts(100).filter((alert) => {
    if (alert.type !== "rug_alert" && alert.type !== "runner_alert" && alert.type !== "watch_alert") {
      return false;
    }
    if (getBantahBroReceiptBySourceAlert(alert.id)) return false;
    if (!alert.referencePriceUsd || alert.referencePriceUsd <= 0) return false;
    const ageMs = Date.now() - new Date(alert.createdAt).getTime();
    return ageMs >= config.receiptDelayMs;
  });

  for (const sourceAlert of dueAlerts.slice(0, 5)) {
    try {
      const analysis = await analyzeToken({
        chainId: sourceAlert.chainId,
        tokenAddress: sourceAlert.tokenAddress,
      });
      const receipt = publishBantahBroReceipt(buildReceiptFromAlert(sourceAlert, analysis));
      publishReceiptAlert(sourceAlert, analysis, receipt);
      automationStatus.publishedReceipts += 1;
      await broadcastReceiptIfPossible(config, receipt);

      elizaLogger.info(
        `[BantahBro Automation] Published receipt ${receipt.id} for alert ${sourceAlert.id}`,
      );
    } catch (error) {
      elizaLogger.error(
        `[BantahBro Automation] Receipt scheduler failed for alert ${sourceAlert.id}: ${toErrorMessage(error)}`,
      );
    }
  }
}

async function runMarketTriggerCycle(config: AutomationConfig) {
  automationStatus.lastMarketTriggerAt = new Date().toISOString();

  if (!config.autoMarketEnabled) {
    return;
  }

  let createdThisCycle = 0;
  const candidates = listBantahBroAlerts(100).filter((alert) => {
    if (alert.type !== "rug_alert" && alert.type !== "runner_alert") return false;
    if (alert.market) return false;
    if (alert.confidence < config.autoMarketMinConfidence) return false;
    if (marketTriggeredAlertIds.has(alert.id)) return false;
    return true;
  });

  for (const alert of candidates) {
    if (createdThisCycle >= config.autoMarketMaxPerCycle) {
      break;
    }

    try {
      const result = await createBantahBroMarketFromSignal({
        sourceAlertId: alert.id,
        durationHours:
          alert.type === "runner_alert"
            ? config.runnerMarketDurationHours
            : config.rugMarketDurationHours,
        stakeAmount: config.autoMarketStakeAmount,
        currency: defaultBantahBroMarketCurrency(alert.chainId),
        sourcePlatform: "system",
        chargeBxbt: config.chargeBxbtForAutoMarkets,
      });
      marketTriggeredAlertIds.add(alert.id);
      createdThisCycle += 1;
      automationStatus.createdMarkets += 1;

      if (result.marketAlert) {
        await broadcastAlertIfPossible(config, result.marketAlert, result.analysis);
      }

      elizaLogger.info(
        `[BantahBro Automation] Auto-created market ${result.market.challengeId} from alert ${alert.id}`,
      );
    } catch (error) {
      elizaLogger.error(
        `[BantahBro Automation] Market trigger failed for alert ${alert.id}: ${toErrorMessage(error)}`,
      );
    }
  }
}

async function runTwitterMonitorCycle(config: AutomationConfig) {
  automationStatus.lastTwitterLoopAt = new Date().toISOString();
  automationStatus.twitterLoop.enabled =
    config.twitterMonitorEnabled ||
    config.twitterReplyLoopEnabled ||
    config.twitterReadEnabled ||
    config.twitterSearchEnabled;
  automationStatus.twitterLoop.active = false;

  if (!automationStatus.twitterLoop.enabled) {
    automationStatus.twitterLoop.reason = "disabled";
    return;
  }

  const twitterStatus = getBantahBroTwitterAgentStatus();
  automationStatus.twitterLoop.active =
    twitterStatus.configured &&
    (twitterStatus.postEnabled ||
      twitterStatus.readEnabled ||
      twitterStatus.searchEnabled ||
      twitterStatus.replyEnabled);

  if (automationStatus.twitterLoop.enabled && !twitterWarningPrinted) {
    twitterWarningPrinted = true;
    elizaLogger.info("[BantahBro Automation] Twitter monitor loop requested.");
  }

  if (!twitterStatus.configured) {
    automationStatus.twitterLoop.reason = twitterStatus.reason;
    return;
  }

  const reasons: string[] = [];

  try {
    if (
      config.twitterReplyLoopEnabled ||
      config.twitterReadEnabled ||
      config.twitterSearchEnabled ||
      twitterStatus.readEnabled ||
      twitterStatus.searchEnabled
    ) {
      const result = await runBantahBroTwitterAgentCycle();
      reasons.push(result.reason);
    }

    if (config.twitterMonitorEnabled && twitterStatus.postEnabled) {
      const result = await postCurrentBattleTweet();
      reasons.push(`Posted live Agent Battle tweet ${result.tweet.id}.`);
    } else if (config.twitterMonitorEnabled && !twitterStatus.postEnabled) {
      reasons.push(twitterStatus.reason);
    }

    automationStatus.twitterLoop.reason =
      reasons.filter(Boolean).join(" | ") || "Twitter loop checked; no action required.";
  } catch (error) {
    const message = toErrorMessage(error);
    automationStatus.twitterLoop.reason = message;
    if (!/already been posted/i.test(message)) {
      elizaLogger.warn(`[BantahBro Automation] Twitter battle post skipped: ${message}`);
    }
  }
}

function scheduleLoop(
  name: LoopName,
  intervalMs: number,
  runner: (config: AutomationConfig) => Promise<void>,
  config: AutomationConfig,
) {
  const tick = async () => {
    if (!automationStatus.started) return;
    if (loopRunning.get(name)) {
      loopTimers.set(name, setTimeout(tick, intervalMs));
      return;
    }

    loopRunning.set(name, true);
    try {
      await runner(config);
    } finally {
      loopRunning.set(name, false);
      if (automationStatus.started) {
        const timeout = setTimeout(tick, intervalMs);
        timeout.unref?.();
        loopTimers.set(name, timeout);
      }
    }
  };

  const timeout = setTimeout(tick, 1000);
  timeout.unref?.();
  loopTimers.set(name, timeout);
}

export function getBantahBroAutomationStatus() {
  return {
    ...automationStatus,
  };
}

export function stopBantahBroAutomationService() {
  automationStatus.started = false;
  for (const timeout of loopTimers.values()) {
    clearTimeout(timeout);
  }
  loopTimers.clear();
}

export async function runBantahBroAutomationOnce() {
  const config = loadAutomationConfig();
  automationStatus.enabled = config.enabled;
  automationStatus.watchlistSize = config.watchlist.length;
  automationStatus.twitterLoop.enabled =
    config.twitterMonitorEnabled ||
    config.twitterReplyLoopEnabled ||
    config.twitterReadEnabled ||
    config.twitterSearchEnabled;
  automationStatus.twitterLoop.active = false;
  automationStatus.twitterLoop.reason =
    automationStatus.twitterLoop.enabled
      ? getBantahBroTwitterAgentStatus().reason
      : "disabled";

  if (!config.enabled) {
    return {
      ...getBantahBroAutomationStatus(),
      reason: "disabled",
    };
  }

  await runTokenMonitorCycle(config);
  await runAlertSchedulerCycle(config);
  await runMarketTriggerCycle(config);
  await runTwitterMonitorCycle(config);

  return {
    ...getBantahBroAutomationStatus(),
    reason: "completed",
  };
}

export async function startBantahBroAutomationService() {
  if (automationStatus.started) {
    return getBantahBroAutomationStatus();
  }

  const config = loadAutomationConfig();
  automationStatus.started = true;
  automationStatus.enabled = config.enabled;
  automationStatus.watchlistSize = config.watchlist.length;
  automationStatus.twitterLoop.enabled =
    config.twitterMonitorEnabled ||
    config.twitterReplyLoopEnabled ||
    config.twitterReadEnabled ||
    config.twitterSearchEnabled;
  automationStatus.twitterLoop.active = false;
  automationStatus.twitterLoop.reason =
    automationStatus.twitterLoop.enabled
      ? getBantahBroTwitterAgentStatus().reason
      : "disabled";

  if (!config.enabled) {
    elizaLogger.info("[BantahBro Automation] Automation disabled by env.");
    return getBantahBroAutomationStatus();
  }

  elizaLogger.info(
    `[BantahBro Automation] Starting with ${config.watchlist.length} watchlist token(s).`,
  );

  scheduleLoop("tokenMonitor", config.tokenMonitorIntervalMs, runTokenMonitorCycle, config);
  scheduleLoop(
    "alertScheduler",
    config.alertSchedulerIntervalMs,
    runAlertSchedulerCycle,
    config,
  );
  scheduleLoop(
    "marketTrigger",
    config.marketTriggerIntervalMs,
    runMarketTriggerCycle,
    config,
  );
  scheduleLoop(
    "twitterMonitor",
    config.twitterMonitorIntervalMs,
    runTwitterMonitorCycle,
    config,
  );

  return getBantahBroAutomationStatus();
}
