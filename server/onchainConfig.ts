import {
  DEFAULT_ONCHAIN_CHAIN_ID,
  DEFAULT_ONCHAIN_TESTNET_CHAINS,
  normalizeOnchainTokenSymbol,
  normalizeEvmAddress,
  normalizeOnchainAddress,
  type OnchainExecutionMode,
  type OnchainChainConfig,
  type OnchainChainKey,
  type OnchainPublicConfig,
  type OnchainTokenConfig,
  type OnchainTokenSymbol,
} from "@shared/onchainConfig";

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  const raw = value.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function parseChainId(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_ONCHAIN_CHAIN_ID;
  return parsed;
}

function parseOptionalChainId(value: string | undefined): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function chainKeyToEnvPrefix(key: OnchainChainKey): string {
  return key.replace(/-/g, "_").toUpperCase();
}

function parseEnabledChainIds(value: string | undefined): number[] {
  if (!value || !value.trim()) {
    return [8453, 56, 42161, 42220, 130, 1399811149];
  }
  const parsed = value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
  return parsed.length > 0
    ? Array.from(new Set(parsed))
    : [84532, 97, 421614, 11142220, 1301, 900001];
}

function parseExecutionMode(value: string | undefined): OnchainExecutionMode {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "contract") return "contract";
  return "metadata_only";
}

function withEnvTokenOverride(
  chain: OnchainChainConfig,
  symbol: OnchainTokenSymbol,
  defaults: OnchainTokenConfig,
): OnchainTokenConfig {
  const prefix = chainKeyToEnvPrefix(chain.key);
  const envKeyByChainName = `ONCHAIN_${prefix}_${symbol}_ADDRESS`;
  const envKeyByChainId = `ONCHAIN_${chain.chainId}_${symbol}_ADDRESS`;
  const envAddress = normalizeOnchainAddress(
    process.env[envKeyByChainName] || process.env[envKeyByChainId],
  );
  return {
    ...defaults,
    address: defaults.isNative ? null : envAddress || defaults.address,
  };
}

