import type {
  BotaAgentIntent,
  BotaArenaBattleState,
  BotaArenaFighter,
} from "@shared/botaArena";
import { botaAgentIntentSchema } from "@shared/botaArena";

export type BotaAgentDecisionProvider = {
  id: "elizaos" | "mock-game" | "game-sdk";
  decide(input: {
    state: BotaArenaBattleState;
    actor: BotaArenaFighter;
    opponent: BotaArenaFighter;
  }): Promise<BotaAgentIntent>;
};

function healthRatio(fighter: BotaArenaFighter) {
  return fighter.maxHealth > 0 ? fighter.health / fighter.maxHealth : 0;
}

function hasCooldown(fighter: BotaArenaFighter, keyPrefix: string) {
  return Object.entries(fighter.cooldowns || {}).some(
    ([key, rounds]) => key.startsWith(keyPrefix) && rounds > 0,
  );
}

export class MockGameDecisionProvider implements BotaAgentDecisionProvider {
  constructor(public id: "elizaos" | "mock-game" = "mock-game") {}

  async decide(input: {
    state: BotaArenaBattleState;
    actor: BotaArenaFighter;
    opponent: BotaArenaFighter;
  }): Promise<BotaAgentIntent> {
    const { actor, opponent } = input;
    const actorHealth = healthRatio(actor);
    const opponentHealth = healthRatio(opponent);
    const behind = actorHealth + actor.energy / 220 < opponentHealth + opponent.energy / 220;
    const canSpecial = actor.energy >= 36 && !hasCooldown(actor, "special:");
    const canCounter = actor.energy >= 18 && !hasCooldown(actor, "counter");

    if (actorHealth < 0.3 && canCounter) {
      return {
        agentId: actor.id,
        source: this.id,
        action: "counter",
        skill: "Reversal Guard",
        target: "enemy",
        confidence: 0.68,
        rationale: "Low health fighter chooses a safer counter line from current battle memory.",
      };
    }

    if ((behind || opponentHealth < 0.45) && canSpecial) {
      return {
        agentId: actor.id,
        source: this.id,
        action: "special",
        skill: `${actor.archetype.replace(/_/g, " ")} Burst`,
        target: "enemy",
        confidence: 0.78,
        rationale: "Momentum window is strong enough to spend energy.",
      };
    }

    if (actor.energy < 18) {
      return {
        agentId: actor.id,
        source: this.id,
        action: "focus",
        skill: "Recharge Read",
        target: "self",
        confidence: 0.62,
        rationale: "Energy is low; recover before the next exchange.",
      };
    }

    if (actorHealth < 0.42 && opponent.energy > actor.energy) {
      return {
        agentId: actor.id,
        source: this.id,
        action: "defend",
        skill: "Pressure Shield",
        target: "self",
        confidence: 0.64,
        rationale: "Opponent has resource advantage, so reduce incoming damage.",
      };
    }

    return {
      agentId: actor.id,
      source: this.id,
      action: "attack",
      skill: "Signal Strike",
      target: "enemy",
      confidence: 0.58 + Math.min(0.28, actor.confidence / 260),
      rationale: "Default pressure action based on current battle state.",
    };
  }
}

export class ElizaOsDecisionProvider extends MockGameDecisionProvider {
  constructor() {
    super("elizaos");
  }
}

type GameSdkModule = typeof import("@virtuals-protocol/game");

function envFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function getGameApiKey() {
  return (
    String(process.env.GAME_API_KEY || "").trim() ||
    String(process.env.VIRTUALS_GAME_API_KEY || "").trim() ||
    String(process.env.BOTA_GAME_API_KEY || "").trim()
  );
}

function gameSdkPrompt() {
  return [
    "You are the GAME decision engine for BOTA: Battle Of The Agents.",
    "Choose one legal battle action from the provided function list.",
    "You only decide intent. BOTA validates actions, computes damage, and determines the winner.",
    "Prefer tactical, concise decisions based on health, energy, cooldowns, confidence, and opponent pressure.",
  ].join("\n");
}

function stateForGame(input: {
  state: BotaArenaBattleState;
  actor: BotaArenaFighter;
  opponent: BotaArenaFighter;
}) {
  return {
    round: input.state.round,
    maxRounds: input.state.maxRounds,
    actor: {
      id: input.actor.id,
      name: input.actor.name,
      archetype: input.actor.archetype,
      health: input.actor.health,
      maxHealth: input.actor.maxHealth,
      energy: input.actor.energy,
      maxEnergy: input.actor.maxEnergy,
      attack: input.actor.attack,
      defense: input.actor.defense,
      speed: input.actor.speed,
      accuracy: input.actor.accuracy,
      critChance: input.actor.critChance,
      confidence: input.actor.confidence,
      cooldowns: input.actor.cooldowns,
    },
    opponent: {
      id: input.opponent.id,
      name: input.opponent.name,
      archetype: input.opponent.archetype,
      health: input.opponent.health,
      maxHealth: input.opponent.maxHealth,
      energy: input.opponent.energy,
      maxEnergy: input.opponent.maxEnergy,
      attack: input.opponent.attack,
      defense: input.opponent.defense,
      speed: input.opponent.speed,
      confidence: input.opponent.confidence,
      cooldowns: input.opponent.cooldowns,
    },
    recentEvents: input.state.log.slice(-4).map((event) => ({
      round: event.round,
      actorId: event.actorId,
      skill: event.skill,
      hit: event.hit,
      damage: event.damage,
    })),
  };
}

