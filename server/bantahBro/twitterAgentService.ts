import fs from "node:fs/promises";
import path from "node:path";
import type { BantahBroAgentBattle } from "./agentBattleService";
import { getLiveBantahBroAgentBattles } from "./agentBattleService";
import {
  buildBattleCandidateFromQueries,
  type BantahBroBattleCandidate,
} from "./battleDiscoveryEngine";
import { publishBantahBroBattleCandidates } from "./battleListingsService";
import { maybeHandleBantahBroCommandSurface } from "./commandSurface";
import {
  buildBantahBroTwitterScanReply,
  extractBantahBroSurfaceScanIntent,
  runBantahBroSurfaceScan,
} from "./rugScorerSurface";
import { buildBantahBroBattlesUrl } from "./telegramSupport";
import { getBantahBroSystemAgentStatus } from "./systemAgent";
import { sendManagedBantahAgentRuntimeMessage } from "../bantahElizaRuntimeManager";
import {
  getAuthenticatedTwitterUser,
  getTwitterTransportStatus,
  getTwitterUserMentions,
  postTweet,
  searchRecentTweets,
  uploadTweetMedia,
  type TwitterPostResult,
  type TwitterTweet,
  type TwitterUser,
} from "./twitterTransport";

type TwitterAgentStatus = {
  configured: boolean;
  postEnabled: boolean;
  readEnabled: boolean;
  searchEnabled: boolean;
  searchReplyEnabled: boolean;
  replyEnabled: boolean;
  createBattleFromTweetsEnabled: boolean;
  autoListTweetBattles: boolean;
  threadPostEnabled: boolean;
  mediaPostEnabled: boolean;
  dryRun: boolean;
  missing: string[];
  lastPostedAt: string | null;
  lastTweetId: string | null;
  lastBattleRoundKey: string | null;
  lastAgentCycleAt: string | null;
  lastAgentCycleReason: string | null;
  reason: string;
};

type BattleTweetDraft = {
  text: string;
  battleId: string;
  roundKey: string;
  battleUrl: string;
  sides: Array<{
    id: string;
    label: string;
    confidence: number;
    priceDisplay: string;
    priceChangeH24: number;
    volumeH24: number | null;
    chainLabel: string | null;
  }>;
};

type PostBattleTweetOptions = {
  battleId?: string | null;
  force?: boolean;
};

type TwitterBattleIntent = {
  id: string;
  tweetId: string;
  tweetText: string;
  authorId: string | null;
  tickers: string[];
  status: "queued" | "listed" | "failed";
  listedBattleId: string | null;
  candidate: BantahBroBattleCandidate | null;
  error: string | null;
  createdAt: string;
};

type TwitterAgentStore = {
  version: 1;
  sinceMentionId: string | null;
  sinceSearchId: string | null;
  processedTweetIds: string[];
  createdBattleIntents: TwitterBattleIntent[];
};

type TwitterAgentDecision = {
  intent:
    | "battle_request"
    | "token_analysis"
    | "campaign_thread"
    | "live_battle"
    | "command_surface"
    | "general";
  shouldReply: boolean;
  replyText: string;
  battleIntent?: TwitterBattleIntent | null;
};

type TwitterAgentCycleResult = {
  dryRun: boolean;
  user: TwitterUser | null;
  mentionsChecked: number;
  searchChecked: number;
  repliesPrepared: number;
  repliesPosted: number;
  battleIntentsCreated: number;
  skipped: Array<{ tweetId: string; reason: string }>;
  actions: Array<{
    tweetId: string;
    source: "mention" | "search";
    intent: TwitterAgentDecision["intent"];
    replyText: string;
    postedTweetId: string | null;
    battleIntent?: TwitterBattleIntent | null;
  }>;
  reason: string;
};

const STORE_PATH = path.resolve(process.cwd(), "cache", "bantahbro-twitter-agent-state.json");
const ELIZA_TWITTER_REPLY_TIMEOUT_MS = Number(
  process.env.BANTAHBRO_TWITTER_ELIZA_REPLY_TIMEOUT_MS || 25_000,
);
const TWITTER_SYSTEM_AGENT_TIMEOUT_MS = Number(
  process.env.BANTAHBRO_TWITTER_SYSTEM_AGENT_TIMEOUT_MS || 8_000,
);
const TWITTER_BATTLE_BUILD_TIMEOUT_MS = Number(
  process.env.BANTAHBRO_TWITTER_BATTLE_BUILD_TIMEOUT_MS || 20_000,
);
const TWITTER_TOKEN_LOOKUP_TIMEOUT_MS = Number(
  process.env.BANTAHBRO_TWITTER_TOKEN_LOOKUP_TIMEOUT_MS || 12_000,
);
const postedRoundKeys = new Set<string>();
let cachedStore: TwitterAgentStore | null = null;
let lastPostedAt: string | null = null;
let lastTweetId: string | null = null;
let lastBattleRoundKey: string | null = null;
let lastAgentCycleAt: string | null = null;
let lastAgentCycleReason: string | null = null;

