import { normalizeEvmAddress, type OnchainChainConfig } from "@shared/onchainConfig";
import type { BantahBroWalletAction } from "@shared/bantahBroWallet";
import { createPublicClient, formatUnits, http, parseAbi, type Address } from "viem";
import { storage } from "../storage";
import { getOnchainServerConfig } from "../onchainConfig";
import { getLiveBantahBroAgentBattles } from "./agentBattleService";
import { publishBantahBroBattleCandidates } from "./battleListingsService";
import { buildBattleCandidateFromQueries } from "./battleDiscoveryEngine";
import { getBantahBroHotTickers } from "./hotTickersService";
import {
  buildBantahBroChatScanReply,
  buildBantahBroScanPrompt,
  buildBantahBroTwitterScanReply,
  extractBantahBroSurfaceScanIntent,
  runBantahBroSurfaceScan,
  type BantahBroSurfaceScan,
  type BantahBroSurfaceScanIntent,
  type BantahBroSurfaceScanMode,
} from "./rugScorerSurface";
import {
  buildBantahBroBattlesUrl,
  buildBantahBroHomeUrl,
  buildBantahBroWalletActionUrl,
  getBantahBroWebBaseUrl,
} from "./telegramSupport";
import { parseBantahBroWalletAction } from "./walletActionSurface";

const erc20BalanceAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

type BantahBroCommandSource = "web" | "telegram" | "twitter";

export type BantahBroCommandActor = {
  userId?: string | null;
  username?: string | null;
  firstName?: string | null;
  walletAddress?: string | null;
};

export type BantahBroCommandSurfaceResult = {
  handled: true;
  intent:
    | "wallet_balance"
    | "wallet_create"
    | "wallet_execution_ready"
    | "wallet_send_pending"
    | "trending"
    | "battle_join"
    | "battle_create"
    | "token_scan"
    | "wallet_track_pending"
    | "trade_execution_pending";
  reply: string;
  actions: string[];
  providers: string[];
  links: Array<{ label: string; url: string }>;
  walletAction?: BantahBroWalletAction;
};

function formatUsd(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "n/a";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (value >= 0.01) return `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toPrecision(4)}`;
}

function formatPercent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  const absolute = Math.abs(value);
  const precision = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
  return `${value > 0 ? "+" : ""}${value.toFixed(precision)}%`;
}

