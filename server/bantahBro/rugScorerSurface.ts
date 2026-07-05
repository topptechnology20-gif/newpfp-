import { recordRugScorerV2Scan } from "./rugScorerV2Persistence";
import { searchRugScorerV2Token } from "./rugScorerV2Service";
import { buildBantahBroTokenScanUrl } from "./telegramSupport";

export type BantahBroSurfaceScanMode = "analyze" | "rug" | "runner";

export type BantahBroSurfaceScanIntent = {
  query: string;
  chainId: string | null;
  matchType: "explicit" | "address" | "ticker" | "phrase";
  confidence: "high" | "medium";
  originalText: string;
};

export type BantahBroSurfaceScan = Awaited<ReturnType<typeof searchRugScorerV2Token>> & {
  intent: BantahBroSurfaceScanIntent;
  scanUrl: string;
};

const CHAIN_ALIASES: Array<{ id: string; terms: string[] }> = [
  { id: "solana", terms: ["solana", "sol"] },
  { id: "base", terms: ["base", "8453"] },
  { id: "arbitrum", terms: ["arbitrum", "arb", "42161"] },
  { id: "bsc", terms: ["bsc", "bnb", "binance", "56"] },
];

const PHRASE_STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "an",
  "analyze",
  "any",
  "are",
  "at",
  "best",
  "bullish",
  "can",
  "chart",
  "changed",
  "check",
  "coin",
  "coins",
  "compare",
  "contract",
  "created",
  "creator",
  "current",
  "find",
  "for",
  "give",
  "holders",
  "how",
  "i",
  "is",
  "it",
  "liquidity",
  "lock",
  "locked",
  "live",
  "market",
  "markets",
  "me",
  "meme",
  "momentum",
  "my",
  "narrative",
  "need",
  "now",
  "of",
  "on",
  "or",
  "please",
  "pls",
  "price",
  "project",
  "quick",
  "read",
  "review",
  "risk",
  "risky",
  "rug",
  "runner",
  "runners",
  "safe",
  "safety",
  "scan",
  "score",
  "show",
  "signal",
  "signals",
  "strongest",
  "tell",
  "this",
  "ticker",
  "tickers",
  "today",
  "to",
  "tomorrow",
  "token",
  "tokens",
  "top",
  "volume",
  "vs",
  "what",
  "which",
  "with",
  "yesterday",
]);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectChainId(text: string) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return null;

  for (const entry of CHAIN_ALIASES) {
    if (
      entry.terms.some((term) => {
        const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i");
        return pattern.test(normalized);
      })
    ) {
      return entry.id;
    }
  }

  return null;
}

function stripCommandPrefix(text: string) {
  return String(text || "").trim().replace(/^\/(?:analyze|rug|runner)(?:@\w+)?\s*/i, "");
}

function cleanSearchText(text: string) {
  return stripCommandPrefix(text)
    .replace(/@\w+/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[|,:;()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAddressQuery(text: string) {
  const evmMatch = text.match(/\b0x[a-fA-F0-9]{40}\b/);
  if (evmMatch) {
    return evmMatch[0];
  }

  const solanaMatch = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
  if (solanaMatch) {
    return solanaMatch[0];
  }

  return null;
}

function extractTickerQuery(text: string) {
  const match = [...text.matchAll(/\$([a-zA-Z][a-zA-Z0-9_!]{1,24})/g)][0];
  return match ? match[1].toUpperCase() : null;
}

function buildPhraseCandidate(text: string) {
  const cleaned = cleanSearchText(text);
  if (!cleaned) return null;

  const tokens = cleaned
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-zA-Z0-9$]+|[^a-zA-Z0-9_!.\-]+$/g, ""))
    .filter(Boolean);

  const filtered = tokens.filter((token) => {
    const normalized = token.replace(/^\$/g, "").trim().toLowerCase();
    if (!normalized) return false;
    if (PHRASE_STOPWORDS.has(normalized)) return false;
    if (CHAIN_ALIASES.some((entry) => entry.terms.includes(normalized))) return false;
    return /[a-zA-Z]/.test(normalized);
  });

  if (filtered.length === 0 || filtered.length > 4) {
    return null;
  }

  return filtered.join(" ").trim() || null;
}

