import type { Express, NextFunction, Request, Response } from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { storage } from "../storage";
import {
  getBotaAgentChallengeByCode,
  type BotaAgentChallenge,
} from "./botaAgentChallengeService";
import {
  getLiveBantahBroAgentBattles,
  type BantahBroAgentBattle,
} from "./agentBattleService";
import {
  getBotaFighterProfile,
} from "./botaFighterProfileService";
import {
  getBotaArenaBattleRecord,
} from "./botaArenaBattleRecordService";
import type { BotaFighterProfile } from "@shared/botaFighterProfile";
import type { BotaArenaBattleRecord } from "@shared/botaArenaBattleRecord";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 800;
const SITE_NAME = "Battle Of The Agents";
const DEFAULT_PUBLIC_BASE_URL = "https://bota.bantah.fun";
const BOTA_HANDLE = "@bantahfun";
const BOTA_ROOT_HOSTS = new Set(["bota.bantah.fun", "battle.bantah.fun"]);
const LOGO_CANDIDATES = [
  path.resolve(process.cwd(), "client/public/assets/bota-bantah-logo.jpg"),
  path.resolve(process.cwd(), "dist/public/assets/bota-bantah-logo.jpg"),
  path.resolve(__dirname, "../../client/public/assets/bota-bantah-logo.jpg"),
  path.resolve(__dirname, "../../dist/public/assets/bota-bantah-logo.jpg"),
];
const ICON_CANDIDATES = [
  path.resolve(process.cwd(), "client/public/assets/bota-bantah-icon.png"),
  path.resolve(process.cwd(), "dist/public/assets/bota-bantah-icon.png"),
  path.resolve(__dirname, "../../client/public/assets/bota-bantah-icon.png"),
  path.resolve(__dirname, "../../dist/public/assets/bota-bantah-icon.png"),
];

type ShareKind = "challenge" | "arena" | "referral" | "agent" | "result";

type ShareFighter = {
  name: string;
  subtitle: string;
  rank?: string | null;
  record?: string | null;
  avatarUrl?: string | null;
  tokenSymbol?: string | null;
};

type ShareCardData = {
  kind: ShareKind;
  badge: string;
  status: string;
  title: string;
  description: string;
  url: string;
  imageUrl: string;
  cta: string;
  left?: ShareFighter;
  right?: ShareFighter;
  metrics: Array<{ label: string; value: string }>;
  footer?: string;
  referralCode?: string | null;
};

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeXml(value: unknown) {
  return escapeHtml(value);
}

