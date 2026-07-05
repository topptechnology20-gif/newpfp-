import Decimal from "decimal.js";
import { encodeFunctionData, formatUnits, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { bantahBroBxbtStatusSchema, type BantahBroBxbtStatus } from "@shared/bantahBro";
import { getBantahAgentKitNetworkIdForChainId } from "@shared/agentApi";
import { restoreBantahAgentWallet } from "../agentProvisioning";
import { getBantahBroSystemAgentSnapshot } from "./systemAgent";

const erc20BalanceAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);
const erc20TransferAbi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

function normalizeAddress(input: unknown): `0x${string}` | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(value)) return null;
  return value as `0x${string}`;
}

function normalizeHash(input: unknown): `0x${string}` | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(value)) return null;
  return value as `0x${string}`;
}

function extractTransactionHash(receipt: unknown): `0x${string}` | null {
  if (!receipt || typeof receipt !== "object") return null;
  const payload = receipt as Record<string, unknown>;
  return (
    normalizeHash(payload.transactionHash) ||
    normalizeHash((payload.transaction as Record<string, unknown> | undefined)?.hash) ||
    normalizeHash(payload.hash)
  );
}

function trimFormattedAmount(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed.includes(".")) return trimmed || "0";
  const normalized = trimmed.replace(/\.?0+$/, "");
  return normalized || "0";
}

