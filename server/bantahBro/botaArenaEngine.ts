import {
  type BotaArenaAction,
  type BotaArenaAdapterResult,
  type BotaArenaBattleSimulation,
  type BotaArenaBattleState,
  type BotaArenaFighter,
  type BotaArenaRoundEvent,
} from "@shared/botaArena";
import {
  adaptGameIntentToArenaAction,
  BOTA_GAME_ADAPTER_VERSION,
} from "./botaGameAdapter";
import {
  getBotaDecisionProvider,
  type BotaAgentDecisionProvider,
} from "./botaGameDecisionProvider";
import type {
  BantahBroAgentBattle,
  BantahBroAgentBattleSide,
} from "./agentBattleService";
import { db } from "../db";
import { eq, inArray } from "drizzle-orm";
import { botaFighterCombatProfiles, botaFighterLoadout, botaToolInventory, botaToolsCatalog, botaBattleRoundLog } from "@shared/schema";
import { botaEconomyService } from "./botaEconomyService";

export const BOTA_ARENA_ENGINE_VERSION = "phase-2.0";

type SimulationOptions = {
  seed?: string | null;
  maxRounds?: number | null;
  provider?: BotaAgentDecisionProvider;
};

type Rng = {
  next(): number;
  nextInt(min: number, max: number): number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value: number | null | undefined, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function hashSeed(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seed: string): Rng {
  let state = hashSeed(seed) || 0x9e3779b9;
  return {
    next() {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    },
    nextInt(min: number, max: number) {
      return Math.floor(this.next() * (max - min + 1)) + min;
    },
  };
}

function battleSymbol(side: BantahBroAgentBattleSide) {
  return (side.tokenSymbol || side.label || "BOTA").replace(/^\$/, "").trim() || "BOTA";
}

function archetypeForSide(side: BantahBroAgentBattleSide): BotaArenaFighter["archetype"] {
  if (side.liquidityUsd && side.liquidityUsd > 750_000) return "liquidity_guardian";
  if (Math.abs(side.priceChangeH24 || 0) >= 100) return "chaos_berserker";
  if ((side.buysH24 || 0) + (side.sellsH24 || 0) > 5_000) return "momentum_scout";
  if (side.chainId === "ethereum" || side.chainLabel?.toLowerCase().includes("ens")) return "oracle_duelist";
  return "signal_striker";
}

function fighterFromSide(side: BantahBroAgentBattleSide, index: number): BotaArenaFighter {
  const confidence = clamp(safeNumber(side.confidence, 50), 1, 99);
  const score = clamp(safeNumber(side.score, confidence), 1, 100);
  const volumeScore = clamp(Math.log10(Math.max(1, safeNumber(side.volumeH24))) * 10, 0, 70);
  const buyPressure = (safeNumber(side.buysH24) + 1) / (safeNumber(side.sellsH24) + 1);
  const pressureScore = clamp(Math.log2(buyPressure) * 12, -18, 18);
  const liquidityScore = clamp(Math.log10(Math.max(1, safeNumber(side.liquidityUsd))) * 8, 0, 60);
  const movementScore = clamp(Math.abs(safeNumber(side.priceChangeH24)) / 3, 0, 45);

  return {
    id: side.id || `fighter-${index + 1}`,
    name: side.agentName || `${battleSymbol(side)} Agent`,
    teamLabel: side.label || `$${battleSymbol(side)}`,
    sourceAgentId: null,
    archetype: archetypeForSide(side),
    rank: Math.max(1, Math.round(100 - score)),
    maxHealth: 100,
    health: 100,
    maxEnergy: 100,
    energy: 58 + Math.round(score * 0.18),
    attack: clamp(32 + confidence * 0.28 + movementScore * 0.45 + pressureScore, 18, 94),
    defense: clamp(28 + liquidityScore * 0.42 + score * 0.16, 16, 92),
    speed: clamp(30 + volumeScore * 0.45 + Math.abs(safeNumber(side.priceChangeM5)) * 0.2, 16, 95),
    accuracy: clamp(0.62 + score / 420 + confidence / 700, 0.52, 0.94),
    critChance: clamp(0.06 + movementScore / 260 + Math.max(0, pressureScore) / 250, 0.04, 0.32),
    confidence,
    score,
    cooldowns: {},
    statusEffects: [],
  };
}

export function buildInitialBotaArenaStateFromBattle(
  battle: BantahBroAgentBattle,
  options: SimulationOptions = {},
): BotaArenaBattleState {
  const maxRounds = clamp(Math.round(options.maxRounds || 5), 1, 5);
  return {
    battleId: battle.id,
    seed: options.seed || `${battle.id}:${battle.startsAt}`,
    round: 0,
    maxRounds,
    status: "pending",
    fighters: [
      fighterFromSide(battle.sides[0], 0),
      fighterFromSide(battle.sides[1], 1),
    ],
    winnerId: null,
    resolutionReason: null,
    log: [],
  };
}

function cloneState(state: BotaArenaBattleState): BotaArenaBattleState {
  return {
    ...state,
    fighters: state.fighters.map((fighter) => ({
      ...fighter,
      cooldowns: { ...fighter.cooldowns },
      statusEffects: [...fighter.statusEffects],
    })) as [BotaArenaFighter, BotaArenaFighter],
    log: [...state.log],
  };
}

function tickCooldowns(fighter: BotaArenaFighter) {
  const nextCooldowns: Record<string, number> = {};
  for (const [key, value] of Object.entries(fighter.cooldowns || {})) {
    const nextValue = Math.max(0, Math.round(value) - 1);
    if (nextValue > 0) nextCooldowns[key] = nextValue;
  }
  fighter.cooldowns = nextCooldowns;
}

function actionForResult(result: BotaArenaAdapterResult) {
  return result.action || result.fallbackAction;
}

function actionDefenseBoost(action: BotaArenaAction | null | undefined) {
  return action?.defenseBoost || 0;
}

function resolveAction(input: {
  state: BotaArenaBattleState;
  round: number;
  action: BotaArenaAction;
  actor: BotaArenaFighter;
  target: BotaArenaFighter;
  targetDeclaredAction: BotaArenaAction | null;
  rng: Rng;
}): BotaArenaRoundEvent {
  const { action, actor, target, targetDeclaredAction, rng, round } = input;
  const energyBefore = actor.energy;
  const energyCost = action.energyCost;
  actor.energy = clamp(actor.energy - energyCost, 0, actor.maxEnergy);

  if (action.cooldownRounds > 0) {
    actor.cooldowns[action.cooldownKey] = action.cooldownRounds;
  }

  if (action.type === "guard") {
    actor.energy = clamp(actor.energy + 9, 0, actor.maxEnergy);
    return {
      id: `${input.state.battleId}:r${round}:${actor.id}:guard`,
      round,
      actorId: actor.id,
      targetId: actor.id,
      actionType: action.type,
      skill: action.skill,
      hit: true,
      critical: false,
      damage: 0,
      energyDelta: actor.energy - energyBefore,
      targetHealthAfter: actor.health,
      message: `${actor.name} guards and absorbs pressure.`,
    };
  }

  if (action.type === "focus") {
    actor.energy = clamp(actor.energy + 24, 0, actor.maxEnergy);
    actor.accuracy = clamp(actor.accuracy + 0.02, 0.4, 0.98);
    return {
      id: `${input.state.battleId}:r${round}:${actor.id}:focus`,
      round,
      actorId: actor.id,
      targetId: actor.id,
      actionType: action.type,
      skill: action.skill,
      hit: true,
      critical: false,
      damage: 0,
      energyDelta: actor.energy - energyBefore,
      targetHealthAfter: actor.health,
      message: `${actor.name} focuses and recovers tempo.`,
    };
  }

  const targetGuard = actionDefenseBoost(targetDeclaredAction);
  const speedEdge = clamp((actor.speed - target.speed) / 260, -0.12, 0.12);
  const hitChance = clamp(action.accuracy + speedEdge - targetGuard * 0.16, 0.08, 0.98);
  const hit = rng.next() <= hitChance;
  const critical = hit && rng.next() <= clamp(actor.critChance + actor.confidence / 1_600, 0.02, 0.44);
  let damage = 0;

  if (hit) {
    const variance = 0.88 + rng.next() * 0.26;
    const rawDamage =
      action.power +
      actor.attack * 0.18 -
      target.defense * 0.12 +
      actor.confidence * 0.035;
    const guardedDamage = rawDamage * (1 - targetGuard);
    damage = Math.round(clamp(guardedDamage * variance * (critical ? 1.55 : 1), 1, 96));
    target.health = clamp(target.health - damage, 0, target.maxHealth);
  }

  const hitText = hit
    ? `${actor.name} lands ${action.skill}${critical ? " cleanly" : ""} for ${damage} damage.`
    : `${actor.name} misses ${action.skill}.`;

  return {
    id: `${input.state.battleId}:r${round}:${actor.id}:${action.type}`,
    round,
    actorId: actor.id,
    targetId: target.id,
    actionType: action.type,
    skill: action.skill,
    hit,
    critical,
    damage,
    energyDelta: actor.energy - energyBefore,
    targetHealthAfter: target.health,
    message: hitText,
  };
}

function chooseRoundOrder(fighters: [BotaArenaFighter, BotaArenaFighter], rng: Rng) {
  const [left, right] = fighters;
  if (left.speed === right.speed) {
    return rng.next() >= 0.5 ? [left, right] : [right, left];
  }
  return left.speed > right.speed ? [left, right] : [right, left];
}

function resolveWinner(state: BotaArenaBattleState) {
  const [left, right] = state.fighters;
  if (left.health <= 0 && right.health <= 0) {
    state.status = "draw";
    state.winnerId = null;
    state.resolutionReason = "double_knockout";
    return;
  }
  if (left.health <= 0) {
    state.status = "resolved";
    state.winnerId = right.id;
    state.resolutionReason = "knockout";
    return;
  }
  if (right.health <= 0) {
    state.status = "resolved";
    state.winnerId = left.id;
    state.resolutionReason = "knockout";
    return;
  }
  if (state.round < state.maxRounds) return;

  const leftScore = left.health / left.maxHealth + left.energy / left.maxEnergy * 0.18 + left.confidence / 1_000;
  const rightScore = right.health / right.maxHealth + right.energy / right.maxEnergy * 0.18 + right.confidence / 1_000;
  const scoreGap = Math.abs(leftScore - rightScore);
  if (scoreGap < 0.015) {
    state.status = "draw";
    state.winnerId = null;
    state.resolutionReason = "score_draw";
    return;
  }

  state.status = "resolved";
  state.winnerId = leftScore > rightScore ? left.id : right.id;
  state.resolutionReason = "round_score";
}

export async function simulateBotaArenaBattle(
  initialState: BotaArenaBattleState,
  options: SimulationOptions = {},
): Promise<BotaArenaBattleSimulation> {
  const provider = options.provider || getBotaDecisionProvider();
  const state = cloneState(initialState);
  const initialSnapshot = cloneState(initialState);
  const rng = createRng(state.seed);
  const adapterResults: BotaArenaAdapterResult[] = [];

  state.status = "running";

  while (state.status === "running" && state.round < state.maxRounds) {
    state.round += 1;
    for (const fighter of state.fighters) {
      tickCooldowns(fighter);
    }

    const [left, right] = state.fighters;
    const leftIntent = await provider.decide({ state: cloneState(state), actor: left, opponent: right });
    const rightIntent = await provider.decide({ state: cloneState(state), actor: right, opponent: left });
    const leftResult = adaptGameIntentToArenaAction(leftIntent, {
      state,
      actorId: left.id,
      opponentId: right.id,
    });
    const rightResult = adaptGameIntentToArenaAction(rightIntent, {
      state,
      actorId: right.id,
      opponentId: left.id,
    });
    adapterResults.push(leftResult, rightResult);

    const actionsByActor = new Map<string, BotaArenaAction | null>([
      [left.id, actionForResult(leftResult)],
      [right.id, actionForResult(rightResult)],
    ]);

    const roundOrder = chooseRoundOrder(state.fighters, rng);
    for (const actor of roundOrder) {
      if (state.status !== "running") break;
      const target = state.fighters.find((fighter) => fighter.id !== actor.id);
      if (!target || actor.health <= 0) continue;
      const action = actionsByActor.get(actor.id);
      if (!action) continue;

      const targetAction = actionsByActor.get(target.id) || null;
      const event = resolveAction({
        state,
        round: state.round,
        action,
        actor,
        target,
        targetDeclaredAction: targetAction,
        rng,
      });
      state.log.push(event);
      resolveWinner(state);
    }

    resolveWinner(state);
  }

  if (state.status === "running") {
    resolveWinner(state);
  }

  return {
    provider: provider.id,
    adapterVersion: BOTA_GAME_ADAPTER_VERSION,
    engineVersion: BOTA_ARENA_ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    initialState: initialSnapshot,
    finalState: state,
    adapterResults,
  };
}

export async function simulateBotaArenaBattleFromLiveBattle(
  battle: BantahBroAgentBattle,
  options: SimulationOptions = {},
) {
  const initialState = buildInitialBotaArenaStateFromBattle(battle, options);

  // Fetch V2 Combat Profiles and Tools
  for (const fighter of initialState.fighters) {
    const profile = await db.query.botaFighterCombatProfiles.findFirst({
      where: eq(botaFighterCombatProfiles.fighterId, fighter.id)
    });
    
    if (profile) {
      fighter.combatProfile = profile;
      // Merge V2 stats into legacy stats for engine compatibility
      fighter.maxHealth = profile.hp;
      fighter.health = profile.hp;
      fighter.attack = profile.aggression;
      fighter.defense = profile.defense;
      fighter.speed = profile.speed;
      fighter.accuracy = clamp(0.5 + profile.intelligence / 200, 0.5, 0.95);
      fighter.critChance = clamp(profile.luck / 200, 0.05, 0.35);
    }
    
    const loadout = await db.query.botaFighterLoadout.findFirst({
      where: eq(botaFighterLoadout.fighterId, fighter.id)
    });
    
    if (loadout) {
      const toolIds = [loadout.primaryToolId, loadout.secondaryToolId, loadout.passiveToolId].filter(Boolean) as string[];
      if (toolIds.length > 0) {
        const inventory = await db.query.botaToolInventory.findMany({
          where: inArray(botaToolInventory.id, toolIds)
        });
        const catalogIds = inventory.map((i: any) => i.toolCatalogId);
        if (catalogIds.length > 0) {
          const catalogs = await db.query.botaToolsCatalog.findMany({
            where: inArray(botaToolsCatalog.id, catalogIds)
          });
          fighter.tools = catalogs.map((c: any) => ({
            id: c.id,
            name: c.name,
            tier: c.tier,
            role: c.role,
            powerRating: c.powerRating,
            effectDesc: c.effectDesc,
            soulDrainEnabled: c.soulDrainEnabled || false
          }));
        }
      }
    }
  }

  const simulation = await simulateBotaArenaBattle(initialState, options);

  // Save logs to bota_battle_round_log
  const logInserts = simulation.finalState.log.map(event => ({
    battleId: simulation.finalState.battleId,
    roundNumber: event.round,
    fighterId: event.actorId,
    actionTaken: event.actionType,
    toolUsedId: null, // Simplified for now
    damageDealt: event.damage,
    hpAfter: event.targetHealthAfter,
    winProbabilityBefore: "0.50",
    rngSeed: simulation.finalState.seed,
  }));
  
  if (logInserts.length > 0) {
    await db.insert(botaBattleRoundLog).values(logInserts);
  }

  // Soul Drain Logic
  if (simulation.finalState.winnerId) {
    const winner = simulation.finalState.fighters.find(f => f.id === simulation.finalState.winnerId);
    const loser = simulation.finalState.fighters.find(f => f.id !== simulation.finalState.winnerId);
    
    if (winner && loser && winner.tools.some(t => t.soulDrainEnabled || t.tier === "epic")) {
      try {
        const amountToDrain = 10;
        await botaEconomyService.burn(loser.id, amountToDrain * 0.2, "soul_drain_burn");
        await botaEconomyService.transfer(loser.id, winner.id, amountToDrain * 0.8, "soul_drain_win");
      } catch (e) {
        // Ignored if insufficient funds or not registered with bantcredit
      }
    }
  }

  return simulation;
}
