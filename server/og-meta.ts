import { CHALLENGE_PLATFORM_FEE_RATE } from "@shared/feeConfig";
import { storage } from "./storage";

export interface OGMetaData {
  title: string;
  description: string;
  image?: string;
  imageAlt?: string;
  url: string;
  type: string;
  siteName: string;
  twitterCard: string;
  twitterSite?: string;
}

const CHAIN_LABELS: Record<number, string> = {
  8453: "Base",
  56: "BSC",
  42161: "Arbitrum",
  130: "Unichain",
  1: "Ethereum",
};

function escapeMetaContent(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toTitleCase(value: string): string {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");
}

function formatTokenAmount(amount: unknown, tokenSymbol?: string | null): string {
  const numericAmount = Number(amount || 0);
  const safeAmount = Number.isFinite(numericAmount) ? numericAmount : 0;
  const formattedAmount = Number.isInteger(safeAmount)
    ? safeAmount.toString()
    : safeAmount.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4,
      });
  const symbol = String(tokenSymbol || "").trim().toUpperCase() || "ETH";
  return `${formattedAmount} ${symbol}`;
}

function formatPotentialPayout(amount: unknown, tokenSymbol?: string | null): string {
  const numericAmount = Number(amount || 0);
  const safeAmount = Number.isFinite(numericAmount) ? numericAmount : 0;
  const payoutAmount = safeAmount * 2 - safeAmount * CHALLENGE_PLATFORM_FEE_RATE;
  return formatTokenAmount(payoutAmount, tokenSymbol);
}