function parseBooleanEnv(name: string, fallback: boolean) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function parseIntegerEnv(name: string, fallback: number) {
  const raw = Number.parseInt(String(process.env[name] || "").trim(), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function formatPercent(value: number) {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${value >= 0 ? "+" : ""}${rounded}%`;
}

function formatVolume(value: number | null) {
  if (!Number.isFinite(value || NaN) || !value) return "n/a";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return `$${Math.round(value)}`;
}

function formatPrice(value: number | null) {
  if (!Number.isFinite(value || NaN) || !value) return "n/a";
  if (value >= 1) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function getBattleRoundKey(battle: BantahBroAgentBattle) {
  return `${battle.id}:${battle.startsAt}`;
}

function getBattleUrl(_battle: BantahBroAgentBattle) {
  return buildBantahBroBattlesUrl(_battle.id);
}

function truncateTweet(text: string, limit = 280) {
  const clean = text.replace(/\s+\n/g, "\n").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(1, limit - 3)).trimEnd()}...`;
}

function appendUrlToTweet(text: string, url?: string | null, limit = 280) {
  const cleanText = String(text || "").trim();
  const cleanUrl = String(url || "").trim();
  if (!cleanUrl) {
    return truncateTweet(cleanText, limit);
  }
  if (!cleanText) {
    return truncateTweet(cleanUrl, limit);
  }
  if (cleanText.includes(cleanUrl)) {
    return truncateTweet(cleanText, limit);
  }
  const combined = `${cleanText}\n${cleanUrl}`;
  if (combined.length <= limit) {
    return combined;
  }
  const reserved = cleanUrl.length + 1;
  if (reserved >= limit) {
    return truncateTweet(cleanUrl, limit);
  }
  return `${truncateTweet(cleanText, limit - reserved)}\n${cleanUrl}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      timeout.unref?.();
    }),
  ]);
}

function emptyStore(): TwitterAgentStore {
  return {
    version: 1,
    sinceMentionId: null,
    sinceSearchId: null,
    processedTweetIds: [],
    createdBattleIntents: [],
  };
}

function normalizeStore(payload: unknown): TwitterAgentStore {
  if (!payload || typeof payload !== "object") return emptyStore();
  const raw = payload as Partial<TwitterAgentStore>;
  return {
    version: 1,
    sinceMentionId: raw.sinceMentionId ? String(raw.sinceMentionId) : null,
    sinceSearchId: raw.sinceSearchId ? String(raw.sinceSearchId) : null,
    processedTweetIds: Array.isArray(raw.processedTweetIds)
      ? raw.processedTweetIds.map((id) => String(id)).filter(Boolean).slice(-500)
      : [],
    createdBattleIntents: Array.isArray(raw.createdBattleIntents)
      ? raw.createdBattleIntents.slice(-200)
      : [],
  };
}

async function readStore() {
  if (cachedStore) return cachedStore;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    cachedStore = normalizeStore(JSON.parse(raw));
  } catch {
    cachedStore = emptyStore();
  }
  return cachedStore;
}

async function writeStore(store: TwitterAgentStore) {
  cachedStore = {
    ...store,
    processedTweetIds: store.processedTweetIds.slice(-500),
    createdBattleIntents: store.createdBattleIntents.slice(-200),
  };
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(cachedStore, null, 2), "utf8");
}

function compareTweetIds(left: string, right: string) {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return left.localeCompare(right);
  }
}

async function getBattleForTweet(battleId?: string | null) {
  const feed = await getLiveBantahBroAgentBattles(12);
  if (feed.battles.length === 0) {
    throw new Error("No live Dexscreener-backed Agent Battle is available.");
  }

  if (battleId) {
    const battle = feed.battles.find((entry) => entry.id === battleId);
    if (!battle) {
      throw new Error("Requested Agent Battle is not in the current live feed.");
    }
    return battle;
  }

  return feed.battles[0];
}

export function getBantahBroTwitterAgentStatus(): TwitterAgentStatus {
  const transport = getTwitterTransportStatus();
  const postEnabled = parseBooleanEnv(
    "BANTAHBRO_TWITTER_BATTLE_POST_ENABLED",
    parseBooleanEnv("TWITTER_POST_ENABLE", false),
  );
  const readEnabled = parseBooleanEnv(
    "BANTAHBRO_TWITTER_READ_ENABLED",
    parseBooleanEnv("BANTAHBRO_TWITTER_REPLY_LOOP_ENABLED", false),
  );
  const searchEnabled = parseBooleanEnv("BANTAHBRO_TWITTER_SEARCH_ENABLED", false);
  const replyEnabled = parseBooleanEnv(
    "BANTAHBRO_TWITTER_REPLY_ENABLED",
    parseBooleanEnv("BANTAHBRO_TWITTER_REPLY_LOOP_ENABLED", false),
  );
  const dryRun = parseBooleanEnv("BANTAHBRO_TWITTER_DRY_RUN", true);
  const createBattleFromTweetsEnabled = parseBooleanEnv(
    "BANTAHBRO_TWITTER_CREATE_BATTLE_FROM_TWEETS_ENABLED",
    false,
  );
  const autoListTweetBattles = parseBooleanEnv(
    "BANTAHBRO_TWITTER_AUTO_LIST_BATTLES_ENABLED",
    false,
  );
  const threadPostEnabled = parseBooleanEnv("BANTAHBRO_TWITTER_THREAD_POST_ENABLED", false);
  const mediaPostEnabled = parseBooleanEnv("BANTAHBRO_TWITTER_MEDIA_POST_ENABLED", false);
  const searchReplyEnabled = parseBooleanEnv("BANTAHBRO_TWITTER_SEARCH_REPLY_ENABLED", false);
  const active =
    postEnabled ||
    readEnabled ||
    searchEnabled ||
    replyEnabled ||
    createBattleFromTweetsEnabled ||
    threadPostEnabled ||
    mediaPostEnabled;

  return {
    configured: transport.configured,
    postEnabled,
    readEnabled,
    searchEnabled,
    searchReplyEnabled,
    replyEnabled,
    createBattleFromTweetsEnabled,
    autoListTweetBattles,
    threadPostEnabled,
    mediaPostEnabled,
    dryRun,
    missing: transport.missing,
    lastPostedAt,
    lastTweetId,
    lastBattleRoundKey,
    lastAgentCycleAt,
    lastAgentCycleReason,
    reason: !active
      ? "Twitter agent is configured but all agentic actions are disabled."
      : transport.configured
        ? dryRun
          ? "Twitter agent is ready in dry-run mode."
          : "Twitter agent is ready."
        : "Twitter credentials are missing.",
  };
}

export async function buildCurrentBattleTweetDraft(
  battleId?: string | null,
): Promise<BattleTweetDraft> {
  const battle = await getBattleForTweet(battleId);
  const [left, right] = battle.sides;
  const leader = battle.sides.find((side) => side.id === battle.leadingSideId) || left;
  const battleUrl = getBattleUrl(battle);

  const lines = [
    "LIVE AGENT BATTLE",
    `${left.label} vs ${right.label}`,
    "",
    `${left.label}: ${left.confidence}% - ${left.priceDisplay} - ${formatPercent(left.priceChangeH24)} - Vol ${formatVolume(left.volumeH24)}`,
    `${right.label}: ${right.confidence}% - ${right.priceDisplay} - ${formatPercent(right.priceChangeH24)} - Vol ${formatVolume(right.volumeH24)}`,
    "",
    `${leader.label} leading. Real Dexscreener data, 3 min round.`,
    battleUrl,
  ];

  return {
    text: truncateTweet(lines.join("\n")),
    battleId: battle.id,
    roundKey: getBattleRoundKey(battle),
    battleUrl,
    sides: battle.sides.map((side) => ({
      id: side.id,
      label: side.label,
      confidence: side.confidence,
      priceDisplay: side.priceDisplay,
      priceChangeH24: side.priceChangeH24,
      volumeH24: side.volumeH24,
      chainLabel: side.chainLabel,
    })),
  };
}

export async function buildCurrentBattleThreadDraft(battleId?: string | null) {
  const battle = await getBattleForTweet(battleId);
  const [left, right] = battle.sides;
  const leader = battle.sides.find((side) => side.id === battle.leadingSideId) || left;
  const url = getBattleUrl(battle);

  return [
    truncateTweet(
      [
        "LIVE BANTAHBRO WAR",
        `${left.label} vs ${right.label}`,
        "3 min round powered by live Dexscreener market data.",
        url,
      ].join("\n"),
    ),
    truncateTweet(
      [
        "Arena readout:",
        `${left.label}: ${left.confidence}% confidence, ${left.priceDisplay}, ${formatPercent(left.priceChangeH24)} 24H.`,
        `${right.label}: ${right.confidence}% confidence, ${right.priceDisplay}, ${formatPercent(right.priceChangeH24)} 24H.`,
        `${leader.label} has the edge right now.`,
      ].join("\n"),
    ),
    truncateTweet(
      [
        "How BantahBro reads it:",
        "Price movement, live volume, liquidity, buys/sells, and rivalry strength become an arena battle.",
        "Users predict the winner. Markets move the fight.",
      ].join("\n"),
    ),
  ];
}

export async function postCurrentBattleTweet(
  options: PostBattleTweetOptions = {},
): Promise<{ draft: BattleTweetDraft; tweet: TwitterPostResult; skipped: false }> {
  const status = getBantahBroTwitterAgentStatus();
  if (!status.postEnabled) {
    throw new Error("Twitter battle posting is disabled.");
  }
  if (!status.configured) {
    throw new Error(`Twitter transport is not configured. Missing: ${status.missing.join(", ")}`);
  }

  const draft = await buildCurrentBattleTweetDraft(options.battleId || null);
  if (!options.force && postedRoundKeys.has(draft.roundKey)) {
    throw new Error("This battle round has already been posted. Use force=true to repost.");
  }

  const tweet = await postTweet(draft.text);
  postedRoundKeys.add(draft.roundKey);
  lastPostedAt = new Date().toISOString();
  lastTweetId = tweet.id;
  lastBattleRoundKey = draft.roundKey;

  return {
    draft,
    tweet,
    skipped: false,
  };
}

export async function postCurrentBattleThread(options: PostBattleTweetOptions = {}) {
  const status = getBantahBroTwitterAgentStatus();
  if (!status.threadPostEnabled) {
    throw new Error("Twitter thread posting is disabled.");
  }
  if (!status.configured) {
    throw new Error(`Twitter transport is not configured. Missing: ${status.missing.join(", ")}`);
  }

  const draft = await buildCurrentBattleThreadDraft(options.battleId || null);
  const posted: TwitterPostResult[] = [];
  let replyToTweetId: string | null = null;

  for (const text of draft) {
    const tweet = await postTweet(text, { replyToTweetId });
    posted.push(tweet);
    replyToTweetId = tweet.id;
  }

  lastPostedAt = new Date().toISOString();
  lastTweetId = posted[posted.length - 1]?.id || null;

  return { draft, tweets: posted };
}

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildBattleCardSvg(draft: BattleTweetDraft) {
  const [left, right] = draft.sides;
  return `<svg width="1200" height="675" viewBox="0 0 1200 675" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="675" rx="42" fill="#050812"/>
  <rect x="32" y="32" width="1136" height="611" rx="34" fill="#0B1020" stroke="#2B3354" stroke-width="2"/>
  <text x="72" y="96" fill="#F9FAFB" font-size="34" font-family="Arial, sans-serif" font-weight="800">BANTAHBRO LIVE AGENT BATTLE</text>
  <text x="72" y="143" fill="#9CA3AF" font-size="22" font-family="Arial, sans-serif">Real Dexscreener data. 3 min prediction arena.</text>
  <rect x="72" y="192" width="460" height="240" rx="28" fill="#092B18" stroke="#25D366" stroke-width="3"/>
  <rect x="668" y="192" width="460" height="240" rx="28" fill="#351019" stroke="#FB3F4E" stroke-width="3"/>
  <text x="100" y="262" fill="#63F26D" font-size="58" font-family="Arial, sans-serif" font-weight="900">${escapeXml(left?.label || "LEFT")}</text>
  <text x="696" y="262" fill="#FF5B66" font-size="58" font-family="Arial, sans-serif" font-weight="900">${escapeXml(right?.label || "RIGHT")}</text>
  <text x="100" y="324" fill="#F9FAFB" font-size="38" font-family="Arial, sans-serif">${escapeXml(left?.confidence ?? 50)}% confidence</text>
  <text x="696" y="324" fill="#F9FAFB" font-size="38" font-family="Arial, sans-serif">${escapeXml(right?.confidence ?? 50)}% confidence</text>
  <text x="100" y="374" fill="#C7D2FE" font-size="28" font-family="Arial, sans-serif">${escapeXml(left?.priceDisplay || "n/a")} · ${escapeXml(formatPercent(left?.priceChangeH24 || 0))}</text>
  <text x="696" y="374" fill="#C7D2FE" font-size="28" font-family="Arial, sans-serif">${escapeXml(right?.priceDisplay || "n/a")} · ${escapeXml(formatPercent(right?.priceChangeH24 || 0))}</text>
  <text x="548" y="330" fill="#F9FAFB" font-size="86" font-family="Arial, sans-serif" font-weight="900">VS</text>
  <rect x="104" y="494" width="992" height="44" rx="22" fill="#1F2937"/>
  <rect x="104" y="494" width="${Math.max(0, Math.min(992, Math.round(((left?.confidence || 50) / 100) * 992)))}" height="44" rx="22" fill="#29E57B"/>
  <text x="124" y="526" fill="#020617" font-size="25" font-family="Arial, sans-serif" font-weight="900">${escapeXml(left?.confidence ?? 50)}%</text>
  <text x="1032" y="526" fill="#F9FAFB" font-size="25" font-family="Arial, sans-serif" font-weight="900">${escapeXml(right?.confidence ?? 50)}%</text>
  <text x="72" y="602" fill="#A78BFA" font-size="24" font-family="Arial, sans-serif">${escapeXml(draft.battleUrl)}</text>
</svg>`;
}

export async function postCurrentBattleMediaTweet(options: PostBattleTweetOptions = {}) {
  const status = getBantahBroTwitterAgentStatus();
  if (!status.mediaPostEnabled) {
    throw new Error("Twitter media posting is disabled.");
  }
  if (!status.configured) {
    throw new Error(`Twitter transport is not configured. Missing: ${status.missing.join(", ")}`);
  }

  const draft = await buildCurrentBattleTweetDraft(options.battleId || null);
  const sharp = (await import("sharp")).default;
  const png = await sharp(Buffer.from(buildBattleCardSvg(draft))).png().toBuffer();
  const media = await uploadTweetMedia(png, "image/png");
  const tweet = await postTweet(
    truncateTweet(`${draft.text}\n\nBattle card generated by BantahBro.`, 260),
    { mediaIds: [media.mediaId] },
  );

  lastPostedAt = new Date().toISOString();
  lastTweetId = tweet.id;
  lastBattleRoundKey = draft.roundKey;

  return { draft, media, tweet };
}

function extractTickers(text: string) {
  const tickers: string[] = [];
  const pattern = /\$([a-zA-Z][a-zA-Z0-9_!]{1,24})/g;
  let match = pattern.exec(text);
  while (match) {
    const ticker = match[1].toUpperCase();
    if (!["USD", "USDC", "USDT", "SOL", "ETH", "BTC"].includes(ticker)) {
      tickers.push(ticker);
    }
    match = pattern.exec(text);
  }
  return Array.from(new Set(tickers)).slice(0, 4);
}

function stripBotMentions(text: string) {
  return text.replace(/@\w+/g, "").replace(/\s+/g, " ").trim();
}

function isBattleRequest(text: string, tickers: string[]) {
  return (
    tickers.length >= 2 &&
    /(battle|war|vs|versus|fight|arena|challenge|create|launch|host)/i.test(text)
  );
}

function isAnalysisRequest(text: string, tickers: string[]) {
  return (
    Boolean(
      tickers.length >= 1 ||
        extractBantahBroSurfaceScanIntent(text, {
          allowPhraseFallback: true,
        }),
    ) &&
    /(analy[sz]e|price|chart|rug|scan|score|runner|liquidity|volume|holders|safe|risky|review|check)/i.test(text)
  );
}

function isThreadRequest(text: string) {
  return /(thread|campaign|write.*post|make.*post|tweet.*about|promote)/i.test(text);
}

function isLiveBattleRequest(text: string) {
  return /(current battle|live battle|arena|who.*winning|who.*leading|battle now)/i.test(text);
}

async function createBattleIntentFromTweet(
  tweet: TwitterTweet,
  tickers: string[],
  status: TwitterAgentStatus,
): Promise<TwitterBattleIntent> {
  const id = `tw-battle-${tweet.id}`;
  const base: TwitterBattleIntent = {
    id,
    tweetId: tweet.id,
    tweetText: tweet.text,
    authorId: tweet.author_id || null,
    tickers: tickers.slice(0, 2),
    status: "queued",
    listedBattleId: null,
    candidate: null,
    error: null,
    createdAt: new Date().toISOString(),
  };

  if (!status.createBattleFromTweetsEnabled) {
    return {
      ...base,
      error: "Twitter battle creation is disabled.",
    };
  }

  try {
    const { candidate } = await withTimeout(
      buildBattleCandidateFromQueries({
        leftQuery: tickers[0],
        rightQuery: tickers[1],
      }),
      TWITTER_BATTLE_BUILD_TIMEOUT_MS,
      "Battle candidate lookup timed out.",
    );
    if (status.autoListTweetBattles) {
      const [listed] = await publishBantahBroBattleCandidates([candidate], {
        source: "manual",
        listedBy: `twitter:${tweet.author_id || "unknown"}`,
      });
      return {
        ...base,
        status: "listed",
        listedBattleId: listed?.engineBattleId || candidate.id,
        candidate,
      };
    }
    return {
      ...base,
      status: "queued",
      candidate,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      error: error instanceof Error ? error.message : "Failed to create battle from tweet.",
    };
  }
}

async function buildTokenAnalysisReply(
  text: string,
  tickers: string[],
): Promise<{ text: string; scanUrl: string | null }> {
  const extractedIntent = extractBantahBroSurfaceScanIntent(text, {
    allowPhraseFallback: true,
  });
  const scan = await withTimeout(
    extractedIntent
      ? runBantahBroSurfaceScan({
          query: extractedIntent.query,
          chainId: extractedIntent.chainId,
        })
      : tickers[0]
        ? runBantahBroSurfaceScan({
            query: tickers[0],
          })
        : Promise.resolve(null),
    TWITTER_TOKEN_LOOKUP_TIMEOUT_MS,
    "Token lookup timed out.",
  );

  if (!scan) {
    return {
      text: tickers[0]
        ? `I couldn't resolve $${tickers[0]} to a live Rug Scorer token. Send a clearer ticker or contract and I'll scan it.`
        : "I couldn't resolve that token to a live Rug Scorer result. Send a clearer ticker or contract and I'll scan it.",
      scanUrl: null,
    };
  }

  const mode =
    /\brunner\b/i.test(text) ? "runner" : /\brug|safe|risky|risk\b/i.test(text) ? "rug" : "analyze";
  return {
    text: truncateTweet(buildBantahBroTwitterScanReply(scan, mode), 220),
    scanUrl: scan.scanUrl,
  };
}

async function buildElizaTwitterReply(
  tweet: TwitterTweet,
  context: string,
  fallback: string,
) {
  try {
    const systemAgent = await withTimeout(
      getBantahBroSystemAgentStatus(),
      TWITTER_SYSTEM_AGENT_TIMEOUT_MS,
      "BantahBro system agent lookup timed out.",
    );
    if (!systemAgent?.agentId) return truncateTweet(fallback, 240);

    const response = await withTimeout(
      sendManagedBantahAgentRuntimeMessage(systemAgent.agentId, {
        text: [
          "Twitter/X mention for BantahBro.",
          "Reply in one sharp public post under 240 characters.",
          "Use live tools for live market facts. Never invent numbers.",
          context ? `Verified context: ${context}` : "",
          "",
          tweet.text,
        ]
          .filter(Boolean)
          .join("\n"),
        sessionId: `twitter-${tweet.id}`,
        userId: tweet.author_id ? `twitter-${tweet.author_id}` : `twitter-${tweet.id}`,
        userName: "Twitter User",
        tool: "assistant",
        source: "twitter",
        context,
      }),
      ELIZA_TWITTER_REPLY_TIMEOUT_MS,
      "Eliza Twitter reply timed out.",
    );
    return truncateTweet(response.text, 240);
  } catch {
    return truncateTweet(fallback, 240);
  }
}

async function buildDecisionForTweet(
  tweet: TwitterTweet,
  status: TwitterAgentStatus,
): Promise<TwitterAgentDecision> {
  const cleanText = stripBotMentions(tweet.text);
  const tickers = extractTickers(cleanText);
  const surfaceReply = await maybeHandleBantahBroCommandSurface({
    text: cleanText,
    source: "twitter",
    actor: null,
  });

  if (surfaceReply) {
    return {
      intent: "command_surface",
      shouldReply: true,
      replyText: appendUrlToTweet(
        truncateTweet(surfaceReply.reply, 220),
        surfaceReply.links[0]?.url || null,
      ),
    };
  }

  if (isBattleRequest(cleanText, tickers)) {
    const battleIntent = await createBattleIntentFromTweet(tweet, tickers, status);
    const [left, right] = tickers;
    const listedBattleUrl =
      battleIntent.status === "listed"
        ? buildBantahBroBattlesUrl(battleIntent.listedBattleId || battleIntent.candidate?.id || null)
        : null;
    const reply =
      battleIntent.status === "listed"
        ? `Battle listed: $${left} vs $${right} is live. Jump into the BantahBro arena below.`
        : battleIntent.status === "queued" && battleIntent.candidate
          ? `Battle intent built: $${left} vs $${right}. Score ${battleIntent.candidate.score}. Queued for BantahBro listing.`
          : `I saw the $${left} vs $${right} battle request, but could not create it yet: ${battleIntent.error || "battle creation is disabled"}.`;
    return {
      intent: "battle_request",
      shouldReply: true,
      replyText: appendUrlToTweet(
        await buildElizaTwitterReply(
          tweet,
          [
            `Detected battle request: $${left} vs $${right}.`,
            `Battle intent status: ${battleIntent.status}.`,
            battleIntent.candidate
              ? `Battle score: ${battleIntent.candidate.score}. Winner rule: ${battleIntent.candidate.winnerRule}.`
              : "",
            battleIntent.error ? `Error: ${battleIntent.error}.` : "",
          ]
            .filter(Boolean)
            .join(" "),
          reply,
        ),
        listedBattleUrl,
      ),
      battleIntent,
    };
  }

  if (isAnalysisRequest(cleanText, tickers)) {
    const factualReply = await buildTokenAnalysisReply(cleanText, tickers);
    return {
      intent: "token_analysis",
      shouldReply: true,
      replyText: appendUrlToTweet(
        await buildElizaTwitterReply(tweet, factualReply.text, factualReply.text),
        factualReply.scanUrl,
      ),
    };
  }

  if (isThreadRequest(cleanText)) {
    const thread = await buildCurrentBattleThreadDraft().catch(() => []);
    const fallback = thread[0] || "Campaign thread ready once a live BantahBro battle is available.";
    return {
      intent: "campaign_thread",
      shouldReply: true,
      replyText: await buildElizaTwitterReply(
        tweet,
        `User requested a campaign/thread. Current draft opener: ${fallback}`,
        fallback,
      ),
    };
  }

  if (isLiveBattleRequest(cleanText)) {
    const draft = await buildCurrentBattleTweetDraft().catch(() => null);
    const fallback = draft?.text || "No live BantahBro battle is available at this exact moment.";
    return {
      intent: "live_battle",
      shouldReply: true,
      replyText: appendUrlToTweet(
        await buildElizaTwitterReply(
          tweet,
          draft
            ? `Current live battle draft: ${draft.text}`
            : "No live BantahBro battle is available right now.",
          fallback,
        ),
        draft?.battleUrl || null,
      ),
    };
  }

  const runtimeReply = await buildElizaTwitterReply(
    tweet,
    "No deterministic battle/token intent was detected. Decide whether to answer publicly in BantahBro voice.",
    "",
  );
  return {
    intent: "general",
    shouldReply: Boolean(runtimeReply),
    replyText:
      runtimeReply ||
      "I am live. Mention a token, ask for a scan, or say '$TOKEN vs $TOKEN battle' and I will build the BantahBro read.",
  };
}

async function processTwitterTweet(params: {
  tweet: TwitterTweet;
  source: "mention" | "search";
  me: TwitterUser;
  store: TwitterAgentStore;
  status: TwitterAgentStatus;
  dryRun: boolean;
}) {
  const { tweet, source, me, store, status, dryRun } = params;
  if (store.processedTweetIds.includes(tweet.id)) {
    return { skipped: true as const, reason: "already processed" };
  }
  if (tweet.author_id && tweet.author_id === me.id) {
    store.processedTweetIds.push(tweet.id);
    return { skipped: true as const, reason: "own tweet" };
  }

  const decision = await buildDecisionForTweet(tweet, status);
  if (!decision.shouldReply) {
    store.processedTweetIds.push(tweet.id);
    return { skipped: true as const, reason: "no reply needed" };
  }

  if (decision.battleIntent) {
    store.createdBattleIntents.push(decision.battleIntent);
  }

  const canReplyFromSource = source === "mention" || status.searchReplyEnabled;
  let postedTweetId: string | null = null;
  if (status.replyEnabled && canReplyFromSource && !dryRun) {
    const posted = await postTweet(decision.replyText, { replyToTweetId: tweet.id });
    postedTweetId = posted.id;
    lastPostedAt = new Date().toISOString();
    lastTweetId = posted.id;
  }

  store.processedTweetIds.push(tweet.id);
  return {
    skipped: false as const,
    decision,
    postedTweetId,
  };
}

function buildDefaultSearchQuery(username?: string | null) {
  const configured = String(process.env.BANTAHBRO_TWITTER_SEARCH_QUERY || "").trim();
  if (configured) return configured;
  const selfFilter = username ? ` -from:${username}` : "";
  return `(BantahBro OR Bantah OR BXBT OR "agent battle" OR "coin battle")${selfFilter} -is:retweet`;
}

export async function runBantahBroTwitterAgentCycle(
  options: { dryRun?: boolean; maxMentions?: number; maxSearch?: number } = {},
): Promise<TwitterAgentCycleResult> {
  const status = getBantahBroTwitterAgentStatus();
  const dryRun = options.dryRun ?? status.dryRun;
  const result: TwitterAgentCycleResult = {
    dryRun,
    user: null,
    mentionsChecked: 0,
    searchChecked: 0,
    repliesPrepared: 0,
    repliesPosted: 0,
    battleIntentsCreated: 0,
    skipped: [],
    actions: [],
    reason: status.reason,
  };

  lastAgentCycleAt = new Date().toISOString();

  if (!status.configured) {
    lastAgentCycleReason = status.reason;
    result.reason = status.reason;
    return result;
  }
  if (!status.readEnabled && !status.searchEnabled) {
    lastAgentCycleReason = "Twitter read/search is disabled.";
    result.reason = lastAgentCycleReason;
    return result;
  }

  const store = await readStore();
  const me = await getAuthenticatedTwitterUser();
  result.user = me;

  const tweetsToProcess: Array<{ tweet: TwitterTweet; source: "mention" | "search" }> = [];

  if (status.readEnabled) {
    try {
      const mentions = await getTwitterUserMentions(me.id, {
        sinceId: store.sinceMentionId,
        maxResults: options.maxMentions || parseIntegerEnv("BANTAHBRO_TWITTER_MENTION_LIMIT", 10),
      });
      result.mentionsChecked = mentions.tweets.length;
      if (mentions.meta.newest_id) store.sinceMentionId = mentions.meta.newest_id;
      tweetsToProcess.push(
        ...mentions.tweets
          .sort((left, right) => compareTweetIds(left.id, right.id))
          .map((tweet) => ({ tweet, source: "mention" as const })),
      );
    } catch (error) {
      result.skipped.push({
        tweetId: "mentions",
        reason: error instanceof Error ? error.message : "Twitter mention read failed.",
      });
    }
  }

  if (status.searchEnabled) {
    try {
      const search = await searchRecentTweets(buildDefaultSearchQuery(me.username), {
        sinceId: store.sinceSearchId,
        maxResults: options.maxSearch || parseIntegerEnv("BANTAHBRO_TWITTER_SEARCH_LIMIT", 10),
      });
      result.searchChecked = search.tweets.length;
      if (search.meta.newest_id) store.sinceSearchId = search.meta.newest_id;
      tweetsToProcess.push(
        ...search.tweets
          .sort((left, right) => compareTweetIds(left.id, right.id))
          .map((tweet) => ({ tweet, source: "search" as const })),
      );
    } catch (error) {
      result.skipped.push({
        tweetId: "search",
        reason: error instanceof Error ? error.message : "Twitter search read failed.",
      });
    }
  }

  for (const item of tweetsToProcess) {
    try {
      const processed = await processTwitterTweet({
        tweet: item.tweet,
        source: item.source,
        me,
        store,
        status,
        dryRun,
      });

      if (processed.skipped) {
        result.skipped.push({ tweetId: item.tweet.id, reason: processed.reason });
        continue;
      }

      result.repliesPrepared += 1;
      if (processed.postedTweetId) result.repliesPosted += 1;
      if (processed.decision.battleIntent) result.battleIntentsCreated += 1;
      result.actions.push({
        tweetId: item.tweet.id,
        source: item.source,
        intent: processed.decision.intent,
        replyText: processed.decision.replyText,
        postedTweetId: processed.postedTweetId,
        battleIntent: processed.decision.battleIntent,
      });
    } catch (error) {
      result.skipped.push({
        tweetId: item.tweet.id,
        reason: error instanceof Error ? error.message : "Twitter agent processing failed.",
      });
    }
  }

  await writeStore(store);
  lastAgentCycleReason = `Processed ${tweetsToProcess.length} tweet(s), prepared ${result.repliesPrepared} reply/replies.`;
  result.reason = lastAgentCycleReason;
  return result;
}

export async function previewBantahBroTwitterAgentResponse(text: string) {
  const tweet: TwitterTweet = {
    id: `preview-${Date.now()}`,
    text,
    author_id: "preview-user",
    created_at: new Date().toISOString(),
  };
  const status = getBantahBroTwitterAgentStatus();
  const decision = await buildDecisionForTweet(tweet, {
    ...status,
    createBattleFromTweetsEnabled: true,
    autoListTweetBattles: false,
    dryRun: true,
  });

  return {
    status: {
      ...status,
      dryRun: true,
    },
    tweet,
    decision,
  };
}
