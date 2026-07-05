import type {
  BantahBroAlert,
  BantahBroBxbtStatus,
  BantahBroReceipt,
  BantahBroTokenAnalysis,
} from "@shared/bantahBro";
import {
  encodeBantahBroWalletActionParam,
} from "@shared/bantahBroWalletDeepLink";
import type { BantahBroWalletAction } from "@shared/bantahBroWallet";

const DEFAULT_CHAIN = String(process.env.BANTAHBRO_TELEGRAM_DEFAULT_CHAIN || "solana").trim();

const BANTAHBRO_TELEGRAM_START_BUTTONS = {
  analyze: "🔎 Analyze Token",
  rug: "⚠️ Rug Score",
  runner: "🚀 Runner Score",
  alerts: "📣 Live Alerts",
  markets: "🏟 Live Markets",
  leaderboard: "🏆 Leaderboard",
} as const;

function formatUsd(value: number | null | undefined) {
  if (!value || !Number.isFinite(value) || value <= 0) return "n/a";
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toPrecision(4)}`;
}

function chainLabel(chainId: string) {
  const normalized = String(chainId || "").trim().toLowerCase();
  if (normalized === "solana" || normalized === "sol") return "Solana";
  if (normalized === "8453" || normalized === "base") return "Base";
  if (normalized === "42161" || normalized === "arb" || normalized === "arbitrum") {
    return "Arbitrum";
  }
  if (
    normalized === "56" ||
    normalized === "bsc" ||
    normalized === "binance" ||
    normalized === "bnb"
  ) {
    return "BSC";
  }
  return chainId;
}

export function normalizeBantahBroTelegramChainId(raw?: string | null) {
  const normalized = String(raw || DEFAULT_CHAIN).trim().toLowerCase();
  if (normalized === "sol" || normalized === "solana") return "solana";
  if (normalized === "base" || normalized === "8453") return "8453";
  if (normalized === "arb" || normalized === "arbitrum" || normalized === "42161") return "42161";
  if (
    normalized === "bsc" ||
    normalized === "binance" ||
    normalized === "bnb" ||
    normalized === "56"
  ) {
    return "56";
  }
  return normalized || DEFAULT_CHAIN;
}

export function parseBantahBroTelegramTokenCommand(text: string) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/)
    .slice(1);
  if (parts.length === 0) return null;

  if (parts.length >= 2) {
    const maybeChain = normalizeBantahBroTelegramChainId(parts[0]);
    const looksLikeChain =
      maybeChain === "solana" || maybeChain === "8453" || maybeChain === "42161" || maybeChain === "56";
    if (looksLikeChain) {
      return {
        chainId: maybeChain,
        tokenAddress: parts[1],
      };
    }
  }

  return {
    chainId: normalizeBantahBroTelegramChainId(),
    tokenAddress: parts[0],
  };
}

export function buildBantahBroTelegramAlertMessage(
  alert: BantahBroAlert,
  analysis?: BantahBroTokenAnalysis | null,
) {
  const symbol = alert.tokenSymbol ? `$${alert.tokenSymbol}` : "This token";
  const chain = chainLabel(alert.chainId);
  const price = formatUsd(analysis?.primaryPair?.priceUsd ?? alert.referencePriceUsd ?? null);
  const chartUrl = analysis?.primaryPair?.url || null;
  const scanUrl = buildBantahBroTokenScanUrl(alert.chainId, alert.tokenAddress);
  const lines = [
    alert.type === "rug_alert"
      ? "🚨 BANTAH ALERT"
      : alert.type === "runner_alert"
        ? "🚀 BANTAH RUNNER"
        : alert.type === "market_live"
          ? "🎯 BANTAH MARKET"
          : "👀 BANTAH WATCH",
    "",
    `🪙 ${symbol} on ${chain}`,
    `💵 Price: ${price}`,
    `⚠️ Rug Score: ${alert.rugScore ?? "n/a"}/100`,
    `🚀 Momentum: ${alert.momentumScore ?? "n/a"}/100`,
    "",
    alert.body,
  ];

  if (analysis?.primaryPair?.liquidityUsd) {
    lines.splice(4, 0, `💧 Liquidity: $${Math.round(analysis.primaryPair.liquidityUsd).toLocaleString()}`);
  }

  if (alert.market?.url) {
    lines.push("", `🎯 Market: ${alert.market.url}`);
  }

  return {
    text: lines.join("\n"),
    chartUrl,
    scanUrl,
  };
}

export function buildBantahBroTelegramReceiptMessage(receipt: BantahBroReceipt) {
  const symbol = receipt.tokenSymbol ? `$${receipt.tokenSymbol}` : "This token";
  return [
    receipt.status === "top_signal" ? "🏆 BANTAH RECEIPT: 10X" : "🧾 BANTAH RECEIPT",
    "",
    `🪙 ${symbol}`,
    `📍 Entry: ${formatUsd(receipt.entryPriceUsd)}`,
    `💵 Latest: ${formatUsd(receipt.latestPriceUsd)}`,
    `📈 Multiple: ${receipt.multiple.toFixed(2)}x`,
    "",
    receipt.body,
    ...(receipt.market?.url ? ["", `🎯 Market: ${receipt.market.url}`] : []),
  ].join("\n");
}

export function buildBantahBroTelegramAlertsDigest(alerts: BantahBroAlert[]) {
  if (alerts.length === 0) {
    return "📭 No BantahBro alerts yet.\n\nUse /analyze <token> to start the chaos.";
  }

  return [
    "📣 BantahBro live alerts",
    "",
    ...alerts.map((alert, index) => {
      const symbol = alert.tokenSymbol ? `$${alert.tokenSymbol}` : alert.tokenAddress.slice(0, 8);
      const type =
        alert.type === "rug_alert"
          ? "RUG"
          : alert.type === "runner_alert"
            ? "RUNNER"
            : alert.type === "market_live"
              ? "MARKET"
              : "WATCH";
      return `${index + 1}. ${symbol} | ${type} | ⚠️ rug ${alert.rugScore ?? "n/a"} | 🚀 momentum ${alert.momentumScore ?? "n/a"}`;
    }),
  ].join("\n");
}

export function buildBantahBroTelegramMarketsDigest(alerts: BantahBroAlert[]) {
  const liveMarkets = alerts.filter((alert) => Boolean(alert.market?.url));
  if (liveMarkets.length === 0) {
    return "🏟 No live BantahBro markets yet.\n\nUse /analyze and open one.";
  }

  return [
    "🏟 BantahBro live markets",
    "",
    ...liveMarkets.map((alert, index) => {
      const symbol = alert.tokenSymbol ? `$${alert.tokenSymbol}` : alert.tokenAddress.slice(0, 8);
      return `${index + 1}. ${symbol} | ${alert.headline}\n${alert.market?.url}`;
    }),
  ].join("\n\n");
}

export function buildBantahBroTelegramLeaderboardMessage(
  entries: Array<{
    rank: number;
    username?: string | null;
    firstName?: string | null;
    points?: number | null;
    coins?: number | null;
    challengesWon?: number | null;
    eventsWon?: number | null;
  }>,
) {
  if (entries.length === 0) {
    return "🏆 Leaderboard is empty right now.";
  }

  return [
    "🏆 Bantah leaderboard",
    "",
    ...entries.map((entry) => {
      const name = entry.username ? `@${entry.username}` : entry.firstName || "User";
      const wins = (entry.challengesWon || 0) + (entry.eventsWon || 0);
      const score = entry.coins ?? entry.points ?? 0;
      const scoreLabel = entry.coins != null ? "coins" : "pts";
      return `#${entry.rank} ${name} | 🪙 ${score} ${scoreLabel} | 🏁 ${wins} wins`;
    }),
  ].join("\n");
}

