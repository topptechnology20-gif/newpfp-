import { randomUUID } from "crypto";
import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import { agents, users } from "@shared/schema";
import { getBantahAgentKitNetworkIdForChainId } from "@shared/agentApi";
import { type BantahBroSystemAgentStatus, bantahBroSystemAgentStatusSchema } from "@shared/bantahBro";
import { db } from "../db";
import { storage } from "../storage";
import { hashPassword } from "../auth";
import { getOnchainServerConfig } from "../onchainConfig";
import {
  DEFAULT_BANTAH_AGENT_SKILLS,
  buildBantahAgentEndpointUrl,
  provisionBantahAgentWallet,
} from "../agentProvisioning";
import {
  BANTAH_ELIZA_DEFAULT_PLUGIN_PACKAGES,
  BANTAH_ELIZA_TELEGRAM_PLUGIN_PACKAGE,
  buildBantahBroElizaCharacter,
  buildBantahElizaRuntimeConfig,
  getBantahBroCharacterProfileVersion,
} from "../elizaAgentBuilder";
import {
  bantahElizaRuntimeConfigSchema,
} from "@shared/elizaAgent";
import type { BantahSkillAction } from "@shared/agentSkill";
import { startManagedBantahAgentRuntime } from "../bantahElizaRuntimeManager";

