import {
  normalizeEvmAddress,
  parseWalletAddresses,
  type OnchainChainConfig,
  type OnchainPublicConfig,
} from "@shared/onchainConfig";
import {
  bantahBroPreparedWalletActionSchema,
  bantahBroWalletActionSchema,
  type BantahBroPreparedWalletAction,
  type BantahBroWalletAction,
} from "@shared/bantahBroWallet";
import { createPublicClient, formatUnits, http, parseAbi, parseUnits, type Address } from "viem";

import { getOnchainServerConfig } from "../onchainConfig";
import { storage } from "../storage";
import { lookupMarketByQuery } from "./tokenIntelligence";

type BantahBroWalletActor = {
  userId?: string | null;
  username?: string | null;
  walletAddress?: string | null;
};

type ResolvedWalletToken = {
  symbol: string;
  address: string | null;
  decimals: number;
  isNative: boolean;
  label: string;
  priceUsd?: string | null;
};

const erc20TokenAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

const LIFI_API_BASE = String(process.env.LIFI_API_BASE || "https://li.quest/v1").replace(/\/+$/, "");
const LIFI_API_KEY = String(process.env.LIFI_API_KEY || "").trim();
const LIFI_TIMEOUT_MS = 12_000;

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function normalizeSearchText(value: string) {
  return String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, " ");
}

