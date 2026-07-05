import { ethers } from "ethers";
import {
  normalizeEvmAddress,
  normalizeOnchainTokenSymbol,
  type OnchainChainConfig,
  type OnchainTokenConfig,
  type OnchainTokenSymbol,
} from "@shared/onchainConfig";
import { pool } from "./db";
import { getOnchainServerConfig } from "./onchainConfig";
import {
  getOnchainChallengeMetadata,
  markMetadataChallengeId,
  type OnchainChallengeMetadataPayload,
} from "./onchainMetadata";

const ESCROW_EVENT_ABI = [
  "event StakeLockedNative(address indexed sender, uint256 amount)",
  "event StakeLockedToken(address indexed sender, address indexed token, uint256 amount)",
  "event ChallengeCreatedLogged(address indexed caller, uint256 indexed challengeId, bytes32 indexed metadataHash, string challengeType)",
];

const escrowInterface = new ethers.Interface(ESCROW_EVENT_ABI);
const STAKE_NATIVE_TOPIC = ethers.id("StakeLockedNative(address,uint256)");
const STAKE_TOKEN_TOPIC = ethers.id("StakeLockedToken(address,address,uint256)");
const CHALLENGE_CREATED_TOPIC = ethers.id(
  "ChallengeCreatedLogged(address,uint256,bytes32,string)",
);

type StakeEvent = {
  txHash: string;
  blockNumber: number;
  sender: string;
  tokenAddress: string | null;
  amountAtomic: bigint;
};

type MetadataEvent = {
  txHash: string;
  blockNumber: number;
  metadataHash: string;
  challengeId: number;
  challengeType: string;
};

type IndexerRuntimeConfig = {
  pollIntervalMs: number;
  backfillBlocks: number;
  batchSize: number;
  confirmations: number;
  category: string;
  titlePrefix: string;
  adminCreated: boolean;
  requireKnownWallet: boolean;
  allowStakeFallback: boolean;
  dueHours: number;
};

type ChainSyncStats = {
  chainId: number;
  chainName: string;
  safeLatest: number;
  processedThrough: number;
  created: number;
  skipped: number;
  durationMs: number;
};

type ChainIndexerHealth = {
  chainId: number;
  chainName: string;
  rpcConfigured: boolean;
  escrowConfigured: boolean;
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  safeLatest: number | null;
  processedThrough: number | null;
  lagBlocks: number | null;
  createdLastRun: number;
  skippedLastRun: number;
  durationMsLastRun: number | null;
};

const indexerHealthState = {
  enabled: false,
  startedAt: null as string | null,
  pollIntervalMs: null as number | null,
  chains: new Map<number, ChainIndexerHealth>(),
};

type ResolvedToken = {
  symbol: OnchainTokenSymbol;
  decimals: number;
  address: string | null;
  isNative: boolean;
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  const raw = value.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function formatAtomicUnits(atomic: bigint, decimals: number): string {
  if (decimals <= 0) return atomic.toString();
  const base = BigInt(10) ** BigInt(decimals);
  const whole = atomic / base;
  const fraction = atomic % base;
  let fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fractionText.length > 8) {
    fractionText = fractionText.slice(0, 8).replace(/0+$/, "");
  }
  return fractionText ? `${whole.toString()}.${fractionText}` : whole.toString();
}

function atomicToRoundedAmount(atomic: bigint, decimals: number): number {
  const human = Number(formatAtomicUnits(atomic, decimals));
  if (!Number.isFinite(human)) return 1;
  const rounded = Math.round(human);
  return rounded > 0 ? rounded : 1;
}

