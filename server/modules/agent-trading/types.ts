import {
  DEFAULT_AGENT_RISK_PROFILE,
  DEFAULT_PROBABILITY_THRESHOLD_STRATEGY_CONFIG,
  agentRiskProfileSchema,
  probabilityThresholdStrategyConfigSchema,
  type AgentRiskProfile,
  type ProbabilityThresholdStrategyConfig,
} from "@shared/agentTrading";

export type TradingAgentRecord = {
  agentId: string;
  ownerId: string;
  agentType: string;
  walletAddress: string;
  walletProvider: string | null;
  walletNetworkId: string | null;
  runtimeConfig?: { chainId?: number | null } | null;
  specialty: string;
  status: string;
  canTrade: boolean;
  strategyType: string | null;
  strategyConfig: unknown;
  riskProfile: unknown;
  maxPositionSize: string | number | null;
  dailyTradeLimit: number | null;
  maxOpenPositions: number | null;
};

export function parseDecimal(value: unknown, fallback = 0): number {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function resolveProbabilityThresholdConfig(
  agent: Pick<TradingAgentRecord, "strategyConfig">,
): ProbabilityThresholdStrategyConfig {
  return probabilityThresholdStrategyConfigSchema.parse({
    ...DEFAULT_PROBABILITY_THRESHOLD_STRATEGY_CONFIG,
    ...(agent.strategyConfig && typeof agent.strategyConfig === "object" ? agent.strategyConfig : {}),
  });
}

export function resolveAgentRiskProfile(
  agent: Pick<TradingAgentRecord, "riskProfile">,
): AgentRiskProfile {
  return agentRiskProfileSchema.parse({
    ...DEFAULT_AGENT_RISK_PROFILE,
    ...(agent.riskProfile && typeof agent.riskProfile === "object" ? agent.riskProfile : {}),
  });
}

export function resolveAgentMaxPositionSizeUsd(
  agent: Pick<TradingAgentRecord, "maxPositionSize" | "strategyConfig">,
): number {
  const storedLimit = parseDecimal(agent.maxPositionSize, DEFAULT_PROBABILITY_THRESHOLD_STRATEGY_CONFIG.maxPositionSizeUsd);
  const strategyLimit = resolveProbabilityThresholdConfig({
    strategyConfig: agent.strategyConfig,
  }).maxPositionSizeUsd;
  return Math.max(1, Math.min(storedLimit, strategyLimit));
}