function cleanTokenQuery(value: string) {
  return String(value || "")
    .trim()
    .replace(/^of\s+/i, "")
    .replace(/^my\s+position\s+in\s+/i, "")
    .replace(/^the\s+/i, "")
    .replace(/^(token|coin)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactAmount(value: string | number) {
  const numeric = Number.parseFloat(String(value || "").trim());
  if (!Number.isFinite(numeric)) return String(value || "").trim();
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(2)}M`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(2)}K`;
  if (numeric >= 1) return numeric.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return numeric.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function humanUsd(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function stripLeadingCommand(text: string) {
  return text.replace(/^\/(send|transfer|tip|approve|revoke|swap|buy|sell|bridge)\b/i, (_, command) => command);
}

function findAddress(text: string) {
  const match = text.match(/0x[a-fA-F0-9]{40}/);
  return normalizeEvmAddress(match?.[0]);
}

function findMentionedUsername(text: string) {
  const match = text.match(/@([a-zA-Z0-9_]{2,32})/);
  return match?.[1] ? match[1].trim() : null;
}

function chainAliasCandidates(value: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return [];
  switch (normalized) {
    case "arb":
      return ["arbitrum"];
    case "binance":
    case "bnb":
      return ["bsc"];
    default:
      return [normalized];
  }
}

function findChainByHint(config: OnchainPublicConfig, hint?: string | null, fallback = true) {
  const chains = Object.values(config.chains || {});
  if (!hint) {
    return fallback
      ? config.chains[String(config.defaultChainId)] || chains[0] || null
      : null;
  }

  if (/^\d+$/.test(hint.trim())) {
    const matchedById = config.chains[String(Number(hint.trim()))];
    if (matchedById) return matchedById;
  }

  const candidates = unique(chainAliasCandidates(hint));
  for (const candidate of candidates) {
    const matched = chains.find((chain) => {
      const key = String((chain as any).key || "").toLowerCase();
      const name = String(chain.name || "").toLowerCase();
      return key === candidate || name.includes(candidate);
    });
    if (matched) return matched;
  }

  return fallback
    ? config.chains[String(config.defaultChainId)] || chains[0] || null
    : null;
}

function stripTrailingChainDirective(text: string) {
  return text.replace(
    /\s+on\s+(base|arbitrum|arb|bsc|binance|unichain|celo)(?:\s+mainnet|\s+one)?\s*$/i,
    "",
  );
}

function extractSingleChainHint(text: string) {
  const normalized = String(text || "").toLowerCase();
  const patterns: Array<{ hint: string; pattern: RegExp }> = [
    { hint: "base", pattern: /\bbase\b/ },
    { hint: "arbitrum", pattern: /\barbitrum\b|\barb\b/ },
    { hint: "bsc", pattern: /\bbsc\b|\bbinance\b|\bbnb smart chain\b/ },
    { hint: "unichain", pattern: /\bunichain\b/ },
    { hint: "celo", pattern: /\bcelo\b/ },
  ];

  for (const entry of patterns) {
    if (entry.pattern.test(normalized)) {
      return entry.hint;
    }
  }
  return null;
}

function parseAmount(value?: string | null) {
  const raw = String(value || "").trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  return raw;
}

function parseSendAction(text: string, config: OnchainPublicConfig): BantahBroWalletAction | null {
  const normalized = stripLeadingCommand(stripTrailingChainDirective(text));
  const recipientAddress = findAddress(normalized);
  const recipientUsername = findMentionedUsername(normalized);
  const match = normalized.match(
    /(?:send|transfer|tip)\s+([0-9]+(?:\.[0-9]+)?)\s+(.+?)(?:\s+to\b|\s+@|$)/i,
  );
  if (!match) return null;

  const chain = findChainByHint(config, extractSingleChainHint(text));
  if (!chain) return null;

  const amount = parseAmount(match[1]);
  const tokenQuery = cleanTokenQuery(match[2]);
  if (!amount || !tokenQuery || (!recipientAddress && !recipientUsername)) {
    return null;
  }

  return {
    kind: "send",
    chainId: chain.chainId,
    chainLabel: chain.name,
    amount,
    tokenQuery,
    recipientAddress: recipientAddress || `@${recipientUsername}`,
    recipientLabel: recipientUsername ? `@${recipientUsername}` : recipientAddress!,
    summary: `Send ${amount} ${tokenQuery} on ${chain.name} to ${recipientUsername ? `@${recipientUsername}` : recipientAddress}.`,
  };
}

function parseApproveAction(text: string, config: OnchainPublicConfig): BantahBroWalletAction | null {
  const normalized = stripLeadingCommand(stripTrailingChainDirective(text));
  const match = normalized.match(
    /approve\s+([0-9]+(?:\.[0-9]+)?)\s+(.+?)\s+(?:to|for)\s+(0x[a-fA-F0-9]{40})/i,
  );
  if (!match) return null;

  const chain = findChainByHint(config, extractSingleChainHint(text));
  const amount = parseAmount(match[1]);
  const tokenQuery = cleanTokenQuery(match[2]);
  const spender = normalizeEvmAddress(match[3]);
  if (!chain || !amount || !tokenQuery || !spender) return null;

  return {
    kind: "approve",
    chainId: chain.chainId,
    chainLabel: chain.name,
    amount,
    tokenQuery,
    spender,
    summary: `Approve ${amount} ${tokenQuery} on ${chain.name} for ${spender}.`,
  };
}

function parseRevokeAction(text: string, config: OnchainPublicConfig): BantahBroWalletAction | null {
  const normalized = stripLeadingCommand(stripTrailingChainDirective(text));
  const match = normalized.match(
    /revoke(?:\s+permissions?)?(?:\s+for)?\s+(.+?)\s+(?:from|for)\s+(0x[a-fA-F0-9]{40})/i,
  );
  if (!match) return null;

  const chain = findChainByHint(config, extractSingleChainHint(text));
  const tokenQuery = cleanTokenQuery(match[1]);
  const spender = normalizeEvmAddress(match[2]);
  if (!chain || !tokenQuery || !spender) return null;

  return {
    kind: "revoke",
    chainId: chain.chainId,
    chainLabel: chain.name,
    tokenQuery,
    spender,
    summary: `Revoke ${tokenQuery} spending permission on ${chain.name} from ${spender}.`,
  };
}

function parseSwapAction(text: string, config: OnchainPublicConfig): BantahBroWalletAction | null {
  const normalized = stripLeadingCommand(stripTrailingChainDirective(text));
  const chain = findChainByHint(config, extractSingleChainHint(text));
  if (!chain) return null;

  const swapMatch = normalized.match(/swap\s+([0-9]+(?:\.[0-9]+)?)\s+(.+?)\s+to\s+(.+)$/i);
  if (swapMatch) {
    const sellAmount = parseAmount(swapMatch[1]);
    const sellTokenQuery = cleanTokenQuery(swapMatch[2]);
    const buyTokenQuery = cleanTokenQuery(swapMatch[3]);
    if (sellAmount && sellTokenQuery && buyTokenQuery) {
      return {
        kind: "swap",
        chainId: chain.chainId,
        chainLabel: chain.name,
        mode: "swap",
        sellTokenQuery,
        buyTokenQuery,
        sellAmount,
        summary: `Swap ${sellAmount} ${sellTokenQuery} to ${buyTokenQuery} on ${chain.name}.`,
      };
    }
  }

  const buyMatch = normalized.match(/buy\s+\$?([0-9]+(?:\.[0-9]+)?)\s+(?:of\s+)?(.+)$/i);
  if (buyMatch) {
    const notionalUsd = parseAmount(buyMatch[1]);
    const buyTokenQuery = cleanTokenQuery(buyMatch[2]);
    if (notionalUsd && buyTokenQuery) {
      return {
        kind: "swap",
        chainId: chain.chainId,
        chainLabel: chain.name,
        mode: "buy",
        sellTokenQuery: "USDC",
        buyTokenQuery,
        notionalUsd,
        summary: `Buy ${humanUsd(Number(notionalUsd))} of ${buyTokenQuery} on ${chain.name}.`,
      };
    }
  }

  const sellPercentMatch = normalized.match(
    /sell\s+([0-9]+(?:\.[0-9]+)?)%\s+(?:of\s+)?(?:my\s+position\s+in\s+)?(.+)$/i,
  );
  if (sellPercentMatch) {
    const sellPercent = Number.parseFloat(sellPercentMatch[1]);
    const sellTokenQuery = cleanTokenQuery(sellPercentMatch[2]);
    if (Number.isFinite(sellPercent) && sellPercent > 0 && sellPercent <= 100 && sellTokenQuery) {
      return {
        kind: "swap",
        chainId: chain.chainId,
        chainLabel: chain.name,
        mode: "sell",
        sellTokenQuery,
        buyTokenQuery: "USDC",
        sellPercent,
        summary: `Sell ${sellPercent}% of ${sellTokenQuery} into USDC on ${chain.name}.`,
      };
    }
  }

  const sellAmountMatch = normalized.match(/sell\s+([0-9]+(?:\.[0-9]+)?)\s+(.+?)(?:\s+to\s+(.+))?$/i);
  if (sellAmountMatch) {
    const sellAmount = parseAmount(sellAmountMatch[1]);
    const sellTokenQuery = cleanTokenQuery(sellAmountMatch[2]);
    const buyTokenQuery = cleanTokenQuery(sellAmountMatch[3] || "USDC");
    if (sellAmount && sellTokenQuery && buyTokenQuery) {
      return {
        kind: "swap",
        chainId: chain.chainId,
        chainLabel: chain.name,
        mode: "sell",
        sellTokenQuery,
        buyTokenQuery,
        sellAmount,
        summary: `Sell ${sellAmount} ${sellTokenQuery} to ${buyTokenQuery} on ${chain.name}.`,
      };
    }
  }

  return null;
}

function parseBridgeAction(text: string, config: OnchainPublicConfig): BantahBroWalletAction | null {
  const normalized = stripLeadingCommand(text);
  const match = normalized.match(
    /bridge\s+([0-9]+(?:\.[0-9]+)?)\s+(.+?)(?:\s+from\s+([a-zA-Z0-9 -]+?))?\s+to\s+([a-zA-Z0-9 -]+)(?:\s+as\s+(.+))?$/i,
  );
  if (!match) return null;

  const amount = parseAmount(match[1]);
  const tokenQuery = cleanTokenQuery(match[2]);
  const fromChain = findChainByHint(
    config,
    match[3] ? match[3].trim() : String((config.chains[String(config.defaultChainId)] || {}).name || ""),
  );
  const toChain = findChainByHint(config, match[4]?.trim(), false);
  const toTokenQuery = cleanTokenQuery(match[5] || tokenQuery);

  if (!amount || !tokenQuery || !fromChain || !toChain || fromChain.chainId === toChain.chainId) {
    return null;
  }

  return {
    kind: "bridge",
    fromChainId: fromChain.chainId,
    fromChainLabel: fromChain.name,
    toChainId: toChain.chainId,
    toChainLabel: toChain.name,
    amount,
    tokenQuery,
    toTokenQuery,
    summary: `Bridge ${amount} ${tokenQuery} from ${fromChain.name} to ${toChain.name}.`,
  };
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(LIFI_API_KEY ? { "x-lifi-api-key": LIFI_API_KEY } : {}),
    },
    signal: AbortSignal.timeout(LIFI_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body === "object" && typeof (body as any).message === "string") {
        detail = `${detail} ${(body as any).message}`;
      }
    } catch {
      // ignore json parsing failures
    }
    throw new Error(`Wallet routing request failed: ${detail}`);
  }

  return response.json() as Promise<any>;
}