function formatDeadline(value: unknown): string {
  if (!value) return "No deadline";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "No deadline";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function buildVersionToken(...values: unknown[]): string {
  const token = values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("|");
  return encodeURIComponent(token || String(Date.now()));
}

function resolveChainLabel(chainId: unknown): string {
  const numericChainId = Number(chainId);
  if (!Number.isFinite(numericChainId) || numericChainId <= 0) {
    return "Onchain";
  }
  return CHAIN_LABELS[numericChainId] || `Chain ${numericChainId}`;
}

async function resolveChallengeParticipantLabels(challenge: any) {
  const challengerAgent = challenge.challengerAgentId
    ? await storage.getAgentById(String(challenge.challengerAgentId))
    : undefined;
  const challengedAgent = challenge.challengedAgentId
    ? await storage.getAgentById(String(challenge.challengedAgentId))
    : undefined;

  const challengerLabel = challengerAgent?.agentName
    || challenge.challengerUser?.username
    || challenge.challengerUser?.firstName
    || "Open";

  const challengedLabel = challengedAgent?.agentName
    || challenge.challengedUser?.username
    || challenge.challengedUser?.firstName
    || "Open";

  return {
    challengerLabel: String(challengerLabel).trim(),
    challengedLabel: String(challengedLabel).trim(),
    challengerIsAgent: Boolean(challengerAgent),
    challengedIsAgent: Boolean(challengedAgent),
  };
}

export async function generateEventOGMeta(eventId: string, baseUrl: string): Promise<OGMetaData> {
  try {
    const event = await storage.getEventById(parseInt(eventId, 10));
    if (!event) throw new Error("Event not found");

    const participants = await storage.getEventParticipants(parseInt(eventId, 10));

    return {
      title: `${event.title} | Bantah`,
      description: `Join ${participants.length} participants on this ${event.category || "prediction"} market on Bantah.`,
      image: `${baseUrl}/api/og/event/${eventId}`,
      imageAlt: `${event.title} on Bantah`,
      url: `${baseUrl}/events/${eventId}`,
      type: "article",
      siteName: "Bantah",
      twitterCard: "summary_large_image",
      twitterSite: "@BantahApp",
    };
  } catch {
    return getDefaultOGMeta(baseUrl);
  }
}

export async function generateChallengeOGMeta(challengeId: string, baseUrl: string): Promise<OGMetaData> {
  try {
    const challenge = await storage.getChallengeById(parseInt(challengeId, 10));
    if (!challenge) throw new Error("Challenge not found");

    const { challengerLabel, challengedLabel, challengerIsAgent, challengedIsAgent } =
      await resolveChallengeParticipantLabels(challenge);

    const challengerSide = String(challenge.challengerSide || "").toUpperCase() || "OPEN";
    const challengedSide = String(challenge.challengedSide || "").toUpperCase() || "OPEN";
    const stakeText = formatTokenAmount(challenge.amount, challenge.tokenSymbol);
    const payoutText = formatPotentialPayout(challenge.amount, challenge.tokenSymbol);
    const deadlineText = formatDeadline(challenge.dueDate);
    const chainText = resolveChainLabel(challenge.chainId);
    const statusText = toTitleCase(String(challenge.status || "open"));
    const imageVersion = buildVersionToken(
      challenge.updatedAt,
      challenge.completedAt,
      challenge.status,
      challenge.challenged,
      challenge.result,
      challenge.coverImageUrl,
      challenge.participantCount,
      ...(Array.isArray(challenge.participantPreviewUsers)
        ? challenge.participantPreviewUsers.map((participant: any) =>
            [
              participant?.id,
              participant?.username,
              participant?.firstName,
              participant?.side,
              participant?.profileImageUrl,
            ]
              .filter(Boolean)
              .join(":"),
          )
        : []),
    );

    const participantText = challenge.challenged
      ? `${challengerSide} by @${challengerLabel} vs ${challengedSide} by @${challengedLabel}`
      : `${challengerSide} by @${challengerLabel} • waiting for an opponent`;

    const agentText = challengerIsAgent || challengedIsAgent
      ? ` ${challengerIsAgent && challengedIsAgent ? "Agent vs Agent." : "Agent-involved challenge."}`
      : "";

    const description = `${participantText}. Status ${statusText}. Stake ${stakeText}. Potential payout ${payoutText}. ${chainText}. Ends ${deadlineText}.${agentText}`.slice(0, 280);

    return {
      title: `${challenge.title} | Bantah Challenge`,
      description,
      image: `${baseUrl}/api/og/challenges/${challengeId}.png?v=${imageVersion}`,
      imageAlt: `${challenge.title} on Bantah`,
      url: `${baseUrl}/challenges/${challengeId}`,
      type: "article",
      siteName: "Bantah",
      twitterCard: "summary_large_image",
      twitterSite: "@BantahApp",
    };
  } catch {
    return getDefaultOGMeta(baseUrl);
  }
}

export async function generateReferralOGMeta(referralCode: string, baseUrl: string): Promise<OGMetaData> {
  try {
    const user = await storage.getUserByReferralCode(referralCode);
    if (!user) throw new Error("Referral code not found");

    const inviterName = user.firstName || user.username || "a friend";

    return {
      title: `Join Bantah with ${inviterName}'s invite`,
      description: `${inviterName} invited you to Bantah. Sign up, earn BantCredit, and start joining onchain challenges.`,
      image: `${baseUrl}/assets/bantahlogo.png`,
      imageAlt: `Join Bantah with ${inviterName}'s invite`,
      url: `${baseUrl}?ref=${referralCode}`,
      type: "website",
      siteName: "Bantah",
      twitterCard: "summary_large_image",
      twitterSite: "@BantahApp",
    };
  } catch {
    return getDefaultOGMeta(baseUrl);
  }
}

export async function generateProfileOGMeta(userId: string, baseUrl: string): Promise<OGMetaData> {
  try {
    const user = await storage.getUser(userId);
    if (!user) throw new Error("User not found");

    const profileName = user.firstName || user.username || "Bantah user";

    return {
      title: `${profileName} | Bantah Profile`,
      description: `See ${profileName}'s activity, wins, and profile on Bantah.`,
      image: `${baseUrl}/assets/bantahlogo.png`,
      imageAlt: `${profileName} on Bantah`,
      url: `${baseUrl}/profile/${userId}`,
      type: "profile",
      siteName: "Bantah",
      twitterCard: "summary_large_image",
      twitterSite: "@BantahApp",
    };
  } catch {
    return getDefaultOGMeta(baseUrl);
  }
}

export function getDefaultOGMeta(baseUrl: string): OGMetaData {
  return {
    title: "Bantah | Onchain social prediction markets",
    description: "Create, join, and share onchain prediction challenges on Bantah.",
    image: `${baseUrl}/assets/bantahlogo.png`,
    imageAlt: "Bantah",
    url: baseUrl,
    type: "website",
    siteName: "Bantah",
    twitterCard: "summary_large_image",
    twitterSite: "@BantahApp",
  };
}

export function generateOGMetaTags(meta: OGMetaData): string {
  const title = escapeMetaContent(meta.title);
  const description = escapeMetaContent(meta.description);
  const image = escapeMetaContent(meta.image || "");
  const imageAlt = escapeMetaContent(meta.imageAlt || meta.title);
  const url = escapeMetaContent(meta.url);
  const siteName = escapeMetaContent(meta.siteName);
  const twitterSite = meta.twitterSite ? escapeMetaContent(meta.twitterSite) : "";

  return `
    <meta property="og:type" content="${escapeMetaContent(meta.type)}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:image" content="${image}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${imageAlt}" />
    <meta property="og:site_name" content="${siteName}" />

    <meta name="twitter:card" content="${escapeMetaContent(meta.twitterCard)}" />
    <meta name="twitter:url" content="${url}" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${image}" />
    <meta name="twitter:image:alt" content="${imageAlt}" />
    ${twitterSite ? `<meta name="twitter:site" content="${twitterSite}" />` : ""}

    <meta name="title" content="${title}" />
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${url}" />
    <meta name="robots" content="index, follow" />
  `.trim();
}
