import { analyzeToken, lookupMarketByQuery } from "./tokenIntelligence";

const HOT_TICKER_CACHE_TTL_MS = 4_000;
const DEXSCREENER_API_BASE =
  process.env.DEXSCREENER_API_BASE?.replace(/\/+$/, "") ||
  "https://api.dexscreener.com";

type HotTickerSource = "dexscreener";
type HotTickerStatus = "live";

type HotTickerWatchlistEntry = {
  id: string;
  emoji: string;
  query: string;
  displaySymbol: string;
  chainId?: string;
  tokenAddress?: string;
};

type DexScreenerBoostedToken = {
  chainId?: string;
  tokenAddress?: string;
  url?: string;
};

type HotTickerSlot = {
  id: string;
  emoji: string;
};

export interface BantahBroHotTickerEntry {
  id: string;
  emoji: string;
  logoUrl: string | null;
  displaySymbol: string;
  actualSymbol: string | null;
  tokenName: string | null;
  change: string;
  direction: "up" | "down" | "flat";
  priceChangeH24: number;
  priceUsd: number | null;
  priceDisplay: string;
  chainId: string | null;
  chainLabel: string | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  volumeH24: number | null;
  buysH24: number;
  sellsH24: number;
  tokenAddress: string | null;
  pairUrl: string | null;
  source: HotTickerSource;
  status: HotTickerStatus;
  holderEnriched: boolean;
  replacedQuery: string | null;
  reason: string | null;
}

export interface BantahBroHotTickersFeed {
  entries: BantahBroHotTickerEntry[];
  updatedAt: string;
  sources: {
    dexscreener: {
      available: boolean;
      active: boolean;
      count: number;
      message?: string;
    };
    moralis: {
      available: boolean;
      active: boolean;
      count: number;
      message?: string;
    };
  };
}

const HOT_TICKER_WATCHLIST: HotTickerWatchlistEntry[] = [
  {
    id: "loudy",
    emoji: "\uD83D\uDD25",
    query: "LOUDY",
    displaySymbol: "$Loudy",
  },
  {
    id: "zswap",
    emoji: "\uD83D\uDE08",
    query: "ZSWAP",
    displaySymbol: "$ZSWAP",
  },
  {
    id: "swif",
    emoji: "\u2694\uFE0F",
    query: "SWIF",
    displaySymbol: "SWIF",
  },
  {
    id: "kekcoin",
    emoji: "\uD83C\uDFB2",
    query: "KEKCOIN",
    displaySymbol: "$Kekcoin",
  },
  {
    id: "bonk",
    emoji: "\uD83C\uDFBA",
    query: "BONK",
    displaySymbol: "$BONK",
    chainId: "solana",
    tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  },
];

const HOT_TICKER_EMOJIS = [
  "\uD83D\uDD25",
  "\uD83D\uDE08",
  "\u2694\uFE0F",
  "\uD83C\uDFB2",
  "\uD83C\uDFBA",
  "\uD83E\uDD16",
  "\u25CE",
  "\uD83D\uDE80",
  "\uD83D\uDC8E",
  "\uD83E\uDDEA",
];

let cachedFeed: BantahBroHotTickersFeed | null = null;
let cachedAt = 0;
let inflightFeedPromise: Promise<BantahBroHotTickersFeed> | null = null;

function chainLabel(chainId?: string | null) {
  const normalized = String(chainId || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "sol" || normalized === "solana") return "Solana";
  if (normalized === "8453" || normalized === "base") return "Base";
  if (normalized === "42161" || normalized === "arb" || normalized === "arbitrum") return "Arbitrum";
  if (normalized === "56" || normalized === "bsc" || normalized === "bnb") return "BSC";
  return String(chainId);
}

function formatUsd(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }

  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0.00%";
  const absolute = Math.abs(value);
  const precision = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(precision)}%`;
}

function tokenKey(chainId?: string | null, tokenAddress?: string | null) {
  return `${String(chainId || "").toLowerCase()}:${String(tokenAddress || "").toLowerCase()}`;
}

function shuffle<T>(items: T[]) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }
  return shuffled;
}

function tickerSlots(limit: number): HotTickerSlot[] {
  return Array.from({ length: limit }, (_, index) => ({
    id: `slot-${index + 1}`,
    emoji: HOT_TICKER_EMOJIS[index % HOT_TICKER_EMOJIS.length],
  }));
}

async function fetchDexScreenerTrendingTokens() {
  const response = await fetch(`${DEXSCREENER_API_BASE}/token-boosts/top/v1`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`DexScreener trending request failed with ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? (data as DexScreenerBoostedToken[]) : [];
}

function buildEntryFromAnalysis(params: {
  id: string;
  emoji: string;
  displaySymbol?: string;
  analysis: Awaited<ReturnType<typeof analyzeToken>>;
  replacedQuery?: string | null;
  reason?: string | null;
}): BantahBroHotTickerEntry | null {
  const primaryPair = params.analysis.primaryPair;
  if (!primaryPair) return null;

  const priceChangeH24 = primaryPair.priceChange.h24;
  const direction =
    priceChangeH24 > 0 ? ("up" as const) : priceChangeH24 < 0 ? ("down" as const) : ("flat" as const);
  const symbol = primaryPair.baseToken.symbol || params.displaySymbol || "LIVE";

  return {
    id: params.id,
    emoji: params.emoji,
    logoUrl: primaryPair.imageUrl,
    displaySymbol: params.displaySymbol || (symbol.startsWith("$") ? symbol : `$${symbol}`),
    actualSymbol: primaryPair.baseToken.symbol || null,
    tokenName: primaryPair.baseToken.name || null,
    change: formatPercent(priceChangeH24),
    direction,
    priceChangeH24,
    priceUsd: primaryPair.priceUsd,
    priceDisplay: formatUsd(primaryPair.priceUsd),
    chainId: primaryPair.chainId,
    chainLabel: chainLabel(primaryPair.chainId),
    marketCap: primaryPair.marketCap,
    liquidityUsd: primaryPair.liquidityUsd,
    volumeH24: primaryPair.volume.h24,
    buysH24: primaryPair.txns.h24.buys,
    sellsH24: primaryPair.txns.h24.sells,
    tokenAddress: primaryPair.baseToken.address,
    pairUrl: primaryPair.url,
    source: "dexscreener",
    status: "live",
    holderEnriched: params.analysis.holders.status === "available",
    replacedQuery: params.replacedQuery || null,
    reason: params.reason || null,
  };
}