function buildRuntimeConfig(): IndexerRuntimeConfig {
  return {
    pollIntervalMs: Math.max(5000, Math.floor(parseNumber(process.env.ONCHAIN_INDEXER_POLL_INTERVAL_MS, 30000))),
    backfillBlocks: Math.max(0, Math.floor(parseNumber(process.env.ONCHAIN_INDEXER_BACKFILL_BLOCKS, 5000))),
    // Some RPC providers (especially free tiers) require very small eth_getLogs block ranges.
    batchSize: Math.max(1, Math.floor(parseNumber(process.env.ONCHAIN_INDEXER_BATCH_SIZE, 1000))),
    confirmations: Math.max(0, Math.floor(parseNumber(process.env.ONCHAIN_INDEXER_CONFIRMATIONS, 2))),
    category: String(process.env.ONCHAIN_INDEXER_CATEGORY || "crypto").trim() || "crypto",
    titlePrefix: String(process.env.ONCHAIN_INDEXER_TITLE_PREFIX || "Onchain Challenge").trim() || "Onchain Challenge",
    adminCreated: parseBool(process.env.ONCHAIN_INDEXER_ADMIN_CREATED, true),
    requireKnownWallet: parseBool(process.env.ONCHAIN_INDEXER_REQUIRE_KNOWN_WALLET, false),
    allowStakeFallback: parseBool(process.env.ONCHAIN_INDEXER_ALLOW_GENERIC, false),
    dueHours: Math.max(0, Math.floor(parseNumber(process.env.ONCHAIN_INDEXER_DUE_HOURS, 0))),
  };
}

function getOrCreateChainHealth(chain: OnchainChainConfig): ChainIndexerHealth {
  const existing = indexerHealthState.chains.get(chain.chainId);
  if (existing) return existing;

  const created: ChainIndexerHealth = {
    chainId: chain.chainId,
    chainName: chain.name,
    rpcConfigured: Boolean(chain.rpcUrl),
    escrowConfigured: Boolean(normalizeEvmAddress(chain.escrowContractAddress)),
    running: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessAt: null,
    lastError: null,
    safeLatest: null,
    processedThrough: null,
    lagBlocks: null,
    createdLastRun: 0,
    skippedLastRun: 0,
    durationMsLastRun: null,
  };
  indexerHealthState.chains.set(chain.chainId, created);
  return created;
}

export function getOnchainIndexerHealthSnapshot() {
  return {
    enabled: indexerHealthState.enabled,
    startedAt: indexerHealthState.startedAt,
    pollIntervalMs: indexerHealthState.pollIntervalMs,
    chains: Array.from(indexerHealthState.chains.values()).sort(
      (left, right) => left.chainId - right.chainId,
    ),
  };
}

function getConfiguredIndexerChains() {
  const config = getOnchainServerConfig();
  return Object.values(config.chains).filter(
    (chain) => Boolean(chain.rpcUrl) && Boolean(chain.escrowContractAddress),
  );
}

async function getLastProcessedBlock(chainId: number): Promise<number | null> {
  const res = await pool.query(
    `select last_block from onchain_indexer_state where chain_id = $1`,
    [chainId],
  );
  const row = res.rows[0];
  if (!row?.last_block) return null;
  const parsed = Number(row.last_block);
  return Number.isFinite(parsed) ? parsed : null;
}

async function setLastProcessedBlock(chainId: number, lastBlock: number): Promise<void> {
  await pool.query(
    `insert into onchain_indexer_state (chain_id, last_block, updated_at)
     values ($1, $2, now())
     on conflict (chain_id) do update set last_block = excluded.last_block, updated_at = excluded.updated_at`,
    [chainId, lastBlock],
  );
}

async function findChallengeByEscrowTxHash(txHash: string): Promise<number | null> {
  const normalized = txHash.toLowerCase();
  const res = await pool.query(
    `select id from challenges where escrow_tx_hash is not null and lower(escrow_tx_hash) like $1 limit 1`,
    [`%${normalized}%`],
  );
  return res.rows[0]?.id ?? null;
}

const walletUserCache = new Map<string, string | null>();
async function resolveUserIdByWallet(wallet: string): Promise<string | null> {
  const normalized = wallet.toLowerCase();
  if (walletUserCache.has(normalized)) {
    return walletUserCache.get(normalized) ?? null;
  }

  const res = await pool.query(
    `select id
     from users
     where lower(coalesce(primary_wallet_address, '')) = $1
        or exists (
          select 1 from jsonb_array_elements_text(coalesce(wallet_addresses, '[]'::jsonb)) wa
          where lower(wa) = $1
        )
     order by is_admin desc, created_at asc
     limit 1`,
    [normalized],
  );
  const id = res.rows[0]?.id ?? null;
  walletUserCache.set(normalized, id);
  return id;
}

