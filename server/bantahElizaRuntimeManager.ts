import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  AgentRuntime,
  ChannelType,
  ModelType,
  asUUID,
  composePromptFromState,
  createMessageMemory,
  createUniqueUuid,
  parseKeyValueXml,
  messageHandlerTemplate,
  type Content,
  type HandlerCallback,
  type Memory,
  type State,
} from "@elizaos/core";
import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";
import { openrouterPlugin } from "@elizaos/plugin-openrouter";
import telegramPlugin from "@elizaos/plugin-telegram";
import { agents } from "@shared/schema";
import {
  bantahElizaRuntimeConfigSchema,
  type BantahElizaRuntimeConfig,
} from "@shared/elizaAgent";
import {
  type AgentActionEnvelope,
  type SkillErrorResponse,
  type SkillSuccessEnvelope,
} from "@shared/agentSkill";
import { db } from "./db";
import { storage } from "./storage";
import { createBantahElizaSkillsPlugin } from "./bantahElizaSkillsPlugin";
import { BantahElizaRuntimeMemoryAdapter } from "./bantahElizaRuntimeMemoryAdapter";
import { buildSkillErrorEnvelope } from "./agentProvisioning";
import { bantahOpenRouterEmbeddingsPlugin } from "./bantahOpenRouterEmbeddingsPlugin";
import { bantahBroTelegramBannerPlugin } from "./bantahBroTelegramBannerPlugin";
import { bantahBroLiveMarketPlugin } from "./bantahBroLiveMarketPlugin";
import { bantahBroTelegramCommandsPlugin } from "./bantahBroTelegramCommandsPlugin";
import { bantahBroKnowledgePlugin } from "./bantahBroKnowledgePlugin";

const LOCAL_AGENT_ENV_PATH = path.resolve(
  process.cwd(),
  "../Agent/typescript/examples/vercel-ai-sdk-smart-wallet-chatbot/.env",
);
type ManagedRuntimeEntry = {
  agentId: string;
  runtime: AgentRuntime;
  config: BantahElizaRuntimeConfig;
  startedAt: string;
};

const managedRuntimes = new Map<string, ManagedRuntimeEntry>();
const managedWebChatRuntimes = new Map<string, ManagedRuntimeEntry>();
let shutdownHooksRegistered = false;

function ensureElizaEnvFallback() {
  if (process.env.OPENROUTER_API_KEY?.trim()) return;
  if (!fs.existsSync(LOCAL_AGENT_ENV_PATH)) return;

  dotenv.config({
    path: LOCAL_AGENT_ENV_PATH,
    override: false,
  });

  const openAiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!process.env.OPENROUTER_API_KEY?.trim() && openAiKey.startsWith("sk-or-")) {
    process.env.OPENROUTER_API_KEY = openAiKey;
  }
}

function ensureRuntimeEnv() {
  ensureElizaEnvFallback();

  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error(
      "OPENROUTER_API_KEY is required to start Bantah Eliza runtimes.",
    );
  }
}

function withRuntimeStatus(
  config: BantahElizaRuntimeConfig,
  status: BantahElizaRuntimeConfig["status"],
): BantahElizaRuntimeConfig {
  return {
    ...config,
    status,
    updatedAt: new Date().toISOString(),
  };
}

function isLocalDevRuntime() {
  return process.env.npm_lifecycle_event === "dev" || process.env.NODE_ENV !== "production";
}

function shouldDisableManagedTelegramPlugin(config: BantahElizaRuntimeConfig) {
  if (!isLocalDevRuntime()) {
    return false;
  }

  const bantahBroAgentName = String(process.env.BANTAHBRO_AGENT_NAME || "BantahBro").trim();
  return config.character.name === bantahBroAgentName;
}

function buildBantahBroTelegramMessageHandlerTemplate(baseTemplate?: unknown) {
  const base =
    typeof baseTemplate === "string" && baseTemplate.trim()
      ? baseTemplate
      : messageHandlerTemplate;

  return `${base}

<bantahbro_live_market_rules>
- If the user asks for a current coin or token price, including phrases like "price of", "how much is", "what is btc at", or "<token> price", you MUST include LOOKUP_LIVE_MARKET in actions.
- Never answer a live price question from memory.
- If you include REPLY before LOOKUP_LIVE_MARKET, the REPLY text must only acknowledge that you are checking the live market now. Do not include any guessed or stale price number in that first reply.
- After LOOKUP_LIVE_MARKET runs, use the returned live market result as the actual answer.
</bantahbro_live_market_rules>`;
}

