import type { Action, Plugin, Provider } from "@elizaos/core";
import { lookupMarketByQuery } from "./bantahBro/tokenIntelligence";

function extractRequestedChain(text: string) {
  const match = text.match(/\b(?:on|in)\s+(base|solana|arbitrum|arb|bsc|binance|bnb)\b/i);
  return match?.[1] || null;
}

function extractPriceQuery(text: string) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return null;

  const patterns = [
    /\bprice of\s+([a-z0-9$._/-]+)(?:\s+on\s+[a-z0-9_-]+)?\b/i,
    /\bhow much is\s+([a-z0-9$._/-]+)(?:\s+on\s+[a-z0-9_-]+)?\b/i,
    /\b([a-z0-9$._/-]+)\s+price\b/i,
    /\bquote for\s+([a-z0-9$._/-]+)(?:\s+on\s+[a-z0-9_-]+)?\b/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/^\$/g, "");
    }
  }

  return null;
}

function formatUsd(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return "n/a";
  if (value >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toPrecision(4)}`;
}

function formatChange(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function buildLiveMarketReply(query: string, lookup: Awaited<ReturnType<typeof lookupMarketByQuery>>) {
  if (!lookup.pair) {
    return `I couldn't verify a live ${query} market right now, so I won't guess the price.`;
  }

  const pair = lookup.pair;
  const symbol = pair.baseToken.symbol || query.toUpperCase();
  const price = formatUsd(pair.priceUsd);
  const h1 = formatChange(pair.priceChange.h1);
  const h24 = formatChange(pair.priceChange.h24);

  return [
    `${pair.baseToken.name || symbol} (${symbol}) is trading around ${price} on ${pair.chainId}.`,
    `1h: ${h1} | 24h: ${h24} | liquidity: ${formatUsd(pair.liquidityUsd)}.`,
    pair.url ? `Chart: ${pair.url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const bantahBroMarketProvider: Provider = {
  name: "BANTAHBRO_MARKET_CONTEXT",
  description:
    "Live DexScreener-backed token and market context for price questions. Use this instead of guessing current prices.",
  position: -5,
  get: async (_runtime, message) => {
    const text = String(message?.content?.text || "").trim();
    const query = extractPriceQuery(text);

    if (!query) {
      return {
        values: {
          bantahbroMarketLookup: null,
        },
        data: {
          bantahbroMarketLookup: null,
        },
        text: "",
      };
    }

    try {
      const lookup = await lookupMarketByQuery({
        query,
        chainId: extractRequestedChain(text),
      });

      if (!lookup.pair) {
        return {
          values: {
            bantahbroMarketLookup: {
              query,
              found: false,
            },
          },
          data: {
            bantahbroMarketLookup: {
              query,
              found: false,
            },
          },
          text: [
            "LIVE MARKET CONTEXT",
            `Requested asset: ${query}`,
            "Result: No live DexScreener pair resolved.",
            "Instruction: Do not guess a current price. Say you could not verify it live right now.",
          ].join("\n"),
        };
      }

      const pair = lookup.pair;
      const symbol = pair.baseToken.symbol || query.toUpperCase();
      const tokenName = pair.baseToken.name || symbol;

      return {
        values: {
          bantahbroMarketLookup: {
            query,
            found: true,
            symbol,
            tokenName,
            chainId: pair.chainId,
            priceUsd: pair.priceUsd,
            pairUrl: pair.url,
          },
        },
        data: {
          bantahbroMarketLookup: lookup,
        },
        text: [
          "LIVE MARKET CONTEXT",
          `Requested asset: ${query}`,
          `Resolved token: ${tokenName} (${symbol})`,
          `Resolved chain: ${pair.chainId}`,
          `Verified live price: ${formatUsd(pair.priceUsd)}`,
          `1h change: ${formatChange(pair.priceChange.h1)}`,
          `24h change: ${formatChange(pair.priceChange.h24)}`,
          `Liquidity: ${formatUsd(pair.liquidityUsd)}`,
          `Pairs considered: ${lookup.pairCount}`,
          `Chart: ${pair.url || "n/a"}`,
          `Verified at: ${lookup.generatedAt}`,
          "Instruction: Use this live market data in your answer. Never invent a current price from memory.",
        ].join("\n"),
      };
    } catch (error) {
      return {
        values: {
          bantahbroMarketLookup: {
            query,
            found: false,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        data: {
          bantahbroMarketLookup: {
            query,
            found: false,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        text: [
          "LIVE MARKET CONTEXT",
          `Requested asset: ${query}`,
          `Lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          "Instruction: Do not guess a current price. Say the live market lookup failed.",
        ].join("\n"),
      };
    }
  },
};

const lookupLiveMarketAction: Action = {
  name: "LOOKUP_LIVE_MARKET",
  similes: ["GET_LIVE_PRICE", "CHECK_TOKEN_PRICE", "VERIFY_MARKET_PRICE"],
  description:
    "Use this for current token or coin price questions like 'price of bitcoin', 'how much is ETH', or 'btc price on base'. It fetches live market data and should be preferred over model memory.",
  validate: async (_runtime, message) => {
    return Boolean(extractPriceQuery(String(message?.content?.text || "")));
  },
  handler: async (_runtime, message, _state, _options, callback) => {
    const text = String(message?.content?.text || "").trim();
    const query = extractPriceQuery(text);

    if (!query || !callback) {
      return;
    }

    try {
      const lookup = await lookupMarketByQuery({
        query,
        chainId: extractRequestedChain(text),
      });

      await callback({
        text: buildLiveMarketReply(query, lookup),
        thought: `Fetched live market data for ${query}.`,
        actions: ["LOOKUP_LIVE_MARKET"],
      });

      return;
    } catch (error) {
      await callback({
        text: `I couldn't complete a live market lookup for ${query} just now, so I won't guess the price.`,
        thought: `Live market lookup failed for ${query}.`,
        actions: ["LOOKUP_LIVE_MARKET"],
      });

      return;
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "price of bitcoin",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let me pull the live BTC market before I answer.",
          actions: ["LOOKUP_LIVE_MARKET"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "how much is eth on base",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Checking the live ETH/Base market now.",
          actions: ["LOOKUP_LIVE_MARKET"],
        },
      },
    ],
  ],
};

export const bantahBroLiveMarketPlugin: Plugin = {
  name: "bantahbro-live-market",
  description: "Provides live token price context to BantahBro before it answers Telegram market questions.",
  actions: [lookupLiveMarketAction],
  providers: [bantahBroMarketProvider],
};
