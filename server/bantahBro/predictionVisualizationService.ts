import type { ExternalMarket } from "@shared/externalMarkets";
import type {
  PredictionVisualizationBattle,
  PredictionVisualizationEvent,
  PredictionVisualizationFeed,
  PredictionVisualizationOrderIntent,
  PredictionVisualizationSide,
} from "@shared/predictionVisualization";
import {
  fetchPolymarketBtcFiveMinuteMarkets,
} from "../modules/agent-trading/services/externalMarketDataService";

const CACHE_TTL_MS = 30_000;

let cachedFeed: PredictionVisualizationFeed | null = null;
let cachedAt = 0;
let inflightFeedPromise: Promise<PredictionVisualizationFeed> | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeOddsPrice(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? value / 100 : value;
}

function formatCents(value: number) {
  const normalized = normalizeOddsPrice(value);
  if (normalized <= 0) return "n/a";
  return `${Math.round(normalized * 100)}¢`;
}

function formatUsd(value: number | null | undefined) {
  const resolved = safeNumber(value);
  if (resolved <= 0) return "n/a";
  if (resolved >= 1_000_000_000) return `$${(resolved / 1_000_000_000).toFixed(2)}B`;
  if (resolved >= 1_000_000) return `$${(resolved / 1_000_000).toFixed(2)}M`;
  if (resolved >= 1_000) return `$${(resolved / 1_000).toFixed(1)}K`;
  return `$${resolved.toFixed(2)}`;
}

function secondsUntil(value: string | null) {
  if (!value) return null;
  const end = new Date(value).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - Date.now()) / 1000));
}

function inferMarketSubject(question: string) {
  const text = question.toLowerCase();
  const candidates: Array<[RegExp, string]> = [
    [/\bbitcoin\b|\bbtc\b/, "BTC"],
    [/\bethereum\b|\beth\b/, "ETH"],
    [/\bsolana\b|\bsol\b/, "SOL"],
    [/\bdogecoin\b|\bdoge\b/, "DOGE"],
    [/\btrump\b/, "Trump"],
    [/\bai\b|artificial intelligence/, "AI"],
    [/\btesla\b|\btsla\b/, "Tesla"],
  ];
  const match = candidates.find(([pattern]) => pattern.test(text));
  return match?.[1] || "Market";
}

function extractContestSubject(question: string) {
  const cleaned = question
    .replace(/^will\s+/i, "")
    .replace(/\?+$/g, "")
    .trim();
  const beforeWin = cleaned.match(/^(.+?)\s+(win|be|become|reach|hit|break|claim|pass|lead)\b/i)?.[1];
  const beforeBy = cleaned.match(/^(.+?)\s+by\b/i)?.[1];
  const candidate = (beforeWin || beforeBy || cleaned).replace(/\b(the|a|an)\b/gi, "").trim();
  return candidate.split(/\s+/).slice(0, 4).join(" ") || inferMarketSubject(question);
}

function factionNamesForMarket(market: ExternalMarket, subject: string) {
  const question = market.question.toLowerCase();
  const compactSubject = subject === "Market" ? extractContestSubject(market.question) : subject;

  if (subject !== "Market") {
    return {
      yes: `${subject} Bulls`,
      no: `${subject} Bears`,
    };
  }

  if (/\bwin|nomination|election|president|champion|championship\b/.test(question)) {
    return {
      yes: `${compactSubject} Backers`,
      no: `${compactSubject} Faders`,
    };
  }

  if (/\babove|over|hit|reach|break|pass|higher|increase|rise\b/.test(question)) {
    return {
      yes: `${compactSubject} Bulls`,
      no: `${compactSubject} Bears`,
    };
  }

  if (/\bbelow|under|fall|drop|decrease|lower\b/.test(question)) {
    return {
      yes: `${compactSubject} Bears`,
      no: `${compactSubject} Bulls`,
    };
  }

  return {
    yes: "YES Army",
    no: "NO Army",
  };
}

function isEligibleVisualizationMarket(market: ExternalMarket) {
  const yes = normalizeOddsPrice(market.yesPrice);
  const no = normalizeOddsPrice(market.noPrice);
  const volume = safeNumber(market.volume);
  const liquidity = safeNumber(market.liquidity);
  const tooOneSided = Math.max(yes, no) >= 0.96 || Math.min(yes, no) <= 0.04;
  const isBtcFiveMinute = isBtcFiveMinuteMarket(market);
  return (
    market.source === "polymarket" &&
    market.isTradable &&
    market.status === "open" &&
    yes > 0 &&
    no > 0 &&
    (isBtcFiveMinute || !tooOneSided) &&
    (isBtcFiveMinute || volume >= 25_000 || liquidity >= 10_000) &&
    market.marketUrl
  );
}