let adminUserIdCache: string | null | undefined;
async function resolveAdminUserId(): Promise<string | null> {
  if (adminUserIdCache !== undefined) return adminUserIdCache;
  const res = await pool.query(
    `select id from users where is_admin = true order by created_at asc limit 1`,
  );
  adminUserIdCache = res.rows[0]?.id ?? null;
  return adminUserIdCache;
}

function resolveTokenFromLog(
  chain: OnchainChainConfig,
  tokenAddress: string | null,
): ResolvedToken | null {
  const nativeToken = (Object.values(chain.tokens) as OnchainTokenConfig[]).find(
    (token) => token.isNative,
  );
  if (!tokenAddress) {
    if (!nativeToken) return null;
    return {
      symbol: nativeToken.symbol,
      decimals: nativeToken.decimals,
      address: null,
      isNative: true,
    };
  }

  const normalized = normalizeEvmAddress(tokenAddress);
  if (!normalized) return null;
  const tokens = Object.values(chain.tokens) as OnchainTokenConfig[];
  const match = tokens.find(
    (token) => !token.isNative && normalizeEvmAddress(token.address) === normalized,
  );
  if (!match) return null;
  return {
    symbol: match.symbol,
    decimals: match.decimals,
    address: normalized,
    isNative: false,
  };
}

function resolveTokenFromMetadata(
  chain: OnchainChainConfig,
  payload: OnchainChallengeMetadataPayload,
): ResolvedToken | null {
  const tokenSymbol = normalizeOnchainTokenSymbol(payload.tokenSymbol);
  const tokenAddress = payload.tokenAddress ? normalizeEvmAddress(payload.tokenAddress) : null;
  const decimalsRaw = payload.decimals;
  const decimals = Number.isFinite(Number(decimalsRaw)) ? Number(decimalsRaw) : null;

  const nativeToken = (Object.values(chain.tokens) as OnchainTokenConfig[]).find(
    (token) => token.isNative,
  );
  if (chain.tokens[tokenSymbol]?.isNative) {
    if (!nativeToken) return null;
    return {
      symbol: nativeToken.symbol,
      decimals: decimals ?? nativeToken.decimals,
      address: null,
      isNative: true,
    };
  }

  if (tokenAddress) {
    const tokens = Object.values(chain.tokens) as OnchainTokenConfig[];
    const match = tokens.find(
      (token) => !token.isNative && normalizeEvmAddress(token.address) === tokenAddress,
    );
    if (match) {
      return {
        symbol: match.symbol,
        decimals: decimals ?? match.decimals,
        address: tokenAddress,
        isNative: false,
      };
    }
  }

  const fallbackToken = chain.tokens[tokenSymbol] as OnchainTokenConfig | undefined;
  if (!fallbackToken) return null;
  return {
    symbol: fallbackToken.symbol,
    decimals: decimals ?? fallbackToken.decimals,
    address: normalizeEvmAddress(fallbackToken.address) ?? null,
    isNative: false,
  };
}