async function fetchLifiToken(chainId: number, token: string) {
  const url = new URL(`${LIFI_API_BASE}/token`);
  url.searchParams.set("chain", String(chainId));
  url.searchParams.set("token", token);
  return fetchJson(url.toString());
}

async function fetchLifiQuote(params: Record<string, string>) {
  const url = new URL(`${LIFI_API_BASE}/quote`);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return fetchJson(url.toString());
}

function buildResolvedToken(input: {
  symbol: string;
  address: string | null;
  decimals: number;
  isNative: boolean;
  label: string;
  priceUsd?: string | null;
}): ResolvedWalletToken {
  return {
    symbol: input.symbol,
    address: input.address,
    decimals: input.decimals,
    isNative: input.isNative,
    label: input.label,
    priceUsd: input.priceUsd ?? null,
  };
}

async function readTokenMetadataFromChain(chain: OnchainChainConfig, address: string) {
  const client = createPublicClient({
    transport: http(chain.rpcUrl),
  });

  const tokenAddress = address as Address;
  const [decimals, symbol, name] = await Promise.all([
    client.readContract({
      address: tokenAddress,
      abi: erc20TokenAbi,
      functionName: "decimals",
    }),
    client.readContract({
      address: tokenAddress,
      abi: erc20TokenAbi,
      functionName: "symbol",
    }),
    client.readContract({
      address: tokenAddress,
      abi: erc20TokenAbi,
      functionName: "name",
    }),
  ]);

  return {
    decimals: Number(decimals),
    symbol: String(symbol || "").trim() || "TOKEN",
    name: String(name || "").trim() || String(symbol || "").trim() || "Token",
  };
}