export function buildBantahBroTelegramFriendsMessage(
  friends: Array<{
    username?: string | null;
    firstName?: string | null;
    connectedAt?: string | Date | null;
  }>,
) {
  if (friends.length === 0) {
    return "👥 No friends linked yet.\n\nAdd people on Bantah and this list will start filling up.";
  }

  return [
    "👥 Bantah friends",
    "",
    ...friends.slice(0, 10).map((friend, index) => {
      const name = friend.username ? `@${friend.username}` : friend.firstName || "Friend";
      const connectedAt = friend.connectedAt ? new Date(friend.connectedAt).toLocaleDateString("en-GB") : null;
      return `${index + 1}. ${name}${connectedAt ? ` | linked ${connectedAt}` : ""}`;
    }),
  ].join("\n");
}

export function buildBantahBroTelegramBxbtMessage(status: BantahBroBxbtStatus) {
  return [
    "🪙 BantahBro BXBT",
    "",
    `⛓ Chain: ${chainLabel(String(status.chainId))}`,
    `🪙 Token: ${status.tokenAddress || "not set"}`,
    `🏦 Treasury: ${status.treasuryAddress || "not set"}`,
    `🎯 Market cost: ${status.marketCreationCost} BXBT`,
    `📣 Boost unit: ${status.boostUnitCost} BXBT`,
    `🎁 Reward: ${status.rewardAmount} BXBT`,
    "",
    status.balance.available
      ? `👛 Wallet balance: ${status.balance.amountFormatted || "0"} BXBT`
      : `👛 Wallet status: ${status.balance.error || "unavailable"}`,
  ].join("\n");
}

