import { isAddress } from "viem";
import type { BotaFighterProfile } from "@shared/botaFighterProfile";

const DEFAULT_BOTA_BASE_URL = "https://bota.bantah.fun";

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

function configuredEnsRootName() {
  return String(
    process.env.BOTA_ENS_FLEET_ROOT_NAME ||
      process.env.BOTA_ENS_AGENT_ROOT_NAME ||
      "",
  )
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
}

function configuredRegistryAddress() {
  return String(
    process.env.BOTA_ENS_AGENT_REGISTRY_ADDRESS ||
      process.env.BOTA_AI_AGENT_REGISTRY_ADDRESS ||
      "",
  ).trim();
}

function configuredRegistryChainId() {
  const parsed = Number(
    process.env.BOTA_ENS_AGENT_REGISTRY_CHAIN_ID ||
      process.env.ONCHAIN_BASE_AGENT_REGISTRY_CHAIN_ID ||
      process.env.ONCHAIN_BASE_CHAIN_ID ||
      8453,
  );
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 8453;
}

function hexByte(value: number) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function minimalChainReferenceHex(chainId: number) {
  const safe = BigInt(Math.max(0, Math.round(chainId)));
  let hex = safe.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return hex || "00";
}

export function encodeErc7930EvmAddress(chainId: number, address: string) {
  if (!isAddress(address)) return null;
  const chainReference = minimalChainReferenceHex(chainId);
  const chainReferenceLength = chainReference.length / 2;
  const cleanAddress = address.toLowerCase().replace(/^0x/, "");
  return `0x00010000${hexByte(chainReferenceLength)}${chainReference}${hexByte(20)}${cleanAddress}`;
}

function safeJson(value: unknown) {
  return JSON.stringify(value);
}

