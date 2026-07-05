import { ethers } from "ethers";
import { Attribution } from "ox/erc8021";
import {
  normalizeEvmAddress,
  type OnchainChainConfig,
} from "@shared/onchainConfig";
import { Connection, Keypair, Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";

const SIM_BATTLE_REGISTRY_ABI = [
  "function owner() view returns (address)",
  "function recordSimulatedBattle(bytes32 battleId, bytes32 ensNamehash, address ensOwner, address winner, bytes32 eventRoot, bytes32 rewardRoot, bytes32 metadataHash, uint256 totalBantCredits) returns (bool)",
];

const BANTCREDIT_REWARDS_ABI = [
  "function owner() view returns (address)",
  "function setRewardBatch(bytes32 batchId, bytes32 merkleRoot, bytes32 metadataHash, uint256 totalBantCredits, bool active)",
];

const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const simBattleRegistryInterface = new ethers.Interface(SIM_BATTLE_REGISTRY_ABI);
const bantCreditRewardsInterface = new ethers.Interface(BANTCREDIT_REWARDS_ABI);
const BASE_ATTRIBUTION_CHAIN_IDS = new Set<number>([8453, 84532]);
const DEFAULT_BASE_BUILDER_CODE = "bc_aujwsbcz";

export type SimBattleRewardRole =
  | "ENS_OWNER"
  | "EXTERNAL_AGENT_OWNER"
  | "SPECTATOR"
  | "FIGHTER_OWNER"
  | "BONUS";

export type SimBattleRewardEntry = {
  account: string;
  amount: number | string | bigint;
  role: SimBattleRewardRole | string;
  matchId: string;
};

export type SimBattleEventEntry = {
  id?: string;
  type: string;
  actor?: string | null;
  message?: string | null;
  value?: string | number | null;
  timestamp?: string | null;
};

export type SimBattleReceiptPayload = {
  version: 1;
  battleId: string;
  ensName?: string | null;
  ensNamehash?: string | null;
  ensOwner: string;
  ownerRole?: SimBattleRewardRole | string | null;
  ownerSource?: string | null;
  winner?: string | null;
  fighters: string[];
  events: SimBattleEventEntry[];
  rewards: SimBattleRewardEntry[];
  finishedAt: string;
};

export type RewardLeaf = SimBattleRewardEntry & {
  account: string;
  amount: bigint;
  batchId: `0x${string}`;
  matchIdBytes32: `0x${string}`;
  roleBytes32: `0x${string}`;
  leaf: `0x${string}`;
  proof: `0x${string}`[];
};

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function asBytes32(value: string, label: string): `0x${string}` {
  const raw = String(value || "").trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(raw)) return raw.toLowerCase() as `0x${string}`;
  if (!raw) throw new Error(`${label} is required`);
  return ethers.keccak256(ethers.toUtf8Bytes(raw)) as `0x${string}`;
}

function optionalBytes32(value: string | null | undefined): `0x${string}` {
  const raw = String(value || "").trim();
  if (!raw) return ethers.ZeroHash as `0x${string}`;
  if (/^0x[a-fA-F0-9]{64}$/.test(raw)) return raw.toLowerCase() as `0x${string}`;
  return ethers.keccak256(ethers.toUtf8Bytes(raw)) as `0x${string}`;
}

function normalizeAmount(value: number | string | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid reward amount");
    return BigInt(Math.floor(value));
  }
  const raw = String(value || "").trim();
  if (!/^\d+$/.test(raw) || raw === "0") throw new Error("Invalid reward amount");
  return BigInt(raw);
}

function baseBuilderCode() {
  return String(
    process.env.BASE_BUILDER_CODE ||
      process.env.VITE_BASE_BUILDER_CODE ||
      DEFAULT_BASE_BUILDER_CODE,
  ).trim();
}

function builderDataSuffix() {
  const code = baseBuilderCode();
  if (!code) return null;
  try {
    return Attribution.toDataSuffix({ codes: [code] });
  } catch {
    return null;
  }
}

function appendBuilderDataSuffix(data: string, chainId?: number | null): `0x${string}` {
  const normalizedData = data.startsWith("0x") ? data : `0x${data}`;
  if (!chainId || !BASE_ATTRIBUTION_CHAIN_IDS.has(Number(chainId))) {
    return normalizedData as `0x${string}`;
  }

  const suffix = builderDataSuffix();
  if (!suffix) return normalizedData as `0x${string}`;

  const suffixWithoutPrefix = suffix.slice(2).toLowerCase();
  if (normalizedData.toLowerCase().endsWith(suffixWithoutPrefix)) {
    return normalizedData as `0x${string}`;
  }

  return `${normalizedData}${suffix.slice(2)}` as `0x${string}`;
}

