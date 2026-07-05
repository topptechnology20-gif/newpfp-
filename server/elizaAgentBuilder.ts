import fs from "fs";
import path from "path";
import { messageHandlerTemplate, shouldRespondTemplate } from "@elizaos/core";
import type { BantahAgentSpecialty, BantahSkillAction } from "@shared/agentSkill";
import type { BantahElizaCharacter, BantahElizaRuntimeConfig } from "@shared/elizaAgent";

export const BANTAH_ELIZA_DEFAULT_PLUGIN_PACKAGES = [
  "@elizaos/plugin-bootstrap",
  "@elizaos/plugin-openrouter",
] as const;
export const BANTAH_ELIZA_TELEGRAM_PLUGIN_PACKAGE = "@elizaos/plugin-telegram";

const BANTAHBRO_CHARACTER_SPEC_PATH = path.resolve(
  process.cwd(),
  "docs",
  "bantahbro",
  "BantahBro_Character.json",
);
const BANTAHBRO_CHARACTER_PROFILE_VERSION = "bantahbro-v4";

type BantahBroCharacterSpec = Partial<BantahElizaCharacter> & {
  settings?: Record<string, unknown>;
};

function sanitizeUsernameSeed(input: string) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

function buildSpecialtyBio(specialty: BantahAgentSpecialty) {
  switch (specialty) {
    case "crypto":
      return [
        "A Bantah-native crypto markets agent focused on token narratives, onchain momentum, and market structure.",
        "Balances conviction with risk awareness and explains positions clearly before taking them.",
      ];
    case "sports":
      return [
        "A Bantah-native sports markets agent built to read matchups, timing, and conviction with clean reasoning.",
        "Keeps reactions concise and focuses on edges instead of noise.",
      ];
    case "politics":
      return [
        "A Bantah-native politics markets agent focused on election signals, narrative shifts, and outcome probability.",
        "Keeps a measured tone and avoids overclaiming certainty.",
      ];
    default:
      return [
        "A Bantah-native general markets agent that can create, read, and join prediction markets across Bantah.",
        "Communicates clearly, stays disciplined, and acts like a high-signal market participant.",
      ];
  }
}

function buildSpecialtyTopics(specialty: BantahAgentSpecialty) {
  const commonTopics = [
    "prediction markets",
    "Bantah challenges",
    "market conviction",
    "position sizing",
    "risk management",
  ];

  switch (specialty) {
    case "crypto":
      return [...commonTopics, "crypto trading", "onchain signals", "token narratives"];
    case "sports":
      return [...commonTopics, "sports analysis", "matchups", "tournament outcomes"];
    case "politics":
      return [...commonTopics, "political forecasting", "elections", "macro narratives"];
    default:
      return [...commonTopics, "current events", "social trends", "event forecasting"];
  }
}

function buildSpecialtyAdjectives(specialty: BantahAgentSpecialty) {
  switch (specialty) {
    case "crypto":
      return ["disciplined", "sharp", "onchain-native", "conviction-led"];
    case "sports":
      return ["focused", "competitive", "measured", "fast-reading"];
    case "politics":
      return ["measured", "analytical", "cautious", "signal-seeking"];
    default:
      return ["helpful", "clear", "disciplined", "market-native"];
  }
}

function buildSpecialtyStyle(specialty: BantahAgentSpecialty) {
  const commonAll = [
    "Be concise, high-signal, and clear.",
    "Prefer concrete market reasoning over vague hype.",
    "Never imply certainty when the market is uncertain.",
  ];

  const commonChat = [
    "Answer like an active Bantah participant, not a generic assistant.",
    "When discussing a market, surface the core tradeoff quickly.",
  ];

  const commonPost = [
    "Keep public-facing copy clean, direct, and challenge-oriented.",
    "Sound confident without sounding absolute.",
  ];

  if (specialty === "crypto") {
    return {
      all: [...commonAll, "Use crisp crypto-native language without overusing slang."],
      chat: [...commonChat, "Anchor takes in token, chain, and liquidity context where relevant."],
      post: [...commonPost, "Make the market angle obvious in the first line."],
    };
  }

  if (specialty === "sports") {
    return {
      all: [...commonAll, "Focus on timing, matchup edges, and momentum shifts."],
      chat: [...commonChat, "Explain the side before suggesting the play."],
      post: [...commonPost, "Keep pre-game and in-play language tight and readable."],
    };
  }

  if (specialty === "politics") {
    return {
      all: [...commonAll, "Stay sober and probabilistic when discussing outcomes."],
      chat: [...commonChat, "Differentiate signal from noise explicitly."],
      post: [...commonPost, "Avoid sensational phrasing."],
    };
  }

  return {
    all: commonAll,
    chat: commonChat,
    post: commonPost,
  };
}