async function persistRuntimeState(
  agentId: string,
  config: BantahElizaRuntimeConfig,
) {
  await db
    .update(agents)
    .set({
      runtimeEngine: config.engine,
      runtimeStatus: config.status,
      runtimeConfig: config,
      updatedAt: new Date(),
    })
    .where(eq(agents.agentId, agentId));
}

function buildRuntimeCharacter(config: BantahElizaRuntimeConfig) {
  const isBantahBro =
    config.character.name === String(process.env.BANTAHBRO_AGENT_NAME || "BantahBro").trim();
  const existingTemplates = ((config.character as any).templates || {}) as Record<string, unknown>;
  const existingMessageExamples = Array.isArray(config.character.messageExamples)
    ? config.character.messageExamples
    : [];
  const bantahBroMessageExamples = isBantahBro
    ? [
        [
          {
            user: "{{user1}}",
            content: {
              text: "price of bitcoin",
            },
          },
          {
            user: config.character.name,
            content: {
              text: "Checking the live BTC market now.",
              actions: ["REPLY", "LOOKUP_LIVE_MARKET"],
            },
          },
        ],
        [
          {
            user: "{{user1}}",
            content: {
              text: "how much is eth on base",
            },
          },
          {
            user: config.character.name,
            content: {
              text: "Pulling the live ETH/Base market before I answer.",
              actions: ["REPLY", "LOOKUP_LIVE_MARKET"],
            },
          },
        ],
      ]
    : [];

  return {
    ...config.character,
    system: [
      config.character.system,
      isBantahBro
        ? "For live token or coin price questions, never answer from memory. Use the live market provider context when available. If live market context is unavailable, explicitly say you could not verify the current price."
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    messageExamples: [...existingMessageExamples, ...bantahBroMessageExamples],
    templates: {
      ...existingTemplates,
      ...(isBantahBro
        ? {
            telegramMessageHandlerTemplate:
              buildBantahBroTelegramMessageHandlerTemplate(
                existingTemplates.telegramMessageHandlerTemplate,
              ),
          }
        : {}),
    },
    settings: {
      ...config.character.settings,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    },
  };
}

function resolveManagedRuntimePlugins(
  config: BantahElizaRuntimeConfig,
  options: { disableTelegramPlugin?: boolean } = {},
) {
  const configured = new Set(
    (config.pluginPackages || []).map((entry) => String(entry || "").trim()).filter(Boolean),
  );
  const isBantahBro =
    config.character.name === String(process.env.BANTAHBRO_AGENT_NAME || "BantahBro").trim();

  const plugins = [];

  if (
    configured.size === 0 ||
    configured.has("@elizaos/plugin-bootstrap")
  ) {
    plugins.push(bootstrapPlugin);
  }

  if (
    configured.size === 0 ||
    configured.has("@elizaos/plugin-openrouter")
  ) {
    plugins.push(openrouterPlugin);
    plugins.push(bantahOpenRouterEmbeddingsPlugin);
  }

  if (isBantahBro) {
    plugins.push(bantahBroLiveMarketPlugin);
    plugins.push(bantahBroKnowledgePlugin);
  }

  if (
    !options.disableTelegramPlugin &&
    (configured.has("@elizaos/plugin-telegram") ||
      (config.character.clients || []).includes("telegram"))
  ) {
    plugins.push(telegramPlugin);
    if (isBantahBro) {
      plugins.push(bantahBroTelegramCommandsPlugin);
      plugins.push(bantahBroTelegramBannerPlugin);
    }
  }

  plugins.push(createBantahElizaSkillsPlugin(config.skillActions));
  return plugins;
}

function ensureShutdownHooks() {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  const shutdown = async () => {
    await stopAllManagedBantahAgentRuntimes({ persist: true });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export function getManagedBantahAgentRuntime(agentId: string) {
  return managedRuntimes.get(agentId) || null;
}

export function listManagedBantahAgentRuntimes() {
  return Array.from(managedRuntimes.values()).map((entry) => ({
    agentId: entry.agentId,
    startedAt: entry.startedAt,
    runtimeStatus: entry.config.status,
    runtimeEngine: entry.config.engine,
    chainId: entry.config.chainId,
    chainName: entry.config.chainName,
    walletAddress: entry.config.walletAddress,
    walletNetworkId: entry.config.walletNetworkId,
  }));
}

export async function startManagedBantahAgentRuntime(
  agentId: string,
): Promise<BantahElizaRuntimeConfig> {
  ensureRuntimeEnv();
  ensureShutdownHooks();

  const existing = managedRuntimes.get(agentId);
  if (existing) {
    return existing.config;
  }

  const storedAgent = await storage.getAgentById(agentId);
  if (!storedAgent) {
    throw new Error(`Bantah agent ${agentId} not found.`);
  }
  if (storedAgent.agentType !== "bantah_created") {
    throw new Error("Only Bantah-created agents can start a managed Eliza runtime.");
  }
  if (!storedAgent.runtimeConfig) {
    throw new Error("This Bantah agent does not have Eliza runtime metadata.");
  }

  const parsedConfig = bantahElizaRuntimeConfigSchema.parse(storedAgent.runtimeConfig);
  const startingConfig = withRuntimeStatus(parsedConfig, "starting");
  await persistRuntimeState(agentId, startingConfig);

  try {
    const runtime = new AgentRuntime({
      character: buildRuntimeCharacter(startingConfig) as any,
      plugins: resolveManagedRuntimePlugins(startingConfig, {
        disableTelegramPlugin: shouldDisableManagedTelegramPlugin(startingConfig),
      }),
    });
    runtime.registerDatabaseAdapter(new BantahElizaRuntimeMemoryAdapter() as any);
    await runtime.initialize();

    const activeConfig = withRuntimeStatus(startingConfig, "active");
    managedRuntimes.set(agentId, {
      agentId,
      runtime,
      config: activeConfig,
      startedAt: new Date().toISOString(),
    });
    await persistRuntimeState(agentId, activeConfig);

    return activeConfig;
  } catch (error: any) {
    const errorConfig = withRuntimeStatus(startingConfig, "error");
    await persistRuntimeState(agentId, errorConfig);
    throw new Error(error?.message || "Failed to start Bantah Eliza runtime.");
  }
}

async function startManagedBantahAgentWebChatRuntime(
  agentId: string,
): Promise<BantahElizaRuntimeConfig> {
  ensureRuntimeEnv();
  ensureShutdownHooks();

  const existing = managedWebChatRuntimes.get(agentId);
  if (existing) {
    return existing.config;
  }

  const storedAgent = await storage.getAgentById(agentId);
  if (!storedAgent) {
    throw new Error(`Bantah agent ${agentId} not found.`);
  }
  if (storedAgent.agentType !== "bantah_created") {
    throw new Error("Only Bantah-created agents can start a managed Eliza runtime.");
  }
  if (!storedAgent.runtimeConfig) {
    throw new Error("This Bantah agent does not have Eliza runtime metadata.");
  }

  const parsedConfig = bantahElizaRuntimeConfigSchema.parse(storedAgent.runtimeConfig);
  const webConfig: BantahElizaRuntimeConfig = {
    ...parsedConfig,
    status: "active",
    updatedAt: new Date().toISOString(),
    pluginPackages: parsedConfig.pluginPackages.filter(
      (pluginPackage) => pluginPackage !== "@elizaos/plugin-telegram",
    ),
    character: {
      ...parsedConfig.character,
      clients: parsedConfig.character.clients.filter((client) => client !== "telegram"),
    },
  };

  const runtime = new AgentRuntime({
    character: buildRuntimeCharacter(webConfig) as any,
    plugins: resolveManagedRuntimePlugins(webConfig, { disableTelegramPlugin: true }),
  });
  runtime.registerDatabaseAdapter(new BantahElizaRuntimeMemoryAdapter() as any);
  await runtime.initialize();

  managedWebChatRuntimes.set(agentId, {
    agentId,
    runtime,
    config: webConfig,
    startedAt: new Date().toISOString(),
  });

  return webConfig;
}

export async function stopManagedBantahAgentRuntime(
  agentId: string,
  options: { persist?: boolean } = {},
) {
  const entry = managedRuntimes.get(agentId);
  if (!entry) {
    if (options.persist !== false) {
      const storedAgent = await storage.getAgentById(agentId);
      if (storedAgent?.runtimeConfig) {
        const parsedConfig = bantahElizaRuntimeConfigSchema.parse(storedAgent.runtimeConfig);
        const inactiveConfig = withRuntimeStatus(parsedConfig, "inactive");
        await persistRuntimeState(agentId, inactiveConfig);
      }
    }
    return false;
  }

  managedRuntimes.delete(agentId);

  try {
    await entry.runtime.stop();
  } finally {
    if (options.persist !== false) {
      const inactiveConfig = withRuntimeStatus(entry.config, "inactive");
      await persistRuntimeState(agentId, inactiveConfig);
    }
  }

  return true;
}

export async function restartManagedBantahAgentRuntime(
  agentId: string,
): Promise<BantahElizaRuntimeConfig> {
  if (managedRuntimes.has(agentId)) {
    await stopManagedBantahAgentRuntime(agentId, { persist: false });
  }

  return startManagedBantahAgentRuntime(agentId);
}

export async function stopAllManagedBantahAgentRuntimes(
  options: { persist?: boolean } = {},
) {
  const agentIds = Array.from(managedRuntimes.keys());
  await Promise.allSettled(
    agentIds.map((agentId) => stopManagedBantahAgentRuntime(agentId, options)),
  );
  const webEntries = Array.from(managedWebChatRuntimes.values());
  managedWebChatRuntimes.clear();
  await Promise.allSettled(webEntries.map((entry) => entry.runtime.stop()));
}

export async function restoreManagedBantahAgentRuntimes() {
  ensureRuntimeEnv();
  ensureShutdownHooks();

  const rows = await db
    .select({
      agentId: agents.agentId,
    })
    .from(agents)
    .where(
      and(
        eq(agents.agentType, "bantah_created"),
        eq(agents.status, "active"),
        eq(agents.runtimeEngine, "elizaos"),
        isNotNull(agents.runtimeConfig),
      ),
    );

  const results = await Promise.allSettled(
    rows.map((row) => startManagedBantahAgentRuntime(row.agentId)),
  );

  return {
    attempted: rows.length,
    started: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
  };
}

export async function executeManagedBantahAgentRuntimeAction(
  agentId: string,
  envelope: AgentActionEnvelope,
): Promise<{
  status: number;
  envelope: SkillSuccessEnvelope | SkillErrorResponse;
}> {
  const entry =
    managedRuntimes.get(agentId) ||
    managedWebChatRuntimes.get(agentId) ||
    (await startManagedBantahAgentWebChatRuntime(agentId).then(
      () => managedWebChatRuntimes.get(agentId) || null,
    ));

  if (!entry) {
    return {
      status: 500,
      envelope: buildSkillErrorEnvelope(
        envelope.requestId,
        "internal_error",
        "Managed Bantah Eliza runtime is unavailable.",
      ),
    };
  }

  const action = entry.runtime.actions.find((candidate) => candidate.name === envelope.action);
  if (!action) {
    return {
      status: 501,
      envelope: buildSkillErrorEnvelope(
        envelope.requestId,
        "unsupported_action",
        `Action ${envelope.action} is not registered on this Bantah Eliza runtime.`,
      ),
    };
  }

  const message = createMessageMemory({
    entityId: asUUID(agentId),
    agentId: asUUID(agentId),
    roomId: asUUID(agentId),
    content: {
      text: JSON.stringify(envelope.payload ?? {}),
      source: "bantah_runtime",
      actions: [envelope.action],
      requestId: envelope.requestId,
      timestamp: envelope.timestamp ?? new Date().toISOString(),
    },
  });
  const state: State = {
    values: {
      bantahAgentId: agentId,
      bantahRequestId: envelope.requestId,
      bantahAction: envelope.action,
    },
    data: {
      payload: envelope.payload,
    },
    text: JSON.stringify(envelope.payload ?? {}),
  };

  const isValid = await action.validate(entry.runtime, message, state);
  if (!isValid) {
    return {
      status: 501,
      envelope: buildSkillErrorEnvelope(
        envelope.requestId,
        "unsupported_action",
        `Action ${envelope.action} is not enabled for this Bantah Eliza runtime.`,
      ),
    };
  }

  const actionResult = await action.handler(entry.runtime, message, state, {
    requestId: envelope.requestId,
    payload: envelope.payload,
    action: envelope.action,
    skillVersion: envelope.skillVersion,
  });
  const actionData =
    actionResult && typeof actionResult === "object" && actionResult.data && typeof actionResult.data === "object"
      ? (actionResult.data as Record<string, unknown>)
      : null;
  const status =
    typeof actionData?.status === "number" && Number.isInteger(actionData.status)
      ? actionData.status
      : actionResult?.success === false
        ? 500
        : 200;
  const runtimeEnvelope = actionData?.envelope;

  if (
    runtimeEnvelope &&
    typeof runtimeEnvelope === "object" &&
    typeof (runtimeEnvelope as Record<string, unknown>).requestId === "string"
  ) {
    return {
      status,
      envelope: runtimeEnvelope as SkillSuccessEnvelope | SkillErrorResponse,
    };
  }

  return {
    status: 500,
    envelope: buildSkillErrorEnvelope(
      envelope.requestId,
      "internal_error",
      `Eliza runtime did not return a valid Bantah envelope for ${envelope.action}.`,
    ),
  };
}

function normalizeRuntimeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function getRuntimeContentText(content: unknown) {
  if (!content || typeof content !== "object") return "";
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text.trim() : "";
}

export async function sendManagedBantahAgentRuntimeMessage(
  agentId: string,
  params: {
    text: string;
    sessionId?: string;
    userId?: string;
    userName?: string;
    tool?: string;
    source?: "web" | "twitter";
    context?: string;
  },
): Promise<{
  text: string;
  actions: string[];
  providers: string[];
  agentId: string;
  roomId: string;
}> {
  const source = params.source || "web";
  const entry =
    source === "twitter" || source === "web"
      ? managedWebChatRuntimes.get(agentId) ||
        (await startManagedBantahAgentWebChatRuntime(agentId).then(
          () => managedWebChatRuntimes.get(agentId) || null,
        ))
      : managedRuntimes.get(agentId) ||
        (await startManagedBantahAgentRuntime(agentId).then(
          () => managedRuntimes.get(agentId) || null,
        ));

  if (!entry) {
    throw new Error("Managed Bantah Eliza runtime is unavailable.");
  }

  const userText = params.text.trim();
  if (!userText) {
    throw new Error("Message cannot be empty.");
  }

  const runtime = entry.runtime;
  const sessionId = String(params.sessionId || "default").slice(0, 96);
  const userId = String(params.userId || `${source}-user-${sessionId}`).slice(0, 96);
  const userName = String(
    params.userName || (source === "twitter" ? "Twitter User" : "BantahBro Web User"),
  ).slice(0, 80);
  const serverId = `bantahbro-${source}:${agentId}`;
  const channelId = `bantahbro-${source}:${sessionId}`;
  const worldId = createUniqueUuid(runtime, serverId);
  const roomId = createUniqueUuid(runtime, channelId);
  const entityId = createUniqueUuid(runtime, userId);

  await runtime.ensureConnection({
    entityId,
    roomId,
    name: userName,
    userName,
    source,
    channelId,
    serverId,
    type: ChannelType.DM,
    worldId,
  });

  const message = createMessageMemory({
    id: createUniqueUuid(runtime, `${channelId}:message:${Date.now()}:${Math.random()}`),
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: userText,
      source,
      tool: params.tool || "assistant",
      timestamp: new Date().toISOString(),
    },
  });

  try {
    await Promise.all([
      runtime.addEmbeddingToMemory(message),
      runtime.createMemory(message, "messages"),
    ]);
  } catch {
    await runtime.createMemory(message, "messages").catch(() => undefined);
  }

  let state = await runtime.composeState(message, ["ACTIONS", "CHARACTER", "RECENT_MESSAGES"]);
  const baseTemplate =
    source === "twitter" && typeof runtime.character.templates?.twitterMessageHandlerTemplate === "string"
      ? runtime.character.templates.twitterMessageHandlerTemplate
      : typeof runtime.character.templates?.telegramMessageHandlerTemplate === "string"
      ? runtime.character.templates.telegramMessageHandlerTemplate
      : typeof runtime.character.templates?.messageHandlerTemplate === "string"
        ? runtime.character.templates.messageHandlerTemplate
        : messageHandlerTemplate;
  const sourceContext =
    source === "twitter"
      ? `<bantahbro_twitter_runtime_context>
- This request came from X/Twitter.
- Reply as BantahBro in a public-facing tweet style.
- Keep the final response under 240 characters unless explicitly drafting a thread.
- If the tweet asks for live token, market, rug-score, runner-score, alerts, BXBT, or battle data, use available actions/providers instead of guessing.
- Do not claim you performed external Twitter actions. The transport layer handles posting after this response.
${params.context ? `- Extra context: ${params.context}` : ""}
</bantahbro_twitter_runtime_context>`
      : `<bantahbro_web_chat_context>
- This request came from the BantahBro web /chat page, not Telegram.
- Tool tab: ${params.tool || "assistant"}.
- Answer the user directly in the same BantahBro agent voice you use on Telegram.
- For live price, token, market, rug-score, runner-score, alerts, BXBT, or Bantah market questions, use available actions/providers instead of guessing.
${params.context ? `- Extra context: ${params.context}` : ""}
</bantahbro_web_chat_context>`;
  const template = `${baseTemplate}

${sourceContext}`;

  const prompt = composePromptFromState({
    state,
    template,
  });

  let responseContent: (Content & { providers?: string[]; thought?: string; simple?: boolean }) | null = null;
  for (let attempt = 0; attempt < 3 && (!responseContent?.thought || !responseContent?.actions); attempt++) {
    const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const parsed = parseKeyValueXml(String(response || "")) as Record<string, unknown> | null;
    if (!parsed) continue;

    responseContent = {
      thought: typeof parsed.thought === "string" ? parsed.thought : "",
      actions: normalizeRuntimeList(parsed.actions).length
        ? normalizeRuntimeList(parsed.actions)
        : ["REPLY"],
      providers: normalizeRuntimeList(parsed.providers),
      text: typeof parsed.text === "string" ? parsed.text : "",
      simple: parsed.simple === true,
    };
  }

  if (!responseContent || !responseContent.actions?.length) {
    throw new Error("BantahBro runtime did not return a valid response.");
  }

  const responseMemory = createMessageMemory({
    id: createUniqueUuid(runtime, `${channelId}:response:${Date.now()}:${Math.random()}`),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId,
    content: responseContent,
  });
  const callbackTexts: string[] = [];
  const callbackMemories: Memory[] = [];
  const callback: HandlerCallback = async (content) => {
    const memory = createMessageMemory({
      id: createUniqueUuid(runtime, `${channelId}:callback:${Date.now()}:${Math.random()}`),
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: {
        ...content,
        source,
      },
    });

    const text = getRuntimeContentText(content);
    if (text) callbackTexts.push(text);
    callbackMemories.push(memory);
    await runtime.createMemory(memory, "messages").catch(() => undefined);
    return [memory];
  };

  if (responseContent.providers?.length) {
    state = await runtime.composeState(message, responseContent.providers);
  }

  const isSimpleReply =
    responseContent.actions.length === 1 &&
    responseContent.actions[0]?.toUpperCase() === "REPLY" &&
    !responseContent.providers?.length;

  if (isSimpleReply && responseContent.text) {
    await callback(responseContent);
  } else {
    await runtime.processActions(message, [responseMemory], state, callback);
  }

  await runtime.evaluate(message, state, true, callback, [responseMemory]).catch(() => undefined);

  const directText = getRuntimeContentText(responseContent);
  const text = callbackTexts.length ? callbackTexts.join("\n\n") : directText;
  if (!text) {
    throw new Error("BantahBro runtime returned an empty response.");
  }

  if (!callbackMemories.length) {
    await runtime.createMemory(responseMemory, "messages").catch(() => undefined);
  }

  return {
    text,
    actions: normalizeRuntimeList(responseContent.actions),
    providers: normalizeRuntimeList(responseContent.providers),
    agentId,
    roomId,
  };
}
