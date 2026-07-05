import axios from "axios";
import { normalizeEvmAddress, type OnchainTokenSymbol } from "@shared/onchainConfig";

const MINT_SELECTOR_HEX = "40c10f19";
const TOKEN_VALIDATION_CACHE_TTL_MS = 5 * 60 * 1000;
const tokenValidationCache = new Map<
  string,
  { checkedAt: number; allowed: boolean; reason?: string }
>();

function normalizeTxHash(input: unknown): `0x${string}` | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) return null;
  return value.toLowerCase() as `0x${string}`;
}

export interface VerifyEscrowTransactionParams {
  rpcUrl: string;
  expectedChainId: number;
  expectedFrom: string;
  expectedEscrowContract: string;
  tokenSymbol: OnchainTokenSymbol;
  txHash: string;
}

export interface VerifiedEscrowTransaction {
  txHash: `0x${string}`;
  chainId: number;
  from: string;
  to: string;
  blockNumber: string;
  status: "success";
  value: string;
}

function parseHexToNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw.startsWith("0x")) return null;
  try {
    return Number.parseInt(raw.slice(2), 16);
  } catch {
    return null;
  }
}

function parseHexToBigInt(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw.startsWith("0x")) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<any> {
  const response = await axios.post(
    rpcUrl,
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    },
    {
      timeout: 15000,
      headers: { "content-type": "application/json" },
    },
  );

  if (response.data?.error) {
    throw new Error(response.data.error.message || "RPC request failed");
  }
  return response.data?.result ?? null;
}

function decodeAbiString(hexValue: unknown): string | null {
  if (typeof hexValue !== "string") return null;
  const raw = hexValue.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(raw) || raw.length < 2) return null;
  const payload = raw.slice(2);
  if (!payload) return null;

  // Dynamic ABI string format: offset (32) + length (32) + bytes
  if (payload.length >= 128) {
    try {
      const offsetBytes = Number.parseInt(payload.slice(0, 64), 16);
      if (Number.isInteger(offsetBytes) && offsetBytes >= 0) {
        const offset = offsetBytes * 2;
        const lengthIndex = offset;
        const stringIndex = lengthIndex + 64;
        if (payload.length >= stringIndex) {
          const lenBytes = Number.parseInt(payload.slice(lengthIndex, lengthIndex + 64), 16);
          if (Number.isInteger(lenBytes) && lenBytes >= 0) {
            const len = lenBytes * 2;
            if (payload.length >= stringIndex + len) {
              const strHex = payload.slice(stringIndex, stringIndex + len);
              const decoded = Buffer.from(strHex, "hex").toString("utf8").replace(/\0/g, "").trim();
              return decoded || null;
            }
          }
        }
      }
    } catch {
      // Fall through to bytes32-style decode
    }
  }

  // Some tokens return bytes32 symbol/name
  if (payload.length >= 64) {
    try {
      const asBytes32 = payload.slice(0, 64);
      const decoded = Buffer.from(asBytes32, "hex").toString("utf8").replace(/\0/g, "").trim();
      return decoded || null;
    } catch {
      return null;
    }
  }

  return null;
}

function parseBlockedAddressSet(): Set<string> {
  const raw = String(process.env.ONCHAIN_BLOCKED_TOKEN_ADDRESSES || "")
    .split(",")
    .map((item) => normalizeEvmAddress(item))
    .filter((item): item is string => !!item);
  return new Set(raw);
}

function parseBlockedKeywordSet(): string[] {
  const raw = String(
    process.env.ONCHAIN_BLOCKED_TOKEN_NAME_KEYWORDS || "bantah,test token",
  )
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(raw));
}

async function readTokenMetadata(
  rpcUrl: string,
  tokenAddress: string,
): Promise<{ name: string | null; symbol: string | null; hasMintSelector: boolean }> {
  const [nameRaw, symbolRaw, codeRaw] = await Promise.all([
    rpcCall(rpcUrl, "eth_call", [{ to: tokenAddress, data: "0x06fdde03" }, "latest"]).catch(
      () => null,
    ),
    rpcCall(rpcUrl, "eth_call", [{ to: tokenAddress, data: "0x95d89b41" }, "latest"]).catch(
      () => null,
    ),
    rpcCall(rpcUrl, "eth_getCode", [tokenAddress, "latest"]).catch(() => "0x"),
  ]);

  const code = String(codeRaw || "").toLowerCase();
  return {
    name: decodeAbiString(nameRaw),
    symbol: decodeAbiString(symbolRaw),
    hasMintSelector: code.includes(MINT_SELECTOR_HEX),
  };
}

