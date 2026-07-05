import { encodeFunctionData, formatUnits, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { Keypair, Connection, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { SolanaAgentKit } from "solana-agent-kit";
import { BANTAH_SKILL_VERSION, bantahRequiredSkillActionValues } from "@shared/agentSkill";
import type { OnchainChainConfig, OnchainTokenSymbol } from "@shared/onchainConfig";
import { getBantahAgentKitNetworkIdForChainId } from "@shared/agentApi";

export const DEFAULT_BANTAH_AGENT_SKILLS = [...bantahRequiredSkillActionValues];
export const DEFAULT_BANTAH_AGENT_NETWORK_ID = "base-mainnet";

const erc20BalanceAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);
const erc20ApproveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const erc20TransferAbi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const escrowNativeAbi = parseAbi([
  "function lockStakeNative() payable returns (bool)",
]);

type BantahAgentWalletErrorCode =
  | "wallet_not_provisioned"
  | "wallet_provision_failed"
  | "unsupported_chain"
  | "wallet_restore_failed"
  | "transaction_incomplete"
  | "insufficient_balance";

type AgentKitLikeModule = {
  CdpSmartWalletProvider: {
    configureWithWallet(config: {
      networkId: string;
      owner?: string | Record<string, unknown>;
      address?: string;
      idempotencyKey?: string;
      apiKeyId?: string;
      apiKeySecret?: string;
      walletSecret?: string;
    }): Promise<{
      exportWallet(): Promise<{
        name?: string;
        address: `0x${string}`;
        ownerAddress: `0x${string}`;
      }>;
      getAddress(): string;
      getBalance(): Promise<bigint>;
      readContract(params: Record<string, unknown>): Promise<unknown>;
      sendTransaction(params: Record<string, unknown>): Promise<Hex>;
      waitForTransactionReceipt(txHash: Hex): Promise<Record<string, unknown>>;
    }>;
  };
};

export type ProvisionedBantahAgent = {
  walletAddress: `0x${string}` | string;
  ownerWalletAddress: `0x${string}` | string;
  walletProvider: "cdp_smart_wallet" | "solana_agent_kit";
  walletNetworkId: string;
  walletData: {
    name?: string;
    address: string;
    ownerAddress: string;
    secretKeyBase58?: string;
  };
};

export type StoredBantahAgentWalletSnapshot = {
  agentId: string;
  walletProvider?: string | null;
  walletNetworkId?: string | null;
  walletAddress?: string | null;
  ownerWalletAddress?: string | null;
  walletData?: unknown;
};

export class BantahAgentWalletError extends Error {
  code: BantahAgentWalletErrorCode;

  constructor(code: BantahAgentWalletErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type RestoredBantahAgentWallet = {
  walletProvider?: Awaited<ReturnType<AgentKitLikeModule["CdpSmartWalletProvider"]["configureWithWallet"]>>;
  solanaAgentKit?: SolanaAgentKit;
  walletProviderType: "cdp_smart_wallet" | "solana_agent_kit";
  walletAddress: `0x${string}` | string;
  ownerWalletAddress: `0x${string}` | string;
  walletNetworkId: string;
};

function normalizeAddress(input: unknown): `0x${string}` | string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (/^0x[a-f0-9A-F]{40}$/.test(value)) return value.toLowerCase() as `0x${string}`;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return value;
  return null;
}

function normalizeHash(input: unknown): `0x${string}` | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(value)) return null;
  return value as `0x${string}`;
}

function trimFormattedAmount(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed.includes(".")) return trimmed || "0";
  const normalized = trimmed.replace(/\.?0+$/, "");
  return normalized || "0";
}

function formatAtomicAmount(amountAtomic: bigint, decimals: number): string {
  return trimFormattedAmount(formatUnits(amountAtomic, decimals));
}

function mapChainIdToAgentKitNetworkId(chainId: number): string | null {
  return getBantahAgentKitNetworkIdForChainId(Number(chainId));
}

function parseStakeAtomicAmount(rawAmount: string | number, decimals: number): bigint {
  const input = String(rawAmount ?? "").trim();
  if (!input) {
    throw new Error("Amount is required for agent escrow transaction.");
  }
  if (!/^\d+(\.\d+)?$/.test(input)) {
    throw new Error("Amount format is invalid.");
  }
  return parseUnits(input, decimals);
}