function isBtcFiveMinuteMarket(market: Pick<ExternalMarket, "question" | "slug" | "tags">) {
  const text = `${market.question || ""} ${market.slug || ""} ${(market.tags || []).join(" ")}`.toLowerCase();
  return /\b(bitcoin|btc)\b/.test(text) && /\b(5\s*min|5m|5\s*minute)\b/.test(text);
}

function buildSide(params: {
  market: ExternalMarket;
  outcome: "YES" | "NO";
  price: number;
  probability: number;
  subject: string;
}): PredictionVisualizationSide {
  const { market, outcome, price, probability, subject } = params;
  const isYes = outcome === "YES";
  const factions = factionNamesForMarket(market, subject);
  const factionName = isYes ? factions.yes : factions.no;

  return {
    id: `${market.source}:${market.polymarketMarketId}:${outcome.toLowerCase()}`,
    outcome,
    label: outcome,
    factionName,
    emoji: isYes ? "🐂" : "🐻",
    color: isYes ? "green" : "red",
    sourceTokenId: isYes ? market.yesTokenId || null : market.noTokenId || null,
    price,
    priceDisplay: formatCents(price),
    impliedProbability: probability,
    confidence: probability,
    sourceActionLabel: isYes ? "Join Bulls" : "Join Bears",
  };
}

function buildEvents(params: {
  battleId: string;
  market: ExternalMarket;
  yes: PredictionVisualizationSide;
  no: PredictionVisualizationSide;
  now: Date;
}): PredictionVisualizationEvent[] {
  const { battleId, market, yes, no, now } = params;
  const leader = yes.confidence >= no.confidence ? yes : no;
  const trailer = leader.id === yes.id ? no : yes;
  const eventTime = (offsetSeconds: number) => new Date(now.getTime() - offsetSeconds * 1000).toISOString();

  return [
    {
      id: `${battleId}-odds-lead`,
      time: eventTime(12),
      type: "odds",
      sideId: leader.id,
      agentName: "BantahBro Market Theater",
      message: `${leader.factionName} leads at ${leader.confidence}% from live Polymarket odds.`,
      metricLabel: `${leader.outcome} odds`,
      metricValue: leader.priceDisplay,
    },
    {
      id: `${battleId}-odds-trailer`,
      time: eventTime(32),
      type: "odds",
      sideId: trailer.id,
      agentName: "BantahBro Market Theater",
      message: `${trailer.factionName} is defending at ${trailer.confidence}% implied probability.`,
      metricLabel: `${trailer.outcome} odds`,
      metricValue: trailer.priceDisplay,
    },
    {
      id: `${battleId}-volume`,
      time: eventTime(52),
      type: "volume",
      sideId: null,
      agentName: "Polymarket Feed",
      message: `Source market volume is ${formatUsd(market.volume)} with ${formatUsd(market.liquidity)} liquidity.`,
      metricLabel: "Volume",
      metricValue: formatUsd(market.volume),
    },
    {
      id: `${battleId}-system`,
      time: eventTime(72),
      type: "system",
      sideId: null,
      agentName: "BantahBro Engine",
      message: "Visualization mode only. Liquidity, execution, and settlement stay on the source market.",
      metricLabel: "Mode",
      metricValue: "Read-only",
    },
  ];
}

function buildBattle(market: ExternalMarket, index: number, now: Date): PredictionVisualizationBattle {
  const yesPrice = normalizeOddsPrice(market.yesPrice);
  const noPrice = normalizeOddsPrice(market.noPrice);
  const total = Math.max(0.0001, yesPrice + noPrice);
  const yesProbability = clamp(Math.round((yesPrice / total) * 100), 1, 99);
  const noProbability = 100 - yesProbability;
  const subject = inferMarketSubject(market.question);
  const yes = buildSide({ market, outcome: "YES", price: yesPrice, probability: yesProbability, subject });
  const no = buildSide({ market, outcome: "NO", price: noPrice, probability: noProbability, subject });
  const battleId = `prediction-visualization-${market.source}-${market.polymarketMarketId || market.id}`
    .replace(/[^a-zA-Z0-9:-]/g, "-")
    .slice(0, 180);
  const leadingSideId = yes.confidence >= no.confidence ? yes.id : no.id;

  return {
    id: battleId || `prediction-visualization-${index + 1}`,
    title: `${yes.factionName} vs ${no.factionName}`,
    battleType: "prediction-visualization",
    mode: "visualization",
    sourcePlatform: market.source,
    sourceMarketId: market.polymarketMarketId,
    sourceMarketUrl: market.marketUrl || market.sourceUrl || "",
    sourceStatus: market.status,
    sourceSlug: market.slug || null,
    marketTitle: market.question,
    category: market.category || null,
    volume: market.volume,
    liquidity: market.liquidity,
    endDate: market.endDate,
    timeRemainingSeconds: secondsUntil(market.endDate),
    winnerLogic: "External market determines outcome. BantahBro visualizes YES/NO as factions.",
    sides: [yes, no],
    leadingSideId,
    confidenceSpread: Math.abs(yes.confidence - no.confidence),
    events: buildEvents({ battleId, market, yes, no, now }),
    execution: {
      status: "read-only",
      tradeRouting: "polymarket-clob-planned",
      primaryActionLabel: "Open source market",
      note: "Phase 1 is read-only visualization. CLOB order signing/submission will be wired in a later phase.",
    },
    updatedAt: now.toISOString(),
  };
}

