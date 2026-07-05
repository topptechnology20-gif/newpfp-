import {
  botaAgentIntentSchema,
  botaArenaActionSchema,
  type BotaAgentIntent,
  type BotaArenaAction,
  type BotaArenaAdapterIssue,
  type BotaArenaAdapterResult,
  type BotaArenaBattleState,
  type BotaArenaFighter,
} from "@shared/botaArena";

export const BOTA_GAME_ADAPTER_VERSION = "phase-1.0";

type AdapterContext = {
  state: BotaArenaBattleState;
  actorId: string;
  opponentId: string;
};

function issue(code: string, message: string, severity: BotaArenaAdapterIssue["severity"] = "error") {
  return { code, message, severity };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getFighter(state: BotaArenaBattleState, fighterId: string) {
  return state.fighters.find((fighter) => fighter.id === fighterId) || null;
}

function normalizeSkillName(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || "Basic Strike";
}

function baseActionFromIntent(
  intent: BotaAgentIntent,
  actor: BotaArenaFighter,
  opponent: BotaArenaFighter,
): BotaArenaAction {
  const skill = normalizeSkillName(intent.skill);
  const intentConfidence = clamp(intent.confidence, 0, 1);

  switch (intent.action) {
    case "defend":
      return {
        actorId: actor.id,
        targetId: actor.id,
        type: "guard",
        skill,
        power: 0,
        accuracy: 1,
        energyCost: 0,
        cooldownKey: "guard",
        cooldownRounds: 0,
        defenseBoost: 0.42,
        intent,
      };
    case "focus":
      return {
        actorId: actor.id,
        targetId: actor.id,
        type: "focus",
        skill,
        power: 0,
        accuracy: 1,
        energyCost: 0,
        cooldownKey: "focus",
        cooldownRounds: 1,
        defenseBoost: 0.12,
        intent,
      };
    case "special":
      return {
        actorId: actor.id,
        targetId: opponent.id,
        type: "special_attack",
        skill,
        power: clamp(28 + actor.attack * 0.35 + intentConfidence * 16, 20, 74),
        accuracy: clamp(actor.accuracy - 0.1 + intentConfidence * 0.1, 0.45, 0.94),
        energyCost: 36,
        cooldownKey: `special:${skill.toLowerCase()}`,
        cooldownRounds: 2,
        defenseBoost: 0,
        intent,
      };
    case "counter":
      return {
        actorId: actor.id,
        targetId: opponent.id,
        type: "counter",
        skill,
        power: clamp(16 + actor.speed * 0.18 + actor.defense * 0.18, 12, 44),
        accuracy: clamp(actor.accuracy + 0.02, 0.5, 0.95),
        energyCost: 18,
        cooldownKey: "counter",
        cooldownRounds: 1,
        defenseBoost: 0.18,
        intent,
      };
    case "attack":
    default:
      return {
        actorId: actor.id,
        targetId: opponent.id,
        type: "basic_attack",
        skill,
        power: clamp(16 + actor.attack * 0.24, 12, 45),
        accuracy: clamp(actor.accuracy + intentConfidence * 0.04, 0.5, 0.97),
        energyCost: 10,
        cooldownKey: "basic_attack",
        cooldownRounds: 0,
        defenseBoost: 0,
        intent,
      };
  }
}

function makeFallbackGuard(intent: BotaAgentIntent, actor: BotaArenaFighter): BotaArenaAction {
  return botaArenaActionSchema.parse({
    actorId: actor.id,
    targetId: actor.id,
    type: "guard",
    skill: "Emergency Guard",
    power: 0,
    accuracy: 1,
    energyCost: 0,
    cooldownKey: "guard",
    cooldownRounds: 0,
    defenseBoost: 0.34,
    intent: {
      ...intent,
      action: "defend",
      skill: "Emergency Guard",
      target: "self",
      rationale: "Adapter fallback used after invalid or unaffordable intent.",
    },
  });
}

export function adaptGameIntentToArenaAction(
  rawIntent: unknown,
  context: AdapterContext,
): BotaArenaAdapterResult {
  const parsedIntent = botaAgentIntentSchema.safeParse(rawIntent);
  const actor = getFighter(context.state, context.actorId);
  const opponent = getFighter(context.state, context.opponentId);
  const issues: BotaArenaAdapterIssue[] = [];

  if (!actor || !opponent) {
    return {
      accepted: false,
      action: null,
      fallbackAction: null,
      issues: [issue("fighter_missing", "Adapter could not resolve the actor/opponent fighter.")],
    };
  }

  if (!parsedIntent.success) {
    const fallbackIntent = botaAgentIntentSchema.parse({
      agentId: actor.id,
      source: "system",
      action: "defend",
      skill: "Emergency Guard",
      target: "self",
      confidence: 0.25,
      rationale: "Invalid agent intent payload.",
    });
    const fallbackAction = makeFallbackGuard(fallbackIntent, actor);
    return {
      accepted: false,
      action: null,
      fallbackAction,
      issues: [
        issue("invalid_intent", "Agent intent did not match the BOTA agent intent schema."),
        ...parsedIntent.error.issues.slice(0, 3).map((item) =>
          issue("schema_issue", `${item.path.join(".") || "intent"}: ${item.message}`),
        ),
      ],
    };
  }

  const intent = parsedIntent.data;
  if (intent.agentId !== actor.id) {
    issues.push(
      issue(
        "agent_mismatch",
        `Intent agentId ${intent.agentId} does not match actor ${actor.id}; actor identity was enforced.`,
        "warning",
      ),
    );
  }

  const action = botaArenaActionSchema.parse(
    baseActionFromIntent({ ...intent, agentId: actor.id }, actor, opponent),
  );

  const cooldownRemaining = actor.cooldowns[action.cooldownKey] || 0;
  if (cooldownRemaining > 0) {
    issues.push(
      issue(
        "cooldown_active",
        `${action.skill} is on cooldown for ${cooldownRemaining} more round${cooldownRemaining === 1 ? "" : "s"}.`,
      ),
    );
  }

  if (actor.energy < action.energyCost) {
    issues.push(
      issue(
        "energy_low",
        `${actor.name} has ${actor.energy} energy but ${action.skill} requires ${action.energyCost}.`,
      ),
    );
  }

  if (action.type !== "guard" && action.type !== "focus" && intent.target !== "enemy") {
    issues.push(issue("target_invalid", "Offensive actions must target the enemy fighter."));
  }

  const blockingIssue = issues.some((item) => item.severity === "error");
  if (blockingIssue) {
    return {
      accepted: false,
      action: null,
      fallbackAction: makeFallbackGuard(intent, actor),
      issues,
    };
  }

  return {
    accepted: true,
    action,
    fallbackAction: null,
    issues,
  };
}
