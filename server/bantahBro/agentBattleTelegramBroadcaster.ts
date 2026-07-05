import fs from "fs/promises";
import path from "path";
import { pool } from "../db";
import { getBantahBroTelegramBot } from "../telegramBot";
import {
  getLiveBantahBroAgentBattles,
  type BantahBroAgentBattle,
} from "./agentBattleService";
import { listBotaAgentChallenges, updateBotaAgentChallengeMetadata } from "./botaAgentChallengeService";


type BroadcastConfig = {
  enabled: boolean;
  intervalMs: number;
  limit: number;
  minSecondsLeft: number;
};

type BroadcastState = {
  sent: Record<string, string>;
};

type BroadcasterStatus = {
  enabled: boolean;
  started: boolean;
  intervalMs: number;
  limit: number;
  reason?: string;
};

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LIMIT = 1;
const DEFAULT_MIN_SECONDS_LEFT = 45;
const MAX_STATE_ENTRIES = 500;
const STATE_PATH = path.resolve(process.cwd(), "cache", "bantahbro-telegram-battle-broadcasts.json");
const DB_STATE_KEY = "bantahbro-telegram-battle-broadcasts";

let timer: NodeJS.Timeout | null = null;
let runPromise: Promise<void> | null = null;

function parseBooleanEnv(name: string, fallback: boolean) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function parseIntegerEnv(name: string, fallback: number) {
  const raw = Number.parseInt(String(process.env[name] || "").trim(), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function loadConfig(): BroadcastConfig {
  return {
    // Keep Arena battle alerts live by default; set the env var to false to opt out.
    enabled: parseBooleanEnv("BANTAHBRO_TELEGRAM_BATTLE_BROADCAST_ENABLED", true),
    intervalMs: Math.max(
      10_000,
      parseIntegerEnv(
        "BANTAHBRO_TELEGRAM_BATTLE_BROADCAST_INTERVAL_MS",
        DEFAULT_INTERVAL_MS,
      ),
    ),
    limit: Math.max(
      1,
      Math.min(
        3,
        parseIntegerEnv("BANTAHBRO_TELEGRAM_BATTLE_BROADCAST_LIMIT", DEFAULT_LIMIT),
      ),
    ),
    minSecondsLeft: Math.max(
      0,
      Math.min(
        240,
        parseIntegerEnv(
          "BANTAHBRO_TELEGRAM_BATTLE_MIN_SECONDS_LEFT",
          DEFAULT_MIN_SECONDS_LEFT,
        ),
      ),
    ),
  };
}

function broadcastKeyForBattle(battle: BantahBroAgentBattle) {
  return `telegram-agent-battle-${battle.id}-${battle.startsAt}`;
}

function shouldUseDatabaseState() {
  const raw = String(process.env.BANTAHBRO_TELEGRAM_BATTLE_BROADCAST_STATE || "").trim().toLowerCase();
  return raw === "database" || raw === "db" || process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

async function ensureRuntimeStateTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bantah_runtime_state (
       state_key text PRIMARY KEY,
       state_value jsonb NOT NULL DEFAULT '{}'::jsonb,
       updated_at timestamp DEFAULT now()
     )`,
  );
}

function normalizeBroadcastState(input: unknown): BroadcastState {
  if (!input || typeof input !== "object") {
    return { sent: {} };
  }

  const parsed = input as Partial<BroadcastState>;
  if (parsed.sent && typeof parsed.sent === "object") {
    return { sent: parsed.sent };
  }

  return { sent: {} };
}

async function loadState(): Promise<BroadcastState> {
  if (shouldUseDatabaseState()) {
    try {
      await ensureRuntimeStateTable();
      const result = await pool.query(
        `SELECT state_value FROM bantah_runtime_state WHERE state_key = $1 LIMIT 1`,
        [DB_STATE_KEY],
      );
      const value = result.rows[0]?.state_value;
      return normalizeBroadcastState(typeof value === "string" ? JSON.parse(value) : value);
    } catch {
      return { sent: {} };
    }
  }

  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    return normalizeBroadcastState(JSON.parse(raw));
  } catch {
    // First run or damaged cache: start clean instead of blocking broadcasts.
  }
  return { sent: {} };
}

async function saveState(state: BroadcastState) {
  const sortedEntries = Object.entries(state.sent)
    .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
    .slice(0, MAX_STATE_ENTRIES);
  const normalizedState = { sent: Object.fromEntries(sortedEntries) };

  if (shouldUseDatabaseState()) {
    await ensureRuntimeStateTable();
    await pool.query(
      `INSERT INTO bantah_runtime_state (state_key, state_value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (state_key)
       DO UPDATE SET state_value = excluded.state_value, updated_at = excluded.updated_at`,
      [DB_STATE_KEY, JSON.stringify(normalizedState)],
    );
    return;
  }

  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(
    STATE_PATH,
    JSON.stringify(normalizedState, null, 2),
    "utf8",
  );
}

export async function broadcastBantahBroLiveBattlesOnce() {
  const config = loadConfig();
  if (!config.enabled) {
    return { sent: 0, skipped: 0, reason: "disabled" };
  }

  const bot = getBantahBroTelegramBot();
  if (!bot) {
    return { sent: 0, skipped: 0, reason: "bot-not-configured" };
  }

  const feed = await getLiveBantahBroAgentBattles(config.limit);
  const state = await loadState();
  let sent = 0;
  let skipped = 0;
  let stateChanged = false;

  for (const battle of feed.battles) {
    const key = broadcastKeyForBattle(battle);
    if (state.sent[key]) {
      skipped += 1;
      continue;
    }

    if (battle.timeRemainingSeconds < config.minSecondsLeft) {
      skipped += 1;
      continue;
    }

    const didSend = await bot.broadcastBantahBroAgentBattle(battle, {
      broadcastId: key,
    });

    if (didSend) {
      state.sent[key] = new Date().toISOString();
      stateChanged = true;
      sent += 1;
    } else {
      skipped += 1;
    }
  }

  if (stateChanged) {
    await saveState(state);
  }

  return { sent, skipped, reason: sent > 0 ? "broadcasted" : "no-new-battles" };
}

export async function broadcastBotaAgentChallengesOnce() {
  const config = loadConfig();
  if (!config.enabled) {
    return { sent: 0, skipped: 0, reason: "disabled" };
  }

  const bot = getBantahBroTelegramBot();
  if (!bot) {
    return { sent: 0, skipped: 0, reason: "bot-not-configured" };
  }

  // Fetch pending, scheduled, live, cancelled, expired challenges
  const recentChallenges = await listBotaAgentChallenges({ limit: 20 });
  const state = await loadState();
  let sent = 0;
  let skipped = 0;
  let stateChanged = false;

  for (const challenge of recentChallenges.challenges) {
    // Only broadcast ones that need to be broadcasted
    // The key should include the status so we broadcast state changes
    const key = `telegram-challenge-${challenge.id}-${challenge.status}`;
    if (state.sent[key]) {
      skipped += 1;
      continue;
    }

    const didSend = await bot.broadcastBotaAgentChallenge(challenge, {
      broadcastId: key,
    });

    if (didSend) {
      state.sent[key] = new Date().toISOString();
      stateChanged = true;
      sent += 1;
      
      // Update metadata to indicate we've broadcasted it
      try {
         await updateBotaAgentChallengeMetadata({
           challengeCode: challenge.challengeCode,
           metadata: {
             lastBroadcastedStatus: challenge.status,
             lastBroadcastedAt: new Date().toISOString()
           }
         });
      } catch(e) {
         // ignore
      }
    } else {
      skipped += 1;
    }
  }

  if (stateChanged) {
    await saveState(state);
  }

  return { sent, skipped, reason: sent > 0 ? "broadcasted" : "no-new-challenges" };
}

async function runBroadcastLoop() {
  if (runPromise) return runPromise;
  runPromise = Promise.all([
    broadcastBantahBroLiveBattlesOnce()
      .then((result) => {
        if (result.sent > 0) {
          console.log(`[OK] BantahBro Telegram battle broadcasts sent: ${result.sent}`);
        }
      })
      .catch((error) => {
        console.error("[WARN] BantahBro Telegram battle broadcast failed:", error);
      }),
    broadcastBotaAgentChallengesOnce()
      .then((result) => {
        if (result.sent > 0) {
          console.log(`[OK] BOTA Telegram challenge broadcasts sent: ${result.sent}`);
        }
      })
      .catch((error) => {
        console.error("[WARN] BOTA Telegram challenge broadcast failed:", error);
      })
  ])
  .then(() => {})
  .finally(() => {
    runPromise = null;
  });
  return runPromise;
}

export function startBantahBroAgentBattleTelegramBroadcaster(): BroadcasterStatus {
  const config = loadConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      started: false,
      intervalMs: config.intervalMs,
      limit: config.limit,
      reason: "disabled",
    };
  }

  if (!getBantahBroTelegramBot()) {
    return {
      enabled: true,
      started: false,
      intervalMs: config.intervalMs,
      limit: config.limit,
      reason: "bot-not-configured",
    };
  }

  if (!timer) {
    void runBroadcastLoop();
    timer = setInterval(() => {
      void runBroadcastLoop();
    }, config.intervalMs);
    timer.unref?.();
  }

  return {
    enabled: true,
    started: true,
    intervalMs: config.intervalMs,
    limit: config.limit,
  };
}
