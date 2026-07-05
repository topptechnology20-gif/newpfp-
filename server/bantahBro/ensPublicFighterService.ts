import type { BotaFighterProfile } from "@shared/botaFighterProfile";
import { sql } from "drizzle-orm";
import { db } from "../db";

const ENS_SUBGRAPH_ID = "5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH";
const ENS_SUBGRAPH_LEGACY_URL = "https://api.thegraph.com/subgraphs/name/ensdomains/ens";
const ENS_SUBGRAPH_GATEWAY_URL = `https://gateway.thegraph.com/api/subgraphs/id/${ENS_SUBGRAPH_ID}`;
const ENS_BADGE_URL = "/assets/ens-badge.jpg";
const ENS_CACHE_TTL_MS = Number(process.env.BOTA_ENS_PUBLIC_CACHE_TTL_MS || 30 * 60 * 1000);
const ENS_REQUEST_TIMEOUT_MS = Number(process.env.BOTA_ENS_SUBGRAPH_TIMEOUT_MS || 8_000);
const ENS_AVATARS = [
  "/2dgame/image/mascots/actions/bantah-avatar-emerald-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-purple-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-red-portrait.png",
  "/2dgame/image/mascots/actions/bantah-avatar-silver-portrait.png",
  "/2dgame/image/mascots/actions/bantah-sword-avatar-portrait.png",
  "/2dgame/image/mascots/actions/bantah-punch-avatar-portrait.png",
] as const;

type EnsRegistrationResponse = {
  data?: {
    registrations?: Array<{
      domain?: {
        name?: string | null;
        labelName?: string | null;
      } | null;
      registrant?: {
        id?: string | null;
      } | null;
      expiryDate?: string | null;
    }>;
  };
  errors?: Array<{ message?: string }>;
};

let cachedEnsProfiles: BotaFighterProfile[] = [];
let cachedEnsProfilesAt = 0;
let inflightEnsProfiles: Promise<BotaFighterProfile[]> | null = null;
let ensureEnsCacheTablePromise: Promise<void> | null = null;

function tableRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function ensureEnsPublicFighterCacheTable() {
  if (!ensureEnsCacheTablePromise) {
    ensureEnsCacheTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bota_ens_public_fighter_cache" (
        "ens_name" varchar(160) PRIMARY KEY NOT NULL,
        "owner_address" varchar(128),
        "expiry_date" varchar(64),
        "profile" jsonb NOT NULL,
        "source" varchar(40) NOT NULL DEFAULT 'ens-subgraph',
        "fetched_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_bota_ens_public_fighter_cache_fetched_at"
        ON "bota_ens_public_fighter_cache" ("fetched_at");
    `).then(() => undefined).catch((error) => {
      ensureEnsCacheTablePromise = null;
      throw error;
    });
  }

  return ensureEnsCacheTablePromise;
}

function stableIndex(seed: string, length: number) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return length > 0 ? hash % length : 0;
}

function normalizeAgentId(value: string) {
  return String(value || "ens-agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180) || "ens-agent";
}

function isEnsFighterProfile(value: unknown): value is BotaFighterProfile {
  const profile = value as BotaFighterProfile | null;
  return Boolean(
    profile &&
      typeof profile === "object" &&
      profile.origin === "ens" &&
      profile.agentId &&
      profile.displayName &&
      isPublicEnsName(profile.ensName || profile.displayName),
  );
}

async function readPersistedEnsProfiles(limit: number) {
  try {
    await ensureEnsPublicFighterCacheTable();
    const result = await db.execute(sql`
      SELECT "profile"
      FROM "bota_ens_public_fighter_cache"
      WHERE "source" = 'ens-subgraph'
      ORDER BY "fetched_at" DESC, "ens_name" ASC
      LIMIT ${limit}
    `);
    return tableRows(result)
      .map((row) => row.profile)
      .filter(isEnsFighterProfile);
  } catch (error) {
    console.warn("[BOTA] Failed to read ENS fighter cache:", error);
    return [];
  }
}

async function persistEnsProfiles(profiles: BotaFighterProfile[]) {
  if (profiles.length === 0) return;
  try {
    await ensureEnsPublicFighterCacheTable();
    for (const profile of profiles) {
      const ensName = String(profile.ensName || profile.displayName || "").toLowerCase();
      if (!isPublicEnsName(ensName)) continue;
      const ensMetadata = (profile.metadata?.ens || {}) as Record<string, unknown>;
      await db.execute(sql`
        INSERT INTO "bota_ens_public_fighter_cache" (
          "ens_name",
          "owner_address",
          "expiry_date",
          "profile",
          "source",
          "fetched_at",
          "updated_at"
        )
        VALUES (
          ${ensName},
          ${profile.walletAddress || null},
          ${typeof ensMetadata.expiryDate === "string" ? ensMetadata.expiryDate : null},
          ${JSON.stringify(profile)}::jsonb,
          'ens-subgraph',
          now(),
          now()
        )
        ON CONFLICT ("ens_name") DO UPDATE SET
          "owner_address" = EXCLUDED."owner_address",
          "expiry_date" = EXCLUDED."expiry_date",
          "profile" = EXCLUDED."profile",
          "source" = EXCLUDED."source",
          "fetched_at" = EXCLUDED."fetched_at",
          "updated_at" = now()
      `);
    }
  } catch (error) {
    console.warn("[BOTA] Failed to persist ENS fighter cache:", error);
  }
}

function configuredGraphApiKey() {
  return String(
    process.env.THE_GRAPH_API_KEY ||
      process.env.GRAPH_API_KEY ||
      process.env.ENS_SUBGRAPH_API_KEY ||
      process.env.BOTA_ENS_SUBGRAPH_API_KEY ||
      "",
  ).trim();
}

function ensSubgraphEndpoints() {
  const configuredUrl = String(
    process.env.ENS_SUBGRAPH_URL ||
      process.env.BOTA_ENS_SUBGRAPH_URL ||
      "",
  ).trim();
  const apiKey = configuredGraphApiKey();
  const endpoints: Array<{ url: string; headers: Record<string, string> }> = [];

  if (configuredUrl) {
    endpoints.push({
      url: configuredUrl,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    });
  }
  if (apiKey) {
    endpoints.push({
      url: ENS_SUBGRAPH_GATEWAY_URL,
      headers: { authorization: `Bearer ${apiKey}` },
    });
  }
  endpoints.push({ url: ENS_SUBGRAPH_LEGACY_URL, headers: {} });

  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key = `${endpoint.url}:${endpoint.headers.authorization || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function postEnsSubgraph<T>(query: string, variables: Record<string, unknown>) {
  let lastError: Error | null = null;
  for (const endpoint of ensSubgraphEndpoints()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ENS_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...endpoint.headers,
        },
        body: JSON.stringify({ query, variables }),
      });
      const payload = (await response.json()) as T & { errors?: Array<{ message?: string }> };
      if (!response.ok || payload.errors?.length) {
        const detail = payload.errors?.map((error) => error.message).filter(Boolean).join("; ");
        throw new Error(detail || `ENS subgraph returned ${response.status}`);
      }
      return payload;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("ENS subgraph request failed");
}

function isPublicEnsName(value: unknown): value is string {
  const name = String(value || "").trim().toLowerCase();
  if (!name.endsWith(".eth")) return false;
  if (name.startsWith("[") || name.includes("[")) return false;
  const parts = name.split(".");
  if (parts.length !== 2) return false;
  const label = parts[0];
  if (label.length < 3 || label.length > 64) return false;
  return /^[a-z0-9-]+$/.test(label);
}

function scoreForEns(name: string, index: number) {
  return Math.max(42, Math.min(99, 99 - index + stableIndex(name, 16)));
}

function profileFromEnsRegistration(input: {
  name: string;
  owner: string | null;
  expiryDate: string | null;
  index: number;
}): BotaFighterProfile {
  const score = scoreForEns(input.name, input.index);
  const rank = input.index + 1;
  const avatarUrl = ENS_AVATARS[stableIndex(input.name, ENS_AVATARS.length)];
  const now = new Date().toISOString();

  return {
    agentId: normalizeAgentId(`ens:${input.name}`),
    displayName: input.name,
    origin: "ens",
    originId: input.name,
    agentClass: input.index % 3 === 0 ? "oracle" : input.index % 3 === 1 ? "scout" : "striker",
    archetype: input.index % 2 === 0 ? "oracle_duelist" : "signal_striker",
    league: rank <= 12 ? "ENS Elite League" : rank <= 32 ? "ENS Pro League" : "ENS Open League",
    rank,
    avatarUrl,
    badgeLabel: "ENS",
    ensName: input.name,
    walletAddress: input.owner,
    externalUrl: `https://app.ens.domains/${input.name}`,
    tokenSymbol: null,
    tokenName: input.name,
    chainId: "ethereum",
    wins: 0,
    losses: 0,
    currentStreak: 0,
    fameScore: score,
    watchers: 900 + stableIndex(`${input.name}:watchers`, 5800),
    challengeVolume: 4 + stableIndex(`${input.name}:challenges`, 44),
    bantCreditsEarned: 0,
    liveSpectators: 0,
    titles: [rank <= 12 ? "ENS Elite Fighter" : "ENS Public Fighter"],
    tags: ["ens", "ethereum", "subgraph", "public-ens"],
    lastBattleId: null,
    metadata: {
      importSource: "ens-subgraph",
      sourceHint: "ens-subgraph",
      sourceIconUrl: ENS_BADGE_URL,
      originIconUrl: ENS_BADGE_URL,
      ens: {
        name: input.name,
        owner: input.owner,
        expiryDate: input.expiryDate,
        source: "ENS Subgraph",
      },
      adapter: {
        status: "ready",
        pipeline: ["ens-subgraph", "fighter-created", "adapter-ready"],
      },
    },
    importedAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

async function fetchEnsProfilesFromSubgraph(limit: number) {
  const requested = Math.max(2, Math.min(Math.round(limit || 50), 120));
  const query = `
    query PublicEnsRegistrations($first: Int!, $skip: Int!, $now: BigInt!) {
      registrations(
        first: $first
        skip: $skip
        orderBy: expiryDate
        orderDirection: desc
        where: { expiryDate_gt: $now }
      ) {
        domain {
          name
          labelName
        }
        registrant {
          id
        }
        expiryDate
      }
    }
  `;
  const nowSeconds = Math.floor(Date.now() / 1000).toString();
  const names = new Map<string, { owner: string | null; expiryDate: string | null }>();
  let skip = 0;

  while (names.size < requested && skip < 800) {
    const payload = await postEnsSubgraph<EnsRegistrationResponse>(query, {
      first: Math.min(100, requested * 2),
      skip,
      now: nowSeconds,
    });
    const registrations = payload.data?.registrations || [];
    if (!registrations.length) break;

    for (const registration of registrations) {
      const name = String(registration.domain?.name || "").trim().toLowerCase();
      if (!isPublicEnsName(name) || names.has(name)) continue;
      names.set(name, {
        owner: registration.registrant?.id?.toLowerCase() || null,
        expiryDate: registration.expiryDate || null,
      });
      if (names.size >= requested) break;
    }
    skip += registrations.length;
  }

  return Array.from(names.entries()).map(([name, registration], index) =>
    profileFromEnsRegistration({
      name,
      owner: registration.owner,
      expiryDate: registration.expiryDate,
      index,
    }),
  );
}

export async function getPublicEnsFighterProfiles(limit = 50) {
  const requested = Math.max(2, Math.min(Math.round(limit || 50), 120));
  const now = Date.now();
  if (cachedEnsProfiles.length >= requested && now - cachedEnsProfilesAt < ENS_CACHE_TTL_MS) {
    return cachedEnsProfiles.slice(0, requested);
  }
  if (inflightEnsProfiles) {
    const profiles = await inflightEnsProfiles;
    return profiles.slice(0, requested);
  }

  inflightEnsProfiles = fetchEnsProfilesFromSubgraph(requested)
    .then(async (profiles) => {
      if (profiles.length > 0) {
        cachedEnsProfiles = profiles;
        cachedEnsProfilesAt = Date.now();
        await persistEnsProfiles(profiles);
      }
      return profiles;
    })
    .catch(async (error) => {
      if (cachedEnsProfiles.length > 0) return cachedEnsProfiles;
      const persisted = await readPersistedEnsProfiles(requested);
      if (persisted.length > 0) {
        cachedEnsProfiles = persisted;
        cachedEnsProfilesAt = Date.now();
        return persisted;
      }
      throw error;
    })
    .finally(() => {
      inflightEnsProfiles = null;
    });

  const profiles = await inflightEnsProfiles;
  return profiles.slice(0, requested);
}