function parseMethodSignature(signature: string): {
  functionName: string;
  paramTypes: string[];
} {
  const raw = String(signature || "").trim();
  const match = raw.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)$/);
  if (!match) {
    throw new Error(`Invalid method signature: ${raw}`);
  }
  const functionName = match[1];
  const params = match[2].trim();
  const paramTypes = params
    ? params.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  return { functionName, paramTypes };
}

function buildErc20EscrowCalldata(
  methodSignature: string,
  tokenAddress: `0x${string}`,
  amountAtomic: bigint,
): `0x${string}` {
  const { functionName, paramTypes } = parseMethodSignature(methodSignature);
  const args: Array<string | bigint> = [];

  for (const paramType of paramTypes) {
    const normalizedType = paramType.toLowerCase();
    if (normalizedType === "address") {
      args.push(tokenAddress);
      continue;
    }
    if (normalizedType.startsWith("uint") || normalizedType.startsWith("int")) {
      args.push(amountAtomic);
      continue;
    }
    throw new Error(
      `Unsupported escrow method parameter type "${paramType}" in ${methodSignature}`,
    );
  }

  const abi = parseAbi([`function ${methodSignature}` as any] as any);
  return encodeFunctionData({
    abi: abi as any,
    functionName: functionName as any,
    args: args as any,
  }) as `0x${string}`;
}

function extractWalletSnapshot(snapshot: StoredBantahAgentWalletSnapshot) {
  const walletData =
    snapshot.walletData && typeof snapshot.walletData === "object"
      ? (snapshot.walletData as Record<string, unknown>)
      : null;

  const walletAddress =
    normalizeAddress(walletData?.address) || normalizeAddress(snapshot.walletAddress);
  const ownerWalletAddress =
    normalizeAddress(walletData?.ownerAddress) || normalizeAddress(snapshot.ownerWalletAddress);

  return {
    walletAddress,
    ownerWalletAddress,
    walletNetworkId: String(snapshot.walletNetworkId || "").trim(),
  };
}

function resolveAgentKitRuntimeNetworkId(params: {
  snapshot: StoredBantahAgentWalletSnapshot;
  targetChainId?: number;
}) {
  const { walletNetworkId } = extractWalletSnapshot(params.snapshot);
  if (params.targetChainId === undefined) {
    if (!walletNetworkId) {
      throw new BantahAgentWalletError(
        "wallet_not_provisioned",
        "This Bantah agent wallet does not have a recorded AgentKit network id yet.",
      );
    }
    return walletNetworkId;
  }

  const requestedNetworkId = mapChainIdToAgentKitNetworkId(params.targetChainId);
  if (!requestedNetworkId) {
    throw new BantahAgentWalletError(
      "unsupported_chain",
      `Coinbase AgentKit smart-wallet execution is not available for chain ${params.targetChainId} yet.`,
    );
  }

  if (walletNetworkId && walletNetworkId !== requestedNetworkId) {
    throw new BantahAgentWalletError(
      "unsupported_chain",
      `This Bantah agent wallet is provisioned on ${walletNetworkId}. Cross-network agent execution to ${requestedNetworkId} is not live yet.`,
    );
  }

  return requestedNetworkId;
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

async function loadAgentKit(): Promise<AgentKitLikeModule> {
  try {
    return (await import("@coinbase/agentkit")) as AgentKitLikeModule;
  } catch (error: any) {
    throw new Error(
      error?.message
        ? `Failed to load @coinbase/agentkit: ${error.message}`
        : "Failed to load @coinbase/agentkit.",
    );
  }
}

function requireCdpEnvValue(name: "CDP_API_KEY_ID" | "CDP_API_KEY_SECRET" | "CDP_WALLET_SECRET") {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is required to provision Bantah agents.`);
  }
  return value;
}

export function getBantahAgentEndpointBaseUrl() {
  return (
    String(process.env.BANTAH_AGENT_ENDPOINT_BASE_URL || "").trim() ||
    String(process.env.BANTAH_ONCHAIN_BASE_URL || "").trim() ||
    String(process.env.RENDER_EXTERNAL_URL || "").trim() ||
    `http://localhost:${Number(process.env.PORT || 5000)}`
  );
}

