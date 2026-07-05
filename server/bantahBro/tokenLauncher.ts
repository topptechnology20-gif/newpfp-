import { desc, eq } from "drizzle-orm";
import {
  encodeFunctionData,
  formatUnits,
  parseAbi,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  bantahLauncherDeployRequestSchema,
  bantahLauncherDraftRequestSchema,
  bantahLauncherSupportedChains,
  type BantahLauncherDraft,
  type BantahLauncherDraftRequest,
  type BantahLauncherDeployRequest,
} from "@shared/bantahLauncher";
import { tokenLaunches } from "@shared/schema";
import { db } from "../db";
import { restoreBantahAgentWallet } from "../agentProvisioning";
import {
  ensureBantahBroSystemAgent,
  getBantahBroSystemAgentSnapshot,
} from "./systemAgent";

const factoryAbi = parseAbi([
  "function launchToken(string tokenName,string tokenSymbol,uint8 tokenDecimals,address initialOwner,uint256 initialSupply) returns (address tokenAddress)",
  "event TokenLaunched(uint256 indexed launchId,address indexed token,address indexed owner,address launcher,string name,string symbol,uint8 decimals,uint256 initialSupply)",
]);

type LauncherChain = (typeof bantahLauncherSupportedChains)[number];

class LauncherError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function trimFormattedAmount(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed.includes(".")) return trimmed || "0";
  const normalized = trimmed.replace(/\.?0+$/, "");
  return normalized || "0";
}

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

function getChain(chainId: number): LauncherChain {
  const chain = bantahLauncherSupportedChains.find((item) => item.chainId === Number(chainId));
  if (!chain) {
    throw new LauncherError(400, `BantahBro Launcher does not support chain ${chainId} yet.`);
  }
  return chain;
}

function readFactoryAddress(chain: LauncherChain): `0x${string}` | null {
  const scoped = normalizeAddress(process.env[chain.envKey]);
  if (scoped) return scoped;
  return normalizeAddress(process.env[`BANTAH_LAUNCH_FACTORY_${chain.chainId}_ADDRESS`]);
}

function buildExplorerTxUrl(chain: LauncherChain, txHash?: string | null) {
  if (!txHash) return null;
  return `${chain.explorerBaseUrl}/tx/${txHash}`;
}

function buildExplorerTokenUrl(chain: LauncherChain, tokenAddress?: string | null) {
  if (!tokenAddress) return null;
  return `${chain.explorerBaseUrl}/token/${tokenAddress}`;
}

function parseSupply(draft: BantahLauncherDraft) {
  const amountAtomic = parseUnits(draft.initialSupply, draft.decimals);
  if (amountAtomic <= BigInt(0)) {
    throw new LauncherError(400, "Initial supply must be greater than zero.");
  }
  return amountAtomic;
}

function buildDraft(raw: BantahLauncherDraftRequest) {
  const draft = bantahLauncherDraftRequestSchema.parse(raw);
  const chain = getChain(draft.chainId);
  const initialSupplyAtomic = parseSupply(draft);
  const factoryAddress = readFactoryAddress(chain);
  const warnings: string[] = [];

  if (!factoryAddress) {
    warnings.push(
      `${chain.envKey} is not configured yet, so live deployment is disabled on ${chain.name}.`,
    );
  }
  if (!draft.ownerAddress) {
    warnings.push("Owner wallet is required before deployment. The full supply will mint there.");
  }

  return {
    ok: warnings.length === 0,
    draft: {
      tokenName: draft.tokenName,
      tokenSymbol: draft.tokenSymbol,
      chainId: chain.chainId,
      chainName: chain.name,
      networkId: chain.networkId,
      decimals: draft.decimals,
      ownerAddress: draft.ownerAddress || null,
      initialSupply: trimFormattedAmount(formatUnits(initialSupplyAtomic, draft.decimals)),
      initialSupplyAtomic: initialSupplyAtomic.toString(),
      fixedSupply: true,
      mintable: false,
      factoryAddress,
    },
    warnings,
  };
}

function extractTransactionHash(receipt: unknown): `0x${string}` | null {
  if (!receipt || typeof receipt !== "object") return null;
  const payload = receipt as Record<string, unknown>;
  return (
    normalizeHash(payload.transactionHash) ||
    normalizeHash((payload.transaction as Record<string, unknown> | undefined)?.hash) ||
    normalizeHash((payload.receipt as Record<string, unknown> | undefined)?.transactionHash) ||
    normalizeHash((payload.transactionReceipt as Record<string, unknown> | undefined)?.transactionHash) ||
    normalizeHash(payload.hash)
  );
}

function extractLogs(receipt: unknown): any[] {
  if (!receipt || typeof receipt !== "object") return [];
  const payload = receipt as Record<string, unknown>;
  const candidates = [
    payload.logs,
    (payload.receipt as Record<string, unknown> | undefined)?.logs,
    (payload.transactionReceipt as Record<string, unknown> | undefined)?.logs,
  ];

  const receipts = payload.receipts;
  if (Array.isArray(receipts)) {
    for (const item of receipts) {
      if (item && typeof item === "object") {
        candidates.push((item as Record<string, unknown>).logs);
      }
    }
  }

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as any[];
  }
  return [];
}

