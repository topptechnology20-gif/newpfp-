import { Request, Response } from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { CHALLENGE_PLATFORM_FEE_RATE } from "@shared/feeConfig";
import type { IStorage } from "./storage";
import { getBotaAgentChallengeByCode } from "./bantahBro/botaAgentChallengeService";

const CHAIN_LABELS: Record<number, string> = {
  8453: "Base",
  56: "BSC",
  42161: "Arbitrum",
  130: "Unichain",
  1: "Ethereum",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BANTAH_BLUE_LOGO_CANDIDATE_PATHS = [
  path.resolve(process.cwd(), "dist/public/assets/bantahblue.svg"),
  path.resolve(__dirname, "public/assets/bantahblue.svg"),
  path.resolve(process.cwd(), "client/public/assets/bantahblue.svg"),
  path.resolve(__dirname, "../client/public/assets/bantahblue.svg"),
  path.resolve(__dirname, "../../client/public/assets/bantahblue.svg"),
  path.resolve(process.cwd(), "public/assets/bantahblue.svg"),
];
const OG_FONT_BUNDLED_CANDIDATE_PATHS = [
  path.resolve(process.cwd(), "server/assets/NotoSans-Regular.ttf"),
  path.resolve(__dirname, "assets/NotoSans-Regular.ttf"),
  path.resolve(__dirname, "../server/assets/NotoSans-Regular.ttf"),
];
const OG_FONT_PRIMARY_CANDIDATE_PATHS = [
  path.resolve(process.cwd(), "dist/public/fonts/sf-pro-rounded/SF-Pro-Rounded.ttf"),
  path.resolve(__dirname, "public/fonts/sf-pro-rounded/SF-Pro-Rounded.ttf"),
  path.resolve(process.cwd(), "client/public/fonts/sf-pro-rounded/SF-Pro-Rounded.ttf"),
  path.resolve(__dirname, "../client/public/fonts/sf-pro-rounded/SF-Pro-Rounded.ttf"),
  path.resolve(__dirname, "../../client/public/fonts/sf-pro-rounded/SF-Pro-Rounded.ttf"),
  path.resolve(process.cwd(), "public/fonts/sf-pro-rounded/SF-Pro-Rounded.ttf"),
];
const OG_FONT_FALLBACK_CANDIDATE_PATHS = [
  path.resolve(process.cwd(), "dist/public/fonts/PoppinsRounded-Rounded.ttf"),
  path.resolve(__dirname, "public/fonts/PoppinsRounded-Rounded.ttf"),
  path.resolve(process.cwd(), "client/public/fonts/PoppinsRounded-Rounded.ttf"),
  path.resolve(__dirname, "../client/public/fonts/PoppinsRounded-Rounded.ttf"),
  path.resolve(__dirname, "../../client/public/fonts/PoppinsRounded-Rounded.ttf"),
  path.resolve(process.cwd(), "public/fonts/PoppinsRounded-Rounded.ttf"),
];
const OG_FONT_STACK = "BantahOG, Noto Sans, Arial, Helvetica, sans-serif";

let ogFontDataUriCache: string | null | undefined;
let resvgFontFilesCache: string[] | null = null;

type ChallengeSlot = {
  key: string;
  side: "YES" | "NO";
  displayName: string;
  avatarUrl: string | null;
  isOpen: boolean;
};

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeSide(value: unknown): "YES" | "NO" | null {
  const side = String(value || "").trim().toUpperCase();
  return side === "YES" || side === "NO" ? side : null;
}

function formatTokenAmount(amount: unknown, tokenSymbol?: string | null): string {
  const numericAmount = Number(amount || 0);
  const safeAmount = Number.isFinite(numericAmount) ? numericAmount : 0;
  const symbol = String(tokenSymbol || "").trim().toUpperCase() || "ETH";
  const formattedAmount = safeAmount.toLocaleString(undefined, {
    minimumFractionDigits: safeAmount >= 100 ? 0 : safeAmount >= 1 ? 0 : 2,
    maximumFractionDigits: 4,
  });
  return `${formattedAmount} ${symbol}`;
}

function formatPayout(amount: unknown, tokenSymbol?: string | null): string {
  const numericAmount = Number(amount || 0);
  const safeAmount = Number.isFinite(numericAmount) ? numericAmount : 0;
  const payout = Math.max(0, safeAmount * (2 - CHALLENGE_PLATFORM_FEE_RATE));
  return formatTokenAmount(payout, tokenSymbol);
}

function formatDateLabel(value: unknown): string {
  if (!value) return "No deadline";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "No deadline";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function resolveChainLabel(chainId: unknown): string {
  const numericChainId = Number(chainId);
  if (!Number.isFinite(numericChainId) || numericChainId <= 0) {
    return "Onchain";
  }
  return CHAIN_LABELS[numericChainId] || `Chain ${numericChainId}`;
}

function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars || current.length === 0) {
      current = next;
      continue;
    }

    lines.push(current);
    current = word;

    if (lines.length === maxLines - 1) break;
  }

  if (lines.length < maxLines) {
    lines.push(current);
  }

  if (words.join(" ").length > lines.join(" ").length) {
    const lastIndex = Math.min(lines.length, maxLines) - 1;
    lines[lastIndex] = `${lines[lastIndex].replace(/\.\.\.$/, "").slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  return lines.slice(0, maxLines);
}

function guessMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

async function toDataUri(buffer: Buffer, mimeType: string): Promise<string> {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function loadFileAsDataUri(filePath: string, mimeType = guessMimeType(filePath)): Promise<string | null> {
  try {
    const buffer = await fs.readFile(filePath);
    return toDataUri(buffer, mimeType);
  } catch {
    return null;
  }
}

async function loadFirstAvailableFileAsDataUri(
  filePaths: string[],
  mimeType: string,
): Promise<string | null> {
  for (const filePath of filePaths) {
    const value = await loadFileAsDataUri(filePath, mimeType);
    if (value) return value;
  }
  return null;
}

async function listExistingPaths(filePaths: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const filePath of filePaths) {
    try {
      await fs.access(filePath);
      existing.push(filePath);
    } catch {
      // ignore
    }
  }
  return existing;
}

async function getResvgFontFiles(): Promise<string[]> {
  if (resvgFontFilesCache) {
    return resvgFontFilesCache;
  }

  const candidates = [
    ...OG_FONT_BUNDLED_CANDIDATE_PATHS,
    ...OG_FONT_PRIMARY_CANDIDATE_PATHS,
    ...OG_FONT_FALLBACK_CANDIDATE_PATHS,
  ];
  const existing = await listExistingPaths(candidates);
  resvgFontFilesCache = Array.from(new Set(existing));
  return resvgFontFilesCache;
}

async function renderSvgImage(svg: string): Promise<{ buffer: Buffer; contentType: string }> {
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const fontFiles = await getResvgFontFiles();
    const resvg = new Resvg(svg, {
      font: {
        fontFiles,
        loadSystemFonts: true,
      },
    });

    const pngData = resvg.render();
    return {
      buffer: Buffer.from(pngData.asPng()),
      contentType: "image/png",
    };
  } catch (error) {
    console.warn("Falling back to SVG OG image:", error);
    return {
      buffer: Buffer.from(svg),
      contentType: "image/svg+xml",
    };
  }
}

async function loadRemoteAssetAsDataUri(url: string, mimeTypeHint?: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const responseType = String(response.headers.get("content-type") || "").split(";")[0].trim();
    const mimeType = responseType || mimeTypeHint || "application/octet-stream";
    const arrayBuffer = await response.arrayBuffer();
    return toDataUri(Buffer.from(arrayBuffer), mimeType);
  } catch {
    return null;
  }
}

async function loadRemoteImageAsDataUri(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return null;
    const arrayBuffer = await response.arrayBuffer();
    return toDataUri(Buffer.from(arrayBuffer), contentType);
  } catch {
    return null;
  }
}

async function getOgFontDataUri(baseUrl?: string): Promise<string | null> {
  if (ogFontDataUriCache !== undefined) {
    return ogFontDataUriCache;
  }

  ogFontDataUriCache = (await loadFirstAvailableFileAsDataUri(OG_FONT_BUNDLED_CANDIDATE_PATHS, "font/ttf"))
    || (await loadFirstAvailableFileAsDataUri(OG_FONT_PRIMARY_CANDIDATE_PATHS, "font/ttf"))
    || (await loadFirstAvailableFileAsDataUri(OG_FONT_FALLBACK_CANDIDATE_PATHS, "font/ttf"))
    || null;

  if (!ogFontDataUriCache && baseUrl) {
    ogFontDataUriCache =
      (await loadRemoteAssetAsDataUri(`${baseUrl}/fonts/sf-pro-rounded/SF-Pro-Rounded.ttf`, "font/ttf"))
      || (await loadRemoteAssetAsDataUri(`${baseUrl}/fonts/PoppinsRounded-Rounded.ttf`, "font/ttf"))
      || null;
  }

  return ogFontDataUriCache;
}

async function resolveImageDataUri(source: unknown, baseUrl: string): Promise<string | null> {
  const raw = String(source || "").trim();
  if (!raw) return null;
  if (raw.startsWith("data:image/")) return raw;

  if (/^https?:\/\//i.test(raw)) {
    return loadRemoteImageAsDataUri(raw);
  }

  if (raw.startsWith("/attached_assets/")) {
    const absolutePath = path.resolve(process.cwd(), raw.slice(1));
    const localData = await loadFileAsDataUri(absolutePath);
    if (localData) return localData;
    return loadRemoteImageAsDataUri(`${baseUrl}${raw}`);
  }

  if (raw.startsWith("/assets/")) {
    const assetPath = path.resolve(process.cwd(), "client/public", raw.replace(/^\/assets\//, "assets/"));
    return loadFileAsDataUri(assetPath);
  }

  if (raw.startsWith("/")) {
    return loadRemoteImageAsDataUri(`${baseUrl}${raw}`);
  }

  return null;
}

function getParticipantName(
  user?: { username?: string | null; firstName?: string | null } | null,
  agent?: { agentName?: string | null } | null,
): string {
  return String(agent?.agentName || user?.username || user?.firstName || "").trim();
}

function getParticipantHandle(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "Open slot";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function getInitials(value: string): string {
  const clean = String(value || "").replace(/^@/, "").trim();
  if (!clean) return "B";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return clean.slice(0, 2).toUpperCase();
  }
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function truncate(value: string, maxChars: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function getStakeFontSize(value: string): number {
  if (value.length > 14) return 58;
  if (value.length > 11) return 66;
  return 82;
}

function getPillWidth(value: string, minWidth: number): number {
  return Math.max(minWidth, 18 * value.length + 42);
}

function buildOpenSlot(side: "YES" | "NO"): ChallengeSlot {
  return {
    key: `${side.toLowerCase()}-open`,
    side,
    displayName: "Open slot",
    avatarUrl: null,
    isOpen: true,
  };
}

function buildChallengeSlots(challenge: any, challengerAgent: any, challengedAgent: any): {
  yesSlot: ChallengeSlot;
  noSlot: ChallengeSlot;
  participantCount: number;
} {
  const slots: Record<"YES" | "NO", ChallengeSlot[]> = {
    YES: [],
    NO: [],
  };
  const seen = new Set<string>();

  const addSlot = (sideRaw: unknown, key: string, displayName: string, avatarUrl: string | null) => {
    const side = normalizeSide(sideRaw);
    const label = String(displayName || "").trim();
    if (!side || !label) return;
    const dedupeKey = `${side}:${key || label.toLowerCase()}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    slots[side].push({
      key: dedupeKey,
      side,
      displayName: label,
      avatarUrl,
      isOpen: false,
    });
  };

  if (!challenge.adminCreated) {
    addSlot(
      challenge.challengerSide,
      String(challenge.challenger || challenge.challengerAgentId || "challenger"),
      getParticipantName(challenge.challengerUser, challengerAgent),
      challenge.challengerUser?.profileImageUrl || null,
    );

    addSlot(
      challenge.challengedSide,
      String(challenge.challenged || challenge.challengedAgentId || "challenged"),
      getParticipantName(challenge.challengedUser, challengedAgent),
      challenge.challengedUser?.profileImageUrl || null,
    );
  }

  for (const participant of Array.isArray(challenge.participantPreviewUsers) ? challenge.participantPreviewUsers : []) {
    addSlot(
      participant?.side,
      String(participant?.id || participant?.username || participant?.firstName || ""),
      String(participant?.username || participant?.firstName || "").trim(),
      participant?.profileImageUrl || null,
    );
  }

  const yesSlot = slots.YES[0] || buildOpenSlot("YES");
  const noSlot = slots.NO[0] || buildOpenSlot("NO");

  const participantCount = Math.max(
    Number(challenge.participantCount || 0),
    Number(challenge.challenger ? 1 : 0) + Number(challenge.challenged ? 1 : 0),
    yesSlot.isOpen ? 0 : 1,
    noSlot.isOpen ? 0 : 1,
  );

  return {
    yesSlot,
    noSlot,
    participantCount,
  };
}