function resolvePhraseConfidence(text: string, phrase: string) {
  const tokenCount = phrase.split(/\s+/).length;
  if (tokenCount === 1) return "high" as const;
  if (/^\/(?:analyze|rug|runner)\b/i.test(text)) return "high" as const;
  if (/\b(analyze|scan|score|review|check)\b/i.test(text)) return "high" as const;
  return "medium" as const;
}

export function extractBantahBroSurfaceScanIntent(
  text: string,
  options: {
    chainId?: string | null;
    allowPhraseFallback?: boolean;
  } = {},
): BantahBroSurfaceScanIntent | null {
  const originalText = String(text || "").trim();
  if (!originalText) return null;

  const chainId = options.chainId || detectChainId(originalText);
  const addressQuery = extractAddressQuery(originalText);
  if (addressQuery) {
    return {
      query: addressQuery,
      chainId,
      matchType: "address",
      confidence: "high",
      originalText,
    };
  }

  const tickerQuery = extractTickerQuery(originalText);
  if (tickerQuery) {
    return {
      query: tickerQuery,
      chainId,
      matchType: "ticker",
      confidence: "high",
      originalText,
    };
  }

  if (options.allowPhraseFallback === false) {
    return null;
  }

  const phrase = buildPhraseCandidate(originalText);
  if (!phrase) return null;

  return {
    query: phrase,
    chainId,
    matchType: "phrase",
    confidence: resolvePhraseConfidence(originalText, phrase),
    originalText,
  };
}

export async function runBantahBroSurfaceScan(params: {
  text?: string;
  query?: string | null;
  chainId?: string | null;
  allowPhraseFallback?: boolean;
}): Promise<BantahBroSurfaceScan | null> {
  const explicitQuery = String(params.query || "").trim();
  const intent =
    explicitQuery.length > 0
      ? {
          query: explicitQuery,
          chainId: params.chainId || null,
          matchType: "explicit" as const,
          confidence: "high" as const,
          originalText: explicitQuery,
        }
      : extractBantahBroSurfaceScanIntent(params.text || "", {
          chainId: params.chainId,
          allowPhraseFallback: params.allowPhraseFallback,
        });

  if (!intent) return null;

  const payload = await searchRugScorerV2Token({
    query: intent.query,
    chainId: intent.chainId,
  });

  void recordRugScorerV2Scan(payload.token).catch((error) => {
    console.warn("[BantahBro Rug V2] Failed to persist shared scan:", error);
  });

  return {
    ...payload,
    intent,
    scanUrl: buildBantahBroTokenScanUrl(payload.token.chainId, payload.token.tokenAddress),
  };
}

function titleCase(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  if (!normalized) return "Unknown";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatUsd(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "n/a";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toPrecision(4)}`;
}

function formatPercent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}%`;
}

function displayTokenLabel(token: { tokenSymbol: string | null; tokenName: string | null; tokenAddress: string }) {
  if (token.tokenSymbol?.trim()) return `$${token.tokenSymbol.trim()}`;
  if (token.tokenName?.trim()) return token.tokenName.trim();
  return `${token.tokenAddress.slice(0, 6)}...${token.tokenAddress.slice(-4)}`;
}

function buildHolderLine(scan: BantahBroSurfaceScan) {
  if (scan.token.holders.status !== "available") {
    return `Holders: ${titleCase(scan.token.holders.status).replace(/_/g, " ")}`;
  }

  const topHolder =
    typeof scan.token.holders.topHolderPercent === "number"
      ? `${scan.token.holders.topHolderPercent.toFixed(1)}% top holder`
      : "top holder n/a";
  const top10 =
    typeof scan.token.holders.top10HolderPercent === "number"
      ? `${scan.token.holders.top10HolderPercent.toFixed(1)}% top 10`
      : "top 10 n/a";
  return `Holders: ${topHolder} | ${top10}`;
}