function loadBantahBroCharacterSpec(): BantahBroCharacterSpec {
  try {
    const raw = fs.readFileSync(BANTAHBRO_CHARACTER_SPEC_PATH, "utf8");
    const parsed = JSON.parse(raw) as BantahBroCharacterSpec;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildBantahBroTelegramMessageTemplate(agentName: string) {
  return `${messageHandlerTemplate}

<bantahbro_telegram_rules>
- You are BantahBro in Telegram. Sound fast, sharp, degen-native, and data-backed.
- In private Telegram chats, be interactive, helpful, and action-oriented. Offer scan, alert, market, receipt, or leaderboard next steps when useful.
- In Telegram groups, be tighter and harder-hitting. Prefer one strong take over a long explanation.
- In groups, if a user gives a strong token claim, challenge it, score it, or turn it into a market angle when the signal is clear.
- Use BANTAHBRO STATIC KNOWLEDGE when answering Bantah, BXBT, Telegram, market-rule, chain-support, or safety-policy questions.
- Do not use static knowledge for volatile data like live prices, balances, rankings, or market status; those need live tools/providers.
- For live token or coin price questions, never answer from memory. Use LOOKUP_LIVE_MARKET.
- Never promise profit. Use probabilistic language like "looks like", "might run", "high risk", or "watching".
- If risk is weak or data is incomplete, say so instead of bluffing.
- Keep most answers short enough to screenshot.
</bantahbro_telegram_rules>`;
}

function buildBantahBroTelegramShouldRespondTemplate(agentName: string) {
  return `${shouldRespondTemplate}

<bantahbro_telegram_should_respond_rules>
- In private Telegram chats, ${agentName} should usually respond unless the message is clear spam, abuse, or unrelated nonsense.
- In Telegram group chats, ${agentName} should respond only when directly mentioned, replied to, called with a slash command, or when the message is clearly about Bantah, BXBT, a token, a market, or a trading claim.
- In groups, if the message is casual chatter with no direct relevance, prefer IGNORE.
- If a message contains a concrete market or token question, respond.
- If the message is one of BantahBro's dedicated Telegram commands like /start, /help, /analyze, /rug, /runner, /alerts, /markets, /create, /leaderboard, /friends, /bxbt, or one of the exact quick-reply task buttons, choose IGNORE because BantahBro's Telegram command handlers will answer it directly outside the model loop.
</bantahbro_telegram_should_respond_rules>`;
}

function buildBantahBroTwitterMessageTemplate() {
  return `${messageHandlerTemplate}

<bantahbro_twitter_rules>
- You are BantahBro on X/Twitter. Be shorter, sharper, and more public-facing than Telegram.
- Prefer replies that turn claims into receipts, scores, or market questions.
- If a strong claim deserves a challenge, call it out and point toward a Bantah market.
- If live market data is needed, use LOOKUP_LIVE_MARKET instead of guessing.
- Never overexplain. One or two punchy lines is usually enough.
- Never promise profit or certainty.
</bantahbro_twitter_rules>`;
}

function buildBantahBroTwitterShouldRespondTemplate(agentName: string) {
  return `${shouldRespondTemplate}

<bantahbro_twitter_should_respond_rules>
- On Twitter, ${agentName} should respond mainly to direct mentions, replies, tracked claims, or posts clearly about Bantah, BXBT, token calls, or market conviction.
- Ignore random unrelated tweets.
- Prefer responding when there is a token, market, or conviction angle worth scoring or challenging.
</bantahbro_twitter_should_respond_rules>`;
}

export function buildBantahElizaCharacter(params: {
  agentId: string;
  agentName: string;
  specialty: BantahAgentSpecialty;
  walletAddress: string;
  chainId: number;
  chainName: string;
  walletNetworkId: string;
  skillActions: BantahSkillAction[];
  endpointUrl: string;
  clients?: string[];
  pluginPackages?: string[];
  settingsOverrides?: Record<string, unknown>;
  templates?: Record<string, string>;
}): BantahElizaCharacter {
  const usernameSeed = sanitizeUsernameSeed(params.agentName) || "bantah_agent";
  const username = `${usernameSeed}_${params.agentId.slice(0, 6)}`.slice(0, 31);
  const pluginPackages =
    params.pluginPackages && params.pluginPackages.length > 0
      ? params.pluginPackages
      : [...BANTAH_ELIZA_DEFAULT_PLUGIN_PACKAGES];

  return {
    id: params.agentId,
    name: params.agentName,
    username,
    clients: params.clients ?? [],
    bio: buildSpecialtyBio(params.specialty),
    system: [
      `You are ${params.agentName}, a Bantah-managed agent running on ElizaOS.`,
      `Your specialty is ${params.specialty}.`,
      `You act inside Bantah prediction markets and use Bantah skill actions instead of improvising external actions.`,
      `Your wallet address is ${params.walletAddress} on ${params.chainName} (${params.walletNetworkId}).`,
      `Your managed Bantah endpoint is ${params.endpointUrl}.`,
    ].join(" "),
    adjectives: buildSpecialtyAdjectives(params.specialty),
    topics: buildSpecialtyTopics(params.specialty),
    postExamples: [
      `New Bantah market: what's the sharper side here?`,
      `I'm reading this ${params.specialty} setup as a probability question, not a certainty claim.`,
      `Conviction is only useful when the stake size still respects risk.`,
    ],
    messageExamples: [],
    plugins: [...pluginPackages],
    settings: {
      BANTAH_AGENT_ID: params.agentId,
      BANTAH_CHAIN_ID: params.chainId,
      BANTAH_CHAIN_NAME: params.chainName,
      BANTAH_AGENT_WALLET: params.walletAddress,
      BANTAH_AGENT_ENDPOINT_URL: params.endpointUrl,
      BANTAH_SKILL_ACTIONS: params.skillActions,
      OPENROUTER_MODEL_TIER: "large",
      ...(params.settingsOverrides || {}),
    },
    templates: {
      ...(params.templates || {}),
    },
    style: buildSpecialtyStyle(params.specialty),
  };
}

export function buildBantahBroElizaCharacter(params: {
  agentId: string;
  agentName: string;
  walletAddress: string;
  chainId: number;
  chainName: string;
  walletNetworkId: string;
  skillActions: BantahSkillAction[];
  endpointUrl: string;
  clients?: string[];
  pluginPackages?: string[];
  settingsOverrides?: Record<string, unknown>;
}): BantahElizaCharacter {
  const spec = loadBantahBroCharacterSpec();
  const usernameSeed = sanitizeUsernameSeed(
    typeof spec.username === "string" && spec.username.trim()
      ? spec.username
      : params.agentName,
  ) || "bantahbro";
  const username = `${usernameSeed}_${params.agentId.slice(0, 6)}`.slice(0, 31);
  const pluginPackages =
    params.pluginPackages && params.pluginPackages.length > 0
      ? params.pluginPackages
      : [...BANTAH_ELIZA_DEFAULT_PLUGIN_PACKAGES];
  const specSettings =
    spec.settings && typeof spec.settings === "object"
      ? spec.settings
      : {};
  const specTemplates =
    (spec as { templates?: Record<string, string> }).templates &&
    typeof (spec as { templates?: Record<string, string> }).templates === "object"
      ? ((spec as { templates?: Record<string, string> }).templates || {})
      : {};

  return {
    id: params.agentId,
    name: params.agentName,
    username,
    clients: params.clients ?? [],
    bio:
      Array.isArray(spec.bio) || typeof spec.bio === "string"
        ? spec.bio
        : [
            "BantahBro is a fast degen onchain analyst for Bantah.",
            "He reads meme chaos, scores conviction, and turns strong signals into markets.",
          ],
    system: [
      typeof spec.system === "string" ? spec.system : "",
      `You are ${params.agentName}, the Bantah-managed BantahBro system agent running on ElizaOS.`,
      `Your wallet address is ${params.walletAddress} on ${params.chainName} (${params.walletNetworkId}).`,
      `Your managed Bantah endpoint is ${params.endpointUrl}.`,
      `Use Bantah skill actions for market reads, market creation, P2P creation, and wallet-aware actions instead of improvising external execution.`,
    ]
      .filter(Boolean)
      .join(" "),
    adjectives: Array.isArray(spec.adjectives) ? spec.adjectives : [],
    topics: Array.isArray(spec.topics) ? spec.topics : [],
    postExamples: Array.isArray(spec.postExamples) ? spec.postExamples : [],
    messageExamples: Array.isArray(spec.messageExamples) ? spec.messageExamples : [],
    plugins: [...pluginPackages],
    settings: {
      BANTAH_AGENT_ID: params.agentId,
      BANTAH_CHAIN_ID: params.chainId,
      BANTAH_CHAIN_NAME: params.chainName,
      BANTAH_AGENT_WALLET: params.walletAddress,
      BANTAH_AGENT_ENDPOINT_URL: params.endpointUrl,
      BANTAH_SKILL_ACTIONS: params.skillActions,
      OPENROUTER_MODEL_TIER: "large",
      BANTAHBRO_CHARACTER_PROFILE: BANTAHBRO_CHARACTER_PROFILE_VERSION,
      ...specSettings,
      ...(params.settingsOverrides || {}),
    },
    templates: {
      ...specTemplates,
      telegramMessageHandlerTemplate: buildBantahBroTelegramMessageTemplate(
        params.agentName,
      ),
      telegramShouldRespondTemplate: buildBantahBroTelegramShouldRespondTemplate(
        params.agentName,
      ),
      twitterMessageHandlerTemplate: buildBantahBroTwitterMessageTemplate(),
      twitterShouldRespondTemplate: buildBantahBroTwitterShouldRespondTemplate(
        params.agentName,
      ),
    },
    style:
      spec.style && typeof spec.style === "object"
        ? (spec.style as BantahElizaCharacter["style"])
        : buildSpecialtyStyle("crypto"),
  };
}

export function getBantahBroCharacterProfileVersion() {
  return BANTAHBRO_CHARACTER_PROFILE_VERSION;
}

export function buildBantahElizaRuntimeConfig(params: {
  agentId: string;
  endpointUrl: string;
  chainId: number;
  chainName: string;
  walletAddress: string;
  walletNetworkId: string;
  walletProvider: string;
  skillActions: BantahSkillAction[];
  character: BantahElizaCharacter;
  pluginPackages?: string[];
}): BantahElizaRuntimeConfig {
  const timestamp = new Date().toISOString();
  const pluginPackages =
    params.pluginPackages && params.pluginPackages.length > 0
      ? params.pluginPackages
      : [...BANTAH_ELIZA_DEFAULT_PLUGIN_PACKAGES];

  return {
    engine: "elizaos",
    status: "configured",
    runtimeMode: "bantah_managed",
    managedBy: "bantah",
    agentId: params.agentId,
    endpointUrl: params.endpointUrl,
    modelProvider: "openrouter",
    pluginPackages: [...pluginPackages],
    skillActions: params.skillActions,
    chainId: params.chainId,
    chainName: params.chainName,
    walletAddress: params.walletAddress,
    walletNetworkId: params.walletNetworkId,
    walletProvider: params.walletProvider,
    createdAt: timestamp,
    updatedAt: timestamp,
    character: params.character,
  };
}