type StoredSystemAgent = {
  agentId: string;
  ownerId: string;
  agentName: string;
  endpointUrl: string;
  walletProvider: string | null;
  walletAddress: string;
  walletNetworkId: string | null;
  ownerWalletAddress: string | null;
  walletData: unknown;
  runtimeStatus: string | null;
  runtimeConfig?: unknown;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

const BANTAHBRO_SYSTEM_SKILLS: BantahSkillAction[] = [
  ...DEFAULT_BANTAH_AGENT_SKILLS,
  "read_leaderboard",
  "create_p2p_market",
];

function getBantahBroTelegramRuntimeConfig() {
  const token = String(process.env.BANTAHBRO_TELEGRAM_BOT_TOKEN || "").trim();
  const allowedChats = String(process.env.BANTAHBRO_TELEGRAM_ALLOWED_CHATS || "").trim();
  const username = String(process.env.BANTAHBRO_TELEGRAM_BOT_USERNAME || "").trim();

  if (!token) {
    return {
      clients: [] as string[],
      pluginPackages: [] as string[],
      settingsOverrides: {} as Record<string, unknown>,
    };
  }

  return {
    clients: ["telegram"],
    pluginPackages: [BANTAH_ELIZA_TELEGRAM_PLUGIN_PACKAGE],
    settingsOverrides: {
      TELEGRAM_BOT_TOKEN: token,
      ...(allowedChats ? { TELEGRAM_ALLOWED_CHATS: allowedChats } : {}),
      ...(username ? { TELEGRAM_BOT_USERNAME: username } : {}),
    } as Record<string, unknown>,
  };
}

export function isBantahBroElizaTelegramEnabled() {
  const enabledRaw = String(process.env.BANTAHBRO_TELEGRAM_USE_ELIZA_PLUGIN || "true")
    .trim()
    .toLowerCase();
  const hasToken = String(process.env.BANTAHBRO_TELEGRAM_BOT_TOKEN || "").trim().length > 0;
  return hasToken && enabledRaw !== "false";
}

function buildBantahBroPluginPackages(extraPackages: string[]) {
  return [...new Set([...BANTAH_ELIZA_DEFAULT_PLUGIN_PACKAGES, ...extraPackages])]
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasCdpCredentials() {
  return Boolean(
    String(process.env.CDP_API_KEY_ID || "").trim() &&
      String(process.env.CDP_API_KEY_SECRET || "").trim() &&
      String(process.env.CDP_WALLET_SECRET || "").trim(),
  );
}

function requireEnv(name: string) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is required for BantahBro.`);
  }
  return value;
}

function parsePositiveIntegerEnv(name: string): number | null {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getSystemConfig() {
  return {
    username: requireEnv("BANTAHBRO_SYSTEM_USERNAME"),
    email: requireEnv("BANTAHBRO_SYSTEM_EMAIL"),
    agentName: requireEnv("BANTAHBRO_AGENT_NAME"),
  };
}

function assertCdpCredentials() {
  if (!hasCdpCredentials()) {
    throw new Error(
      "CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET are required for BantahBro AgentKit provisioning.",
    );
  }
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildBantahBroRuntimeArtifacts(params: {
  agentId: string;
  agentName: string;
  walletAddress: string;
  chainId: number;
  chainName: string;
  walletNetworkId: string;
  walletProvider: string;
  skillActions: BantahSkillAction[];
  endpointUrl: string;
  walletData?: unknown;
}) {
  const telegramRuntime = getBantahBroTelegramRuntimeConfig();
  const pluginPackages = buildBantahBroPluginPackages(telegramRuntime.pluginPackages);
  const settingsOverrides = { ...telegramRuntime.settingsOverrides };

  if (params.walletProvider === "solana_agent_kit" && params.walletData) {
    const wd = params.walletData as { secretKeyBase58?: string };
    if (wd.secretKeyBase58) {
      pluginPackages.push("@elizaos/plugin-solana");
      settingsOverrides.SOLANA_PRIVATE_KEY = wd.secretKeyBase58;
      settingsOverrides.SOLANA_PUBLIC_KEY = params.walletAddress;
      settingsOverrides.SOLANA_RPC_URL = String(process.env.SOLANA_RPC_URL || "").trim() || "https://api.mainnet-beta.solana.com";
    }
  }

  const character = buildBantahBroElizaCharacter({
    agentId: params.agentId,
    agentName: params.agentName,
    walletAddress: params.walletAddress,
    chainId: params.chainId,
    chainName: params.chainName,
    walletNetworkId: params.walletNetworkId,
    skillActions: [...params.skillActions],
    endpointUrl: params.endpointUrl,
    clients: telegramRuntime.clients,
    pluginPackages,
    settingsOverrides,
  });

  const runtime = buildBantahElizaRuntimeConfig({
    agentId: params.agentId,
    endpointUrl: params.endpointUrl,
    chainId: params.chainId,
    chainName: params.chainName,
    walletAddress: params.walletAddress,
    walletNetworkId: params.walletNetworkId,
    walletProvider: params.walletProvider,
    skillActions: [...params.skillActions],
    character,
    pluginPackages,
  });

  return { character, runtime };
}

function hasBantahBroTelegramPluginConfig(agent: StoredSystemAgent) {
  const token = String(process.env.BANTAHBRO_TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) return true;
  if (!agent.runtimeConfig) return false;

  try {
    const parsed = bantahElizaRuntimeConfigSchema.parse(agent.runtimeConfig);
    const settings = (parsed.character.settings || {}) as Record<string, unknown>;
    return (
      parsed.pluginPackages.includes(BANTAH_ELIZA_TELEGRAM_PLUGIN_PACKAGE) &&
      parsed.character.clients.includes("telegram") &&
      String(settings.TELEGRAM_BOT_TOKEN || "").trim().length > 0 &&
      String(settings.BANTAHBRO_CHARACTER_PROFILE || "").trim() ===
        getBantahBroCharacterProfileVersion()
    );
  } catch {
    return false;
  }
}

async function ensureSystemOwner() {
  const systemConfig = getSystemConfig();
  const existing = await storage.getUserByUsername(systemConfig.username);
  if (existing) return existing;

  return storage.createUser({
    id: nanoid(),
    email: systemConfig.email,
    password: await hashPassword(randomUUID()),
    firstName: "BantahBro",
    lastName: "System",
    username: systemConfig.username,
    level: 1,
    xp: 0,
    points: 0,
    balance: "0.00",
    streak: 0,
    status: "active",
    isAdmin: false,
    isTelegramUser: false,
    coins: 0,
    isShadowPersona: true,
    isAdminGenerated: true,
  });
}

async function getExistingSystemAgent(
  ownerId: string,
  agentName: string,
): Promise<StoredSystemAgent | null> {
  const [agent] = await db
    .select({
      agentId: agents.agentId,
      ownerId: agents.ownerId,
      agentName: agents.agentName,
      endpointUrl: agents.endpointUrl,
      walletProvider: agents.walletProvider,
      walletAddress: agents.walletAddress,
      walletNetworkId: agents.walletNetworkId,
      ownerWalletAddress: agents.ownerWalletAddress,
      walletData: agents.walletData,
      runtimeStatus: agents.runtimeStatus,
      runtimeConfig: agents.runtimeConfig,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.agentName, agentName)))
    .limit(1);

  return agent || null;
}

function resolveWalletHealth(agent: StoredSystemAgent): BantahBroSystemAgentStatus["walletHealth"] {
  if (agent.walletProvider === "cdp_smart_wallet" || agent.walletProvider === "solana_agent_kit") return "live";
  if (agent.walletProvider) return "error";
  return "missing";
}

function resolvePreferredChain() {
  const onchain = getOnchainServerConfig();
  const requestedChainId =
    parsePositiveIntegerEnv("BANTAHBRO_AGENT_CHAIN_ID") ||
    parsePositiveIntegerEnv("BANTAHBRO_DEFAULT_EXECUTION_CHAIN_ID") ||
    onchain.defaultChainId;
  const chainConfig = onchain.chains[String(requestedChainId)];
  if (!chainConfig) {
    throw new Error(
      `BANTAHBRO_AGENT_CHAIN_ID ${requestedChainId} is not enabled in ONCHAIN_ENABLED_CHAINS.`,
    );
  }
  const chainId = Number(chainConfig.chainId);
  const networkId = getBantahAgentKitNetworkIdForChainId(chainId);
  if (!networkId) {
    throw new Error(
      `BantahBro AgentKit provisioning is not configured for chain ${chainId} (${chainConfig.name}). Set BANTAHBRO_AGENT_CHAIN_ID to a supported CDP network or keep this chain for market execution only.`,
    );
  }
  return {
    chainId,
    chainName: chainConfig.name,
    networkId,
  };
}

async function buildSystemAgentStatus(
  ownerUsername: string,
  agent: StoredSystemAgent,
): Promise<BantahBroSystemAgentStatus> {
  return bantahBroSystemAgentStatusSchema.parse({
    ownerUserId: agent.ownerId,
    ownerUsername,
    agentId: agent.agentId,
    agentName: agent.agentName,
    endpointUrl: agent.endpointUrl,
    walletProvider: agent.walletProvider || "missing",
    walletAddress: agent.walletAddress,
    walletNetworkId: agent.walletNetworkId || "missing",
    walletHealth: resolveWalletHealth(agent),
    runtimeStatus: agent.runtimeStatus,
    canCreateMarkets: Boolean(agent.walletAddress),
    createdAt: toIsoString(agent.createdAt),
    updatedAt: toIsoString(agent.updatedAt),
  });
}

export async function ensureBantahBroSystemAgent(options: { preferLiveWallet?: boolean } = {}) {
  const systemConfig = getSystemConfig();
  assertCdpCredentials();
  const owner = await ensureSystemOwner();
  const existing = await getExistingSystemAgent(owner.id, systemConfig.agentName);

  if (existing) {
    if (existing.walletProvider !== "cdp_smart_wallet") {
      return reprovisionBantahBroSystemAgentWallet();
    }
    if (options.preferLiveWallet === false) {
      throw new Error("BantahBro only supports live AgentKit wallets.");
    }
    if (!hasBantahBroTelegramPluginConfig(existing)) {
      const parsedRuntime = existing.runtimeConfig
        ? bantahElizaRuntimeConfigSchema.parse(existing.runtimeConfig)
        : null;
      if (!parsedRuntime) {
        throw new Error("BantahBro system agent runtime config is missing.");
      }
      const rebuilt = buildBantahBroRuntimeArtifacts({
        agentId: existing.agentId,
        agentName: systemConfig.agentName,
        walletAddress: existing.walletAddress,
        chainId: parsedRuntime.chainId,
        chainName: parsedRuntime.chainName,
        walletNetworkId: existing.walletNetworkId || parsedRuntime.walletNetworkId,
        walletProvider: existing.walletProvider || "cdp_smart_wallet",
        skillActions: [...BANTAHBRO_SYSTEM_SKILLS],
        endpointUrl: existing.endpointUrl,
        walletData: existing.walletData,
      });

      await db
        .update(agents)
        .set({
          runtimeStatus: rebuilt.runtime.status,
          skillActions: BANTAHBRO_SYSTEM_SKILLS,
          runtimeConfig: rebuilt.runtime as any,
          updatedAt: new Date(),
        })
        .where(eq(agents.agentId, existing.agentId));

      const refreshed = await getExistingSystemAgent(owner.id, systemConfig.agentName);
      if (refreshed) {
        return buildSystemAgentStatus(owner.username || systemConfig.username, refreshed);
      }
    }
    return buildSystemAgentStatus(owner.username || systemConfig.username, existing);
  }

  const agentId = randomUUID();
  const endpointUrl = buildBantahAgentEndpointUrl(agentId);
  const preferredChain = resolvePreferredChain();
  const wallet = await provisionBantahAgentWallet(agentId, preferredChain.networkId);

  const { runtime } = buildBantahBroRuntimeArtifacts({
    agentId,
    agentName: systemConfig.agentName,
    walletAddress: wallet.walletAddress,
    chainId: preferredChain.chainId,
    chainName: preferredChain.chainName,
    walletNetworkId: wallet.walletNetworkId,
    walletProvider: wallet.walletProvider,
    skillActions: [...BANTAHBRO_SYSTEM_SKILLS],
    endpointUrl,
    walletData: wallet.walletData,
  });

  const created = await storage.createAgent({
    agentId,
    ownerId: owner.id,
    agentName: systemConfig.agentName,
    avatarUrl: null,
    agentType: "bantah_created",
    walletAddress: wallet.walletAddress,
    endpointUrl,
    bantahSkillVersion: "1.0.0",
    specialty: "crypto",
    status: "active",
    skillActions: BANTAHBRO_SYSTEM_SKILLS,
    walletNetworkId: wallet.walletNetworkId,
    walletProvider: wallet.walletProvider,
    ownerWalletAddress: wallet.ownerWalletAddress,
    walletData: wallet.walletData,
    runtimeEngine: runtime.engine,
    runtimeStatus: runtime.status,
    runtimeConfig: runtime,
    isTokenized: false,
    points: 0,
    winCount: 0,
    lossCount: 0,
    marketCount: 0,
  } as any);

  return buildSystemAgentStatus(owner.username || systemConfig.username, {
    agentId: created.agentId,
    ownerId: created.ownerId,
    agentName: created.agentName,
    endpointUrl: created.endpointUrl,
    walletProvider: created.walletProvider,
    walletAddress: created.walletAddress,
    walletNetworkId: created.walletNetworkId,
    ownerWalletAddress: created.ownerWalletAddress,
    walletData: created.walletData,
    runtimeStatus: created.runtimeStatus,
    runtimeConfig: created.runtimeConfig,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  });
}

export async function getBantahBroSystemAgentStatus() {
  const systemConfig = getSystemConfig();
  const owner = await ensureSystemOwner();
  const existing = await getExistingSystemAgent(owner.id, systemConfig.agentName);
  if (!existing) {
    return null;
  }

  return buildSystemAgentStatus(owner.username || systemConfig.username, existing);
}

export async function getBantahBroSystemAgentSnapshot() {
  const owner = await ensureSystemOwner();
  const systemConfig = getSystemConfig();
  const existing = await getExistingSystemAgent(owner.id, systemConfig.agentName);
  if (!existing) {
    throw new Error("BantahBro system agent does not exist yet.");
  }
  if (existing.walletProvider !== "cdp_smart_wallet" && existing.walletProvider !== "solana_agent_kit") {
    throw new Error(
      `BantahBro system agent wallet is invalid for production (${existing.walletProvider || "missing"}). Reprovision with AgentKit or Solana Kit.`,
    );
  }
  return {
    owner,
    agent: existing,
    systemConfig,
  };
}

export async function reprovisionBantahBroSystemAgentWallet() {
  const systemConfig = getSystemConfig();
  assertCdpCredentials();
  const owner = await ensureSystemOwner();
  const existing = await getExistingSystemAgent(owner.id, systemConfig.agentName);
  if (!existing) {
    throw new Error("BantahBro system agent does not exist yet.");
  }

  const preferredChain = resolvePreferredChain();
  const wallet = await provisionBantahAgentWallet(existing.agentId, preferredChain.networkId);

  const { runtime } = buildBantahBroRuntimeArtifacts({
    agentId: existing.agentId,
    agentName: existing.agentName,
    walletAddress: wallet.walletAddress,
    chainId: preferredChain.chainId,
    chainName: preferredChain.chainName,
    walletNetworkId: wallet.walletNetworkId,
    walletProvider: wallet.walletProvider,
    skillActions: [...BANTAHBRO_SYSTEM_SKILLS],
    endpointUrl: existing.endpointUrl,
  });

  const [updated] = await db
    .update(agents)
    .set({
      walletAddress: wallet.walletAddress,
      walletNetworkId: wallet.walletNetworkId,
      walletProvider: wallet.walletProvider,
      ownerWalletAddress: wallet.ownerWalletAddress,
      walletData: wallet.walletData as any,
      runtimeStatus: runtime.status,
      skillActions: BANTAHBRO_SYSTEM_SKILLS,
      runtimeConfig: runtime as any,
      updatedAt: new Date(),
    })
    .where(eq(agents.agentId, existing.agentId))
    .returning();

  return buildSystemAgentStatus(owner.username || systemConfig.username, {
    agentId: updated.agentId,
    ownerId: updated.ownerId,
    agentName: updated.agentName,
    endpointUrl: updated.endpointUrl,
    walletProvider: updated.walletProvider,
    walletAddress: updated.walletAddress,
    walletNetworkId: updated.walletNetworkId,
    ownerWalletAddress: updated.ownerWalletAddress,
    walletData: updated.walletData,
    runtimeStatus: updated.runtimeStatus,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  });
}

export async function ensureBantahBroTelegramRuntimeStarted() {
  const systemAgent = await ensureBantahBroSystemAgent({ preferLiveWallet: true });
  if (!isBantahBroElizaTelegramEnabled()) {
    return { systemAgent, runtime: null };
  }

  const runtime = await startManagedBantahAgentRuntime(systemAgent.agentId);
  return { systemAgent, runtime };
}
