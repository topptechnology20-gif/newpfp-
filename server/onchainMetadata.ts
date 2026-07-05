import { ethers } from "ethers";
import { pool } from "./db";
import { normalizeEvmAddress, type OnchainChainConfig } from "@shared/onchainConfig";

export type OnchainChallengeMetadataPayload = {
  version: number;
  challengeId?: number | null;
  chainId: number;
  escrowTxHash?: string | null;
  challengerWallet?: string | null;
  challengerUserId?: string | null;
  challengedUserId?: string | null;
  challengedWalletAddress?: string | null;
  title: string;
  description?: string | null;
  category?: string | null;
  amount?: number | string | null;
  challengerSide?: string | null;
  dueDate?: string | null;
  settlementRail?: string | null;
  tokenSymbol?: string | null;
  tokenAddress?: string | null;
  decimals?: number | null;
  stakeAtomic?: string | null;
  adminCreated?: boolean;
  createdAt?: string | null;
};

type StoredOnchainChallengeMetadata = {
  metadataHash: string;
  payload: OnchainChallengeMetadataPayload;
  chainId: number | null;
  escrowTxHash: string | null;
  challengeId: number | null;
};

const ESCROW_METADATA_ABI = [
  "function logChallengeCreated(uint256 challengeId, bytes32 metadataHash, string challengeType) returns (bool)",
];

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function computeMetadataHash(payload: OnchainChallengeMetadataPayload): {
  hash: `0x${string}`;
  canonicalJson: string;
} {
  const canonicalJson = stableStringify(payload);
  const hash = ethers.keccak256(ethers.toUtf8Bytes(canonicalJson));
  return { hash: hash as `0x${string}`, canonicalJson };
}

export async function upsertOnchainChallengeMetadata(params: {
  payload: OnchainChallengeMetadataPayload;
  chainId?: number | null;
  escrowTxHash?: string | null;
  challengeId?: number | null;
}): Promise<StoredOnchainChallengeMetadata> {
  const { payload, chainId, escrowTxHash, challengeId } = params;
  const { hash } = computeMetadataHash(payload);

  await pool.query(
    `insert into onchain_challenge_metadata (
       metadata_hash,
       chain_id,
       escrow_tx_hash,
       challenge_id,
       payload,
       created_at,
       updated_at
     )
     values ($1, $2, $3, $4, $5, now(), now())
     on conflict (metadata_hash) do update set
       chain_id = excluded.chain_id,
       escrow_tx_hash = excluded.escrow_tx_hash,
       challenge_id = excluded.challenge_id,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
    [
      hash.toLowerCase(),
      chainId ?? null,
      escrowTxHash ? escrowTxHash.toLowerCase() : null,
      challengeId ?? null,
      payload,
    ],
  );

  return {
    metadataHash: hash.toLowerCase(),
    payload,
    chainId: chainId ?? null,
    escrowTxHash: escrowTxHash ? escrowTxHash.toLowerCase() : null,
    challengeId: challengeId ?? null,
  };
}

export async function getOnchainChallengeMetadata(
  metadataHash: string,
): Promise<StoredOnchainChallengeMetadata | null> {
  const normalized = metadataHash.toLowerCase();
  const res = await pool.query(
    `select metadata_hash, chain_id, escrow_tx_hash, challenge_id, payload
     from onchain_challenge_metadata
     where metadata_hash = $1
     limit 1`,
    [normalized],
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0];
  return {
    metadataHash: row.metadata_hash,
    payload: row.payload,
    chainId: row.chain_id ?? null,
    escrowTxHash: row.escrow_tx_hash ?? null,
    challengeId: row.challenge_id ?? null,
  };
}

export async function markMetadataChallengeId(
  metadataHash: string,
  challengeId: number,
): Promise<void> {
  await pool.query(
    `update onchain_challenge_metadata
     set challenge_id = $2, updated_at = now()
     where metadata_hash = $1`,
    [metadataHash.toLowerCase(), challengeId],
  );
}

export async function logOnchainChallengeCreated(params: {
  chain: OnchainChainConfig;
  metadataHash: string;
  challengeId: number;
  challengeType: string;
}): Promise<string | null> {
  const adminKey = String(process.env.ADMIN_PRIVATE_KEY || "").trim();
  if (!adminKey) return null;

  const escrowAddress = normalizeEvmAddress(params.chain.escrowContractAddress);
  if (!escrowAddress) return null;

  const provider = new ethers.JsonRpcProvider(params.chain.rpcUrl, params.chain.chainId, {
    staticNetwork: true,
  });
  const wallet = new ethers.Wallet(adminKey, provider);
  const escrow = new ethers.Contract(escrowAddress, ESCROW_METADATA_ABI, wallet);

  const tx = await escrow.logChallengeCreated(
    params.challengeId,
    params.metadataHash,
    params.challengeType,
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("Metadata log transaction failed");
  }
  return tx.hash as string;
}