function configuredPrivateKeys(): string[] {
  const rawKeys = [
    process.env.ONCHAIN_SIM_REWARDS_PRIVATE_KEY,
    process.env.BANTCREDIT_REWARDS_PRIVATE_KEY,
    process.env.PRIVATE_KEY,
    process.env.PLATFORM_PRIVATE_KEY,
    process.env.ADMIN_PRIVATE_KEY,
    process.env.TESTNET_ADMIN_PRIVATE_KEY,
  ];
  const seen = new Set<string>();
  return rawKeys
    .map((value) => String(value || "").trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function sameAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeEvmAddress(left);
  const normalizedRight = normalizeEvmAddress(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft.toLowerCase() === normalizedRight.toLowerCase());
}

async function ownerSignerForContract(params: {
  chain: OnchainChainConfig;
  contractAddress: string;
  contractLabel: string;
  abi: string[];
}): Promise<ethers.Wallet> {
  const provider = new ethers.JsonRpcProvider(params.chain.rpcUrl, params.chain.chainId, {
    staticNetwork: true,
  });
  const contract = new ethers.Contract(params.contractAddress, params.abi, provider);
  const owner = normalizeEvmAddress(await contract.owner());
  if (!owner) throw new Error(`${params.contractLabel} owner could not be resolved`);

  for (const privateKey of configuredPrivateKeys()) {
    try {
      const wallet = new ethers.Wallet(privateKey, provider);
      if (sameAddress(wallet.address, owner)) return wallet;
    } catch {
      // Ignore invalid optional key candidates and keep looking.
    }
  }

  throw new Error(
    `${params.contractLabel} owner is ${owner}, but no configured private key matches it. ` +
      "Set ONCHAIN_SIM_REWARDS_PRIVATE_KEY, BANTCREDIT_REWARDS_PRIVATE_KEY, PRIVATE_KEY, or ADMIN_PRIVATE_KEY.",
  );
}

function sortedPairHash(left: `0x${string}`, right: `0x${string}`): `0x${string}` {
  const a = BigInt(left);
  const b = BigInt(right);
  return (a <= b
    ? ethers.keccak256(ethers.concat([left, right]))
    : ethers.keccak256(ethers.concat([right, left]))) as `0x${string}`;
}

function buildMerkleRoot(leaves: `0x${string}`[]): `0x${string}` {
  if (!leaves.length) return ethers.ZeroHash as `0x${string}`;
  let level = leaves.slice().sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  while (level.length > 1) {
    const next: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left;
      next.push(sortedPairHash(left, right));
    }
    level = next;
  }
  return level[0];
}

function buildMerkleProof(target: `0x${string}`, leaves: `0x${string}`[]): `0x${string}`[] {
  if (!leaves.length) return [];
  let index = leaves.findIndex((leaf) => leaf === target);
  if (index < 0) throw new Error("Leaf is not in Merkle tree");

  let level = leaves.slice().sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  index = level.findIndex((leaf) => leaf === target);
  const proof: `0x${string}`[] = [];

  while (level.length > 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    proof.push(level[siblingIndex] || level[index]);

    const next: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left;
      next.push(sortedPairHash(left, right));
    }
    index = Math.floor(index / 2);
    level = next;
  }

  return proof;
}

export function computeSimBattleMetadataHash(payload: SimBattleReceiptPayload): {
  hash: `0x${string}`;
  canonicalJson: string;
} {
  const canonicalJson = stableStringify(payload);
  return {
    hash: ethers.keccak256(ethers.toUtf8Bytes(canonicalJson)) as `0x${string}`,
    canonicalJson,
  };
}

export function computeSimBattleEventRoot(events: SimBattleEventEntry[]): `0x${string}` {
  const leaves = events.map((event, index) =>
    ethers.keccak256(ethers.toUtf8Bytes(stableStringify({ index, ...event }))) as `0x${string}`,
  );
  return buildMerkleRoot(leaves);
}

export function rewardLeafHash(params: {
  batchId: string;
  account: string;
  amount: number | string | bigint;
  role: string;
  matchId: string;
}): `0x${string}` {
  const account = normalizeEvmAddress(params.account);
  if (!account) throw new Error("Invalid reward account");

  return ethers.keccak256(
    abiCoder.encode(
      ["bytes32", "address", "uint256", "bytes32", "bytes32"],
      [
        asBytes32(params.batchId, "batchId"),
        account,
        normalizeAmount(params.amount),
        asBytes32(params.role, "role"),
        asBytes32(params.matchId, "matchId"),
      ],
    ),
  ) as `0x${string}`;
}

