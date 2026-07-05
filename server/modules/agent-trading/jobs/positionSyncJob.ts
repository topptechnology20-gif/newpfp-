import { getExternalMarketSidePrice } from "@shared/externalMarkets";
import { getPolymarketMarketById } from "../services/externalMarketDataService";
import {
  listOpenAgentPositions,
  updateAgentPositionMark,
} from "../repositories/positionRepository";

export async function positionSyncJob(limit = 50): Promise<{ scanned: number; updated: number }> {
  const positions = await listOpenAgentPositions(limit);
  let updated = 0;

  for (const position of positions) {
    const market = await getPolymarketMarketById(position.externalMarketId);
    if (!market) continue;

    const markPrice = getExternalMarketSidePrice(market, position.side);
    const unrealizedPnl = Number(
      ((markPrice - position.avgEntryPrice) * position.totalShares).toFixed(4),
    );

    await updateAgentPositionMark(position.id, markPrice, unrealizedPnl);
    updated += 1;
  }

  return {
    scanned: positions.length,
    updated,
  };
}
