import { settleDueAgentBattleP2PRounds } from "./agentBattleP2PService";

type SettlementWorkerStatus = {
  enabled: boolean;
  started: boolean;
  intervalMs: number;
  limit: number;
  maxPairsPerRound: number;
  reason?: string;
};

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LIMIT = 5;
const DEFAULT_MAX_PAIRS_PER_ROUND = 20;

let timer: NodeJS.Timeout | null = null;
let runPromise: Promise<any> | null = null;

function parseBooleanEnv(name: string, fallback: boolean) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function parseIntegerEnv(name: string, fallback: number) {
  const raw = Number.parseInt(String(process.env[name] || "").trim(), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function loadSettlementWorkerConfig() {
  return {
    enabled: parseBooleanEnv("BANTAHBRO_BATTLE_SETTLEMENT_WORKER_ENABLED", true),
    intervalMs: Math.max(
      10_000,
      parseIntegerEnv("BANTAHBRO_BATTLE_SETTLEMENT_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    ),
    limit: Math.max(
      1,
      Math.min(
        25,
        parseIntegerEnv("BANTAHBRO_BATTLE_SETTLEMENT_ROUND_LIMIT", DEFAULT_LIMIT),
      ),
    ),
    maxPairsPerRound: Math.max(
      1,
      Math.min(
        100,
        parseIntegerEnv(
          "BANTAHBRO_BATTLE_SETTLEMENT_MAX_PAIRS_PER_ROUND",
          DEFAULT_MAX_PAIRS_PER_ROUND,
        ),
      ),
    ),
  };
}

export async function runBantahBroAgentBattleSettlementOnce() {
  if (runPromise) return runPromise;

  const config = loadSettlementWorkerConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      reason: "disabled",
      intervalMs: config.intervalMs,
      limit: config.limit,
      maxPairsPerRound: config.maxPairsPerRound,
    };
  }

  runPromise = settleDueAgentBattleP2PRounds({
    limit: config.limit,
    maxPairsPerRound: config.maxPairsPerRound,
  })
    .then((result) => {
      if (result.settled || result.partiallySettled || result.failed) {
        console.log(
          `[OK] BantahBro battle settlement worker: ` +
            `${result.settled} settled, ${result.partiallySettled} partial, ${result.failed} failed`,
        );
      }
      return {
        enabled: true,
        intervalMs: config.intervalMs,
        limit: config.limit,
        maxPairsPerRound: config.maxPairsPerRound,
        ...result,
      };
    })
    .catch((error) => {
      console.error("[WARN] BantahBro battle settlement worker failed:", error);
      return {
        enabled: true,
        intervalMs: config.intervalMs,
        limit: config.limit,
        maxPairsPerRound: config.maxPairsPerRound,
        error: error instanceof Error ? error.message : String(error),
      };
    })
    .finally(() => {
      runPromise = null;
    });

  return runPromise;
}

async function runSettlementLoop() {
  await runBantahBroAgentBattleSettlementOnce();
}

export function startBantahBroAgentBattleSettlementWorker(): SettlementWorkerStatus {
  const config = loadSettlementWorkerConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      started: false,
      intervalMs: config.intervalMs,
      limit: config.limit,
      maxPairsPerRound: config.maxPairsPerRound,
      reason: "disabled",
    };
  }

  if (!timer) {
    const initialDelayMs = Math.min(10_000, config.intervalMs);
    setTimeout(() => {
      void runSettlementLoop();
    }, initialDelayMs).unref?.();
    timer = setInterval(() => {
      void runSettlementLoop();
    }, config.intervalMs);
    timer.unref?.();
  }

  return {
    enabled: true,
    started: true,
    intervalMs: config.intervalMs,
    limit: config.limit,
    maxPairsPerRound: config.maxPairsPerRound,
  };
}

export function stopBantahBroAgentBattleSettlementWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