function requireEnv(name: string) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is required for BantahBro BXBT.`);
  }
  return value;
}

function optionalEnv(name: string) {
  return String(process.env[name] || "").trim();
}

function getBxbtChainEnvAliases(chainId: number) {
  const aliasMap: Record<number, string[]> = {
    8453: ["8453", "BASE"],
    42161: ["42161", "ARBITRUM"],
    56: ["56", "BSC", "BINANCE", "BNB"],
  };
  return aliasMap[chainId] || [String(chainId)];
}

function resolveChainAwareEnv(name: string, chainId?: number) {
  if (chainId) {
    for (const alias of getBxbtChainEnvAliases(chainId)) {
      const scopedValue = String(process.env[`${name}_${alias}`] || "").trim();
      if (scopedValue) return scopedValue;
    }
  }
  return requireEnv(name);
}

function requireAddressEnv(name: string, chainId?: number) {
  const value = normalizeAddress(resolveChainAwareEnv(name, chainId));
  if (!value) {
    throw new Error(`${name} must be a valid EVM address.`);
  }
  return value;
}

function requirePositiveIntegerEnv(name: string, chainId?: number) {
  const value = Number.parseInt(resolveChainAwareEnv(name, chainId), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function getBxbtConfig() {
  const chainId = requirePositiveIntegerEnv("BANTAHBRO_BXBT_CHAIN_ID");
  return {
    tokenAddress: requireAddressEnv("BANTAHBRO_BXBT_TOKEN_ADDRESS", chainId),
    chainId,
    decimals: requirePositiveIntegerEnv("BANTAHBRO_BXBT_DECIMALS", chainId),
    treasuryAddress: requireAddressEnv("BANTAHBRO_BXBT_TREASURY_ADDRESS", chainId),
    marketCreationCost: requireEnv("BANTAHBRO_BXBT_MARKET_CREATION_COST"),
    boostUnitCost: requireEnv("BANTAHBRO_BXBT_BOOST_UNIT_COST"),
    rewardAmount: requireEnv("BANTAHBRO_BXBT_REWARD_AMOUNT"),
  };
}

function getBxbtStatusConfig() {
  const chainId = Number.parseInt(optionalEnv("BANTAHBRO_BXBT_CHAIN_ID") || "8453", 10);
  const safeChainId = Number.isInteger(chainId) && chainId > 0 ? chainId : 8453;
  const decimals = Number.parseInt(
    optionalEnv(`BANTAHBRO_BXBT_DECIMALS_${getBxbtChainEnvAliases(safeChainId)[1] || safeChainId}`) ||
      optionalEnv("BANTAHBRO_BXBT_DECIMALS") ||
      "18",
    10,
  );
  const tokenAddress =
    normalizeAddress(resolveOptionalChainAwareEnv("BANTAHBRO_BXBT_TOKEN_ADDRESS", safeChainId)) ||
    null;
  const treasuryAddress =
    normalizeAddress(resolveOptionalChainAwareEnv("BANTAHBRO_BXBT_TREASURY_ADDRESS", safeChainId)) ||
    null;

  return {
    tokenAddress,
    chainId: safeChainId,
    decimals: Number.isInteger(decimals) && decimals > 0 ? decimals : 18,
    treasuryAddress,
    marketCreationCost: optionalEnv("BANTAHBRO_BXBT_MARKET_CREATION_COST") || "0",
    boostUnitCost: optionalEnv("BANTAHBRO_BXBT_BOOST_UNIT_COST") || "0",
    rewardAmount: optionalEnv("BANTAHBRO_BXBT_REWARD_AMOUNT") || "0",
  };
}

function resolveOptionalChainAwareEnv(name: string, chainId: number) {
  for (const alias of getBxbtChainEnvAliases(chainId)) {
    const scopedValue = optionalEnv(`${name}_${alias}`);
    if (scopedValue) return scopedValue;
  }
  return optionalEnv(name);
}

async function readBxbtBalance() {
  const config = getBxbtConfig();
  const { agent } = await getBantahBroSystemAgentSnapshot();
  if (agent.walletProvider !== "cdp_smart_wallet") {
    return {
      available: false,
      walletAddress: agent.walletAddress,
      amountAtomic: null,
      amountFormatted: null,
      error: "BantahBro needs a live AgentKit wallet before BXBT transfers can run.",
    };
  }

  if (!getBantahAgentKitNetworkIdForChainId(config.chainId)) {
    return {
      available: false,
      walletAddress: agent.walletAddress,
      amountAtomic: null,
      amountFormatted: null,
      error: `BANTAHBRO_BXBT_CHAIN_ID ${config.chainId} is not mapped to a live Bantah AgentKit network yet.`,
    };
  }

  const restored = await restoreBantahAgentWallet(
    {
      agentId: agent.agentId,
      walletProvider: agent.walletProvider,
      walletNetworkId: agent.walletNetworkId,
      walletAddress: agent.walletAddress,
      ownerWalletAddress: agent.ownerWalletAddress,
      walletData: agent.walletData,
    },
    { targetChainId: config.chainId },
  );

  const balanceResult = await restored.walletProvider.readContract({
    address: config.tokenAddress,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [restored.walletAddress],
  });
  const amountAtomic = BigInt(String(balanceResult || "0"));
  return {
    available: true,
    walletAddress: restored.walletAddress,
    amountAtomic: amountAtomic.toString(),
    amountFormatted: trimFormattedAmount(formatUnits(amountAtomic, config.decimals)),
    error: null,
    restoredWallet: restored,
  };
}

export async function getBantahBroBxbtStatus(): Promise<BantahBroBxbtStatus> {
  const statusConfig = getBxbtStatusConfig();

  if (!statusConfig.tokenAddress || !statusConfig.treasuryAddress) {
    const { agent } = await getBantahBroSystemAgentSnapshot();
    return bantahBroBxbtStatusSchema.parse({
      configured: false,
      tokenAddress: statusConfig.tokenAddress,
      tokenSymbol: "BXBT",
      chainId: statusConfig.chainId,
      decimals: statusConfig.decimals,
      treasuryAddress: statusConfig.treasuryAddress,
      marketCreationCost: statusConfig.marketCreationCost,
      boostUnitCost: statusConfig.boostUnitCost,
      rewardAmount: statusConfig.rewardAmount,
      liveWalletRequired: true,
      balance: {
        available: false,
        walletAddress: agent.walletAddress || null,
        amountAtomic: null,
        amountFormatted: null,
        error:
          "BXBT token and treasury addresses are not configured yet. Add BANTAHBRO_BXBT_TOKEN_ADDRESS and BANTAHBRO_BXBT_TREASURY_ADDRESS to enable live balance checks.",
      },
    });
  }

  const config = getBxbtConfig();
  const balance = await readBxbtBalance();

  return bantahBroBxbtStatusSchema.parse({
    configured: Boolean(config.tokenAddress),
    tokenAddress: config.tokenAddress,
    tokenSymbol: "BXBT",
    chainId: config.chainId,
    decimals: config.decimals,
    treasuryAddress: config.treasuryAddress,
    marketCreationCost: config.marketCreationCost,
    boostUnitCost: config.boostUnitCost,
    rewardAmount: config.rewardAmount,
    liveWalletRequired: true,
    balance: {
      available: balance.available,
      walletAddress: balance.walletAddress || null,
      amountAtomic: balance.amountAtomic,
      amountFormatted: balance.amountFormatted,
      error: balance.error,
    },
  });
}

async function transferBxbt(params: {
  amount: string;
  recipientAddress: string;
  reason: string;
}) {
  const config = getBxbtConfig();

  const recipientAddress = normalizeAddress(params.recipientAddress);
  if (!recipientAddress) {
    throw new Error("Recipient address is invalid.");
  }

  const balance = await readBxbtBalance();
  if (!balance.available || !balance.amountAtomic || !balance.restoredWallet) {
    throw new Error(balance.error || "BantahBro BXBT wallet is unavailable.");
  }

  const amountAtomic = parseUnits(String(params.amount).trim(), config.decimals);
  if (amountAtomic <= BigInt(0)) {
    throw new Error("BXBT amount must be greater than zero.");
  }

  if (BigInt(balance.amountAtomic) < amountAtomic) {
    throw new Error(
      `BantahBro BXBT balance is too low. Available ${balance.amountFormatted}, required ${params.amount}.`,
    );
  }

  const transferData = encodeFunctionData({
    abi: erc20TransferAbi,
    functionName: "transfer",
    args: [recipientAddress as Address, amountAtomic],
  });

  const userOpHash = await balance.restoredWallet.walletProvider.sendTransaction({
    to: config.tokenAddress,
    data: transferData,
    value: BigInt(0),
  });
  const receipt = await balance.restoredWallet.walletProvider.waitForTransactionReceipt(userOpHash as Hex);
  const txHash = extractTransactionHash(receipt);
  if (!txHash) {
    throw new Error("BXBT transfer completed without an onchain transaction hash.");
  }

  return {
    reason: params.reason,
    recipientAddress,
    walletAddress: balance.restoredWallet.walletAddress,
    amount: String(params.amount),
    amountAtomic: amountAtomic.toString(),
    txHash,
    chainId: config.chainId,
    tokenAddress: config.tokenAddress,
    tokenSymbol: "BXBT" as const,
  };
}

export async function spendBantahBroBxbt(params: {
  amount: string;
  reason: string;
  recipientAddress?: string | null;
}) {
  const config = getBxbtConfig();
  const recipientAddress = params.recipientAddress || config.treasuryAddress;
  return transferBxbt({
    amount: params.amount,
    reason: params.reason,
    recipientAddress,
  });
}

export async function rewardBantahBroBxbt(params: {
  recipientAddress: string;
  amount?: string;
  reason: string;
}) {
  const config = getBxbtConfig();
  return transferBxbt({
    amount: params.amount || config.rewardAmount,
    reason: params.reason,
    recipientAddress: params.recipientAddress,
  });
}

export function calculateBoostBxbtSpend(multiplier: number, durationHours: number) {
  const { boostUnitCost } = getBxbtConfig();
  return new Decimal(boostUnitCost)
    .mul(new Decimal(multiplier))
    .mul(new Decimal(durationHours))
    .toFixed();
}