async function extractEscrowEvents(logs: ethers.Log[]): Promise<{
  stakeEvents: StakeEvent[];
  metadataEvents: MetadataEvent[];
}> {
  const stakeEvents: StakeEvent[] = [];
  const metadataEvents: MetadataEvent[] = [];

  for (const log of logs) {
    const txHash = String(log.transactionHash || "").toLowerCase();
    if (!/^0x[a-f0-9]{64}$/.test(txHash)) continue;
    try {
      const parsed = escrowInterface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (parsed.name === "StakeLockedNative") {
        const args = parsed.args as { sender: string; amount: bigint };
        stakeEvents.push({
          txHash,
          blockNumber: log.blockNumber ?? 0,
          sender: args.sender,
          tokenAddress: null,
          amountAtomic: args.amount,
        });
      } else if (parsed.name === "StakeLockedToken") {
        const args = parsed.args as {
          sender: string;
          token: string;
          amount: bigint;
        };
        stakeEvents.push({
          txHash,
          blockNumber: log.blockNumber ?? 0,
          sender: args.sender,
          tokenAddress: args.token,
          amountAtomic: args.amount,
        });
      } else if (parsed.name === "ChallengeCreatedLogged") {
        const args = parsed.args as {
          caller: string;
          challengeId: bigint;
          metadataHash: string;
          challengeType: string;
        };
        const numericChallengeId = Number(args.challengeId);
        metadataEvents.push({
          txHash,
          blockNumber: log.blockNumber ?? 0,
          metadataHash: String(args.metadataHash).toLowerCase(),
          challengeId: Number.isFinite(numericChallengeId) ? numericChallengeId : 0,
          challengeType: String(args.challengeType || ""),
        });
      }
    } catch {
      continue;
    }
  }

  return { stakeEvents, metadataEvents };
}

async function resolveDueDate(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  dueHours: number,
  cache: Map<number, Date>,
): Promise<Date | null> {
  if (dueHours <= 0) return null;
  if (cache.has(blockNumber)) return cache.get(blockNumber) ?? null;
  try {
    const block = await provider.getBlock(blockNumber);
    if (!block?.timestamp) return null;
    const dueDate = new Date((block.timestamp + dueHours * 3600) * 1000);
    cache.set(blockNumber, dueDate);
    return dueDate;
  } catch {
    return null;
  }
}

async function insertChallengeFromStake(params: {
  chain: OnchainChainConfig;
  token: ResolvedToken;
  sender: string;
  amountAtomic: bigint;
  txHash: string;
  dueDate: Date | null;
  runtime: IndexerRuntimeConfig;
}): Promise<number | null> {
  const { chain, token, sender, amountAtomic, txHash, dueDate, runtime } = params;
  const amountInt = atomicToRoundedAmount(amountAtomic, token.decimals);
  const shortHash = txHash.slice(2, 8).toUpperCase();
  const title = `${runtime.titlePrefix} ${token.symbol} #${shortHash}`;
  const description = `Auto-imported from onchain escrow on ${chain.name}. Tx ${txHash}.`;

  let challengerId = await resolveUserIdByWallet(sender);
  if (!challengerId && runtime.adminCreated) {
    challengerId = await resolveAdminUserId();
  }
  if (!challengerId && runtime.requireKnownWallet) {
    return null;
  }

  const insertRes = await pool.query(
    `insert into challenges (
       challenger,
       title,
       description,
       category,
       amount,
       challenger_side,
       status,
       admin_created,
       settlement_rail,
       chain_id,
       token_symbol,
       token_address,
       decimals,
       stake_atomic,
       escrow_tx_hash,
       due_date,
       created_at
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     returning id`,
    [
      challengerId,
      title,
      description,
      runtime.category,
      amountInt,
      "YES",
      "open",
      runtime.adminCreated,
      "onchain",
      chain.chainId,
      token.symbol,
      token.address,
      token.decimals,
      amountAtomic.toString(),
      txHash.toLowerCase(),
      dueDate ? dueDate.toISOString() : null,
    ],
  );

  const challengeId = insertRes.rows[0]?.id as number | undefined;
  if (!challengeId) return null;

  await pool.query(
    `insert into escrow (challenge_id, amount, status, created_at)
     values ($1, $2, 'holding', now())`,
    [challengeId, amountInt],
  );

  return challengeId;
}

