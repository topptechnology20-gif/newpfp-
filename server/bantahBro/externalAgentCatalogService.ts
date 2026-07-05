import type {
  BotaFighterClass,
  BotaFighterOrigin,
  BotaFighterProfile,
} from "@shared/botaFighterProfile";
import type { BotaArenaFighter } from "@shared/botaArena";

type ExternalAgentSource = {
  origin: Extract<BotaFighterOrigin, "eliza" | "virtuals" | "bankr" | "game-sdk" | "agentkit">;
  label: string;
  chainId: string;
  endpoint: string;
  docsUrl: string;
  fetchMode: "eliza-rest" | "virtuals-acp-search" | "json-list";
  className: BotaFighterClass;
  archetype: BotaArenaFighter["archetype"];
  logoUrl: string;
};

type ExternalAgentCatalogResult = {
  profiles: BotaFighterProfile[];
  sources: Array<{
    origin: ExternalAgentSource["origin"];
    label: string;
    endpointConfigured: boolean;
    liveCount: number;
    seedCount: number;
  }>;
  updatedAt: string;
};

const EXTERNAL_AGENT_CATALOG_TARGET = Math.max(
  20,
  Math.min(Number.parseInt(String(process.env.BOTA_EXTERNAL_AGENT_CATALOG_TARGET || "120"), 10) || 120, 240),
);
const EXTERNAL_AGENT_CATALOG_TTL_MS = Math.max(
  30_000,
  Math.min(Number.parseInt(String(process.env.BOTA_EXTERNAL_AGENT_CATALOG_TTL_MS || "600000"), 10) || 600_000, 3_600_000),
);
const EXTERNAL_AGENT_FETCH_TIMEOUT_MS = Math.max(
  1_000,
  Math.min(Number.parseInt(String(process.env.BOTA_EXTERNAL_AGENT_FETCH_TIMEOUT_MS || "3500"), 10) || 3_500, 15_000),
);
const EXTERNAL_AGENT_SOURCE_TIMEOUT_MS = Math.max(
  1_200,
  Math.min(Number.parseInt(String(process.env.BOTA_EXTERNAL_AGENT_SOURCE_TIMEOUT_MS || "2500"), 10) || 2_500, 20_000),
);
const VIRTUALS_ACP_GRADUATION_STATUS = String(
  process.env.VIRTUALS_ACP_GRADUATION_STATUS ||
    process.env.BOTA_VIRTUALS_ACP_GRADUATION_STATUS ||
    "all",
).trim().toLowerCase();
const VIRTUALS_ACP_ONLINE_STATUS = String(
  process.env.VIRTUALS_ACP_ONLINE_STATUS ||
    process.env.BOTA_VIRTUALS_ACP_ONLINE_STATUS ||
    "all",
).trim().toLowerCase();
const VIRTUALS_ACP_SORT_BY = String(
  process.env.VIRTUALS_ACP_SORT_BY ||
    process.env.BOTA_VIRTUALS_ACP_SORT_BY ||
    "successfulJobCount,successRate",
).trim();
const VIRTUALS_ACP_SEARCH_KEYWORDS = String(
  process.env.VIRTUALS_ACP_SEARCH_KEYWORDS ||
    process.env.BOTA_VIRTUALS_ACP_SEARCH_KEYWORDS ||
    "agent",
)
  .split(",")
  .map((keyword) => keyword.trim())
  .filter(Boolean);
const VIRTUALS_ACP_DEFAULT_BASE_URL = "https://acpx.virtuals.io";

const SOURCE_LOGOS = {
  eliza: "/assets/source-elizaos.png",
  virtuals: "/assets/source-virtuals.jpg",
  bankr: "/assets/source-bankr.png",
  "game-sdk": "/assets/source-game-sdk.svg",
  agentkit: "/assets/source-agentkit.svg",
} as const;

const EXTERNAL_AGENT_FIGHTER_AVATARS = [
  "/2dgame/image/mascots/actions/bantah-punch-avatar-portrait.png",
  "/2dgame/image/mascots/actions/bantah-rival-punch-avatar-portrait.png",
  "/2dgame/image/mascots/actions/bantah-sword-avatar-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-emerald-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-purple-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-red-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-silver-portrait.png",
] as const;