function extractLaunchedTokenAddress(receipt: unknown): `0x${string}` | null {
  const logs = extractLogs(receipt);
  if (logs.length === 0) return null;

  try {
    const parsedLogs = parseEventLogs({
      abi: factoryAbi,
      eventName: "TokenLaunched",
      logs,
    });
    const event = parsedLogs[0];
    return normalizeAddress(event?.args?.token) || null;
  } catch {
    return null;
  }
}

export function getBantahLauncherStatus() {
  return {
    mode: "agentkit_factory",
    agentKitRequired: true,
    deployRequiresAuth: true,
    explicitConfirmationRequired: true,
    chains: bantahLauncherSupportedChains.map((chain) => {
      const factoryAddress = readFactoryAddress(chain);
      return {
        chainId: chain.chainId,
        name: chain.name,
        networkId: chain.networkId,
        explorerBaseUrl: chain.explorerBaseUrl,
        factoryAddress,
        configured: Boolean(factoryAddress),
        envKey: chain.envKey,
      };
    }),
  };
}

export function validateBantahLaunchDraft(raw: BantahLauncherDraftRequest) {
  return buildDraft(raw);
}

export async function listBantahTokenLaunches(userId?: string | null, limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  const rows = userId
    ? await db
        .select()
        .from(tokenLaunches)
        .where(eq(tokenLaunches.userId, userId))
        .orderBy(desc(tokenLaunches.createdAt))
        .limit(safeLimit)
    : await db
        .select()
        .from(tokenLaunches)
        .orderBy(desc(tokenLaunches.createdAt))
        .limit(safeLimit);

  return rows.map((row) => {
    const chain = getChain(row.chainId);
    return {
      ...row,
      explorerTxUrl: buildExplorerTxUrl(chain, row.deployTxHash),
      explorerTokenUrl: buildExplorerTokenUrl(chain, row.tokenAddress),
    };
  });
}

export async function deployBantahLaunchToken(
  raw: BantahLauncherDeployRequest,
  options: { userId: string },
) {
  const request = bantahLauncherDeployRequestSchema.parse(raw);
  const chain = getChain(request.chainId);
  const factoryAddress = readFactoryAddress(chain);
  if (!factoryAddress) {
    throw new LauncherError(
      503,
      `${chain.name} token factory is not configured. Deploy the factory and set ${chain.envKey}.`,
    );
  }

  const initialSupplyAtomic = parseSupply(request);
  const systemAgent = await ensureBantahBroSystemAgent({ preferLiveWallet: true });
  const { agent } = await getBantahBroSystemAgentSnapshot();

  const [launch] = await db
    .insert(tokenLaunches)
    .values({
      userId: options.userId,
      agentId: agent.agentId,
      chainId: chain.chainId,
      networkId: chain.networkId,
      factoryAddress,
      ownerAddress: request.ownerAddress.toLowerCase(),
      tokenName: request.tokenName,
      tokenSymbol: request.tokenSymbol,
      decimals: request.decimals,
      initialSupply: trimFormattedAmount(formatUnits(initialSupplyAtomic, request.decimals)),
      initialSupplyAtomic: initialSupplyAtomic.toString(),
      status: "pending",
      metadata: {
        launchedBy: "bantahbro-agentkit",
        systemAgentName: systemAgent.agentName,
      },
    })
    .returning();

  try {
    const restored = await restoreBantahAgentWallet(
      {
        agentId: agent.agentId,
        walletProvider: agent.walletProvider,
        walletNetworkId: agent.walletNetworkId,
        walletAddress: agent.walletAddress,
        ownerWalletAddress: agent.ownerWalletAddress,
        walletData: agent.walletData,
      },
      { targetChainId: chain.chainId },
    );

    const data = encodeFunctionData({
      abi: factoryAbi,
      functionName: "launchToken",
      args: [
        request.tokenName,
        request.tokenSymbol,
        request.decimals,
        request.ownerAddress as Address,
        initialSupplyAtomic,
      ],
    });

    const userOpHash = await restored.walletProvider.sendTransaction({
      to: factoryAddress,
      data,
      value: BigInt(0),
    });
    const receipt = await restored.walletProvider.waitForTransactionReceipt(userOpHash as Hex);
    const deployTxHash = extractTransactionHash(receipt);
    const tokenAddress = extractLaunchedTokenAddress(receipt);

    const [updated] = await db
      .update(tokenLaunches)
      .set({
        tokenAddress,
        deployTxHash,
        status: "deployed",
        metadata: {
          launchedBy: "bantahbro-agentkit",
          userOpHash,
          systemAgentName: systemAgent.agentName,
          systemAgentWallet: restored.walletAddress,
          receiptShape: receipt && typeof receipt === "object" ? Object.keys(receipt as any) : [],
        },
        updatedAt: new Date(),
      })
      .where(eq(tokenLaunches.id, launch.id))
      .returning();

    return {
      launch: updated,
      chain,
      userOpHash,
      deployTxHash,
      tokenAddress,
      explorerTxUrl: buildExplorerTxUrl(chain, deployTxHash),
      explorerTokenUrl: buildExplorerTokenUrl(chain, tokenAddress),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token deployment failed.";
    const [failed] = await db
      .update(tokenLaunches)
      .set({
        status: "failed",
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(eq(tokenLaunches.id, launch.id))
      .returning();

    throw new LauncherError(502, failed.errorMessage || message);
  }
}

export { LauncherError };