async function fetchCandidateMarkets(limit: number) {
  const btcFiveMinuteMarkets = await fetchPolymarketBtcFiveMinuteMarkets(Math.max(limit, 12));

  const byId = new Map<string, ExternalMarket>();

  for (const market of btcFiveMinuteMarkets) {
    if (!isEligibleVisualizationMarket(market)) continue;
    byId.set(market.polymarketMarketId || market.id, market);
  }

  return Array.from(byId.values())
    .sort((a, b) => {
      const aEnd = a.endDate ? new Date(a.endDate).getTime() : Number.MAX_SAFE_INTEGER;
      const bEnd = b.endDate ? new Date(b.endDate).getTime() : Number.MAX_SAFE_INTEGER;
      return aEnd - bEnd;
    })
    .slice(0, limit);
}

async function buildFeed(limit: number): Promise<PredictionVisualizationFeed> {
  const now = new Date();
  const safeLimit = clamp(Math.round(limit || 12), 1, 30);
  const markets = await fetchCandidateMarkets(safeLimit);
  const battles = markets.map((market, index) => buildBattle(market, index, now));

  return {
    battles,
    updatedAt: now.toISOString(),
    sources: {
      marketData: "polymarket",
      mode: "visualization",
      note: "Read-only visualization layer: BantahBro adds factions, arena context, and commentary while Polymarket keeps liquidity and settlement.",
    },
  };
}

export async function getLivePredictionVisualizationBattles(limit = 12) {
  const now = Date.now();
  if (cachedFeed && now - cachedAt < CACHE_TTL_MS && cachedFeed.battles.length >= Math.min(limit, 30)) {
    return {
      ...cachedFeed,
      battles: cachedFeed.battles.slice(0, clamp(Math.round(limit || 12), 1, 30)),
    };
  }

  if (!inflightFeedPromise) {
    inflightFeedPromise = buildFeed(limit).finally(() => {
      inflightFeedPromise = null;
    });
  }

  cachedFeed = await inflightFeedPromise;
  cachedAt = Date.now();
  return {
    ...cachedFeed,
    battles: cachedFeed.battles.slice(0, clamp(Math.round(limit || 12), 1, 30)),
  };
}

export async function preparePredictionVisualizationOrderIntent(params: {
  battleId: string;
  side: "yes" | "no";
  amountUsd: number;
  maxPrice?: number | null;
}): Promise<PredictionVisualizationOrderIntent> {
  const feed = await getLivePredictionVisualizationBattles(30);
  const battle = feed.battles.find((item) => item.id === params.battleId);
  if (!battle) {
    const error = new Error("Prediction visualization battle not found");
    (error as Error & { status?: number }).status = 404;
    throw error;
  }

  const side = params.side === "no" ? battle.sides[1] : battle.sides[0];
  const marketPrice = side.price;
  const maxPrice = clamp(Number(params.maxPrice || marketPrice + 0.02), 0.01, 0.99);
  const amountUsd = Math.max(1, Number(params.amountUsd || 0));

  return {
    battleId: battle.id,
    sourcePlatform: battle.sourcePlatform,
    sourceMarketId: battle.sourceMarketId,
    sourceMarketUrl: battle.sourceMarketUrl,
    side: params.side,
    outcome: side.outcome,
    factionName: side.factionName,
    sourceTokenId: side.sourceTokenId,
    amountUsd,
    maxPrice,
    estimatedShares: maxPrice > 0 ? Number((amountUsd / maxPrice).toFixed(4)) : 0,
    executionStatus: "clob-planned",
    executionReady: false,
    nextAction: "clob-not-configured",
    message:
      "Polymarket CLOB execution is not enabled yet. Open the source market to place the live order on Polymarket.",
    warnings: [
      "No BantahBro trade was submitted.",
      "Phase 3 requires wallet signing, CLOB credentials, allowance checks, and order submission wiring.",
    ],
  };
}