export function buildRewardBatch(params: {
  batchId: string;
  rewards: SimBattleRewardEntry[];
}): {
  batchId: `0x${string}`;
  root: `0x${string}`;
  totalBantCredits: bigint;
  leaves: RewardLeaf[];
} {
  const batchId = asBytes32(params.batchId, "batchId");
  const partialLeaves = params.rewards.map((reward) => {
    const account = normalizeEvmAddress(reward.account);
    if (!account) throw new Error(`Invalid reward account: ${reward.account}`);
    const amount = normalizeAmount(reward.amount);
    const roleBytes32 = asBytes32(reward.role, "role");
    const matchIdBytes32 = asBytes32(reward.matchId, "matchId");
    const leaf = rewardLeafHash({
      batchId,
      account,
      amount,
      role: reward.role,
      matchId: reward.matchId,
    });
    return {
      ...reward,
      account,
      amount,
      batchId,
      matchIdBytes32,
      roleBytes32,
      leaf,
      proof: [] as `0x${string}`[],
    };
  });
  const leafHashes = partialLeaves.map((leaf) => leaf.leaf);
  const root = buildMerkleRoot(leafHashes);

  return {
    batchId,
    root,
    totalBantCredits: partialLeaves.reduce((sum, leaf) => sum + leaf.amount, BigInt(0)),
    leaves: partialLeaves.map((leaf) => ({
      ...leaf,
      proof: buildMerkleProof(leaf.leaf, leafHashes),
    })),
  };
}

