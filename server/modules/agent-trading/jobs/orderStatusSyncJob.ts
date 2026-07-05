import { listAgentOrderSyncCandidates, updateAgentOrder } from "../repositories/orderRepository";

export async function orderStatusSyncJob(limit = 50): Promise<{ scanned: number; updated: number }> {
  const candidates = await listAgentOrderSyncCandidates(limit);
  let updated = 0;

  for (const order of candidates) {
    // TODO(polymarket): poll external order state for submitted orders and map fills/cancellations.
    await updateAgentOrder(order.id, {
      lastSyncedAt: new Date(),
    });
    updated += 1;
  }

  return {
    scanned: candidates.length,
    updated,
  };
}
