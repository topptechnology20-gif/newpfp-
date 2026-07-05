import {
  bantahBroAlertSchema,
  bantahBroBoostSchema,
  bantahBroReceiptSchema,
  type BantahBroAlert,
  type BantahBroBoost,
  type BantahBroMarketLink,
  type BantahBroReceipt,
} from "@shared/bantahBro";

const MAX_ALERTS = 200;
const MAX_RECEIPTS = 200;

const liveAlerts: BantahBroAlert[] = [];
const liveReceipts: BantahBroReceipt[] = [];
const marketBoosts: BantahBroBoost[] = [];

function sortByNewest<T extends { createdAt: string; updatedAt?: string }>(items: T[]) {
  return [...items].sort(
    (a, b) =>
      new Date(b.updatedAt || b.createdAt).getTime() -
      new Date(a.updatedAt || a.createdAt).getTime(),
  );
}

function upsertItem<T extends { id: string }>(items: T[], next: T, maxItems: number) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    items[index] = next;
  } else {
    items.unshift(next);
  }
  if (items.length > maxItems) {
    items.length = maxItems;
  }
}

export function publishBantahBroAlert(alert: BantahBroAlert) {
  const parsed = bantahBroAlertSchema.parse(alert);
  upsertItem(liveAlerts, parsed, MAX_ALERTS);
  return parsed;
}

export function listBantahBroAlerts(limit = 50) {
  return sortByNewest(liveAlerts).slice(0, Math.max(1, Math.min(limit, MAX_ALERTS)));
}

export function getBantahBroAlert(alertId: string) {
  return liveAlerts.find((item) => item.id === alertId) || null;
}

export function attachMarketToAlert(alertId: string, market: BantahBroMarketLink) {
  const existing = getBantahBroAlert(alertId);
  if (!existing) return null;
  const updated = bantahBroAlertSchema.parse({
    ...existing,
    updatedAt: new Date().toISOString(),
    market,
  });
  upsertItem(liveAlerts, updated, MAX_ALERTS);
  return updated;
}

export function attachBoostToAlert(alertId: string, boost: BantahBroBoost) {
  const existing = getBantahBroAlert(alertId);
  if (!existing) return null;
  const updated = bantahBroAlertSchema.parse({
    ...existing,
    updatedAt: new Date().toISOString(),
    boost,
  });
  upsertItem(liveAlerts, updated, MAX_ALERTS);
  return updated;
}

export function publishBantahBroReceipt(receipt: BantahBroReceipt) {
  const parsed = bantahBroReceiptSchema.parse(receipt);
  upsertItem(liveReceipts, parsed, MAX_RECEIPTS);
  return parsed;
}

export function listBantahBroReceipts(limit = 50) {
  return sortByNewest(liveReceipts).slice(0, Math.max(1, Math.min(limit, MAX_RECEIPTS)));
}

export function listBantahBroReceiptsByToken(tokenAddress: string, chainId?: string) {
  return sortByNewest(
    liveReceipts.filter(
      (item) =>
        item.tokenAddress.toLowerCase() === tokenAddress.toLowerCase() &&
        (!chainId || item.chainId.toLowerCase() === chainId.toLowerCase()),
    ),
  );
}

export function getBantahBroReceiptBySourceAlert(sourceAlertId: string) {
  return liveReceipts.find((item) => item.sourceAlertId === sourceAlertId) || null;
}

export function registerMarketBoost(boost: BantahBroBoost) {
  const parsed = bantahBroBoostSchema.parse(boost);
  upsertItem(marketBoosts, parsed, MAX_ALERTS);
  return parsed;
}

export function listMarketBoosts(limit = 50) {
  return sortByNewest(marketBoosts).slice(0, Math.max(1, Math.min(limit, MAX_ALERTS)));
}