function withEnvChainOverride(chain: OnchainChainConfig): OnchainChainConfig {
  const prefix = chainKeyToEnvPrefix(chain.key);
  const chainIdEnv = parseOptionalChainId(process.env[`ONCHAIN_${prefix}_CHAIN_ID`]);
  const rpcUrl =
    process.env[`ONCHAIN_${prefix}_RPC_URL`] ||
    process.env[`ONCHAIN_${chain.chainId}_RPC_URL`] ||
    chain.rpcUrl;
  const escrowContractAddress = normalizeOnchainAddress(
    process.env.SOLANA_TREASURY_WALLET && chain.key.startsWith("solana") 
      ? process.env.SOLANA_TREASURY_WALLET 
      : (process.env[`ONCHAIN_${prefix}_ESCROW_ADDRESS`] ||
      process.env[`ONCHAIN_${chain.chainId}_ESCROW_ADDRESS`]),
  );
  const bantCreditsAddress = normalizeOnchainAddress(
    process.env[`ONCHAIN_${prefix}_BANTCREDITS_ADDRESS`] ||
      process.env[`ONCHAIN_${chain.chainId}_BANTCREDITS_ADDRESS`],
  );
  const simBattleRegistryAddress = normalizeOnchainAddress(
    process.env[`ONCHAIN_${prefix}_SIM_BATTLE_REGISTRY_ADDRESS`] ||
      process.env[`ONCHAIN_${chain.chainId}_SIM_BATTLE_REGISTRY_ADDRESS`],
  );
  const bantCreditRewardsAddress = normalizeOnchainAddress(
    process.env[`ONCHAIN_${prefix}_BANTCREDIT_REWARDS_ADDRESS`] ||
      process.env[`ONCHAIN_${chain.chainId}_BANTCREDIT_REWARDS_ADDRESS`],
  );
  const escrowSupportsChallengeLock = parseBool(
    process.env[`ONCHAIN_${prefix}_ESCROW_SUPPORTS_CHALLENGE_LOCK`] ||
      process.env[`ONCHAIN_${chain.chainId}_ESCROW_SUPPORTS_CHALLENGE_LOCK`] ||
      process.env.ONCHAIN_ESCROW_SUPPORTS_CHALLENGE_LOCK,
    false,
  );
  const escrowStakeMethodErc20 =
    process.env[`ONCHAIN_${prefix}_ESCROW_STAKE_METHOD_ERC20`] ||
    process.env[`ONCHAIN_${chain.chainId}_ESCROW_STAKE_METHOD_ERC20`] ||
    process.env.ONCHAIN_ESCROW_STAKE_METHOD_ERC20 ||
    "lockStakeToken(address,uint256)";
  const escrowSettleMethod =
    process.env[`ONCHAIN_${prefix}_ESCROW_SETTLE_METHOD`] ||
    process.env[`ONCHAIN_${chain.chainId}_ESCROW_SETTLE_METHOD`] ||
    process.env.ONCHAIN_ESCROW_SETTLE_METHOD ||
    "settleChallenge(uint256,uint8)";

  const effectiveChainId = chainIdEnv ?? chain.chainId;

  const supportedTokens = Array.isArray(chain.supportedTokens)
    ? chain.supportedTokens
    : [];
  const tokens: Record<OnchainTokenSymbol, OnchainTokenConfig> = {
    USDC: supportedTokens.includes("USDC")
      ? withEnvTokenOverride(chain, "USDC", chain.tokens.USDC)
      : chain.tokens.USDC,
    USDT: supportedTokens.includes("USDT")
      ? withEnvTokenOverride(chain, "USDT", chain.tokens.USDT)
      : chain.tokens.USDT,
    ETH: supportedTokens.includes("ETH")
      ? withEnvTokenOverride(chain, "ETH", chain.tokens.ETH)
      : chain.tokens.ETH,
    BNB: supportedTokens.includes("BNB")
      ? withEnvTokenOverride(chain, "BNB", chain.tokens.BNB)
      : chain.tokens.BNB,
  };

  return {
    ...chain,
    chainId: effectiveChainId,
    rpcUrl,
    escrowContractAddress,
    bantCreditsAddress,
    simBattleRegistryAddress,
    bantCreditRewardsAddress,
    escrowSupportsChallengeLock,
    escrowStakeMethodErc20: escrowStakeMethodErc20 ? escrowStakeMethodErc20.trim() : null,
    escrowSettleMethod: escrowSettleMethod ? escrowSettleMethod.trim() : null,
    tokens,
    supportedTokens,
  };
}

export function getOnchainServerConfig(): OnchainPublicConfig {
  const defaultChainId = parseChainId(process.env.ONCHAIN_DEFAULT_CHAIN_ID || process.env.ONCHAIN_CHAIN_ID);
  const enabledChainIds = parseEnabledChainIds(process.env.ONCHAIN_ENABLED_CHAINS);
  const defaultToken = normalizeOnchainTokenSymbol(process.env.ONCHAIN_DEFAULT_TOKEN || "USDC");
  const executionMode = parseExecutionMode(process.env.ONCHAIN_EXECUTION_MODE);
  const allChains = Object.values(DEFAULT_ONCHAIN_TESTNET_CHAINS).map(withEnvChainOverride);
  const chains = allChains
    .filter((chain) => enabledChainIds.includes(chain.chainId))
    .reduce<Record<string, OnchainChainConfig>>((acc, chain) => {
      acc[String(chain.chainId)] = chain;
      return acc;
    }, {});

  const fallbackChain =
    chains[String(defaultChainId)] ||
    chains[String(DEFAULT_ONCHAIN_CHAIN_ID)] ||
    Object.values(chains)[0] ||
    allChains[0];

  return {
    chainId: fallbackChain.chainId,
    rpcUrl: fallbackChain.rpcUrl,
    tokens: fallbackChain.tokens,
    defaultChainId: fallbackChain.chainId,
    enforceWallet: parseBool(process.env.ONCHAIN_ENFORCE_WALLET, true),
    defaultToken,
    executionMode,
    contractEnabled: executionMode === "contract",
    chains,
  };
}
