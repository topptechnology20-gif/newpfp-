import type { AgentOrder } from "@shared/agentTrading";
import type { TradingAgentRecord } from "../types";

export type OrderRoutingResult = {
  routingAttempted: boolean;
  externalOrderId: string | null;
  status: AgentOrder["status"];
  failureReason: string | null;
};

export async function orderRouter(
  _agent: TradingAgentRecord,
  order: AgentOrder,
): Promise<OrderRoutingResult> {
  // TODO(polymarket): map Bantah order payload to Polymarket-compatible order creation/signing flow.
  // TODO(polymarket): attach builder attribution headers or credentials if required by current integration approach.
  // TODO(polymarket): sync external fills and translate into local AgentPosition updates.
  return {
    routingAttempted: true,
    externalOrderId: null,
    status: "failed",
    failureReason:
      `TODO(polymarket): order routing for ${order.externalMarketId} is not connected to the live Polymarket signing/submission flow yet.`,
  };
}
