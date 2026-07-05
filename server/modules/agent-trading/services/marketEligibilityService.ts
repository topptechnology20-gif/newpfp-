import type { ExternalMarket } from "@shared/externalMarkets";
import { storage } from "../../../storage";
import type { EligibleMarketsQuery } from "@shared/agentTrading";
import { fetchTrendingPolymarketMarketsFromEvents } from "./externalMarketDataService";
import {
  resolveAgentRiskProfile,
  resolveProbabilityThresholdConfig,
  type TradingAgentRecord,
} from "../types";

const MANUALLY_BLOCKED_MARKET_IDS = new Set(
  String(process.env.POLYMARKET_BLOCKED_MARKET_IDS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);

function normalizeCategory(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

export function isMarketTradable(
  market: ExternalMarket,
  agent: TradingAgentRecord,
  filters?: Pick<EligibleMarketsQuery, "minLiquidity">,
): boolean {
  const strategyConfig = resolveProbabilityThresholdConfig(agent);
  const riskProfile = resolveAgentRiskProfile(agent);
  const minimumLiquidity = Math.max(
    filters?.minLiquidity ?? 0,
    strategyConfig.minLiquidity,
    riskProfile.minLiquidity,
  );
  const category = normalizeCategory(market.category);

  if (!market.isTradable) return false;
  if (market.liquidity < minimumLiquidity) return false;
  if (MANUALLY_BLOCKED_MARKET_IDS.has(market.id) || MANUALLY_BLOCKED_MARKET_IDS.has(market.polymarketMarketId)) {
    return false;
  }
  if (
    riskProfile.blockedMarketIds.includes(market.id) ||
    riskProfile.blockedMarketIds.includes(market.polymarketMarketId)
  ) {
    return false;
  }
  if (riskProfile.blockedCategories.map(normalizeCategory).includes(category)) {
    return false;
  }
  if (
    strategyConfig.allowedCategories.length > 0 &&
    category &&
    !strategyConfig.allowedCategories.map(normalizeCategory).includes(category)
  ) {
    return false;
  }

  return true;
}

export async function getEligibleMarketsForAgent(
  agent: TradingAgentRecord,
  filters: EligibleMarketsQuery = { limit: 20 },
): Promise<ExternalMarket[]> {
  const markets = await fetchTrendingPolymarketMarketsFromEvents(20);

  return markets
    .filter((market) => {
      if (filters.category) {
        return normalizeCategory(market.category) === normalizeCategory(filters.category);
      }
      return true;
    })
    .filter((market) => isMarketTradable(market, agent, filters))
    .slice(0, filters.limit ?? 20);
}

export async function getStoredTradableAgent(agentId: string): Promise<TradingAgentRecord> {
  const agent = await storage.getAgentById(agentId);
  if (!agent) {
    throw new Error("Agent not found");
  }

  return agent as TradingAgentRecord;
}