async function resolveTokenOnChain(chain: OnchainChainConfig, rawQuery: string): Promise<ResolvedWalletToken> {
  const query = cleanTokenQuery(rawQuery).replace(/^\$/g, "").trim();
  if (!query) {
    throw new Error("Token symbol or contract is required.");
  }

  const normalizedSymbol = query.toUpperCase();
  for (const symbol of chain.supportedTokens || []) {
    const configured = chain.tokens[symbol];
    if (!configured) continue;
    if (configured.symbol.toUpperCase() === normalizedSymbol) {
      let priceUsd: string | null = configured.symbol === "USDC" || configured.symbol === "USDT" ? "1" : null;
      if (!priceUsd) {
        try {
          const token = await fetchLifiToken(chain.chainId, configured.symbol);
          priceUsd = token?.priceUSD != null ? String(token.priceUSD) : null;
        } catch {
          priceUsd = null;
        }
      }

      return buildResolvedToken({
        symbol: configured.symbol,
        address: configured.isNative ? null : configured.address,
        decimals: configured.decimals,
        isNative: configured.isNative,
        label: configured.symbol,
        priceUsd,
      });
    }
  }

  const normalizedAddress = normalizeEvmAddress(query);
  if (normalizedAddress) {
    try {
      const token = await fetchLifiToken(chain.chainId, normalizedAddress);
      return buildResolvedToken({
        symbol: String(token.symbol || "").trim() || "TOKEN",
        address: normalizeEvmAddress(token.address) || normalizedAddress,
        decimals: Number(token.decimals || 18),
        isNative: false,
        label: String(token.name || token.symbol || normalizedAddress).trim(),
        priceUsd: token.priceUSD != null ? String(token.priceUSD) : null,
      });
    } catch {
      const metadata = await readTokenMetadataFromChain(chain, normalizedAddress);
      return buildResolvedToken({
        symbol: metadata.symbol,
        address: normalizedAddress,
        decimals: metadata.decimals,
        isNative: false,
        label: metadata.name,
      });
    }
  }

  const dexLookup = await lookupMarketByQuery({
    query,
    chainId: String((chain as any).key || chain.chainId),
    mode: "ticker-first",
  }).catch(() => null);
  const dexAddress = normalizeEvmAddress(dexLookup?.pair?.baseToken?.address || null);
  if (dexAddress) {
    try {
      const token = await fetchLifiToken(chain.chainId, dexAddress);
      return buildResolvedToken({
        symbol: String(token.symbol || "").trim() || String(dexLookup?.pair?.baseToken?.symbol || "TOKEN"),
        address: normalizeEvmAddress(token.address) || dexAddress,
        decimals: Number(token.decimals || 18),
        isNative: false,
        label: String(token.name || dexLookup?.pair?.baseToken?.name || token.symbol || query).trim(),
        priceUsd: token.priceUSD != null ? String(token.priceUSD) : null,
      });
    } catch {
      const metadata = await readTokenMetadataFromChain(chain, dexAddress);
      return buildResolvedToken({
        symbol: metadata.symbol,
        address: dexAddress,
        decimals: metadata.decimals,
        isNative: false,
        label: metadata.name,
      });
    }
  }

  const token = await fetchLifiToken(chain.chainId, query);
  if (!token) {
    throw new Error(`Could not resolve ${query} on ${chain.name}.`);
  }

  return buildResolvedToken({
    symbol: String(token.symbol || "").trim() || query.toUpperCase(),
    address: normalizeEvmAddress(token.address),
    decimals: Number(token.decimals || 18),
    isNative: Boolean(token.coinKey && String(token.coinKey).toUpperCase() === normalizedSymbol && !token.address),
    label: String(token.name || token.symbol || query).trim(),
    priceUsd: token.priceUSD != null ? String(token.priceUSD) : null,
  });
}