async function resolveWatchlistEntry(item: HotTickerWatchlistEntry) {
  if (item.chainId && item.tokenAddress) {
    const analysis = await analyzeToken({
      chainId: item.chainId,
      tokenAddress: item.tokenAddress,
    });

    return buildEntryFromAnalysis({
      id: item.id,
      emoji: item.emoji,
      displaySymbol: item.displaySymbol,
      analysis,
    });
  }

  const lookup = await lookupMarketByQuery({
    query: item.query,
    mode: "ticker-first",
  });

  if (!lookup.pair) return null;

  const analysis = await analyzeToken({
    chainId: lookup.pair.chainId,
    tokenAddress: lookup.pair.baseToken.address,
  });

  return buildEntryFromAnalysis({
    id: item.id,
    emoji: item.emoji,
    displaySymbol: item.displaySymbol,
    analysis,
  });
}

async function resolveTrendingEntry(
  boostedToken: DexScreenerBoostedToken,
  slot: HotTickerSlot,
) {
  if (!boostedToken.chainId || !boostedToken.tokenAddress) return null;

  const analysis = await analyzeToken({
    chainId: boostedToken.chainId,
    tokenAddress: boostedToken.tokenAddress,
  });

  return buildEntryFromAnalysis({
    id: `trending-${slot.id}-${tokenKey(boostedToken.chainId, boostedToken.tokenAddress)}`,
    emoji: slot.emoji,
    analysis,
    reason: "Random live DexScreener boosted token.",
  });
}

async function buildFeed(limit: number): Promise<BantahBroHotTickersFeed> {
  const resolvedLimit = Math.max(1, Math.min(limit, 10));
  const slots = tickerSlots(resolvedLimit);
  const trendingResult = await fetchDexScreenerTrendingTokens().then(
    (tokens) => ({ status: "fulfilled" as const, tokens }),
    (error) => ({ status: "rejected" as const, error }),
  );

  const entries: BantahBroHotTickerEntry[] = [];
  const usedTokenKeys = new Set<string>();

  if (trendingResult.status === "fulfilled") {
    for (const token of shuffle(trendingResult.tokens)) {
      if (entries.length >= resolvedLimit) break;
      const key = tokenKey(token.chainId, token.tokenAddress);
      if (!token.chainId || !token.tokenAddress || usedTokenKeys.has(key)) continue;

      try {
        const entry = await resolveTrendingEntry(token, slots[entries.length]);
        if (!entry) continue;
        entries.push(entry);
        usedTokenKeys.add(key);
      } catch {
        continue;
      }
    }
  }

  if (entries.length < resolvedLimit) {
    for (const item of shuffle(HOT_TICKER_WATCHLIST)) {
      if (entries.length >= resolvedLimit) break;

      try {
        const entry = await resolveWatchlistEntry(item);
        if (!entry) continue;

        const key = tokenKey(entry.chainId, entry.tokenAddress);
        if (usedTokenKeys.has(key)) continue;

        entries.push({
          ...entry,
          id: `searched-${item.id}-${key}`,
          emoji: slots[entries.length].emoji,
          reason: "Live DexScreener searched token used because boosted tokens did not fill every slot.",
        });
        usedTokenKeys.add(key);
      } catch {
        continue;
      }
    }
  }

  const liveCount = entries.length;
  const moralisCount = entries.filter((entry) => entry.holderEnriched).length;
  const missingCount = Math.max(0, resolvedLimit - entries.length);

  return {
    entries: entries.slice(0, resolvedLimit),
    updatedAt: new Date().toISOString(),
    sources: {
      dexscreener: {
        available: trendingResult.status === "fulfilled" || liveCount > 0,
        active: liveCount > 0,
        count: liveCount,
        message:
          missingCount > 0
            ? "DexScreener did not return enough live ticker or trending tokens to fill every ribbon slot."
            : undefined,
      },
      moralis: {
        available: true,
        active: moralisCount > 0,
        count: moralisCount,
        message:
          moralisCount === 0
            ? "Moralis holder enrichment is unavailable for the currently resolved ribbon tickers."
            : undefined,
      },
    },
  };
}

export async function getBantahBroHotTickers(limit = HOT_TICKER_WATCHLIST.length) {
  const now = Date.now();
  if (cachedFeed && (now - cachedAt) < HOT_TICKER_CACHE_TTL_MS) {
    return cachedFeed;
  }

  if (!inflightFeedPromise) {
    inflightFeedPromise = buildFeed(limit)
      .then((feed) => {
        cachedFeed = feed;
        cachedAt = Date.now();
        return feed;
      })
      .finally(() => {
        inflightFeedPromise = null;
      });
  }

  return inflightFeedPromise;
}