export async function assertAllowedStakeToken(params: {
  rpcUrl: string;
  tokenAddress: string;
  tokenSymbol?: string;
}): Promise<void> {
  const normalizedTokenAddress = normalizeEvmAddress(params.tokenAddress);
  if (!normalizedTokenAddress) {
    throw new Error("Stake token address is invalid");
  }

  const cacheKey = `${params.rpcUrl}::${normalizedTokenAddress}`;
  const cached = tokenValidationCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.checkedAt <= TOKEN_VALIDATION_CACHE_TTL_MS) {
    if (!cached.allowed) {
      throw new Error(cached.reason || "This token is not allowed for challenge staking");
    }
    return;
  }

  const blockedAddresses = parseBlockedAddressSet();
  if (blockedAddresses.has(normalizedTokenAddress)) {
    const reason =
      "This token address is blocked for challenge staking. Use official USDC/USDT/ETH contracts.";
    tokenValidationCache.set(cacheKey, { checkedAt: now, allowed: false, reason });
    throw new Error(reason);
  }

  const blockedKeywords = parseBlockedKeywordSet();
  const metadata = await readTokenMetadata(params.rpcUrl, normalizedTokenAddress);
  const tokenName = String(metadata.name || "").trim();
  const tokenSymbol = String(metadata.symbol || params.tokenSymbol || "").trim();
  const lowerName = tokenName.toLowerCase();
  const lowerSymbol = tokenSymbol.toLowerCase();
  const nameLooksBlocked = blockedKeywords.some(
    (keyword) => lowerName.includes(keyword) || lowerSymbol.includes(keyword),
  );
  const strictBlockMintable = String(process.env.ONCHAIN_STRICT_BLOCK_MINTABLE || "")
    .trim()
    .toLowerCase() === "true";

  if (nameLooksBlocked || (strictBlockMintable && metadata.hasMintSelector)) {
    const reason =
      "Mintable test token contracts are disabled for onchain challenge staking. Configure official token contracts.";
    tokenValidationCache.set(cacheKey, { checkedAt: now, allowed: false, reason });
    throw new Error(reason);
  }

  tokenValidationCache.set(cacheKey, { checkedAt: now, allowed: true });
}

export async function verifyEscrowTransaction(
  params: VerifyEscrowTransactionParams,
): Promise<VerifiedEscrowTransaction> {
  const normalizedFrom = normalizeEvmAddress(params.expectedFrom);
  const normalizedEscrow = normalizeEvmAddress(params.expectedEscrowContract);
  const normalizedHash = normalizeTxHash(params.txHash);

  if (!normalizedFrom) {
    throw new Error("Invalid wallet address for escrow verification");
  }
  if (!normalizedEscrow) {
    throw new Error("Escrow contract address is not configured");
  }
  if (!normalizedHash) {
    throw new Error("Invalid escrowTxHash");
  }

  let receipt: any = null;
  let tx: any = null;
  try {
    receipt = await rpcCall(params.rpcUrl, "eth_getTransactionReceipt", [normalizedHash]);
    tx = await rpcCall(params.rpcUrl, "eth_getTransactionByHash", [normalizedHash]);
  } catch (error: any) {
    throw new Error(error?.message || "Failed to fetch escrow transaction from RPC");
  }

  if (!receipt || !tx) {
    throw new Error("Escrow transaction hash was not found on the selected chain");
  }

  const statusHex = String(receipt?.status || "").toLowerCase();
  if (statusHex !== "0x1") {
    throw new Error("Escrow transaction did not succeed");
  }

  const txFrom = normalizeEvmAddress(tx?.from);
  if (!txFrom || txFrom !== normalizedFrom) {
    throw new Error("Escrow transaction sender does not match connected wallet");
  }

  const txTo = normalizeEvmAddress(tx?.to);
  if (!txTo || txTo !== normalizedEscrow) {
    throw new Error("Escrow transaction target does not match configured escrow contract");
  }

  const txChainId = parseHexToNumber(tx?.chainId) ?? Number(params.expectedChainId);
  if (!Number.isInteger(txChainId) || txChainId !== Number(params.expectedChainId)) {
    throw new Error("Escrow transaction was sent on the wrong chain");
  }

  const txValue = parseHexToBigInt(tx?.value) ?? 0n;
  const isNativeStakeToken = params.tokenSymbol === "ETH" || params.tokenSymbol === "BNB";
  if (isNativeStakeToken && txValue <= 0n) {
    throw new Error("Native-token escrow transaction must include a positive value");
  }

  const blockNumber = parseHexToBigInt(receipt?.blockNumber);
  if (blockNumber === null) {
    throw new Error("Escrow transaction receipt is missing block number");
  }

  return {
    txHash: normalizedHash,
    chainId: txChainId,
    from: txFrom,
    to: txTo,
    blockNumber: blockNumber.toString(),
    status: "success",
    value: txValue.toString(),
  };
}