export function buildBantahBroTelegramHelp() {
  return [
    "😎 BantahBro commands",
    "",
    "🔎 /analyze <token> or /analyze <chain> <token>  - full token scan",
    "⚠️ /rug <token>  - rug risk score",
    "🚀 /runner <token>  - runner momentum score",
    "📣 /alerts  - latest BantahBro calls",
    "🏟 /markets  - live Bantah conviction markets",
    "🎯 /create <token>  - open a market from a signal",
    "👛 /balance or /wallet  - linked wallet snapshot",
    "🧭 /discover  - trending meme coins",
    "⚔️ /battle  - join or create battles",
    "🏆 /leaderboard  - live Bantah rankings",
    "👥 /friends  - your Bantah circle",
    "🪙 /bxbt  - BXBT costs, treasury, and balance",
    "",
    "💬 You can also ask plain text like: price of bitcoin, show me trending meme coins on Base, or create $PEPE vs $BONK",
    "",
    "⛓ Supported chain shortcuts: solana, base, arbitrum, bsc",
  ].join("\n");
}

export function buildBantahBroTelegramWelcomeMessage(firstName?: string | null) {
  const safeFirstName = String(firstName || "there").trim() || "there";

  return [
    `😎 Welcome to BantahBro, ${safeFirstName}.`,
    "",
    "⚡ Your degen command center for token scans, wallet checks, meme-coin discovery, battles, BXBT, and Bantah conviction markets.",
    "",
    "👇 Tap a button below or try:",
    "🔎 /analyze <token>",
    "⚠️ /rug <token>",
    "🚀 /runner <token>",
    "👛 /balance",
    "🧭 /discover",
    "⚔️ /battle",
    "📣 /alerts",
    "🏟 /markets",
    "🏆 /leaderboard",
    "👥 /friends",
    "🪙 /bxbt",
    "",
    "💬 Or just ask:",
    "show me trending meme coins on Base",
  ].join("\n");
}

export function buildBantahBroTelegramBotShortDescription() {
  return "🔎 Scan tokens. 👛 Check wallets. 🧭 Find memes. ⚔️ Join battles. ⚠️ Score rugs.";
}

export function buildBantahBroTelegramBotDescription() {
  return [
    "😎 BantahBro is your degen command center on Telegram.",
    "🔎 Scan tokens, 👛 check wallet status, 🧭 find trending meme coins, ⚔️ join or create battles, ⚠️ score rug risk, 🚀 track runner momentum, 📣 watch alerts, 🏟 open markets, 🏆 read leaderboards, and 🪙 use BXBT-backed conviction.",
  ].join(" ");
}

export function buildBantahBroTelegramCommandMenu() {
  return [
    { command: "start", description: "😎 Open BantahBro and quick actions" },
    { command: "help", description: "📚 Show BantahBro commands and examples" },
    { command: "analyze", description: "🔎 Scan any token on Solana, Base, Arbitrum, or BSC" },
    { command: "rug", description: "⚠️ Score the rug risk on a token" },
    { command: "runner", description: "🚀 Score the runner momentum on a token" },
    { command: "balance", description: "👛 Show your linked wallet snapshot" },
    { command: "wallet", description: "👛 Open wallet and account status" },
    { command: "discover", description: "🧭 Show trending meme coins" },
    { command: "battle", description: "⚔️ Join or create live battles" },
    { command: "alerts", description: "📣 See BantahBro's latest alerts" },
    { command: "markets", description: "🏟 View live Bantah conviction markets" },
    { command: "create", description: "🎯 Create a market from a token signal" },
    { command: "leaderboard", description: "🏆 View the live Bantah leaderboard" },
    { command: "friends", description: "👥 See your Bantah friends" },
    { command: "bxbt", description: "🪙 Check BXBT costs, treasury, and balance" },
  ] as const;
}