async function insertChallengeFromMetadata(params: {
  chain: OnchainChainConfig;
  metadata: OnchainChallengeMetadataPayload;
  metadataHash: string;
  runtime: IndexerRuntimeConfig;
}): Promise<number | null> {
  const { chain, metadata, metadataHash, runtime } = params;
  const token = resolveTokenFromMetadata(chain, metadata);
  if (!token) return null;

  const stakeAtomicRaw = String(metadata.stakeAtomic || "").trim();
  const stakeAtomic = /^\d+$/.test(stakeAtomicRaw)
    ? BigInt(stakeAtomicRaw)
    : null;

  const amountRaw = metadata.amount;
  let amountInt = Number.isFinite(Number(amountRaw)) ? Math.round(Number(amountRaw)) : 0;
  if (!amountInt && stakeAtomic) {
    amountInt = atomicToRoundedAmount(stakeAtomic, token.decimals);
  }
  if (amountInt <= 0) amountInt = 1;

  const title = metadata.title?.trim() || `${runtime.titlePrefix} #${metadataHash.slice(2, 8).toUpperCase()}`;
  const description =
    metadata.description?.trim() ||
    `Auto-imported from onchain metadata on ${chain.name}.`;
  const category = metadata.category?.trim() || runtime.category;
  const challengerSide = metadata.challengerSide?.trim() || "YES";
  const adminCreated = typeof metadata.adminCreated === "boolean" ? metadata.adminCreated : runtime.adminCreated;

  const challengedWallet = metadata.challengedWalletAddress
    ? normalizeEvmAddress(metadata.challengedWalletAddress)
    : null;
  const challengedUserId = metadata.challengedUserId ?? null;
  const status = challengedUserId || challengedWallet ? "pending" : "open";

  let challengerId = metadata.challengerUserId ?? null;
  if (!challengerId && metadata.challengerWallet) {
    challengerId = await resolveUserIdByWallet(metadata.challengerWallet);
  }
  if (!challengerId && runtime.adminCreated) {
    challengerId = await resolveAdminUserId();
  }
  if (!challengerId && runtime.requireKnownWallet) return null;

  const createdAt = metadata.createdAt ? new Date(metadata.createdAt) : null;
  const dueDate = metadata.dueDate ? new Date(metadata.dueDate) : null;
  const escrowTxHash = metadata.escrowTxHash ? metadata.escrowTxHash.toLowerCase() : null;

  const insertRes = await pool.query(
    `insert into challenges (
       challenger,
       challenged,
       challenged_wallet_address,
       title,
       description,
       category,
       amount,
       challenger_side,
       status,
       admin_created,
       settlement_rail,
       chain_id,
       token_symbol,
       token_address,
       decimals,
       stake_atomic,
       escrow_tx_hash,
       due_date,
       created_at
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,coalesce($19, now()))
     returning id`,
    [
      challengerId,
      challengedUserId,
      challengedWallet,
      title,
      description,
      category,
      amountInt,
      challengerSide,
      status,
      adminCreated,
      "onchain",
      Number(metadata.chainId || chain.chainId),
      token.symbol,
      token.address,
      token.decimals,
      stakeAtomic ? stakeAtomic.toString() : null,
      escrowTxHash,
      dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate.toISOString() : null,
      createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : null,
    ],
  );

  const challengeId = insertRes.rows[0]?.id as number | undefined;
  if (!challengeId) return null;

  await pool.query(
    `insert into escrow (challenge_id, amount, status, created_at)
     values ($1, $2, 'holding', now())`,
    [challengeId, amountInt],
  );

  await markMetadataChallengeId(metadataHash, challengeId);

  return challengeId;
}