function sanitizeLabel(value: string) {
  const label = value
    .toLowerCase()
    .replace(/\.eth$/i, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 48);
  return label || "fighter";
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function ensNameForProfile(profile: Pick<BotaFighterProfile, "ensName" | "displayName" | "originId">) {
  return String(profile.ensName || profile.originId || profile.displayName || "")
    .trim()
    .toLowerCase();
}

function fighterWebUrl(agentId: string) {
  return `${publicBaseUrl()}/?section=agents&agent=${encodeURIComponent(agentId)}`;
}

function fighterApiUrl(agentId: string) {
  return `${publicBaseUrl()}/api/bantahbro/ens/agents/${encodeURIComponent(agentId)}/context`;
}

function battleDiscoveryUrl(agentId: string) {
  return `${publicBaseUrl()}/api/bantahbro/ens/agents/${encodeURIComponent(agentId)}/battles`;
}

function configuredEndpointUrl(protocol: "a2a" | "mcp", agentId: string) {
  const key = `BOTA_ENS_AGENT_ENDPOINT_${protocol.toUpperCase()}_URL`;
  const value = String(process.env[key] || "").trim();
  if (!value) return null;
  return value.replace(/\{agentId\}/g, encodeURIComponent(agentId));
}

function displayNameFor(input: {
  displayName: string;
  ensName: string;
}) {
  return input.ensName || input.displayName || "ENS Fighter";
}

export type BotaEnsAgentIdentityInput = {
  agentId: string;
  displayName: string;
  ensName: string;
  walletAddress?: string | null;
  resolvedAddress?: string | null;
  avatarUrl?: string | null;
  rank?: number | null;
  wins?: number | null;
  losses?: number | null;
  currentStreak?: number | null;
  bantCreditsEarned?: number | null;
  fameScore?: number | null;
  titles?: string[];
  tags?: string[];
  sourceTextRecords?: Record<string, string | null | undefined>;
  publishedTextRecords?: Record<string, string | null | undefined>;
};

export function buildBotaEnsAgentIdentity(input: BotaEnsAgentIdentityInput) {
  const ensName = String(input.ensName || "").trim().toLowerCase();
  const agentId = String(input.agentId || "").trim();
  const registryAddress = configuredRegistryAddress();
  const registryChainId = configuredRegistryChainId();
  const erc7930RegistryAddress = isAddress(registryAddress)
    ? encodeErc7930EvmAddress(registryChainId, registryAddress)
    : null;
  const verificationKey = erc7930RegistryAddress
    ? `agent-registration[${erc7930RegistryAddress}][${agentId}]`
    : null;
  const rootName = configuredEnsRootName();
  const suggestedSubname = rootName ? `${sanitizeLabel(ensName || input.displayName || agentId)}.${rootName}` : null;
  const profileUrl = fighterWebUrl(agentId);
  const apiUrl = fighterApiUrl(agentId);
  const battleUrl = battleDiscoveryUrl(agentId);
  const a2aEndpointUrl = configuredEndpointUrl("a2a", agentId);
  const mcpEndpointUrl = configuredEndpointUrl("mcp", agentId);
  const sourceTextRecords = input.sourceTextRecords || {};
  const publishedTextRecords = input.publishedTextRecords || {};
  const endpoints: Record<string, string> = {
    web: profileUrl,
    "bota-context": apiUrl,
    "bota-battles": battleUrl,
  };
  if (a2aEndpointUrl) endpoints.a2a = a2aEndpointUrl;
  if (mcpEndpointUrl) endpoints.mcp = mcpEndpointUrl;

  const context = {
    name: displayNameFor({ displayName: input.displayName, ensName }),
    type: "BOTA Arena Fighter",
    ensName,
    agentId,
    platform: "Battle Of The Agents",
    source: "ENS",
    ownerAddress: input.walletAddress || input.resolvedAddress || null,
    avatarUrl: input.avatarUrl || null,
    stats: {
      rank: input.rank || null,
      wins: numberValue(input.wins),
      losses: numberValue(input.losses),
      currentStreak: numberValue(input.currentStreak),
      bantCreditsEarned: numberValue(input.bantCreditsEarned),
      fameScore: numberValue(input.fameScore),
    },
    capabilities: [
      "autonomous-arena-battles",
      "prediction-challenges",
      "leaderboard-reputation",
      "bantcredit-rewards",
    ],
    endpoints,
    titles: input.titles || [],
    tags: Array.from(new Set(["ens", "bota", ...(input.tags || [])])).slice(0, 12),
    standards: verificationKey ? ["ENSIP-25", "ENSIP-26"] : ["ENSIP-26"],
  };

  const textRecords: Record<string, string> = {
    "agent-context": safeJson(context),
    "agent-endpoint[web]": profileUrl,
    "agent-endpoint[bota-context]": apiUrl,
    "agent-endpoint[bota-battles]": battleUrl,
    "com.bota.fighter": safeJson({
      agentId,
      ensName,
      profileUrl,
      battleUrl,
      source: "ENS",
    }),
  };
  if (a2aEndpointUrl) textRecords["agent-endpoint[a2a]"] = a2aEndpointUrl;
  if (mcpEndpointUrl) textRecords["agent-endpoint[mcp]"] = mcpEndpointUrl;
  if (verificationKey) {
    textRecords[verificationKey] = "1";
  }

  const publishedVerificationValue = verificationKey ? publishedTextRecords[verificationKey] || null : null;
  const hasPublishedContext = Boolean(publishedTextRecords["agent-context"]);
  const hasPublishedWebEndpoint = Boolean(publishedTextRecords["agent-endpoint[web]"]);
  const verified = Boolean(verificationKey && publishedVerificationValue);
  const status = verified && hasPublishedContext
    ? "published"
    : verificationKey
      ? "ready_to_publish"
      : "ensip26_ready";

  return {
    standard: verificationKey ? "ENSIP-25/26" : "ENSIP-26",
    status,
    ensName,
    agentId,
    ownerAddress: input.walletAddress || input.resolvedAddress || null,
    resolvedAddress: input.resolvedAddress || null,
    avatarUrl: input.avatarUrl || null,
    subname: {
      rootName: rootName || null,
      suggestedName: suggestedSubname,
      configured: Boolean(rootName),
    },
    registry: {
      chainId: registryChainId,
      address: isAddress(registryAddress) ? registryAddress : null,
      erc7930Address: erc7930RegistryAddress,
      verificationKey,
      verificationValue: verificationKey ? "1" : null,
      publishedValue: publishedVerificationValue,
      verified,
      status: verificationKey ? "configured" : "not_configured",
    },
    textRecords,
    published: {
      "agent-context": publishedTextRecords["agent-context"] || null,
      "agent-endpoint[web]": publishedTextRecords["agent-endpoint[web]"] || null,
      verification: publishedVerificationValue,
      hasPublishedContext,
      hasPublishedWebEndpoint,
    },
    sourceTextRecords: {
      description: sourceTextRecords.description || null,
      url: sourceTextRecords.url || null,
      twitter: sourceTextRecords.twitter || null,
      github: sourceTextRecords.github || null,
    },
    context,
    generatedAt: new Date().toISOString(),
  };
}

export function buildBotaEnsAgentIdentityForProfile(profile: BotaFighterProfile) {
  const metadata = profile.metadata || {};
  const ensIdentity =
    metadata.ensIdentity && typeof metadata.ensIdentity === "object" && !Array.isArray(metadata.ensIdentity)
      ? (metadata.ensIdentity as Record<string, unknown>)
      : {};
  const ensTextRecords =
    ensIdentity.textRecords && typeof ensIdentity.textRecords === "object" && !Array.isArray(ensIdentity.textRecords)
      ? (ensIdentity.textRecords as Record<string, string | null | undefined>)
      : {};
  const existing =
    metadata.ensAgentIdentity &&
    typeof metadata.ensAgentIdentity === "object" &&
    !Array.isArray(metadata.ensAgentIdentity)
      ? (metadata.ensAgentIdentity as { published?: Record<string, string | null | undefined> })
      : {};

  return buildBotaEnsAgentIdentity({
    agentId: profile.agentId,
    displayName: profile.displayName,
    ensName: ensNameForProfile(profile),
    walletAddress: profile.walletAddress,
    resolvedAddress: typeof ensIdentity.resolvedAddress === "string" ? ensIdentity.resolvedAddress : null,
    avatarUrl: profile.avatarUrl,
    rank: profile.rank,
    wins: profile.wins,
    losses: profile.losses,
    currentStreak: profile.currentStreak,
    bantCreditsEarned: profile.bantCreditsEarned,
    fameScore: profile.fameScore,
    titles: profile.titles,
    tags: profile.tags,
    sourceTextRecords: ensTextRecords,
    publishedTextRecords: existing.published || {},
  });
}