function buildRiskDrivers(scan: BantahBroSurfaceScan) {
  if (scan.token.rug.reasons.length === 0) return null;
  return `Key signals: ${scan.token.rug.reasons
    .slice(0, 3)
    .map((reason) => reason.label)
    .join("; ")}.`;
}

export function buildBantahBroChatScanReply(
  scan: BantahBroSurfaceScan,
  mode: BantahBroSurfaceScanMode,
) {
  const label = displayTokenLabel(scan.token);
  const heading =
    mode === "rug"
      ? `Rug scan for ${label} on ${scan.token.chainLabel}`
      : mode === "runner"
        ? `Runner scan for ${label} on ${scan.token.chainLabel}`
        : `Live scan for ${label} on ${scan.token.chainLabel}`;
  const scoreLine =
    mode === "runner"
      ? `Runner ${scan.analysis.momentum.score}/100 (${titleCase(scan.analysis.momentum.momentumLevel)}) | Rug ${scan.token.rug.score}/100 (${titleCase(scan.token.rug.riskLevel)})`
      : `Rug ${scan.token.rug.score}/100 (${titleCase(scan.token.rug.riskLevel)}) | Runner ${scan.analysis.momentum.score}/100 (${titleCase(scan.analysis.momentum.momentumLevel)})`;
  const verdict = mode === "runner" ? scan.analysis.momentum.verdict : scan.token.rug.verdict;

  return [
    heading,
    scoreLine,
    `Price ${formatUsd(scan.token.priceUsd)} | Liquidity ${formatUsd(scan.token.liquidityUsd)} | 24H volume ${formatUsd(scan.token.volumeH24)}`,
    `24H ${formatPercent(scan.token.priceChangeH24)} | Buys ${scan.token.txnsH24.buys} vs sells ${scan.token.txnsH24.sells}`,
    buildHolderLine(scan),
    `Contract: ${scan.token.contractRisk.label} | LP: ${scan.token.liquidityLock.label}`,
    verdict,
    buildRiskDrivers(scan),
    `Open full live scan: ${scan.scanUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function compactStatusLabel(status: "safe" | "warning" | "danger" | "unknown") {
  if (status === "warning") return "warn";
  if (status === "danger") return "risk";
  return status;
}

export function buildBantahBroTwitterScanReply(
  scan: BantahBroSurfaceScan,
  mode: BantahBroSurfaceScanMode,
) {
  const label = displayTokenLabel(scan.token);
  const base =
    mode === "runner"
      ? `${label} ${scan.token.chainLabel}: runner ${scan.analysis.momentum.score}/100, rug ${scan.token.rug.score}/100.`
      : `${label} ${scan.token.chainLabel}: rug ${scan.token.rug.score}/100 (${scan.token.rug.riskLevel}), runner ${scan.analysis.momentum.score}/100.`;
  const market = `24H ${formatPercent(scan.token.priceChangeH24)}, liq ${formatUsd(scan.token.liquidityUsd)}, vol ${formatUsd(scan.token.volumeH24)}.`;
  const safety = `Contract ${compactStatusLabel(scan.token.contractRisk.status)}, LP ${compactStatusLabel(scan.token.liquidityLock.status)}.`;
  const holders =
    scan.token.holders.status === "available" && typeof scan.token.holders.top10HolderPercent === "number"
      ? `Top10 ${scan.token.holders.top10HolderPercent.toFixed(0)}%.`
      : `Holders ${scan.token.holders.status}.`;

  return [base, market, safety, holders].join(" ");
}

export function buildBantahBroScanPrompt(mode: BantahBroSurfaceScanMode) {
  if (mode === "rug") {
    return "Send a token ticker or contract to score. Example: rug score PEPE, /rug base 0x4200000000000000000000000000000000000006";
  }
  if (mode === "runner") {
    return "Send a token ticker or contract to scan. Example: runner score BONK or check Base WETH runner score.";
  }
  return "Send a token ticker or contract to scan. Example: analyze PEPE, review ALIEN BOY, or paste a contract address.";
}
