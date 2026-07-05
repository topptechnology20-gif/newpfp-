import type { ExternalMarket } from "@shared/externalMarkets";

const parseStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    } catch {
      return [];
    }
  }
  return [];
};

const parseNumberArray = (value: unknown): number[] => {
  if (Array.isArray(value)) return value.map((entry) => Number(entry) || 0);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((entry) => Number(entry) || 0);
    } catch {
      return [];
    }
  }
  return [];
};

const pickFirstValidImage = (candidates: unknown[]): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
  }
  return undefined;
};

const parseTags = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (entry && typeof entry === "object") {
          const objectEntry = entry as { name?: unknown; label?: unknown; slug?: unknown };
          return String(objectEntry.name || objectEntry.label || objectEntry.slug || "").trim();
        }
        return "";
      })
      .filter(Boolean);
  }
  return [];
};

const inferMarketCategory = (market: any, tags: string[]): string => {
  const haystack = [
    market?.category,
    market?.groupItemTitle,
    market?.question,
    market?.title,
    market?.events?.[0]?.title,
    market?.events?.[0]?.ticker,
    ...tags,
  ]
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");

  const matchesAny = (keywords: string[]) => keywords.some((keyword) => haystack.includes(keyword));

  if (
    matchesAny([
      "crypto",
      "bitcoin",
      "btc",
      "ethereum",
      "eth",
      "solana",
      "doge",
      "defi",
      "memecoin",
      "token",
      "base",
    ])
  ) {
    return "crypto";
  }

  if (
    matchesAny([
      "sports",
      "nba",
      "nfl",
      "mlb",
      "nhl",
      "ufc",
      "soccer",
      "football",
      "tennis",
      "golf",
      "premier league",
      "champions league",
      "wnba",
      "ncaa",
      "f1",
      "formula 1",
    ])
  ) {
    return "sports";
  }

  if (
    matchesAny([
      "politics",
      "election",
      "trump",
      "biden",
      "president",
      "congress",
      "senate",
      "house",
      "government",
      "geopolitics",
      "war",
      "iran",
      "ukraine",
      "russia",
      "china",
      "tariff",
      "military",
      "policy",
    ])
  ) {
    return "politics";
  }

  return String(market?.category || "").trim() || "general";
};

const isPastEndDate = (value: unknown): boolean => {
  if (!value) return false;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() <= Date.now();
};

export const normalizePolymarketMarket = (market: any): ExternalMarket => {
  const outcomes = parseStringArray(market?.outcomes);
  const prices = parseNumberArray(market?.outcomePrices);
  const normalizedPrices = outcomes.length
    ? outcomes.map((_, index) => Number(prices[index] || 0))
    : prices;
  const clobTokenIds = parseStringArray(
    market?.clobTokenIds || market?.clob_token_ids || market?.clobTokenIDs,
  );
  const id = String(
    market?.id || market?.conditionId || market?.condition_id || market?.slug || `market_${Date.now()}`,
  );
  const slug = market?.slug ? String(market.slug) : undefined;
  const question =
    market?.question ||
    market?.title ||
    (slug ? slug.replace(/-/g, " ") : "Unknown Question");
  const image = pickFirstValidImage([
    market?.image,
    market?.icon,
    market?.events?.[0]?.image,
    market?.events?.[0]?.icon,
  ]);
  const icon = pickFirstValidImage([
    market?.icon,
    market?.image,
    market?.events?.[0]?.icon,
    market?.events?.[0]?.image,
  ]);
  const polymarketMarketId = String(
    market?.id || market?.conditionId || market?.condition_id || slug || id,
  );
  const loweredOutcomes = (outcomes.length ? outcomes : ["Yes", "No"]).map((entry) =>
    String(entry || "").trim().toLowerCase(),
  );
  const resolvedYesIndex = loweredOutcomes.findIndex((entry) => entry === "yes");
  const resolvedNoIndex = loweredOutcomes.findIndex((entry) => entry === "no");
  const yesIndex = resolvedYesIndex >= 0 ? resolvedYesIndex : 0;
  const noIndex = resolvedNoIndex >= 0 ? resolvedNoIndex : 1;
  const yesPrice = Number(normalizedPrices[yesIndex] || 0);
  const noPrice = Number(normalizedPrices[noIndex] || 0);
  const liquidity = Number(
    market?.liquidityNum ??
      market?.liquidity ??
      market?.events?.[0]?.liquidityNum ??
      market?.events?.[0]?.liquidity ??
      0,
  );
  const active = Boolean(market?.active ?? market?.is_active ?? false);
  const closed = Boolean(market?.closed ?? market?.is_closed ?? false);
  const endDate =
    market?.endDate ||
    market?.end_date_iso ||
    market?.endDateIso ||
    market?.end_date ||
    null;
  const hasEnded = isPastEndDate(endDate);
  const status = closed ? "closed" : active && !hasEnded ? "open" : hasEnded ? "resolved" : "inactive";
  const tags = Array.from(
    new Set(
      [
        ...parseTags(market?.tags),
        ...parseTags(market?.events?.[0]?.tags),
        market?.groupItemTitle,
        market?.category,
      ]
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  );
  const category = inferMarketCategory(market, tags);
  const marketUrl = slug
    ? `https://polymarket.com/market/${slug}`
    : `https://polymarket.com/market/${id}`;

  return {
    source: "polymarket",
    id,
    polymarketMarketId,
    slug,
    question,
    description: market?.description || "",
    outcomes: outcomes.length ? outcomes : ["Yes", "No"],
    prices: normalizedPrices.length ? normalizedPrices : [0, 0],
    clobTokenIds,
    yesTokenId: clobTokenIds[yesIndex] || null,
    noTokenId: clobTokenIds[noIndex] || null,
    yesPrice,
    noPrice,
    liquidity,
    volume: Number(market?.volumeNum ?? market?.volume ?? 0),
    active,
    closed,
    status,
    endDate,
    category,
    tags,
    image,
    icon,
    marketUrl,
    sourceUrl: marketUrl,
    resolutionSource: market?.resolutionSource || market?.resolution_source || "",
    orderPriceMinTickSize: Number(market?.orderPriceMinTickSize ?? market?.order_price_min_tick_size ?? 0) || null,
    negRisk: typeof market?.negRisk === "boolean" ? market.negRisk : null,
    isTradable: active && !closed && !hasEnded,
    lastSyncedAt: new Date().toISOString(),
  };
};

export const normalizePolymarketMarkets = (markets: unknown[]): ExternalMarket[] => {
  if (!Array.isArray(markets)) return [];
  return markets.map((market) => normalizePolymarketMarket(market));
};