export async function recordSimulatedBattleOnchain(params: {
  chain: OnchainChainConfig;
  payload: SimBattleReceiptPayload;
  eventRoot?: string | null;
  rewardRoot?: string | null;
  totalBantCredits?: number | string | bigint;
  dryRun?: boolean;
}): Promise<{
  battleId: `0x${string}`;
  ensNamehash: `0x${string}`;
  eventRoot: `0x${string}`;
  rewardRoot: `0x${string}`;
  metadataHash: `0x${string}`;
  totalBantCredits: bigint;
  txHash: string;
}> {
  const isSolana = params.chain.key.startsWith("solana");
  let registryAddress: string | null = null;
  if (!isSolana) {
    registryAddress = normalizeEvmAddress(params.chain.simBattleRegistryAddress);
    if (!registryAddress) throw new Error(`SimBattleRegistry is not configured for ${params.chain.name}`);
  }

  const ensOwner = params.chain.key.startsWith("solana") 
    ? params.payload.ensOwner 
    : normalizeEvmAddress(params.payload.ensOwner);
  if (!ensOwner && !params.chain.key.startsWith("solana")) throw new Error("Invalid ENS owner");
  const winner = params.chain.key.startsWith("solana") 
    ? params.payload.winner
    : normalizeEvmAddress(params.payload.winner) || ethers.ZeroAddress;
  const metadata = computeSimBattleMetadataHash(params.payload);
  const rewardBatch = buildRewardBatch({ batchId: params.payload.battleId, rewards: params.payload.rewards });

  const eventRoot = params.eventRoot
    ? optionalBytes32(params.eventRoot)
    : computeSimBattleEventRoot(params.payload.events);
  const rewardRoot = params.rewardRoot
    ? optionalBytes32(params.rewardRoot)
    : rewardBatch.root;

  const receiptPayload = {
    battleId: asBytes32(params.payload.battleId, "battleId"),
    ensNamehash: optionalBytes32(params.payload.ensNamehash || params.payload.ensName || null),
    eventRoot,
    rewardRoot,
    metadataHash: metadata.hash,
    totalBantCredits: params.totalBantCredits !== undefined
      ? normalizeAmount(params.totalBantCredits)
      : rewardBatch.totalBantCredits,
  };

  if (params.dryRun) {
    return { ...receiptPayload, txHash: "dry-run" };
  }

  if (isSolana) {
    const privateKeyStr = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKeyStr) {
      throw new Error("SOLANA_PRIVATE_KEY is not configured for recording battles on Solana.");
    }
    const secretKey = bs58.decode(privateKeyStr);
    const keypair = Keypair.fromSecretKey(secretKey);
    const connection = new Connection(params.chain.rpcUrl, "confirmed");

    const memoPayload = {
      type: "BantahBattle",
      battleId: receiptPayload.battleId,
      winner,
      ensOwner,
      eventRoot: receiptPayload.eventRoot,
      rewardRoot: receiptPayload.rewardRoot,
      metadataHash: receiptPayload.metadataHash,
      totalBantCredits: receiptPayload.totalBantCredits.toString()
    };

    const memoInstruction = new TransactionInstruction({
      keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from(JSON.stringify(memoPayload), "utf-8"),
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    });

    const tx = new Transaction().add(memoInstruction);
    const txHash = await sendAndConfirmTransaction(connection, tx, [keypair]);
    
    return { ...receiptPayload, txHash };
  }

  const signer = await ownerSignerForContract({
    chain: params.chain,
    contractAddress: registryAddress!,
    contractLabel: "SimBattleRegistry",
    abi: SIM_BATTLE_REGISTRY_ABI,
  });
  const data = simBattleRegistryInterface.encodeFunctionData("recordSimulatedBattle", [
    receiptPayload.battleId,
    receiptPayload.ensNamehash,
    ensOwner,
    winner,
    receiptPayload.eventRoot,
    receiptPayload.rewardRoot,
    receiptPayload.metadataHash,
    receiptPayload.totalBantCredits,
  ]);
  const tx = await signer.sendTransaction({
    to: registryAddress,
    data: appendBuilderDataSuffix(data, params.chain.chainId),
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Simulated battle receipt tx failed");
  return { ...receiptPayload, txHash: tx.hash as string };
}

export async function setBantCreditRewardBatchOnchain(params: {
  chain: OnchainChainConfig;
  batchId: string;
  rewards: SimBattleRewardEntry[];
  metadataHash?: string | null;
  active?: boolean;
  dryRun?: boolean;
}): Promise<{
  batchId: `0x${string}`;
  rewardRoot: `0x${string}`;
  metadataHash: `0x${string}`;
  totalBantCredits: bigint;
  leaves: RewardLeaf[];
  txHash: string;
}> {
  const isSolana = params.chain.key.startsWith("solana");
  let rewardsAddress: string | null = null;
  if (!isSolana) {
    rewardsAddress = normalizeEvmAddress(params.chain.bantCreditRewardsAddress);
    if (!rewardsAddress) throw new Error(`BantCreditRewards is not configured for ${params.chain.name}`);
  }

  const batch = buildRewardBatch({ batchId: params.batchId, rewards: params.rewards });
  const metadataHash = optionalBytes32(params.metadataHash);

  if (params.dryRun) {
    return {
      batchId: batch.batchId,
      rewardRoot: batch.root,
      metadataHash,
      totalBantCredits: batch.totalBantCredits,
      leaves: batch.leaves,
      txHash: "dry-run",
    };
  }

  if (isSolana) {
    const privateKeyStr = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKeyStr) {
      throw new Error("SOLANA_PRIVATE_KEY is not configured for recording reward batches on Solana.");
    }
    const secretKey = bs58.decode(privateKeyStr);
    const keypair = Keypair.fromSecretKey(secretKey);
    const connection = new Connection(params.chain.rpcUrl, "confirmed");

    const memoPayload = {
      type: "BantahRewardBatch",
      batchId: batch.batchId,
      rewardRoot: batch.root,
      metadataHash,
      totalBantCredits: batch.totalBantCredits.toString(),
      active: params.active !== false
    };

    const memoInstruction = new TransactionInstruction({
      keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from(JSON.stringify(memoPayload), "utf-8"),
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    });

    const tx = new Transaction().add(memoInstruction);
    const txHash = await sendAndConfirmTransaction(connection, tx, [keypair]);
    
    return {
      batchId: batch.batchId,
      rewardRoot: batch.root,
      metadataHash,
      totalBantCredits: batch.totalBantCredits,
      leaves: batch.leaves,
      txHash,
    };
  }

  const signer = await ownerSignerForContract({
    chain: params.chain,
    contractAddress: rewardsAddress!,
    contractLabel: "BantCreditRewards",
    abi: BANTCREDIT_REWARDS_ABI,
  });
  const data = bantCreditRewardsInterface.encodeFunctionData("setRewardBatch", [
    batch.batchId,
    batch.root,
    metadataHash,
    batch.totalBantCredits,
    params.active !== false,
  ]);
  const tx = await signer.sendTransaction({
    to: rewardsAddress,
    data: appendBuilderDataSuffix(data, params.chain.chainId),
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Reward batch tx failed");

  return {
    batchId: batch.batchId,
    rewardRoot: batch.root,
    metadataHash,
    totalBantCredits: batch.totalBantCredits,
    leaves: batch.leaves,
    txHash: tx.hash as string,
  };
}