function getSolanaRpcUrl() {
  return String(process.env.SOLANA_RPC_URL || "").trim() || "https://api.mainnet-beta.solana.com";
}

export function buildBantahAgentEndpointUrl(agentId: string) {
  return new URL(`/api/agents/runtime/${agentId}`, getBantahAgentEndpointBaseUrl()).toString();
}

export async function provisionBantahAgentWallet(
  agentId: string,
  networkId = DEFAULT_BANTAH_AGENT_NETWORK_ID,
): Promise<ProvisionedBantahAgent> {
  if (networkId.includes("solana")) {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    const secretKeyBase58 = bs58.encode(keypair.secretKey);
    return {
      walletAddress: address,
      ownerWalletAddress: address,
      walletProvider: "solana_agent_kit",
      walletNetworkId: networkId,
      walletData: {
        address,
        ownerAddress: address,
        secretKeyBase58,
      },
    };
  }

  const { CdpSmartWalletProvider } = await loadAgentKit();
  try {
    const walletProvider = await CdpSmartWalletProvider.configureWithWallet({
      networkId,
      idempotencyKey: `bantah-agent-${agentId}`,
      apiKeyId: requireCdpEnvValue("CDP_API_KEY_ID"),
      apiKeySecret: requireCdpEnvValue("CDP_API_KEY_SECRET"),
      walletSecret: requireCdpEnvValue("CDP_WALLET_SECRET"),
    });

    const walletData = await walletProvider.exportWallet();

    return {
      walletAddress: walletData.address,
      ownerWalletAddress: walletData.ownerAddress,
      walletProvider: "cdp_smart_wallet",
      walletNetworkId: networkId,
      walletData,
    };
  } catch (error: any) {
    if (error?.statusCode === 401 || error?.errorType === "unauthorized") {
      throw new BantahAgentWalletError(
        "wallet_provision_failed",
        "Coinbase AgentKit wallet provisioning failed because the configured CDP credentials were rejected by Coinbase.",
      );
    }

    throw new BantahAgentWalletError(
      "wallet_provision_failed",
      error?.message || "Failed to provision Bantah agent wallet with AgentKit.",
    );
  }
}

export async function restoreBantahAgentWallet(
  snapshot: StoredBantahAgentWalletSnapshot,
  options: {
    targetChainId?: number;
  } = {},
): Promise<RestoredBantahAgentWallet> {
  if (snapshot.walletProvider && snapshot.walletProvider !== "cdp_smart_wallet" && snapshot.walletProvider !== "solana_agent_kit") {
    const walletProvider = String(snapshot.walletProvider || "").trim();
    throw new BantahAgentWalletError(
      "wallet_not_provisioned",
      walletProvider === "local_demo_wallet"
        ? "This agent is still on a local demo wallet because AgentKit provisioning is unavailable. Onchain execution will stay disabled until the Coinbase CDP credentials are fixed."
        : `This Bantah agent does not have a live AgentKit wallet provider yet (${walletProvider}).`,
    );
  }

  const { walletAddress, ownerWalletAddress } = extractWalletSnapshot(snapshot);
  if (!walletAddress || !ownerWalletAddress) {
    throw new BantahAgentWalletError(
      "wallet_not_provisioned",
      "Bantah agent wallet data is incomplete. Recreate the agent wallet before using contract-mode actions.",
    );
  }

  const walletNetworkId = resolveAgentKitRuntimeNetworkId({
    snapshot,
    targetChainId: options.targetChainId,
  });

  if (snapshot.walletProvider === "solana_agent_kit") {
    const walletData = snapshot.walletData as { secretKeyBase58?: string };
    if (!walletData?.secretKeyBase58) {
       throw new BantahAgentWalletError(
        "wallet_restore_failed",
        "Bantah agent solana wallet data is missing secret key.",
      );
    }
    const solanaAgentKit = new SolanaAgentKit(
      walletData.secretKeyBase58,
      getSolanaRpcUrl(),
      String(process.env.OPENAI_API_KEY || "")
    );
    return {
      solanaAgentKit,
      walletProviderType: "solana_agent_kit",
      walletAddress,
      ownerWalletAddress,
      walletNetworkId,
    };
  }

  const { CdpSmartWalletProvider } = await loadAgentKit();

  try {
    const walletProvider = await CdpSmartWalletProvider.configureWithWallet({
      networkId: walletNetworkId,
      owner: ownerWalletAddress,
      address: walletAddress,
      idempotencyKey: `bantah-agent-runtime-${snapshot.agentId}`,
      apiKeyId: requireCdpEnvValue("CDP_API_KEY_ID"),
      apiKeySecret: requireCdpEnvValue("CDP_API_KEY_SECRET"),
      walletSecret: requireCdpEnvValue("CDP_WALLET_SECRET"),
    });

    return {
      walletProvider,
      walletProviderType: "cdp_smart_wallet",
      walletAddress,
      ownerWalletAddress,
      walletNetworkId,
    };
  } catch (error: any) {
    throw new BantahAgentWalletError(
      "wallet_restore_failed",
      error?.message || "Failed to restore Bantah agent wallet from AgentKit.",
    );
  }
}