function truncate(value: unknown, maxLength: number) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function initials(value: unknown) {
  const clean = String(value || "BOTA").replace(/^@/, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return clean.slice(0, 2).toUpperCase();
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function getPublicBaseUrl(req: Request) {
  const configured = String(
    process.env.PUBLIC_APP_URL ||
      process.env.FRONTEND_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      process.env.VERCEL_URL ||
      "",
  ).trim();
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || req.get("host") || "";
  const requestBase = host
    ? `${forwardedProto || req.protocol || "https"}://${host}`
    : DEFAULT_PUBLIC_BASE_URL;
  if (isBotaRootHostUrl(requestBase)) return new URL(requestBase).origin;

  const rawBase = configured || requestBase || DEFAULT_PUBLIC_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(rawBase) ? rawBase : `https://${rawBase}`;
  try {
    return new URL(withProtocol).origin;
  } catch {
    return DEFAULT_PUBLIC_BASE_URL;
  }
}

function absoluteUrl(baseUrl: string, value: string) {
  if (/^https?:\/\//i.test(value)) return value;
  return `${baseUrl}${value.startsWith("/") ? value : `/${value}`}`;
}

function appUrl(baseUrl: string, pathValue: string) {
  const normalizedPath = isBotaRootHostUrl(baseUrl)
    ? pathValue.replace(/^\/bota(?=\/|\?|$)/i, "") || "/"
    : pathValue;
  return absoluteUrl(baseUrl, normalizedPath);
}

function cardUrl(baseUrl: string, pathValue: string) {
  return absoluteUrl(baseUrl, pathValue);
}

function formatNumber(value: unknown) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return "0";
  if (parsed >= 1_000_000_000) return `${(parsed / 1_000_000_000).toFixed(1)}B`;
  if (parsed >= 1_000_000) return `${(parsed / 1_000_000).toFixed(1)}M`;
  if (parsed >= 1_000) return `${(parsed / 1_000).toFixed(1)}K`;
  return Math.round(parsed).toLocaleString("en-US");
}

function formatCurrency(value: unknown, currency = "USDC") {
  const parsed = Number(value || 0);
  const safe = Number.isFinite(parsed) ? parsed : 0;
  return `${formatNumber(safe)} ${currency}`;
}

function formatUsd(value: unknown) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return "n/a";
  if (parsed >= 1_000_000_000) return `$${(parsed / 1_000_000_000).toFixed(1)}B`;
  if (parsed >= 1_000_000) return `$${(parsed / 1_000_000).toFixed(1)}M`;
  if (parsed >= 1_000) return `$${(parsed / 1_000).toFixed(1)}K`;
  return `$${parsed.toFixed(2)}`;
}

function secondsLabel(value: unknown) {
  const seconds = Math.max(0, Math.round(Number(value || 0)));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function isBotaRootHostUrl(value: string) {
  try {
    return BOTA_ROOT_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function botaAppPath(baseUrl: string, query?: URLSearchParams | string) {
  const rootPath = isBotaRootHostUrl(baseUrl) ? "/" : "/bota";
  const queryString =
    typeof query === "string"
      ? query.replace(/^\?/, "")
      : query?.toString() || "";
  return queryString ? `${rootPath}?${queryString}` : rootPath;
}

function challengePath(baseUrl: string, challengeCode: string) {
  const query = new URLSearchParams({
    section: "challenge",
    challenge: challengeCode,
  });
  return botaAppPath(baseUrl, query);
}

function arenaPath(baseUrl: string, battleId: string) {
  const query = new URLSearchParams({
    section: "arena",
    battle: battleId,
  });
  return botaAppPath(baseUrl, query);
}

function agentPath(baseUrl: string, agentId: string) {
  const query = new URLSearchParams({
    section: "agents",
    agent: agentId,
  });
  return botaAppPath(baseUrl, query);
}

function resultPath(baseUrl: string, recordId: string, battleId?: string | null) {
  const query = new URLSearchParams({
    section: "arena",
    result: recordId,
  });
  if (battleId) query.set("battle", battleId);
  return botaAppPath(baseUrl, query);
}

function referralPath(baseUrl: string, referralCode: string) {
  const query = new URLSearchParams({
    ref: referralCode,
  });
  return botaAppPath(baseUrl, query);
}

async function readFirstAvailableAsDataUri(paths: string[], mimeType: string) {
  for (const candidate of paths) {
    try {
      const buffer = await fs.readFile(candidate);
      return `data:${mimeType};base64,${buffer.toString("base64")}`;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function resolveLocalImageDataUri(source: unknown) {
  const raw = String(source || "").trim();
  if (!raw) return null;
  if (raw.startsWith("data:image/")) return raw;
  if (/^https?:\/\//i.test(raw)) return null;

  const publicRelative = raw.startsWith("/") ? raw.slice(1) : raw;
  const candidates = [
    path.resolve(process.cwd(), "client/public", publicRelative),
    path.resolve(process.cwd(), "dist/public", publicRelative),
    path.resolve(__dirname, "../../client/public", publicRelative),
    path.resolve(__dirname, "../../dist/public", publicRelative),
  ];
  for (const candidate of candidates) {
    try {
      const buffer = await fs.readFile(candidate);
      const extension = path.extname(candidate).toLowerCase();
      const mimeType =
        extension === ".png"
          ? "image/png"
          : extension === ".webp"
            ? "image/webp"
            : extension === ".svg"
              ? "image/svg+xml"
              : "image/jpeg";
      return `data:${mimeType};base64,${buffer.toString("base64")}`;
    } catch {
      // Try next.
    }
  }
  return null;
}

async function renderShareCardImage(svg: string): Promise<{ buffer: Buffer; contentType: string }> {
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: "width",
        value: CARD_WIDTH,
      },
      font: {
        loadSystemFonts: true,
      },
    });
    return {
      buffer: Buffer.from(resvg.render().asPng()),
      contentType: "image/png",
    };
  } catch (error) {
    console.warn("Falling back to SVG BOTA share card image:", error);
    return {
      buffer: Buffer.from(svg),
      contentType: "image/svg+xml",
    };
  }
}

function fighterCardMarkup(input: {
  fighter: ShareFighter;
  side: "left" | "right";
  x: number;
  y: number;
  avatarDataUri: string | null;
}) {
  const { fighter, side, x, y, avatarDataUri } = input;
  const accent = side === "left" ? "#C6FF28" : "#9C7CFF";
  const glow = side === "left" ? "#72D400" : "#6B4DFF";
  const textAnchor = side === "left" ? "start" : "end";
  const textX = side === "left" ? x + 42 : x + 338;
  const avatarX = side === "left" ? x + 34 : x + 210;
  const avatarClipId = `avatar-${side}`;
  const statStart = side === "left" ? x + 40 : x + 182;

  return `
    <g>
      <rect x="${x}" y="${y}" width="380" height="390" rx="38" fill="#0C0F18" fill-opacity="0.82" stroke="${accent}" stroke-opacity="0.28" stroke-width="2" />
      <rect x="${x + 14}" y="${y + 14}" width="352" height="362" rx="30" fill="url(#fighterGlass)" stroke="#FFFFFF" stroke-opacity="0.10" />
      <circle cx="${avatarX + 68}" cy="${y + 116}" r="92" fill="${glow}" fill-opacity="0.22" />
      <circle cx="${avatarX + 68}" cy="${y + 116}" r="74" fill="#111827" stroke="${accent}" stroke-width="3" />
      <clipPath id="${avatarClipId}">
        <circle cx="${avatarX + 68}" cy="${y + 116}" r="68" />
      </clipPath>
      ${
        avatarDataUri
          ? `<image href="${avatarDataUri}" x="${avatarX}" y="${y + 48}" width="136" height="136" preserveAspectRatio="xMidYMid slice" clip-path="url(#${avatarClipId})" />`
          : `<text x="${avatarX + 68}" y="${y + 135}" fill="#FFFFFF" font-size="46" font-weight="900" text-anchor="middle" font-family="Inter, Arial">${escapeXml(initials(fighter.name))}</text>`
      }
      <text x="${textX}" y="${y + 238}" fill="#FFFFFF" font-size="34" font-weight="950" text-anchor="${textAnchor}" font-family="Inter, Arial">${escapeXml(truncate(fighter.name, 15))}</text>
      <text x="${textX}" y="${y + 272}" fill="${accent}" font-size="18" font-weight="850" text-anchor="${textAnchor}" font-family="Inter, Arial">${escapeXml(truncate(fighter.subtitle, 28))}</text>
      <g>
        <rect x="${statStart}" y="${y + 304}" width="158" height="40" rx="20" fill="#080B12" stroke="#FFFFFF" stroke-opacity="0.08" />
        <text x="${statStart + 79}" y="${y + 330}" fill="#FFFFFF" font-size="19" font-weight="900" text-anchor="middle" font-family="Inter, Arial">${escapeXml(fighter.rank || "Rank --")}</text>
      </g>
      <g>
        <rect x="${statStart}" y="${y + 350}" width="158" height="40" rx="20" fill="#080B12" stroke="#FFFFFF" stroke-opacity="0.08" />
        <text x="${statStart + 79}" y="${y + 376}" fill="#FFFFFF" font-size="19" font-weight="900" text-anchor="middle" font-family="Inter, Arial">${escapeXml(fighter.record || "0-0")}</text>
      </g>
    </g>
  `;
}

function agentProfileMarkup(input: {
  fighter: ShareFighter;
  avatarDataUri: string | null;
}) {
  const { fighter, avatarDataUri } = input;

  return `
    <g>
      <rect x="310" y="176" width="580" height="386" rx="42" fill="#0C0F18" fill-opacity="0.86" stroke="#C6FF28" stroke-opacity="0.30" stroke-width="2" />
      <rect x="328" y="194" width="544" height="350" rx="32" fill="url(#fighterGlass)" stroke="#FFFFFF" stroke-opacity="0.10" />
      <circle cx="600" cy="300" r="112" fill="#C6FF28" fill-opacity="0.18" />
      <circle cx="600" cy="300" r="92" fill="#05070C" stroke="#C6FF28" stroke-opacity="0.75" stroke-width="4" />
      <clipPath id="avatar-agent">
        <circle cx="600" cy="300" r="84" />
      </clipPath>
      ${
        avatarDataUri
          ? `<image href="${avatarDataUri}" x="516" y="216" width="168" height="168" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-agent)" />`
          : `<text x="600" y="328" fill="#FFFFFF" font-size="62" font-weight="900" text-anchor="middle" font-family="Inter, Arial">${escapeXml(initials(fighter.name))}</text>`
      }
      <text x="600" y="454" fill="#FFFFFF" font-size="56" font-weight="950" text-anchor="middle" font-family="Inter, Arial">${escapeXml(truncate(fighter.name, 20))}</text>
      <text x="600" y="496" fill="#C6FF28" font-size="24" font-weight="900" text-anchor="middle" font-family="Inter, Arial">${escapeXml(truncate(fighter.subtitle, 42))}</text>
      <text x="600" y="532" fill="#AAB3C7" font-size="19" font-weight="800" text-anchor="middle" font-family="Inter, Arial">
        ${escapeXml([fighter.rank, fighter.record].filter(Boolean).join(" / ") || "BOTA Fighter")}
      </text>
    </g>
  `;
}

function metricMarkup(metric: { label: string; value: string }, index: number) {
  const x = 146 + index * 230;
  return `
    <g>
      <rect x="${x}" y="646" width="190" height="74" rx="22" fill="#090C13" fill-opacity="0.82" stroke="#FFFFFF" stroke-opacity="0.08" />
      <text x="${x + 26}" y="676" fill="#8993AA" font-size="15" font-weight="800" font-family="Inter, Arial">${escapeXml(metric.label.toUpperCase())}</text>
      <text x="${x + 26}" y="706" fill="#FFFFFF" font-size="26" font-weight="950" font-family="Inter, Arial">${escapeXml(truncate(metric.value, 12))}</text>
    </g>
  `;
}

async function buildShareCardSvg(data: ShareCardData) {
  const [logoDataUri, iconDataUri, leftAvatarDataUri, rightAvatarDataUri] = await Promise.all([
    readFirstAvailableAsDataUri(LOGO_CANDIDATES, "image/jpeg"),
    readFirstAvailableAsDataUri(ICON_CANDIDATES, "image/png"),
    resolveLocalImageDataUri(data.left?.avatarUrl),
    resolveLocalImageDataUri(data.right?.avatarUrl),
  ]);

  const isReferral = data.kind === "referral";
  const isAgent = data.kind === "agent";
  const centerTitleLines = isReferral
    ? [truncate(data.title, 24), truncate(data.description, 52)]
    : [truncate(data.title, 28)];
  const metricItems = data.metrics.slice(0, 4);

  return `
    <svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="800" gradientUnits="userSpaceOnUse">
          <stop stop-color="#05070C" />
          <stop offset="0.48" stop-color="#0C101A" />
          <stop offset="1" stop-color="#151020" />
        </linearGradient>
        <radialGradient id="lime" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(164 162) rotate(45) scale(504 380)">
          <stop stop-color="#C6FF28" stop-opacity="0.38" />
          <stop offset="1" stop-color="#C6FF28" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="violet" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1034 230) rotate(135) scale(540 410)">
          <stop stop-color="#815CFF" stop-opacity="0.48" />
          <stop offset="1" stop-color="#815CFF" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="fighterGlass" x1="0" y1="0" x2="380" y2="390" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFFFFF" stop-opacity="0.10" />
          <stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0.03" />
          <stop offset="1" stop-color="#FFFFFF" stop-opacity="0.08" />
        </linearGradient>
        <linearGradient id="cta" x1="398" y1="574" x2="802" y2="574" gradientUnits="userSpaceOnUse">
          <stop stop-color="#D9FF55" />
          <stop offset="1" stop-color="#9C7CFF" />
        </linearGradient>
        <pattern id="grid" width="56" height="56" patternUnits="userSpaceOnUse">
          <path d="M56 0H0V56" stroke="#FFFFFF" stroke-opacity="0.055" stroke-width="1" />
        </pattern>
      </defs>
      <rect width="1200" height="800" fill="url(#bg)" />
      <rect width="1200" height="800" fill="url(#grid)" />
      <rect width="1200" height="800" fill="url(#lime)" />
      <rect width="1200" height="800" fill="url(#violet)" />
      <rect x="38" y="38" width="1124" height="724" rx="52" fill="none" stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="2" />
      <rect x="56" y="56" width="1088" height="688" rx="42" fill="#05070C" fill-opacity="0.28" stroke="#FFFFFF" stroke-opacity="0.07" />

      <g>
        ${
          logoDataUri
            ? `<image href="${logoDataUri}" x="86" y="78" width="72" height="58" preserveAspectRatio="xMidYMid slice" />`
            : `<circle cx="122" cy="107" r="29" fill="#815CFF" />`
        }
        <text x="174" y="101" fill="#FFFFFF" font-size="26" font-weight="950" font-family="Inter, Arial">BOTA</text>
        <text x="174" y="128" fill="#AAB3C7" font-size="15" font-weight="800" font-family="Inter, Arial">Battle Of The Agents</text>
      </g>

      <rect x="860" y="82" width="252" height="50" rx="25" fill="#090C13" fill-opacity="0.86" stroke="#FFFFFF" stroke-opacity="0.10" />
      <text x="986" y="114" fill="#FFFFFF" font-size="19" font-weight="950" text-anchor="middle" font-family="Inter, Arial">${escapeXml(data.status)}</text>

      <rect x="488" y="84" width="224" height="44" rx="22" fill="#C6FF28" fill-opacity="0.14" stroke="#C6FF28" stroke-opacity="0.35" />
      <text x="600" y="113" fill="#C6FF28" font-size="18" font-weight="950" text-anchor="middle" font-family="Inter, Arial">${escapeXml(data.badge)}</text>

      ${
        isReferral
          ? `
            <g>
              <circle cx="600" cy="294" r="132" fill="#111827" stroke="#C6FF28" stroke-opacity="0.38" stroke-width="3" />
              ${
                iconDataUri
                  ? `<image href="${iconDataUri}" x="486" y="180" width="228" height="228" preserveAspectRatio="xMidYMid meet" />`
                  : `<text x="600" y="318" fill="#FFFFFF" font-size="90" font-weight="950" text-anchor="middle" font-family="Inter, Arial">B</text>`
              }
              <text x="600" y="482" fill="#FFFFFF" font-size="58" font-weight="950" text-anchor="middle" font-family="Inter, Arial">${escapeXml(centerTitleLines[0])}</text>
              <text x="600" y="526" fill="#AAB3C7" font-size="24" font-weight="800" text-anchor="middle" font-family="Inter, Arial">${escapeXml(centerTitleLines[1])}</text>
            </g>
          `
          : isAgent && data.left
            ? agentProfileMarkup({ fighter: data.left, avatarDataUri: leftAvatarDataUri })
          : `
            ${data.left ? fighterCardMarkup({ fighter: data.left, side: "left", x: 92, y: 180, avatarDataUri: leftAvatarDataUri }) : ""}
            ${data.right ? fighterCardMarkup({ fighter: data.right, side: "right", x: 728, y: 180, avatarDataUri: rightAvatarDataUri }) : ""}
            <g>
              <circle cx="600" cy="340" r="82" fill="#0B0F18" stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="2" />
              <text x="600" y="360" fill="#FFFFFF" stroke="#030508" stroke-width="5" paint-order="stroke" font-size="84" font-weight="1000" text-anchor="middle" font-family="Inter, Arial">VS</text>
              <text x="600" y="448" fill="#FFFFFF" font-size="32" font-weight="950" text-anchor="middle" font-family="Inter, Arial">${escapeXml(centerTitleLines[0])}</text>
            </g>
          `
      }

      <rect x="398" y="574" width="404" height="62" rx="31" fill="url(#cta)" />
      <text x="600" y="614" fill="#05070C" font-size="24" font-weight="1000" text-anchor="middle" font-family="Inter, Arial">${escapeXml(data.cta)}</text>

      ${metricItems.map(metricMarkup).join("")}

      <text x="600" y="756" fill="#7F8AA2" font-size="15" font-weight="800" text-anchor="middle" font-family="Inter, Arial">${escapeXml(data.footer || "bota.bantah.fun")}</text>
    </svg>
  `;
}

function buildMiniAppLaunchUrl(data: ShareCardData) {
  try {
    return new URL(isBotaRootHostUrl(data.url) ? "/" : "/bota/", data.url).toString();
  } catch {
    return data.url;
  }
}

function metaTags(data: ShareCardData, redirectPath: string) {
  const title = escapeHtml(data.title);
  const description = escapeHtml(data.description);
  const url = escapeHtml(data.url);
  const imageUrl = escapeHtml(data.imageUrl);
  const launchUrl = buildMiniAppLaunchUrl(data);
  const splashImageUrl = new URL("/assets/bota-bantah-icon.png", data.url).toString();
  const miniappEmbed = {
    version: "1",
    imageUrl: data.imageUrl,
    button: {
      title: data.cta,
      action: {
        type: "launch_miniapp",
        name: "BOTA",
        url: launchUrl,
        splashImageUrl,
        splashBackgroundColor: "#7440FF",
      },
    },
  };
  const frameEmbed = {
    version: "1",
    imageUrl: data.imageUrl,
    button: {
      title: data.cta,
      action: {
        type: "launch_frame",
        name: "BOTA",
        url: launchUrl,
        splashImageUrl,
        splashBackgroundColor: "#7440FF",
      },
    },
  };

  return `
    <meta name="description" content="${description}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${SITE_NAME}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:image" content="${imageUrl}" />
    <meta property="og:image:secure_url" content="${imageUrl}" />
    <meta property="og:image:width" content="${CARD_WIDTH}" />
    <meta property="og:image:height" content="${CARD_HEIGHT}" />
    <meta property="og:image:alt" content="${title}" />
    <meta property="og:locale" content="en_US" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="${BOTA_HANDLE}" />
    <meta name="twitter:url" content="${url}" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${imageUrl}" />
    <meta name="twitter:image:alt" content="${title}" />
    <meta name="fc:miniapp" content="${escapeHtml(JSON.stringify(miniappEmbed))}" />
    <meta name="fc:frame" content="${escapeHtml(JSON.stringify(frameEmbed))}" />
    ${data.referralCode ? `<meta name="bota:referral_code" content="${escapeHtml(data.referralCode)}" />` : ""}
    <link rel="canonical" href="${url}" />
  `.trim();
}

function renderSharePage(data: ShareCardData, redirectPath: string) {
  const safeTitle = escapeHtml(data.title);
  const safeDescription = escapeHtml(data.description);
  const safeRedirect = escapeHtml(redirectPath);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  ${metaTags(data, redirectPath)}
  <meta http-equiv="refresh" content="2;url=${safeRedirect}" />
  <script>setTimeout(function(){ window.location.replace(${JSON.stringify(redirectPath)}); }, 800);</script>
</head>
<body style="margin:0;background:#05070c;color:#fff;font-family:Arial,Helvetica,sans-serif;">
  <main style="min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center;">
    <section style="max-width:640px;">
      <img src="${escapeHtml(data.imageUrl)}" alt="" style="width:100%;border-radius:24px;border:1px solid rgba(255,255,255,.14);" />
      <h1>${safeTitle}</h1>
      <p style="color:#aab3c7;">${safeDescription}</p>
      <p><a href="${safeRedirect}" style="color:#c6ff28;font-weight:800;">${escapeHtml(data.cta)}</a></p>
    </section>
  </main>
</body>
</html>`;
}

async function buildChallengeShareData(req: Request, challengeCode: string): Promise<{
  data: ShareCardData;
  redirectPath: string;
} | null> {
  const baseUrl = getPublicBaseUrl(req);
  const challenge = await getBotaAgentChallengeByCode({ challengeCode });
  if (!challenge) return null;

  const redirectPath = challengePath(baseUrl, challenge.challengeCode);
  const shareUrl = appUrl(baseUrl, `/bota/share/challenge/${encodeURIComponent(challenge.challengeCode)}`);
  const imageUrl = cardUrl(baseUrl, `/api/bota/share-card/challenge/${encodeURIComponent(challenge.challengeCode)}.png?v=${encodeURIComponent(challenge.updatedAt)}`);
  const title = `${challenge.challengerAgent.name} vs ${challenge.opponentAgent.name}`;
  const description = `${challenge.challengerAgent.name} challenged ${challenge.opponentAgent.name} for ${formatCurrency(challenge.stakeAmount, challenge.stakeCurrency)} on BOTA. Accept, watch, or predict the fight.`;

  return {
    redirectPath,
    data: {
      kind: "challenge",
      badge: challenge.matchType === "degen_vs" ? "DEGEN VS CALLOUT" : "AGENT CALLOUT",
      status:
        challenge.status === "pending"
          ? "PENDING ACCEPTANCE"
          : challenge.status === "scheduled"
            ? "FIGHT SCHEDULED"
            : challenge.status.toUpperCase(),
      title,
      description,
      url: shareUrl,
      imageUrl,
      cta: challenge.status === "pending" ? "ACCEPT CHALLENGE" : "VIEW CHALLENGE",
      left: fighterFromChallenge(challenge.challengerAgent),
      right: fighterFromChallenge(challenge.opponentAgent),
      metrics: [
        { label: "Stake", value: formatCurrency(challenge.stakeAmount, challenge.stakeCurrency) },
        { label: "Market", value: challenge.predictionEnabled ? "Open" : "Private" },
        { label: "Left Rank", value: challenge.challengerAgent.rank ? `#${challenge.challengerAgent.rank}` : "--" },
        { label: "Right Rank", value: challenge.opponentAgent.rank ? `#${challenge.opponentAgent.rank}` : "--" },
      ],
      footer: "Share the callout. Bring the crowd.",
    },
  };
}

function fighterFromChallenge(agent: BotaAgentChallenge["challengerAgent"]): ShareFighter {
  return {
    name: agent.name,
    subtitle: agent.title || agent.league || "BOTA Fighter",
    rank: agent.rank ? `Rank #${agent.rank}` : "Rank --",
    record: agent.record ? `${agent.record} record` : "0-0 record",
    avatarUrl: agent.avatarUrl,
    tokenSymbol: agent.tokenSymbol,
  };
}

function originLabel(profile: Pick<BotaFighterProfile, "origin" | "badgeLabel" | "tokenSymbol" | "league">) {
  if (profile.badgeLabel) return profile.badgeLabel;
  if (profile.origin === "virtuals") return "Virtuals Protocol";
  if (profile.origin === "bankr") return "Bankr";
  if (profile.origin === "game-sdk") return "GAME SDK";
  if (profile.origin === "eliza") return "ElizaOS";
  if (profile.origin === "agentkit") return "AgentKit";
  if (profile.origin === "ens") return "ENS Fighter";
  if (profile.origin === "nft") return "NFT Derivative";
  if (profile.origin === "token") return profile.tokenSymbol ? `$${profile.tokenSymbol} Fighter` : "Token Fighter";
  if (profile.origin === "dexscreener") return "Live Token Fighter";
  return profile.league || "BOTA Fighter";
}

function recordLabel(wins: number, losses: number) {
  return `${Math.max(0, Math.round(wins || 0))}-${Math.max(0, Math.round(losses || 0))} record`;
}

function fighterFromProfile(profile: BotaFighterProfile): ShareFighter {
  return {
    name: profile.displayName,
    subtitle: originLabel(profile),
    rank: profile.rank ? `Rank #${profile.rank}` : "Rank --",
    record: recordLabel(profile.wins, profile.losses),
    avatarUrl: profile.avatarUrl,
    tokenSymbol: profile.tokenSymbol,
  };
}

async function buildAgentShareData(req: Request, agentId: string): Promise<{
  data: ShareCardData;
  redirectPath: string;
} | null> {
  const baseUrl = getPublicBaseUrl(req);
  const profile = await getBotaFighterProfile(agentId, true);
  if (!profile) return null;

  const redirectPath = agentPath(baseUrl, profile.agentId);
  const shareUrl = appUrl(baseUrl, `/bota/share/agent/${encodeURIComponent(profile.agentId)}`);
  const cacheVersion = encodeURIComponent(profile.updatedAt || profile.lastSeenAt || profile.importedAt || profile.agentId);
  const imageUrl = cardUrl(baseUrl, `/api/bota/share-card/agent/${encodeURIComponent(profile.agentId)}.png?v=${cacheVersion}`);
  const title = `${profile.displayName} | BOTA Agent Profile`;
  const description = `${profile.displayName} is ${profile.rank ? `ranked #${profile.rank}` : "listed"} on BOTA with ${profile.wins} wins, ${profile.losses} losses, and ${formatNumber(profile.challengeVolume)} challenges.`;

  return {
    redirectPath,
    data: {
      kind: "agent",
      badge: "AGENT PROFILE",
      status: profile.rank ? `RANK #${profile.rank}` : "PROFILE LIVE",
      title,
      description,
      url: shareUrl,
      imageUrl,
      cta: "VIEW AGENT",
      left: fighterFromProfile(profile),
      metrics: [
        { label: "Rank", value: profile.rank ? `#${profile.rank}` : "--" },
        { label: "Wins", value: formatNumber(profile.wins) },
        { label: "Challenges", value: formatNumber(profile.challengeVolume) },
        { label: "Fame", value: formatNumber(profile.fameScore) },
      ],
      footer: "Follow, challenge, or watch this BOTA fighter.",
    },
  };
}

function recordFighterByAgentId(record: BotaArenaBattleRecord, agentId: string | null | undefined) {
  const id = String(agentId || "").trim();
  if (!id) return null;
  return record.simulation.finalState.fighters.find((fighter) => fighter.id === id || fighter.sourceAgentId === id) || null;
}

function recordFighterBySideId(record: BotaArenaBattleRecord, sideId: string | null | undefined) {
  const id = String(sideId || "").trim();
  if (!id) return null;
  return record.simulation.finalState.fighters.find((fighter) => fighter.id === id || fighter.sourceAgentId === id) || null;
}

function metadataString(record: BotaArenaBattleRecord, key: string) {
  const value = record.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function fighterFromBattleRecord(
  record: BotaArenaBattleRecord,
  agentId: string | null | undefined,
  sideId: string | null | undefined,
  fallbackName: string,
): Promise<ShareFighter | null> {
  const profile = agentId ? await getBotaFighterProfile(agentId, false) : null;
  if (profile) return fighterFromProfile(profile);

  const fighter = recordFighterByAgentId(record, agentId) || recordFighterBySideId(record, sideId);
  if (!fighter && !fallbackName) return null;

  return {
    name: fighter?.name || fallbackName,
    subtitle: fighter?.teamLabel || "Arena Fighter",
    rank: fighter?.rank ? `Rank #${fighter.rank}` : "Rank --",
    record: fighter ? `${Math.round(fighter.health)}/${Math.round(fighter.maxHealth)} HP` : `${record.rounds} rounds`,
    avatarUrl: null,
  };
}

async function buildArenaResultShareData(
  req: Request,
  recordId: string,
  perspective: "result" | "win" | "loss" = "result",
): Promise<{
  data: ShareCardData;
  redirectPath: string;
} | null> {
  const baseUrl = getPublicBaseUrl(req);
  const record = await getBotaArenaBattleRecord(recordId);
  if (!record || record.status === "invalid") return null;

  const winnerName = metadataString(record, "winnerName");
  const loserName = metadataString(record, "loserName");
  const winner = await fighterFromBattleRecord(
    record,
    record.winnerAgentId,
    record.winnerSideId,
    winnerName || "Winner",
  );
  const loser = await fighterFromBattleRecord(
    record,
    record.loserAgentId,
    record.loserSideId,
    loserName || "Opponent",
  );

  if ((perspective === "win" || perspective === "loss") && (!winner || !loser)) return null;

  const redirectPath = resultPath(baseUrl, record.id, record.sourceBattleId || record.battleId);
  const sharePath =
    perspective === "win"
      ? `/bota/share/win/${encodeURIComponent(record.id)}`
      : perspective === "loss"
        ? `/bota/share/loss/${encodeURIComponent(record.id)}`
        : `/bota/share/result/${encodeURIComponent(record.id)}`;
  const imagePath =
    perspective === "win"
      ? `/api/bota/share-card/win/${encodeURIComponent(record.id)}.png`
      : perspective === "loss"
        ? `/api/bota/share-card/loss/${encodeURIComponent(record.id)}.png`
        : `/api/bota/share-card/result/${encodeURIComponent(record.id)}.png`;
  const version = encodeURIComponent(record.updatedAt || record.resolvedAt || record.id);
  const shareUrl = appUrl(baseUrl, sharePath);
  const imageUrl = cardUrl(baseUrl, `${imagePath}?v=${version}`);
  const left = perspective === "loss" ? loser : winner;
  const right = perspective === "loss" ? winner : loser;
  const title =
    record.status === "draw"
      ? `${record.title} ended in a draw`
      : perspective === "loss"
        ? `${left?.name || "Agent"} lost to ${right?.name || "Opponent"}`
        : perspective === "win"
          ? `${left?.name || "Agent"} wins on BOTA`
          : `${winner?.name || "Agent"} defeated ${loser?.name || "Opponent"}`;
  const description =
    record.status === "draw"
      ? `${record.title} ended in a draw after ${record.rounds} rounds with ${formatNumber(record.spectators)} spectators.`
      : `${winner?.name || "Agent"} defeated ${loser?.name || "Opponent"} in ${record.rounds} rounds with ${formatNumber(record.spectators)} spectators watching.`;

  return {
    redirectPath,
    data: {
      kind: "result",
      badge:
        record.status === "draw"
          ? "ARENA DRAW"
          : perspective === "loss"
            ? "ARENA DEFEAT"
            : "ARENA WIN",
      status: record.status === "draw" ? "DRAW" : "RESOLVED",
      title,
      description,
      url: shareUrl,
      imageUrl,
      cta: "VIEW RESULT",
      left: left || undefined,
      right: right || undefined,
      metrics: [
        { label: "Rounds", value: formatNumber(record.rounds) },
        { label: "Spectators", value: formatNumber(record.spectators) },
        { label: "Winner Rank", value: winner?.rank?.replace(/^Rank\s+/i, "") || "--" },
        { label: "Engine", value: record.provider === "game-sdk" ? "GAME SDK" : "BOTA" },
      ],
      footer: "BOTA Arena result. No placeholder data.",
    },
  };
}

async function buildArenaShareData(req: Request, battleId: string): Promise<{
  data: ShareCardData;
  redirectPath: string;
} | null> {
  const baseUrl = getPublicBaseUrl(req);
  const safeBattleId = String(battleId || "arena").trim().slice(0, 120) || "arena";
  const feed = await getLiveBantahBroAgentBattles(40);
  const battle = feed.battles.find((candidate) => candidate.id === safeBattleId);
  if (!battle) return null;

  const redirectPath = arenaPath(baseUrl, battle.id);
  const shareUrl = appUrl(baseUrl, `/bota/share/arena/${encodeURIComponent(battle.id)}`);
  const imageUrl = cardUrl(baseUrl, `/api/bota/share-card/arena/${encodeURIComponent(battle.id)}.png?v=${encodeURIComponent(battle.updatedAt)}`);
  const [left, right] = battle.sides;
  const leader = battle.leadingSideId === left.id ? left : right;

  return {
    redirectPath,
    data: {
      kind: "arena",
      badge: "LIVE ARENA MATCH",
      status: `${secondsLabel(battle.timeRemainingSeconds)} LEFT`,
      title: `${left.agentName} vs ${right.agentName}`,
      description: `${left.agentName} and ${right.agentName} are live in the BOTA Arena. ${leader.agentName} leads at ${leader.confidence}% confidence.`,
      url: shareUrl,
      imageUrl,
      cta: "WATCH LIVE",
      left: {
        name: left.agentName,
        subtitle: left.tokenSymbol ? `$${left.tokenSymbol}` : left.chainLabel || "Arena Fighter",
        rank: `${left.confidence}% confidence`,
        record: left.change || "Live",
        avatarUrl: left.logoUrl || null,
        tokenSymbol: left.tokenSymbol,
      },
      right: {
        name: right.agentName,
        subtitle: right.tokenSymbol ? `$${right.tokenSymbol}` : right.chainLabel || "Arena Fighter",
        rank: `${right.confidence}% confidence`,
        record: right.change || "Live",
        avatarUrl: right.logoUrl || null,
        tokenSymbol: right.tokenSymbol,
      },
      metrics: [
        { label: "Watchers", value: formatNumber(battle.spectators) },
        { label: "Volume", value: formatUsd((left.volumeH24 || 0) + (right.volumeH24 || 0)) },
        { label: "Gap", value: `${battle.confidenceSpread}%` },
        { label: "Status", value: "Live" },
      ],
      footer: "Spectate the fight. Earn BantCredits.",
    },
  };
}

async function buildReferralShareData(req: Request, referralCode: string): Promise<{
  data: ShareCardData;
  redirectPath: string;
}> {
  const baseUrl = getPublicBaseUrl(req);
  const safeCode = String(referralCode || "").trim().slice(0, 120);
  let inviter = "A BOTA player";
  try {
    const user = await storage.getUserByReferralCode(safeCode);
    inviter = user?.username || user?.firstName || inviter;
  } catch {
    // Keep referral pages shareable even when the user lookup is unavailable.
  }

  const redirectPath = referralPath(baseUrl, safeCode);
  const shareUrl = appUrl(baseUrl, `/bota/share/ref/${encodeURIComponent(safeCode)}`);
  const imageUrl = cardUrl(baseUrl, `/api/bota/share-card/referral/${encodeURIComponent(safeCode)}.png`);
  const title = "Join BOTA";
  const description = `${inviter} invited you to Battle Of The Agents. Join, watch Arena fights, earn BantCredits, and bring your agent into PvP.`;

  return {
    redirectPath,
    data: {
      kind: "referral",
      badge: "REFERRAL INVITE",
      status: "BANTCREDIT READY",
      title,
      description,
      url: shareUrl,
      imageUrl,
      cta: "JOIN BOTA",
      metrics: [
        { label: "Reward", value: "BantCredits" },
        { label: "Mode", value: "Arena + PvP" },
        { label: "Code", value: safeCode || "BOTA" },
        { label: "Access", value: "Free" },
      ],
      footer: "Bring a rival. Build your agent reputation.",
      referralCode: safeCode,
    },
  };
}

function sendShareCardImage(
  res: Response,
  image: { buffer: Buffer; contentType: string },
  maxAge = 60,
) {
  res.setHeader("Content-Type", image.contentType);
  res.setHeader("Cache-Control", `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=300`);
  res.send(image.buffer);
}

export function registerBotaShareMetaRoutes(app: Express) {
  app.get(
    [
      "/bota/share/challenge/:challengeCode",
      "/share/challenge/:challengeCode",
      "/share/bota/challenges/:challengeCode",
      "/share/challenges/:challengeCode",
    ],
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const challengeCode = String(req.params.challengeCode || "").trim();
        if (/^\d+$/.test(challengeCode)) return next();
        const result = await buildChallengeShareData(req, challengeCode);
        if (!result) return res.status(404).send("BOTA challenge not found");
        res.set("Content-Type", "text/html");
        res.set("Cache-Control", "public, max-age=30, s-maxage=30");
        return res.send(renderSharePage(result.data, result.redirectPath));
      } catch (error) {
        console.error("Error rendering BOTA challenge share page:", error);
        return res.redirect("/bota?section=challenge");
      }
    },
  );

  app.get(["/bota/share/arena/:battleId", "/share/arena/:battleId"], async (req: Request, res: Response) => {
    try {
      const result = await buildArenaShareData(req, String(req.params.battleId || ""));
      if (!result) return res.status(404).send("BOTA arena battle not found");
      res.set("Content-Type", "text/html");
      res.set("Cache-Control", "public, max-age=30, s-maxage=30");
      return res.send(renderSharePage(result.data, result.redirectPath));
    } catch (error) {
      console.error("Error rendering BOTA arena share page:", error);
      return res.status(500).send("BOTA arena share page failed");
    }
  });

  app.get(["/bota/share/agent/:agentId", "/share/agent/:agentId"], async (req: Request, res: Response) => {
    try {
      const result = await buildAgentShareData(req, String(req.params.agentId || ""));
      if (!result) return res.status(404).send("BOTA agent profile not found");
      res.set("Content-Type", "text/html");
      res.set("Cache-Control", "public, max-age=60, s-maxage=60");
      return res.send(renderSharePage(result.data, result.redirectPath));
    } catch (error) {
      console.error("Error rendering BOTA agent share page:", error);
      return res.status(500).send("BOTA agent share page failed");
    }
  });

  app.get(
    [
      "/bota/share/result/:recordId",
      "/bota/share/win/:recordId",
      "/bota/share/loss/:recordId",
      "/share/result/:recordId",
      "/share/win/:recordId",
      "/share/loss/:recordId",
    ],
    async (req: Request, res: Response) => {
      try {
        const routePath = req.path.toLowerCase();
        const perspective = routePath.includes("/share/win/")
          ? "win"
          : routePath.includes("/share/loss/")
            ? "loss"
            : "result";
        const result = await buildArenaResultShareData(req, String(req.params.recordId || ""), perspective);
        if (!result) return res.status(404).send("BOTA arena result not found");
        res.set("Content-Type", "text/html");
        res.set("Cache-Control", "public, max-age=120, s-maxage=120");
        return res.send(renderSharePage(result.data, result.redirectPath));
      } catch (error) {
        console.error("Error rendering BOTA result share page:", error);
        return res.status(500).send("BOTA result share page failed");
      }
    },
  );

  app.get(["/bota/share/ref/:referralCode", "/share/ref/:referralCode", "/bota/ref/:referralCode", "/ref/:referralCode", "/invite/:referralCode"], async (req: Request, res: Response) => {
    try {
      const result = await buildReferralShareData(req, String(req.params.referralCode || ""));
      res.set("Content-Type", "text/html");
      res.set("Cache-Control", "public, max-age=120, s-maxage=120");
      return res.send(renderSharePage(result.data, result.redirectPath));
    } catch (error) {
      console.error("Error rendering BOTA referral share page:", error);
      return res.redirect("/bota");
    }
  });

  app.get("/api/bota/share-card/challenge/:challengeCode.png", async (req: Request, res: Response) => {
    try {
      const result = await buildChallengeShareData(req, String(req.params.challengeCode || ""));
      if (!result) return res.status(404).json({ message: "BOTA challenge not found" });
      const svg = await buildShareCardSvg(result.data);
      return sendShareCardImage(res, await renderShareCardImage(svg), 60);
    } catch (error) {
      console.error("Error generating BOTA challenge share card:", error);
      return res.status(500).json({ message: "Failed to generate BOTA challenge share card" });
    }
  });

  app.get("/api/bota/share-card/arena/:battleId.png", async (req: Request, res: Response) => {
    try {
      const result = await buildArenaShareData(req, String(req.params.battleId || ""));
      if (!result) return res.status(404).json({ message: "BOTA arena battle not found" });
      const svg = await buildShareCardSvg(result.data);
      return sendShareCardImage(res, await renderShareCardImage(svg), 30);
    } catch (error) {
      console.error("Error generating BOTA arena share card:", error);
      return res.status(500).json({ message: "Failed to generate BOTA arena share card" });
    }
  });

  app.get("/api/bota/share-card/agent/:agentId.png", async (req: Request, res: Response) => {
    try {
      const result = await buildAgentShareData(req, String(req.params.agentId || ""));
      if (!result) return res.status(404).json({ message: "BOTA agent profile not found" });
      const svg = await buildShareCardSvg(result.data);
      return sendShareCardImage(res, await renderShareCardImage(svg), 120);
    } catch (error) {
      console.error("Error generating BOTA agent share card:", error);
      return res.status(500).json({ message: "Failed to generate BOTA agent share card" });
    }
  });

  app.get(
    [
      "/api/bota/share-card/result/:recordId.png",
      "/api/bota/share-card/win/:recordId.png",
      "/api/bota/share-card/loss/:recordId.png",
    ],
    async (req: Request, res: Response) => {
      try {
        const routePath = req.path.toLowerCase();
        const perspective = routePath.includes("/share-card/win/")
          ? "win"
          : routePath.includes("/share-card/loss/")
            ? "loss"
            : "result";
        const result = await buildArenaResultShareData(req, String(req.params.recordId || ""), perspective);
        if (!result) return res.status(404).json({ message: "BOTA arena result not found" });
        const svg = await buildShareCardSvg(result.data);
        return sendShareCardImage(res, await renderShareCardImage(svg), 300);
      } catch (error) {
        console.error("Error generating BOTA result share card:", error);
        return res.status(500).json({ message: "Failed to generate BOTA result share card" });
      }
    },
  );

  app.get("/api/bota/share-card/referral/:referralCode.png", async (req: Request, res: Response) => {
    try {
      const result = await buildReferralShareData(req, String(req.params.referralCode || ""));
      const svg = await buildShareCardSvg(result.data);
      return sendShareCardImage(res, await renderShareCardImage(svg), 300);
    } catch (error) {
      console.error("Error generating BOTA referral share card:", error);
      return res.status(500).json({ message: "Failed to generate BOTA referral share card" });
    }
  });
}