export function buildBantahBroTelegramStartReplyMarkup() {
  return {
    keyboard: [
      [
        { text: BANTAHBRO_TELEGRAM_START_BUTTONS.analyze },
        { text: BANTAHBRO_TELEGRAM_START_BUTTONS.rug },
      ],
      [
        { text: BANTAHBRO_TELEGRAM_START_BUTTONS.runner },
        { text: BANTAHBRO_TELEGRAM_START_BUTTONS.alerts },
      ],
      [
        { text: BANTAHBRO_TELEGRAM_START_BUTTONS.markets },
        { text: BANTAHBRO_TELEGRAM_START_BUTTONS.leaderboard },
      ],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: "Paste a token or tap a BantahBro task",
  } as const;
}

export function buildBantahBroTelegramStartInlineReplyMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "🔎 Analyze Token", callback_data: "bb:menu:analyze" },
        { text: "⚠️ Rug Score", callback_data: "bb:menu:rug" },
      ],
      [
        { text: "🚀 Runner Score", callback_data: "bb:menu:runner" },
        { text: "📣 Live Alerts", callback_data: "bb:run:alerts" },
      ],
      [
        { text: "🏟 Live Markets", callback_data: "bb:run:markets" },
        { text: "🏆 Leaderboard", callback_data: "bb:run:leaderboard" },
      ],
      [
        { text: "🪙 BXBT Status", callback_data: "bb:run:bxbt" },
        { text: "🎯 Create Market", callback_data: "bb:menu:create" },
      ],
    ],
  };
}

export function parseBantahBroTelegramStartButton(text: string | null | undefined) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.includes("analyze")) return "analyze";
  if (normalized.includes("rug")) return "rug";
  if (normalized.includes("runner")) return "runner";
  if (normalized.includes("alerts")) return "alerts";
  if (normalized.includes("markets")) return "markets";
  if (normalized.includes("leaderboard")) return "leaderboard";

  return null;
}

export function buildBantahBroTelegramStartButtonPrompt(
  action: "analyze" | "rug" | "runner" | "alerts" | "markets" | "leaderboard",
) {
  if (action === "analyze") {
    return [
      "🔎 Send me a token and I will scan it.",
      "",
      "Examples:",
      "/analyze solana So11111111111111111111111111111111111111112",
      "/analyze base 0x4200000000000000000000000000000000000006",
    ].join("\n");
  }

  if (action === "rug") {
    return [
      "⚠️ Send me a token and I will score the rug risk.",
      "",
      "Examples:",
      "/rug solana So11111111111111111111111111111111111111112",
      "/rug base 0x4200000000000000000000000000000000000006",
    ].join("\n");
  }

  if (action === "runner") {
    return [
      "🚀 Send me a token and I will score the runner momentum.",
      "",
      "Examples:",
      "/runner solana So11111111111111111111111111111111111111112",
      "/runner base 0x4200000000000000000000000000000000000006",
    ].join("\n");
  }

  if (action === "alerts") {
    return "/alerts";
  }

  if (action === "markets") {
    return "/markets";
  }

  return "/leaderboard";
}

export function getBantahBroWebBaseUrl() {
  return (
    String(process.env.FRONTEND_URL || "").trim().replace(/\/bantahbro\/?$/, "") ||
    String(process.env.RENDER_EXTERNAL_URL || "").trim() ||
    "http://localhost:5000"
  );
}

export function buildBantahBroHomeUrl() {
  const configured = String(process.env.BANT_A_BRO_WEB_URL || "").trim();
  if (configured) return configured;
  return new URL("/bantahbro", getBantahBroWebBaseUrl()).toString();
}

export function buildBantahBroAgentsUrl() {
  return buildBantahBroHomeUrl();
}

export function buildBantahBroBattlesUrl(battleId?: string | null) {
  const url = new URL("/bantahbro/battles", getBantahBroWebBaseUrl());
  if (battleId) url.searchParams.set("battle", battleId);
  return url.toString();
}

export function buildBantahBroTelegramStartUrl() {
  return buildBantahBroHomeUrl();
}

export function buildBantahBroAgentUrl(agentId?: string | null) {
  const url = new URL(buildBantahBroHomeUrl());
  if (agentId) url.searchParams.set("agent", agentId);
  return url.toString();
}

export function buildBantahBroTokenScanUrl(chainId: string, tokenAddress: string) {
  const url = new URL("/bantahbro/rug-scorer", getBantahBroWebBaseUrl());
  url.searchParams.set("chainId", normalizeBantahBroTelegramChainId(chainId));
  url.searchParams.set("token", tokenAddress);
  return url.toString();
}

export function buildBantahBroWalletActionUrl(action: BantahBroWalletAction) {
  const url = new URL("/bantahbro", getBantahBroWebBaseUrl());
  url.searchParams.set("section", "chat");
  url.searchParams.set("tool", "wallet");
  url.searchParams.set("walletAction", encodeBantahBroWalletActionParam(action));
  url.searchParams.set("source", "telegram");
  return url.toString();
}

export function defaultBantahBroMarketCurrency(chainId: string) {
  return normalizeBantahBroTelegramChainId(chainId) === "56" ? "BNB" : "ETH";
}