export async function getBantahAgentWalletBalance(params: {
  snapshot: StoredBantahAgentWalletSnapshot;
  chainId: number;
  chainConfig: OnchainChainConfig;
  tokenSymbol: OnchainTokenSymbol;
}): Promise<{
  walletAddress: `0x${string}`;
  walletNetworkId: string;
  amountAtomic: string;
  amountFormatted: string;
}> {
  const restoredWallet = await restoreBantahAgentWallet(params.snapshot, {
    targetChainId: params.chainId,
  });
  const tokenConfig = params.chainConfig.tokens[params.tokenSymbol];

  if (!tokenConfig) {
    throw new BantahAgentWalletError(
      "unsupported_chain",
      `Token ${params.tokenSymbol} is not configured on ${params.chainConfig.name}.`,
    );
  }

  let amountAtomic: bigint;
  if (restoredWallet.walletProviderType === "solana_agent_kit" && restoredWallet.solanaAgentKit) {
    if (tokenConfig.isNative) {
      // getBalance returns SOL in lamports as number, but let's just get it directly or via sdk
      const balanceNum = await restoredWallet.solanaAgentKit.connection.getBalance(restoredWallet.solanaAgentKit.wallet.publicKey);
      amountAtomic = BigInt(balanceNum);
    } else {
      const tokenAddress = normalizeAddress(tokenConfig.address);
      if (!tokenAddress) {
        throw new BantahAgentWalletError(
          "unsupported_chain",
          `Token ${params.tokenSymbol} does not have a configured contract address on ${params.chainConfig.name}.`,
        );
      }
      try {
        const tokenPubkey = new PublicKey(tokenAddress);
        const accounts = await restoredWallet.solanaAgentKit.connection.getTokenAccountsByOwner(restoredWallet.solanaAgentKit.wallet.publicKey, { mint: tokenPubkey });
        if (accounts.value.length > 0) {
          const balInfo = await restoredWallet.solanaAgentKit.connection.getTokenAccountBalance(accounts.value[0].pubkey);
          amountAtomic = BigInt(balInfo.value.amount);
        } else {
          amountAtomic = 0n;
        }
      } catch (err) {
        amountAtomic = 0n;
      }
    }
  } else if (restoredWallet.walletProvider) {
    if (tokenConfig.isNative) {
      amountAtomic = await restoredWallet.walletProvider.getBalance();
    } else {
    const tokenAddress = normalizeAddress(tokenConfig.address);
    if (!tokenAddress) {
      throw new BantahAgentWalletError(
        "unsupported_chain",
        `Token ${params.tokenSymbol} does not have a configured contract address on ${params.chainConfig.name}.`,
      );
    }

      const balanceResult = await restoredWallet.walletProvider.readContract({
        address: tokenAddress as `0x${string}`,
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [restoredWallet.walletAddress as `0x${string}`],
      });
      amountAtomic = BigInt(String(balanceResult || "0"));
    }
  } else {
    amountAtomic = 0n;
  }

  return {
    walletAddress: restoredWallet.walletAddress,
    walletNetworkId: restoredWallet.walletNetworkId,
    amountAtomic: amountAtomic.toString(),
    amountFormatted: trimFormattedAmount(formatUnits(amountAtomic, tokenConfig.decimals)),
  };
}

