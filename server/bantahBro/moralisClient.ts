import type { BantahBroHolderMetrics, BantahBroTokenRef } from "@shared/bantahBro";

type MoralisTopHolder = Record<string, unknown>;

const MORALIS_SOLANA_API_BASE =
  process.env.MORALIS_SOLANA_API_BASE?.replace(/\/+$/, "") ||
  "https://solana-gateway.moralis.io";

const MORALIS_EVM_API_BASE =
  process.env.MORALIS_EVM_API_BASE?.replace(/\/+$/, "") ||
  "https://deep-index.moralis.io/api/v2.2";
const MORALIS_FETCH_TIMEOUT_MS = Number(
  process.env.BANTAHBRO_MORALIS_FETCH_TIMEOUT_MS || 4_000,
);

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toNullableNumber(value: unknown): number | null {
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function emptyHolderMetrics(
  ref: BantahBroTokenRef,
  status: BantahBroHolderMetrics["status"],
  network: string | null,
  error: string | null,
): BantahBroHolderMetrics {
  return {
    source: "moralis",
    status,
    chainId: ref.chainId,
    network,
    error,
    totalHolders: null,
    holderSupply: {
      top10SupplyPercent: null,
      top25SupplyPercent: null,
      top50SupplyPercent: null,
      top100SupplyPercent: null,
    },
    holderChange: {
      m5ChangePercent: null,
      h1ChangePercent: null,
      h6ChangePercent: null,
      h24ChangePercent: null,
    },
    holderDistribution: {},
    topHolders: [],
  };
}

function resolveMoralisNetwork(chainId: string): {
  kind: "solana" | "evm" | "unsupported";
  network: string | null;
} {
  const normalized = chainId.trim().toLowerCase();
  if (normalized === "solana" || normalized === "sol") {
    return { kind: "solana", network: "mainnet" };
  }
  if (normalized === "solana-devnet" || normalized === "devnet") {
    return { kind: "solana", network: "devnet" };
  }

  const evmAliases: Record<string, string> = {
    ethereum: "eth",
    eth: "eth",
    "1": "eth",
    "0x1": "0x1",
    base: "base",
    "8453": "base",
    "0x2105": "0x2105",
    "base-sepolia": "base sepolia",
    "84532": "base sepolia",
    "0x14a34": "0x14a34",
    bsc: "bsc",
    "56": "bsc",
    "0x38": "0x38",
    arbitrum: "arbitrum",
    "42161": "arbitrum",
    "0xa4b1": "0xa4b1",
    optimism: "optimism",
    "10": "optimism",
    "0xa": "0xa",
    polygon: "polygon",
    "137": "polygon",
    "0x89": "0x89",
  };

  const network = evmAliases[normalized];
  return network ? { kind: "evm", network } : { kind: "unsupported", network: null };
}

async function fetchJson(url: string, apiKey: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-API-Key": apiKey,
      "X-Api-Key": apiKey,
    },
    signal: AbortSignal.timeout(MORALIS_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Moralis request failed with ${response.status}`);
  }

  return response.json() as Promise<unknown>;
}

function normalizeHolderDistribution(value: unknown): Record<string, number> {
  const raw = getRecord(value);
  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, item]) => [key, toNumber(item, Number.NaN)] as const)
      .filter((entry): entry is readonly [string, number] => Number.isFinite(entry[1])),
  );
}

function normalizeSolanaTopHolder(item: MoralisTopHolder) {
  return {
    address: String(
      item.ownerAddress ||
        item.owner_address ||
        item.address ||
        item.walletAddress ||
        "",
    ),
    percentage: toNullableNumber(
      item.percentageRelativeToTotalSupply ||
        item.percentage_relative_to_total_supply ||
        item.percentage ||
        item.supplyPercent,
    ),
    balanceFormatted: toStringOrNull(item.balanceFormatted || item.balance_formatted || item.amount),
    isContract: null,
    label: toStringOrNull(item.ownerAddressLabel || item.owner_address_label || item.label),
    entity: toStringOrNull(item.entity),
  };
}

function normalizeEvmTopHolder(item: MoralisTopHolder) {
  return {
    address: String(item.owner_address || item.ownerAddress || item.address || ""),
    percentage: toNullableNumber(
      item.percentage_relative_to_total_supply || item.percentageRelativeToTotalSupply,
    ),
    balanceFormatted: toStringOrNull(item.balance_formatted || item.balanceFormatted),
    isContract: typeof item.is_contract === "boolean" ? item.is_contract : null,
    label: toStringOrNull(item.owner_address_label || item.ownerAddressLabel || item.label),
    entity: toStringOrNull(item.entity),
  };
}

async function fetchSolanaHolders(
  ref: BantahBroTokenRef,
  apiKey: string,
  network: string,
): Promise<BantahBroHolderMetrics> {
  const metricsUrl = `${MORALIS_SOLANA_API_BASE}/token/${encodeURIComponent(
    network,
  )}/holders/${encodeURIComponent(ref.tokenAddress)}`;
  const topUrl = `${MORALIS_SOLANA_API_BASE}/token/${encodeURIComponent(
    network,
  )}/${encodeURIComponent(ref.tokenAddress)}/top-holders?limit=10`;

  const [metricsData, topData] = await Promise.all([
    fetchJson(metricsUrl, apiKey),
    fetchJson(topUrl, apiKey).catch(() => null),
  ]);

  const holderSupply = getRecord(getRecord(metricsData).holderSupply);
  const holderChange = getRecord(getRecord(metricsData).holderChange);
  const topResult = Array.isArray(getRecord(topData).result)
    ? (getRecord(topData).result as MoralisTopHolder[])
    : [];

  return {
    source: "moralis",
    status: "available",
    chainId: ref.chainId,
    network,
    error: null,
    totalHolders: toNullableNumber(getRecord(metricsData).totalHolders),
    holderSupply: {
      top10SupplyPercent: toNullableNumber(getRecord(holderSupply.top10).supplyPercent),
      top25SupplyPercent: toNullableNumber(getRecord(holderSupply.top25).supplyPercent),
      top50SupplyPercent: toNullableNumber(getRecord(holderSupply.top50).supplyPercent),
      top100SupplyPercent: toNullableNumber(getRecord(holderSupply.top100).supplyPercent),
    },
    holderChange: {
      m5ChangePercent: toNullableNumber(getRecord(holderChange["5min"]).changePercent),
      h1ChangePercent: toNullableNumber(getRecord(holderChange["1h"]).changePercent),
      h6ChangePercent: toNullableNumber(getRecord(holderChange["6h"]).changePercent),
      h24ChangePercent: toNullableNumber(getRecord(holderChange["24h"]).changePercent),
    },
    holderDistribution: normalizeHolderDistribution(getRecord(metricsData).holderDistribution),
    topHolders: topResult
      .map(normalizeSolanaTopHolder)
      .filter((holder) => holder.address),
  };
}

async function fetchEvmHolders(
  ref: BantahBroTokenRef,
  apiKey: string,
  network: string,
): Promise<BantahBroHolderMetrics> {
  const url = `${MORALIS_EVM_API_BASE}/erc20/${encodeURIComponent(
    ref.tokenAddress,
  )}/owners?chain=${encodeURIComponent(network)}&limit=10&order=DESC`;
  const data = await fetchJson(url, apiKey);
  const result = Array.isArray(getRecord(data).result)
    ? (getRecord(data).result as MoralisTopHolder[])
    : [];
  const topHolders = result
    .map(normalizeEvmTopHolder)
    .filter((holder) => holder.address);
  const top10SupplyPercent = topHolders.reduce(
    (sum, holder) => sum + (holder.percentage || 0),
    0,
  );

  return {
    source: "moralis",
    status: "available",
    chainId: ref.chainId,
    network,
    error: null,
    totalHolders: null,
    holderSupply: {
      top10SupplyPercent,
      top25SupplyPercent: null,
      top50SupplyPercent: null,
      top100SupplyPercent: null,
    },
    holderChange: {
      m5ChangePercent: null,
      h1ChangePercent: null,
      h6ChangePercent: null,
      h24ChangePercent: null,
    },
    holderDistribution: {},
    topHolders,
  };
}

export async function fetchMoralisHolderMetrics(
  ref: BantahBroTokenRef,
): Promise<BantahBroHolderMetrics> {
  const apiKey = process.env.MORALIS_API_KEY?.trim();
  const resolved = resolveMoralisNetwork(ref.chainId);

  if (!apiKey) {
    return emptyHolderMetrics(ref, "disabled", resolved.network, "MORALIS_API_KEY is not configured.");
  }

  if (resolved.kind === "unsupported" || !resolved.network) {
    return emptyHolderMetrics(ref, "unsupported", null, `Moralis holder enrichment does not support chain ${ref.chainId}.`);
  }

  try {
    if (resolved.kind === "solana") {
      return await fetchSolanaHolders(ref, apiKey, resolved.network);
    }

    return await fetchEvmHolders(ref, apiKey, resolved.network);
  } catch (error) {
    return emptyHolderMetrics(
      ref,
      "error",
      resolved.network,
      error instanceof Error ? error.message : "Moralis holder enrichment failed.",
    );
  }
}
