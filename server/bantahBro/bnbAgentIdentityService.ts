import { sql } from "drizzle-orm";
import type { BotaFighterOrigin, BotaFighterProfile } from "@shared/botaFighterProfile";
import { normalizeEvmAddress } from "@shared/onchainConfig";
import { db } from "../db";

const DEFAULT_BOTA_BASE_URL = "https://bota.bantah.fun";
const DEFAULT_BNB_CHAIN_ID = 56;
const BNB_AGENT_SDK_REPO = "https://github.com/bnb-chain/bnbagent-sdk";
const BNB_AGENT_SDK_BLOG =
  "https://www.bnbchain.org/en/blog/bnbagent-sdk-is-now-live-on-bnb-chain-mainnet-the-modular-standard-for-identity-commerce-payment-and-memory-in-ai-agents";

type BnbAgentRegistrationRow = {
  agent_id: string;
  chain_id: number;
  agent_registry_address: string | null;
  bnb_agent_id: string | null;
  metadata_uri: string | null;
  registration_tx_hash: string | null;
  status: string;
  registered_by: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
};

export type BotaBnbAgentIdentityRegistration = {
  agentId: string;
  chainId: number;
  registryAddress: string | null;
  bnbAgentId: string | null;
  metadataUri: string | null;
  registrationTxHash: string | null;
  status: string;
  registeredBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type BotaBnbAgentIdentityInput = {
  agentId: string;
  displayName: string;
  origin: BotaFighterOrigin;
  originId?: string | null;
  ownerAddress?: string | null;
  avatarUrl?: string | null;
  rank?: number | null;
  wins?: number | null;
  losses?: number | null;
  currentStreak?: number | null;
  bantCreditsEarned?: number | null;
  fameScore?: number | null;
  titles?: string[];
  tags?: string[];
  externalUrl?: string | null;
  tokenSymbol?: string | null;
  tokenName?: string | null;
  sourceLabel?: string | null;
};

let ensureBnbAgentIdentityTablePromise: Promise<void> | null = null;

function rowsOf<T = any>(result: any): T[] {
  return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
}

function toIso(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function publicBaseUrl() {
  return String(
    process.env.BOTA_PUBLIC_BASE_URL ||
      process.env.PUBLIC_BASE_URL ||
      process.env.VITE_PUBLIC_BASE_URL ||
      DEFAULT_BOTA_BASE_URL,
  )
    .trim()
    .replace(/\/+$/, "");
}

function configuredBnbChainId() {
  const parsed = Number(
    process.env.BOTA_BNB_AGENT_CHAIN_ID ||
      process.env.BNB_AGENT_CHAIN_ID ||
      process.env.ONCHAIN_BSC_CHAIN_ID ||
      DEFAULT_BNB_CHAIN_ID,
  );
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_BNB_CHAIN_ID;
}

function configuredBnbAgentRegistryAddress() {
  return normalizeEvmAddress(
    process.env.BOTA_BNB_AGENT_REGISTRY_ADDRESS ||
      process.env.BNB_AGENT_REGISTRY_ADDRESS ||
      process.env.BNBAGENT_REGISTRY_ADDRESS ||
      process.env.ONCHAIN_BSC_AGENT_REGISTRY_ADDRESS ||
      null,
  );
}

function configuredEndpointUrl(kind: "a2a" | "mcp" | "commerce", agentId: string) {
  const envKey = `BOTA_BNB_AGENT_ENDPOINT_${kind.toUpperCase()}_URL`;
  const value = String(process.env[envKey] || "").trim();
  if (!value) return null;
  return value.replace(/\{agentId\}/g, encodeURIComponent(agentId));
}

function sourceLabelFor(origin: BotaFighterOrigin) {
  if (origin === "ens") return "ENS";
  if (origin === "virtuals") return "Virtuals Protocol";
  if (origin === "eliza") return "ElizaOS";
  if (origin === "bankr") return "Bankr";
  if (origin === "agentkit") return "AgentKit";
  if (origin === "game-sdk") return "GAME SDK";
  if (origin === "nft") return "NFT";
  if (origin === "token" || origin === "dexscreener") return "Meme";
  if (origin === "bota") return "BOTA";
  return origin.replace(/[-_]/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function sourceLabelFromMetadata(metadata: Record<string, unknown> | undefined | null) {
  const identity =
    metadata?.agentIdentity && typeof metadata.agentIdentity === "object" && !Array.isArray(metadata.agentIdentity)
      ? (metadata.agentIdentity as Record<string, unknown>)
      : null;
  const raw =
    (typeof identity?.sourceLabel === "string" && identity.sourceLabel.trim()) ||
    (typeof identity?.label === "string" && identity.label.trim()) ||
    (typeof metadata?.sourceHint === "string" && metadata.sourceHint.trim()) ||
    (typeof metadata?.importSource === "string" && metadata.importSource.trim()) ||
    (typeof metadata?.importedFrom === "string" && metadata.importedFrom.trim()) ||
    "";
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (normalized.includes("virtual")) return "Virtuals Protocol";
  if (normalized.includes("eliza")) return "ElizaOS";
  if (normalized.includes("bankr")) return "Bankr";
  if (normalized.includes("agentkit") || normalized.includes("agent kit")) return "AgentKit";
  if (normalized.includes("game")) return "GAME SDK";
  if (normalized.includes("ens")) return "ENS";
  return raw;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function normalizeRegistration(row: BnbAgentRegistrationRow): BotaBnbAgentIdentityRegistration {
  return {
    agentId: String(row.agent_id),
    chainId: Number(row.chain_id || DEFAULT_BNB_CHAIN_ID),
    registryAddress: normalizeEvmAddress(row.agent_registry_address) || null,
    bnbAgentId: row.bnb_agent_id ? String(row.bnb_agent_id) : null,
    metadataUri: row.metadata_uri ? String(row.metadata_uri) : null,
    registrationTxHash: row.registration_tx_hash ? String(row.registration_tx_hash) : null,
    status: String(row.status || "ready_to_register"),
    registeredBy: normalizeEvmAddress(row.registered_by) || null,
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function ensureBotaBnbAgentIdentitiesTable() {
  if (!ensureBnbAgentIdentityTablePromise) {
    ensureBnbAgentIdentityTablePromise = db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bota_bnb_agent_identities" (
        "agent_id" varchar(180) PRIMARY KEY NOT NULL,
        "chain_id" integer NOT NULL DEFAULT 56,
        "agent_registry_address" varchar(64),
        "bnb_agent_id" varchar(255),
        "metadata_uri" text,
        "registration_tx_hash" varchar(90),
        "status" varchar(40) NOT NULL DEFAULT 'ready_to_register',
        "registered_by" varchar(128),
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_bota_bnb_agent_identities_status"
        ON "bota_bnb_agent_identities" ("status");
      CREATE INDEX IF NOT EXISTS "idx_bota_bnb_agent_identities_chain"
        ON "bota_bnb_agent_identities" ("chain_id");
    `).then(() => undefined);
  }
  return ensureBnbAgentIdentityTablePromise;
}

export async function getBotaBnbAgentRegistration(agentId: string) {
  await ensureBotaBnbAgentIdentitiesTable();
  const result = await db.execute(sql`
    SELECT *
    FROM "bota_bnb_agent_identities"
    WHERE "agent_id" = ${agentId}
    LIMIT 1;
  `);
  const [row] = rowsOf<BnbAgentRegistrationRow>(result);
  return row ? normalizeRegistration(row) : null;
}

export async function upsertBotaBnbAgentRegistration(params: {
  agentId: string;
  chainId?: number | null;
  registryAddress?: string | null;
  bnbAgentId?: string | null;
  metadataUri?: string | null;
  registrationTxHash?: string | null;
  status?: string | null;
  registeredBy?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  await ensureBotaBnbAgentIdentitiesTable();
  const registryAddress = normalizeEvmAddress(params.registryAddress) || configuredBnbAgentRegistryAddress();
  const registeredBy = normalizeEvmAddress(params.registeredBy) || null;
  const chainId = Number.isInteger(Number(params.chainId)) && Number(params.chainId) > 0
    ? Math.round(Number(params.chainId))
    : configuredBnbChainId();
  const status = String(params.status || (params.registrationTxHash ? "registered" : "ready_to_register"))
    .trim()
    .slice(0, 40);

  const result = await db.execute(sql`
    INSERT INTO "bota_bnb_agent_identities" (
      "agent_id",
      "chain_id",
      "agent_registry_address",
      "bnb_agent_id",
      "metadata_uri",
      "registration_tx_hash",
      "status",
      "registered_by",
      "metadata",
      "updated_at"
    )
    VALUES (
      ${params.agentId},
      ${chainId},
      ${registryAddress},
      ${params.bnbAgentId || null},
      ${params.metadataUri || null},
      ${params.registrationTxHash || null},
      ${status || "ready_to_register"},
      ${registeredBy},
      ${JSON.stringify(params.metadata || {})}::jsonb,
      now()
    )
    ON CONFLICT ("agent_id")
    DO UPDATE SET
      "chain_id" = EXCLUDED."chain_id",
      "agent_registry_address" = COALESCE(EXCLUDED."agent_registry_address", "bota_bnb_agent_identities"."agent_registry_address"),
      "bnb_agent_id" = COALESCE(EXCLUDED."bnb_agent_id", "bota_bnb_agent_identities"."bnb_agent_id"),
      "metadata_uri" = COALESCE(EXCLUDED."metadata_uri", "bota_bnb_agent_identities"."metadata_uri"),
      "registration_tx_hash" = COALESCE(EXCLUDED."registration_tx_hash", "bota_bnb_agent_identities"."registration_tx_hash"),
      "status" = EXCLUDED."status",
      "registered_by" = COALESCE(EXCLUDED."registered_by", "bota_bnb_agent_identities"."registered_by"),
      "metadata" = COALESCE(EXCLUDED."metadata", "bota_bnb_agent_identities"."metadata"),
      "updated_at" = now()
    RETURNING *;
  `);
  const [row] = rowsOf<BnbAgentRegistrationRow>(result);
  return row ? normalizeRegistration(row) : null;
}

export function buildBotaBnbAgentIdentity(
  input: BotaBnbAgentIdentityInput,
  registration?: BotaBnbAgentIdentityRegistration | null,
) {
  const agentId = String(input.agentId || "").trim();
  const chainId = registration?.chainId || configuredBnbChainId();
  const registryAddress = registration?.registryAddress || configuredBnbAgentRegistryAddress();
  const metadataUri = registration?.metadataUri || `${publicBaseUrl()}/api/bantahbro/bnb/agents/${encodeURIComponent(agentId)}/metadata`;
  const profileUrl = `${publicBaseUrl()}/?section=agents&agent=${encodeURIComponent(agentId)}`;
  const statsUrl = `${publicBaseUrl()}/api/bantahbro/fighter-profiles/${encodeURIComponent(agentId)}`;
  const battlesUrl = `${publicBaseUrl()}/api/bantahbro/bnb/agents/${encodeURIComponent(agentId)}/battles`;
  const challengeUrl = `${publicBaseUrl()}/?section=challenges&agent=${encodeURIComponent(agentId)}&chain=bsc`;
  const a2aEndpoint = configuredEndpointUrl("a2a", agentId);
  const mcpEndpoint = configuredEndpointUrl("mcp", agentId);
  const commerceEndpoint = configuredEndpointUrl("commerce", agentId);
  const sourceLabel = input.sourceLabel || sourceLabelFor(input.origin);
  const ownerAddress = normalizeEvmAddress(input.ownerAddress) || null;

  const endpoints: Record<string, string> = {
    web: profileUrl,
    metadata: metadataUri,
    stats: statsUrl,
    battles: battlesUrl,
    challenge: challengeUrl,
  };
  if (a2aEndpoint) endpoints.a2a = a2aEndpoint;
  if (mcpEndpoint) endpoints.mcp = mcpEndpoint;
  if (commerceEndpoint) endpoints.commerce = commerceEndpoint;

  const registered = Boolean(registration?.registrationTxHash || registration?.bnbAgentId);
  const metadata = {
    schema: "bota.bnb-agent.v1",
    name: input.displayName,
    description: `${input.displayName} is a Battle Of The Agents fighter prepared for BNB Chain agent identity and challenge rails.`,
    image: input.avatarUrl || null,
    external_url: profileUrl,
    agent: {
      id: agentId,
      bnbAgentId: registration?.bnbAgentId || null,
      type: "BOTA Arena Fighter",
      platform: "Battle Of The Agents",
      source: sourceLabel,
      sourceOrigin: input.origin,
      originId: input.originId || null,
      ownerAddress,
      tokenSymbol: input.tokenSymbol || null,
      tokenName: input.tokenName || null,
    },
    capabilities: [
      "autonomous-arena-battles",
      "prediction-challenges",
      "leaderboard-reputation",
      "bantcredit-rewards",
      "bnb-chain-agent-identity",
    ],
    endpoints,
    stats: {
      rank: input.rank || null,
      wins: numberValue(input.wins),
      losses: numberValue(input.losses),
      currentStreak: numberValue(input.currentStreak),
      bantCreditsEarned: numberValue(input.bantCreditsEarned),
      fameScore: numberValue(input.fameScore),
    },
    titles: input.titles || [],
    tags: Array.from(new Set(["bota", "bnb-chain", "bnb-agent", input.origin, ...(input.tags || [])])).slice(0, 16),
    standards: {
      identity: ["ERC-8004"],
      commerce: ["ERC-8183-ready"],
      sdk: "BNBAgent SDK",
    },
  };

  return {
    standard: "BNBAgent SDK / ERC-8004",
    status: registered ? "registered" : registryAddress ? "ready_to_register" : "registry_not_configured",
    chain: {
      chainId,
      name: "BNB Smart Chain",
      explorerUrl: "https://bscscan.com",
    },
    registry: {
      chainId,
      address: registryAddress,
      configured: Boolean(registryAddress),
      status: registryAddress ? "configured" : "not_configured",
    },
    registration: registration || {
      agentId,
      chainId,
      registryAddress,
      bnbAgentId: null,
      metadataUri,
      registrationTxHash: null,
      status: "ready_to_register",
      registeredBy: null,
      metadata: {},
      createdAt: null,
      updatedAt: null,
    },
    agentId,
    ownerAddress,
    source: sourceLabel,
    metadataUri,
    endpoints,
    sdk: {
      repository: BNB_AGENT_SDK_REPO,
      announcement: BNB_AGENT_SDK_BLOG,
      notes: [
        "Use ERC-8004 for BNB-native fighter identity registration.",
        "Use ERC-8183 only for paid Challenge Mode jobs or agent commerce flows, not every simulator battle.",
      ],
    },
    metadata,
    generatedAt: new Date().toISOString(),
  };
}

export function buildBotaBnbAgentIdentityForProfile(
  profile: BotaFighterProfile,
  registration?: BotaBnbAgentIdentityRegistration | null,
) {
  return buildBotaBnbAgentIdentity(
    {
      agentId: profile.agentId,
      displayName: profile.displayName,
      origin: profile.origin,
      originId: profile.originId,
      ownerAddress: profile.walletAddress,
      avatarUrl: profile.avatarUrl,
      rank: profile.rank,
      wins: profile.wins,
      losses: profile.losses,
      currentStreak: profile.currentStreak,
      bantCreditsEarned: profile.bantCreditsEarned,
      fameScore: profile.fameScore,
      titles: profile.titles,
      tags: profile.tags,
      externalUrl: profile.externalUrl,
      tokenSymbol: profile.tokenSymbol,
      tokenName: profile.tokenName,
      sourceLabel: sourceLabelFromMetadata(profile.metadata),
    },
    registration,
  );
}