export async function executeBantahAgentEscrowStakeTx(params: {
  snapshot: StoredBantahAgentWalletSnapshot;
  chainId: number;
  chainConfig: OnchainChainConfig;
  tokenSymbol: OnchainTokenSymbol;
  amount: string | number;
  amountAtomic?: string | null;
}): Promise<{
  walletAddress: `0x${string}`;
  walletNetworkId: string;
  approveTxHash?: `0x${string}`;
  escrowTxHash: `0x${string}`;
}> {
  const restoredWallet = await restoreBantahAgentWallet(params.snapshot, {
    targetChainId: params.chainId,
  });
  const tokenConfig = params.chainConfig.tokens[params.tokenSymbol];
  const escrowAddress = normalizeAddress(params.chainConfig.escrowContractAddress);

  if (!tokenConfig) {
    throw new BantahAgentWalletError(
      "unsupported_chain",
      `Token ${params.tokenSymbol} is not configured on ${params.chainConfig.name}.`,
    );
  }
  if (!escrowAddress) {
    throw new BantahAgentWalletError(
      "unsupported_chain",
      `Escrow contract is not configured for ${params.chainConfig.name}.`,
    );
  }

  const rawAmountAtomic =
    typeof params.amountAtomic === "string" && /^\d+$/.test(params.amountAtomic.trim())
      ? BigInt(params.amountAtomic.trim())
      : parseStakeAtomicAmount(params.amount, tokenConfig.decimals);
  if (rawAmountAtomic <= 0n) {
    throw new BantahAgentWalletError(
      "transaction_incomplete",
      "Agent escrow amount must be greater than zero.",
    );
  }

  let availableAmountAtomic: bigint;
  if (restoredWallet.walletProviderType === "solana_agent_kit" && restoredWallet.solanaAgentKit) {
    if (tokenConfig.isNative) {
      availableAmountAtomic = BigInt(await restoredWallet.solanaAgentKit.connection.getBalance(restoredWallet.solanaAgentKit.wallet.publicKey));
    } else {
      const tokenAddress = normalizeAddress(tokenConfig.address);
      if (!tokenAddress) {
        throw new BantahAgentWalletError(
          "unsupported_chain",
          `Token ${params.tokenSymbol} does not have a configured contract address on ${params.chainConfig.name}.`,
        );
      }
      try {
        const accounts = await restoredWallet.solanaAgentKit.connection.getTokenAccountsByOwner(restoredWallet.solanaAgentKit.wallet.publicKey, { mint: new PublicKey(tokenAddress) });
        if (accounts.value.length > 0) {
          const balInfo = await restoredWallet.solanaAgentKit.connection.getTokenAccountBalance(accounts.value[0].pubkey);
          availableAmountAtomic = BigInt(balInfo.value.amount);
        } else {
          availableAmountAtomic = 0n;
        }
      } catch (err) {
        availableAmountAtomic = 0n;
      }
    }
  } else if (restoredWallet.walletProvider) {
    if (tokenConfig.isNative) {
      availableAmountAtomic = await restoredWallet.walletProvider.getBalance();
    } else {
      const tokenAddress = normalizeAddress(tokenConfig.address);
      if (!tokenAddress) {
        throw new BantahAgentWalletError(
          "unsupported_chain",
          `Token ${params.tokenSymbol} does not have a configured contract address on ${params.chainConfig.name}.`,
        );
      }
      const balanceResult = await restoredWallet.walletProvider.readContract({
        address: tokenAddress as `0x${string}`,
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [restoredWallet.walletAddress as `0x${string}`],
      });
      availableAmountAtomic = BigInt(String(balanceResult || "0"));
    }
  } else {
    availableAmountAtomic = 0n;
  }

  if (availableAmountAtomic < rawAmountAtomic) {
    const availableFormatted = formatAtomicAmount(availableAmountAtomic, tokenConfig.decimals);
    const requiredFormatted = formatAtomicAmount(rawAmountAtomic, tokenConfig.decimals);
    throw new BantahAgentWalletError(
      "insufficient_balance",
      `Agent wallet balance is too low for this ${params.tokenSymbol} stake. Available ${availableFormatted}, required ${requiredFormatted}.`,
    );
  }

  if (restoredWallet.walletProviderType === "solana_agent_kit" && restoredWallet.solanaAgentKit) {
    if (tokenConfig.isNative) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: restoredWallet.solanaAgentKit.wallet.publicKey,
          toPubkey: new PublicKey(escrowAddress),
          lamports: Number(rawAmountAtomic),
        })
      );
      const { signature } = await restoredWallet.solanaAgentKit.wallet.signAndSendTransaction(tx);
      return {
        walletAddress: restoredWallet.walletAddress,
        walletNetworkId: restoredWallet.walletNetworkId,
        escrowTxHash: signature as `0x${string}`,
      };
    } else {
      const tokenAddress = normalizeAddress(tokenConfig.address);
      if (!tokenAddress) {
        throw new BantahAgentWalletError(
          "unsupported_chain",
          `Token ${params.tokenSymbol} does not have a configured contract address on ${params.chainConfig.name}.`,
        );
      }
      
      try {
        const signature = await restoredWallet.solanaAgentKit.transfer(
          new PublicKey(escrowAddress),
          Number(rawAmountAtomic) / (10 ** tokenConfig.decimals),
          new PublicKey(tokenAddress)
        );
        return {
          walletAddress: restoredWallet.walletAddress,
          walletNetworkId: restoredWallet.walletNetworkId,
          escrowTxHash: signature as `0x${string}`,
        };
      } catch (error: any) {
        throw new BantahAgentWalletError(
          "transaction_failed",
          `SPL Token staking failed: ${error?.message || "Unknown error"}`
        );
      }
    }
  }

  if (!restoredWallet.walletProvider) {
    throw new BantahAgentWalletError("transaction_incomplete", "EVM Provider missing");
  }

  if (tokenConfig.isNative) {
    const nativeStakeData = encodeFunctionData({
      abi: escrowNativeAbi,
      functionName: "lockStakeNative",
      args: [],
    });
    const userOpHash = await restoredWallet.walletProvider.sendTransaction({
      to: escrowAddress as `0x${string}`,
      data: nativeStakeData,
      value: rawAmountAtomic,
    });
    const receipt = await restoredWallet.walletProvider.waitForTransactionReceipt(userOpHash);
    const escrowTxHash = extractTransactionHash(receipt);

    if (!escrowTxHash) {
      throw new BantahAgentWalletError(
        "transaction_incomplete",
        "Agent escrow transaction completed without an onchain transaction hash.",
      );
    }

    return {
      walletAddress: restoredWallet.walletAddress,
      walletNetworkId: restoredWallet.walletNetworkId,
      escrowTxHash,
    };
  }

  if (!restoredWallet.walletProvider) {
    throw new BantahAgentWalletError("transaction_incomplete", "EVM Provider missing for non-native execution");
  }

  const tokenAddress = normalizeAddress(tokenConfig.address);
  if (!tokenAddress) {
    throw new BantahAgentWalletError(
      "unsupported_chain",
      `Token ${params.tokenSymbol} does not have a configured contract address on ${params.chainConfig.name}.`,
    );
  }

  const approveData = encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: "approve",
    args: [escrowAddress as `0x${string}`, rawAmountAtomic],
  });
  const approveUserOpHash = await restoredWallet.walletProvider.sendTransaction({
    to: tokenAddress as `0x${string}`,
    data: approveData,
    value: 0n,
  });
  const approveReceipt =
    await restoredWallet.walletProvider.waitForTransactionReceipt(approveUserOpHash);
  const approveTxHash = extractTransactionHash(approveReceipt);
  if (!approveTxHash) {
    throw new BantahAgentWalletError(
      "transaction_incomplete",
      "Agent token approval completed without an onchain transaction hash.",
    );
  }

  const erc20MethodSignature =
    params.chainConfig.escrowStakeMethodErc20?.trim() || "lockStakeToken(address,uint256)";
  const escrowData = buildErc20EscrowCalldata(
    erc20MethodSignature,
    tokenAddress as `0x${string}`,
    rawAmountAtomic,
  );
  const escrowUserOpHash = await restoredWallet.walletProvider.sendTransaction({
    to: escrowAddress as `0x${string}`,
    data: escrowData,
    value: 0n,
  });
  const escrowReceipt =
    await restoredWallet.walletProvider.waitForTransactionReceipt(escrowUserOpHash);
  const escrowTxHash = extractTransactionHash(escrowReceipt);
  if (!escrowTxHash) {
    throw new BantahAgentWalletError(
      "transaction_incomplete",
      "Agent escrow transaction completed without an onchain transaction hash.",
    );
  }

  return {
    walletAddress: restoredWallet.walletAddress,
    walletNetworkId: restoredWallet.walletNetworkId,
    approveTxHash,
    escrowTxHash,
  };
}