async function syncChain(
  chain: OnchainChainConfig,
  provider: ethers.JsonRpcProvider,
  runtime: IndexerRuntimeConfig,
): Promise<ChainSyncStats> {
  const startedAt = Date.now();
  const escrowAddress = normalizeEvmAddress(chain.escrowContractAddress);
  if (!escrowAddress) {
    return {
      chainId: chain.chainId,
      chainName: chain.name,
      safeLatest: 0,
      processedThrough: 0,
      created: 0,
      skipped: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const latest = await provider.getBlockNumber();
  const safeLatest = Math.max(0, latest - runtime.confirmations);
  if (safeLatest <= 0) {
    const storedLast = await getLastProcessedBlock(chain.chainId);
    return {
      chainId: chain.chainId,
      chainName: chain.name,
      safeLatest: 0,
      processedThrough: storedLast ?? 0,
      created: 0,
      skipped: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const startOverrideByChain = parseOptionalNumber(
    process.env[`ONCHAIN_INDEXER_START_BLOCK_${chain.chainId}`],
  );
  const startOverrideGlobal = parseOptionalNumber(process.env.ONCHAIN_INDEXER_START_BLOCK);
  const stored = await getLastProcessedBlock(chain.chainId);
  const initialStart = stored !== null
    ? stored + 1
    : startOverrideByChain ?? startOverrideGlobal ?? Math.max(0, safeLatest - runtime.backfillBlocks);

  if (initialStart > safeLatest) {
    return {
      chainId: chain.chainId,
      chainName: chain.name,
      safeLatest,
      processedThrough: stored ?? safeLatest,
      created: 0,
      skipped: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const blockCache = new Map<number, Date>();
  let cursor = initialStart;
  let processedThrough = stored ?? Math.max(0, initialStart - 1);
  let created = 0;
  let skipped = 0;

  while (cursor <= safeLatest) {
    const end = Math.min(safeLatest, cursor + runtime.batchSize - 1);
    const logs = await provider.getLogs({
      address: escrowAddress,
      fromBlock: cursor,
      toBlock: end,
      topics: [[STAKE_NATIVE_TOPIC, STAKE_TOKEN_TOPIC, CHALLENGE_CREATED_TOPIC]],
    });

    const { stakeEvents, metadataEvents } = await extractEscrowEvents(logs);
    const handledEscrowTx = new Set<string>();

    for (const metaEvent of metadataEvents) {
      const metadata = await getOnchainChallengeMetadata(metaEvent.metadataHash);
      if (!metadata) {
        skipped += 1;
        continue;
      }
      if (metadata.challengeId) {
        if (metadata.escrowTxHash) {
          handledEscrowTx.add(metadata.escrowTxHash.toLowerCase());
        }
        skipped += 1;
        continue;
      }
      if (metadata.escrowTxHash) {
        const existing = await findChallengeByEscrowTxHash(metadata.escrowTxHash);
        if (existing) {
          await markMetadataChallengeId(metaEvent.metadataHash, existing);
          handledEscrowTx.add(metadata.escrowTxHash.toLowerCase());
          skipped += 1;
          continue;
        }
      }

      const inserted = await insertChallengeFromMetadata({
        chain,
        metadata: metadata.payload,
        metadataHash: metaEvent.metadataHash,
        runtime,
      });
      if (metadata.escrowTxHash) {
        handledEscrowTx.add(metadata.escrowTxHash.toLowerCase());
      }
      if (inserted) {
        created += 1;
      } else {
        skipped += 1;
      }
    }

    for (const event of stakeEvents) {
      if (!runtime.allowStakeFallback) {
        skipped += 1;
        continue;
      }
      if (handledEscrowTx.has(event.txHash)) {
        skipped += 1;
        continue;
      }

      const existing = await findChallengeByEscrowTxHash(event.txHash);
      if (existing) {
        skipped += 1;
        continue;
      }

      const token = resolveTokenFromLog(chain, event.tokenAddress);
      if (!token) {
        skipped += 1;
        continue;
      }

      const dueDate = await resolveDueDate(
        provider,
        event.blockNumber,
        runtime.dueHours,
        blockCache,
      );

      const inserted = await insertChallengeFromStake({
        chain,
        token,
        sender: event.sender,
        amountAtomic: event.amountAtomic,
        txHash: event.txHash,
        dueDate,
        runtime,
      });

      if (inserted) {
        created += 1;
      } else {
        skipped += 1;
      }
    }

    await setLastProcessedBlock(chain.chainId, end);
    processedThrough = end;
    cursor = end + 1;
  }

  if (created > 0 || skipped > 0) {
    console.log(
      `[onchain-indexer] ${chain.name}: created=${created} skipped=${skipped} latest=${safeLatest}`,
    );
  }

  return {
    chainId: chain.chainId,
    chainName: chain.name,
    safeLatest,
    processedThrough,
    created,
    skipped,
    durationMs: Date.now() - startedAt,
  };
}

export function startOnchainIndexer(): void {
  const enabled = parseBool(process.env.ONCHAIN_INDEXER_ENABLED, false);
  indexerHealthState.enabled = enabled;
  indexerHealthState.startedAt = enabled ? new Date().toISOString() : null;
  indexerHealthState.pollIntervalMs = null;
  indexerHealthState.chains.clear();
  if (!enabled) return;

  const runtime = buildRuntimeConfig();
  indexerHealthState.pollIntervalMs = runtime.pollIntervalMs;
  const chains = getConfiguredIndexerChains();

  if (chains.length === 0) {
    console.log("[onchain-indexer] No chains configured for indexing.");
    return;
  }

  const inFlight = new Map<number, boolean>();

  for (const chain of chains) {
    const health = getOrCreateChainHealth(chain);
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, {
      staticNetwork: true,
    });

    const tick = async () => {
      if (inFlight.get(chain.chainId)) return;
      inFlight.set(chain.chainId, true);
      const runStartedAt = new Date();
      health.running = true;
      health.lastStartedAt = runStartedAt.toISOString();
      health.lastError = null;

      try {
        const stats = await syncChain(chain, provider, runtime);
        const runCompletedAt = new Date();
        health.running = false;
        health.lastCompletedAt = runCompletedAt.toISOString();
        health.lastSuccessAt = runCompletedAt.toISOString();
        health.safeLatest = stats.safeLatest;
        health.processedThrough = stats.processedThrough;
        health.lagBlocks = Math.max(0, stats.safeLatest - stats.processedThrough);
        health.createdLastRun = stats.created;
        health.skippedLastRun = stats.skipped;
        health.durationMsLastRun = stats.durationMs;
      } catch (error: any) {
        const runCompletedAt = new Date();
        health.running = false;
        health.lastCompletedAt = runCompletedAt.toISOString();
        health.lastError = String(error?.message || error || "unknown_error");
        console.error(`[onchain-indexer] ${chain.name} sync error:`, error);
      } finally {
        inFlight.set(chain.chainId, false);
      }
    };

    void tick();
    setInterval(tick, runtime.pollIntervalMs);
  }
}

export async function runOnchainIndexerOnce() {
  const enabled = parseBool(process.env.ONCHAIN_INDEXER_ENABLED, false);
  indexerHealthState.enabled = enabled;
  indexerHealthState.startedAt = enabled ? new Date().toISOString() : null;
  indexerHealthState.pollIntervalMs = null;
  indexerHealthState.chains.clear();

  if (!enabled) {
    return {
      enabled: false,
      chains: [],
      reason: "disabled",
    };
  }

  const runtime = buildRuntimeConfig();
  indexerHealthState.pollIntervalMs = runtime.pollIntervalMs;
  const chains = getConfiguredIndexerChains();

  if (chains.length === 0) {
    return {
      enabled: true,
      chains: [],
      reason: "no-configured-chains",
    };
  }

  const results = await Promise.all(
    chains.map(async (chain) => {
      const health = getOrCreateChainHealth(chain);
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, {
        staticNetwork: true,
      });
      const runStartedAt = new Date();
      health.running = true;
      health.lastStartedAt = runStartedAt.toISOString();
      health.lastError = null;

      try {
        const stats = await syncChain(chain, provider, runtime);
        const runCompletedAt = new Date();
        health.running = false;
        health.lastCompletedAt = runCompletedAt.toISOString();
        health.lastSuccessAt = runCompletedAt.toISOString();
        health.safeLatest = stats.safeLatest;
        health.processedThrough = stats.processedThrough;
        health.lagBlocks = Math.max(0, stats.safeLatest - stats.processedThrough);
        health.createdLastRun = stats.created;
        health.skippedLastRun = stats.skipped;
        health.durationMsLastRun = stats.durationMs;

        return {
          ok: true,
          ...stats,
        };
      } catch (error: any) {
        const runCompletedAt = new Date();
        health.running = false;
        health.lastCompletedAt = runCompletedAt.toISOString();
        health.lastError = String(error?.message || error || "unknown_error");

        return {
          ok: false,
          chainId: chain.chainId,
          chainName: chain.name,
          error: health.lastError,
        };
      }
    }),
  );

  return {
    enabled: true,
    chains: results,
  };
}
