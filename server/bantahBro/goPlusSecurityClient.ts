import type { BantahBroTokenRef } from "@shared/bantahBro";

type GoPlusStatus = "available" | "disabled" | "unsupported" | "error";
type SecurityTone = "safe" | "warning" | "danger" | "unknown";

export type GoPlusSecurityFlag = {
  key: string;
  label: string;
  tone: SecurityTone;
  value: string | null;
};

export type GoPlusSecuritySnapshot = {
  source: "goplus";
  status: GoPlusStatus;
  chainId: string;
  tokenAddress: string;
  network: string | null;
  error: string | null;
  contractRisk: {
    status: SecurityTone;
    label: string;
    detail: string;
  };
  liquidityLock: {
    status: SecurityTone;
    label: string;
    lockedPercent: number | null;
    detail: string;
  };
  flags: GoPlusSecurityFlag[];
};

const GOPLUS_API_BASE =
  process.env.GOPLUS_API_BASE?.replace(/\/+$/, "") ||
  "https://api.gopluslabs.io/api/v1";
const GOPLUS_FETCH_TIMEOUT_MS = Number(process.env.BANTAHBRO_GOPLUS_FETCH_TIMEOUT_MS || 4_000);

function normalizeChainId(chainId: string): { kind: "evm" | "solana" | "unsupported"; id: string | null } {
  const normalized = String(chainId || "").trim().toLowerCase();
  const aliases: Record<string, string> = {
    ethereum: "1",
    eth: "1",
    "1": "1",
    bsc: "56",
    "56": "56",
    base: "8453",
    "8453": "8453",
    arbitrum: "42161",
    "42161": "42161",
    polygon: "137",
    "137": "137",
    optimism: "10",
    "10": "10",
  };

  if (normalized === "solana" || normalized === "sol") return { kind: "solana", id: "solana" };
  return aliases[normalized] ? { kind: "evm", id: aliases[normalized] } : { kind: "unsupported", id: null };
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boolFlag(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function emptySnapshot(
  ref: BantahBroTokenRef,
  status: GoPlusStatus,
  network: string | null,
  error: string | null,
): GoPlusSecuritySnapshot {
  return {
    source: "goplus",
    status,
    chainId: ref.chainId,
    tokenAddress: ref.tokenAddress,
    network,
    error,
    contractRisk: {
      status: "unknown",
      label: "Contract not verified",
      detail: error || "No live contract-risk adapter result is available.",
    },
    liquidityLock: {
      status: "unknown",
      label: "LP lock not verified",
      lockedPercent: null,
      detail: error || "No live liquidity-lock adapter result is available.",
    },
    flags: [],
  };
}

async function fetchJson(url: string) {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = process.env.GOPLUS_API_TOKEN?.trim() || process.env.GOPLUS_ACCESS_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(GOPLUS_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`GoPlus request failed with ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

function extractResult(data: unknown, tokenAddress: string) {
  const root = getRecord(data);
  const result = getRecord(root.result);
  const lower = tokenAddress.toLowerCase();

  const candidates = [
    getRecord(result[tokenAddress]),
    getRecord(result[lower]),
    getRecord(result[Object.keys(result).find((key) => key.toLowerCase() === lower) || ""]),
  ];

  for (const candidate of candidates) {
    if (Object.keys(candidate).length) return candidate;
  }

  return result;
}

function pushFlag(
  flags: GoPlusSecurityFlag[],
  raw: Record<string, unknown>,
  key: string,
  label: string,
  riskyWhenTrue = true,
) {
  const value = boolFlag(raw[key]);
  if (value === null) return;
  const risky = riskyWhenTrue ? value : !value;
  flags.push({
    key,
    label,
    tone: risky ? "danger" : "safe",
    value: value ? "yes" : "no",
  });
}

function extractLockedPercent(raw: Record<string, unknown>) {
  const direct =
    toNumber(raw.lp_locked_percent) ??
    toNumber(raw.lp_lock_percent) ??
    toNumber(raw.liquidity_locked_percent) ??
    toNumber(raw.locked_percent);
  if (direct !== null) return direct <= 1 ? direct * 100 : direct;

  const holders = Array.isArray(raw.lp_holders) ? (raw.lp_holders as unknown[]) : [];
  let locked = 0;
  let sawPercent = false;
  for (const holder of holders) {
    const item = getRecord(holder);
    const tag = String(item.tag || item.label || "").toLowerCase();
    const isLocked =
      boolFlag(item.is_locked) === true ||
      tag.includes("lock") ||
      tag.includes("burn") ||
      tag.includes("dead");
    const percent = toNumber(item.percent);
    if (percent !== null) sawPercent = true;
    if (isLocked && percent !== null) locked += percent <= 1 ? percent * 100 : percent;
  }
  return sawPercent ? Math.min(100, Math.max(0, locked)) : null;
}

function normalizeSecurity(ref: BantahBroTokenRef, network: string, raw: Record<string, unknown>): GoPlusSecuritySnapshot {
  const flags: GoPlusSecurityFlag[] = [];
  pushFlag(flags, raw, "is_honeypot", "Honeypot risk");
  pushFlag(flags, raw, "cannot_sell_all", "Cannot sell all");
  pushFlag(flags, raw, "is_blacklisted", "Blacklist logic");
  pushFlag(flags, raw, "is_whitelisted", "Whitelist-only trading");
  pushFlag(flags, raw, "hidden_owner", "Hidden owner");
  pushFlag(flags, raw, "is_mintable", "Mint function");
  pushFlag(flags, raw, "can_take_back_ownership", "Ownership can be reclaimed");
  pushFlag(flags, raw, "owner_change_balance", "Owner can change balances");
  pushFlag(flags, raw, "selfdestruct", "Self destruct");
  pushFlag(flags, raw, "external_call", "External call dependency");
  pushFlag(flags, raw, "transfer_pausable", "Transfers can pause");
  pushFlag(flags, raw, "is_open_source", "Open source contract", false);
  pushFlag(flags, raw, "is_proxy", "Proxy contract");

  const buyTax = toNumber(raw.buy_tax);
  const sellTax = toNumber(raw.sell_tax);
  if (buyTax !== null && buyTax >= 0.15) {
    flags.push({ key: "buy_tax", label: "High buy tax", tone: buyTax >= 0.3 ? "danger" : "warning", value: formatPercent(buyTax * 100) });
  }
  if (sellTax !== null && sellTax >= 0.15) {
    flags.push({ key: "sell_tax", label: "High sell tax", tone: sellTax >= 0.3 ? "danger" : "warning", value: formatPercent(sellTax * 100) });
  }

  const mintAuthority = raw.mint_authority ?? raw.mintAuthority;
  if (typeof mintAuthority === "string" && mintAuthority.trim()) {
    flags.push({ key: "mint_authority", label: "Mint authority active", tone: "warning", value: "yes" });
  }
  const freezeAuthority = raw.freeze_authority ?? raw.freezeAuthority;
  if (typeof freezeAuthority === "string" && freezeAuthority.trim()) {
    flags.push({ key: "freeze_authority", label: "Freeze authority active", tone: "danger", value: "yes" });
  }

  const dangerous = flags.filter((flag) => flag.tone === "danger");
  const warnings = flags.filter((flag) => flag.tone === "warning");
  const lockedPercent = extractLockedPercent(raw);
  const liquidityLock =
    lockedPercent === null
      ? {
          status: "unknown" as const,
          label: "LP lock not verified",
          lockedPercent,
          detail: "GoPlus did not return a verifiable LP lock percentage for this token.",
        }
      : lockedPercent >= 70
        ? {
            status: "safe" as const,
            label: `${formatPercent(lockedPercent)} LP locked/burned`,
            lockedPercent,
            detail: "GoPlus returned a high locked/burned LP holder percentage.",
          }
        : lockedPercent > 0
          ? {
              status: "warning" as const,
              label: `${formatPercent(lockedPercent)} LP locked`,
              lockedPercent,
              detail: "Only part of visible LP supply is locked/burned.",
            }
          : {
              status: "danger" as const,
              label: "No LP lock detected",
              lockedPercent,
              detail: "GoPlus returned LP holder data without a locked/burned share.",
            };

  return {
    source: "goplus",
    status: "available",
    chainId: ref.chainId,
    tokenAddress: ref.tokenAddress,
    network,
    error: null,
    contractRisk: dangerous.length
      ? {
          status: "danger",
          label: `${dangerous.length} contract red flag${dangerous.length === 1 ? "" : "s"}`,
          detail: dangerous.slice(0, 3).map((flag) => flag.label).join(", "),
        }
      : warnings.length
        ? {
            status: "warning",
            label: `${warnings.length} contract warning${warnings.length === 1 ? "" : "s"}`,
            detail: warnings.slice(0, 3).map((flag) => flag.label).join(", "),
          }
        : {
            status: "safe",
            label: "No GoPlus contract red flags",
            detail: "GoPlus returned no high-risk contract flags in this scan.",
          },
    liquidityLock,
    flags,
  };
}

export async function fetchGoPlusTokenSecurity(ref: BantahBroTokenRef): Promise<GoPlusSecuritySnapshot> {
  const resolved = normalizeChainId(ref.chainId);
  if (resolved.kind === "unsupported" || !resolved.id) {
    return emptySnapshot(ref, "unsupported", null, `GoPlus token security does not support chain ${ref.chainId}.`);
  }

  try {
    const url =
      resolved.kind === "solana"
        ? `${GOPLUS_API_BASE}/solana/token_security?contract_addresses=${encodeURIComponent(ref.tokenAddress)}`
        : `${GOPLUS_API_BASE}/token_security/${encodeURIComponent(resolved.id)}?contract_addresses=${encodeURIComponent(ref.tokenAddress)}`;
    const data = await fetchJson(url);
    const root = getRecord(data);
    if (String(root.code || "1") !== "1") {
      return emptySnapshot(ref, "error", resolved.id, String(root.message || "GoPlus returned a non-success response."));
    }
    const raw = extractResult(data, ref.tokenAddress);
    if (!Object.keys(raw).length) {
      return emptySnapshot(ref, "error", resolved.id, "GoPlus returned no token security result.");
    }
    return normalizeSecurity(ref, resolved.id, raw);
  } catch (error) {
    return emptySnapshot(
      ref,
      "error",
      resolved.id,
      error instanceof Error ? error.message : "GoPlus token security request failed.",
    );
  }
}