function formatNumber(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function shortAddress(value: string | null | undefined) {
  const normalized = normalizeEvmAddress(value);
  if (!normalized) return null;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function compactAmount(value: string) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return value;
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(2)}M`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(2)}K`;
  if (numeric >= 1) return numeric.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return numeric.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function buildWalletUrl() {
  return new URL("/wallet", getBantahBroWebBaseUrl()).toString();
}

function buildLauncherUrl() {
  return `${buildBantahBroHomeUrl()}?section=launcher`;
}

function includesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function detectChainHint(text: string) {
  const normalized = text.toLowerCase();
  if (/\bsolana\b|\bsol\b/.test(normalized)) return "solana";
  if (/\bbase\b|\b8453\b/.test(normalized)) return "base";
  if (/\barbitrum\b|\barb\b|\b42161\b/.test(normalized)) return "arbitrum";
  if (/\bbsc\b|\bbnb\b|\bbinance\b|\b56\b/.test(normalized)) return "bsc";
  if (/\bethereum\b|\beth\b|\bmainnet\b|\b1\b/.test(normalized)) return "ethereum";
  return null;
}

function normalizeSearchTerm(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chainHintLabel(chainHint: string | null) {
  if (!chainHint) return null;
  if (chainHint === "base") return "Base";
  if (chainHint === "solana") return "Solana";
  if (chainHint === "arbitrum") return "Arbitrum";
  if (chainHint === "bsc") return "BSC";
  if (chainHint === "ethereum") return "Ethereum";
  return chainHint;
}

function extractTickers(text: string) {
  const matches: string[] = [];
  const pattern = /\$([a-zA-Z][a-zA-Z0-9_!]{1,24})/g;
  let match = pattern.exec(text);
  while (match) {
    matches.push(match[1].toUpperCase());
    match = pattern.exec(text);
  }

  return unique(
    matches.filter((ticker) => !["USD", "USDC", "USDT", "ETH", "BTC", "SOL", "BNB"].includes(ticker)),
  ).slice(0, 4);
}

function extractBattleQueries(text: string) {
  const tickers = extractTickers(text);
  if (tickers.length >= 2) {
    return [tickers[0], tickers[1]] as const;
  }

  const vsMatch = text.match(
    /\b([a-zA-Z][a-zA-Z0-9_!]{1,24})\b\s+(?:vs|versus)\s+\b([a-zA-Z][a-zA-Z0-9_!]{1,24})\b/i,
  );
  if (!vsMatch) return null;
  return [vsMatch[1].toUpperCase(), vsMatch[2].toUpperCase()] as const;
}

function extractMentionedUsername(text: string) {
  const match = text.match(/@([a-zA-Z0-9_]{2,64})/);
  return match ? match[1] : null;
}

function detectScanMode(text: string, tool?: string | null): BantahBroSurfaceScanMode {
  if (tool === "rug") return "rug";
  if (tool === "runner") return "runner";
  if (/\brunner\b|\bmomentum\b|\bbreakout\b/.test(text)) return "runner";
  if (/\brug\b|\bscam\b|\bsafe\b|\brisky\b|\brisk\b/.test(text)) return "rug";
  return "analyze";
}

function buildLinks(...links: Array<{ label: string; url: string } | null>) {
  return links.filter((entry): entry is { label: string; url: string } => Boolean(entry));
}

function isWalletBalanceIntent(text: string, tool?: string | null) {
  return (
    includesAny(text, [
      /^\/wallet\b/,
      /^wallet$/,
      /\bwallet balance\b/,
      /\bmy balance\b/,
      /\bbalance\b/,
      /\bmy wallet\b/,
      /\bwallet status\b/,
      /\bportfolio\b/,
      /\bpositions?\b/,
      /\bholdings?\b/,
    ])
  );
}

function isCreateWalletIntent(text: string) {
  return includesAny(text, [/\bcreate\b.*\bwallet\b/, /\bmake\b.*\bwallet\b/, /\bnew wallet\b/]);
}

function isTrendingIntent(text: string, tool?: string | null) {
  return (
    tool === "discover" ||
    includesAny(text, [
      /\btrending\b/,
      /\bwhat('?s| is)\b.*\bhot\b/,
      /\bhot\b.*\bon\b/,
      /\bhot now\b/,
      /\bhot\b.*\bcoins?\b/,
      /\bmeme coins?\b/,
      /\bdexscreener\b/,
      /\bwhat('?s| is)\b.*\brunning\b/,
      /\bdiscover\b/,
    ])
  );
}

function isBattleJoinIntent(text: string, tool?: string | null) {
  return (
    tool === "battle" ||
    includesAny(text, [
      /\bjoin\b.*\bbattle\b/,
      /\bshow\b.*\bbattles?\b/,
      /\blive\b.*\bbattles?\b/,
      /\bbattle now\b/,
      /\barena\b/,
    ])
  );
}

function isBattleCreateIntent(text: string, tool?: string | null) {
  return (
    Boolean(extractBattleQueries(text)) &&
    (tool === "battle" ||
      includesAny(text, [/\bcreate\b/, /\bopen\b/, /\blaunch\b/, /\bstart\b/, /\bbattle\b/, /\bvs\b/, /\bversus\b/]))
  );
}

function isWalletTrackingIntent(text: string) {
  return includesAny(text, [
    /\btrack\b.*\bwallet\b/,
    /\balert me\b.*\bbuy\b/,
    /\bcopy trade\b/,
    /\bbuy every token\b/,
  ]);
}

function isTradeExecutionIntent(text: string) {
  return includesAny(text, [
    /^(?:\/)?buy\b/,
    /^(?:\/)?sell\b/,
    /^(?:\/)?swap\b/,
    /^(?:\/)?bridge\b/,
    /^(?:\/)?approve\b/,
    /^(?:\/)?revoke\b/,
    /\bbuy\s+(?:\$|[0-9])/,
    /\bsell\s+(?:\$|[0-9])/,
    /\bswap\s+[0-9]/,
    /\bsnipe\b/,
    /\bstake\b/,
    /\bclaim airdrops?\b/,
    /\btake profit\b/,
    /\bstop loss\b/,
  ]);
}

function isWalletSendIntent(text: string) {
  return includesAny(text, [/\bsend\b/, /\btransfer\b/, /\btip\b/]) && Boolean(extractMentionedUsername(text));
}

function isTokenInfoIntent(text: string, tool?: string | null) {
  return (
    tool === "analyze" ||
    tool === "rug" ||
    tool === "runner" ||
    includesAny(text, [
      /\bmarket cap\b/,
      /\bfdv\b/,
      /\bholders?\b/,
      /\btop holders?\b/,
      /\bliquidity\b.*\blocked\b/,
      /\blp\b.*\blocked\b/,
      /\bwho created\b/,
      /\bcreator\b/,
      /\brug\b/,
      /\bscam\b/,
      /\bcheck\b/,
      /\banaly[sz]e\b/,
      /\bscan\b/,
      /\bscore\b/,
    ])
  );
}

function renderTwitterReply(text: string) {
  return text.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
}

async function readChainBalances(params: {
  walletAddress: string;
  chain: OnchainChainConfig;
}) {
  const walletAddress = params.walletAddress as Address;
  const client = createPublicClient({
    transport: http(params.chain.rpcUrl),
  });
  const assets: string[] = [];
  const nativeToken =
    Object.values(params.chain.tokens).find((token) => token.isNative) || null;

  if (nativeToken) {
    try {
      const amount = await client.getBalance({ address: walletAddress });
      if (amount > BigInt(0)) {
        assets.push(`${compactAmount(formatUnits(amount, nativeToken.decimals))} ${nativeToken.symbol}`);
      }
    } catch {
      // Ignore per-chain read failures so the command surface still responds.
    }
  }

  for (const symbol of params.chain.supportedTokens.slice(0, 3)) {
    const token = params.chain.tokens[symbol];
    if (!token || token.isNative || !normalizeEvmAddress(token.address)) continue;

    try {
      const balance = await client.readContract({
        address: token.address as Address,
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [walletAddress],
      });
      const amount = BigInt(String(balance || "0"));
      if (amount > BigInt(0)) {
        assets.push(`${compactAmount(formatUnits(amount, token.decimals))} ${token.symbol}`);
      }
    } catch {
      // Ignore unsupported token reads on a chain.
    }
  }

  return {
    chainName: params.chain.name,
    assets,
  };
}

async function buildWalletBalanceReply(params: {
  source: BantahBroCommandSource;
  actor?: BantahBroCommandActor | null;
  text: string;
}) {
  const actor = params.actor || null;
  if (!actor?.userId) {
    return {
      reply:
        params.source === "twitter"
          ? "Wallet commands need a linked Bantah account. Open BantahBro or Telegram, connect, and I can read your wallet status there."
          : "Wallet commands need a signed-in Bantah account. Connect on BantahBro and I can read your linked wallet status here.",
      links: buildLinks({ label: "Open BantahBro", url: buildBantahBroHomeUrl() }),
    };
  }

  if (!normalizeEvmAddress(actor.walletAddress)) {
    return {
      reply: [
        "I found your Bantah account, but there is no linked EVM wallet yet.",
        "",
        "Open the wallet flow and Privy can create or connect one for you. After that, I can read balances here.",
      ].join("\n"),
      links: buildLinks({ label: "Open Wallet", url: buildWalletUrl() }),
    };
  }

  const preferredChainHint = detectChainHint(params.text);
  const onchainConfig = getOnchainServerConfig();
  const enabledChains = Object.values(onchainConfig.chains);
  const orderedChains = enabledChains
    .sort((left, right) => {
      const leftHint = preferredChainHint && left.key.includes(preferredChainHint) ? 1 : 0;
      const rightHint = preferredChainHint && right.key.includes(preferredChainHint) ? 1 : 0;
      if (leftHint !== rightHint) return rightHint - leftHint;
      if (left.chainId === onchainConfig.defaultChainId) return -1;
      if (right.chainId === onchainConfig.defaultChainId) return 1;
      return 0;
    })
    .slice(0, 4);

  const [appBalance, chainSnapshots] = await Promise.all([
    storage.getUserBalance(actor.userId).catch(() => null),
    Promise.all(
      orderedChains.map((chain) =>
        readChainBalances({
          walletAddress: actor.walletAddress as string,
          chain,
        }).catch(() => ({ chainName: chain.name, assets: [] })),
      ),
    ),
  ]);

  const nonEmptySnapshots = chainSnapshots.filter((entry) => entry.assets.length > 0);
  const visibleSnapshots = (nonEmptySnapshots.length > 0 ? nonEmptySnapshots : chainSnapshots.slice(0, 2)).slice(
    0,
    params.source === "twitter" ? 2 : 3,
  );

  const lines = [
    `Linked wallet: ${shortAddress(actor.walletAddress) || actor.walletAddress}`,
    ...visibleSnapshots.map((entry) =>
      entry.assets.length > 0 ? `${entry.chainName}: ${entry.assets.join(" | ")}` : `${entry.chainName}: no detected supported balance`,
    ),
  ];

  if (appBalance) {
    lines.push(
      `App balance: ${formatNumber(Number(appBalance.balance || 0))} | Coins ${formatNumber(
        Number(appBalance.coins || 0),
      )} | BantCredit ${formatNumber(Number(appBalance.points || 0))}`,
    );
  }

  return {
    reply:
      params.source === "twitter"
        ? renderTwitterReply(lines.join("\n"))
        : ["Wallet snapshot", "", ...lines].join("\n"),
    links: buildLinks({ label: "Open Wallet", url: buildWalletUrl() }),
  };
}

async function buildCreateWalletReply(params: {
  source: BantahBroCommandSource;
  actor?: BantahBroCommandActor | null;
}) {
  const walletAddress = normalizeEvmAddress(params.actor?.walletAddress);
  if (walletAddress) {
    return {
      reply:
        params.source === "twitter"
          ? `You already have a linked wallet: ${shortAddress(walletAddress)}.`
          : `You already have a linked wallet: ${walletAddress}`,
      links: buildLinks({ label: "Open Wallet", url: buildWalletUrl() }),
    };
  }

  return {
    reply:
      params.source === "twitter"
        ? "Open BantahBro, sign in, and Privy can create or connect a wallet for you."
        : [
            "Open BantahBro, sign in, and Privy can create or connect a wallet for you.",
            "",
            "Once it is linked, I can read balances and route you into battles from chat.",
          ].join("\n"),
    links: buildLinks(
      { label: "Open BantahBro", url: buildBantahBroHomeUrl() },
      { label: "Open Wallet", url: buildWalletUrl() },
    ),
  };
}

async function buildTrendingReply(params: {
  source: BantahBroCommandSource;
  text: string;
}) {
  const feed = await getBantahBroHotTickers(6);
  const chainHint = detectChainHint(params.text);
  const filteredEntries = chainHint
    ? feed.entries.filter((entry) => {
        const entryChainId = String(entry.chainId || "").toLowerCase();
        const entryChainLabel = String(entry.chainLabel || "").toLowerCase();
        return entryChainId.includes(chainHint) || entryChainLabel.includes(chainHint);
      })
    : feed.entries;
  if (chainHint && filteredEntries.length === 0) {
    const fallbackEntries = feed.entries.slice(0, params.source === "twitter" ? 2 : 4);
    if (fallbackEntries.length === 0) {
      return {
        reply: `I do not have a clean live trending read for ${chainHintLabel(chainHint) || chainHint} right now.`,
        links: buildLinks({ label: "Open BantahBro", url: buildBantahBroHomeUrl() }),
      };
    }

    const fallbackLines = fallbackEntries.map(
      (entry, index) =>
        `${index + 1}. ${entry.displaySymbol} | ${entry.chainLabel || entry.chainId || "Live"} | 24H ${entry.change} | MC ${formatUsd(
          entry.marketCap,
        )} | Liq ${formatUsd(entry.liquidityUsd)}`,
    );

    return {
      reply:
        params.source === "twitter"
          ? renderTwitterReply(
              `No clean ${chainHintLabel(chainHint) || chainHint} trending board right now. Cross-chain heat: ${fallbackLines.join(
                " / ",
              )}`,
            )
          : [
              `I do not have a clean live trending read for ${chainHintLabel(chainHint) || chainHint} right now.`,
              "",
              "Current cross-chain heat:",
              ...fallbackLines,
            ].join("\n"),
      links: buildLinks({ label: "Open BantahBro", url: buildBantahBroHomeUrl() }),
    };
  }

  const entries = (filteredEntries.length > 0 ? filteredEntries : feed.entries).slice(
    0,
    params.source === "twitter" ? 2 : 4,
  );

  if (entries.length === 0) {
    return {
      reply: "I do not have a live trending meme-coin read right now.",
      links: buildLinks({ label: "Open BantahBro", url: buildBantahBroHomeUrl() }),
    };
  }

  const heading = chainHint ? `Trending meme coins on ${chainHint}` : "Trending meme coins right now";
  const lines = entries.map(
    (entry, index) =>
      `${index + 1}. ${entry.displaySymbol} | ${entry.chainLabel || entry.chainId || "Live"} | 24H ${entry.change} | MC ${formatUsd(
        entry.marketCap,
      )} | Liq ${formatUsd(entry.liquidityUsd)}`,
  );

  return {
    reply:
      params.source === "twitter"
        ? renderTwitterReply(`${heading}: ${lines.join(" / ")}`)
        : [heading, "", ...lines].join("\n"),
    links: buildLinks({ label: "Open BantahBro", url: buildBantahBroHomeUrl() }),
  };
}

function matchHotTickerEntry(
  entries: Awaited<ReturnType<typeof getBantahBroHotTickers>>["entries"],
  intent: BantahBroSurfaceScanIntent,
) {
  const normalizedQuery = normalizeSearchTerm(intent.query);
  if (!normalizedQuery) return null;

  const scopedEntries =
    intent.chainId && intent.chainId.length > 0
      ? entries.filter((entry) => {
          const entryChainId = String(entry.chainId || "").trim().toLowerCase();
          const entryChainLabel = String(entry.chainLabel || "").trim().toLowerCase();
          return entryChainId === intent.chainId || entryChainLabel === intent.chainId;
        })
      : entries;

  let bestEntry: (typeof entries)[number] | null = null;
  let bestScore = 0;

  for (const entry of scopedEntries) {
    const candidates = [
      entry.displaySymbol,
      entry.actualSymbol,
      entry.tokenName,
    ]
      .map((value) => normalizeSearchTerm(value))
      .filter(Boolean);

    for (const candidate of candidates) {
      const score =
        candidate === normalizedQuery
          ? 5
          : candidate.startsWith(normalizedQuery) || normalizedQuery.startsWith(candidate)
            ? 4
            : candidate.includes(normalizedQuery) || normalizedQuery.includes(candidate)
              ? 3
              : 0;
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }
  }

  return bestScore >= 3 ? bestEntry : null;
}

async function resolveSurfaceScan(intent: BantahBroSurfaceScanIntent) {
  try {
    return await runBantahBroSurfaceScan({
      query: intent.query,
      chainId: intent.chainId,
    });
  } catch (error) {
    if (intent.matchType === "address") {
      throw error;
    }

    const feed = await getBantahBroHotTickers(12).catch(() => null);
    const matchedEntry = feed ? matchHotTickerEntry(feed.entries, intent) : null;
    if (!matchedEntry?.tokenAddress || !matchedEntry.chainId) {
      throw error;
    }

    return runBantahBroSurfaceScan({
      query: matchedEntry.tokenAddress,
      chainId: matchedEntry.chainId,
    });
  }
}

function findBattleByTicker(feed: Awaited<ReturnType<typeof getLiveBantahBroAgentBattles>>, text: string) {
  const tickers = extractTickers(text);
  if (tickers.length === 0) return null;
  return (
    feed.battles.find((battle) =>
      battle.sides.some((side) =>
        [side.tokenSymbol, side.label, side.tokenName]
          .filter(Boolean)
          .some((value) => String(value).toUpperCase().includes(tickers[0])),
      ),
    ) || null
  );
}

async function buildJoinBattleReply(params: {
  source: BantahBroCommandSource;
  text: string;
}) {
  const feed = await getLiveBantahBroAgentBattles(params.source === "twitter" ? 2 : 4);
  const matchedBattle = findBattleByTicker(feed, params.text);
  const battles = matchedBattle ? [matchedBattle] : feed.battles.slice(0, params.source === "twitter" ? 1 : 3);

  if (battles.length === 0) {
    return {
      reply: "No live BantahBro battle is open right this second.",
      links: buildLinks({ label: "Open Battles", url: buildBantahBroBattlesUrl() }),
    };
  }

  const lines = battles.map((battle, index) => {
    const [left, right] = battle.sides;
    const url = buildBantahBroBattlesUrl(battle.id);
    return `${index + 1}. ${left.label} vs ${right.label} | ${battle.timeRemainingSeconds}s left | Lead ${battle.confidenceSpread.toFixed(
      0,
    )}% | ${url}`;
  });

  return {
    reply:
      params.source === "twitter"
        ? renderTwitterReply(`Live battle: ${lines[0]}`)
        : ["Live battles", "", ...lines].join("\n"),
    links: buildLinks({ label: "Open Battles", url: buildBantahBroBattlesUrl(battles[0].id) }),
  };
}

async function buildCreateBattleReply(params: {
  source: BantahBroCommandSource;
  text: string;
  actor?: BantahBroCommandActor | null;
}) {
  const battleQueries = extractBattleQueries(params.text);
  if (!battleQueries) {
    return {
      reply:
        params.source === "twitter"
          ? "Say '$TOKEN vs $TOKEN' and I can build a BantahBro battle."
          : "Send two live tokens like '$PEPE vs $BONK' and I can build a BantahBro battle for them.",
      links: buildLinks({ label: "Open Battles", url: buildBantahBroBattlesUrl() }),
    };
  }

  const [leftQuery, rightQuery] = battleQueries;
  const { candidate } = await buildBattleCandidateFromQueries({
    leftQuery,
    rightQuery,
  });
  const [listed] = await publishBantahBroBattleCandidates([candidate], {
    source: "manual",
    listedBy: params.actor?.userId ? `${params.source}:${params.actor.userId}` : params.source,
  });
  const battleUrl = buildBantahBroBattlesUrl(listed?.engineBattleId || candidate.id);

  const reply =
    params.source === "twitter"
      ? `Battle live: $${leftQuery} vs $${rightQuery}. Score ${candidate.score}. Jump into the BantahBro arena below.`
      : [
          `Battle created: $${leftQuery} vs $${rightQuery}`,
          "",
          `Battle score: ${candidate.score}`,
          `Winner rule: ${candidate.winnerRule.replace(/_/g, " ")}`,
          `Arena: ${battleUrl}`,
        ].join("\n");

  return {
    reply,
    links: buildLinks({ label: "Open Battle", url: battleUrl }),
  };
}

function buildTopHolderLines(scan: BantahBroSurfaceScan) {
  if (scan.analysis.holders.status !== "available" || scan.analysis.holders.topHolders.length === 0) {
    return ["Top holders are not available from the current live source."];
  }

  return scan.analysis.holders.topHolders.slice(0, 5).map((holder, index) => {
    const label =
      holder.label || holder.entity || `${holder.address.slice(0, 6)}...${holder.address.slice(-4)}`;
    const percent =
      typeof holder.percentage === "number" && Number.isFinite(holder.percentage)
        ? `${holder.percentage.toFixed(2)}%`
        : "n/a";
    return `${index + 1}. ${label} | ${percent}`;
  });
}

async function buildTokenInfoReply(params: {
  source: BantahBroCommandSource;
  text: string;
  tool?: string | null;
}) {
  const mode = detectScanMode(params.text, params.tool);
  const intent = extractBantahBroSurfaceScanIntent(params.text, {
    allowPhraseFallback: true,
  });

  if (!intent) {
    return {
      reply: buildBantahBroScanPrompt(mode),
      links: buildLinks({ label: "Open Rug Scorer", url: buildBantahBroHomeUrl() }),
    };
  }

  let scan: BantahBroSurfaceScan | null = null;
  try {
    scan = await resolveSurfaceScan(intent);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The live token scan could not complete.";
    const chainLabel = chainHintLabel(intent.chainId);
    return {
      reply:
        params.source === "twitter"
          ? renderTwitterReply(
              `I could not resolve a clean live scan for ${chainLabel ? `${chainLabel} ` : ""}${intent.query}. Send the chain plus contract for a more reliable read.`,
            )
          : [
              `I could not complete a clean live scan for ${intent.query}${chainLabel ? ` on ${chainLabel}` : ""}.`,
              "",
              message,
              "",
              "Try the chain plus contract address for the most reliable answer.",
              buildBantahBroScanPrompt(mode),
            ].join("\n"),
      links: buildLinks({ label: "Open Rug Scorer", url: buildBantahBroHomeUrl() }),
    };
  }
  if (!scan) {
    return {
      reply: buildBantahBroScanPrompt(mode),
      links: buildLinks({ label: "Open Rug Scorer", url: buildBantahBroHomeUrl() }),
    };
  }

  if (/\btop holders?\b|\bshow holders?\b/.test(params.text)) {
    return {
      reply:
        params.source === "twitter"
          ? renderTwitterReply(
              `${scan.token.tokenSymbol || scan.token.tokenName || "Token"} top holders: ${buildTopHolderLines(scan)
                .slice(0, 2)
                .join(" / ")}`,
            )
          : [
              `Top holders for ${scan.token.tokenSymbol ? `$${scan.token.tokenSymbol}` : scan.token.tokenName || scan.token.tokenAddress}`,
              "",
              ...buildTopHolderLines(scan),
              "",
              `Open full scan: ${scan.scanUrl}`,
            ].join("\n"),
      links: buildLinks({ label: "Open Scan", url: scan.scanUrl }),
    };
  }

  if (/\bliquidity\b.*\blocked\b|\blp\b.*\blocked\b/.test(params.text)) {
    const lockedPercent =
      typeof scan.token.liquidityLock.lockedPercent === "number"
        ? ` (${scan.token.liquidityLock.lockedPercent.toFixed(1)}%)`
        : "";
    return {
      reply:
        params.source === "twitter"
          ? renderTwitterReply(
              `${scan.token.tokenSymbol || scan.token.tokenName || "Token"} LP: ${scan.token.liquidityLock.label}${lockedPercent}. Rug ${scan.token.rug.score}/100.`,
            )
          : [
              `Liquidity lock for ${scan.token.tokenSymbol ? `$${scan.token.tokenSymbol}` : scan.token.tokenName || scan.token.tokenAddress}`,
              "",
              `LP status: ${scan.token.liquidityLock.label}${lockedPercent}`,
              `Contract risk: ${scan.token.contractRisk.label}`,
              `Rug score: ${scan.token.rug.score}/100 (${scan.token.rug.riskLevel})`,
              "",
              `Open full scan: ${scan.scanUrl}`,
            ].join("\n"),
      links: buildLinks({ label: "Open Scan", url: scan.scanUrl }),
    };
  }

  if (/\bmarket cap\b|\bfdv\b/.test(params.text)) {
    const marketCap = formatUsd(scan.token.marketCap);
    const fdv = formatUsd(scan.analysis.primaryPair?.fdv ?? null);
    return {
      reply:
        params.source === "twitter"
          ? renderTwitterReply(
              `${scan.token.tokenSymbol || scan.token.tokenName || "Token"} ${scan.token.chainLabel}: MC ${marketCap}, FDV ${fdv}, price ${formatUsd(
                scan.token.priceUsd,
              )}, liq ${formatUsd(scan.token.liquidityUsd)}.`,
            )
          : [
              `Market cap for ${scan.token.tokenSymbol ? `$${scan.token.tokenSymbol}` : scan.token.tokenName || scan.token.tokenAddress}`,
              "",
              `Chain: ${scan.token.chainLabel}`,
              `Market cap: ${marketCap}`,
              `FDV: ${fdv}`,
              `Price: ${formatUsd(scan.token.priceUsd)}`,
              `Liquidity: ${formatUsd(scan.token.liquidityUsd)}`,
              `24H volume: ${formatUsd(scan.token.volumeH24)}`,
              "",
              `Open full scan: ${scan.scanUrl}`,
            ].join("\n"),
      links: buildLinks({ label: "Open Scan", url: scan.scanUrl }),
    };
  }

  if (/\bwho created\b|\bcreator\b/.test(params.text)) {
    return {
      reply:
        params.source === "twitter"
          ? renderTwitterReply(
              `${scan.token.tokenSymbol || scan.token.tokenName || "Token"} creator lookup is not wired yet. I can still give you the contract, LP, holder, and rug read.`,
            )
          : [
              "Creator lookup is not wired into the BantahBro command surface yet.",
              "",
              buildBantahBroChatScanReply(scan, mode),
            ].join("\n"),
      links: buildLinks({ label: "Open Scan", url: scan.scanUrl }),
    };
  }

  const reply =
    params.source === "twitter"
      ? buildBantahBroTwitterScanReply(scan, mode)
      : buildBantahBroChatScanReply(scan, mode);
  return {
    reply,
    links: buildLinks({ label: "Open Scan", url: scan.scanUrl }),
  };
}

async function buildWalletTrackingPendingReply() {
  return {
    reply: [
      "Wallet tracking and copy-trade alerts are not live yet in BantahBro.",
      "",
      "What is live now: rug checks, market-cap reads, top holders, trending meme coins, wallet balance snapshots, and join/create battle flows.",
    ].join("\n"),
    links: buildLinks({ label: "Open BantahBro", url: buildBantahBroHomeUrl() }),
  };
}

async function buildWalletSendPendingReply(params: {
  source: BantahBroCommandSource;
  text: string;
}) {
  const username = extractMentionedUsername(params.text);
  const targetUser = username ? await storage.getUserByUsername(username).catch(() => undefined) : undefined;
  const targetLabel = username ? `@${username}` : "that recipient";
  const targetStatus = targetUser
    ? `${targetLabel} exists on Bantah.`
    : username
      ? `I could not verify ${targetLabel} on Bantah yet.`
      : "";

  return {
    reply:
      params.source === "twitter"
        ? renderTwitterReply(
            `I need a clearer send command before I can prepare it. Try: send 5 USDC to @username. ${targetStatus}`.trim(),
          )
        : [
            "I need a clearer send command before I can prepare it.",
            "",
            targetStatus,
            "Try a format like: send 5 USDC to @username",
          ]
            .filter(Boolean)
            .join("\n"),
    links: buildLinks({ label: "Open Wallet", url: buildWalletUrl() }),
  };
}

async function buildTradeExecutionPendingReply(params: {
  source: BantahBroCommandSource;
}) {
  return {
    reply:
      params.source === "twitter"
        ? "Advanced automation is not live in BantahBro chat yet. Live now: send, approve, swap, buy, sell, bridge, rug checks, trending coins, battles, and token launch."
        : [
            "That advanced automation path is not live yet.",
            "",
            "Live right now: send, approve, revoke, swap, buy, sell, bridge, wallet balance snapshots, create wallet guidance, rug checks, market-cap reads, top holders, liquidity-lock reads, trending meme coins, join/create battles, and token deployment.",
            "",
            "Still pending: snipe-at-launch, stop-loss, take-profit, copy-trade, staking automation, and claim-airdrop automation.",
          ].join("\n"),
    links: buildLinks(
      { label: "Open Wallet", url: buildWalletUrl() },
      { label: "Open Launcher", url: buildLauncherUrl() },
    ),
  };
}

async function buildWalletExecutionReadyReply(params: {
  source: BantahBroCommandSource;
  action: BantahBroWalletAction;
}) {
  const summary = params.action.summary;
  const walletActionUrl =
    params.source === "telegram" ? buildBantahBroWalletActionUrl(params.action) : null;
  return {
    reply:
      params.source === "twitter"
        ? renderTwitterReply(`${summary} Open BantahBro to review and sign.`)
        : [
            "Execution ready.",
            "",
            summary,
            "",
            params.source === "telegram"
              ? "Tap Review & Sign to open BantahBro with this wallet action loaded and ready for Privy confirmation."
              : "Review the action card below, then confirm it with your Privy wallet.",
          ].join("\n"),
    links: walletActionUrl
      ? buildLinks(
          { label: "Review & Sign", url: walletActionUrl },
          { label: "Open Wallet", url: buildWalletUrl() },
        )
      : buildLinks({ label: "Open Wallet", url: buildWalletUrl() }),
  };
}

export async function maybeHandleBantahBroCommandSurface(params: {
  text: string;
  tool?: string | null;
  source: BantahBroCommandSource;
  actor?: BantahBroCommandActor | null;
}): Promise<BantahBroCommandSurfaceResult | null> {
  const rawText = String(params.text || "").trim();
  if (!rawText) return null;
  const text = rawText.toLowerCase();

  if (isBattleCreateIntent(text, params.tool)) {
    const response = await buildCreateBattleReply(params);
    return {
      handled: true,
      intent: "battle_create",
      reply: response.reply,
      actions: ["BATTLE_CREATE"],
      providers: ["battle-engine", "dexscreener"],
      links: response.links,
    };
  }

  if (isBattleJoinIntent(text, params.tool)) {
    const response = await buildJoinBattleReply(params);
    return {
      handled: true,
      intent: "battle_join",
      reply: response.reply,
      actions: ["BATTLE_JOIN_GUIDE"],
      providers: ["battle-engine", "dexscreener"],
      links: response.links,
    };
  }

  if (isWalletBalanceIntent(text, params.tool)) {
    const response = await buildWalletBalanceReply(params);
    return {
      handled: true,
      intent: "wallet_balance",
      reply: response.reply,
      actions: ["WALLET_BALANCE"],
      providers: ["privy", "onchain", "wallet"],
      links: response.links,
    };
  }

  if (isCreateWalletIntent(text)) {
    const response = await buildCreateWalletReply(params);
    return {
      handled: true,
      intent: "wallet_create",
      reply: response.reply,
      actions: ["WALLET_CREATE_GUIDE"],
      providers: ["privy"],
      links: response.links,
    };
  }

  if (isTrendingIntent(text, params.tool)) {
    const response = await buildTrendingReply(params);
    return {
      handled: true,
      intent: "trending",
      reply: response.reply,
      actions: ["TRENDING_MEMES"],
      providers: ["dexscreener", "moralis"],
      links: response.links,
    };
  }

  if (isWalletTrackingIntent(text)) {
    const response = await buildWalletTrackingPendingReply();
    return {
      handled: true,
      intent: "wallet_track_pending",
      reply: response.reply,
      actions: ["WALLET_TRACK_PENDING"],
      providers: [],
      links: response.links,
    };
  }

  const walletAction = parseBantahBroWalletAction({
    text: rawText,
    actor: params.actor,
  });
  if (walletAction) {
    const response = await buildWalletExecutionReadyReply({
      source: params.source,
      action: walletAction,
    });
    return {
      handled: true,
      intent: "wallet_execution_ready",
      reply: response.reply,
      actions: ["WALLET_EXECUTION_READY"],
      providers: ["privy", "wallet", walletAction.kind === "bridge" || walletAction.kind === "swap" ? "lifi" : "onchain"],
      links: response.links,
      walletAction,
    };
  }

  if (isWalletSendIntent(text)) {
    const response = await buildWalletSendPendingReply(params);
    return {
      handled: true,
      intent: "wallet_send_pending",
      reply: response.reply,
      actions: ["WALLET_SEND_PENDING"],
      providers: [],
      links: response.links,
    };
  }

  if (isTradeExecutionIntent(text)) {
    const response = await buildTradeExecutionPendingReply(params);
    return {
      handled: true,
      intent: "trade_execution_pending",
      reply: response.reply,
      actions: ["TRADE_EXECUTION_PENDING"],
      providers: [],
      links: response.links,
    };
  }

  if (isTokenInfoIntent(text, params.tool)) {
    const response = await buildTokenInfoReply(params);
    return {
      handled: true,
      intent: "token_scan",
      reply: response.reply,
      actions: ["TOKEN_SCAN"],
      providers: ["rug-v2", "dexscreener", "goplus", "moralis"],
      links: response.links,
    };
  }

  return null;
}