const SOURCE_CHARACTER_OFFSET: Record<string, number> = {
  eliza: 0,
  virtuals: 6,
  bankr: 1,
  "game-sdk": 6,
  agentkit: 4,
};

const EXTERNAL_SOURCES: ExternalAgentSource[] = [
  {
    origin: "virtuals",
    label: "Virtuals Protocol",
    chainId: "base",
    endpoint: String(
      process.env.VIRTUALS_AGENT_REGISTRY_URL ||
        process.env.VIRTUALS_ACP_API_BASE ||
      process.env.BOTA_VIRTUALS_AGENT_REGISTRY_URL ||
        process.env.BOTA_VIRTUALS_ACP_API_BASE ||
        process.env.BOTA_VIRTUALS_AGENT_API_URL ||
        VIRTUALS_ACP_DEFAULT_BASE_URL,
    ).trim(),
    docsUrl: "https://whitepaper.virtuals.io/acp-product-resources/acp-onboarding-guide/tips-and-troubleshooting/debugging-acp-jobs",
    fetchMode: "virtuals-acp-search",
    className: "oracle",
    archetype: "oracle_duelist",
    logoUrl: SOURCE_LOGOS.virtuals,
  },
  {
    origin: "eliza",
    label: "ElizaOS",
    chainId: "elizaos",
    endpoint: String(
      process.env.ELIZAOS_AGENT_REGISTRY_URL ||
        process.env.ELIZAOS_BASE_URL ||
        process.env.ELIZAOS_AGENT_API_URL ||
        process.env.BOTA_ELIZAOS_AGENT_REGISTRY_URL ||
        process.env.BOTA_ELIZAOS_BASE_URL ||
        "",
    ).trim(),
    docsUrl: "https://docs.elizaos.ai/rest-reference/agents/list-all-agents",
    fetchMode: "eliza-rest",
    className: "striker",
    archetype: "signal_striker",
    logoUrl: SOURCE_LOGOS.eliza,
  },

  {
    origin: "agentkit",
    label: "AgentKit",
    chainId: "base",
    endpoint: String(
      process.env.AGENTKIT_AGENT_REGISTRY_URL ||
        process.env.BOTA_AGENTKIT_AGENT_REGISTRY_URL ||
        process.env.BOTA_BASE_AGENT_REGISTRY_URL ||
        "",
    ).trim(),
    docsUrl: "https://docs.cdp.coinbase.com/agentkit",
    fetchMode: "json-list",
    className: "scout",
    archetype: "momentum_scout",
    logoUrl: SOURCE_LOGOS.agentkit,
  },
];