async function resolveRecipientAddress(input: string) {
  const directAddress = normalizeEvmAddress(input);
  if (directAddress) {
    return {
      address: directAddress,
      label: directAddress,
    };
  }

  const username = String(input || "").trim().replace(/^@/, "");
  if (!username) {
    throw new Error("Recipient is missing.");
  }

  const user = await storage.getUserByUsername(username);
  const address =
    normalizeEvmAddress((user as any)?.primaryWalletAddress) ||
    parseWalletAddresses((user as any)?.walletAddresses)[0] ||
    null;
  if (!address) {
    throw new Error(`@${username} does not have a linked wallet yet.`);
  }

  return {
    address,
    label: `@${username}`,
  };
}

async function readWalletBalance(params: {
  chain: OnchainChainConfig;
  walletAddress: string;
  token: ResolvedWalletToken;
}) {
  const client = createPublicClient({
    transport: http(params.chain.rpcUrl),
  });

  if (params.token.isNative) {
    return client.getBalance({ address: params.walletAddress as Address });
  }

  const tokenAddress = normalizeEvmAddress(params.token.address);
  if (!tokenAddress) {
    throw new Error(`${params.token.symbol} does not have a configured contract address on ${params.chain.name}.`);
  }

  const balance = await client.readContract({
    address: tokenAddress as Address,
    abi: erc20TokenAbi,
    functionName: "balanceOf",
    args: [params.walletAddress as Address],
  });

  return BigInt(String(balance || "0"));
}

function amountFromUsd(notionalUsd: string, token: ResolvedWalletToken) {
  const usd = Number.parseFloat(notionalUsd);
  const priceUsd =
    token.symbol.toUpperCase() === "USDC" || token.symbol.toUpperCase() === "USDT"
      ? 1
      : Number.parseFloat(String(token.priceUsd || ""));
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error("USD notional is invalid.");
  }
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error(`I could not price ${token.symbol} for a USD-sized buy yet. Try a token amount instead.`);
  }

  const amount = usd / priceUsd;
  return amount.toFixed(amount >= 1 ? 6 : 8).replace(/0+$/, "").replace(/\.$/, "");
}