function buildAvatarFallbackMarkup(
  x: number,
  y: number,
  side: "YES" | "NO",
  label: string,
): string {
  const fill = side === "YES" ? "#1D6B5A" : "#5A2456";
  const stroke = side === "YES" ? "#BEFF07" : "#A487FF";
  return `
    <circle cx="${x}" cy="${y}" r="14" fill="${fill}" stroke="${stroke}" stroke-width="2" />
    <text x="${x}" y="${y + 5}" fill="#FFFFFF" font-family="${OG_FONT_STACK}" font-size="11" font-weight="800" text-anchor="middle">${escapeXml(getInitials(label))}</text>
  `;
}

function buildParticipantRowMarkup(
  slot: ChallengeSlot,
  avatarDataUri: string | null,
  side: "YES" | "NO",
  x: number,
  y: number,
  clipId: string,
): string {
  const sideColor = side === "YES" ? "#BEFF07" : "#A487FF";
  const nameColor = slot.isOpen ? "#9EA7BE" : "#FFFFFF";
  const displayName = slot.isOpen ? "Open slot" : truncate(getParticipantHandle(slot.displayName), 16);
  const avatarCx = x + 96;
  const avatarCy = y + 23;

  return `
    <g>
      <rect x="${x}" y="${y}" width="348" height="46" rx="23" fill="#10131B" stroke="${sideColor}" stroke-opacity="0.22" />
      <text x="${x + 24}" y="${y + 29}" fill="${sideColor}" font-family="${OG_FONT_STACK}" font-size="21" font-weight="800">${side}</text>
      ${
        avatarDataUri
          ? `<image href="${avatarDataUri}" x="${avatarCx - 14}" y="${avatarCy - 14}" width="28" height="28" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" />`
          : buildAvatarFallbackMarkup(avatarCx, avatarCy, side, slot.displayName)
      }
      <text x="${x + 122}" y="${y + 29}" fill="${nameColor}" font-family="${OG_FONT_STACK}" font-size="20" font-weight="700">${escapeXml(displayName)}</text>
    </g>
  `;
}

async function buildChallengeCardSvg(challenge: any, storage: IStorage, baseUrl: string): Promise<string> {
  const logoDataUri = (await loadFirstAvailableFileAsDataUri(BANTAH_BLUE_LOGO_CANDIDATE_PATHS, "image/svg+xml"))
    || (await resolveImageDataUri("/assets/bantahblue.svg", baseUrl))
    || "";
  const ogFontDataUri = await getOgFontDataUri(baseUrl);
  const coverImageDataUri = await resolveImageDataUri(
    challenge.coverImageUrl || challenge.coverImage || challenge.image || challenge.imageUrl,
    baseUrl,
  );

  const challengerAgent = challenge.challengerAgentId
    ? await storage.getAgentById(String(challenge.challengerAgentId))
    : undefined;
  const challengedAgent = challenge.challengedAgentId
    ? await storage.getAgentById(String(challenge.challengedAgentId))
    : undefined;

  const { yesSlot, noSlot, participantCount } = buildChallengeSlots(challenge, challengerAgent, challengedAgent);
  const [yesAvatarDataUri, noAvatarDataUri] = await Promise.all([
    resolveImageDataUri(yesSlot.avatarUrl, baseUrl),
    resolveImageDataUri(noSlot.avatarUrl, baseUrl),
  ]);

  const titleLines = wrapText(String(challenge.title || "Untitled challenge"), 24, 3);
  const stakeText = formatTokenAmount(challenge.amount, challenge.tokenSymbol);
  const payoutText = formatPayout(challenge.amount, challenge.tokenSymbol);
  const deadlineLabel = formatDateLabel(challenge.dueDate);
  const chainLabel = resolveChainLabel(challenge.chainId);
  const usersLabel = `${participantCount} ${participantCount === 1 ? "user" : "users"}`;
  const statusLabel = String(challenge.status || "open").replace(/_/g, " ").toUpperCase();
  const statusWidth = getPillWidth(statusLabel, 140);
  const stakeFontSize = getStakeFontSize(stakeText);
  const titleTop = 156;
  const titleLineHeight = 46;
  const titleBottom = titleTop + (titleLines.length - 1) * titleLineHeight;
  const stakeLabelY = titleBottom + 56;
  const stakeY = stakeLabelY + 66;
  const winPillY = stakeY + 18;
  const participantRow1Y = winPillY + 64;
  const participantRow2Y = participantRow1Y + 54;
  const statBoxY = participantRow2Y + 52;

  const logoMarkup = logoDataUri
    ? `<image href="${logoDataUri}" x="82" y="52" width="52" height="42" preserveAspectRatio="xMidYMid meet" />`
    : `<circle cx="108" cy="73" r="22" fill="#7440FF" />`;

  const coverMarkup = coverImageDataUri
    ? `
      <image href="${coverImageDataUri}" x="-154" y="-190" width="308" height="380" preserveAspectRatio="xMidYMid slice" clip-path="url(#coverClip)" />
      <rect x="-154" y="-190" width="308" height="380" rx="34" fill="url(#coverShade)" />
    `
    : `
      <rect x="-154" y="-190" width="308" height="380" rx="34" fill="url(#heroFallback)" />
      <text x="0" y="-8" fill="#FFFFFF" font-family="${OG_FONT_STACK}" font-size="26" font-weight="700" text-anchor="middle">${escapeXml(truncate(String(challenge.category || "Bantah").toUpperCase(), 12))}</text>
      <text x="0" y="28" fill="#BEFF07" font-family="${OG_FONT_STACK}" font-size="18" font-weight="700" text-anchor="middle">CHALLENGE</text>
    `;
  const fontFaceMarkup = ogFontDataUri
    ? `
        <style>
          @font-face {
            font-family: "BantahOG";
            src: url("${ogFontDataUri}") format("truetype");
            font-weight: 100 900;
            font-style: normal;
          }
        </style>
      `
    : "";

  return `
    <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
      <defs>
        ${fontFaceMarkup}
        <linearGradient id="canvasBg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
          <stop stop-color="#030306" />
          <stop offset="1" stop-color="#090913" />
        </linearGradient>
        <linearGradient id="cardBg" x1="30" y1="30" x2="1170" y2="600" gradientUnits="userSpaceOnUse">
          <stop stop-color="#06070B" />
          <stop offset="0.42" stop-color="#0D0A18" />
          <stop offset="1" stop-color="#171129" />
        </linearGradient>
        <radialGradient id="purpleGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(894 182) rotate(118.245) scale(474 502)">
          <stop stop-color="#7440FF" stop-opacity="0.44" />
          <stop offset="1" stop-color="#7440FF" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="limeGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1014 548) rotate(-165.473) scale(300 210)">
          <stop stop-color="#BEFF07" stop-opacity="0.24" />
          <stop offset="1" stop-color="#BEFF07" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="stakeFill" x1="80" y1="290" x2="470" y2="394" gradientUnits="userSpaceOnUse">
          <stop stop-color="#D4FF62" />
          <stop offset="0.55" stop-color="#BEFF07" />
          <stop offset="1" stop-color="#8ED000" />
        </linearGradient>
        <linearGradient id="heroFallback" x1="-154" y1="-190" x2="154" y2="190" gradientUnits="userSpaceOnUse">
          <stop stop-color="#1A1731" />
          <stop offset="0.55" stop-color="#202449" />
          <stop offset="1" stop-color="#11151F" />
        </linearGradient>
        <linearGradient id="coverShade" x1="-154" y1="-190" x2="154" y2="190" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFFFFF" stop-opacity="0.10" />
          <stop offset="0.38" stop-color="#FFFFFF" stop-opacity="0" />
          <stop offset="1" stop-color="#000000" stop-opacity="0.34" />
        </linearGradient>
        <pattern id="grid" width="44" height="44" patternUnits="userSpaceOnUse">
          <path d="M44 0H0V44" stroke="#A487FF" stroke-opacity="0.08" stroke-width="1" />
        </pattern>
        <clipPath id="cardClip">
          <rect x="30" y="30" width="1140" height="570" rx="40" />
        </clipPath>
        <clipPath id="coverClip">
          <rect x="-154" y="-190" width="308" height="380" rx="34" />
        </clipPath>
        <clipPath id="yesAvatarClip">
          <circle cx="176" cy="${participantRow1Y + 23}" r="14" />
        </clipPath>
        <clipPath id="noAvatarClip">
          <circle cx="176" cy="${participantRow2Y + 23}" r="14" />
        </clipPath>
      </defs>

      <rect width="1200" height="630" fill="url(#canvasBg)" />
      <g clip-path="url(#cardClip)">
        <rect x="30" y="30" width="1140" height="570" rx="40" fill="url(#cardBg)" />
        <rect x="30" y="30" width="1140" height="570" rx="40" fill="url(#purpleGlow)" />
        <rect x="30" y="30" width="1140" height="570" rx="40" fill="url(#limeGlow)" />
        <rect x="30" y="30" width="1140" height="570" rx="40" fill="url(#grid)" />

        <g opacity="0.14">
          <line x1="712" y1="86" x2="712" y2="580" stroke="#BEFF07" stroke-width="2" />
          <line x1="762" y1="126" x2="762" y2="580" stroke="#BEFF07" stroke-width="2" />
          <line x1="814" y1="96" x2="814" y2="580" stroke="#BEFF07" stroke-width="2" />
          <line x1="866" y1="148" x2="866" y2="580" stroke="#BEFF07" stroke-width="2" />
          <line x1="918" y1="104" x2="918" y2="580" stroke="#BEFF07" stroke-width="2" />
          <line x1="970" y1="168" x2="970" y2="580" stroke="#BEFF07" stroke-width="2" />
          <line x1="1022" y1="126" x2="1022" y2="580" stroke="#BEFF07" stroke-width="2" />
          <line x1="1074" y1="82" x2="1074" y2="580" stroke="#BEFF07" stroke-width="2" />
        </g>

        <g opacity="0.18">
          <rect x="782" y="116" width="52" height="132" rx="18" stroke="#8F70FF" stroke-width="2" />
          <rect x="874" y="98" width="56" height="170" rx="18" stroke="#8F70FF" stroke-width="2" />
          <rect x="972" y="152" width="52" height="122" rx="18" stroke="#8F70FF" stroke-width="2" />
          <rect x="1064" y="114" width="58" height="184" rx="18" stroke="#8F70FF" stroke-width="2" />
        </g>

        <g opacity="0.22">
          <path d="M724 510L762 476L796 444L830 410L864 378L898 332L932 302L968 258L1004 220L1040 180" stroke="#BEFF07" stroke-width="4" stroke-linecap="round" />
          <path d="M1024 172L1052 180L1043 154" stroke="#BEFF07" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
        </g>

        ${logoMarkup}

        <rect x="${1092 - statusWidth}" y="54" width="${statusWidth}" height="42" rx="21" fill="#11131A" stroke="#A487FF" stroke-opacity="0.30" />
        <text x="${1092 - statusWidth / 2}" y="81" fill="#FFFFFF" font-family="${OG_FONT_STACK}" font-size="18" font-weight="800" text-anchor="middle">${escapeXml(statusLabel)}</text>

        ${titleLines
          .map(
            (line, index) => `
          <text x="80" y="${titleTop + index * titleLineHeight}" fill="#FFFFFF" font-family="${OG_FONT_STACK}" font-size="44" font-weight="800">${escapeXml(line)}</text>`,
          )
          .join("")}

        <text x="80" y="${stakeLabelY}" fill="#9891B7" font-family="${OG_FONT_STACK}" font-size="18" font-weight="800" letter-spacing="1.5">STAKE</text>
        <text x="80" y="${stakeY}" fill="url(#stakeFill)" font-family="${OG_FONT_STACK}" font-size="${stakeFontSize}" font-weight="900">${escapeXml(stakeText)}</text>

        <rect x="84" y="${winPillY}" width="${getPillWidth(`To win ${payoutText}`, 214)}" height="44" rx="22" fill="#12141E" stroke="#BEFF07" stroke-opacity="0.24" />
        <text x="${84 + getPillWidth(`To win ${payoutText}`, 214) / 2}" y="${winPillY + 29}" fill="#FFFFFF" font-family="${OG_FONT_STACK}" font-size="21" font-weight="800" text-anchor="middle">${escapeXml(`To win ${payoutText}`)}</text>

        ${buildParticipantRowMarkup(yesSlot, yesAvatarDataUri, "YES", 80, participantRow1Y, "yesAvatarClip")}
        ${buildParticipantRowMarkup(noSlot, noAvatarDataUri, "NO", 80, participantRow2Y, "noAvatarClip")}

        <g>
          <rect x="80" y="${statBoxY}" width="150" height="58" rx="18" fill="#11131A" stroke="#FFFFFF" stroke-opacity="0.08" />
          <text x="102" y="${statBoxY + 21}" fill="#858FA9" font-family="${OG_FONT_STACK}" font-size="13" font-weight="700" letter-spacing="1">USERS</text>
          <text x="102" y="${statBoxY + 43}" fill="#FFFFFF" font-family="${OG_FONT_STACK}" font-size="20" font-weight="800">${escapeXml(usersLabel)}</text>
        </g>

        <g>
          <rect x="246" y="${statBoxY}" width="150" height="58" rx="18" fill="#11131A" stroke="#FFFFFF" stroke-opacity="0.08" />
          <text x="268" y="${statBoxY + 21}" fill="#858FA9" font-family="${OG_FONT_STACK}" font-size="13" font-weight="700" letter-spacing="1">CHAIN</text>
          <text x="268" y="${statBoxY + 43}" fill="#FFFFFF" font-family="${OG_FONT_STACK}" font-size="20" font-weight="800">${escapeXml(chainLabel)}</text>
        </g>

        <g>
          <rect x="412" y="${statBoxY}" width="188" height="58" rx="18" fill="#11131A" stroke="#FFFFFF" stroke-opacity="0.08" />
          <text x="434" y="${statBoxY + 21}" fill="#858FA9" font-family="${OG_FONT_STACK}" font-size="13" font-weight="700" letter-spacing="1">ENDS</text>
          <text x="434" y="${statBoxY + 43}" fill="#FFFFFF" font-family="${OG_FONT_STACK}" font-size="20" font-weight="800">${escapeXml(deadlineLabel)}</text>
        </g>

        <g transform="translate(944 310) rotate(-11)">
          <rect x="-170" y="-206" width="340" height="412" rx="42" fill="#12141E" fill-opacity="0.76" />
          <rect x="-154" y="-190" width="308" height="380" rx="34" fill="#131522" />
          ${coverMarkup}
          <rect x="-154" y="-190" width="308" height="380" rx="34" fill="none" stroke="#BEFF07" stroke-opacity="0.16" stroke-width="2" />
          <rect x="-142" y="-178" width="284" height="356" rx="28" fill="none" stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="1.5" />
        </g>
      </g>
    </svg>
  `;
}

async function buildBotaChallengeCardSvg(challenge: any, baseUrl: string): Promise<string> {
  const logoDataUri = (await loadFirstAvailableFileAsDataUri(BANTAH_BLUE_LOGO_CANDIDATE_PATHS, "image/svg+xml"))
    || (await resolveImageDataUri("/assets/bantahblue.svg", baseUrl))
    || "";
  const ogFontDataUri = await getOgFontDataUri(baseUrl);

  // We can reuse the challenge layout but with BotaChallenge fields
  const titleLines = wrapText(String(`@${challenge.challengerAgent?.name || 'Agent'} challenges @${challenge.opponentAgent?.name || 'Agent'}` || "PvP Challenge"), 24, 3);
  const stakeText = formatTokenAmount(challenge.stakeAmount, challenge.stakeCurrency);
  const payoutText = formatPayout(challenge.stakeAmount, challenge.stakeCurrency);
  const deadlineLabel = formatDateLabel(challenge.expiresAt);
  const statusLabel = String(challenge.status || "pending").replace(/_/g, " ").toUpperCase();
  const statusWidth = getPillWidth(statusLabel, 140);
  const stakeFontSize = getStakeFontSize(stakeText);
  const titleTop = 156;
  const titleLineHeight = 46;
  const titleBottom = titleTop + (titleLines.length - 1) * titleLineHeight;
  const stakeLabelY = titleBottom + 56;
  const stakeY = stakeLabelY + 66;

  const fontFaceMarkup = ogFontDataUri
    ? `
        <style>
          @font-face {
            font-family: "BantahOG";
            src: url("${ogFontDataUri}") format("truetype");
            font-weight: 100 900;
            font-style: normal;
          }
        </style>
      `
    : "";

  return `
    <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
      <defs>
        ${fontFaceMarkup}
        <linearGradient id="canvasBg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
          <stop stop-color="#030306" />
          <stop offset="1" stop-color="#090913" />
        </linearGradient>
        <linearGradient id="cardBg" x1="30" y1="30" x2="1170" y2="600" gradientUnits="userSpaceOnUse">
          <stop stop-color="#06070B" />
          <stop offset="0.42" stop-color="#0D0A18" />
          <stop offset="1" stop-color="#171129" />
        </linearGradient>
        <radialGradient id="purpleGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(894 182) rotate(118.245) scale(474 502)">
          <stop stop-color="#7440FF" stop-opacity="0.44" />
          <stop offset="1" stop-color="#7440FF" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="limeGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1014 548) rotate(-165.473) scale(300 210)">
          <stop stop-color="#BEFF07" stop-opacity="0.24" />
          <stop offset="1" stop-color="#BEFF07" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="stakeFill" x1="80" y1="290" x2="470" y2="394" gradientUnits="userSpaceOnUse">
          <stop stop-color="#D4FF62" />
          <stop offset="0.55" stop-color="#BEFF07" />
          <stop offset="1" stop-color="#8ED000" />
        </linearGradient>
        <clipPath id="cardClip">
          <rect x="30" y="30" width="1140" height="570" rx="40" />
        </clipPath>
      </defs>

      <rect width="1200" height="630" fill="url(#canvasBg)" />
      <g clip-path="url(#cardClip)">
        <rect x="30" y="30" width="1140" height="570" rx="40" fill="url(#cardBg)" />
        <rect x="30" y="30" width="1140" height="570" rx="40" fill="url(#purpleGlow)" />
        <rect x="30" y="30" width="1140" height="570" rx="40" fill="url(#limeGlow)" />

        <rect x="${1092 - statusWidth}" y="54" width="${statusWidth}" height="42" rx="21" fill="#11131A" stroke="#A487FF" stroke-opacity="0.30" />
        <text x="${1092 - statusWidth / 2}" y="81" fill="#FFFFFF" font-family="${OG_FONT_STACK}" font-size="18" font-weight="800" text-anchor="middle">${escapeXml(statusLabel)}</text>

        ${titleLines
          .map(
            (line, index) => `
          <text x="80" y="${titleTop + index * titleLineHeight}" fill="#FFFFFF" font-family="${OG_FONT_STACK}" font-size="44" font-weight="800">${escapeXml(line)}</text>`,
          )
          .join("")}

        <text x="80" y="${stakeLabelY}" fill="#9891B7" font-family="${OG_FONT_STACK}" font-size="18" font-weight="800" letter-spacing="1.5">STAKE</text>
        <text x="80" y="${stakeY}" fill="url(#stakeFill)" font-family="${OG_FONT_STACK}" font-size="${stakeFontSize}" font-weight="900">${escapeXml(stakeText)}</text>
      </g>
    </svg>
  `;
}

async function generateEventSvg(event: any, baseUrl?: string): Promise<string> {
  const ogFontDataUri = await getOgFontDataUri(baseUrl);
  const title = escapeXml(String(event.title || "Bantah event"));
  const category = escapeXml(String(event.category || "general").toUpperCase());
  const participantCount = Number(event.participantCount || 0);
  const entryFee = escapeXml(String(event.entryFee || "0"));
  const fontFaceMarkup = ogFontDataUri
    ? `
        <style>
          @font-face {
            font-family: "BantahOG";
            src: url("${ogFontDataUri}") format("truetype");
            font-weight: 100 900;
            font-style: normal;
          }
        </style>
      `
    : "";

  return `
    <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
      <defs>
        ${fontFaceMarkup}
        <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
          <stop stop-color="#0f8b6f" />
          <stop offset="1" stop-color="#0a5d4d" />
        </linearGradient>
      </defs>
      <rect width="1200" height="630" fill="url(#bg)" />
      <rect x="90" y="104" width="1020" height="422" rx="30" fill="#FFFFFF" fill-opacity="0.96" />
      <text x="130" y="180" font-family="${OG_FONT_STACK}" font-size="34" font-weight="700" fill="#0f172a">Bantah Event</text>
      <text x="130" y="264" font-family="${OG_FONT_STACK}" font-size="42" font-weight="700" fill="#0f172a">${title}</text>
      <text x="130" y="342" font-family="${OG_FONT_STACK}" font-size="24" fill="#475569">Category: ${category}</text>
      <text x="130" y="386" font-family="${OG_FONT_STACK}" font-size="24" fill="#475569">Entry fee: ${entryFee}</text>
      <text x="130" y="430" font-family="${OG_FONT_STACK}" font-size="24" fill="#475569">Participants: ${participantCount}</text>
    </svg>
  `;
}

export function setupOGImageRoutes(app: any, storage: IStorage) {
  app.get("/api/og/challenges/:id.png", async (req: Request, res: Response) => {
    try {
      const challengeId = Number(req.params.id);
      if (Number.isNaN(challengeId)) {
        return res.status(400).json({ error: "Invalid challenge ID" });
      }
      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ error: "Challenge not found" });
      }

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const svg = await buildChallengeCardSvg(challenge, storage, baseUrl);
      const image = await renderSvgImage(svg);

      res.setHeader("Content-Type", image.contentType);
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=300");
      res.send(image.buffer);
    } catch (error) {
      console.error("Error generating challenge OG image:", error);
      res.status(500).json({ error: "Failed to generate image" });
    }
  });

  app.get("/api/og/bota-challenges/:code.png", async (req: Request, res: Response) => {
    try {
      const challengeCode = req.params.code;
      const challenge = await getBotaAgentChallengeByCode({ challengeCode });
      if (!challenge) {
        return res.status(404).json({ error: "BOTA Challenge not found" });
      }

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const svg = await buildBotaChallengeCardSvg(challenge, baseUrl);
      const image = await renderSvgImage(svg);

      res.setHeader("Content-Type", image.contentType);
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=300");
      res.send(image.buffer);
    } catch (error) {
      console.error("Error generating BOTA challenge OG image:", error);
      res.status(500).json({ error: "Failed to generate image" });
    }
  });

  app.get("/api/og/challenge/:id", async (req: Request, res: Response) => {
    req.url = `/api/og/challenges/${req.params.id}.png`;
    res.redirect(302, `/api/og/challenges/${req.params.id}.png`);
  });

  app.get("/api/og/bota-challenge/:code", async (req: Request, res: Response) => {
    res.redirect(302, `/api/og/bota-challenges/${req.params.code}.png`);
  });

  app.get("/api/og/event/:id", async (req: Request, res: Response) => {
    try {
      const eventId = parseInt(req.params.id, 10);
      const event = await storage.getEventById(eventId);

      if (!event) {
        return res.status(404).json({ error: "Event not found" });
      }

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const svg = await generateEventSvg(event, baseUrl);
      const image = await renderSvgImage(svg);

      res.setHeader("Content-Type", image.contentType);
      res.setHeader("Cache-Control", "public, max-age=900");
      res.send(image.buffer);
    } catch (error) {
      console.error("Error generating event OG image:", error);
      res.status(500).json({ error: "Failed to generate image" });
    }
  });
}
