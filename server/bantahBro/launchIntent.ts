import type {
  BantahLauncherDeployRequest,
  BantahLauncherDraftRequest,
} from "@shared/bantahLauncher";
import {
  validateBantahLaunchDraft,
} from "./tokenLauncher";

type LaunchIntentResult = {
  handled: boolean;
  reply: string;
  launcher?: {
    validation?: ReturnType<typeof validateBantahLaunchDraft>;
    deployPayload?: BantahLauncherDeployRequest;
    missingFields: string[];
  };
};

const chainAliases: Array<{ pattern: RegExp; chainId: number; label: string }> = [
  { pattern: /\bbase\s+sepolia\b/i, chainId: 84532, label: "Base Sepolia" },
  { pattern: /\barbitrum\s+sepolia\b|\barb\s+sepolia\b/i, chainId: 421614, label: "Arbitrum Sepolia" },
  { pattern: /\barbitrum\b|\barb\b/i, chainId: 42161, label: "Arbitrum" },
  { pattern: /\bbase\b/i, chainId: 8453, label: "Base" },
];

function cleanCaptured(value: string) {
  return value
    .replace(/[",;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function capture(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1] ? cleanCaptured(match[1]) : null;
}

function parseChain(text: string) {
  const match = chainAliases.find((candidate) => candidate.pattern.test(text));
  return match || chainAliases[3];
}

function parseOwnerAddress(text: string) {
  return text.match(/\b(0x[a-fA-F0-9]{40})\b/)?.[1] || null;
}

function parseLaunchDraft(text: string) {
  const chain = parseChain(text);
  const ownerAddress = parseOwnerAddress(text);
  const tokenSymbol =
    capture(text, /\b(?:symbol|ticker)\s*[:=]?\s*\$?([A-Za-z0-9]{2,16})\b/i) ||
    capture(text, /\$([A-Za-z0-9]{2,16})\b/);
  const tokenName =
    capture(
      text,
      /\b(?:token\s+name|name|called)\s*[:=]?\s*["']?(.+?)(?=\s+(?:symbol|ticker|\$|supply|initial\s+supply|owner|wallet|on\s+base|on\s+arbitrum|chain|decimals)\b|$)/i,
    ) ||
    (tokenSymbol ? `${tokenSymbol} Token` : null);
  const initialSupplyRaw = capture(
    text,
    /\b(?:initial\s+supply|supply)\s*[:=]?\s*([\d,]+(?:\.\d+)?)\b/i,
  );
  const decimalsRaw = capture(text, /\bdecimals\s*[:=]?\s*(\d{1,2})\b/i);

  const missingFields = [
    !tokenName ? "token name" : null,
    !tokenSymbol ? "symbol" : null,
    !initialSupplyRaw ? "initial supply" : null,
    !ownerAddress ? "owner wallet" : null,
  ].filter(Boolean) as string[];

  if (!tokenName || !tokenSymbol || !initialSupplyRaw) {
    return { draft: null, missingFields, chain };
  }

  const draft: BantahLauncherDraftRequest = {
    tokenName,
    tokenSymbol,
    chainId: chain.chainId,
    initialSupply: initialSupplyRaw.replace(/,/g, ""),
    decimals: decimalsRaw ? Number(decimalsRaw) : 18,
    ...(ownerAddress ? { ownerAddress } : {}),
  };

  return { draft, missingFields, chain };
}

export function isTokenLaunchIntent(text: string) {
  return /\b(?:launch|deploy|create)\b/i.test(text) && /\b(?:token|coin)\b/i.test(text);
}

export function handleTokenLaunchIntent(text: string): LaunchIntentResult {
  if (!isTokenLaunchIntent(text)) {
    return { handled: false, reply: "" };
  }

  const { draft, missingFields, chain } = parseLaunchDraft(text);
  if (!draft) {
    return {
      handled: true,
      reply:
        `I can prep that token launch on ${chain.label}, but I still need: ${missingFields.join(", ")}.\n\n` +
        "Use: launch token name Bantah Demo symbol BDEMO supply 1000000 owner 0xYourWallet on Base",
      launcher: { missingFields },
    };
  }

  const validation = validateBantahLaunchDraft(draft);
  const deployPayload =
    draft.ownerAddress && validation.ok
      ? {
          ...draft,
          ownerAddress: draft.ownerAddress,
          confirm: true as const,
        }
      : undefined;

  const warnings = validation.warnings.length
    ? `\n\nWarnings:\n${validation.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : "";
  const confirmLine = deployPayload
    ? "\n\nIf this looks right, use the confirm button in chat. I will not deploy until you explicitly confirm."
    : "\n\nAdd the missing owner wallet or wait until the chain factory is configured before deploying.";

  return {
    handled: true,
    reply:
      `Launch draft ready for ${validation.draft.tokenName} (${validation.draft.tokenSymbol}) on ${validation.draft.chainName}.\n` +
      `Supply: ${validation.draft.initialSupply} fixed-supply tokens\n` +
      `Owner: ${validation.draft.ownerAddress || "missing"}\n` +
      `Factory: ${validation.draft.factoryAddress || "not configured"}` +
      warnings +
      confirmLine,
    launcher: {
      validation,
      deployPayload,
      missingFields,
    },
  };
}