function chooseFundingToken(chain: OnchainChainConfig) {
  if (chain.supportedTokens.includes("USDC")) return "USDC";
  if (chain.supportedTokens.includes("USDT")) return "USDT";
  if (chain.supportedTokens.includes("ETH")) return "ETH";
  if (chain.supportedTokens.includes("BNB")) return "BNB";
  return chain.supportedTokens[0];
}

async function quoteSwapRoute(params: {
  chain: OnchainChainConfig;
  mode: "buy" | "sell" | "swap";
  sellToken: ResolvedWalletToken;
  buyToken: ResolvedWalletToken;
  sellAmount: string;
  activeWalletAddress: string | null;
}) {
  const quote = await fetchLifiQuote({
    fromChain: String(params.chain.chainId),
    toChain: String(params.chain.chainId),
    fromToken: params.sellToken.address || "0x0000000000000000000000000000000000000000",
    toToken: params.buyToken.address || "0x0000000000000000000000000000000000000000",
    fromAddress: params.activeWalletAddress || "0x0000000000000000000000000000000000000001",
    toAddress: params.activeWalletAddress || "0x0000000000000000000000000000000000000001",
    fromAmount: stringifyAtomic(parseUnits(params.sellAmount, params.sellToken.decimals)),
    slippage: "0.005",
    integrator: "bantahbro",
  });

  return {
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: params.sellAmount,
    sellAmountAtomic: parseUnits(params.sellAmount, params.sellToken.decimals),
    quote,
  };
}

function stringifyAtomic(value: bigint) {
  return value.toString(10);
}

export function parseBantahBroWalletAction(params: {
  text: string;
  actor?: BantahBroWalletActor | null;
}): BantahBroWalletAction | null {
  const config = getOnchainServerConfig();
  const text = normalizeSearchText(params.text);
  if (!text) return null;

  const candidate =
    parseBridgeAction(text, config) ||
    parseSendAction(text, config) ||
    parseApproveAction(text, config) ||
    parseRevokeAction(text, config) ||
    parseSwapAction(text, config);

  return candidate ? bantahBroWalletActionSchema.parse(candidate) : null;
}