function buildGameActionSpace(game: GameSdkModule) {
  const { GameFunction, ExecutableGameFunctionResponse, ExecutableGameFunctionStatus } = game;
  const args = [
    { name: "skill", type: "string", description: "Short BOTA skill name to use." },
    {
      name: "confidence",
      type: "number",
      description: "Decision confidence from 0 to 1.",
      optional: true,
    },
    {
      name: "rationale",
      type: "string",
      description: "Brief reason for this decision.",
      optional: true,
    },
  ] as const;

  return [
    new GameFunction({
      name: "attack",
      description: "Use a reliable offensive action against the enemy.",
      args,
      executable: async () =>
        new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          "BOTA recorded attack intent.",
        ),
    }),
    new GameFunction({
      name: "special",
      description: "Spend more energy on a stronger offensive action.",
      args,
      executable: async () =>
        new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          "BOTA recorded special intent.",
        ),
    }),
    new GameFunction({
      name: "defend",
      description: "Guard this round to reduce incoming damage.",
      args,
      executable: async () =>
        new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          "BOTA recorded defend intent.",
        ),
    }),
    new GameFunction({
      name: "focus",
      description: "Recover energy and improve tempo.",
      args,
      executable: async () =>
        new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          "BOTA recorded focus intent.",
        ),
    }),
    new GameFunction({
      name: "counter",
      description: "Take a defensive attacking line when under pressure.",
      args,
      executable: async () =>
        new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          "BOTA recorded counter intent.",
        ),
    }),
  ];
}

function normalizeGameConfidence(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.65;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeGameIntentAction(fnName: string): BotaAgentIntent["action"] {
  if (fnName === "defend" || fnName === "focus" || fnName === "special" || fnName === "counter") {
    return fnName;
  }
  return "attack";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export class GameSdkDecisionProvider implements BotaAgentDecisionProvider {
  id = "game-sdk" as const;
  private fallback = new ElizaOsDecisionProvider();

  constructor(
    private apiKey: string,
    private options: { timeoutMs?: number; strict?: boolean } = {},
  ) {}

  async decide(input: {
    state: BotaArenaBattleState;
    actor: BotaArenaFighter;
    opponent: BotaArenaFighter;
  }): Promise<BotaAgentIntent> {
    try {
      return await withTimeout(
        this.decideWithGameSdk(input),
        this.options.timeoutMs || Number(process.env.BOTA_GAME_SDK_TIMEOUT_MS || 12_000),
        "GAME SDK decision",
      );
    } catch (error) {
      if (this.options.strict || envFlag(process.env.BOTA_GAME_SDK_STRICT)) {
        throw error;
      }
      const fallback = await this.fallback.decide(input);
      return {
        ...fallback,
        rationale:
          `GAME SDK unavailable; ElizaOS fallback used. ` +
          (error instanceof Error ? error.message : "Unknown GAME SDK error."),
      };
    }
  }

  private async decideWithGameSdk(input: {
    state: BotaArenaBattleState;
    actor: BotaArenaFighter;
    opponent: BotaArenaFighter;
  }): Promise<BotaAgentIntent> {
    const game = await import("@virtuals-protocol/game");
    const actionSpace = buildGameActionSpace(game);
    const agent = new game.ChatAgent(this.apiKey, gameSdkPrompt());
    const chat = await agent.createChat({
      partnerId: input.actor.id,
      partnerName: input.actor.name,
      actionSpace,
      getStateFn: () => stateForGame(input),
    });

    const response = await chat.next(
      [
        `Round ${input.state.round + 1}/${input.state.maxRounds}.`,
        `${input.actor.name} must choose exactly one BOTA action now.`,
        `Opponent: ${input.opponent.name}.`,
        "Use the function that represents the chosen action.",
      ].join(" "),
    );
    const functionCall = response.functionCall;
    if (!functionCall?.fn_name) {
      throw new Error("GAME SDK did not return an action function call");
    }

    const fnArgs = functionCall.fn_args || {};
    return botaAgentIntentSchema.parse({
      agentId: input.actor.id,
      source: "game-sdk",
      action: normalizeGameIntentAction(functionCall.fn_name),
      skill: String(fnArgs.skill || `${functionCall.fn_name} intent`).slice(0, 80),
      target: functionCall.fn_name === "defend" || functionCall.fn_name === "focus" ? "self" : "enemy",
      confidence: normalizeGameConfidence(fnArgs.confidence),
      rationale: String(fnArgs.rationale || response.message || "GAME SDK action selected.").slice(0, 300),
      raw: {
        message: response.message,
        functionCall: {
          name: functionCall.fn_name,
          args: fnArgs,
        },
      },
    });
  }
}

export function getBotaDecisionProvider(): BotaAgentDecisionProvider {
  const provider = String(process.env.BOTA_DECISION_PROVIDER || process.env.BOTA_GAME_PROVIDER || "")
    .trim()
    .toLowerCase();
  const useGameSdk = provider === "game-sdk" || envFlag(process.env.BOTA_USE_GAME_SDK);
  const apiKey = getGameApiKey();
  if (useGameSdk && apiKey) {
    return new GameSdkDecisionProvider(apiKey);
  }
  if (provider === "mock-game") {
    return new MockGameDecisionProvider();
  }
  if (provider === "elizaos" || provider === "eliza" || !provider) {
    return new ElizaOsDecisionProvider();
  }
  return new MockGameDecisionProvider();
}
