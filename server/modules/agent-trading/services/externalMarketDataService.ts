import axios from "axios";

import type { ExternalMarket } from "@shared/externalMarkets";
import { normalizePolymarketMarkets } from "../../../externalMarketAdapters";

type FetchExternalMarketsOptions = {
  active?: boolean;
  closed?: boolean;
  limit?: number;
};

export async function fetchPolymarketMarkets(
  options: FetchExternalMarketsOptions = {},
): Promise<ExternalMarket[]> {
  const params = new URLSearchParams({
    active: options.active === false ? "false" : "true",
    closed: options.closed === true ? "true" : "false",
    limit: String(Math.min(Math.max(options.limit ?? 100, 1), 500)),
  });

  const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;
  const response = await axios.get(url, { timeout: 15000 });
  return normalizePolymarketMarkets(Array.isArray(response.data) ? response.data : []);
}

const FIVE_MINUTE_MARKET_PATTERN =
  /\b(5\s*minute|5\s*min|5m)\b|up\/down in 5|five[- ]minute/i;

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isUltraShortRawPolymarketMarket(market: any): boolean {
  const text = [
    market?.question,
    market?.slug,
    market?.groupItemTitle,
    ...(Array.isArray(market?.tags) ? market.tags.map((tag: any) => tag?.label || tag?.slug || tag) : []),
  ]
    .map((entry) => String(entry || "").trim().toLowerCase())
    .join(" ");

  if (FIVE_MINUTE_MARKET_PATTERN.test(text)) {
    return true;
  }

  const startDate =
    parseDate(market?.startDate) ||
    parseDate(market?.startDateIso) ||
    parseDate(market?.events?.[0]?.startDate);
  const endDate =
    parseDate(market?.endDate) ||
    parseDate(market?.endDateIso) ||
    parseDate(market?.umaEndDate) ||
    parseDate(market?.closedTime);

  if (startDate && endDate) {
    const durationMs = endDate.getTime() - startDate.getTime();
    if (durationMs > 0 && durationMs <= 1000 * 60 * 15) {
      return true;
    }
  }

  return false;
}

function flattenTrendingEventMarkets(events: any[]): any[] {
  return events.flatMap((event) => {
    const eventContext = {
      title: event?.title,
      ticker: event?.ticker,
      image: event?.image,
      icon: event?.icon,
      tags: event?.tags,
      liquidity: event?.liquidity,
      liquidityNum: event?.liquidity,
      volume24hr: event?.volume24hr,
    };

    return Array.isArray(event?.markets)
      ? event.markets.map((market: any) => ({
          ...market,
          events: [eventContext],
          tags: Array.isArray(market?.tags) && market.tags.length > 0 ? market.tags : event?.tags,
        }))
      : [];
  });
}

export async function fetchTrendingPolymarketMarketsFromEvents(eventLimit = 20): Promise<ExternalMarket[]> {
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    order: "volume24hr",
    ascending: "false",
    limit: String(Math.min(Math.max(eventLimit, 1), 50)),
  });

  const url = `https://gamma-api.polymarket.com/events?${params.toString()}`;
  const response = await axios.get(url, { timeout: 15000 });
  const flattenedMarkets = flattenTrendingEventMarkets(Array.isArray(response.data) ? response.data : []).filter(
    (market) => !isUltraShortRawPolymarketMarket(market),
  );

  return normalizePolymarketMarkets(flattenedMarkets);
}

function currentFiveMinuteEpochSeconds() {
  return Math.floor(Date.now() / 300_000) * 300;
}

function btcFiveMinuteEventSlug(epochSeconds: number) {
  return `btc-updown-5m-${epochSeconds}`;
}

async function fetchPolymarketEventBySlug(slug: string): Promise<any | null> {
  try {
    const response = await axios.get(`https://gamma-api.polymarket.com/events/slug/${slug}`, {
      timeout: 10000,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 404,
    });
    if (response.status === 404) return null;
    return response.data && typeof response.data === "object" ? response.data : null;
  } catch {
    return null;
  }
}

export async function fetchPolymarketBtcFiveMinuteMarkets(limit = 12): Promise<ExternalMarket[]> {
  const safeLimit = Math.min(Math.max(Math.round(limit || 12), 1), 30);
  const baseEpoch = currentFiveMinuteEpochSeconds();
  const epochOffsets = Array.from({ length: safeLimit + 8 }, (_, index) => (index - 2) * 300);
  const events = await Promise.all(
    epochOffsets.map((offset) => fetchPolymarketEventBySlug(btcFiveMinuteEventSlug(baseEpoch + offset))),
  );

  const rawMarkets = events.flatMap((event) => {
    if (!event || !Array.isArray(event.markets)) return [];
    const eventContext = {
      title: event.title,
      ticker: event.ticker,
      image: event.image,
      icon: event.icon,
      tags: event.tags,
      liquidity: event.liquidity,
      liquidityNum: event.liquidity,
      volume24hr: event.volume24hr,
    };

    return event.markets.map((market: any) => ({
      ...market,
      events: [eventContext],
      tags: Array.isArray(market?.tags) && market.tags.length > 0
        ? market.tags
        : [
            ...(Array.isArray(event?.tags) ? event.tags : []),
            { label: "Crypto", slug: "crypto" },
            { label: "BTC 5M", slug: "btc-5m" },
          ],
    }));
  });

  return normalizePolymarketMarkets(rawMarkets)
    .filter((market) => {
      const text = `${market.question} ${market.slug || ""} ${(market.tags || []).join(" ")}`.toLowerCase();
      return market.status === "open" && market.isTradable && /\b(bitcoin|btc)\b/.test(text) && /\b(5\s*min|5m|5\s*minute)\b/.test(text);
    })
    .sort((a, b) => {
      const aEnd = a.endDate ? new Date(a.endDate).getTime() : Number.MAX_SAFE_INTEGER;
      const bEnd = b.endDate ? new Date(b.endDate).getTime() : Number.MAX_SAFE_INTEGER;
      return aEnd - bEnd;
    })
    .slice(0, safeLimit);
}

export async function getPolymarketMarketById(marketId: string): Promise<ExternalMarket | null> {
  const needle = String(marketId || "").trim();
  if (!needle) return null;

  const markets = await fetchPolymarketMarkets({
    active: true,
    closed: false,
    limit: 200,
  });

  return (
    markets.find(
      (market) =>
        market.id === needle ||
        market.polymarketMarketId === needle ||
        market.slug === needle,
    ) || null
  );
}