let cachedCatalog: ExternalAgentCatalogResult | null = null;
let cachedAt = 0;
let inflightCatalogPromise: Promise<ExternalAgentCatalogResult> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function stableHash(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function fighterAvatarForSource(source: ExternalAgentSource, seed: string) {
  const offset = SOURCE_CHARACTER_OFFSET[source.origin] || 0;
  const index = (offset + stableHash(`${source.origin}:${seed}`)) % EXTERNAL_AGENT_FIGHTER_AVATARS.length;
  return EXTERNAL_AGENT_FIGHTER_AVATARS[index];
}

function slug(value: string) {
  return String(value || "agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "agent";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sourceEndpointUrl(source: ExternalAgentSource, virtualsVersion: "v4" | "v2" = "v4") {
  if (!source.endpoint) return "";
  try {
    const url = new URL(source.endpoint);
    if (source.fetchMode === "eliza-rest" && !url.pathname.includes("/api/agents")) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/agents`;
    }
    if (
      source.fetchMode === "virtuals-acp-search" &&
      !/\/agents\/v\d+\/search(?:\/)?$/i.test(url.pathname)
    ) {
      const normalizedPath = url.pathname.replace(/\/+$/, "");
      const apiBasePath = normalizedPath.endsWith("/api") ? normalizedPath : `${normalizedPath}/api`;
      url.pathname = `${apiBasePath}/agents/${virtualsVersion}/search`;
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizedVirtualsStatus(
  value: string,
  allowed: Set<string>,
  fallback: string,
) {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return allowed.has(normalized) ? normalized : fallback;
}

function virtualsSearchUrl(source: ExternalAgentSource, keyword: string, limit: number, version: "v4" | "v2") {
  const endpoint = sourceEndpointUrl(source, version);
  if (!endpoint) return "";
  const url = new URL(endpoint);
  url.searchParams.set("search", keyword);
  url.searchParams.set("top_k", String(Math.max(1, Math.min(limit, 50))));
  url.searchParams.set(
    "graduationStatus",
    normalizedVirtualsStatus(
      VIRTUALS_ACP_GRADUATION_STATUS,
      new Set(["all", "graduated", "not_graduated"]),
      "all",
    ),
  );
  url.searchParams.set(
    "onlineStatus",
    normalizedVirtualsStatus(
      VIRTUALS_ACP_ONLINE_STATUS,
      new Set(["all", "online", "offline"]),
      "all",
    ),
  );
  if (VIRTUALS_ACP_SORT_BY) {
    url.searchParams.set("sortBy", VIRTUALS_ACP_SORT_BY);
  }
  return url.toString();
}

function authHeadersForSource(source: ExternalAgentSource) {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const apiKey =
    source.origin === "virtuals"
      ? String(process.env.VIRTUALS_ACP_API_KEY || process.env.BOTA_VIRTUALS_ACP_API_KEY || "").trim()
      : source.origin === "eliza"
        ? String(process.env.ELIZAOS_API_KEY || process.env.BOTA_ELIZAOS_API_KEY || "").trim()
        : "";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs = EXTERNAL_AGENT_FETCH_TIMEOUT_MS,
) {
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractAgentRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  for (const key of ["agents", "items", "results", "profiles"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  const data = record.data;
  if (Array.isArray(data)) return data;
  const nestedData = asRecord(data);
  for (const key of ["agents", "items", "results", "profiles"]) {
    const value = nestedData[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function profileFromSourceAgent(
  source: ExternalAgentSource,
  raw: Record<string, unknown>,
  index: number,
): BotaFighterProfile {
  const rawId = stringValue(raw.id) ||
    stringValue(raw.agentId) ||
    stringValue(raw.uuid) ||
    stringValue(raw.uid) ||
    stringValue(raw.address) ||
    stringValue(raw.walletAddress) ||
    stringValue(raw.agentWalletAddress) ||
    stringValue(raw.providerAddress) ||
    stringValue(raw.contractAddress) ||
    stringValue(raw.slug);
  const displayName =
    stringValue(raw.name) ||
    stringValue(raw.displayName) ||
    stringValue(raw.agentName) ||
    stringValue(raw.username) ||
    `${source.label} Agent ${index + 1}`;
  const originId = rawId || slug(displayName);
  const seed = `${source.origin}:${originId}:${displayName}`;
  const rank = Math.max(1, Math.round(numberValue(raw.rank, index + 1)));
  const createdAt = nowIso();
  const sourceAvatarUrl =
    stringValue(raw.avatarUrl) ||
    stringValue(raw.avatar) ||
    stringValue(raw.image) ||
    stringValue(raw.imageUrl) ||
    stringValue(raw.profilePic) ||
    stringValue(raw.profileImage) ||
    stringValue(raw.logo) ||
    stringValue(raw.logoUrl) ||
    null;
  const avatarUrl = fighterAvatarForSource(source, seed);
  const externalUrl =
    stringValue(raw.url) ||
    stringValue(raw.externalUrl) ||
    stringValue(raw.profileUrl) ||
    stringValue(raw.website) ||
    source.docsUrl;
  const tokenSymbol =
    stringValue(raw.symbol) ||
    stringValue(raw.tokenSymbol) ||
    stringValue(asRecord(raw.token).symbol) ||
    null;
  const metrics = asRecord(raw.metrics);
  const stats = asRecord(raw.stats);
  const sourceWatchers = Math.max(0, Math.round(
    firstNumber(raw, ["followers", "watchers", "followerCount", "uniqueBuyerCount"]) ||
      firstNumber(metrics, ["followers", "watchers", "uniqueBuyerCount"]) ||
      firstNumber(stats, ["followers", "watchers", "uniqueBuyerCount"]),
  ));
  const sourceChallengeVolume = Math.max(0, Math.round(
    firstNumber(raw, ["challengeVolume", "activity", "successfulJobCount", "jobCount"]) ||
      firstNumber(metrics, ["challengeVolume", "activity", "successfulJobCount", "jobCount"]) ||
      firstNumber(stats, ["challengeVolume", "activity", "successfulJobCount", "jobCount"]),
  ));
  const sourceWins = Math.max(0, Math.round(
    firstNumber(raw, ["wins", "successfulJobCount", "completedJobs"]) ||
      firstNumber(metrics, ["wins", "successfulJobCount", "completedJobs"]) ||
      firstNumber(stats, ["wins", "successfulJobCount", "completedJobs"]),
  ));
  const sourceLosses = Math.max(0, Math.round(
    firstNumber(raw, ["losses", "failedJobCount", "rejectedJobs"]) ||
      firstNumber(metrics, ["losses", "failedJobCount", "rejectedJobs"]) ||
      firstNumber(stats, ["losses", "failedJobCount", "rejectedJobs"]),
  ));
  const sourceFameScore = Math.max(0,
    firstNumber(raw, ["fameScore", "successRate", "score", "rating"]) ||
      firstNumber(metrics, ["fameScore", "successRate", "score", "rating"]) ||
      firstNumber(stats, ["fameScore", "successRate", "score", "rating"]),
  );

  return {
    agentId: `external:${source.origin}:${slug(originId)}`,
    displayName: displayName.slice(0, 120),
    origin: source.origin,
    originId: originId.slice(0, 180),
    agentClass: source.className,
    archetype: source.archetype,
    league: `${source.label} League`,
    rank,
    avatarUrl,
    badgeLabel: source.label,
    ensName: null,
    walletAddress: stringValue(raw.walletAddress) || stringValue(raw.ownerAddress) || stringValue(raw.address) || null,
    externalUrl,
    tokenSymbol,
    tokenName: stringValue(raw.tokenName) || stringValue(asRecord(raw.token).name) || displayName,
    chainId: stringValue(raw.chainId, source.chainId),
    wins: 0,
    losses: 0,
    currentStreak: 0,
    fameScore: 0,
    watchers: 0,
    challengeVolume: 0,
    bantCreditsEarned: 0,
    liveSpectators: 0,
    titles: [
      source.origin === "eliza"
        ? "ElizaOS"
        : source.origin === "virtuals"
          ? "Virtuals Fighter"
          : source.origin === "bankr"
            ? "Bankr Agent"
            : source.label,
    ],
    tags: [source.origin, source.label, "external-agent", "arena"],
    lastBattleId: null,
    metadata: {
      importedFrom: source.label,
      importSource: source.label,
      sourceHint: source.label,
      sourceDocsUrl: source.docsUrl,
      sourceIconUrl: source.logoUrl,
      sourceAvatarUrl,
      sourceCatalog: true,
      statsSource: "bota-arena-records",
      sourceStats: {
        statsSource: "external-agent-api",
        wins: sourceWins,
        losses: sourceLosses,
        currentStreak: Math.round(
          firstNumber(raw, ["currentStreak", "streak"]) ||
            firstNumber(metrics, ["currentStreak", "streak"]) ||
            firstNumber(stats, ["currentStreak", "streak"]),
        ),
        fameScore: sourceFameScore,
        watchers: sourceWatchers,
        challengeVolume: sourceChallengeVolume,
      },
      brain: {
        type: "external",
        source: source.label,
      },
      agentIdentity: {
        kind: "external-agent",
        label: source.label,
        sourceLabel: source.label,
        brainLabel: source.label,
        logoUrl: source.logoUrl,
        identityLogoUrl: source.logoUrl,
        sourceLogoUrl: source.logoUrl,
        story: source.label,
      },
      logoBadge: {
        label: source.label,
        imageUrl: source.logoUrl,
      },
      registryAgent: raw,
    },
    importedAt: createdAt,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

async function fetchSourceProfiles(source: ExternalAgentSource, limit: number) {
  if (limit <= 0) return [];
  if (source.fetchMode === "virtuals-acp-search") {
    const keywords = VIRTUALS_ACP_SEARCH_KEYWORDS.length ? VIRTUALS_ACP_SEARCH_KEYWORDS : ["agent"];
    const perKeywordLimit = Math.max(1, Math.ceil(limit / keywords.length));
    for (const version of ["v4", "v2"] as const) {
      const payloads = await Promise.all(
        keywords.map((keyword) =>
          fetchJsonWithTimeout(
            virtualsSearchUrl(source, keyword, perKeywordLimit, version),
            authHeadersForSource(source),
          ),
        ),
      );
      const profiles = uniqueProfiles(
        payloads.flatMap((payload, payloadIndex) =>
          extractAgentRows(payload).map((row, rowIndex) =>
            profileFromSourceAgent(source, asRecord(row), payloadIndex * perKeywordLimit + rowIndex),
          ),
        ),
      ).slice(0, limit);
      if (profiles.length > 0) return profiles;
    }
    return [];
  }

  const endpoint = sourceEndpointUrl(source);
  const payload = await fetchJsonWithTimeout(endpoint, authHeadersForSource(source));
  const rows = extractAgentRows(payload).slice(0, limit);
  return rows.map((row, index) => profileFromSourceAgent(source, asRecord(row), index));
}

async function fetchSourceProfilesWithTimeout(source: ExternalAgentSource, limit: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchSourceProfiles(source, limit),
      new Promise<BotaFighterProfile[]>((resolve) => {
        timeout = setTimeout(() => {
          console.warn(
            `[BOTA] ${source.label} agent catalog timed out after ${EXTERNAL_AGENT_SOURCE_TIMEOUT_MS}ms.`,
          );
          resolve([]);
        }, EXTERNAL_AGENT_SOURCE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function uniqueProfiles(profiles: BotaFighterProfile[]) {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    const key = profile.agentId.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildExternalAgentCatalog(limit: number): Promise<ExternalAgentCatalogResult> {
  const perSourceLimit = Math.max(8, Math.ceil(limit / EXTERNAL_SOURCES.length));
  const sourceResults = await Promise.all(
    EXTERNAL_SOURCES.map(async (source) => {
      const liveProfiles = await fetchSourceProfilesWithTimeout(source, perSourceLimit);
      return {
        source,
        liveProfiles,
      };
    }),
  );
  const profiles = uniqueProfiles(
    sourceResults.flatMap((result) => result.liveProfiles),
  ).slice(0, limit);

  return {
    profiles,
    sources: sourceResults.map((result) => ({
      origin: result.source.origin,
      label: result.source.label,
      endpointConfigured: Boolean(sourceEndpointUrl(result.source)),
      liveCount: result.liveProfiles.length,
      seedCount: 0,
    })),
    updatedAt: nowIso(),
  };
}

export async function getExternalAgentCatalogProfiles(input: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(Math.round(input.limit || EXTERNAL_AGENT_CATALOG_TARGET), 240));
  const now = Date.now();
  if (cachedCatalog && cachedCatalog.profiles.length >= limit && now - cachedAt < EXTERNAL_AGENT_CATALOG_TTL_MS) {
    return {
      ...cachedCatalog,
      profiles: cachedCatalog.profiles.slice(0, limit),
    };
  }
  if (!inflightCatalogPromise) {
    inflightCatalogPromise = buildExternalAgentCatalog(limit)
      .then((catalog) => {
        cachedCatalog = catalog;
        cachedAt = Date.now();
        return catalog;
      })
      .finally(() => {
        inflightCatalogPromise = null;
      });
  }
  const catalog = await inflightCatalogPromise;
  return {
    ...catalog,
    profiles: catalog.profiles.slice(0, limit),
  };
}