export async function prepareBantahBroWalletAction(params: {
  action: BantahBroWalletAction;
  actor?: BantahBroWalletActor | null;
  walletAddress?: string | null;
}): Promise<BantahBroPreparedWalletAction> {
  const config = getOnchainServerConfig();
  const activeWalletAddress =
    normalizeEvmAddress(params.walletAddress) ||
    normalizeEvmAddress(params.actor?.walletAddress) ||
    null;

  switch (params.action.kind) {
    case "send": {
      const chain = findChainByHint(config, String(params.action.chainId));
      if (!chain) throw new Error("Unsupported send chain.");
      const token = await resolveTokenOnChain(chain, params.action.tokenQuery);
      const recipient = await resolveRecipientAddress(params.action.recipientAddress);
      const amountAtomic = parseUnits(params.action.amount, token.decimals);

      return bantahBroPreparedWalletActionSchema.parse({
        kind: "send",
        chainId: chain.chainId,
        chainLabel: chain.name,
        amount: params.action.amount,
        amountAtomic: stringifyAtomic(amountAtomic),
        token,
        recipientAddress: recipient.address,
        recipientLabel: recipient.label,
        summary: params.action.summary.replace(params.action.recipientAddress, recipient.label),
      });
    }
    case "approve": {
      const chain = findChainByHint(config, String(params.action.chainId));
      if (!chain) throw new Error("Unsupported approval chain.");
      const token = await resolveTokenOnChain(chain, params.action.tokenQuery);
      const amountAtomic = parseUnits(params.action.amount, token.decimals);

      return bantahBroPreparedWalletActionSchema.parse({
        kind: "approve",
        chainId: chain.chainId,
        chainLabel: chain.name,
        amount: params.action.amount,
        amountAtomic: stringifyAtomic(amountAtomic),
        token,
        spender: params.action.spender,
        summary: params.action.summary,
      });
    }
    case "revoke": {
      const chain = findChainByHint(config, String(params.action.chainId));
      if (!chain) throw new Error("Unsupported revoke chain.");
      const token = await resolveTokenOnChain(chain, params.action.tokenQuery);

      return bantahBroPreparedWalletActionSchema.parse({
        kind: "revoke",
        chainId: chain.chainId,
        chainLabel: chain.name,
        amountAtomic: "0",
        token,
        spender: params.action.spender,
        summary: params.action.summary,
      });
    }
    case "swap": {
      const chain = findChainByHint(config, String(params.action.chainId));
      if (!chain) throw new Error("Unsupported swap chain.");

      const normalizedAction = { ...params.action };
      if (normalizedAction.mode === "buy" && normalizedAction.sellTokenQuery === "USDC") {
        normalizedAction.sellTokenQuery = chooseFundingToken(chain);
      }

      let [sellToken, buyToken] = await Promise.all([
        resolveTokenOnChain(chain, normalizedAction.sellTokenQuery),
        resolveTokenOnChain(chain, normalizedAction.buyTokenQuery),
      ]);

      if (!activeWalletAddress && normalizedAction.sellPercent) {
        throw new Error("Sign in with your linked wallet before selling a percentage position.");
      }

      let sellAmount = normalizedAction.sellAmount || null;
      if (!sellAmount && normalizedAction.notionalUsd) {
        sellAmount = amountFromUsd(normalizedAction.notionalUsd, sellToken);
      }
      if (!sellAmount && normalizedAction.sellPercent && activeWalletAddress) {
        const balance = await readWalletBalance({
          chain,
          walletAddress: activeWalletAddress,
          token: sellToken,
        });
        const percentAtomic = (balance * BigInt(Math.round(normalizedAction.sellPercent * 100))) / 10_000n;
        if (percentAtomic <= 0n) {
          throw new Error(`Your ${sellToken.symbol} balance is too low for that percentage sale.`);
        }
        sellAmount = formatUnits(percentAtomic, sellToken.decimals);
      }
      if (!sellAmount) {
        throw new Error("Swap amount is missing.");
      }

      let quoteResult: Awaited<ReturnType<typeof quoteSwapRoute>> | null = null;
      let lastQuoteError: Error | null = null;

      try {
        quoteResult = await quoteSwapRoute({
          chain,
          mode: normalizedAction.mode,
          sellToken,
          buyToken,
          sellAmount,
          activeWalletAddress,
        });
      } catch (error) {
        lastQuoteError = error instanceof Error ? error : new Error("Swap routing failed.");
      }

      if (!quoteResult && normalizedAction.mode === "buy" && normalizedAction.notionalUsd) {
        const fallbackFundingSymbols = unique(
          (chain.supportedTokens || []).filter(
            (symbol) => symbol !== sellToken.symbol && symbol !== buyToken.symbol,
          ),
        );

        for (const fallbackSymbol of fallbackFundingSymbols) {
          try {
            const fallbackSellToken = await resolveTokenOnChain(chain, fallbackSymbol);
            const fallbackSellAmount = amountFromUsd(normalizedAction.notionalUsd, fallbackSellToken);
            quoteResult = await quoteSwapRoute({
              chain,
              mode: normalizedAction.mode,
              sellToken: fallbackSellToken,
              buyToken,
              sellAmount: fallbackSellAmount,
              activeWalletAddress,
            });
            sellToken = fallbackSellToken;
            sellAmount = fallbackSellAmount;
            break;
          } catch (fallbackError) {
            lastQuoteError =
              fallbackError instanceof Error ? fallbackError : new Error("Swap routing failed.");
          }
        }
      }

      if (!quoteResult) {
        throw lastQuoteError || new Error("No available quotes for the requested transfer.");
      }

      const { quote, sellAmountAtomic } = quoteResult;

      const estimatedBuyAmount = formatUnits(
        BigInt(String(quote?.estimate?.toAmount || "0")),
        Number(quote?.action?.toToken?.decimals || buyToken.decimals),
      );

      return bantahBroPreparedWalletActionSchema.parse({
        kind: "swap",
        chainId: chain.chainId,
        chainLabel: chain.name,
        mode: normalizedAction.mode,
        summary: normalizedAction.summary,
        sellToken: {
          ...sellToken,
          priceUsd: sellToken.priceUsd ?? null,
        },
        buyToken: {
          ...buyToken,
          priceUsd: buyToken.priceUsd ?? null,
        },
        sellAmount,
        sellAmountAtomic: stringifyAtomic(sellAmountAtomic),
        estimatedBuyAmount,
        quote: {
          allowanceTarget: normalizeEvmAddress(quote?.estimate?.approvalAddress || null),
          transaction: {
            to: String(quote?.transactionRequest?.to || ""),
            data: String(quote?.transactionRequest?.data || "0x"),
            value:
              quote?.transactionRequest?.value != null
                ? String(quote.transactionRequest.value)
                : null,
          },
          priceImpactBps:
            quote?.estimate?.priceImpact != null ? String(quote.estimate.priceImpact) : null,
          minBuyAmount:
            quote?.estimate?.toAmountMin != null
              ? formatUnits(
                  BigInt(String(quote.estimate.toAmountMin)),
                  Number(quote?.action?.toToken?.decimals || buyToken.decimals),
                )
              : null,
        },
      });
    }
    case "bridge": {
      const fromChain = findChainByHint(config, String(params.action.fromChainId));
      const toChain = findChainByHint(config, String(params.action.toChainId), false);
      if (!fromChain || !toChain) {
        throw new Error("Unsupported bridge route.");
      }

      const [fromToken, destinationToken] = await Promise.all([
        resolveTokenOnChain(fromChain, params.action.tokenQuery),
        resolveTokenOnChain(toChain, params.action.toTokenQuery || params.action.tokenQuery),
      ]);

      const amountAtomic = parseUnits(params.action.amount, fromToken.decimals);
      const quote = await fetchLifiQuote({
        fromChain: String(fromChain.chainId),
        toChain: String(toChain.chainId),
        fromToken: fromToken.address || "0x0000000000000000000000000000000000000000",
        toToken: destinationToken.address || "0x0000000000000000000000000000000000000000",
        fromAddress: activeWalletAddress || "0x0000000000000000000000000000000000000001",
        toAddress: activeWalletAddress || "0x0000000000000000000000000000000000000001",
        fromAmount: stringifyAtomic(amountAtomic),
        slippage: "0.005",
        integrator: "bantahbro",
      });

      const estimatedReceivedAmount = formatUnits(
        BigInt(String(quote?.estimate?.toAmount || "0")),
        Number(quote?.action?.toToken?.decimals || destinationToken.decimals),
      );

      return bantahBroPreparedWalletActionSchema.parse({
        kind: "bridge",
        fromChainId: fromChain.chainId,
        fromChainLabel: fromChain.name,
        toChainId: toChain.chainId,
        toChainLabel: toChain.name,
        summary: params.action.summary,
        token: {
          ...fromToken,
          priceUsd: fromToken.priceUsd ?? null,
        },
        destinationToken: {
          ...destinationToken,
          priceUsd: destinationToken.priceUsd ?? null,
        },
        amount: params.action.amount,
        amountAtomic: stringifyAtomic(amountAtomic),
        estimatedReceivedAmount,
        quote: {
          allowanceTarget: normalizeEvmAddress(quote?.estimate?.approvalAddress || null),
          transaction: {
            to: String(quote?.transactionRequest?.to || ""),
            data: String(quote?.transactionRequest?.data || "0x"),
            value:
              quote?.transactionRequest?.value != null
                ? String(quote.transactionRequest.value)
                : null,
          },
          minReceiveAmount:
            quote?.estimate?.toAmountMin != null
              ? formatUnits(
                  BigInt(String(quote.estimate.toAmountMin)),
                  Number(quote?.action?.toToken?.decimals || destinationToken.decimals),
                )
              : null,
        },
      });
    }
  }
}