export async function sendBantahAgentWalletTransfer(params: {
  snapshot: StoredBantahAgentWalletSnapshot;
  chainId: number;
  chainConfig: OnchainChainConfig;
  tokenSymbol: OnchainTokenSymbol;
  recipientAddress: string;
  amount: string | number;
}): Promise<{
  walletAddress: `0x${string}`;
  walletNetworkId: string;
  recipientAddress: `0x${string}`;
  txHash: `0x${string}`;
}> {
  const restoredWallet = await restoreBantahAgentWallet(params.snapshot, {
    targetChainId: params.chainId,
  });
  const tokenConfig = params.chainConfig.tokens[params.tokenSymbol];
  const recipientAddress = normalizeAddress(params.recipientAddress);

  if (!recipientAddress) {
    throw new BantahAgentWalletError(
      "transaction_incomplete",
      "Recipient wallet address is invalid.",
    );
  }

  if (!tokenConfig) {
    throw new BantahAgentWalletError(
      "unsupported_chain",
      `Token ${params.tokenSymbol} is not configured on ${params.chainConfig.name}.`,
    );
  }

  const amountAtomic = parseStakeAtomicAmount(params.amount, tokenConfig.decimals);
  if (amountAtomic <= 0n) {
    throw new BantahAgentWalletError(
      "transaction_incomplete",
      "Transfer amount must be greater than zero.",
    );
  }

  let availableAmountAtomic: bigint;
  if (restoredWallet.walletProviderType === "solana_agent_kit" && restoredWallet.solanaAgentKit) {
    if (tokenConfig.isNative) {
      availableAmountAtomic = BigInt(await restoredWallet.solanaAgentKit.connection.getBalance(restoredWallet.solanaAgentKit.wallet.publicKey));
    } else {
      const tokenAddress = normalizeAddress(tokenConfig.address);
      if (!tokenAddress) {
        throw new BantahAgentWalletError(
          "unsupported_chain",
          `Token ${params.tokenSymbol} does not have a configured contract address on ${params.chainConfig.name}.`,
        );
      }
      try {
        const accounts = await restoredWallet.solanaAgentKit.connection.getTokenAccountsByOwner(restoredWallet.solanaAgentKit.wallet.publicKey, { mint: new PublicKey(tokenAddress) });
        if (accounts.value.length > 0) {
          const balInfo = await restoredWallet.solanaAgentKit.connection.getTokenAccountBalance(accounts.value[0].pubkey);
          availableAmountAtomic = BigInt(balInfo.value.amount);
        } else {
          availableAmountAtomic = 0n;
        }
      } catch (err) {
        availableAmountAtomic = 0n;
      }
    }
  } else if (restoredWallet.walletProvider) {
    if (tokenConfig.isNative) {
      availableAmountAtomic = await restoredWallet.walletProvider.getBalance();
    } else {
      const tokenAddress = normalizeAddress(tokenConfig.address);
      if (!tokenAddress) {
        throw new BantahAgentWalletError(
          "unsupported_chain",
          `Token ${params.tokenSymbol} does not have a configured contract address on ${params.chainConfig.name}.`,
        );
      }
      const balanceResult = await restoredWallet.walletProvider.readContract({
        address: tokenAddress as `0x${string}`,
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [restoredWallet.walletAddress as `0x${string}`],
      });
      availableAmountAtomic = BigInt(String(balanceResult || "0"));
    }
  } else {
    availableAmountAtomic = 0n;
  }

  if (availableAmountAtomic < amountAtomic) {
    const availableFormatted = formatAtomicAmount(availableAmountAtomic, tokenConfig.decimals);
    const requiredFormatted = formatAtomicAmount(amountAtomic, tokenConfig.decimals);
    throw new BantahAgentWalletError(
      "insufficient_balance",
      `Agent wallet balance is too low for this ${params.tokenSymbol} transfer. Available ${availableFormatted}, required ${requiredFormatted}.`,
    );
  }

  let txHash: string;
  if (restoredWallet.walletProviderType === "solana_agent_kit" && restoredWallet.solanaAgentKit) {
    if (tokenConfig.isNative) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: restoredWallet.solanaAgentKit.wallet.publicKey,
          toPubkey: new PublicKey(recipientAddress),
          lamports: Number(amountAtomic),
        })
      );
      const res = await restoredWallet.solanaAgentKit.wallet.signAndSendTransaction(tx);
      txHash = res.signature;
    } else {
        const tokenAddress = normalizeAddress(tokenConfig.address);
        if (!tokenAddress) {
          throw new BantahAgentWalletError(
            "unsupported_chain",
            `Token ${params.tokenSymbol} does not have a configured contract address on ${params.chainConfig.name}.`,
          );
        }
        
        try {
          const res = await restoredWallet.solanaAgentKit.transfer(
            new PublicKey(recipientAddress),
            Number(amountAtomic) / (10 ** tokenConfig.decimals),
            new PublicKey(tokenAddress)
          );
          txHash = res;
        } catch (error: any) {
          throw new BantahAgentWalletError(
            "transaction_failed",
            `SPL Token transfer failed: ${error?.message || "Unknown error"}`
          );
        }
    }
  } else if (restoredWallet.walletProvider) {
    let userOpHash: Hex;
    if (tokenConfig.isNative) {
      userOpHash = await restoredWallet.walletProvider.sendTransaction({
        to: recipientAddress as `0x${string}`,
        value: amountAtomic,
        data: "0x",
      });
    } else {
      const tokenAddress = normalizeAddress(tokenConfig.address);
      if (!tokenAddress) {
        throw new BantahAgentWalletError(
          "unsupported_chain",
          `Token ${params.tokenSymbol} does not have a configured contract address on ${params.chainConfig.name}.`,
        );
      }

      const transferData = encodeFunctionData({
        abi: erc20TransferAbi,
        functionName: "transfer",
        args: [recipientAddress as Address, amountAtomic],
      });

      userOpHash = await restoredWallet.walletProvider.sendTransaction({
        to: tokenAddress as `0x${string}`,
        data: transferData,
        value: 0n,
      });
    }

    const receipt = await restoredWallet.walletProvider.waitForTransactionReceipt(userOpHash);
    const evmTxHash = extractTransactionHash(receipt);
    if (!evmTxHash) {
      throw new BantahAgentWalletError(
        "transaction_incomplete",
        "Wallet transfer completed without an onchain transaction hash.",
      );
    }
    txHash = evmTxHash;
  } else {
    throw new BantahAgentWalletError("transaction_incomplete", "Wallet provider missing");
  }

  return {
    walletAddress: restoredWallet.walletAddress,
    walletNetworkId: restoredWallet.walletNetworkId,
    recipientAddress: recipientAddress as `0x${string}`,
    txHash: txHash as `0x${string}`,
  };
}

export function buildSkillSuccessEnvelope(requestId: string, result: unknown) {
  return {
    ok: true as const,
    requestId,
    skillVersion: BANTAH_SKILL_VERSION,
    result,
  };
}

export function buildSkillErrorEnvelope(
  requestId: string,
  code:
    | "insufficient_balance"
    | "market_closed"
    | "invalid_input"
    | "unauthorized"
    | "unsupported_action"
    | "rate_limited"
    | "internal_error",
  message: string,
  details?: Record<string, unknown>,
) {
  return {
    ok: false as const,
    requestId,
    skillVersion: BANTAH_SKILL_VERSION,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}
