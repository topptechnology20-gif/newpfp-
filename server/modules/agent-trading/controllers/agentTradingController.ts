import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";

import {
  agentDecisionRequestSchema,
  agentDecisionResponseSchema,
  agentExecuteRequestSchema,
  agentOrdersResponseSchema,
  agentPerformanceResponseSchema,
  agentPositionsResponseSchema,
  eligibleMarketsQuerySchema,
  eligibleMarketsResponseSchema,
  tradingReadinessResponseSchema,
} from "@shared/agentTrading";
import { PrivyAuthMiddleware } from "../../../privyAuth";
import { storage } from "../../../storage";
import { decideForAgentMarket, executeAgentDecision } from "../services/agentExecutionService";
import {
  getEligibleMarketsForAgent,
  getStoredTradableAgent,
} from "../services/marketEligibilityService";
import { getAgentTradingReadiness } from "../services/tradingReadinessService";
import { listAgentOrders } from "../repositories/orderRepository";
import { listAgentPositions } from "../repositories/positionRepository";
import { performanceService } from "../../performance/services/performanceService";

const router = Router({ mergeParams: true });

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
  };
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function getAuthenticatedUserId(req: any): string {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) {
    throw new HttpError(401, "Unauthorized");
  }
  return userId;
}

async function assertAgentOwner(agentId: string, userId: string) {
  const agent = await storage.getAgentById(agentId);
  if (!agent) {
    throw new HttpError(404, "Agent not found");
  }
  if (agent.ownerId !== userId) {
    throw new HttpError(403, "Only the agent owner can run this trading action.");
  }
}

function handleError(res: Response, error: unknown) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      message: "Invalid request",
      issues: error.flatten(),
    });
  }

  if (error instanceof HttpError) {
    return res.status(error.status).json({ message: error.message });
  }

  const message = error instanceof Error ? error.message : "Trading request failed";
  return res.status(500).json({ message });
}

router.get("/:agentId/trading-readiness", async (req, res) => {
  try {
    const readiness = await getAgentTradingReadiness(req.params.agentId);
    res.json(tradingReadinessResponseSchema.parse(readiness));
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:agentId/eligible-markets", async (req, res) => {
  try {
    const filters = eligibleMarketsQuerySchema.parse(req.query);
    const agent = await getStoredTradableAgent(req.params.agentId);
    const items = await getEligibleMarketsForAgent(agent, filters);

    res.json(
      eligibleMarketsResponseSchema.parse({
        agentId: req.params.agentId,
        items: items.map((item) => ({
          source: item.source,
          marketId: item.id,
          externalMarketId: item.polymarketMarketId,
          question: item.question,
          yesPrice: item.yesPrice,
          noPrice: item.noPrice,
          liquidity: item.liquidity,
          volume: item.volume,
          category: item.category ?? null,
          endDate: item.endDate ?? null,
          marketUrl: item.marketUrl ?? item.sourceUrl ?? null,
          isTradable: item.isTradable,
        })),
      }),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:agentId/decide", PrivyAuthMiddleware, async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    await assertAgentOwner(req.params.agentId, userId);
    const body = agentDecisionRequestSchema.parse(req.body);
    const result = body.attemptExecution
      ? await executeAgentDecision(req.params.agentId, body.marketId)
      : await decideForAgentMarket(req.params.agentId, body.marketId);

    res.json(agentDecisionResponseSchema.parse(result));
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:agentId/execute", PrivyAuthMiddleware, async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    await assertAgentOwner(req.params.agentId, userId);
    const body = agentExecuteRequestSchema.parse(req.body);
    const result = await executeAgentDecision(req.params.agentId, body.marketId, body.action);
    res.json(agentDecisionResponseSchema.parse(result));
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:agentId/orders", async (req, res) => {
  try {
    const items = await listAgentOrders(req.params.agentId);
    res.json(agentOrdersResponseSchema.parse({ agentId: req.params.agentId, items }));
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:agentId/positions", async (req, res) => {
  try {
    const items = await listAgentPositions(req.params.agentId);
    res.json(agentPositionsResponseSchema.parse({ agentId: req.params.agentId, items }));
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:agentId/performance", async (req, res) => {
  try {
    const result = await performanceService(req.params.agentId);
    res.json(agentPerformanceResponseSchema.parse(result));
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
