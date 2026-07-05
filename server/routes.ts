import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import path from "path";
import Pusher from "pusher";
import { ethers } from "ethers";
import { AGENT_WIN_BANTCREDIT_REWARD, storage } from "./storage";
import { setupAuth, isAdmin, hashPassword } from "./auth";
import { PrivyAuthMiddleware } from "./privyAuth";
import { verifyPrivyToken } from "./privyAuth";
import { getDelegatedAgentUserIdFromAuthHeader } from "./agentAuth";
import { getOnchainServerConfig } from "./onchainConfig";
import { verifyEscrowTransaction, assertAllowedStakeToken } from "./onchainEscrowService";
import {
  logOnchainChallengeCreated,
  upsertOnchainChallengeMetadata,
} from "./onchainMetadata";
import {
  buildRewardBatch,
  computeSimBattleEventRoot,
  computeSimBattleMetadataHash,
  recordSimulatedBattleOnchain,
  setBantCreditRewardBatchOnchain,
  type SimBattleReceiptPayload,
} from "./onchainSimRewards";
import { getOnchainIndexerHealthSnapshot } from "./onchainIndexer";
import { DB_IDENTITY, db, pool } from "./db";
import { insertEventSchema, insertChallengeSchema, insertNotificationSchema } from "@shared/schema";
import {
  BANTCREDIT_DAILY_CHECKIN_REWARD,
  BANTCREDIT_REFERRED_REWARD,
  BANTCREDIT_REFERRER_REWARD,
} from "@shared/bantCredit";
import {
  normalizeEvmAddress,
  normalizeOnchainTokenSymbol,
  parseWalletAddresses,
  toAtomicUnits,
  type OnchainChainConfig,
  type OnchainTokenSymbol,
} from "@shared/onchainConfig";
import { and, eq } from "drizzle-orm";
import {
  users,
  events,
  userAchievements,
  challenges,
  notifications,
  transactions,
  dailyLogins,
  eventParticipants,
  eventMessages,
  challengeMessages,
  messageReactions,
  friends,
  groups,
  groupMembers,
  eventJoinRequests,
  eventPools,
  pairQueue,
  adminWalletTransactions,
} from "../shared/schema";
import { sql } from "drizzle-orm";
import crypto from "crypto";
import { createTelegramSync, getTelegramSync } from "./telegramSync";
import { getBantahBroTelegramBot, getTelegramBot } from "./telegramBot";
import webpush from "web-push";
import { setupOGImageRoutes } from "./ogImageGenerator";
import { recommendationEngine } from "./recommendationEngine";
import { payoutQueue } from "./payoutQueue";
import { payoutWorker } from "./payoutWorker";
import { 
  generateEventOGMeta, 
  generateChallengeOGMeta, 
  generateReferralOGMeta, 
  generateProfileOGMeta,
  getDefaultOGMeta,
  generateOGMetaTags 
} from "./og-meta";
import ogMetadataRouter from './routes/og-metadata';
import { challengeNotifications } from './challengeNotifications';
import {
  createAndPushAgentOwnerNotification,
  getAgentRankSnapshot,
  notifyAgentRankChangeIfNeeded,
} from "./agentNotificationService";
import { getStoredMediaAsset, storeUploadedImage } from "./mediaStorage";

// Import notification routes
import notificationsApi from './routes/notificationsApi';
import adminNotificationsApi from './routes/adminNotificationsApi';
import agentsApi from './routes/agentsApi';
import bantahBroApi from './routes/bantahBroApi';
import { registerBlinkActionRoutes } from './routes/blinkActionsApi';
import { registerBotaShareMetaRoutes } from './bantahBro/botaShareMetaRoutes';
import { getBantahBroBattleEngineFeed } from './bantahBro/battleDiscoveryEngine';
import {
  listBantahBroBattleOverrides,
  updateBantahBroBattleOverride,
} from './bantahBro/battleOverridesService';
import {
  listBantahBroListedBattles,
  publishBantahBroBattleCandidates,
  unlistBantahBroBattle,
} from './bantahBro/battleListingsService';
import { notificationInfrastructure } from './notificationInfrastructure';
import { normalizePolymarketMarkets } from "./externalMarketAdapters";
import type { ExternalMarket } from "@shared/externalMarkets";
import {
  attachChallengeToPartnerProgram,
  createPartnerWithdrawalRequest,
  calculatePartnerFeeSettlement,
  canManagePartnerProgram,
  canViewPartnerProgram,
  createPartnerSignupApplication,
  createPartnerProgram,
  getPartnerDashboardAccess,
  decidePartnerWithdrawal,
  ensurePartnerProgramTables,
  getPartnerChallengeMeta,
  getPartnerProgramById,
  getPartnerWalletSummary,
  listPartnerChallenges,
  listPartnerProgramMembers,
  listPartnerProgramsForUser,
  listPartnerWalletTransactions,
  listPartnerWithdrawals,
  listPartnerSignupApplications,
  listPendingPartnerWithdrawals,
  listPublicPartnerChallengeLinks,
  reviewPartnerSignupApplication,
  upsertPartnerProgramMember,
  type PartnerMemberRole,
} from "./partnerPrograms";

// Import pairing engine for challenge queue matching
import { createPairingEngine } from './pairingEngine';

// Import formatBalance utility for coin operations
function formatBalance(amount: number): string {
  return `₦${amount.toLocaleString()}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderShareRedirectPage(
  ogMeta: { title: string; description: string; url: string },
  redirectPath: string,
  metaTags: string,
) {
  const safeRedirectPath = escapeHtml(redirectPath);
  const safeTitle = escapeHtml(ogMeta.title);
  const safeDescription = escapeHtml(ogMeta.description);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  ${metaTags}
  <meta http-equiv="refresh" content="0; url=${safeRedirectPath}" />
  <script>window.location.replace(${JSON.stringify(redirectPath)});</script>
</head>
<body>
  <main style="font-family: Arial, Helvetica, sans-serif; padding: 24px;">
    <h1>${safeTitle}</h1>
    <p>${safeDescription}</p>
    <p><a href="${safeRedirectPath}">Open challenge on Bantah</a></p>
  </main>
</body>
</html>`;
}
import axios from "axios";
import fs from "fs/promises";
import path from "path";
// express-fileupload removed — multer handles file uploads in server/index.ts
import { adminAuth, generateAdminToken } from "./adminAuth";
import { desc, or, not, isNull, count, sum, avg } from "drizzle-orm";
import type { NextFunction } from "express";

// Initialize Pusher
const pusher = new Pusher({
  appId: "1553294",
  key: "decd2cca5e39cf0cbcd4",
  secret: "1dd966e56c465ea285d9",
  cluster: "mt1",
  useTLS: true,
});

const WEB_PUSH_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY ||
  process.env.WEB_PUSH_PUBLIC_KEY ||
  "BKZ0LNy05CTv807lF4dSwM3wB7nxrBHXDP5AYPvbCCPZYWrK08rTYFQO6BmKrW3f0xmIe5wUxtLN67XOSQ7W--o";
const WEB_PUSH_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY ||
  process.env.WEB_PUSH_PRIVATE_KEY ||
  "uNkb_1Ntqe1IKeqDeAlbyOJcXTt8wrvwArWSh7GML0A";
const WEB_PUSH_SUBJECT =
  process.env.VAPID_SUBJECT ||
  process.env.WEB_PUSH_SUBJECT ||
  "mailto:support@bantah.com";

// Configure Web Push
webpush.setVapidDetails(WEB_PUSH_SUBJECT, WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY);

const ONCHAIN_CONFIG = getOnchainServerConfig();



// Initialize Telegram sync service. Local dev disables it by default so Vite
// refreshes are not tied to Telegram session/polling failures.
const isLocalDevRuntime =
  process.env.npm_lifecycle_event === "dev" || process.env.NODE_ENV !== "production";
const isVercelRuntime = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
const telegramSyncEnabledInDev =
  String(process.env.TELEGRAM_SYNC_ENABLED || "").trim().toLowerCase() === "true";
const telegramSyncEnabledInVercel =
  String(process.env.TELEGRAM_SYNC_ENABLED || "").trim().toLowerCase() === "true";

let telegramSync =
  (isLocalDevRuntime && !telegramSyncEnabledInDev) ||
  (isVercelRuntime && !telegramSyncEnabledInVercel)
    ? null
    : createTelegramSync(pusher);
if (telegramSync) {
  telegramSync.initialize().catch((error) => {
    // Telegram sync initialization failed silently
  });
} else if (isLocalDevRuntime && !telegramSyncEnabledInDev) {
  console.log("[INIT] Telegram sync disabled in local dev. Set TELEGRAM_SYNC_ENABLED=true to enable it.");
} else if (isVercelRuntime && !telegramSyncEnabledInVercel) {
  console.log("[INIT] Telegram sync disabled on Vercel. Set TELEGRAM_SYNC_ENABLED=true to enable it.");
}

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
    walletAddress?: string | null;
    isAdmin?: boolean;
    claims?: {
      sub: string;
      email?: string;
      first_name?: string;
      last_name?: string;
    };
  };
}

// Helper function to safely get user ID from request
function getUserId(req: AuthenticatedRequest): string {
  // Privy stores user ID directly in user.id
  if (req.user?.id) {
    // Normalize Privy DID to compact ID (remove "did:privy:" prefix if present)
    return req.user.id.replace(/^did:privy:/, '').trim();
  }
  // Fallback for old auth structure
  if (req.user?.claims?.sub) {
    return req.user.claims.sub.replace(/^did:privy:/, '').trim();
  }
  throw new Error("User ID not found in request");
}

async function getOptionalPrivyUserId(req: Request): Promise<string | null> {
  let existingUserId =
    (req as any)?.user?.id || (req as any)?.user?.claims?.sub || null;
  if (typeof existingUserId === "string" && existingUserId) {
    // Normalize Privy DID to compact ID (remove "did:privy:" prefix if present)
    return existingUserId.replace(/^did:privy:/, '').trim();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const delegatedAgentUserId = await getDelegatedAgentUserIdFromAuthHeader(authHeader);
  if (delegatedAgentUserId) return delegatedAgentUserId;
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;
  try {
    const claims = await verifyPrivyToken(token);
    const userId = claims?.userId || claims?.sub;
    return typeof userId === "string" && userId ? userId : null;
  } catch {
    return null;
  }
}

function mergeWalletSet(current: unknown, incoming: string | null): string[] {
  const existing = parseWalletAddresses(current);
  if (!incoming) return existing;
  if (existing.includes(incoming)) return existing;
  return [...existing, incoming];
}

const COMMUNITY_SOCIAL_KEYS = ["facebook", "twitter", "instagram", "tiktok", "youtube"] as const;
type CommunitySocialKey = (typeof COMMUNITY_SOCIAL_KEYS)[number];

function normalizeSocialUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeCommunityCoverImageUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/attached_assets/")) return trimmed;
  if (trimmed.startsWith("/api/media/")) return trimmed;
  if (trimmed.startsWith("/assets/")) return trimmed;
  if (trimmed.startsWith("data:image/")) return trimmed;
  return normalizeSocialUrl(trimmed);
}

function normalizeChallengeCoverImageUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/attached_assets/")) return trimmed;
  if (trimmed.startsWith("/api/media/")) return trimmed;
  if (trimmed.startsWith("/assets/")) return trimmed;
  if (trimmed.startsWith("data:image/")) return trimmed;
  return normalizeSocialUrl(trimmed);
}

function parseCommunitySocialLinks(input: unknown): Record<CommunitySocialKey, string> | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const normalized: Partial<Record<CommunitySocialKey, string>> = {};

  for (const key of COMMUNITY_SOCIAL_KEYS) {
    const value = raw[key];
    if (typeof value !== "string") continue;
    const normalizedUrl = normalizeSocialUrl(value);
    if (normalizedUrl) normalized[key] = normalizedUrl;
  }

  return Object.keys(normalized).length > 0
    ? (normalized as Record<CommunitySocialKey, string>)
    : null;
}

export async function registerRoutes(app: Express, upload?: any): Promise<Server> {
  // Create HTTP server
  const httpServer = createServer(app);

  app.get("/api/webhook", (_req, res) => {
    res.json({
      ok: true,
      service: "BOTA Mini App webhook",
      accepts: ["miniapp_added", "miniapp_removed", "notifications_enabled", "notifications_disabled"],
      db_url: process.env.DATABASE_URL
    });
  });

  app.post("/api/webhook", (req, res) => {
    console.log("[BOTA Mini App webhook]", JSON.stringify(req.body || {}));
    res.json({ ok: true });
  });

  // File uploads are handled by multer (configured in server/index.ts).
  // Do not register another multipart parser to avoid stream conflicts.

  // Auth middleware
  await setupAuth(app);

  // BOTA social share pages must be registered before generic app/share routes
  // so crawlers receive OG/Twitter/Farcaster meta instead of the React shell.
  registerBotaShareMetaRoutes(app);

  // The battle discovery engine is an admin control surface. Keep old public links
  // from rendering a blank BantahBro route by sending them to the admin page.
  app.get(['/bantahbro/battle-engine/live', '/bantahbro/battle-engine/live/'], (_req, res) => {
    res.redirect(302, '/admin/bantahbro-engine');
  });

  app.get("/api/push/config", (_req, res) => {
    res.json({ publicKey: WEB_PUSH_PUBLIC_KEY });
  });

  app.post("/api/push/subscribe", PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const subscription = req.body?.subscription || req.body;
      const endpoint = String(subscription?.endpoint || "").trim();
      const p256dh = String(subscription?.keys?.p256dh || "").trim();
      const auth = String(subscription?.keys?.auth || "").trim();

      if (!endpoint || !p256dh || !auth) {
        return res.status(400).json({ message: "Invalid push subscription payload" });
      }

      await storage.savePushSubscription(userId, {
        endpoint,
        keys: { p256dh, auth },
        userAgent: req.get("user-agent") || null,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error saving push subscription:", error);
      res.status(500).json({ message: "Failed to save push subscription" });
    }
  });

  app.post("/api/push/unsubscribe", PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const endpoint = String(req.body?.endpoint || req.body?.subscription?.endpoint || "").trim();
      if (!endpoint) {
        return res.status(400).json({ message: "Push endpoint is required" });
      }

      await storage.removePushSubscription(endpoint);
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing push subscription:", error);
      res.status(500).json({ message: "Failed to remove push subscription" });
    }
  });

  app.post("/api/push/send", PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const subscriptions = await storage.getPushSubscriptions(userId);
      const payload = JSON.stringify({
        title: String(req.body?.title || "BOTA notification"),
        body: String(req.body?.body || req.body?.message || "New BOTA update"),
        icon: "/assets/bota-bantah-icon.png",
        badge: "/assets/bota-bantah-icon.png",
        type: String(req.body?.data?.type || req.body?.type || "bota_push_test"),
        data: {
          ...(req.body?.data || {}),
          url: req.body?.data?.url || req.body?.url || "/bota",
        },
      });

      let sent = 0;
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await webpush.sendNotification(subscription, payload);
            sent += 1;
          } catch (error: any) {
            if (error?.statusCode === 404 || error?.statusCode === 410) {
              await storage.removePushSubscription(subscription.endpoint);
            } else {
              console.warn("Push notification send failed:", error?.message || error);
            }
          }
        }),
      );

      res.json({ success: true, sent, subscriptions: subscriptions.length });
    } catch (error) {
      console.error("Error sending push notification:", error);
      res.status(500).json({ message: "Failed to send push notification" });
    }
  });

  // Partner program tables are isolated from existing challenge tables.
  // Ensure they exist at boot so partner endpoints work without a separate migration step.
  ensurePartnerProgramTables().catch((error) => {
    console.error("Failed to ensure partner program tables:", error);
  });

  // Public "skills" descriptor for third-party agents (safe read endpoints; no auth required).
  app.get("/api/skills", (req, res) => {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim();
    const forwardedHost = String(req.headers["x-forwarded-host"] || "")
      .split(",")[0]
      .trim();

    const proto = forwardedProto || req.protocol || "http";
    const host = forwardedHost || req.get("host") || "";
    const baseUrl = host ? `${proto}://${host}` : "";

    res.json({
      name: "Bantah Public Skills",
      version: "1.0.0",
      baseUrl,
      safeWithoutAuth: true,
      note: "Public read-only endpoints that agents can call without Bantah sign-in. Protected actions still require Bantah auth.",
      endpoints: [
        { group: "Challenge Discovery", method: "GET", path: "/api/challenges?feed=all" },
        { group: "Challenge Discovery", method: "GET", path: "/api/challenges/public" },
        { group: "Challenge Discovery", method: "GET", path: "/api/challenges/:id" },
        { group: "Challenge Discovery", method: "GET", path: "/api/challenges/:id/messages" },
        { group: "Leaderboard", method: "GET", path: "/api/leaderboard" },
        { group: "Onchain Status", method: "GET", path: "/api/onchain/config" },
        { group: "Onchain Status", method: "GET", path: "/api/onchain/status" },
        { group: "Public Profiles", method: "GET", path: "/u/:username", note: "Redirects to /@:username" },
      ],
    });
  });

  // Public onchain runtime config for UI initialization
  app.get("/api/onchain/config", (_req, res) => {
    res.json(ONCHAIN_CONFIG);
  });

  app.post("/api/admin/onchain/sim-battle/record", adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const payload = req.body?.payload as SimBattleReceiptPayload | undefined;
      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ message: "payload is required" });
      }
      if (!payload.battleId || !payload.ensOwner || !Array.isArray(payload.rewards)) {
        return res.status(400).json({
          message: "payload.battleId, payload.ensOwner, and payload.rewards are required",
        });
      }

      const chainId = Number(req.body?.chainId || ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId);
      const chain =
        ONCHAIN_CONFIG.chains[String(chainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.chainId)];
      if (!chain) {
        return res.status(400).json({ message: "Unsupported chainId for simulated battle rewards" });
      }

      const dryRun = req.body?.execute !== true;
      const metadata = computeSimBattleMetadataHash(payload);
      const eventRoot = computeSimBattleEventRoot(payload.events || []);
      const rewardBatch = buildRewardBatch({
        batchId: String(req.body?.batchId || payload.battleId),
        rewards: payload.rewards,
      });

      const recordResult = req.body?.recordBattle === false
        ? null
        : await recordSimulatedBattleOnchain({
            chain,
            payload,
            eventRoot,
            rewardRoot: rewardBatch.root,
            totalBantCredits: rewardBatch.totalBantCredits,
            dryRun,
          });
      const rewardResult = req.body?.publishRewards === false
        ? null
        : await setBantCreditRewardBatchOnchain({
            chain,
            batchId: rewardBatch.batchId,
            rewards: payload.rewards,
            metadataHash: metadata.hash,
            active: req.body?.active !== false,
            dryRun,
          });

      res.json({
        mode: dryRun ? "dry_run" : "executed",
        chainId: chain.chainId,
        chainName: chain.name,
        contracts: {
          bantCreditsAddress: chain.bantCreditsAddress || null,
          simBattleRegistryAddress: chain.simBattleRegistryAddress || null,
          bantCreditRewardsAddress: chain.bantCreditRewardsAddress || null,
        },
        battleId: recordResult?.battleId || rewardBatch.batchId,
        metadataHash: metadata.hash,
        eventRoot,
        rewardRoot: rewardBatch.root,
        totalBantCredits: rewardBatch.totalBantCredits.toString(),
        recordTxHash: recordResult?.txHash || null,
        rewardBatchTxHash: rewardResult?.txHash || null,
        claims: rewardBatch.leaves.map((leaf) => ({
          account: leaf.account,
          amount: leaf.amount.toString(),
          role: leaf.role,
          roleBytes32: leaf.roleBytes32,
          matchId: leaf.matchId,
          matchIdBytes32: leaf.matchIdBytes32,
          leaf: leaf.leaf,
          proof: leaf.proof,
        })),
      });
    } catch (error: any) {
      console.error("Error recording simulated battle onchain:", error);
      res.status(500).json({ message: error?.message || "Failed to record simulated battle onchain" });
    }
  });

  app.get("/api/onchain/status", (_req, res) => {
    const indexer = getOnchainIndexerHealthSnapshot();
    const chains = Object.values(ONCHAIN_CONFIG.chains).map((chain) => ({
      chainId: chain.chainId,
      name: chain.name,
      escrowContractAddress: chain.escrowContractAddress || null,
      escrowSupportsChallengeLock: chain.escrowSupportsChallengeLock === true,
      escrowStakeMethodErc20: chain.escrowStakeMethodErc20 || null,
      escrowSettleMethod: chain.escrowSettleMethod || null,
      tokenSupport: Object.values(chain.tokens)
        .filter((token) => isSupportedOnchainToken(chain, token.symbol))
        .map((token) => ({
          symbol: token.symbol,
          isNative: token.isNative,
          configured: token.isNative ? true : !!normalizeEvmAddress(token.address),
        })),
    }));

    const contractConfiguredChains = chains.filter(
      (chain) => !!normalizeEvmAddress(chain.escrowContractAddress),
    ).length;

    const warnings: string[] = [];
    if (ONCHAIN_CONFIG.executionMode === "contract" && contractConfiguredChains === 0) {
      warnings.push("Execution mode is contract but no chain has ONCHAIN_*_ESCROW_ADDRESS configured.");
    }
    if (indexer.enabled) {
      for (const chain of indexer.chains) {
        if (typeof chain.lagBlocks === "number" && chain.lagBlocks > 200) {
          warnings.push(
            `Indexer lag is high on chainId ${chain.chainId} (${chain.lagBlocks} blocks behind).`,
          );
        }
        if (chain.lastError) {
          warnings.push(`Indexer reported an error on chainId ${chain.chainId}: ${chain.lastError}`);
        }
      }
    }
    if (DB_IDENTITY.isLocal && process.env.NODE_ENV === "production") {
      warnings.push("Production instance is connected to a local database host.");
    }

    res.json({
      appMode: "onchain",
      executionMode: ONCHAIN_CONFIG.executionMode,
      contractEnabled: ONCHAIN_CONFIG.contractEnabled,
      enforceWallet: ONCHAIN_CONFIG.enforceWallet,
      contractConfiguredChains,
      totalEnabledChains: chains.length,
      chains,
      database: {
        host: DB_IDENTITY.host,
        database: DB_IDENTITY.database,
        port: DB_IDENTITY.port,
        isLocal: DB_IDENTITY.isLocal,
      },
      indexer,
      warnings,
    });
  });

  function mergeEscrowTxHashes(existing: unknown, incomingHash: string): string {
    const incoming = String(incomingHash || "").trim().toLowerCase();
    if (!incoming) return String(existing || "");

    const raw = String(existing || "").trim();
    if (!raw) return incoming;

    if (raw.toLowerCase().includes(incoming)) {
      return raw;
    }

    return `${raw},${incoming}`;
  }

  function normalizeTxHash(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(trimmed)) return null;
    return trimmed.toLowerCase();
  }

  function extractFirstTxHash(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const parts = value
      .split(/[,\s]+/)
      .map((part) => normalizeTxHash(part))
      .filter((part): part is string => !!part);
    return parts[0] || null;
  }

  function extractTxHashes(value: unknown): string[] {
    if (typeof value !== "string") return [];
    return value
      .split(/[,\s]+/)
      .map((part) => normalizeTxHash(part))
      .filter((part): part is string => !!part);
  }

  function getStaticRpcProvider(chain: OnchainChainConfig) {
    return new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, {
      staticNetwork: true,
    });
  }

  async function resolveChallengeEscrowRuntime(params: {
    challengeLike: any;
    chain: OnchainChainConfig;
  }): Promise<{
    escrowContractAddress: string | null;
    challengerWallet: string | null;
    challengedWallet: string | null;
    txHashes: string[];
  }> {
    const txHashes = extractTxHashes(
      params.challengeLike?.escrowTxHash || params.challengeLike?.escrow_tx_hash,
    );
    const provider = getStaticRpcProvider(params.chain);
    const txs = await Promise.all(
      txHashes.slice(0, 2).map((hash) =>
        provider.getTransaction(hash).catch(() => null),
      ),
    );

    const escrowContractAddress =
      normalizeEvmAddress(txs[0]?.to) ||
      normalizeEvmAddress(params.chain.escrowContractAddress);
    const challengerWallet = normalizeEvmAddress(txs[0]?.from);
    const challengedWallet =
      normalizeEvmAddress(txs[1]?.from) ||
      normalizeEvmAddress(
        params.challengeLike?.challengedWalletAddress ||
          params.challengeLike?.challenged_wallet_address,
      );

    return {
      escrowContractAddress,
      challengerWallet,
      challengedWallet,
      txHashes,
    };
  }

  const ESCROW_V2_PAYOUT_ABI = [
    "function settleChallengeNativePayout(uint256 challengeId, address winner, address loser) returns (bool)",
    "function settleChallengeTokenPayout(uint256 challengeId, address token, address winner, address loser) returns (bool)",
    "function refundChallengeNative(uint256 challengeId, address participantA, address participantB) returns (bool)",
    "function refundChallengeToken(uint256 challengeId, address token, address participantA, address participantB) returns (bool)",
    "function treasury() view returns (address)",
  ];

  async function executeManagedChallengeSettlement(params: {
    challengeLike: any;
    chain: OnchainChainConfig;
    tokenSymbol: OnchainTokenSymbol;
    result: "challenger_won" | "challenged_won" | "draw";
    escrowContractAddress: string;
    challengerWallet: string;
    challengedWallet: string;
  }): Promise<{
    payoutTxHash: string;
    method:
      | "settleChallengeNativePayout"
      | "settleChallengeTokenPayout"
      | "refundChallengeNative"
      | "refundChallengeToken";
    treasuryAddress: string;
  }> {
    const adminKey = String(process.env.ADMIN_PRIVATE_KEY || "").trim();
    if (!adminKey) {
      throw new Error("ADMIN_PRIVATE_KEY is required for managed onchain settlement");
    }

    const provider = getStaticRpcProvider(params.chain);
    const signer = new ethers.Wallet(adminKey, provider);
    const contract = new ethers.Contract(
      params.escrowContractAddress,
      ESCROW_V2_PAYOUT_ABI,
      signer,
    );

    const tokenConfig = params.chain.tokens[params.tokenSymbol];
    if (!tokenConfig) {
      throw new Error(`Unsupported token ${params.tokenSymbol} on ${params.chain.name}`);
    }

    let tx: any;
    let method:
      | "settleChallengeNativePayout"
      | "settleChallengeTokenPayout"
      | "refundChallengeNative"
      | "refundChallengeToken";

    if (params.result === "draw") {
      if (tokenConfig.isNative) {
        method = "refundChallengeNative";
        tx = await contract.refundChallengeNative(
          BigInt(params.challengeLike.id),
          params.challengerWallet,
          params.challengedWallet,
        );
      } else {
        const tokenAddress = normalizeEvmAddress(
          params.challengeLike.tokenAddress || tokenConfig.address,
        );
        if (!tokenAddress) {
          throw new Error(`Token address missing for ${params.tokenSymbol} on ${params.chain.name}`);
        }
        method = "refundChallengeToken";
        tx = await contract.refundChallengeToken(
          BigInt(params.challengeLike.id),
          tokenAddress,
          params.challengerWallet,
          params.challengedWallet,
        );
      }
    } else {
      const winnerWallet =
        params.result === "challenger_won"
          ? params.challengerWallet
          : params.challengedWallet;
      const loserWallet =
        params.result === "challenger_won"
          ? params.challengedWallet
          : params.challengerWallet;

      if (tokenConfig.isNative) {
        method = "settleChallengeNativePayout";
        tx = await contract.settleChallengeNativePayout(
          BigInt(params.challengeLike.id),
          winnerWallet,
          loserWallet,
        );
      } else {
        const tokenAddress = normalizeEvmAddress(
          params.challengeLike.tokenAddress || tokenConfig.address,
        );
        if (!tokenAddress) {
          throw new Error(`Token address missing for ${params.tokenSymbol} on ${params.chain.name}`);
        }
        method = "settleChallengeTokenPayout";
        tx = await contract.settleChallengeTokenPayout(
          BigInt(params.challengeLike.id),
          tokenAddress,
          winnerWallet,
          loserWallet,
        );
      }
    }

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("Managed onchain settlement payout transaction failed");
    }

    const treasuryAddress = normalizeEvmAddress(await contract.treasury());
    return {
      payoutTxHash: String(tx.hash),
      method,
      treasuryAddress: treasuryAddress || "",
    };
  }

  function getChallengeScanUrl(challengeLike: any, preferredTxHash?: string | null): string | null {
    const chainId = Number(
      challengeLike?.chainId ||
        challengeLike?.chain_id ||
        ONCHAIN_CONFIG.defaultChainId ||
        ONCHAIN_CONFIG.chainId,
    );
    const chainConfig =
      ONCHAIN_CONFIG.chains[String(chainId)] ||
      ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)] ||
      ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.chainId)] ||
      Object.values(ONCHAIN_CONFIG.chains)[0];

    const baseExplorer = String(chainConfig?.blockExplorerUrl || "")
      .trim()
      .replace(/\/+$/, "");
    if (!baseExplorer) return null;

    const txHash =
      normalizeTxHash(preferredTxHash || "") ||
      extractFirstTxHash(challengeLike?.escrowTxHash || challengeLike?.escrow_tx_hash) ||
      extractFirstTxHash(challengeLike?.settleTxHash || challengeLike?.settle_tx_hash);

    if (txHash) return `${baseExplorer}/tx/${txHash}`;
    return baseExplorer;
  }

  function resolveOnchainChainName(chainIdLike: unknown): string | null {
    const chainId = Number(chainIdLike);
    if (!Number.isFinite(chainId)) return null;
    const chain = ONCHAIN_CONFIG.chains[String(chainId)];
    return chain?.name || `Chain ${chainId}`;
  }

  function formatAtomicStakeForDisplay(
    stakeAtomicLike: unknown,
    decimalsLike: unknown,
    tokenSymbolLike: unknown,
  ): string | null {
    const raw = String(stakeAtomicLike ?? "").trim();
    if (!/^\d+$/.test(raw)) return null;
    const decimals = Number(decimalsLike);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    const tokenSymbol = String(tokenSymbolLike || "ETH").toUpperCase();
    try {
      const atomic = BigInt(raw);
      if (decimals === 0) return `${atomic.toString()} ${tokenSymbol}`;
      const base = BigInt(10) ** BigInt(decimals);
      const whole = atomic / base;
      const fraction = atomic % base;
      let fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
      if (fractionText.length > 8) {
        fractionText = fractionText.slice(0, 8).replace(/0+$/, "");
      }
      const amountText = fractionText ? `${whole.toString()}.${fractionText}` : whole.toString();
      return `${amountText} ${tokenSymbol}`;
    } catch {
      return null;
    }
  }

  function buildChallengeStakeBroadcastMeta(challengeLike: any): {
    stakeDisplay: string;
    settlementLabel: string;
  } {
    const settlementRail = String(
      challengeLike?.settlementRail || challengeLike?.settlement_rail || "offchain",
    ).toLowerCase();
    const amount = Number.parseFloat(String(challengeLike?.amount ?? 0));
    const safeAmount = Number.isFinite(amount) ? amount : 0;

    if (settlementRail === "onchain") {
      const tokenSymbol = String(
        challengeLike?.tokenSymbol || challengeLike?.token_symbol || "ETH",
      ).toUpperCase();
      const chainName = resolveOnchainChainName(challengeLike?.chainId || challengeLike?.chain_id);
      const atomicDisplay = formatAtomicStakeForDisplay(
        challengeLike?.stakeAtomic ?? challengeLike?.stake_atomic,
        challengeLike?.decimals,
        tokenSymbol,
      );
      return {
        stakeDisplay: atomicDisplay || `${safeAmount.toLocaleString()} ${tokenSymbol}`,
        settlementLabel: `Onchain${chainName ? ` (${chainName})` : ""}`,
      };
    }

    return {
      stakeDisplay: `NGN ${safeAmount.toLocaleString()}`,
      settlementLabel: "Offchain (NGN)",
    };
  }

  function isSupportedOnchainToken(chainConfig: any, tokenSymbol: OnchainTokenSymbol): boolean {
    if (!chainConfig) return false;
    if (Array.isArray(chainConfig.supportedTokens) && chainConfig.supportedTokens.length > 0) {
      return chainConfig.supportedTokens.includes(tokenSymbol);
    }
    const tokenConfig = chainConfig.tokens?.[tokenSymbol];
    return Boolean(tokenConfig?.isNative || normalizeEvmAddress(tokenConfig?.address));
  }

  function parseNotificationData(data: unknown): Record<string, any> | null {
    if (!data) return null;
    if (typeof data === "string") {
      try {
        const parsed = JSON.parse(data);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    }
    return typeof data === "object" ? (data as Record<string, any>) : null;
  }

  function sanitizePusherChannel(value: string): string {
    return value.replace(/[^a-zA-Z0-9_\-]/g, "_");
  }

  async function triggerNotificationPush(userId: string, notification: any) {
    const sanitizedUserId = sanitizePusherChannel(String(userId || ""));
    if (!sanitizedUserId) return;
    try {
      await pusher.trigger(`user-${sanitizedUserId}`, "notification", {
        id: notification?.id,
        title: notification?.title,
        message: notification?.message,
        type: notification?.type,
        data: notification?.data,
        createdAt: notification?.createdAt,
        priority: notification?.priority,
        fomoLevel: notification?.fomoLevel,
      });
    } catch (error) {
      console.error("Failed to push realtime notification:", error);
    }
  }

  async function awardChallengeCreationBantCreditAndNotify(params: {
    userId: string;
    challenge: { id: number; title?: string | null };
    marketSize: number;
  }) {
    const reward = await storage.awardChallengeCreationBantCredit(params.userId, {
      challengeId: params.challenge.id,
      marketSize: params.marketSize,
      challengeTitle: params.challenge.title ?? null,
    });

    if (!reward.awarded || reward.pointsAwarded <= 0) {
      return reward;
    }

    const notification = await storage.createNotification({
      userId: params.userId,
      type: "challenge_creation_reward",
      title: "BantCredit earned",
      message: `You earned ${reward.pointsAwarded} BantCredit for creating "${params.challenge.title || "your challenge"}".`,
      data: {
        challengeId: params.challenge.id,
        challengeTitle: params.challenge.title ?? null,
        pointsAwarded: reward.pointsAwarded,
        marketSize: reward.marketSize,
        activityCount: reward.activityCount,
        activityMultiplier: reward.activityMultiplier,
        baseRate: reward.baseRate,
      },
    });

    await triggerNotificationPush(params.userId, notification);
    return reward;
  }

  function getNotificationChallengeId(notification: any, data?: Record<string, any> | null): number | null {
    const source = data || parseNotificationData(notification?.data);
    const rawId =
      source?.challengeId ??
      source?.challenge_id ??
      notification?.challengeId ??
      notification?.challenge_id ??
      notification?.relatedId;
    const parsed = Number(rawId);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  async function findChallengeUsingEscrowTxHash(txHash: string, excludeChallengeId?: number) {
    const normalized = String(txHash || "").trim().toLowerCase();
    if (!normalized) return null;

    const rows = await db
      .select({
        id: challenges.id,
        escrowTxHash: challenges.escrowTxHash,
      })
      .from(challenges)
      .where(
        and(
          sql`${challenges.escrowTxHash} IS NOT NULL`,
          excludeChallengeId ? sql`${challenges.id} <> ${excludeChallengeId}` : sql`TRUE`,
          sql`LOWER(${challenges.escrowTxHash}) LIKE ${`%${normalized}%`}`,
        ),
      )
      .limit(1);

    return rows[0] || null;
  }

  async function findChallengeUsingSettleTxHash(txHash: string, excludeChallengeId?: number) {
    const normalized = String(txHash || "").trim().toLowerCase();
    if (!normalized) return null;

    const rows = await db
      .select({
        id: challenges.id,
        settleTxHash: challenges.settleTxHash,
      })
      .from(challenges)
      .where(
        and(
          sql`${challenges.settleTxHash} IS NOT NULL`,
          excludeChallengeId ? sql`${challenges.id} <> ${excludeChallengeId}` : sql`TRUE`,
          sql`LOWER(${challenges.settleTxHash}) = ${normalized}`,
        ),
      )
      .limit(1);

    return rows[0] || null;
  }

  const requireOnchainWallet = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      if (!ONCHAIN_CONFIG.enforceWallet) {
        return next();
      }

      const userId = getUserId(req);
      const dbUser = await storage.getUser(userId);
      if (!dbUser) {
        return res.status(401).json({ message: "User not found" });
      }

      const headerWallet = normalizeEvmAddress(req.headers["x-wallet-address"]);
      const bodyWallet = normalizeEvmAddress((req.body as any)?.walletAddress);
      const authWallet = normalizeEvmAddress((req.user as any)?.walletAddress);
      const requestWallet = headerWallet || bodyWallet;
      const existingPrimary = normalizeEvmAddress((dbUser as any)?.primaryWalletAddress);
      const existingWallets = parseWalletAddresses((dbUser as any)?.walletAddresses);
      const effectiveWallet =
        requestWallet || authWallet || existingPrimary || existingWallets[0] || null;

      if (!effectiveWallet) {
        return res.status(403).json({
          message: "Wallet required. Connect an EVM wallet to continue.",
          code: "WALLET_REQUIRED",
        });
      }

      const nextWallets = mergeWalletSet((dbUser as any)?.walletAddresses, effectiveWallet);
      if (
        effectiveWallet !== existingPrimary ||
        nextWallets.length !== existingWallets.length
      ) {
        await storage.updateUserProfile(userId, {
          primaryWalletAddress: effectiveWallet,
          walletAddresses: nextWallets,
        } as any);
      }

      req.user.walletAddress = effectiveWallet;
      next();
    } catch (error) {
      console.error("Error enforcing onchain wallet auth:", error);
      res.status(500).json({ message: "Failed to validate wallet" });
    }
  };

  async function settleChallengeResultAndQueuePayout(params: {
    challengeId: number;
    result: "challenger_won" | "challenged_won" | "draw";
    resolvedByUserId?: string | null;
  }) {
    const { challengeId, result, resolvedByUserId } = params;

    const existingChallenge = await storage.getChallengeById(challengeId);
    if (!existingChallenge) {
      throw new Error("Challenge not found");
    }

    if (existingChallenge.result) {
      return {
        challenge: existingChallenge,
        payoutJobId: null,
        partnerSettlement: null,
        message: `Challenge already settled as ${existingChallenge.result}.`,
      };
    }

    const challenge = await storage.adminSetChallengeResult(challengeId, result);
    if (!challenge) {
      throw new Error("Challenge not found");
    }

    const challengerUser = challenge.challenger ? await storage.getUser(challenge.challenger) : null;
    const challengedUser = challenge.challenged ? await storage.getUser(challenge.challenged) : null;
    const tryManagedOnchainSettlement = async (
      challengeLike: typeof challenge,
      settledResult: "challenger_won" | "challenged_won" | "draw",
    ) => {
      const isEligible =
        String(challengeLike.settlementRail || "").toLowerCase() === "onchain" &&
        ONCHAIN_CONFIG.contractEnabled &&
        !challengeLike.adminCreated;
      if (!isEligible) return null;

      const chainId = Number(
        challengeLike.chainId || ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId,
      );
      const chainConfig =
        ONCHAIN_CONFIG.chains[String(chainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.chainId)];
      if (!chainConfig || chainConfig.escrowSupportsChallengeLock !== true) return null;

      const configuredEscrowContract = normalizeEvmAddress(chainConfig.escrowContractAddress);
      if (!configuredEscrowContract) return null;

      const escrowRuntime = await resolveChallengeEscrowRuntime({
        challengeLike,
        chain: chainConfig,
      });
      if (
        !escrowRuntime.escrowContractAddress ||
        escrowRuntime.escrowContractAddress !== configuredEscrowContract
      ) {
        return null;
      }
      if (!escrowRuntime.challengerWallet || !escrowRuntime.challengedWallet) {
        throw new Error("Unable to resolve participant wallets for managed onchain payout");
      }

      return await executeManagedChallengeSettlement({
        challengeLike,
        chain: chainConfig,
        tokenSymbol: normalizeOnchainTokenSymbol(
          challengeLike.tokenSymbol || ONCHAIN_CONFIG.defaultToken,
        ) as OnchainTokenSymbol,
        result: settledResult,
        escrowContractAddress: configuredEscrowContract,
        challengerWallet: escrowRuntime.challengerWallet,
        challengedWallet: escrowRuntime.challengedWallet,
      });
    };

    const applyAgentChallengeOutcomeStats = async (
      challengeLike: typeof challenge,
      settledResult: "challenger_won" | "challenged_won" | "draw",
    ) => {
      if (settledResult === "draw" || !challengeLike.agentInvolved) {
        return {
          winnerAgentId: null as string | null,
          loserAgentId: null as string | null,
          winnerPreviousRank: null as number | null,
          loserPreviousRank: null as number | null,
        };
      }

      const winnerAgentId =
        settledResult === "challenger_won"
          ? challengeLike.challengerAgentId
          : challengeLike.challengedAgentId;
      const loserAgentId =
        settledResult === "challenger_won"
          ? challengeLike.challengedAgentId
          : challengeLike.challengerAgentId;

      const [winnerRankSnapshot, loserRankSnapshot] = await Promise.all([
        winnerAgentId ? getAgentRankSnapshot(winnerAgentId) : Promise.resolve(null),
        loserAgentId ? getAgentRankSnapshot(loserAgentId) : Promise.resolve(null),
      ]);

      const updates: Promise<any>[] = [];
      if (winnerAgentId) {
        updates.push(storage.recordAgentChallengeOutcome(winnerAgentId, "win"));
      }
      if (loserAgentId) {
        updates.push(storage.recordAgentChallengeOutcome(loserAgentId, "loss"));
      }
      if (updates.length > 0) {
        await Promise.all(updates);
      }

      return {
        winnerAgentId: winnerAgentId ?? null,
        loserAgentId: loserAgentId ?? null,
        winnerPreviousRank: winnerRankSnapshot?.rank ?? null,
        loserPreviousRank: loserRankSnapshot?.rank ?? null,
      };
    };

    const notifyAgentOwnersOfOutcome = async (
      challengeLike: typeof challenge,
      settledResult: "challenger_won" | "challenged_won" | "draw",
      rankContext?: {
        winnerAgentId: string | null;
        loserAgentId: string | null;
        winnerPreviousRank: number | null;
        loserPreviousRank: number | null;
      },
    ) => {
      if (settledResult === "draw" || !challengeLike.agentInvolved) return;

      const winnerAgentId =
        rankContext?.winnerAgentId ??
        (settledResult === "challenger_won"
          ? challengeLike.challengerAgentId
          : challengeLike.challengedAgentId);
      const loserAgentId =
        rankContext?.loserAgentId ??
        (settledResult === "challenger_won"
          ? challengeLike.challengedAgentId
          : challengeLike.challengerAgentId);

      const winnerAgent = winnerAgentId ? await storage.getAgentById(winnerAgentId) : undefined;
      const loserAgent = loserAgentId ? await storage.getAgentById(loserAgentId) : undefined;

      if (winnerAgent) {
        await createAndPushAgentOwnerNotification(winnerAgent, {
          type: "agent_challenge_won",
          title: "Agent won a market",
          message: `${winnerAgent.agentName} won "${challengeLike.title}".`,
          data: {
            challengeId: challengeLike.id,
            result: settledResult,
          },
          priority: 3,
          fomoLevel: "high",
        });
        await createAndPushAgentOwnerNotification(winnerAgent, {
          type: "agent_points_earned",
          title: "Agent earned BantCredit",
          message: `${winnerAgent.agentName} earned +${AGENT_WIN_BANTCREDIT_REWARD} BantCredit from "${challengeLike.title}".`,
          data: {
            challengeId: challengeLike.id,
            pointsAwarded: AGENT_WIN_BANTCREDIT_REWARD,
            result: settledResult,
          },
          priority: 2,
          fomoLevel: "medium",
        });
        await notifyAgentRankChangeIfNeeded(
          winnerAgent.agentId,
          rankContext?.winnerPreviousRank ?? null,
          "market_won",
          { challengeId: challengeLike.id, result: settledResult },
        );
      }

      if (loserAgent) {
        await createAndPushAgentOwnerNotification(loserAgent, {
          type: "agent_challenge_lost",
          title: "Agent lost a market",
          message: `${loserAgent.agentName} lost "${challengeLike.title}".`,
          data: {
            challengeId: challengeLike.id,
            result: settledResult,
          },
          priority: 2,
          fomoLevel: "medium",
        });
        await notifyAgentRankChangeIfNeeded(
          loserAgent.agentId,
          rankContext?.loserPreviousRank ?? null,
          "market_lost",
          { challengeId: challengeLike.id, result: settledResult },
        );
      }
    };

    if (result === "draw") {
      const drawMessage = `Challenge "${challenge.title}" ended in a draw. Your stake has been returned to your wallet.`;
      const managedDrawSettlement = await tryManagedOnchainSettlement(challenge, result);

      if (managedDrawSettlement) {
        if (challenge.challenger) {
          await storage.createNotification({
            userId: challenge.challenger,
            type: "challenge_draw",
            title: "🤝 Challenge Draw",
            message: drawMessage,
            data: {
              challengeId: challenge.id,
              title: challenge.title,
              result: "draw",
              payoutTxHash: managedDrawSettlement.payoutTxHash,
            },
          } as any);
        }

        if (challenge.challenged) {
          await storage.createNotification({
            userId: challenge.challenged,
            type: "challenge_draw",
            title: "🤝 Challenge Draw",
            message: drawMessage,
            data: {
              challengeId: challenge.id,
              title: challenge.title,
              result: "draw",
              payoutTxHash: managedDrawSettlement.payoutTxHash,
            },
          } as any);
        }

        return {
          challenge,
          payoutJobId: null,
          partnerSettlement: null,
          message: `Challenge result set to draw. Onchain refund sent via ${managedDrawSettlement.method}.`,
        };
      }

      // Draw refund flow for market-style/admin challenges:
      // refund all active queue stakes (both waiting and matched).
      const queueEntries = await db
        .select({
          userId: pairQueue.userId,
          stakeAmount: pairQueue.stakeAmount,
          status: pairQueue.status,
        })
        .from(pairQueue)
        .where(eq(pairQueue.challengeId, challengeId as any));

      const refundableByUser = new Map<string, number>();
      for (const entry of queueEntries) {
        if (entry.status !== "waiting" && entry.status !== "matched") continue;
        const stake = Number(entry.stakeAmount || 0);
        if (!entry.userId || stake <= 0) continue;
        refundableByUser.set(entry.userId, (refundableByUser.get(entry.userId) || 0) + stake);
      }

      if (refundableByUser.size > 0) {
        for (const [userId, refundAmount] of refundableByUser.entries()) {
          await storage.updateUserBalance(userId, refundAmount);
          await storage.createTransaction({
            userId,
            type: "challenge_draw_refund",
            amount: refundAmount.toString(),
            description: `Draw refund for challenge "${challenge.title}"`,
            relatedId: challenge.id,
            status: "completed",
            reference: `challenge_${challenge.id}_draw_refund_${userId}`,
          } as any);

          await storage.createNotification({
            userId,
            type: "challenge_draw",
            title: "🤝 Challenge Draw",
            message: drawMessage,
            data: {
              challengeId: challenge.id,
              title: challenge.title,
              result: "draw",
              refundAmount,
            },
          } as any);
        }

        // Mark queue entries closed after refund
        await db
          .update(pairQueue)
          .set({ status: "cancelled" as any })
          .where(eq(pairQueue.challengeId, challengeId as any));
      } else {
        // Fallback for legacy/direct two-party challenges.
        if (challenge.challenger) {
          await storage.updateUserBalance(challenge.challenger, Number(challenge.amount || 0));
          await storage.createTransaction({
            userId: challenge.challenger,
            type: "challenge_draw",
            amount: Number(challenge.amount || 0).toString(),
            description: `Draw in challenge: ${challenge.title}`,
            relatedId: challenge.id,
            status: "completed",
            reference: `challenge_${challenge.id}_draw_challenger`,
          } as any);

          await storage.createNotification({
            userId: challenge.challenger,
            type: "challenge_draw",
            title: "🤝 Challenge Draw",
            message: drawMessage,
            data: {
              challengeId: challenge.id,
              title: challenge.title,
              result: "draw",
            },
          } as any);
        }

        if (challenge.challenged) {
          await storage.updateUserBalance(challenge.challenged, Number(challenge.amount || 0));
          await storage.createTransaction({
            userId: challenge.challenged,
            type: "challenge_draw",
            amount: Number(challenge.amount || 0).toString(),
            description: `Draw in challenge: ${challenge.title}`,
            relatedId: challenge.id,
            status: "completed",
            reference: `challenge_${challenge.id}_draw_challenged`,
          } as any);

          await storage.createNotification({
            userId: challenge.challenged,
            type: "challenge_draw",
            title: "🤝 Challenge Draw",
            message: drawMessage,
            data: {
              challengeId: challenge.id,
              title: challenge.title,
              result: "draw",
            },
          } as any);
        }
      }

      return {
        challenge,
        payoutJobId: null,
        partnerSettlement: null,
        message: "Challenge result set to draw. Stakes have been returned to participants.",
      };
    }

    const winnerId = result === "challenger_won" ? challenge.challenger : challenge.challenged;
    const loserId = result === "challenger_won" ? challenge.challenged : challenge.challenger;
    const winnerUser = result === "challenger_won" ? challengerUser : challengedUser;
    const loserUser = result === "challenger_won" ? challengedUser : challengerUser;

    if (winnerId && winnerUser) {
      await storage.createNotification({
        userId: winnerId,
        type: "challenge_won",
        title: "🏆 You Won!",
        message: `Congratulations! You won the challenge "${challenge.title}". Your payout is being processed.`,
        data: {
          challengeId: challenge.id,
          title: challenge.title,
          result,
        },
      } as any);
    }

    if (loserId && loserUser) {
      await storage.createNotification({
        userId: loserId,
        type: "challenge_lost",
        title: "❌ Challenge Lost",
        message: `You didn't win "${challenge.title}". Better luck next time!`,
        data: {
          challengeId: challenge.id,
          title: challenge.title,
          result,
        },
      } as any);
    }

    const agentOutcomeContext = await applyAgentChallengeOutcomeStats(challenge, result);
    await notifyAgentOwnersOfOutcome(challenge, result, agentOutcomeContext);

    try {
      const { challengeNotificationTriggers } = await import("./challengeNotificationTriggers");
      const winningSide = result === "challenger_won" ? "YES" : result === "challenged_won" ? "NO" : "DRAW";
      challengeNotificationTriggers.onChallengeCompleted(String(challenge.id), winningSide).catch((err) => {
        console.error("Error triggering challenge completion notifications:", err);
      });
    } catch (notifErr) {
      console.error("Failed to import challengeNotificationTriggers:", notifErr);
    }

    if (challenge.adminCreated) {
      try {
        const { settleChallengeTreasuryMatches } = await import("./treasurySettlementWorker");
        const challengeResult = result === "challenger_won";
        const settlementResult = await settleChallengeTreasuryMatches(
          challengeId,
          challengeResult,
          resolvedByUserId || undefined,
        );

        if (settlementResult.settled > 0) {
          console.log(
            `✅ Treasury settlement complete: ${settlementResult.settled} matches, Net: ₦${settlementResult.netProfit.toLocaleString()}`,
          );
        }
      } catch (treasuryErr) {
        console.error("Error settling Treasury matches:", treasuryErr);
      }
    }

    const managedWinnerSettlement = await tryManagedOnchainSettlement(challenge, result);
    if (managedWinnerSettlement) {
      let partnerSettlement: any = null;
      try {
        partnerSettlement = await calculatePartnerFeeSettlement(challengeId, resolvedByUserId || null);
      } catch (partnerFeeError) {
        console.error(`Error calculating partner settlement for challenge ${challengeId}:`, partnerFeeError);
      }

      return {
        challenge,
        payoutJobId: null,
        partnerSettlement,
        message: `Challenge result set to ${result}. Onchain payout sent via ${managedWinnerSettlement.method}.`,
      };
    }

    let payoutJobId: string | null = null;
    try {
      const stakers = await db.select().from(pairQueue).where(eq(pairQueue.challengeId, challengeId as any));

      const winners: Array<{ userId: string; amount: bigint }> = [];
      const winningTeam = result === "challenger_won" ? "YES" : "NO";
      let totalWinningStake = 0n;
      let totalLosing = 0n;

      for (const staker of stakers) {
        const stakeAmount = BigInt(staker.stakeAmount || 0);
        if (staker.side === winningTeam && staker.status === "matched") {
          totalWinningStake += stakeAmount;
          winners.push({ userId: staker.userId, amount: stakeAmount });
        } else {
          totalLosing += stakeAmount;
        }
      }

      if (winners.length > 0) {
        const totalPool = totalWinningStake + totalLosing;
        const platformFee = BigInt(Math.floor(Number(totalPool) * 0.05));
        const winnerPool = totalPool - platformFee;

        const amountPerWinner = winnerPool / BigInt(winners.length);
        const remainder = winnerPool % BigInt(winners.length);

        const payoutWinners = winners.map((winner, index) => ({
          userId: winner.userId,
          amount: Number(amountPerWinner + BigInt(index === 0 ? remainder : 0)),
        }));

        payoutJobId = await payoutQueue.createPayoutJob(
          challengeId,
          payoutWinners,
          Number(totalPool),
          Number(platformFee),
        );
        payoutWorker.triggerImmediate(payoutJobId);

        console.log(
          `Created payout job ${payoutJobId} for challenge ${challengeId} with ${payoutWinners.length} winners`,
        );
      }
    } catch (payoutError) {
      console.error(`Error creating payout job for challenge ${challengeId}:`, payoutError);
    }

    let partnerSettlement: any = null;
    try {
      partnerSettlement = await calculatePartnerFeeSettlement(challengeId, resolvedByUserId || null);
    } catch (partnerFeeError) {
      console.error(`Error calculating partner settlement for challenge ${challengeId}:`, partnerFeeError);
    }

    return {
      challenge,
      payoutJobId,
      partnerSettlement,
      message: `Challenge result set to ${result}. Payouts queued for processing.`,
    };
  }

  // Telegram webhook for callback buttons (Phase 2)
  app.post('/api/telegram/webhook', async (req, res) => {
    try {
      const update = req.body;
      console.log('📨 Telegram webhook update:', JSON.stringify(update, null, 2));

      // Handle my_chat_member updates (bot or user status changes in chats)
      if (update.my_chat_member) {
        try {
          const myChat = update.my_chat_member;
          // If bot was added to a group
          if (myChat.new_chat_member && myChat.new_chat_member.status === 'member') {
            const telegramBot = getTelegramBot();
            if (telegramBot) {
              // create a synthetic message object for group
              const fakeMessage = { chat: myChat.chat, from: update.my_chat_member.from };
              await telegramBot.handleGroupJoin(fakeMessage);
            }
          }
        } catch (err) {
          console.error('Error handling my_chat_member:', err);
        }
      }

      // Handle chat_member updates (users joining/leaving)
      if (update.chat_member) {
        try {
          const chatMember = update.chat_member;
          const chat = chatMember.chat;
          const newStatus = chatMember.new_chat_member?.status;
          const user = chatMember.from || chatMember.new_chat_member?.user;
          if (chat && user) {
            const telegramBot = getTelegramBot();
            // Find group record
            const groupRecord = await storage.getGroupByTelegramId(String(chat.id)).catch(() => null);
            if (groupRecord) {
              if (newStatus === 'member') {
                // add member
                await storage.addGroupMember(groupRecord.id, `telegram-${user.id}`, String(user.id), user.username || undefined);
              } else if (newStatus === 'left' || newStatus === 'kicked') {
                await storage.removeGroupMember(groupRecord.id, String(user.id));
              }
            }
          }
        } catch (err) {
          console.error('Error handling chat_member:', err);
        }
      }
      // Handle callback queries (inline button clicks)
      if (update.callback_query) {
        const callbackQuery = update.callback_query;
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;
        const telegramUserId = callbackQuery.from.id;

        console.log(`🔘 Callback button clicked: ${data} by user ${telegramUserId}`);

        // Get user by Telegram ID
        const user = await storage.getUserByTelegramId(telegramUserId.toString());

        if (!user) {
          // User not linked yet
          const telegramBot = getTelegramBot();
          if (telegramBot) {
            await telegramBot.sendErrorMessage(chatId, 'general');
          }
          return res.json({ ok: true });
        }

        // Handle inline 'challenge user' action: challenge_user_<telegramId>
        if (data && data.startsWith && data.startsWith('challenge_user_')) {
          const targetTgId = data.replace('challenge_user_', '');
          try {
            const callerTelegramId = callbackQuery.from.id.toString();
            const callerUser = await storage.getUserByTelegramId(callerTelegramId);
            if (!callerUser) {
              await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                callback_query_id: callbackQuery.id,
                text: 'Please link your Telegram account to Bantah first. Open the mini-app via the bot to link.',
                show_alert: true,
              });
              return res.json({ ok: true });
            }

            const targetUser = await storage.getUserByTelegramId(targetTgId);
            if (!targetUser) {
              await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                callback_query_id: callbackQuery.id,
                text: 'That user has not linked Bantah. Ask them to open the mini-app to accept challenges.',
                show_alert: true,
              });
              return res.json({ ok: true });
            }

            const defaultAmount = parseFloat(process.env.DEFAULT_INLINE_CHALLENGE_AMOUNT || '1000');
            const bal = await storage.getUserBalance(callerUser.id);
            if (bal.balance < defaultAmount) {
              await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                callback_query_id: callbackQuery.id,
                text: `Insufficient balance to create a ₦${defaultAmount} challenge.`,
                show_alert: true,
              });
              return res.json({ ok: true });
            }

            const challengeData = {
              challenger: callerUser.id,
              challenged: targetUser.id,
              title: `Inline challenge: ${callerUser.username || callerUser.firstName || 'Player'}`,
              description: `Challenge created from Telegram chat by @${callerUser.username || callerUser.id}`,
              category: 'inline',
              amount: defaultAmount.toString(),
              dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
            };

            const challenge = await storage.createChallenge(challengeData as any);

            // Post confirmation message with accept/decline buttons
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              chat_id: chatId,
              text: `⚔️ *Challenge Created*\n*${challenge.title}*\nWager: ₦${defaultAmount}\nChallenger: @${callerUser.username || callerUser.id}\nChallenged: @${targetUser.username || targetUser.id}`,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Accept', callback_data: `accept_challenge_${challenge.id}` },
                    { text: '❌ Decline', callback_data: `decline_challenge_${challenge.id}` },
                    { text: '🔍 Open', web_app: { url: `${(process.env.FRONTEND_URL||'http://localhost:5173')}/telegram-mini-app?action=view_challenge&challengeId=${challenge.id}` } }
                  ]
                ]
              }
            });

            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: callbackQuery.id,
              text: '✅ Challenge created and posted to chat',
            });

            return res.json({ ok: true });
          } catch (err: any) {
            console.error('Error handling challenge_user callback:', err);
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: callbackQuery.id,
              text: '❌ Failed to create challenge',
              show_alert: true,
            });
            return res.json({ ok: true });
          }
        }

        // Handle accept challenge
        if (data.startsWith('accept_challenge_')) {
          const challengeId = parseInt(data.replace('accept_challenge_', ''));

          try {
            // Check user balance
            const balance = await storage.getUserBalance(user.id);
            const challenge = await storage.getChallengeById(challengeId);

            if (!challenge) {
              throw new Error('Challenge not found');
            }

            const requiredAmount = parseFloat(challenge.amount);

            if (balance.balance < requiredAmount) {
              // Insufficient funds
              const telegramBot = getTelegramBot();
              if (telegramBot) {
                await telegramBot.sendInsufficientFundsNotification(
                  chatId,
                  requiredAmount,
                  balance.balance
                );
              }
                
              // Get full challenge details
              const fullChallenge = await storage.getChallengeById(challengeId);
              const challenger = await storage.getUser(fullChallenge!.challenger);
              const challenged = await storage.getUser(fullChallenge!.challenged);

              // Send confirmation to both users
              if (telegramBot && challenger && challenged) {
                // Notify challenged user (current user)
                await telegramBot.sendChallengeAcceptedConfirmation(chatId, {
                  id: challengeId,
                  title: fullChallenge!.title,
                  challenger: { name: challenger.firstName || challenger.username || 'Challenger' },
                  challenged: { name: challenged.firstName || challenged.username || 'You' },
                  amount: requiredAmount
                });

                // Notify challenger if they have Telegram linked
                if (challenger.telegramId) {
                  await telegramBot.sendChallengeAcceptedConfirmation(
                    parseInt(challenger.telegramId),
                    {
                      id: challengeId,
                      title: fullChallenge!.title,
                      challenger: { name: 'You' },
                      challenged: { name: challenged.firstName || challenged.username || 'Opponent' },
                      amount: requiredAmount
                    }
                  );
                }
              }
            }

            // Answer callback query to remove loading state
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: callbackQuery.id,
              text: '✅ Processing...'
            });

          } catch (error: any) {
            console.error('Error accepting challenge:', error);
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: callbackQuery.id,
              text: `❌ Error: ${error.message}`,
              show_alert: true
            });
          }
        }

        // Handle decline challenge
        if (data.startsWith('decline_challenge_')) {
          const challengeId = parseInt(data.replace('decline_challenge_', ''));

          try {
            await storage.updateChallenge(challengeId, { status: 'cancelled' });

            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: callbackQuery.id,
              text: '❌ Challenge declined'
            });

            // Send declined message
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              chat_id: chatId,
              text: '❌ *Challenge Declined*\n\nYou have declined this challenge.',
              parse_mode: 'Markdown'
            });

          } catch (error: any) {
            console.error('Error declining challenge:', error);
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: callbackQuery.id,
              text: `❌ Error: ${error.message}`,
              show_alert: true
            });
          }
        }
      }

      // Handle inline queries (group challenges)
      if (update.inline_query) {
        const inlineQuery = update.inline_query;
        const telegramBot = getTelegramBot();
        
        if (telegramBot) {
          await telegramBot.handleInlineQuery(inlineQuery, apiClient);
        }
      }

      // Handle message events (group joins, leave notifications)
      if (update.message) {
        const message = update.message;
        const telegramBot = getTelegramBot();

        // Handle group_chat_created or my_chat_member for group join
        if (message.group_chat_created || message.supergroup_chat_created || (update.my_chat_member && update.my_chat_member.new_chat_member?.status === 'member')) {
          if (telegramBot) {
            await telegramBot.handleGroupJoin(message);
          }
        }
      }

      // Handle chosen inline result (when user selects a challenge)
      if (update.chosen_inline_result) {
        const chosenResult = update.chosen_inline_result;
        const telegramBot = getTelegramBot();

        if (telegramBot) {
          await telegramBot.handleChosenInlineResult(chosenResult, apiClient);
        }
      }

      res.json({ ok: true });
    } catch (error) {
      console.error('❌ Telegram webhook error:', error);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // Auth routes
  app.get('/api/auth/user', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ message: "User ID not found" });
      }
      const user = await storage.getUser(userId);

      // Check and create daily login record
      await storage.checkDailyLogin(userId);

      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // Profile routes
  app.get('/api/profile', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ message: "User ID not found" });
      }
      const user = await storage.getUser(userId);

      // Ensure user has a referral code
      if (!user.referralCode) {
        const referralCode = user.username || `user_${userId.slice(-8)}`;
        await db
          .update(users)
          .set({ 
            referralCode: referralCode,
            updatedAt: new Date()
          })
          .where(eq(users.id, userId));

        user.referralCode = referralCode;
      }

      res.json(user);
    } catch (error) {
      console.error("Error fetching profile:", error);
      res.status(500).json({ message: "Failed to fetch profile" });
    }
  });

  app.put('/api/profile', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user?.id || req.user?.claims?.sub;
      if (!userId) {
        console.error("User ID not found in request:", req.user);
        return res.status(401).json({ message: "User ID not found" });
      }

      const { firstName, username, bio, profileImageUrl } = req.body;

      // Update user profile
      await storage.updateUserProfile(userId, {
        firstName,
        username,
        bio,
        profileImageUrl
      });

      const updatedUser = await storage.getUser(userId);
      res.json(updatedUser);
    } catch (error: any) {
      console.error("Error updating profile:", error);
      // Handle validation-style errors thrown from storage layer
      if (error && error.status === 400) {
        return res.status(400).json({ message: error.message || 'Bad Request' });
      }
      res.status(500).json({ message: "Failed to update profile" });
    }
  });

  app.put('/api/users/me/wallet', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const walletAddress = normalizeEvmAddress(req.body?.walletAddress);
      if (!walletAddress) {
        return res.status(400).json({ message: "Valid walletAddress is required" });
      }

      const currentUser = await storage.getUser(userId);
      if (!currentUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const nextWallets = mergeWalletSet((currentUser as any)?.walletAddresses, walletAddress);
      const updated = await storage.updateUserProfile(userId, {
        primaryWalletAddress: walletAddress,
        walletAddresses: nextWallets,
      } as any);

      res.json({
        success: true,
        primaryWalletAddress: (updated as any)?.primaryWalletAddress || walletAddress,
        walletAddresses: (updated as any)?.walletAddresses || nextWallets,
      });
    } catch (error: any) {
      console.error("Error updating primary wallet address:", error);
      res.status(500).json({ message: error?.message || "Failed to update wallet" });
    }
  });

  // Referral routes
  app.get('/api/referrals', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: "User ID not found" });
      }

      const referrals = await storage.getReferrals(userId);
      res.json(referrals);
    } catch (error) {
      console.error("Error fetching referrals:", error);
      res.status(500).json({ message: "Failed to fetch referrals" });
    }
  });

  app.post('/api/referrals/apply', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { referralCode } = req.body;

      if (!referralCode) {
        return res.status(400).json({ message: "Referral code required" });
      }

      const user = await storage.getUser(userId);
      if (user.referredBy) {
        return res.json({ success: true, message: "User already referred" });
      }

      const referrer = await storage.getUserByReferralCode(referralCode);
      if (!referrer || referrer.id === userId) {
        return res.status(400).json({ message: "Invalid referral code" });
      }

      // Update user to mark them as referred
      await db
        .update(users)
        .set({ referredBy: referrer.id })
        .where(eq(users.id, userId));

      // Process rewards (simplified version of the logic in server/auth.ts)
      const bonusPoints = BANTCREDIT_REFERRED_REWARD;
      const bonusCoins = 0;
      await storage.updateUserPoints(userId, bonusPoints);
      if (bonusCoins > 0) {
        await storage.updateUserCoins(userId, bonusCoins);
      }

      await storage.createNotification({
        userId: userId,
        type: 'referral_success',
        title: '🎁 Referral Bonus Applied!',
        message: `You earned ${bonusPoints} BantCredit from the referral!`,
        data: { points: bonusPoints },
      });

      // Reward the referrer too
      const referrerBonus = BANTCREDIT_REFERRER_REWARD;
      const referrerCoinBonus = 0;
      await storage.updateUserPoints(referrer.id, referrerBonus);
      if (referrerCoinBonus > 0) {
        await storage.updateUserCoins(referrer.id, referrerCoinBonus);
      }

      // Create referral record in database for tracking
      await storage.createReferral({
        referrerId: referrer.id,
        referredId: userId,
        code: referralCode,
        status: 'active',
      });

      // Create transaction records for both users
      await storage.createTransaction({
        userId: userId,
        type: 'referral_bonus',
        amount: bonusPoints.toString(),
        description: `Referral signup bonus (Code: ${referralCode})`,
        status: 'completed',
      });

      await storage.createTransaction({
        userId: referrer.id,
        type: 'referral_reward',
        amount: referrerBonus.toString(),
        description: `Referral reward for ${user.username || 'new user'}`,
        status: 'completed',
      });

      await storage.createNotification({
        userId: referrer.id,
        type: 'referral_success',
        title: '🎉 Referral Success!',
        message: `${user.username || 'A new user'} joined using your code! You earned ${referrerBonus} BantCredit.`,
        data: { points: referrerBonus },
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error applying referral:", error);
      res.status(500).json({ message: "Failed to apply referral" });
    }
  });

  // Event routes
  app.get('/api/events', async (req, res) => {
    try {
      const events = await storage.getEvents(20);
      res.json(events);
    } catch (error) {
      console.error("Error fetching events:", error);
      res.status(500).json({ message: "Failed to fetch events" });
    }
  });

  app.get('/api/polymarket/markets', async (req, res) => {
    try {
      const limitRaw = Number(req.query.limit ?? 20);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
      const active = String(req.query.active ?? "true") === "false" ? "false" : "true";
      const closed = String(req.query.closed ?? "false") === "true" ? "true" : "false";
      const normalize = String(req.query.normalize ?? "false") === "true";

      const params = new URLSearchParams({
        active,
        closed,
        limit: String(limit),
      });

      const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;
      const response = await axios.get(url, { timeout: 15000 });
      res.setHeader("Cache-Control", "public, max-age=60");
      if (normalize) {
        res.json(normalizePolymarketMarkets(Array.isArray(response.data) ? response.data : []));
      } else {
        res.json(response.data);
      }
    } catch (error) {
      console.error("Error fetching Polymarket markets:", error);
      res.status(502).json({ message: "Failed to fetch Polymarket markets" });
    }
  });

  app.get('/api/external/markets', async (req, res) => {
    try {
      const source = String(req.query.source || "polymarket").toLowerCase();
      const limitRaw = Number(req.query.limit ?? 20);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
      const active = String(req.query.active ?? "true") === "false" ? "false" : "true";
      const closed = String(req.query.closed ?? "false") === "true" ? "true" : "false";

      if (source !== "polymarket") {
        return res.status(400).json({ message: "Unsupported market source" });
      }

      const params = new URLSearchParams({
        active,
        closed,
        limit: String(limit),
      });

      const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;
      const response = await axios.get(url, { timeout: 15000 });
      const normalized: ExternalMarket[] = normalizePolymarketMarkets(
        Array.isArray(response.data) ? response.data : [],
      );
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(normalized);
    } catch (error) {
      console.error("Error fetching external markets:", error);
      res.status(502).json({ message: "Failed to fetch external markets" });
    }
  });

  app.post('/api/polymarket/challenges/ensure', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const marketId = String(req.body?.marketId || "").trim();
      const question = String(req.body?.question || "").trim();
      const stakeAmountRaw = Number.parseInt(String(req.body?.stakeAmount || ""), 10);
      if (!marketId || !question) {
        return res.status(400).json({ message: "marketId and question are required" });
      }
      if (!Number.isFinite(stakeAmountRaw) || stakeAmountRaw <= 0) {
        return res.status(400).json({ message: "stakeAmount must be a positive number" });
      }

      const stakeAmount = Math.floor(stakeAmountRaw);
      const slug = typeof req.body?.slug === "string" ? req.body.slug.trim() : null;
      const sourceUrl = typeof req.body?.sourceUrl === "string" ? req.body.sourceUrl.trim() : null;
      const resolutionSource =
        typeof req.body?.resolutionSource === "string" ? req.body.resolutionSource.trim() : null;
      const endDateRaw = typeof req.body?.endDate === "string" ? req.body.endDate.trim() : "";
      const endDate = endDateRaw ? new Date(endDateRaw) : null;
      const dueDate = endDate && !Number.isNaN(endDate.getTime()) ? endDate : null;
      const coverImageUrl = typeof req.body?.image === "string" ? req.body.image.trim() : null;

      const existing = await db
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.adminCreated, true),
            eq(challenges.category, "polymarket"),
            eq(challenges.amount, stakeAmount),
            eq(challenges.status, "open"),
            sql`(${challenges.evidence} ->> 'source') = 'polymarket'`,
            sql`(${challenges.evidence} ->> 'marketId') = ${marketId}`,
          ),
        )
        .limit(1);

      if (existing?.[0]) {
        return res.json(existing[0]);
      }

      const defaultChainId = Number(
        ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId,
      );
      const chainConfig =
        ONCHAIN_CONFIG.chains[String(defaultChainId)] ||
        Object.values(ONCHAIN_CONFIG.chains)[0];
      if (!chainConfig) {
        return res.status(400).json({ message: "Onchain config unavailable" });
      }

      const tokenSymbol = normalizeOnchainTokenSymbol(
        ONCHAIN_CONFIG.defaultToken || "USDC",
      ) as OnchainTokenSymbol;
      const tokenConfig = chainConfig.tokens[tokenSymbol];
      if (!tokenConfig || !isSupportedOnchainToken(chainConfig, tokenSymbol)) {
        return res.status(400).json({ message: "Unsupported token configuration" });
      }

      const evidence = {
        source: "polymarket",
        marketId,
        slug,
        sourceUrl,
        resolutionSource,
        endDate: endDateRaw || null,
      };

      const challenge = await storage.createAdminChallenge({
        title: question,
        description: null,
        category: "polymarket",
        amount: stakeAmount,
        status: "open",
        dueDate,
        coverImageUrl,
        settlementRail: "onchain",
        chainId: chainConfig.chainId,
        tokenSymbol,
        tokenAddress: tokenConfig.isNative ? null : tokenConfig.address,
        decimals: tokenConfig.decimals,
        stakeAtomic: toAtomicUnits(stakeAmount, tokenConfig.decimals),
        evidence,
      });

      res.json(challenge);
    } catch (error: any) {
      console.error("Error ensuring Polymarket challenge:", error);
      res.status(500).json({ message: error?.message || "Failed to prepare challenge" });
    }
  });

  // Groups listing
  app.get('/api/groups', async (_req, res) => {
    try {
      const groupsList = await db.select().from(groups).orderBy(desc(groups.addedAt));
      res.json(groupsList);
    } catch (err) {
      console.error('Error fetching groups:', err);
      res.status(500).json({ message: 'Failed to fetch groups' });
    }
  });

  // Get members for a group
  app.get('/api/groups/:id/members', async (req, res) => {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (isNaN(groupId)) return res.status(400).json({ message: 'Invalid group id' });
      const members = await storage.getGroupMembers(groupId);
      res.json(members || []);
    } catch (err) {
      console.error('Error fetching group members:', err);
      res.status(500).json({ message: 'Failed to fetch group members' });
    }
  });

  // Partner signup applications (public intake + admin review)
  app.post('/api/partners/signup-cover-upload', async (req, res, next) => {
    try {
      if (!upload || typeof upload.single !== "function") {
        return res.status(500).json({ message: "Upload middleware unavailable" });
      }
      return upload.single("image")(req, res, next);
    } catch (error) {
      return next(error);
    }
  }, async (req, res) => {
    try {
      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ message: "No image file provided" });
      }

      const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
      if (!allowedTypes.includes(String(file.mimetype || "").toLowerCase())) {
        return res.status(400).json({ message: "Invalid file type. Upload JPEG, PNG, GIF, or WebP." });
      }

      const maxSize = 8 * 1024 * 1024;
      if (Number(file.size || 0) > maxSize) {
        return res.status(400).json({ message: "File too large. Maximum size is 8MB." });
      }

      const stored = await storeUploadedImage(file, {
        prefix: "partner-cover",
      });

      return res.json({
        success: true,
        imageUrl: stored.imageUrl,
        filename: stored.filename,
      });
    } catch (error) {
      console.error("Error uploading partner signup cover image:", error);
      return res.status(500).json({ message: "Failed to upload cover image" });
    }
  });

  app.post('/api/partners/signup-applications', async (req, res) => {
    try {
      const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const communityName = typeof req.body?.communityName === "string" ? req.body.communityName.trim() : "";
      const roleTitle = typeof req.body?.roleTitle === "string" ? req.body.roleTitle : null;
      const phone = typeof req.body?.phone === "string" ? req.body.phone : null;
      const telegramHandle = typeof req.body?.telegramHandle === "string" ? req.body.telegramHandle : null;
      const website = typeof req.body?.website === "string" ? req.body.website : null;
      const communityCoverImageUrlRaw = typeof req.body?.communityCoverImageUrl === "string"
        ? req.body.communityCoverImageUrl.trim()
        : "";
      const socialLinks = parseCommunitySocialLinks(req.body?.socialLinks);
      const notes = typeof req.body?.notes === "string" ? req.body.notes : null;
      const communityCoverImageUrl = communityCoverImageUrlRaw
        ? normalizeCommunityCoverImageUrl(communityCoverImageUrlRaw)
        : null;

      if (!fullName || fullName.length < 2) {
        return res.status(400).json({ message: "Full name must be at least 2 characters" });
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: "Valid email is required" });
      }
      if (!communityName || communityName.length < 2) {
        return res.status(400).json({ message: "Community name must be at least 2 characters" });
      }
      if (!socialLinks) {
        return res.status(400).json({ message: "At least one valid community social link is required (Facebook, X/Twitter, Instagram, TikTok, YouTube)." });
      }
      if (communityCoverImageUrlRaw && !communityCoverImageUrl) {
        return res.status(400).json({ message: "Community cover art must be an uploaded image path or a valid http/https URL" });
      }
      if (notes && notes.length > 2000) {
        return res.status(400).json({ message: "Notes are too long (max 2000 chars)" });
      }

      const requestedByUserId = await getOptionalPrivyUserId(req);

      const created = await createPartnerSignupApplication({
        fullName,
        email,
        communityName,
        roleTitle,
        phone,
        telegramHandle,
        website,
        communityCoverImageUrl,
        socialLinks,
        notes,
        requestedByUserId,
      });

      if (requestedByUserId) {
        try {
          await storage.createNotification({
            userId: requestedByUserId,
            type: "system",
            title: "Partner application submitted",
            message: `Your partner application for "${communityName}" has been received.`,
            data: {
              partnerSignupApplicationId: created.id,
              communityName,
            },
          } as any);
        } catch (notificationError) {
          console.error("Failed to create partner signup notification:", notificationError);
        }
      }

      res.status(201).json({
        application: created,
        message: "Application submitted. Our team will contact you after review.",
      });
    } catch (error: any) {
      console.error("Error creating partner signup application:", error);
      res.status(500).json({ message: error?.message || "Failed to submit partner application" });
    }
  });

  app.get('/api/admin/partners/signup-applications', adminAuth, async (req, res) => {
    try {
      const status = typeof req.query?.status === "string" ? req.query.status : null;
      const limit = Number(req.query?.limit || 100);
      const rows = await listPartnerSignupApplications(limit, status);
      res.json(rows);
    } catch (error: any) {
      console.error("Error fetching partner signup applications:", error);
      res.status(500).json({ message: error?.message || "Failed to fetch partner signup applications" });
    }
  });

  app.post('/api/admin/partners/signup-applications/:id/review', adminAuth, async (req, res) => {
    try {
      const applicationId = parseInt(req.params.id, 10);
      if (Number.isNaN(applicationId)) {
        return res.status(400).json({ message: "Invalid application id" });
      }

      const statusRaw = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
      if (!["pending", "reviewing", "approved", "rejected"].includes(statusRaw)) {
        return res.status(400).json({ message: "Invalid status. Use pending|reviewing|approved|rejected" });
      }

      const reviewNote = typeof req.body?.reviewNote === "string" ? req.body.reviewNote : null;
      const reviewedBy = req.user?.id || req.adminUser?.id || "admin";

      const updated = await reviewPartnerSignupApplication({
        applicationId,
        status: statusRaw as any,
        reviewedBy,
        reviewNote,
      });

      if (updated.requestedByUserId) {
        try {
          await storage.createNotification({
            userId: updated.requestedByUserId,
            type: "system",
            title: "Partner application updated",
            message: `Your partner application is now ${updated.status}.`,
            data: {
              partnerSignupApplicationId: updated.id,
              status: updated.status,
            },
          } as any);
        } catch (notificationError) {
          console.error("Failed to create partner signup review notification:", notificationError);
        }
      }

      res.json(updated);
    } catch (error: any) {
      console.error("Error reviewing partner signup application:", error);
      res.status(500).json({ message: error?.message || "Failed to review partner signup application" });
    }
  });

  app.get('/api/admin/partners/programs', adminAuth, async (req, res) => {
    try {
      const adminUserId = req.user?.id || req.adminUser?.id || "admin";
      const programs = await listPartnerProgramsForUser(adminUserId, true);

      const summaries = await Promise.all(
        programs.map(async (program) => {
          const [members, challenges, wallet, pendingWithdrawals] = await Promise.all([
            listPartnerProgramMembers(program.id),
            listPartnerChallenges(program.id, Number(req.query?.challengeLimit || 200)),
            getPartnerWalletSummary(program.id),
            listPendingPartnerWithdrawals(500, program.id),
          ]);

          return {
            ...program,
            memberCount: members.length,
            challengeCount: challenges.length,
            activeChallengeCount: challenges.filter((item) => item.challenge?.status === "open" || item.challenge?.status === "active").length,
            pendingSettlementCount: challenges.filter((item) => item.settlementStatus !== "settled").length,
            pendingWithdrawalsCount: pendingWithdrawals.length,
            wallet,
          };
        }),
      );

      res.json(summaries);
    } catch (error: any) {
      console.error("Error fetching admin partner programs:", error);
      res.status(500).json({ message: error?.message || "Failed to fetch partner programs" });
    }
  });

  app.get('/api/admin/partners/programs/:id', adminAuth, async (req, res) => {
    try {
      const programId = parseInt(req.params.id, 10);
      if (Number.isNaN(programId)) {
        return res.status(400).json({ message: "Invalid program id" });
      }

      const program = await getPartnerProgramById(programId);
      if (!program) {
        return res.status(404).json({ message: "Partner program not found" });
      }

      const [members, challenges, wallet, withdrawals, pendingWithdrawals] = await Promise.all([
        listPartnerProgramMembers(programId),
        listPartnerChallenges(programId, Number(req.query?.challengeLimit || 200)),
        getPartnerWalletSummary(programId),
        listPartnerWithdrawals(programId, Number(req.query?.withdrawalLimit || 100)),
        listPendingPartnerWithdrawals(500, programId),
      ]);

      res.json({
        program,
        members,
        challenges,
        wallet,
        withdrawals,
        pendingWithdrawals,
      });
    } catch (error: any) {
      console.error("Error fetching admin partner program detail:", error);
      res.status(500).json({ message: error?.message || "Failed to fetch partner program details" });
    }
  });

  app.get('/api/admin/partners/withdrawals/pending', adminAuth, async (req, res) => {
    try {
      const programIdRaw = req.query.programId;
      const parsedProgramId = typeof programIdRaw === "string" && programIdRaw.trim()
        ? parseInt(programIdRaw, 10)
        : null;
      if (parsedProgramId !== null && Number.isNaN(parsedProgramId)) {
        return res.status(400).json({ message: "Invalid programId" });
      }

      const rows = await listPendingPartnerWithdrawals(
        Number(req.query.limit || 100),
        parsedProgramId,
      );
      res.json(rows);
    } catch (error: any) {
      console.error("Error fetching admin pending partner withdrawals:", error);
      res.status(500).json({ message: error?.message || "Failed to fetch pending partner withdrawals" });
    }
  });

  app.post('/api/admin/partners/withdrawals/:id/decision', adminAuth, async (req, res) => {
    try {
      const withdrawalId = parseInt(req.params.id, 10);
      if (Number.isNaN(withdrawalId)) {
        return res.status(400).json({ message: "Invalid withdrawal id" });
      }

      const action = typeof req.body?.action === "string" ? req.body.action.trim().toLowerCase() : "";
      if (action !== "approve" && action !== "reject") {
        return res.status(400).json({ message: "Action must be approve or reject" });
      }

      const decision = await decidePartnerWithdrawal({
        withdrawalId,
        action: action as "approve" | "reject",
        processedBy: req.user?.id || req.adminUser?.id || "admin",
        reviewNote: typeof req.body?.note === "string" ? req.body.note : null,
      });

      res.json(decision);
    } catch (error: any) {
      console.error("Error processing admin partner withdrawal decision:", error);
      res.status(500).json({ message: error?.message || "Failed to process withdrawal decision" });
    }
  });

  // Public feed for partner/community challenges (admin-style YES/NO cards + community metadata)
  app.get('/api/communities/challenges', async (req, res) => {
    try {
      const limitRaw = Number(req.query?.limit || 60);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 60;

      const communityLinks = await listPublicPartnerChallengeLinks(limit);
      if (!communityLinks.length) {
        return res.json([]);
      }

      const metaByChallengeId = new Map<number, {
        programId: number;
        name: string;
        slug: string;
        logoUrl: string | null;
        badgeText: string | null;
      }>();

      for (const row of communityLinks) {
        if (!row.challengeId) continue;
        metaByChallengeId.set(row.challengeId, {
          programId: row.programId,
          name: row.programName,
          slug: row.programSlug,
          logoUrl: row.programLogoUrl || null,
          badgeText: row.programBadgeText || null,
        });
      }

      const publicFeed = await storage.getPublicAdminChallenges(Math.min(1000, Math.max(36, limit * 2)));
      const filtered = publicFeed
        .filter((challenge: any) => metaByChallengeId.has(Number(challenge.id)))
        .map((challenge: any) => ({
          ...challenge,
          community: metaByChallengeId.get(Number(challenge.id)),
        }))
        .slice(0, limit);

      res.json(filtered);
    } catch (error: any) {
      console.error("Error fetching communities challenges feed:", error);
      res.status(500).json({ message: error?.message || "Failed to fetch communities challenges feed" });
    }
  });

  const PartnerDashboardAccessMiddleware = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const email =
        (typeof req.user?.email === "string" && req.user.email.trim()) ||
        (typeof req.user?.claims?.email === "string" && req.user.claims.email.trim()) ||
        null;

      const access = await getPartnerDashboardAccess({
        userId,
        email,
        isAdmin: isAdminUser,
      });

      if (!access.allowed) {
        return res.status(403).json({
          message: "No partner profile is linked to this account yet.",
          reason: access.reason,
        });
      }

      return next();
    } catch (error: any) {
      console.error("Error checking partner dashboard access:", error);
      return res.status(500).json({ message: error?.message || "Failed to verify partner access" });
    }
  };

  app.get('/api/partners/dashboard-access', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const email =
        (typeof req.user?.email === "string" && req.user.email.trim()) ||
        (typeof req.user?.claims?.email === "string" && req.user.claims.email.trim()) ||
        null;
      const access = await getPartnerDashboardAccess({
        userId,
        email,
        isAdmin: isAdminUser,
      });

      res.json(access);
    } catch (error: any) {
      console.error("Error fetching partner dashboard access:", error);
      res.status(500).json({ message: error?.message || "Failed to fetch partner access status" });
    }
  });

  // Partner programs: access + challenge creation + monitoring
  app.get('/api/partners/programs/me', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const programs = await listPartnerProgramsForUser(userId, isAdminUser);

      const programsWithRole = await Promise.all(
        programs.map(async (program) => {
          const role = await (async () => {
            if (isAdminUser) return "admin";
            if (program.ownerUserId === userId) return "owner";
            const member = await db.execute(sql`
              SELECT role
              FROM partner_program_members
              WHERE program_id = ${program.id}
                AND user_id = ${userId}
                AND status = 'active'
              LIMIT 1
            `);
            return String(member.rows?.[0]?.role || "viewer");
          })();

          return {
            ...program,
            role,
          };
        }),
      );

      res.json(programsWithRole);
    } catch (error) {
      console.error("Error fetching partner programs:", error);
      res.status(500).json({ message: "Failed to fetch partner programs" });
    }
  });

  app.post('/api/partners/programs', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);

      const nameRaw = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const slugRaw = typeof req.body?.slug === "string" ? req.body.slug.trim() : "";
      const feeBpsRaw = Number(req.body?.defaultFeeBps);
      const groupIdRaw = req.body?.groupId;
      const chatMonitorEnabled = req.body?.chatMonitorEnabled !== false;
      const logoUrlRaw = typeof req.body?.logoUrl === "string" ? req.body.logoUrl.trim() : "";
      const badgeTextRaw = typeof req.body?.badgeText === "string" ? req.body.badgeText.trim() : "";

      if (!nameRaw || nameRaw.length < 3) {
        return res.status(400).json({ message: "Program name must be at least 3 characters" });
      }

      const defaultFeeBps = Number.isFinite(feeBpsRaw)
        ? Math.max(0, Math.min(10000, Math.floor(feeBpsRaw)))
        : 1000;

      let groupId: number | null = null;
      if (groupIdRaw !== undefined && groupIdRaw !== null && groupIdRaw !== "") {
        groupId = Number(groupIdRaw);
        if (!Number.isInteger(groupId) || groupId <= 0) {
          return res.status(400).json({ message: "Invalid groupId" });
        }

        const [groupRecord] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
        if (!groupRecord) {
          return res.status(404).json({ message: "Group not found" });
        }

        if (!isAdminUser && groupRecord.addedBy && groupRecord.addedBy !== userId) {
          return res.status(403).json({ message: "Only the group owner can bind this group to a partner program" });
        }
      }

      const program = await createPartnerProgram({
        name: nameRaw,
        slug: slugRaw || nameRaw,
        logoUrl: logoUrlRaw || null,
        badgeText: badgeTextRaw || null,
        ownerUserId: userId,
        groupId,
        defaultFeeBps,
        chatMonitorEnabled,
      });

      res.status(201).json(program);
    } catch (error: any) {
      if (String(error?.message || "").includes("duplicate key value")) {
        return res.status(409).json({ message: "Partner slug already exists. Choose another slug." });
      }
      console.error("Error creating partner program:", error);
      res.status(500).json({ message: error?.message || "Failed to create partner program" });
    }
  });

  app.get('/api/partners/programs/:id/challenges', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const programId = parseInt(req.params.id, 10);
      if (Number.isNaN(programId)) {
        return res.status(400).json({ message: "Invalid program id" });
      }

      const canView = await canViewPartnerProgram(programId, userId, isAdminUser);
      if (!canView) {
        return res.status(403).json({ message: "You do not have access to this partner program" });
      }

      const items = await listPartnerChallenges(programId, Number(req.query.limit || 50));
      res.json(items);
    } catch (error) {
      console.error("Error fetching partner challenges:", error);
      res.status(500).json({ message: "Failed to fetch partner challenges" });
    }
  });

  app.get('/api/partners/programs/:id/members', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const programId = parseInt(req.params.id, 10);
      if (Number.isNaN(programId)) {
        return res.status(400).json({ message: "Invalid program id" });
      }

      const canView = await canViewPartnerProgram(programId, userId, isAdminUser);
      if (!canView) {
        return res.status(403).json({ message: "You do not have access to this partner program" });
      }

      const members = await listPartnerProgramMembers(programId);
      res.json(members);
    } catch (error) {
      console.error("Error fetching partner program members:", error);
      res.status(500).json({ message: "Failed to fetch partner program members" });
    }
  });

  app.post('/api/partners/programs/:id/members', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const programId = parseInt(req.params.id, 10);
      if (Number.isNaN(programId)) {
        return res.status(400).json({ message: "Invalid program id" });
      }

      const program = await getPartnerProgramById(programId);
      if (!program) {
        return res.status(404).json({ message: "Partner program not found" });
      }

      const canManage = await canManagePartnerProgram(programId, userId, isAdminUser);
      if (!canManage) {
        return res.status(403).json({ message: "Only owner/manager can manage members" });
      }

      const targetUserId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
      const roleInput = typeof req.body?.role === "string" ? req.body.role.trim().toLowerCase() : "";
      const allowedRoles: PartnerMemberRole[] = ["owner", "manager", "moderator", "viewer"];
      if (!targetUserId) {
        return res.status(400).json({ message: "Missing userId" });
      }
      if (!allowedRoles.includes(roleInput as PartnerMemberRole)) {
        return res.status(400).json({ message: "Invalid role. Use owner|manager|moderator|viewer" });
      }

      const targetUser = await storage.getUser(targetUserId);
      if (!targetUser) {
        return res.status(404).json({ message: "Target user not found" });
      }

      const member = await upsertPartnerProgramMember({
        programId,
        userId: targetUserId,
        role: roleInput as PartnerMemberRole,
        addedBy: userId,
      });

      res.json({ member });
    } catch (error: any) {
      console.error("Error upserting partner member:", error);
      res.status(500).json({ message: error?.message || "Failed to update partner member" });
    }
  });

  app.post('/api/partners/programs/:id/challenges', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const programId = parseInt(req.params.id, 10);
      if (Number.isNaN(programId)) {
        return res.status(400).json({ message: "Invalid program id" });
      }

      const canManage = await canManagePartnerProgram(programId, userId, isAdminUser);
      if (!canManage) {
        return res.status(403).json({ message: "Only owner/manager can create partner challenges" });
      }

      const program = await getPartnerProgramById(programId);
      if (!program) {
        return res.status(404).json({ message: "Partner program not found" });
      }

      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
      const category = typeof req.body?.category === "string" ? req.body.category.trim() : "general";
      const amount = Number(req.body?.amount);
      const dueDateRaw = req.body?.dueDate;
      const partnerFeeBps = Number(req.body?.partnerFeeBps);

      if (!title || title.length < 3) {
        return res.status(400).json({ message: "Challenge title must be at least 3 characters" });
      }
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ message: "Challenge amount must be a positive integer" });
      }
      if (amount > 1_000_000) {
        return res.status(400).json({ message: "Challenge amount exceeds NGN 1,000,000 max" });
      }

      let dueDate: Date | null = null;
      if (typeof dueDateRaw === "string" && dueDateRaw.trim()) {
        const parsed = new Date(dueDateRaw);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({ message: "Invalid dueDate" });
        }
        dueDate = parsed;
      }

      const challenge = await storage.createAdminChallenge({
        challenger: null,
        challenged: null,
        title,
        description: description || null,
        category,
        amount,
        status: "open",
        adminCreated: true,
        dueDate: dueDate || null,
      } as any);

      const feeBpsToApply = Number.isInteger(partnerFeeBps)
        ? Math.max(0, Math.min(10000, Math.floor(partnerFeeBps)))
        : program.defaultFeeBps;

      const partnerChallenge = await attachChallengeToPartnerProgram({
        programId,
        challengeId: challenge.id,
        partnerFeeBps: feeBpsToApply,
        chatMonitorEnabled: true,
        createdBy: userId,
      });

      try {
        notificationInfrastructure
          .handleChallengeCreated(String(challenge.id), challenge.title, 1, userId)
          .catch((err) => {
            console.error("Failed to trigger partner challenge notifications:", err);
          });
      } catch (err) {
        console.error("Partner challenge notification setup failed:", err);
      }

      res.status(201).json({
        challenge,
        partnerChallenge,
      });
    } catch (error: any) {
      console.error("Error creating partner challenge:", error);
      res.status(500).json({ message: error?.message || "Failed to create partner challenge" });
    }
  });

  app.get('/api/partners/challenges/:id/monitor', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const challengeId = parseInt(req.params.id, 10);
      if (Number.isNaN(challengeId)) {
        return res.status(400).json({ message: "Invalid challenge id" });
      }

      const partnerMeta = await getPartnerChallengeMeta(challengeId);
      if (!partnerMeta) {
        return res.status(404).json({ message: "This challenge is not linked to a partner program" });
      }

      const canView = await canViewPartnerProgram(partnerMeta.programId, userId, isAdminUser);
      if (!canView) {
        return res.status(403).json({ message: "You do not have monitor access for this challenge" });
      }

      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      const [messages, proofs, votes, stateHistory] = await Promise.all([
        storage.getChallengeMessages(challengeId),
        (storage as any).getChallengeProofs ? (storage as any).getChallengeProofs(challengeId) : Promise.resolve([]),
        (storage as any).getChallengVotes ? (storage as any).getChallengVotes(challengeId) : Promise.resolve([]),
        (storage as any).getChallengeStateHistory ? (storage as any).getChallengeStateHistory(challengeId) : Promise.resolve([]),
      ]);

      res.json({
        challenge,
        partnerMeta,
        monitor: {
          chatMonitorEnabled: partnerMeta.chatMonitorEnabled,
          messages,
          proofs,
          votes,
          stateHistory,
        },
      });
    } catch (error) {
      console.error("Error fetching partner challenge monitor data:", error);
      res.status(500).json({ message: "Failed to load challenge monitor data" });
    }
  });

  app.get('/api/partners/challenges/:id/fees', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const challengeId = parseInt(req.params.id, 10);
      if (Number.isNaN(challengeId)) {
        return res.status(400).json({ message: "Invalid challenge id" });
      }

      const partnerMeta = await getPartnerChallengeMeta(challengeId);
      if (!partnerMeta) {
        return res.status(404).json({ message: "This challenge is not linked to a partner program" });
      }

      const canView = await canViewPartnerProgram(partnerMeta.programId, userId, isAdminUser);
      if (!canView) {
        return res.status(403).json({ message: "You do not have access to this challenge fee data" });
      }

      const challenge = await storage.getChallengeById(challengeId);
      const shouldSettleNow = Boolean(challenge?.result);
      const settlement = shouldSettleNow
        ? await calculatePartnerFeeSettlement(challengeId, userId)
        : null;

      res.json({
        challengeId,
        partnerMeta,
        settlement,
        note: shouldSettleNow
          ? "Settlement is based on matched stake pool and current platform fee model."
          : "Settlement is calculated when the challenge result is available.",
      });
    } catch (error: any) {
      console.error("Error fetching partner challenge fee data:", error);
      res.status(500).json({ message: error?.message || "Failed to fetch partner fee data" });
    }
  });

  app.post('/api/partners/challenges/:id/result', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const challengeId = parseInt(req.params.id, 10);
      if (Number.isNaN(challengeId)) {
        return res.status(400).json({ message: "Invalid challenge id" });
      }

      const result = typeof req.body?.result === "string" ? req.body.result.trim() : "";
      if (!["challenger_won", "challenged_won", "draw"].includes(result)) {
        return res.status(400).json({ message: "Invalid result. Must be 'challenger_won', 'challenged_won', or 'draw'" });
      }

      const partnerMeta = await getPartnerChallengeMeta(challengeId);
      if (!partnerMeta) {
        return res.status(404).json({ message: "This challenge is not linked to a partner program" });
      }

      const canManage = await canManagePartnerProgram(partnerMeta.programId, userId, isAdminUser);
      if (!canManage) {
        return res.status(403).json({ message: "Only owner/manager can settle partner challenges" });
      }

      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      if (!challenge.adminCreated) {
        return res.status(400).json({ message: "Only admin-created market challenges can be settled from partner dashboard" });
      }

      if (challenge.result) {
        return res.status(409).json({ message: `Challenge already settled as ${challenge.result}` });
      }

      const outcome = await settleChallengeResultAndQueuePayout({
        challengeId,
        result: result as "challenger_won" | "challenged_won" | "draw",
        resolvedByUserId: userId,
      });

      res.json({
        ...outcome,
        settledBy: "partner",
        partnerProgramId: partnerMeta.programId,
      });
    } catch (error: any) {
      console.error("Error settling partner challenge:", error);
      res.status(500).json({ message: error?.message || "Failed to settle partner challenge" });
    }
  });

  app.get('/api/partners/programs/:id/wallet', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const programId = parseInt(req.params.id, 10);
      if (Number.isNaN(programId)) {
        return res.status(400).json({ message: "Invalid program id" });
      }

      const canView = await canViewPartnerProgram(programId, userId, isAdminUser);
      if (!canView) {
        return res.status(403).json({ message: "You do not have access to this partner wallet" });
      }

      const [wallet, recentTransactions, withdrawals] = await Promise.all([
        getPartnerWalletSummary(programId),
        listPartnerWalletTransactions(programId, Number(req.query.txLimit || 30)),
        listPartnerWithdrawals(programId, Number(req.query.withdrawalLimit || 30)),
      ]);

      res.json({
        programId,
        wallet,
        recentTransactions,
        withdrawals,
      });
    } catch (error: any) {
      console.error("Error fetching partner wallet:", error);
      res.status(500).json({ message: error?.message || "Failed to fetch partner wallet" });
    }
  });

  app.get('/api/partners/programs/:id/withdrawals', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const programId = parseInt(req.params.id, 10);
      if (Number.isNaN(programId)) {
        return res.status(400).json({ message: "Invalid program id" });
      }

      const canView = await canViewPartnerProgram(programId, userId, isAdminUser);
      if (!canView) {
        return res.status(403).json({ message: "You do not have access to these withdrawals" });
      }

      const withdrawals = await listPartnerWithdrawals(programId, Number(req.query.limit || 50));
      res.json(withdrawals);
    } catch (error: any) {
      console.error("Error fetching partner withdrawals:", error);
      res.status(500).json({ message: error?.message || "Failed to fetch partner withdrawals" });
    }
  });

  app.post('/api/partners/programs/:id/withdrawals', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      const programId = parseInt(req.params.id, 10);
      if (Number.isNaN(programId)) {
        return res.status(400).json({ message: "Invalid program id" });
      }

      const canManage = await canManagePartnerProgram(programId, userId, isAdminUser);
      if (!canManage) {
        return res.status(403).json({ message: "Only owner/manager can request partner withdrawals" });
      }

      const amount = Number(req.body?.amount);
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ message: "Withdrawal amount must be a positive integer" });
      }
      if (amount > 1_000_000_000) {
        return res.status(400).json({ message: "Withdrawal amount is too large" });
      }

      const destination = req.body?.destination && typeof req.body.destination === "object"
        ? req.body.destination
        : null;
      const note = typeof req.body?.note === "string" ? req.body.note : null;

      const withdrawal = await createPartnerWithdrawalRequest({
        programId,
        requestedBy: userId,
        amount,
        destination,
        note,
      });
      const wallet = await getPartnerWalletSummary(programId);
      const program = await getPartnerProgramById(programId);

      try {
        await storage.createNotification({
          userId,
          type: 'withdrawal',
          title: 'Partner withdrawal requested',
          message: `Your partner withdrawal request of NGN ${amount.toLocaleString()} has been submitted.`,
          data: {
            withdrawalId: withdrawal.id,
            amount,
            programId,
            source: 'partner_program',
          },
        } as any);

        if (program?.ownerUserId && program.ownerUserId !== userId) {
          await storage.createNotification({
            userId: program.ownerUserId,
            type: 'withdrawal',
            title: 'Partner withdrawal pending review',
            message: `A withdrawal request of NGN ${amount.toLocaleString()} was submitted for ${program.name}.`,
            data: {
              withdrawalId: withdrawal.id,
              amount,
              programId,
              source: 'partner_program',
            },
          } as any);
        }
      } catch (notificationError) {
        console.error("Failed to send partner withdrawal notification:", notificationError);
      }

      res.status(201).json({ withdrawal, wallet });
    } catch (error: any) {
      console.error("Error creating partner withdrawal request:", error);
      res.status(500).json({ message: error?.message || "Failed to create withdrawal request" });
    }
  });

  app.get('/api/partners/admin/withdrawals/pending', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      if (!userId || !isAdminUser) {
        return res.status(403).json({ message: "Admin access required" });
      }

      const programIdRaw = req.query.programId;
      const parsedProgramId = typeof programIdRaw === "string" && programIdRaw.trim()
        ? parseInt(programIdRaw, 10)
        : null;
      if (parsedProgramId !== null && Number.isNaN(parsedProgramId)) {
        return res.status(400).json({ message: "Invalid programId" });
      }

      const rows = await listPendingPartnerWithdrawals(
        Number(req.query.limit || 100),
        parsedProgramId,
      );
      res.json(rows);
    } catch (error: any) {
      console.error("Error fetching pending partner withdrawals:", error);
      res.status(500).json({ message: error?.message || "Failed to fetch pending partner withdrawals" });
    }
  });

  app.post('/api/partners/admin/withdrawals/:id/decision', PrivyAuthMiddleware, PartnerDashboardAccessMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const adminUserId = getUserId(req);
      const isAdminUser = Boolean(req.user?.isAdmin);
      if (!adminUserId || !isAdminUser) {
        return res.status(403).json({ message: "Admin access required" });
      }

      const withdrawalId = parseInt(req.params.id, 10);
      if (Number.isNaN(withdrawalId)) {
        return res.status(400).json({ message: "Invalid withdrawal id" });
      }

      const action = typeof req.body?.action === "string" ? req.body.action.trim().toLowerCase() : "";
      if (action !== "approve" && action !== "reject") {
        return res.status(400).json({ message: "Action must be approve or reject" });
      }

      const reviewNote = typeof req.body?.note === "string" ? req.body.note : null;
      const decision = await decidePartnerWithdrawal({
        withdrawalId,
        action: action as "approve" | "reject",
        processedBy: adminUserId,
        reviewNote,
      });

      const withdrawal = decision.withdrawal;
      const program = await getPartnerProgramById(withdrawal.programId);
      const amount = Number(withdrawal.amount || 0);

      try {
        await storage.createNotification({
          userId: withdrawal.requestedBy,
          type: 'withdrawal',
          title: action === "approve" ? 'Partner withdrawal approved' : 'Partner withdrawal rejected',
          message: action === "approve"
            ? `Your partner withdrawal of NGN ${amount.toLocaleString()} has been approved.`
            : `Your partner withdrawal of NGN ${amount.toLocaleString()} was rejected.`,
          data: {
            withdrawalId: withdrawal.id,
            amount,
            status: withdrawal.status,
            programId: withdrawal.programId,
            source: 'partner_program',
          },
        } as any);

        if (program?.ownerUserId && program.ownerUserId !== withdrawal.requestedBy) {
          await storage.createNotification({
            userId: program.ownerUserId,
            type: 'withdrawal',
            title: action === "approve" ? 'Partner withdrawal approved' : 'Partner withdrawal rejected',
            message: `Withdrawal #${withdrawal.id} for ${program.name} is now ${withdrawal.status}.`,
            data: {
              withdrawalId: withdrawal.id,
              amount,
              status: withdrawal.status,
              programId: withdrawal.programId,
              source: 'partner_program',
            },
          } as any);
        }
      } catch (notificationError) {
        console.error("Failed to send partner withdrawal decision notification:", notificationError);
      }

      res.json(decision);
    } catch (error: any) {
      console.error("Error deciding partner withdrawal:", error);
      res.status(500).json({ message: error?.message || "Failed to process withdrawal decision" });
    }
  });

  // Admin: sync group members when bot is admin (pull group admins and add them)
  app.post('/api/admin/groups/:telegramId/sync', adminAuth, async (req, res) => {
    try {
      const telegramId = req.params.telegramId;
      if (!telegramId) return res.status(400).json({ message: 'Missing telegramId' });

      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) return res.status(500).json({ message: 'Telegram bot token not configured' });

      const base = `https://api.telegram.org/bot${botToken}`;

      // Ensure our group record exists
      let group = await storage.getGroupByTelegramId(String(telegramId));
      if (!group) {
        group = await storage.addGroup(String(telegramId), undefined, undefined, req.user?.id || 'system');
      }

      // Fetch chat administrators (requires bot to be admin in the chat)
      const adminsResp = await axios.get(`${base}/getChatAdministrators`, { params: { chat_id: telegramId } });
      if (!adminsResp.data || !adminsResp.data.ok) {
        return res.status(500).json({ message: 'Failed to fetch chat administrators', detail: adminsResp.data });
      }

      const added: any[] = [];
      for (const admin of adminsResp.data.result || []) {
        try {
          const user = admin.user;
          if (!user) continue;
          const telegramUserId = String(user.id);
          await storage.addGroupMember(group.id, `telegram-${telegramUserId}`, telegramUserId, user.username || undefined);
          added.push({ id: telegramUserId, username: user.username });
        } catch (err) {
          console.warn('Failed adding admin member', err);
        }
      }

      return res.json({ ok: true, added });
    } catch (err) {
      console.error('Error syncing group members:', err);
      res.status(500).json({ message: 'Failed to sync group members' });
    }
  });

  // Test endpoints to simulate Telegram updates for QA
  app.post('/api/test/telegram/inline_query', adminAuth, async (req, res) => {
    try {
      const inlineQuery = req.body.inline_query;
      if (!inlineQuery) return res.status(400).json({ message: 'Missing inline_query in body' });
      const telegramBot = getTelegramBot();
      if (!telegramBot) return res.status(500).json({ message: 'Telegram bot not initialized' });
      // Pass axios as apiClient
      await telegramBot.handleInlineQuery(inlineQuery, axios);
      res.json({ ok: true });
    } catch (err) {
      console.error('Error in test inline_query:', err);
      res.status(500).json({ message: 'Failed to simulate inline_query' });
    }
  });

  app.post('/api/test/telegram/callback', adminAuth, async (req, res) => {
    try {
      const callbackQuery = req.body.callback_query;
      if (!callbackQuery) return res.status(400).json({ message: 'Missing callback_query in body' });

      // Reuse the same logic as webhook for callback_query handling
      const chatId = callbackQuery.message?.chat?.id;
      const data = callbackQuery.data;
      const telegramUserId = callbackQuery.from?.id;

      const user = await storage.getUserByTelegramId(String(telegramUserId));
      if (!user) return res.status(400).json({ message: 'Telegram user not linked to a Bantah user' });

      // Basic challenge_user_ flow for QA
      if (data && data.startsWith && data.startsWith('challenge_user_')) {
        const targetTgId = data.replace('challenge_user_', '');
        const callerUser = user;
        const targetUser = await storage.getUserByTelegramId(targetTgId);
        if (!targetUser) return res.status(400).json({ message: 'Target user not linked' });

        const defaultAmount = parseFloat(process.env.DEFAULT_INLINE_CHALLENGE_AMOUNT || '1000');
        const challengeData = {
          challenger: callerUser.id,
          challenged: targetUser.id,
          title: `Inline challenge: ${callerUser.username || callerUser.firstName || 'Player'}`,
          description: `Challenge created from Telegram chat by @${callerUser.username || callerUser.id}`,
          category: 'inline',
          amount: defaultAmount.toString(),
          dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        };

        const challenge = await storage.createChallenge(challengeData as any);

        // For QA, return the challenge object instead of calling Telegram
        return res.json({ ok: true, challenge });
      }

      res.json({ ok: true, note: 'callback processed (no action taken)' });
    } catch (err) {
      console.error('Error in test callback:', err);
      res.status(500).json({ message: 'Failed to simulate callback_query' });
    }
  });

  // Admin: set webhook and allowed_updates for Bot (deploy webhook)
  app.post('/api/admin/telegram/set-webhook', adminAuth, async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ message: 'Missing url in body' });
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) return res.status(500).json({ message: 'Telegram bot token not configured' });
      const base = `https://api.telegram.org/bot${botToken}`;

      const allowed_updates = [
        'message',
        'inline_query',
        'chosen_inline_result',
        'callback_query',
        'my_chat_member',
        'chat_member'
      ];

      const resp = await axios.post(`${base}/setWebhook`, { url, allowed_updates });
      if (!resp.data || !resp.data.ok) {
        return res.status(500).json({ message: 'Failed to set webhook', detail: resp.data });
      }

      return res.json({ ok: true, result: resp.data.result });
    } catch (err) {
      console.error('Error setting webhook:', err);
      res.status(500).json({ message: 'Failed to set webhook' });
    }
  });

  // Social Event Recommendation Engine Endpoints
  app.get('/api/recommendations/events', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.id;
      const limit = parseInt(req.query.limit as string) || 10;
      const recommendations = await recommendationEngine.getRecommendedEvents(userId, limit);
      res.json(recommendations);
    } catch (error) {
      console.error("Error getting event recommendations:", error);
      res.status(500).json({ message: "Failed to get recommendations" });
    }
  });

  app.get('/api/recommendations/trending', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 5;
      const trending = await recommendationEngine.getTrendingEvents(limit);
      res.json(trending);
    } catch (error) {
      console.error("Error getting trending events:", error);
      res.status(500).json({ message: "Failed to get trending events" });
    }
  });

  app.get('/api/recommendations/similar/:eventId', async (req, res) => {
    try {
      const eventId = parseInt(req.params.eventId);
      const limit = parseInt(req.query.limit as string) || 5;
      const similar = await recommendationEngine.getSimilarEvents(eventId, limit);
      res.json(similar);
    } catch (error) {
      console.error("Error getting similar events:", error);
      res.status(500).json({ message: "Failed to get similar events" });
    }
  });

  app.get('/api/recommendations/preferences', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.id;
      const preferences = await recommendationEngine.calculateUserPreferences(userId);
      res.json(preferences);
    } catch (error) {
      console.error("Error getting user preferences:", error);
      res.status(500).json({ message: "Failed to get user preferences" });
    }
  });

  app.get('/api/events/:id', async (req, res) => {
    try {
      const event = await storage.getEventById(parseInt(req.params.id));
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      res.json(event);
    } catch (error) {
      console.error("Error fetching event:", error);
      res.status(500).json({ message: "Failed to fetch event" });
    }
  });

  app.post('/api/events', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user?.id || req.user?.claims?.sub;
      console.log("Creating event with data:", req.body);
      console.log("User ID:", userId);

      // Validate required fields
      if (!req.body.title || !req.body.category || !req.body.entryFee || !req.body.endDate) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Convert entryFee to proper integer format (coins)
      const entryFee = parseInt(req.body.entryFee);
      if (isNaN(entryFee) || entryFee <= 0) {
        return res.status(400).json({ message: "Invalid entry fee" });
      }

      // Validate end date
      const endDate = new Date(req.body.endDate);
      if (endDate <= new Date()) {
        return res.status(400).json({ message: "End date must be in the future" });
      }

      const categoryIconAssets = new Set([
        "/assets/cryptosvg.svg",
        "/assets/sportscon.svg",
        "/assets/poltiii.svg",
        "/assets/popcorn.svg",
        "/assets/gamessvg.svg",
        "/assets/news.svg",
        "/assets/eventssvg.svg",
      ]);
      const rawBanner = String(req.body.bannerUrl || req.body.imageUrl || "").trim();
      const normalizedBanner = rawBanner
        ? rawBanner.startsWith("http") || rawBanner.startsWith("data:")
          ? rawBanner
          : rawBanner.startsWith("/")
            ? rawBanner
            : `/${rawBanner}`
        : "";
      const sanitizedBanner =
        normalizedBanner && !categoryIconAssets.has(normalizedBanner)
          ? normalizedBanner
          : null;

      const eventData = {
        title: req.body.title,
        description: req.body.description || null,
        category: req.body.category,
        entryFee: entryFee,
        endDate: endDate,
        creatorId: userId,
        status: 'active',
        isPrivate: req.body.isPrivate || false,
        maxParticipants: req.body.maxParticipants || 100,
        imageUrl: sanitizedBanner,
      };

      console.log("Parsed event data:", eventData);

      const event = await storage.createEvent(eventData);
      console.log("Created event:", event);

      // Get creator info for Telegram broadcast
      const creator = await storage.getUser(userId);

      // Broadcast to Telegram channel
      const telegramBot = getTelegramBot();
      if (telegramBot && creator) {
        try {
          await telegramBot.broadcastEvent({
            id: event.id,
            title: event.title,
            description: event.description || undefined,
            creator: {
              name: creator.firstName || creator.username || 'Unknown',
              username: creator.username || undefined,
            },
            entryFee: event.entryFee,
            endDate: event.endDate,
            is_private: event.isPrivate,
            max_participants: event.maxParticipants,
            category: event.category,
          });
          console.log("📤 Event broadcasted to Telegram successfully");
        } catch (error) {
          console.error("❌ Failed to broadcast event to Telegram:", error);
        }
      }

      res.json(event);
    } catch (error) {
      console.error("Error creating event:", error);
      if (error instanceof Error) {
        res.status(500).json({ message: error.message });
      } else {
        res.status(500).json({ message: "Failed to create event" });
      }
    }
  });

  // Edit event endpoint
  app.put('/api/events/:id', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const userId = req.user?.id || req.user?.claims?.sub;

      // Check if event exists and user is the creator
      const event = await storage.getEventById(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (event.creatorId !== userId) {
        return res.status(403).json({ message: "Only the event creator can edit this event" });
      }

      // Check if event can still be edited (hasn't started yet)
      const now = new Date();
      const endDate = new Date(event.endDate);
      if (now >= endDate) {
        return res.status(400).json({ message: "Cannot edit event that has already ended" });
      }

      // Validate required fields
      if (!req.body.title || !req.body.category || !req.body.entryFee || !req.body.endDate) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Convert entryFee to proper integer format
      const entryFee = parseInt(req.body.entryFee);
      if (isNaN(entryFee) || entryFee <= 0) {
        return res.status(400).json({ message: "Invalid entry fee" });
      }

      // Validate end date
      const newEndDate = new Date(req.body.endDate);
      if (newEndDate <= new Date()) {
        return res.status(400).json({ message: "End date must be in the future" });
      }

      const updates = {
        title: req.body.title,
        description: req.body.description || null,
        category: req.body.category,
        entryFee: entryFee,
        endDate: newEndDate,
      };

      const updatedEvent = await storage.updateEvent(eventId, updates);
      res.json(updatedEvent);
    } catch (error) {
      console.error("Error updating event:", error);
      res.status(500).json({ message: "Failed to update event" });
    }
  });

  app.post('/api/events/:id/leave', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const userId = getUserId(req);

      // Check if user has joined the event
      const participant = await db
        .select()
        .from(eventParticipants)
        .where(and(
          eq(eventParticipants.eventId, eventId),
          eq(eventParticipants.userId, userId)
        ))
        .limit(1);

      if (participant.length === 0) {
        return res.status(400).json({ message: "You haven't joined this event" });
      }

      // Check if user has bet (prevent leaving if they have bet)
      if (participant[0].prediction !== null) {
        return res.status(400).json({ message: "Cannot leave event after placing a bet" });
      }

      // Remove participant
      await db
        .delete(eventParticipants)
        .where(and(
          eq(eventParticipants.eventId, eventId),
          eq(eventParticipants.userId, userId)
        ));

      res.json({ message: "Successfully left the event" });
    } catch (error) {
      console.error("Error leaving event:", error);
      res.status(500).json({ message: "Failed to leave event" });
    }
  });

  app.post('/api/events/:id/join', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user?.id || req.user?.claims?.sub;
      const eventId = parseInt(req.params.id);
      const { prediction } = req.body;

      const event = await storage.getEventById(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      // Always use the event's entry fee (fixed model) - now in coins
      const amount = parseInt(event.entryFee.toString());

      // Check user coin balance
      const balance = await storage.getUserBalance(userId);
      const userCoins = balance.coins || 0;
      if (userCoins < amount) {
        return res.status(400).json({ message: "Insufficient coins" });
      }

      // Check if event is private
      if (event.isPrivate) {
        // Create join request for private events
        const joinRequest = await storage.requestEventJoin(eventId, userId, prediction, amount);

        // Create notification for event creator
        await storage.createNotification({
          userId: event.creatorId,
          type: 'event_join_request',
          title: 'New Event Join Request',
          message: `${req.user.claims.first_name || 'Someone'} wants to join your private event: ${event.title}`,
          data: { eventId: eventId, requestId: joinRequest.id },
        });

        // Create notification for user about pending request
        await storage.createNotification({
          userId,
          type: 'event_join_pending',
          title: '⏳ Join Request Submitted',
          message: `Your request to join "${event.title}" is pending approval. Funds will be locked once approved.`,
          data: { 
            eventId: eventId, 
            amount: amount,
            prediction: prediction ? 'YES' : 'NO',
            eventTitle: event.title
          },
        });

        return res.json({ message: "Join request sent to event creator", request: joinRequest });
      }

      const participant = await storage.joinEvent(eventId, userId, prediction, amount);

      // Create transaction record for coin escrow
      await storage.createTransaction({
        userId,
        type: 'event_escrow',
        amount: `-${amount}`,
        description: `${amount.toLocaleString()} coins locked in escrow for event: ${event.title}`,
        relatedId: eventId,
        status: 'completed',
      });

      // Deduct coins from user
      await db
        .update(users)
        .set({ 
          coins: sql`${users.coins} - ${amount}`,
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));

      // Create comprehensive notifications
      await storage.createNotification({
        userId,
        type: 'coins_locked',
        title: '🔒 Coins Locked in Escrow',
        message: `${amount.toLocaleString()} coins locked for your ${prediction ? 'YES' : 'NO'} prediction on "${event.title}". Coins will be released when the event ends.`,
        data: { 
          eventId: eventId,
          amount: amount,
          prediction: prediction ? 'YES' : 'NO',
          eventTitle: event.title,
          eventEndDate: event.endDate,
          type: 'escrow_lock'
        },
      });

      // Notify event creator about new participant
      await storage.createNotification({
        userId: event.creatorId,
        type: 'event_participant_joined',
        title: '🎯 New Event Participant',
        message: `${req.user.claims.first_name || 'Someone'} joined your event "${event.title}" with a ${prediction ? 'YES' : 'NO'} prediction (${amount.toLocaleString()} coins)!`,
        data: { 
          eventId: eventId,
          participantId: userId,
          amount: amount,
          prediction: prediction ? 'YES' : 'NO',
          eventTitle: event.title
        },
      });

      // Send real-time notifications via Pusher
      await pusher.trigger(`user-${userId}`, 'coins-locked', {
        title: '🔒 Coins Locked in Escrow',
        message: `${amount.toLocaleString()} coins locked for your ${prediction ? 'YES' : 'NO'} prediction on "${event.title}"`,
        eventId: eventId,
        type: 'coins_locked',
      });

      await pusher.trigger(`user-${event.creatorId}`, 'participant-joined', {
        title: '🎯 New Event Participant',
        message: `${req.user.claims.first_name || 'Someone'} joined your event "${event.title}"`,
        eventId: eventId,
        type: 'participant_joined',
      });

      res.json(participant);
    } catch (error) {
      console.error("Error joining event:", error);
      res.status(500).json({ message: "Failed to join event" });
    }
  });

  app.get('/api/events/:id/messages', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const userId = getUserId(req);

      // Check if event exists and get event details
      const event = await storage.getEventById(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      // If event is private, check access permissions
      if (event.isPrivate) {
        // Allow access if user is the creator
        if (event.creatorId !== userId) {
          // Check if user is a participant (approved to join)
          const participants = await storage.getEventParticipantsWithUsers(eventId);
          const userParticipant = participants.find((p: any) => p.userId === userId);

          if (!userParticipant) {
            return res.status(403).json({ message: "Access denied. This is a private event and you haven't been approved to join." });
          }
        }
      }

      const messages = await storage.getEventMessages(eventId);
      res.json(messages);
    } catch (error) {
      console.error("Error fetching event messages:", error);
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  app.post('/api/events/:id/messages', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const eventId = parseInt(req.params.id);
      const { message, replyToId, mentions } = req.body;

      // Check if event exists and get event details
      const event = await storage.getEventById(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      // If event is private, check access permissions
      if (event.isPrivate) {
        // Allow access if user is the creator
        if (event.creatorId !== userId) {
          // Check if user is a participant (approved to join)
          const participants = await storage.getEventParticipantsWithUsers(eventId);
          const userParticipant = participants.find((p: any) => p.userId === userId);

          if (!userParticipant) {
            return res.status(403).json({ message: "Access denied. You cannot post messages in this private event." });
          }
        }
      }

      const newMessage = await storage.createEventMessage(eventId, userId, message, replyToId, mentions);

      // Broadcast new message via Pusher
      await pusher.trigger(`event-${eventId}`, 'new-message', {
        message: newMessage,
        eventId: eventId,
        userId: userId,
      });

      // Forward to Telegram if sync is available
      const telegramSync = getTelegramSync();
      if (telegramSync && telegramSync.isReady()) {
        try {
          const user = await storage.getUser(userId);
          const event = await storage.getEventById(eventId);
          const senderName = user?.firstName || user?.username || 'BetChat User';

          await telegramSync.sendMessageToTelegram(
            message, 
            senderName, 
            { id: eventId, title: event?.title || `Event ${eventId}` }
          );
        } catch (telegramError) {
          console.error('Error forwarding message to Telegram:', telegramError);
        }
      } else {
        // Fallback to Telegram bot if sync is not available
        const telegramBot = getTelegramBot();
        if (telegramBot) {
          try {
            const user = await storage.getUser(userId);
            const event = await storage.getEventById(eventId);
            const senderName = user?.firstName || user?.username || 'BetChat User';

            const formattedMessage = `🎯 ${event?.title || 'Event Chat'}\n👤 ${senderName}: ${message}`;

            await telegramBot.sendCustomMessage(formattedMessage);
            console.log(`📤 BetChat → Telegram Bot: ${senderName}: ${message} [Event: ${event?.title || 'Event Chat'}]`);
          } catch (telegramError) {
            console.error('Error sending message via Telegram bot:', telegramError);
          }
        }
      }

      // Create notifications for mentioned users
      if (mentions && mentions.length > 0) {
        for (const mentionedUsername of mentions) {
          const mentionedUser = await storage.getUserByUsername(mentionedUsername);
          if (mentionedUser && mentionedUser.id !== userId) {
            const notification = await storage.createNotification({
              userId: mentionedUser.id,
              type: 'mention',
              title: 'You were mentioned',
              message: `${req.user.claims.first_name || 'Someone'} mentioned you in an event chat`,
              data: { 
                eventId: eventId, 
                messageId: newMessage.id,
                mentionedBy: userId,
                eventTitle: 'Event Chat'
              },
            });

            // Send notification via Pusher
            await pusher.trigger(`user-${mentionedUser.id}`, 'event-notification', {
              title: 'You were mentioned',
              message: `${req.user.claims.first_name || 'Someone'} mentioned you in an event chat`,
              eventId: eventId,
              type: 'mention',
            });
          }
        }
      }

      // Create notification for replied user
      if (replyToId) {
        const repliedMessage = await storage.getEventMessageById(replyToId);
        if (repliedMessage && repliedMessage.userId !== userId) {
          const notification = await storage.createNotification({
            userId: repliedMessage.userId,
            type: 'reply',
            title: 'Someone replied to your message',
            message: `${req.user.claims.first_name || 'Someone'} replied to your message`,
            data: { 
              eventId: eventId, 
              messageId: newMessage.id,
              repliedBy: userId,
              originalMessageId: replyToId
            },
          });

          // Send notification via Pusher
          await pusher.trigger(`user-${repliedMessage.userId}`, 'event-notification', {
            title: 'Someone replied to your message',
            message: `${req.user.claims.first_name || 'Someone'} replied to your message`,
            eventId: eventId,
            type: 'reply',
          });
        }
      }

      res.json(newMessage);
    } catch (error) {
      console.error("Error creating event message:", error);
      res.status(500).json({ message: "Failed to create message" });
    }
  });

  app.post('/api/events/:id/messages/:messageId/react', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const eventId = parseInt(req.params.id);
      const messageId = req.params.messageId;
      const { emoji } = req.body;

      const reaction = await storage.toggleMessageReaction(messageId, userId, emoji);

      // Get updated reaction summary for the message
      const message = await storage.getEventMessageById(messageId);
      const updatedReactions = await storage.getMessageReactions(messageId);

      // Broadcast reaction update via Pusher with complete reaction data
      await pusher.trigger(`event-${eventId}`, 'reaction-update', {
        messageId: messageId,
        reactions: updatedReactions,
        userId: userId,
        action: reaction.action,
        emoji: emoji,
        timestamp: new Date().toISOString(),
      });

      res.json({ 
        ...reaction, 
        messageId: messageId,
        reactions: updatedReactions,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error("Error reacting to message:", error);
      res.status(500).json({ message: "Failed to react to message" });
    }
  });

  app.get('/api/events/:id/participants', async (req, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const participants = await storage.getEventParticipantsWithUsers(eventId);
      res.json(participants);
    } catch (error) {
      console.error("Error fetching event participants:", error);
      res.status(500).json({ message: "Failed to fetch participants" });
    }
  });

  // Event Pool Management Routes
  app.get('/api/events/:id/stats', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const stats = await storage.getEventPoolStats(eventId);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching event stats:", error);
      res.status(500).json({ message: "Failed to fetch event stats" });
    }
  });

  // Admin login endpoint (no auth required)
  app.post('/api/admin/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
      }

      // Find user by username
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ message: 'Invalid admin credentials' });
      }

      // Check if user is admin
      if (!user.isAdmin) {
        return res.status(403).json({ message: 'Admin access denied' });
      }

      // Verify password
      const { comparePasswords } = await import('./auth');
      const isValidPassword = await comparePasswords(password, user.password);
      if (!isValidPassword) {
        return res.status(401).json({ message: 'Invalid admin credentials' });
      }

      // Generate signed admin token
      const adminToken = generateAdminToken(user.id);

      res.json({
        token: adminToken,
        user: {
          id: user.id,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          isAdmin: user.isAdmin
        }
      });
    } catch (error) {
      console.error('Admin login error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Admin routes with authentication
  app.use('/api/admin', adminAuth);

  app.get('/api/admin/bantahbro/battle-engine/live', async (req, res) => {
    try {
      const parseAdminLimit = (value: unknown, fallback: number, max: number) => {
        const parsed = Number.parseInt(String(value ?? ""), 10);
        if (!Number.isInteger(parsed)) return fallback;
        return Math.max(1, Math.min(parsed, max));
      };

      const feed = await getBantahBroBattleEngineFeed({
        scanLimit: parseAdminLimit(req.query.scanLimit, 28, 80),
        candidateLimit: parseAdminLimit(req.query.candidateLimit, 80, 240),
        selectedLimit: parseAdminLimit(req.query.selectedLimit, 24, 60),
        featuredLimit: parseAdminLimit(req.query.featuredLimit, 8, 12),
        bypassCache: String(req.query.refresh || "").toLowerCase() === "true",
      });

      res.json(feed);
    } catch (error) {
      console.error("Error running BantahBro battle engine:", error);
      res.status(502).json({
        message: error instanceof Error ? error.message : "Failed to run BantahBro battle engine",
      });
    }
  });

  app.get('/api/admin/bantahbro/battle-engine/overrides', async (_req, res) => {
    try {
      res.json({ overrides: await listBantahBroBattleOverrides() });
    } catch (error) {
      console.error("Error listing BantahBro battle overrides:", error);
      res.status(500).json({
        message: error instanceof Error ? error.message : "Failed to list battle overrides",
      });
    }
  });

  app.get('/api/admin/bantahbro/battle-engine/listed', async (_req, res) => {
    try {
      res.json({ battles: await listBantahBroListedBattles() });
    } catch (error) {
      console.error("Error listing official BantahBro battles:", error);
      res.status(500).json({
        message: error instanceof Error ? error.message : "Failed to list official battles",
      });
    }
  });

  app.post('/api/admin/bantahbro/battle-engine/listed', async (req: AdminAuthRequest, res) => {
    try {
      const battles = Array.isArray(req.body?.battles) ? req.body.battles : [];
      if (!battles.length) {
        return res.status(400).json({ message: "Select at least one battle to list" });
      }

      const published = await publishBantahBroBattleCandidates(battles, {
        listedBy: req.adminUser?.id ?? null,
        source: "engine",
      });

      res.json({
        published,
        count: published.length,
        message: `${published.length} battle${published.length === 1 ? "" : "s"} listed officially`,
      });
    } catch (error) {
      console.error("Error publishing official BantahBro battles:", error);
      res.status(400).json({
        message: error instanceof Error ? error.message : "Failed to publish official battles",
      });
    }
  });

  app.post('/api/admin/bantahbro/battle-engine/listed/autolist', async (req: AdminAuthRequest, res) => {
    try {
      const parsedLimit = Number.parseInt(String(req.body?.limit ?? req.query.limit ?? "30"), 10);
      const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 60)) : 30;
      const feed = await getBantahBroBattleEngineFeed({
        scanLimit: Math.max(40, Math.min(80, limit * 3)),
        candidateLimit: Math.max(120, limit * 8),
        selectedLimit: limit,
        featuredLimit: Math.min(12, limit),
        bypassCache: true,
      });
      const candidateMap = new Map<string, typeof feed.selectedBattles[number]>();
      for (const battle of feed.selectedBattles) candidateMap.set(battle.id, battle);
      for (const battle of feed.candidates) candidateMap.set(battle.id, battle);
      const candidates = Array.from(candidateMap.values()).slice(0, limit);
      if (!candidates.length) {
        return res.status(409).json({ message: "No eligible live engine battles to list right now" });
      }

      const published = await publishBantahBroBattleCandidates(candidates, {
        listedBy: req.adminUser?.id ?? null,
        source: "engine",
      });

      res.json({
        published,
        count: published.length,
        scanned: feed.scanner.analyzedTokens,
        candidateCount: feed.candidates.length,
        message: `${published.length} live engine battle${published.length === 1 ? "" : "s"} listed officially`,
      });
    } catch (error) {
      console.error("Error auto-listing BantahBro battles:", error);
      res.status(400).json({
        message: error instanceof Error ? error.message : "Failed to auto-list battles",
      });
    }
  });

  app.delete('/api/admin/bantahbro/battle-engine/listed/:battleId', async (req, res) => {
    try {
      const removed = await unlistBantahBroBattle(String(req.params.battleId || ""));
      res.json({ removed, message: removed ? "Battle unlisted" : "Battle was not listed" });
    } catch (error) {
      console.error("Error unlisting BantahBro battle:", error);
      res.status(400).json({
        message: error instanceof Error ? error.message : "Failed to unlist battle",
      });
    }
  });

  app.patch('/api/admin/bantahbro/battle-engine/battles/:battleId/override', async (req: AdminAuthRequest, res) => {
    try {
      const parseOptionalBoolean = (value: unknown) => {
        if (typeof value === "boolean") return value;
        if (typeof value === "string") {
          if (value.toLowerCase() === "true") return true;
          if (value.toLowerCase() === "false") return false;
        }
        return undefined;
      };

      const record = await updateBantahBroBattleOverride(String(req.params.battleId || ""), {
        hidden: parseOptionalBoolean(req.body?.hidden),
        pinned: parseOptionalBoolean(req.body?.pinned),
        featured: parseOptionalBoolean(req.body?.featured),
        note: typeof req.body?.note === "string" ? req.body.note : undefined,
        updatedBy: req.adminUser?.id ?? null,
      });

      res.json({ override: record });
    } catch (error) {
      console.error("Error updating BantahBro battle override:", error);
      res.status(400).json({
        message: error instanceof Error ? error.message : "Failed to update battle override",
      });
    }
  });

  app.get('/api/admin/stats', adminAuth, async (req, res) => {
    try {
      const stats = await storage.getAdminStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching admin stats:", error);
      res.status(500).json({ message: "Failed to fetch admin stats" });
    }
  });

  // Admin Route: Set event result and trigger payout
  app.post('/api/admin/events/:id/result', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const userId = req.adminUser.id;
      const eventId = parseInt(req.params.id);
      const { result } = req.body; // true for YES, false for NO

      // Log admin action for audit trail
      console.log(`Admin ${userId} setting result for event ${eventId}: ${result ? 'YES' : 'NO'}`);

      // Validate event exists and is ready for payout
      const existingEvent = await storage.getEventById(eventId);
      if (!existingEvent) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (existingEvent.adminResult !== null) {
        return res.status(400).json({ message: "Event result already set" });
      }

      const event = await storage.adminSetEventResult(eventId, result);
      const payoutResult = await storage.processEventPayout(eventId);

      // Log payout for audit trail```text
  console.log(`Event ${eventId} payout processed:`, {
        winnersCount: payoutResult.winnersCount,
        totalPayout: payoutResult.totalPayout,
        creatorFee: payoutResult.creatorFee,
        processedBy: userId,
        timestamp: new Date().toISOString()
      });

      // Send real-time notification to participants
      await pusher.trigger(`event-${eventId}`, 'event-resolved', {
        eventId,
        result: result ? 'YES' : 'NO',
        winnersCount: payoutResult.winnersCount,
        totalPayout: payoutResult.totalPayout,
        timestamp: new Date().toISOString()
      });

      res.json({ 
        event, 
        payout: payoutResult,
        message: `Event result set to ${result ? 'YES' : 'NO'}. Payout processed: ${payoutResult.winnersCount} winners received ₦${payoutResult.totalPayout.toLocaleString()} total, ₦${payoutResult.creatorFee.toLocaleString()} creator fee.`
      });
    } catch (error) {
      console.error("Error setting event result:", error);
      res.status(500).json({ message: error.message || "Failed to set event result" });
    }
  });

  // Private Event Management Routes
  app.get('/api/events/:id/join-requests', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const eventId = parseInt(req.params.id);

      // Check if user is the event creator
      const event = await storage.getEventById(eventId);
      if (!event || event.creatorId !== userId) {
        return res.status(403).json({ message: "Only event creator can view join requests" });
      }

      const requests = await storage.getEventJoinRequests(eventId);
      res.json(requests);
    } catch (error) {
      console.error("Error fetching join requests:", error);
      res.status(500).json({ message: "Failed to fetch join requests" });
    }
  });

  app.post('/api/events/join-requests/:id/approve', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const requestId = parseInt(req.params.id);

      // TODO: Add validation that user is the event creator

      const participant = await storage.approveEventJoinRequest(requestId);

      // Create notification for requester
      await storage.createNotification({
        userId: participant.userId,
        type: 'event_join_approved',
        title: 'Event Join Request Approved',
        message: `Your request to join the event has been approved!`,
        data: { eventId: participant.eventId },
      });

      res.json(participant);
    } catch (error) {
      console.error("Error approving join request:", error);
      res.status(500).json({ message: "Failed to approve join request" });
    }
  });

  app.post('/api/events/join-requests/:id/reject', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const requestId = parseInt(req.params.id);

      // TODO: Add validation that user is the event creator

      const rejectedRequest = await storage.rejectEventJoinRequest(requestId);

      // Create notification for requester
      await storage.createNotification({
        userId: rejectedRequest.userId,
        type: 'event_join_rejected',
        title: 'Event Join Request Rejected',
        message: `Your request to join the event has been rejected.`,
        data: { eventId: rejectedRequest.eventId },
      });

      res.json(rejectedRequest);
    } catch (error) {
      console.error("Error rejecting join request:", error);
      res.status(500).json({ message: "Failed to reject join request" });
    }
  });

  // Challenge routes
  app.get('/api/challenges/public', async (req, res) => {
    try {
      const limitRaw = Number(req.query?.limit || 60);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 60;
      console.log("📥 Fetching public challenges...");
      const challenges = await storage.getAllChallengesFeed(limit);
      console.log(`✅ Retrieved ${challenges.length} public challenges`);
      res.json(challenges);
    } catch (error: any) {
      console.error("❌ Error fetching public challenges:", error);
      console.error("Error details:", {
        message: error?.message,
        code: error?.code,
        stack: error?.stack?.substring(0, 200)
      });
      res.status(500).json({ 
        message: "Failed to fetch public challenges",
        error: error?.message 
      });
    }
  });

  // Debug: list expired or ended admin challenges for inspection
  app.get('/api/admin/challenges/expired', async (req, res) => {
    try {
      const challenges = await storage.getPublicAdminChallenges(200);
      const now = new Date();
      const expired = challenges.filter((c: any) => {
        // expired if status is not open OR dueDate in the past
        if (c.status && c.status !== 'open') return true;
        if (c.adminCreated && c.dueDate) {
          try {
            return new Date(c.dueDate) < now;
          } catch { return false; }
        }
        return false;
      });
      res.json({ count: expired.length, expired });
    } catch (err: any) {
      console.error('Error fetching expired challenges:', err);
      res.status(500).json({ message: err?.message || 'Failed to fetch expired challenges' });
    }
  });

  app.get('/api/challenges/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid challenge ID" });
      }
      const challenge = await storage.getChallengeById(id);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }
      res.setHeader("x-onchain-execution-mode", ONCHAIN_CONFIG.executionMode);
      res.json({
        ...challenge,
        onchainExecution: {
          mode: ONCHAIN_CONFIG.executionMode,
          contractEnabled: ONCHAIN_CONFIG.contractEnabled,
        },
      });
    } catch (error) {
      console.error("Error fetching challenge:", error);
      res.status(500).json({ message: "Failed to fetch challenge" });
    }
  });

  app.post('/api/track-share', async (req, res) => {
    try {
      // Basic implementation to satisfy the frontend request
      // You can expand this to log to a database if needed
      console.log('Share tracked:', req.body);
      res.json({ success: true });
    } catch (error) {
      console.error('Error tracking share:', error);
      res.status(500).json({ message: 'Failed to track share' });
    }
  });

  app.get('/api/challenges', async (req: AuthenticatedRequest, res) => {
    try {
      // Check if requesting all challenges (public feed) or user-specific challenges
      const feedType = req.query.feed as string;
      const limitRaw = Number(req.query?.limit || 60);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 60;
      const optionalUserId = await getOptionalPrivyUserId(req);
      const hasAuthedUser = Boolean(optionalUserId);
      const challenges =
        feedType === 'all' || !hasAuthedUser
          ? await storage.getAllChallengesFeed(limit)
          : await storage.getChallenges(optionalUserId as string, limit);
      res.json(challenges);
    } catch (error) {
      console.error("Error fetching challenges:", error);
      res.status(500).json({ message: "Failed to fetch challenges" });
    }
  });

  app.get('/api/challenges/:id/activity', async (req, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      
      // 1. Get Challenge completion/result activity
      const challenge = await storage.getChallengeById(challengeId);
      
      // 2. Get Transactions related to this challenge (Payouts)
      const challengeTransactions = await db.select().from(transactions).where(and(eq(transactions.relatedId, challengeId), eq(transactions.type, 'challenge')));
      
      // 3. Get Matches (joins) - wrapped in try-catch due to potential type mismatches
      let queueEntries: any[] = [];
      try {
        queueEntries = await db.select({
          entry: pairQueue,
          user: users
        }).from(pairQueue).leftJoin(users, eq(pairQueue.userId, users.id)).where(eq(pairQueue.challengeId, challengeId));
      } catch (err) {
        // Continue without queue entries if there's a type mismatch
      }

      const activity: any[] = [];

      if (!challenge) {
        return res.json([]);
      }

      // Add challenge creation event (first activity)
      if (challenge.challenger) {
        const creator = await storage.getUser(challenge.challenger);
        activity.push({
          id: `created-${challengeId}`,
          user: creator,
          action: `created challenge "${challenge.title}"`,
          createdAt: challenge.createdAt
        });
      } else {
        // For old challenges without a challenger, just show creation
        activity.push({
          id: `created-${challengeId}`,
          user: null,
          action: `challenge "${challenge.title}" created`,
          createdAt: challenge.createdAt
        });
      }

      // Add bonus event if bonus is active
      if (challenge.bonusSide && challenge.bonusMultiplier && parseFloat(challenge.bonusMultiplier.toString()) > 1) {
        const bonusType = challenge.bonusAmount > 0 ? `₦${challenge.bonusAmount}` : `${challenge.bonusMultiplier}x`;
        activity.push({
          id: `bonus-${challengeId}`,
          user: challenge.challenger ? await storage.getUser(challenge.challenger) : null,
          action: `added ${bonusType} bonus on the ${challenge.bonusSide} side`,
          createdAt: challenge.bonusEndsAt ? new Date(new Date(challenge.bonusEndsAt).getTime() - 86400000) : challenge.createdAt
        });
      }

      // Add awaiting participants event
      const participantCount = queueEntries.length;
      if (participantCount === 0) {
        activity.push({
          id: `awaiting-${challengeId}`,
          user: null,
          action: `awaiting participants`,
          createdAt: challenge.createdAt
        });
      }

      if (challenge.status === 'completed' && challenge.result) {
        const winnerId = challenge.result === 'challenger_won' ? challenge.challenger : challenge.challenged;
        const winner = await storage.getUser(winnerId!);
        const loserId = challenge.result === 'challenger_won' ? challenge.challenged : challenge.challenger;
        const loser = await storage.getUser(loserId!);
        activity.push({
          id: `result-${challengeId}`,
          user: winner,
          action: `defeated ${loser?.username || 'Opponent'} — Winner: ${winner?.username || 'Winner'}`,
          createdAt: challenge.completedAt || new Date()
        });
      }

      for (const tx of challengeTransactions) {
        const user = await storage.getUser(tx.userId);
        activity.push({
          id: `tx-${tx.id}`,
          user,
          action: `Payout of ${tx.amount} coins made to ${user?.username || 'User'}`,
          createdAt: tx.createdAt
        });
      }

      for (const q of queueEntries) {
        if (q.user) {
          activity.push({
            id: `join-${q.entry.id}`,
            user: q.user,
            action: `joined on the ${q.entry.side} side`,
            createdAt: q.entry.createdAt
          });
        }
        if (q.entry.status === 'matched' && q.entry.matchedWith) {
          const opponent = await storage.getUser(q.entry.matchedWith);
          if (q.user) {
            activity.push({
              id: `match-${q.entry.id}`,
              user: q.user,
              action: `matched with ${opponent?.username || 'opponent'}`,
              createdAt: q.entry.matchedAt || q.entry.createdAt
            });
          }
        }
      }

      res.json(activity.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    } catch (error) {
      console.error("Error fetching activity:", error);
      res.json([]);
    }
  });

  app.get('/api/challenges/:id/matches', async (req, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const matches = await db.select({
        entry: pairQueue,
        user: users,
        matchedWithUser: sql<any>`(SELECT row_to_json(u) FROM users u WHERE u.id = ${pairQueue.matchedWith})`
      }).from(pairQueue)
      .leftJoin(users, eq(pairQueue.userId, users.id))
      .where(eq(pairQueue.challengeId, challengeId));
      
      res.json(matches.map(m => ({
        ...m.entry,
        user: m.user,
        matchedWithUser: m.matchedWithUser
      })));
    } catch (error) {
      console.error("Error fetching matches:", error);
      res.json([]);
    }
  });

  app.post('/api/challenges/draft', PrivyAuthMiddleware, requireOnchainWallet, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const selectedChainId = Number(
        req.body?.chainId || ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId,
      );
      const chainConfig =
        ONCHAIN_CONFIG.chains[String(selectedChainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.chainId)];

      if (!chainConfig) {
        return res.status(400).json({ message: "Unsupported chainId for onchain challenge" });
      }

      const tokenSymbol = normalizeOnchainTokenSymbol(
        req.body?.tokenSymbol || ONCHAIN_CONFIG.defaultToken,
      ) as OnchainTokenSymbol;
      const tokenConfig = chainConfig.tokens[tokenSymbol];

      if (!tokenConfig || !isSupportedOnchainToken(chainConfig, tokenSymbol)) {
        return res.status(400).json({ message: "Unsupported token" });
      }
      if (!tokenConfig.isNative && !normalizeEvmAddress(tokenConfig.address)) {
        return res.status(400).json({
          message: `Token ${tokenSymbol} not configured for chainId ${chainConfig.chainId}. Set token address in env.`,
        });
      }
      if (!tokenConfig.isNative) {
        try {
          await assertAllowedStakeToken({
            rpcUrl: chainConfig.rpcUrl,
            tokenAddress: String(tokenConfig.address),
            tokenSymbol,
          });
        } catch (tokenError: any) {
          return res.status(400).json({
            message:
              tokenError?.message ||
              `Token ${tokenSymbol} is not allowed for onchain challenge staking.`,
          });
        }
      }

      const amountValue = req.body.amount;
      if (!amountValue) {
        return res.status(400).json({ message: "Amount is required" });
      }

      const parsedAmount = Number.parseFloat(String(amountValue));
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: "Amount must be a valid positive number" });
      }
      if (parsedAmount > MAX_CHALLENGE_AMOUNT) {
        return res.status(400).json({
          message: `Amount is too large. Maximum allowed is ${MAX_CHALLENGE_AMOUNT.toLocaleString()} ${tokenSymbol}`,
        });
      }

      if (!req.body.title || !req.body.title.trim()) {
        return res.status(400).json({ message: "Title is required" });
      }

      if (!req.body.category || !req.body.category.trim()) {
        return res.status(400).json({ message: "Category is required" });
      }

      const creatorWallet = normalizeEvmAddress(req.user.walletAddress);
      if (ONCHAIN_CONFIG.contractEnabled && !creatorWallet) {
        return res.status(403).json({
          message: "Wallet required. Connect an EVM wallet to continue.",
          code: "WALLET_REQUIRED",
        });
      }

      const stakeAtomic = toAtomicUnits(String(amountValue), tokenConfig.decimals);
      const amountForSchema = Math.max(1, Math.round(parsedAmount));
      const challengedWalletAddress = normalizeEvmAddress(
        (req.body as any)?.challengedWalletAddress,
      );
      const challengedInput =
        typeof req.body?.challenged === "string" ? req.body.challenged.trim() : "";
      let challengedUserId: string | null = null;

      if (challengedInput) {
        const normalizedChallengeTarget = challengedInput.replace(/^@+/, "");
        const challengedUser =
          (await storage.getUser(normalizedChallengeTarget)) ||
          (await storage.getUserByUsername(normalizedChallengeTarget));

        if (!challengedUser) {
          return res.status(404).json({
            message: "Opponent not found. Enter a valid username.",
          });
        }

        if (challengedUser.id === userId) {
          return res.status(400).json({
            message: "You can't challenge yourself.",
          });
        }

        challengedUserId = challengedUser.id;
      }

      const dataToValidate: any = {
        ...req.body,
        challenger: userId,
        amount: amountForSchema,
        dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined,
        settlementRail: "onchain",
        chainId: chainConfig.chainId,
        tokenSymbol,
        tokenAddress: tokenConfig.address,
        decimals: tokenConfig.decimals,
        stakeAtomic,
        escrowTxHash: undefined,
        status: "draft",
      };

      if (challengedUserId) {
        dataToValidate.challenged = challengedUserId;
        delete dataToValidate.challengedWalletAddress;
      } else if (challengedWalletAddress) {
        delete dataToValidate.challenged;
        dataToValidate.challengedWalletAddress = challengedWalletAddress;
      } else {
        delete dataToValidate.challenged;
        delete dataToValidate.challengedWalletAddress;
      }

      const challengeData = insertChallengeSchema.parse(dataToValidate);
      const challenge = await storage.createChallengeDraft(challengeData);

      res.status(201).json({
        challenge,
        onchainExecution: {
          mode: ONCHAIN_CONFIG.executionMode,
          contractEnabled: ONCHAIN_CONFIG.contractEnabled,
        },
      });
    } catch (error: any) {
      console.error("Error creating challenge draft:", error);
      if (error?.message?.includes("validation") || error?.issues) {
        return res.status(400).json({
          message: "Validation error",
          details: error?.issues || error?.message,
        });
      }
      res.status(500).json({
        message: "Failed to create challenge draft",
        error: error?.message || "Unknown error",
      });
    }
  });

  app.post('/api/challenges', PrivyAuthMiddleware, requireOnchainWallet, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const MAX_CHALLENGE_AMOUNT = 1_000_000; // NGN safeguard against malformed unit-scaled inputs
      const requestedChainId = Number(req.body?.chainId || ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId);
      const chainConfig =
        ONCHAIN_CONFIG.chains[String(requestedChainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.chainId)];
      if (!chainConfig) {
        return res.status(400).json({ message: "Unsupported chainId for onchain testnet mode" });
      }
      const tokenSymbol = normalizeOnchainTokenSymbol(req.body?.tokenSymbol) as OnchainTokenSymbol;
      const tokenConfig = chainConfig.tokens[tokenSymbol];

      if (!tokenConfig || !isSupportedOnchainToken(chainConfig, tokenSymbol)) {
        return res.status(400).json({ message: "Unsupported token" });
      }
      if (!tokenConfig.isNative && !normalizeEvmAddress(tokenConfig.address)) {
        return res.status(400).json({
          message: `Token ${tokenSymbol} not configured for chainId ${chainConfig.chainId}. Set token address in env.`,
        });
      }
      if (!tokenConfig.isNative) {
        try {
          await assertAllowedStakeToken({
            rpcUrl: chainConfig.rpcUrl,
            tokenAddress: String(tokenConfig.address),
            tokenSymbol,
          });
        } catch (tokenError: any) {
          return res.status(400).json({
            message:
              tokenError?.message ||
              `Token ${tokenSymbol} is not allowed for onchain challenge staking.`,
          });
        }
      }

      // Validate amount first
      const amountValue = req.body.amount;
      if (!amountValue) {
        return res.status(400).json({ message: "Amount is required" });
      }

      const parsedAmount = Number.parseFloat(String(amountValue));
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: "Amount must be a valid positive number" });
      }
      if (parsedAmount > MAX_CHALLENGE_AMOUNT) {
        return res.status(400).json({
          message: `Amount is too large. Maximum allowed is ${MAX_CHALLENGE_AMOUNT.toLocaleString()} ${tokenSymbol}`,
        });
      }

      // Validate required fields
      if (!req.body.title || !req.body.title.trim()) {
        return res.status(400).json({ message: "Title is required" });
      }

      if (!req.body.category || !req.body.category.trim()) {
        return res.status(400).json({ message: "Category is required" });
      }

      const stakeAtomic = toAtomicUnits(String(amountValue), tokenConfig.decimals);
      const amountForSchema = Math.max(1, Math.round(parsedAmount));
      let creatorEscrowTxHash: string | null = null;
      const creatorWallet = normalizeEvmAddress(req.user.walletAddress);
      const challengedWalletAddress = normalizeEvmAddress(
        (req.body as any)?.challengedWalletAddress,
      );
      const challengedInput =
        typeof req.body?.challenged === "string" ? req.body.challenged.trim() : "";
      let challengedUserId: string | null = null;

      if (challengedInput) {
        const normalizedChallengeTarget = challengedInput.replace(/^@+/, "");
        const challengedUser =
          (await storage.getUser(normalizedChallengeTarget)) ||
          (await storage.getUserByUsername(normalizedChallengeTarget));

        if (!challengedUser) {
          return res.status(404).json({
            message: "Opponent not found. Enter a valid username.",
          });
        }

        if (challengedUser.id === userId) {
          return res.status(400).json({
            message: "You can't challenge yourself.",
          });
        }

        challengedUserId = challengedUser.id;
      }

      if (ONCHAIN_CONFIG.contractEnabled) {
        if (!creatorWallet) {
          return res.status(403).json({
            message: "Wallet required. Connect an EVM wallet to continue.",
            code: "WALLET_REQUIRED",
          });
        }

        const escrowContract = normalizeEvmAddress(chainConfig.escrowContractAddress);
        if (!escrowContract) {
          return res.status(500).json({
            message: `Escrow contract not configured for chainId ${chainConfig.chainId}`,
          });
        }

        if (!req.body?.escrowTxHash) {
          return res.status(400).json({
            message:
              "escrowTxHash is required in contract mode. Send the wallet escrow transaction hash.",
          });
        }

        const verifiedEscrowTx = await verifyEscrowTransaction({
          rpcUrl: chainConfig.rpcUrl,
          expectedChainId: chainConfig.chainId,
          expectedFrom: creatorWallet,
          expectedEscrowContract: escrowContract,
          tokenSymbol,
          txHash: String(req.body.escrowTxHash),
        });

        const alreadyUsed = await findChallengeUsingEscrowTxHash(verifiedEscrowTx.txHash);
        if (alreadyUsed) {
          return res.status(409).json({
            message: "This escrow transaction hash has already been used for another challenge.",
            challengeId: alreadyUsed.id,
          });
        }

        creatorEscrowTxHash = verifiedEscrowTx.txHash;
      }

      // Prepare data for validation
      const dataToValidate: any = {
        ...req.body,
        challenger: userId,
        amount: amountForSchema, // Integer for schema/back-compat; stakeAtomic holds exact value
        dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined, // Convert string to Date
        settlementRail: "onchain",
        chainId: chainConfig.chainId,
        tokenSymbol,
        tokenAddress: tokenConfig.address,
        decimals: tokenConfig.decimals,
        stakeAtomic,
        escrowTxHash: creatorEscrowTxHash || undefined,
      };

      // Handle challenged field - for open challenges it might be empty string, which should be null/undefined
      if (challengedUserId) {
        dataToValidate.challenged = challengedUserId;
        delete dataToValidate.challengedWalletAddress;
        dataToValidate.status = 'pending';
      } else if (challengedWalletAddress) {
        delete dataToValidate.challenged;
        dataToValidate.challengedWalletAddress = challengedWalletAddress;
        dataToValidate.status = 'pending';
      } else {
        // For open challenges, don't include challenged or set to null
        delete dataToValidate.challenged;
        delete dataToValidate.challengedWalletAddress;
        dataToValidate.status = 'open';
      }

      console.log('Challenge data to validate:', dataToValidate);

      let challengeData;
      try {
        challengeData = insertChallengeSchema.parse(dataToValidate);
        console.log('Challenge data after schema validation:', challengeData);
      } catch (validationError: any) {
        console.error('Schema validation failed:', validationError);
        return res.status(400).json({ 
          message: "Validation error",
          details: validationError?.issues || validationError?.message 
        });
      }
      
      // Use standard P2P creation (sets adminCreated to false by default)
      console.log('About to call storage.createChallenge with:', challengeData);
      const challenge = await storage.createChallenge(challengeData);
      const bantCreditReward = await awardChallengeCreationBantCreditAndNotify({
        userId,
        challenge,
        marketSize: parsedAmount,
      });
      const challenger = await storage.getUser(userId);
      const challenged = challenge.challenged ? await storage.getUser(challenge.challenged) : null;
      const challengeMeta = {
        chainId: challenge.chainId ?? challengeData.chainId ?? chainConfig.chainId,
        settlementRail: challenge.settlementRail ?? challengeData.settlementRail ?? "onchain",
        tokenSymbol: challenge.tokenSymbol ?? challengeData.tokenSymbol ?? tokenSymbol,
        escrowTxHash: challenge.escrowTxHash ?? creatorEscrowTxHash ?? challengeData.escrowTxHash,
        settleTxHash: challenge.settleTxHash ?? challengeData.settleTxHash,
      };
      const challengeScanUrl = getChallengeScanUrl(challengeMeta, creatorEscrowTxHash);
      const telegramBot = getTelegramBot();

      // Persist onchain metadata for indexers and optionally log metadata hash onchain
      try {
        const metadataPayload = {
          version: 1,
          challengeId: challenge.id,
          chainId: Number(challengeMeta.chainId || chainConfig.chainId),
          escrowTxHash: challengeMeta.escrowTxHash ?? null,
          challengerWallet: creatorWallet,
          challengerUserId: challenge.challenger ?? null,
          challengedUserId: challenge.challenged ?? null,
          challengedWalletAddress: challenge.challengedWalletAddress ?? null,
          title: challenge.title,
          description: challenge.description ?? null,
          category: challenge.category,
          amount: parseFloat(String(challenge.amount || 0)) || 0,
          challengerSide: challenge.challengerSide ?? null,
          dueDate: challenge.dueDate ? new Date(challenge.dueDate).toISOString() : null,
          settlementRail: challenge.settlementRail ?? "onchain",
          tokenSymbol: challenge.tokenSymbol ?? tokenSymbol,
          tokenAddress: challenge.tokenAddress ?? tokenConfig.address ?? null,
          decimals: Number(challenge.decimals ?? tokenConfig.decimals ?? 0) || null,
          stakeAtomic: challenge.stakeAtomic ?? stakeAtomic,
          adminCreated: challenge.adminCreated ?? false,
          createdAt: challenge.createdAt ? new Date(challenge.createdAt).toISOString() : null,
        };

        const metadataRecord = await upsertOnchainChallengeMetadata({
          payload: metadataPayload,
          chainId: metadataPayload.chainId,
          escrowTxHash: metadataPayload.escrowTxHash,
          challengeId: challenge.id,
        });

        const metadataLoggerEnabled = String(process.env.ONCHAIN_METADATA_LOGGER_ENABLED || "")
          .trim()
          .toLowerCase();
        const shouldLogMetadata =
          metadataLoggerEnabled === "true" ||
          metadataLoggerEnabled === "1" ||
          metadataLoggerEnabled === "yes";

        if (shouldLogMetadata && metadataPayload.escrowTxHash) {
          await logOnchainChallengeCreated({
            chain: chainConfig,
            metadataHash: metadataRecord.metadataHash,
            challengeId: challenge.id,
            challengeType: "challenge",
          });
        }
      } catch (metadataError) {
        console.error("⚠️ Failed to persist/log onchain metadata:", metadataError);
      }

      // Only create notification for challenged user if there is a challenged user (not open challenge)  
      if (challenge.challenged && challenged) {
        const challengedNotification = await storage.createNotification({
          userId: challenge.challenged,
          type: 'challenge',
          title: '🎯 New Challenge Request',
          message: `${challenger?.firstName || challenger?.username || 'Someone'} challenged you to "${challenge.title}"`,
          data: { 
            challengeId: challenge.id,
            challengerName: challenger?.firstName || challenger?.username,
            challengeTitle: challenge.title,
            amount: challenge.amount,
            category: challenge.category,
            chainId: challengeMeta.chainId,
            settlementRail: challengeMeta.settlementRail,
            tokenSymbol: challengeMeta.tokenSymbol,
            scanUrl: challengeScanUrl,
            explorerUrl: challengeScanUrl,
          },
        });

        // Send instant real-time notification via Pusher for challenged user
        try {
          await pusher.trigger(`user-${challenge.challenged}`, 'challenge-received', {
            id: challengedNotification.id,
            type: 'challenge_received',
            title: '🎯 Challenge Received!',
            message: `${challenger?.firstName || challenger?.username || 'Someone'} challenged you to "${challenge.title}"`,
            challengerName: challenger?.firstName || challenger?.username || 'Someone',
            challengeTitle: challenge.title,
            amount: parseFloat(challenge.amount.toString()),
            challengeId: challenge.id,
            data: challengedNotification.data,
            scanUrl: challengeScanUrl,
            timestamp: new Date().toISOString(),
          });
        } catch (pusherError) {
          console.error("Error sending Pusher notification to challenged user:", pusherError);
        }
      }

      // Create notification for challenger (confirmation)
      const challengerNotification = await storage.createNotification({
        userId: userId,
        type: 'challenge_sent',
        title: '🚀 Challenge Sent',
        message: `Your challenge "${challenge.title}" was sent to ${challenged?.firstName || challenged?.username || 'Open Challenge'}`,
        data: { 
          challengeId: challenge.id,
          challengedName: challenged?.firstName || challenged?.username || 'Open Challenge',
          challengeTitle: challenge.title,
          amount: challenge.amount,
          category: challenge.category,
          chainId: challengeMeta.chainId,
          settlementRail: challengeMeta.settlementRail,
          tokenSymbol: challengeMeta.tokenSymbol,
          scanUrl: challengeScanUrl,
          explorerUrl: challengeScanUrl,
        },
      });

      // Send Pusher notification to challenger
      try {
        await pusher.trigger(`user-${userId}`, 'challenge-sent', {
          id: challengerNotification.id,
          type: 'challenge_sent',
          title: '🚀 Challenge Sent',
          message: `Your challenge "${challenge.title}" was sent to ${challenged?.firstName || challenged?.username || 'Open Challenge'}`,
          data: challengerNotification.data,
          scanUrl: challengeScanUrl,
          timestamp: new Date().toISOString(),
        });
      } catch (pusherError) {
        console.error("Error sending Pusher notification to challenger:", pusherError);
      }

      // Send NotificationService notification for challenge created
      try {
        const { notifyChallengeCreated } = await import('./challengeNotifications');
        await notifyChallengeCreated(
          challenge.id,
          challenger?.firstName || challenger?.username || 'Unknown',
          challenge.challenged,
          challenge.title,
          parseFloat(challenge.amount)
        );
      } catch (notifErr) {
        console.error('Error sending challenge created notification:', notifErr);
      }

      // Broadcast to Telegram channel
      if (telegramBot) {
        try {
          const stakeBroadcastMeta = buildChallengeStakeBroadcastMeta(challenge);
          await telegramBot.broadcastChallenge({
            id: challenge.id,
            title: challenge.title,
            description: challenge.description || undefined,
            creator: {
              name: challenger.firstName || challenger.username || 'Unknown',
              username: challenger.username || undefined,
            },
            challenged: {
              name: challenged?.firstName || challenged?.username || 'Open Challenge',
              username: challenged?.username || undefined,
            },
            stake_amount: parseFloat(challenge.amount.toString()),
            stake_display: stakeBroadcastMeta.stakeDisplay,
            settlement_label: stakeBroadcastMeta.settlementLabel,
            status: challenge.status,
            end_time: challenge.dueDate,
            category: challenge.category,
          });
          console.log("📤 Challenge broadcasted to Telegram successfully");

          // Phase 2: Send accept card to challenged user if they have Telegram linked
          if (challenged?.telegramId) {
            console.log(`📤 Sending challenge accept card to Telegram user ${challenged.telegramId}`);
            await telegramBot.sendChallengeAcceptCard(
              parseInt(challenged.telegramId),
              {
                id: challenge.id,
                title: challenge.title,
                description: challenge.description || undefined,
                challenger: {
                  name: challenger.firstName || challenger.username || 'Unknown',
                  username: challenger.username || undefined,
                },
                challenged: {
                  name: challenged.firstName || challenged.username || 'You',
                  username: challenged.username || undefined,
                },
                amount: parseFloat(challenge.amount.toString()),
                category: challenge.category,
              }
            );
            console.log("📤 Challenge accept card sent to Telegram user");
          }
        } catch (error) {
          console.error("❌ Failed to broadcast challenge to Telegram:", error);
        }
      }

      res.setHeader("x-onchain-execution-mode", ONCHAIN_CONFIG.executionMode);
      res.json({
        ...challenge,
        bantCreditReward,
        onchainExecution: {
          mode: ONCHAIN_CONFIG.executionMode,
          contractEnabled: ONCHAIN_CONFIG.contractEnabled,
        },
      });
    } catch (error: any) {
      console.error("Error creating challenge:", error);
      console.error("Error details:", {
        message: error?.message,
        code: error?.code,
        detail: error?.detail,
        stack: error?.stack
      });
      
      // Check if it's a validation error
      if (error?.message?.includes("validation") || error?.issues) {
        return res.status(400).json({ 
          message: "Validation error",
          details: error?.issues || error?.message 
        });
      }
      
      // Check for insufficient balance
      if (error?.message?.includes("Insufficient balance")) {
        return res.status(402).json({ message: error.message });
      }
      
      res.status(500).json({ 
        message: "Failed to create challenge",
        error: error?.message || "Unknown error"
      });
    }
  });

  app.post('/api/challenges/:id/onchain/finalize-create', PrivyAuthMiddleware, requireOnchainWallet, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id, 10);
      if (Number.isNaN(challengeId)) {
        return res.status(400).json({ message: "Invalid challenge id" });
      }

      const userId = getUserId(req);
      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }
      if (challenge.challenger !== userId) {
        return res.status(403).json({ message: "Only the challenge creator can finalize this challenge" });
      }
      if (String(challenge.status || "").toLowerCase() !== "draft") {
        return res.status(400).json({ message: "This challenge is not awaiting onchain finalization" });
      }
      if (String(challenge.settlementRail || "").toLowerCase() !== "onchain") {
        return res.status(400).json({ message: "This challenge is not configured for onchain settlement" });
      }
      if (!ONCHAIN_CONFIG.contractEnabled) {
        return res.status(400).json({
          message:
            "Contract execution is disabled. Switch ONCHAIN_EXECUTION_MODE=contract to finalize onchain challenge creation.",
        });
      }

      const chainId = Number(challenge.chainId || ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId);
      const chainConfig =
        ONCHAIN_CONFIG.chains[String(chainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.chainId)];
      if (!chainConfig) {
        return res.status(400).json({ message: "Unsupported chainId for this challenge" });
      }

      const configuredEscrowContract = normalizeEvmAddress(chainConfig.escrowContractAddress);
      if (!configuredEscrowContract) {
        return res.status(500).json({
          message: `Escrow contract not configured for chainId ${chainConfig.chainId}`,
        });
      }

      if (!req.body?.escrowTxHash) {
        return res.status(400).json({ message: "escrowTxHash is required" });
      }

      const creatorWallet = normalizeEvmAddress(req.user.walletAddress);
      if (!creatorWallet) {
        return res.status(403).json({
          message: "Wallet required. Connect an EVM wallet to continue.",
          code: "WALLET_REQUIRED",
        });
      }

      const tokenSymbol = normalizeOnchainTokenSymbol(
        challenge.tokenSymbol || ONCHAIN_CONFIG.defaultToken,
      ) as OnchainTokenSymbol;
      const verifiedEscrowTx = await verifyEscrowTransaction({
        rpcUrl: chainConfig.rpcUrl,
        expectedChainId: chainConfig.chainId,
        expectedFrom: creatorWallet,
        expectedEscrowContract: escrowContract,
        tokenSymbol,
        txHash: String(req.body.escrowTxHash),
      });

      const alreadyUsed = await findChallengeUsingEscrowTxHash(verifiedEscrowTx.txHash, challengeId);
      if (alreadyUsed) {
        return res.status(409).json({
          message: "This escrow transaction hash has already been used for another challenge.",
          challengeId: alreadyUsed.id,
        });
      }

      const finalStatus =
        challenge.challenged || (challenge as any).challengedWalletAddress ? "pending" : "open";

      const updatedChallenge = await storage.updateChallenge(challengeId, {
        status: finalStatus as any,
        escrowTxHash: verifiedEscrowTx.txHash,
      } as any);
      const bantCreditReward = await awardChallengeCreationBantCreditAndNotify({
        userId,
        challenge: updatedChallenge,
        marketSize: parseFloat(String(updatedChallenge.amount || challenge.amount || 0)) || 0,
      });

      await storage.recordChallengeEscrowHold(
        challengeId,
        parseFloat(String(updatedChallenge.amount || challenge.amount || 0)) || 0,
      );

      const challenger = await storage.getUser(userId);
      const challenged = updatedChallenge.challenged
        ? await storage.getUser(updatedChallenge.challenged)
        : null;
      const challengeMeta = {
        chainId: updatedChallenge.chainId ?? chainId,
        settlementRail: updatedChallenge.settlementRail ?? "onchain",
        tokenSymbol: updatedChallenge.tokenSymbol ?? tokenSymbol,
        escrowTxHash: updatedChallenge.escrowTxHash ?? verifiedEscrowTx.txHash,
        settleTxHash: updatedChallenge.settleTxHash ?? null,
      };
      const challengeScanUrl = getChallengeScanUrl(challengeMeta, verifiedEscrowTx.txHash);
      const telegramBot = getTelegramBot();

      try {
        const metadataPayload = {
          version: 1,
          challengeId: updatedChallenge.id,
          chainId: Number(challengeMeta.chainId || chainConfig.chainId),
          escrowTxHash: challengeMeta.escrowTxHash ?? null,
          challengerWallet: creatorWallet,
          challengerUserId: updatedChallenge.challenger ?? null,
          challengedUserId: updatedChallenge.challenged ?? null,
          challengedWalletAddress: updatedChallenge.challengedWalletAddress ?? null,
          title: updatedChallenge.title,
          description: updatedChallenge.description ?? null,
          category: updatedChallenge.category,
          amount: parseFloat(String(updatedChallenge.amount || 0)) || 0,
          challengerSide: updatedChallenge.challengerSide ?? null,
          dueDate: updatedChallenge.dueDate ? new Date(updatedChallenge.dueDate).toISOString() : null,
          settlementRail: updatedChallenge.settlementRail ?? "onchain",
          tokenSymbol: updatedChallenge.tokenSymbol ?? tokenSymbol,
          tokenAddress: updatedChallenge.tokenAddress ?? chainConfig.tokens[tokenSymbol]?.address ?? null,
          decimals: Number(updatedChallenge.decimals ?? chainConfig.tokens[tokenSymbol]?.decimals ?? 0) || null,
          stakeAtomic: updatedChallenge.stakeAtomic ?? null,
          adminCreated: updatedChallenge.adminCreated ?? false,
          createdAt: updatedChallenge.createdAt ? new Date(updatedChallenge.createdAt).toISOString() : null,
        };

        const metadataRecord = await upsertOnchainChallengeMetadata({
          payload: metadataPayload,
          chainId: metadataPayload.chainId,
          escrowTxHash: metadataPayload.escrowTxHash,
          challengeId: updatedChallenge.id,
        });

        const metadataLoggerEnabled = String(process.env.ONCHAIN_METADATA_LOGGER_ENABLED || "")
          .trim()
          .toLowerCase();
        const shouldLogMetadata =
          metadataLoggerEnabled === "true" ||
          metadataLoggerEnabled === "1" ||
          metadataLoggerEnabled === "yes";

        if (shouldLogMetadata && metadataPayload.escrowTxHash) {
          await logOnchainChallengeCreated({
            chain: chainConfig,
            metadataHash: metadataRecord.metadataHash,
            challengeId: updatedChallenge.id,
            challengeType: "challenge",
          });
        }
      } catch (metadataError) {
        console.error("⚠️ Failed to persist/log onchain metadata:", metadataError);
      }

      if (updatedChallenge.challenged && challenged) {
        const challengedNotification = await storage.createNotification({
          userId: updatedChallenge.challenged,
          type: 'challenge',
          title: '🎯 New Challenge Request',
          message: `${challenger?.firstName || challenger?.username || 'Someone'} challenged you to "${updatedChallenge.title}"`,
          data: {
            challengeId: updatedChallenge.id,
            challengerName: challenger?.firstName || challenger?.username,
            challengeTitle: updatedChallenge.title,
            amount: updatedChallenge.amount,
            category: updatedChallenge.category,
            chainId: challengeMeta.chainId,
            settlementRail: challengeMeta.settlementRail,
            tokenSymbol: challengeMeta.tokenSymbol,
            scanUrl: challengeScanUrl,
            explorerUrl: challengeScanUrl,
          },
        });

        try {
          await pusher.trigger(`user-${updatedChallenge.challenged}`, 'challenge-received', {
            id: challengedNotification.id,
            type: 'challenge_received',
            title: '🎯 Challenge Received!',
            message: `${challenger?.firstName || challenger?.username || 'Someone'} challenged you to "${updatedChallenge.title}"`,
            challengerName: challenger?.firstName || challenger?.username || 'Someone',
            challengeTitle: updatedChallenge.title,
            amount: parseFloat(updatedChallenge.amount.toString()),
            challengeId: updatedChallenge.id,
            data: challengedNotification.data,
            scanUrl: challengeScanUrl,
            timestamp: new Date().toISOString(),
          });
        } catch (pusherError) {
          console.error("Error sending Pusher notification to challenged user:", pusherError);
        }
      }

      const challengerNotification = await storage.createNotification({
        userId,
        type: 'challenge_sent',
        title: '🚀 Challenge Sent',
        message: `Your challenge "${updatedChallenge.title}" was sent to ${challenged?.firstName || challenged?.username || 'Open Challenge'}`,
        data: {
          challengeId: updatedChallenge.id,
          challengedName: challenged?.firstName || challenged?.username || 'Open Challenge',
          challengeTitle: updatedChallenge.title,
          amount: updatedChallenge.amount,
          category: updatedChallenge.category,
          chainId: challengeMeta.chainId,
          settlementRail: challengeMeta.settlementRail,
          tokenSymbol: challengeMeta.tokenSymbol,
          scanUrl: challengeScanUrl,
          explorerUrl: challengeScanUrl,
        },
      });

      try {
        await pusher.trigger(`user-${userId}`, 'challenge-sent', {
          id: challengerNotification.id,
          type: 'challenge_sent',
          title: '🚀 Challenge Sent',
          message: `Your challenge "${updatedChallenge.title}" was sent to ${challenged?.firstName || challenged?.username || 'Open Challenge'}`,
          data: challengerNotification.data,
          scanUrl: challengeScanUrl,
          timestamp: new Date().toISOString(),
        });
      } catch (pusherError) {
        console.error("Error sending Pusher notification to challenger:", pusherError);
      }

      try {
        const { notifyChallengeCreated } = await import('./challengeNotifications');
        await notifyChallengeCreated(
          updatedChallenge.id,
          challenger?.firstName || challenger?.username || 'Unknown',
          updatedChallenge.challenged,
          updatedChallenge.title,
          parseFloat(updatedChallenge.amount)
        );
      } catch (notifErr) {
        console.error('Error sending challenge created notification:', notifErr);
      }

      if (telegramBot) {
        try {
          const stakeBroadcastMeta = buildChallengeStakeBroadcastMeta(updatedChallenge);
          await telegramBot.broadcastChallenge({
            id: updatedChallenge.id,
            title: updatedChallenge.title,
            description: updatedChallenge.description || undefined,
            creator: {
              name: challenger?.firstName || challenger?.username || 'Unknown',
              username: challenger?.username || undefined,
            },
            challenged: {
              name: challenged?.firstName || challenged?.username || 'Open Challenge',
              username: challenged?.username || undefined,
            },
            stake_amount: parseFloat(updatedChallenge.amount.toString()),
            stake_display: stakeBroadcastMeta.stakeDisplay,
            settlement_label: stakeBroadcastMeta.settlementLabel,
            status: updatedChallenge.status,
            end_time: updatedChallenge.dueDate,
            category: updatedChallenge.category,
          });
        } catch (error) {
          console.error("❌ Failed to broadcast finalized challenge to Telegram:", error);
        }
      }

      res.setHeader("x-onchain-execution-mode", ONCHAIN_CONFIG.executionMode);
      res.json({
        ...updatedChallenge,
        bantCreditReward,
        onchainExecution: {
          mode: ONCHAIN_CONFIG.executionMode,
          contractEnabled: ONCHAIN_CONFIG.contractEnabled,
        },
      });
    } catch (error: any) {
      console.error("Error finalizing onchain challenge creation:", error);
      res.status(500).json({
        message: "Failed to finalize onchain challenge creation",
        error: error?.message || "Unknown error",
      });
    }
  });

  // Edit challenge endpoint
  app.put('/api/challenges/:id', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = req.user?.id || req.user?.claims?.sub;

      // Check if challenge exists and user is the challenger
      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      if (challenge.challenger !== userId) {
        return res.status(403).json({ message: "Only the challenger can edit this challenge" });
      }

      // Check if challenge can still be edited (before it starts)
      const editableChallengeStatuses = new Set(['pending', 'open']);
      if (!editableChallengeStatuses.has(String(challenge.status || '').toLowerCase())) {
        return res.status(400).json({ message: "Cannot edit challenge that has started or completed" });
      }

      // Validate required fields
      if (!req.body.title || !req.body.amount) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Convert amount to proper integer format
      const amount = parseInt(req.body.amount);
      if (isNaN(amount) || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      const updates = {
        title: req.body.title,
        description: req.body.description || null,
        amount: amount,
      };

      const updatedChallenge = await storage.updateChallenge(challengeId, updates);
      res.json(updatedChallenge);
    } catch (error) {
      console.error("Error updating challenge:", error);
      res.status(500).json({ message: "Failed to update challenge" });
    }
  });

  // Decline/Cancel challenge endpoint
  app.patch('/api/challenges/:id', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = getUserId(req);
      const { status } = req.body;

      // Only allow cancelling to 'cancelled' status for now
      if (status !== 'cancelled') {
        return res.status(400).json({ message: "Only 'cancelled' status is allowed" });
      }

      // Get challenge
      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      // Check if user is either challenger or challenged
      if (challenge.challenger !== userId && challenge.challenged !== userId) {
        return res.status(403).json({ message: "You don't have permission to decline this challenge" });
      }

      // Check if challenge can be cancelled (must be pending - not yet accepted)
      if (challenge.status !== 'pending') {
        return res.status(400).json({ message: "Can only decline pending (not yet accepted) challenges" });
      }

      // Get user info for notifications
      const currentUser = await storage.getUser(userId);

      // Update challenge status to cancelled
      const updatedChallenge = await storage.updateChallenge(challengeId, { status: 'cancelled' });

      // Refund the challenger's escrow if offchain
      const isOnchainChallenge = String(challenge.settlementRail || "").toLowerCase() === "onchain";
      if (!isOnchainChallenge && challenge.amount) {
        const refundAmount = parseFloat(challenge.amount.toString());
        if (refundAmount > 0) {
          await storage.updateUserBalance(challenge.challenger, refundAmount);
          await storage.createTransaction({
            userId: challenge.challenger,
            type: 'refund',
            amount: refundAmount.toString(),
            description: `Refund for declined challenge: ${challenge.title}`,
            relatedId: challengeId,
            status: 'completed',
          });
        }
      }

      // Send notifications
      if (userId === challenge.challenged) {
        const { notifyChallengeDeclined } = await import('./challengeNotifications');
        await notifyChallengeDeclined(
          challengeId,
          challenge.challenger,
          currentUser?.firstName || currentUser?.username || 'Unknown'
        );
      } else {
        const { notifyChallengeCancelled } = await import('./challengeNotifications');
        await notifyChallengeCancelled(
          challengeId,
          currentUser?.firstName || currentUser?.username || 'Unknown',
          challenge.challenger,
          challenge.challenged,
          challenge.title
        );
      }

      // Send real-time notification via Pusher
      try {
        const otherUserId = userId === challenge.challenger ? challenge.challenged : challenge.challenger;
        const eventType = userId === challenge.challenger ? 'challenger_declined' : 'challenged_declined';
        
        await pusher.trigger(`user-${otherUserId}`, eventType, {
          id: Date.now(),
          type: 'challenge_cancelled',
          title: '❌ Challenge Declined',
          message: `${currentUser?.firstName || currentUser?.username} declined the challenge "${challenge.title}".`,
          data: { challengeId: challengeId },
          timestamp: new Date().toISOString(),
        });
      } catch (pusherError) {
        console.error("Error sending Pusher notification:", pusherError);
      }

      res.json(updatedChallenge);
    } catch (error) {
      console.error("Error declining challenge:", error);
      res.status(500).json({ message: error instanceof Error ? error.message : "Failed to decline challenge" });
    }
  });

  app.post('/api/challenges/:id/accept', PrivyAuthMiddleware, requireOnchainWallet, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = getUserId(req);
      const challengeData = await storage.getChallengeById(challengeId);
      if (!challengeData) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      if (challengeData.adminCreated && challengeData.status === 'open') {
        return res.status(400).json({
          message: "Admin challenges require a YES/NO side selection. Use the admin join flow.",
        });
      }

      const targetWallet = normalizeEvmAddress((challengeData as any).challengedWalletAddress);
      if (targetWallet && !challengeData.challenged) {
        const currentWallet = normalizeEvmAddress(req.user.walletAddress);
        if (!currentWallet || currentWallet !== targetWallet) {
          return res.status(403).json({
            message: "Only the targeted wallet address can accept this challenge.",
            code: "WALLET_NOT_TARGETED",
            challengedWalletAddress: targetWallet,
          });
        }
      }

      const isOnchainChallenge =
        String(challengeData.settlementRail || "").toLowerCase() === "onchain";
      let acceptEscrowTxHash: string | null = null;

      if (isOnchainChallenge && ONCHAIN_CONFIG.contractEnabled) {
        const chainId = Number(
          challengeData.chainId || ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId,
        );
        const chainConfig =
          ONCHAIN_CONFIG.chains[String(chainId)] ||
          ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)] ||
          ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.chainId)];

        if (!chainConfig) {
          return res.status(400).json({ message: "Unsupported chainId for onchain challenge" });
        }

        const escrowContract = normalizeEvmAddress(chainConfig.escrowContractAddress);
        if (!escrowContract) {
          return res.status(500).json({
            message: `Escrow contract not configured for chainId ${chainConfig.chainId}`,
          });
        }

        const participantWallet = normalizeEvmAddress(req.user.walletAddress);
        if (!participantWallet) {
          return res.status(403).json({
            message: "Wallet required. Connect an EVM wallet to continue.",
            code: "WALLET_REQUIRED",
          });
        }

        if (!req.body?.escrowTxHash) {
          return res.status(400).json({
            message:
              "escrowTxHash is required in contract mode. Send the wallet escrow transaction hash.",
          });
        }

        const tokenSymbol = normalizeOnchainTokenSymbol(
          challengeData.tokenSymbol || ONCHAIN_CONFIG.defaultToken,
        ) as OnchainTokenSymbol;
        const tokenConfig = chainConfig.tokens[tokenSymbol];
        if (!tokenConfig || !isSupportedOnchainToken(chainConfig, tokenSymbol)) {
          return res.status(400).json({ message: "Unsupported token for this challenge" });
        }
        if (!tokenConfig.isNative) {
          const resolvedTokenAddress = normalizeEvmAddress(
            challengeData.tokenAddress || tokenConfig.address,
          );
          if (!resolvedTokenAddress) {
            return res.status(400).json({
              message: `Token ${tokenSymbol} is not configured on chainId ${chainConfig.chainId}.`,
            });
          }
          try {
            await assertAllowedStakeToken({
              rpcUrl: chainConfig.rpcUrl,
              tokenAddress: resolvedTokenAddress,
              tokenSymbol,
            });
          } catch (tokenError: any) {
            return res.status(400).json({
              message:
                tokenError?.message ||
                `Token ${tokenSymbol} is not allowed for onchain challenge staking.`,
            });
          }
        }

        const verifiedEscrowTx = await verifyEscrowTransaction({
          rpcUrl: chainConfig.rpcUrl,
          expectedChainId: chainConfig.chainId,
          expectedFrom: participantWallet,
          expectedEscrowContract: escrowContract,
          tokenSymbol,
          txHash: String(req.body.escrowTxHash),
        });

        const alreadyUsed = await findChallengeUsingEscrowTxHash(
          verifiedEscrowTx.txHash,
          challengeId,
        );
        if (alreadyUsed) {
          return res.status(409).json({
            message: "This escrow transaction hash has already been used for another challenge.",
            challengeId: alreadyUsed.id,
          });
        }

        acceptEscrowTxHash = verifiedEscrowTx.txHash;
      }

      let challenge = await storage.acceptChallenge(challengeId, userId);

      // Generate a battle ID for the 2D Arena Battle
      const crypto = await import('crypto');
      const generatedBattleId = crypto.randomUUID();

      if (acceptEscrowTxHash || generatedBattleId) {
        const mergedEscrowHashes = acceptEscrowTxHash ? mergeEscrowTxHashes(challenge.escrowTxHash, acceptEscrowTxHash) : challenge.escrowTxHash;
        challenge = await storage.updateChallenge(challengeId, {
          escrowTxHash: mergedEscrowHashes,
          battleId: generatedBattleId,
        } as any);
      }

      // Get user info for notifications
      const challenger = await storage.getUser(challenge.challenger);
      const challenged = await storage.getUser(challenge.challenged);
      const acceptScanUrl = getChallengeScanUrl(challenge, acceptEscrowTxHash);

      // Send the specialized Challenge Accepted notification
      try {
        const { notifyChallengeAccepted } = await import('./challengeNotifications');
        await notifyChallengeAccepted(
          challengeId,
          challenge.challenger,
          challenged?.firstName || challenged?.username || 'Unknown',
          generatedBattleId
        );
      } catch (notifErr) {
        console.error('Error sending challenge accepted notification:', notifErr);
      }

      // Also notify the challenged user
      await storage.createNotification({
        userId: challenge.challenged,
        type: 'challenge_active',
        title: '🔒 Challenge Active',
        message:
          String(challenge.settlementRail || "").toLowerCase() === "onchain"
            ? `Your stake of ${parseFloat(challenge.amount).toLocaleString()} ${String(challenge.tokenSymbol || "ETH").toUpperCase()} is now locked in escrow for "${challenge.title}". Good luck!`
            : `Your stake of ₦${parseFloat(challenge.amount).toLocaleString()} has been escrowed for challenge "${challenge.title}". Good luck!`,
        data: { 
          challengeId: challengeId,
          challengeTitle: challenge.title,
          amount: parseFloat(challenge.amount),
          chainId: challenge.chainId,
          settlementRail: challenge.settlementRail,
          tokenSymbol: challenge.tokenSymbol,
          scanUrl: acceptScanUrl,
          explorerUrl: acceptScanUrl,
        },
      });

      // Send real-time notifications via Pusher
      try {
        await pusher.trigger(`user-${challenge.challenger}`, 'challenge-accepted', {
          id: Date.now(),
          type: 'challenge_accepted',
          title: '🎯 Challenge Accepted!',
          message: `${challenged?.firstName || challenged?.username} accepted your challenge "${challenge.title}"!`,
          data: { challengeId: challengeId },
          scanUrl: acceptScanUrl,
          timestamp: new Date().toISOString(),
        });

        await pusher.trigger(`user-${challenge.challenged}`, 'challenge-active', {
          id: Date.now(),
          type: 'challenge_active',
          title: '🔒 Challenge Active',
          message: `Challenge "${challenge.title}" is now active! Your funds are secured in escrow.`,
          data: { challengeId: challengeId },
          scanUrl: acceptScanUrl,
          timestamp: new Date().toISOString(),
        });
      } catch (pusherError) {
        console.error("Error sending Pusher notifications:", pusherError);
      }

      // Broadcast matchmaking (challenge accepted) to Telegram
      try {
        const telegramBot = getTelegramBot();
        if (telegramBot) {
          await telegramBot.broadcastMatchmaking({
            challengeId: challenge.id,
            challenger: {
              name: challenger?.firstName || challenger?.username || 'Unknown',
              username: challenger?.username || undefined,
            },
            challenged: {
              name: challenged?.firstName || challenged?.username || 'Unknown',
              username: challenged?.username || undefined,
            },
            stake_amount: parseFloat(challenge.amount),
            category: challenge.type,
          });
          console.log('📤 Challenge acceptance (matchmaking) broadcasted to Telegram successfully');
        }
      } catch (telegramError) {
        console.error('❌ Error broadcasting matchmaking to Telegram:', telegramError);
      }

      res.setHeader("x-onchain-execution-mode", ONCHAIN_CONFIG.executionMode);
      res.json({
        ...challenge,
        onchainExecution: {
          mode: ONCHAIN_CONFIG.executionMode,
          contractEnabled: ONCHAIN_CONFIG.contractEnabled,
        },
      });
    } catch (error) {
      console.error("Error accepting challenge:", error);
      res.status(500).json({ message: error instanceof Error ? error.message : "Failed to accept challenge" });
    }
  });

  // --- New offchain voting / escrow endpoints ---
  app.post('/api/challenges/:id/reserve', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = getUserId(req);
      const amount = parseFloat(req.body.amount);
      if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' });

      const reservation = await storage.reserveStake(challengeId, userId, amount, req.body.paymentMethodId);
      res.json({ success: true, reservation });
    } catch (err: any) {
      console.error('Error reserving stake:', err);
      res.status(500).json({ message: err.message || 'Failed to reserve stake' });
    }
  });

  app.get('/api/challenges/:id/proofs', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = getUserId(req);
      if (Number.isNaN(challengeId)) {
        return res.status(400).json({ message: 'Invalid challenge id' });
      }

      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: 'Challenge not found' });
      }

      const isParticipant = userId === challenge.challenger || userId === challenge.challenged;
      if (!isParticipant) {
        return res.status(403).json({ message: 'Only participants can view proofs' });
      }

      const proofs = await storage.getChallengeProofs(challengeId);
      res.json(proofs);
    } catch (err: any) {
      console.error('Error fetching challenge proofs:', err);
      res.status(500).json({ message: err.message || 'Failed to fetch proofs' });
    }
  });

  app.get('/api/challenges/:id/votes', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id, 10);
      const userId = getUserId(req);
      if (Number.isNaN(challengeId)) {
        return res.status(400).json({ message: 'Invalid challenge id' });
      }

      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: 'Challenge not found' });
      }

      const requester = await storage.getUser(userId);
      const isParticipant = userId === challenge.challenger || userId === challenge.challenged;
      if (!isParticipant && !requester?.isAdmin) {
        return res.status(403).json({ message: 'Only participants can view votes' });
      }

      const votes = await storage.getChallengVotes(challengeId);
      const normalizedVotes = (votes || [])
        .map((vote: any) => {
          const participantId = String(
            vote?.participant_id ?? vote?.participantId ?? vote?.user_id ?? vote?.userId ?? '',
          ).trim();
          if (!participantId) return null;

          const choiceRaw = String(
            vote?.vote_choice ?? vote?.voteChoice ?? vote?.choice ?? '',
          ).trim().toLowerCase();
          const choice =
            choiceRaw === 'creator' || choiceRaw === 'challenger'
              ? 'challenger'
              : choiceRaw === 'opponent' || choiceRaw === 'challenged'
                ? 'challenged'
                : null;
          if (!choice) return null;

          return {
            userId: participantId,
            choice,
            timestamp: vote?.submitted_at ?? vote?.submittedAt ?? vote?.timestamp ?? null,
            proofHash: vote?.proof_hash ?? vote?.proofHash ?? null,
          };
        })
        .filter(Boolean);

      res.json(normalizedVotes);
    } catch (err: any) {
      console.error('Error fetching challenge votes:', err);
      res.status(500).json({ message: err.message || 'Failed to fetch challenge votes' });
    }
  });

  app.post('/api/challenges/:id/proofs', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = getUserId(req);
      const { proofUri, proofHash } = req.body;
      if (!proofUri || !proofHash) return res.status(400).json({ message: 'Missing proofUri or proofHash' });

      const proof = await storage.createProof(challengeId, userId, proofUri, proofHash);

      // Send notification to counterparty
      try {
        const challenge = await storage.getChallengeById(challengeId);
        const user = await storage.getUser(userId);
        const counterpartyId = userId === challenge.challenger ? challenge.challenged : challenge.challenger;
        
        if (counterpartyId) {
          const { notifyProofUploaded } = await import('./challengeNotifications');
          await notifyProofUploaded(challengeId, userId, counterpartyId, user?.firstName || user?.username || 'Unknown');
        }
      } catch (notifErr) {
        console.error('Error sending proof uploaded notification:', notifErr);
      }

      res.status(201).json(proof);
    } catch (err: any) {
      console.error('Error uploading proof:', err);
      res.status(500).json({ message: err.message || 'Failed to upload proof' });
    }
  });

  app.post('/api/challenges/:id/vote', PrivyAuthMiddleware, requireOnchainWallet, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = getUserId(req);
      const { voteChoice, proofHash, signedVote } = req.body;
      if (!voteChoice || !proofHash || !signedVote) return res.status(400).json({ message: 'Missing voteChoice, proofHash or signedVote' });

      // Verify signature using user's registered public key (tweetnacl)
      const user = await storage.getUser(userId);
      const pubkeyBase64 = (user as any)?.signing_pubkey;
      if (!pubkeyBase64) return res.status(400).json({ message: 'No signing public key registered for user' });

      try {
        const nacl = await import('tweetnacl');
        const util = await import('tweetnacl-util');
        const publicKey = util.decodeBase64(pubkeyBase64);

        // Expect signedVote to be base64 signature and message included in body
        const { signature, timestamp, nonce } = JSON.parse(signedVote);
        if (!signature || !timestamp || !nonce) return res.status(400).json({ message: 'Invalid signedVote format' });

        // Reject votes older than 10 minutes (prevent delayed replay)
        const tsNum = Number(timestamp);
        if (Number.isNaN(tsNum)) return res.status(400).json({ message: 'Invalid timestamp in signedVote' });
        const TEN_MIN = 10 * 60 * 1000;
        if (Math.abs(Date.now() - tsNum) > TEN_MIN) {
          return res.status(400).json({ message: 'Signed vote timestamp outside allowed window' });
        }

        const message = `${challengeId}:${voteChoice}:${proofHash}:${timestamp}:${nonce}`;
        const messageBytes = new TextEncoder().encode(message);
        const sigBytes = util.decodeBase64(signature);

        const verified = nacl.sign.detached.verify(messageBytes, sigBytes, publicKey);
        if (!verified) return res.status(400).json({ message: 'Invalid signature' });

        // Prevent replay: check nonce uniqueness (simple check using challenge_votes.vote_nonce)
        const { pool } = await import('./db');
        const nonceCheck: any = await pool.query('SELECT 1 FROM challenge_votes WHERE challenge_id = $1 AND vote_nonce = $2 LIMIT 1', [challengeId, nonce]);
        if (nonceCheck.rows && nonceCheck.rows.length > 0) {
          return res.status(400).json({ message: 'Nonce already used' });
        }

        const vote = await storage.submitVote(challengeId, userId, voteChoice, proofHash, signedVote);
        // store nonce in the vote record (update); handle unique constraint gracefully
        try {
          await pool.query('UPDATE challenge_votes SET vote_nonce = $1 WHERE challenge_id = $2 AND participant_id = $3', [nonce, challengeId, userId]);
        } catch (err: any) {
          // Postgres unique violation code
          if (err && err.code === '23505') {
            return res.status(400).json({ message: 'Nonce already used' });
          }
          throw err;
        }

        // Send notification to counterparty
        try {
          const challenge = await storage.getChallengeById(challengeId);
          const user = await storage.getUser(userId);
          const counterpartyId = userId === challenge.challenger ? challenge.challenged : challenge.challenger;
          
          if (counterpartyId) {
            const { notifyVoteSubmitted } = await import('./challengeNotifications');
            await notifyVoteSubmitted(challengeId, userId, counterpartyId, user?.firstName || user?.username || 'Unknown');
          }
        } catch (notifErr) {
          console.error('Error sending vote submitted notification:', notifErr);
        }

        res.json({ success: true, vote });
      } catch (err: any) {
        console.error('Signature verification error:', err);
        return res.status(500).json({ message: 'Signature verification failed' });
      }
    } catch (err: any) {
      console.error('Error submitting vote:', err);
      res.status(500).json({ message: err.message || 'Failed to submit vote' });
    }
  });

  app.post('/api/challenges/:id/try-release', PrivyAuthMiddleware, requireOnchainWallet, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const result = await storage.tryAutoRelease(challengeId);

      // Send notification if auto-release was successful
      if ((result as any).autoReleased || (result as any).released) {
        try {
          const challenge = await storage.getChallengeById(challengeId);
          const { notifyAutoReleased } = await import('./challengeNotifications');

          const resolvedResult = String(challenge?.result || "").toLowerCase();
          const winnerUserId =
            resolvedResult === "challenger_won"
              ? challenge?.challenger
              : resolvedResult === "challenged_won"
                ? challenge?.challenged
                : null;
          const loserUserId =
            winnerUserId && challenge
              ? (winnerUserId === challenge.challenger ? challenge.challenged : challenge.challenger)
              : null;
          const winAmount = Number(challenge?.amount || 0) * 2;

          if (winnerUserId && loserUserId) {
            await notifyAutoReleased(challengeId, winnerUserId, loserUserId, winAmount);
          }
        } catch (notifErr) {
          console.error('Error sending auto-release notification:', notifErr);
        }
      }

      res.setHeader("x-onchain-execution-mode", ONCHAIN_CONFIG.executionMode);
      res.json({
        ...result,
        onchainExecution: {
          mode: ONCHAIN_CONFIG.executionMode,
          contractEnabled: ONCHAIN_CONFIG.contractEnabled,
        },
      });
    } catch (err: any) {
      console.error('Error trying auto-release:', err);
      res.status(500).json({ message: err.message || 'Failed to try-release' });
    }
  });

  app.post('/api/challenges/:id/onchain/settle', PrivyAuthMiddleware, requireOnchainWallet, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id, 10);
      if (Number.isNaN(challengeId)) {
        return res.status(400).json({ message: "Invalid challenge id" });
      }

      const userId = getUserId(req);
      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      const isParticipant = userId === challenge.challenger || userId === challenge.challenged;
      const requesterUser = await storage.getUser(userId);
      if (!isParticipant && !requesterUser?.isAdmin) {
        return res.status(403).json({ message: "Only participants or admins can record settlement tx" });
      }

      const isOnchainChallenge =
        String(challenge.settlementRail || "").toLowerCase() === "onchain";
      if (!isOnchainChallenge) {
        return res.status(400).json({ message: "This challenge is not configured for onchain settlement" });
      }
      if (!ONCHAIN_CONFIG.contractEnabled) {
        return res.status(400).json({
          message:
            "Contract execution is disabled. Switch ONCHAIN_EXECUTION_MODE=contract to record onchain settlement tx.",
        });
      }

      const chainId = Number(challenge.chainId || ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId);
      const chainConfig =
        ONCHAIN_CONFIG.chains[String(chainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)] ||
        ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.chainId)];
      if (!chainConfig) {
        return res.status(400).json({ message: "Unsupported chainId for this challenge" });
      }

      const escrowContract = normalizeEvmAddress(chainConfig.escrowContractAddress);
      if (!escrowContract) {
        return res.status(500).json({
          message: `Escrow contract not configured for chainId ${chainConfig.chainId}`,
        });
      }

      if (!req.body?.settleTxHash) {
        return res.status(400).json({ message: "settleTxHash is required" });
      }

      const settlementWallet = normalizeEvmAddress(req.user.walletAddress);
      if (!settlementWallet) {
        return res.status(403).json({
          message: "Wallet required. Connect an EVM wallet to continue.",
          code: "WALLET_REQUIRED",
        });
      }

      const tokenSymbol = normalizeOnchainTokenSymbol(
        challenge.tokenSymbol || ONCHAIN_CONFIG.defaultToken,
      ) as OnchainTokenSymbol;
      const escrowRuntime = await resolveChallengeEscrowRuntime({
        challengeLike: challenge,
        chain: chainConfig,
      });
      const expectedSettlementEscrowContract =
        escrowRuntime.escrowContractAddress || configuredEscrowContract;

      const verifiedSettleTx = await verifyEscrowTransaction({
        rpcUrl: chainConfig.rpcUrl,
        expectedChainId: chainConfig.chainId,
        expectedFrom: settlementWallet,
        expectedEscrowContract: expectedSettlementEscrowContract,
        tokenSymbol,
        txHash: String(req.body.settleTxHash),
      });

      const settleTxAlreadyUsed = await findChallengeUsingSettleTxHash(
        verifiedSettleTx.txHash,
        challengeId,
      );
      if (settleTxAlreadyUsed) {
        return res.status(409).json({
          message: "This settlement transaction hash has already been used for another challenge.",
          challengeId: settleTxAlreadyUsed.id,
        });
      }

      const requestedResult = String(req.body?.result || "").trim().toLowerCase();
      const allowedResults = new Set(["challenger_won", "challenged_won", "draw"]);
      const existingSettleTxHash = String(challenge.settleTxHash || "").trim().toLowerCase();
      if (existingSettleTxHash && existingSettleTxHash !== verifiedSettleTx.txHash) {
        return res.status(409).json({
          message: "This challenge already has a different settlement transaction recorded.",
          settleTxHash: challenge.settleTxHash,
        });
      }
      if (
        existingSettleTxHash &&
        existingSettleTxHash === verifiedSettleTx.txHash &&
        String(challenge.status || "").toLowerCase() === "completed"
      ) {
        return res.json({
          challenge,
          result: challenge.result,
          alreadyRecorded: true,
          settlementTx: {
            hash: verifiedSettleTx.txHash,
            chainId: verifiedSettleTx.chainId,
            recordedBy: settlementWallet,
          },
          onchainExecution: {
            mode: ONCHAIN_CONFIG.executionMode,
            contractEnabled: ONCHAIN_CONFIG.contractEnabled,
          },
        });
      }

      const votes = await storage.getChallengVotes(challengeId);
      const normalizedVotes = (votes || [])
        .map((vote: any) =>
          String(vote?.vote_choice ?? vote?.voteChoice ?? vote?.choice ?? "")
            .trim()
            .toLowerCase(),
        )
        .filter((choice: string) => !!choice);
      const normalizedResultFromVotes = normalizedVotes.map((choice) => {
        if (choice === "challenger" || choice === "creator") return "challenger_won";
        if (choice === "challenged" || choice === "opponent") return "challenged_won";
        return null;
      });
      const hasConsensus =
        normalizedResultFromVotes.length >= 2 &&
        normalizedResultFromVotes.every((choice) => choice && choice === normalizedResultFromVotes[0]);
      const consensusResult = hasConsensus
        ? (normalizedResultFromVotes[0] as "challenger_won" | "challenged_won")
        : null;
      const isAdminRequester = !!requesterUser?.isAdmin;

      if (!consensusResult && !isAdminRequester) {
        return res.status(400).json({
          message: "Settlement requires matching participant votes or admin override.",
        });
      }

      if (consensusResult && requestedResult && requestedResult !== consensusResult) {
        return res.status(409).json({
          message: "Requested settlement result does not match vote consensus.",
          consensusResult,
        });
      }

      const nextResult =
        challenge.result ||
        consensusResult ||
        (isAdminRequester && allowedResults.has(requestedResult) ? requestedResult : null);
      if (!nextResult) {
        return res.status(400).json({
          message: "Settlement result is missing. Submit participant consensus or admin result.",
        });
      }

      let payoutExecution:
        | {
            payoutTxHash: string;
            method:
              | "settleChallengeNativePayout"
              | "settleChallengeTokenPayout"
              | "refundChallengeNative"
              | "refundChallengeToken";
            treasuryAddress: string;
          }
        | null = null;

      const eligibleForManagedV2Settlement =
        chainConfig.escrowSupportsChallengeLock === true &&
        !challenge.adminCreated &&
        !!escrowRuntime.escrowContractAddress &&
        escrowRuntime.escrowContractAddress === configuredEscrowContract;

      if (eligibleForManagedV2Settlement) {
        if (!escrowRuntime.challengerWallet || !escrowRuntime.challengedWallet) {
          return res.status(500).json({
            message: "Unable to resolve participant wallets for onchain settlement payout.",
          });
        }

        payoutExecution = await executeManagedChallengeSettlement({
          challengeLike: challenge,
          chain: chainConfig,
          tokenSymbol,
          result: nextResult,
          escrowContractAddress: configuredEscrowContract,
          challengerWallet: escrowRuntime.challengerWallet,
          challengedWallet: escrowRuntime.challengedWallet,
        });
      }

      const updates: any = {
        settleTxHash: verifiedSettleTx.txHash,
        result: nextResult,
        status: "completed",
        completedAt: new Date(),
      };

      const updatedChallenge = await storage.updateChallenge(challengeId, updates);

      if (!challenge.result && (nextResult === "challenger_won" || nextResult === "challenged_won")) {
        const winnerAgentId =
          nextResult === "challenger_won" ? challenge.challengerAgentId : challenge.challengedAgentId;
        const loserAgentId =
          nextResult === "challenger_won" ? challenge.challengedAgentId : challenge.challengerAgentId;

        const [winnerRankSnapshot, loserRankSnapshot] = await Promise.all([
          winnerAgentId ? getAgentRankSnapshot(winnerAgentId) : Promise.resolve(null),
          loserAgentId ? getAgentRankSnapshot(loserAgentId) : Promise.resolve(null),
        ]);

        if (winnerAgentId) {
          await storage.recordAgentChallengeOutcome(winnerAgentId, "win");
        }
        if (loserAgentId) {
          await storage.recordAgentChallengeOutcome(loserAgentId, "loss");
        }

        const winnerAgent = winnerAgentId ? await storage.getAgentById(winnerAgentId) : undefined;
        const loserAgent = loserAgentId ? await storage.getAgentById(loserAgentId) : undefined;

        if (winnerAgent) {
          await createAndPushAgentOwnerNotification(winnerAgent, {
            type: "agent_challenge_won",
            title: "Agent won a market",
            message: `${winnerAgent.agentName} won "${challenge.title}".`,
            data: {
              challengeId: challenge.id,
              result: nextResult,
            },
            priority: 3,
            fomoLevel: "high",
          });
          await createAndPushAgentOwnerNotification(winnerAgent, {
            type: "agent_points_earned",
            title: "Agent earned BantCredit",
            message: `${winnerAgent.agentName} earned +${AGENT_WIN_BANTCREDIT_REWARD} BantCredit from "${challenge.title}".`,
            data: {
              challengeId: challenge.id,
              pointsAwarded: AGENT_WIN_BANTCREDIT_REWARD,
              result: nextResult,
            },
            priority: 2,
            fomoLevel: "medium",
          });
          await notifyAgentRankChangeIfNeeded(
            winnerAgent.agentId,
            winnerRankSnapshot?.rank ?? null,
            "market_won",
            { challengeId: challenge.id, result: nextResult },
          );
        }

        if (loserAgent) {
          await createAndPushAgentOwnerNotification(loserAgent, {
            type: "agent_challenge_lost",
            title: "Agent lost a market",
            message: `${loserAgent.agentName} lost "${challenge.title}".`,
            data: {
              challengeId: challenge.id,
              result: nextResult,
            },
            priority: 2,
            fomoLevel: "medium",
          });
          await notifyAgentRankChangeIfNeeded(
            loserAgent.agentId,
            loserRankSnapshot?.rank ?? null,
            "market_lost",
            { challengeId: challenge.id, result: nextResult },
          );
        }
      }
      try {
        await pool.query(
          `INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`,
          [
            String(challengeId),
            String(challenge.status || 'voting'),
            'resolved',
            userId,
            `onchain_settlement tx=${verifiedSettleTx.txHash} result=${nextResult}${payoutExecution ? ` payout=${payoutExecution.payoutTxHash}` : ""}`,
          ],
        );
      } catch (historyError) {
        console.error('Failed to write onchain settlement history:', historyError);
      }

      if (nextResult === "challenger_won" || nextResult === "challenged_won") {
        try {
          const winnerUserId =
            nextResult === "challenger_won" ? challenge.challenger : challenge.challenged;
          const loserUserId =
            nextResult === "challenger_won" ? challenge.challenged : challenge.challenger;
          const winAmount = Number(challenge.amount || 0) * 2;

          if (winnerUserId && loserUserId) {
            const { notifyAutoReleased } = await import("./challengeNotifications");
            await notifyAutoReleased(challengeId, winnerUserId, loserUserId, winAmount);
          }
        } catch (notificationError) {
          console.error("Error sending onchain settlement notification:", notificationError);
        }
      }

      res.setHeader("x-onchain-execution-mode", ONCHAIN_CONFIG.executionMode);
      res.json({
        challenge: updatedChallenge,
        result: nextResult,
        settlementTx: {
          hash: verifiedSettleTx.txHash,
          chainId: verifiedSettleTx.chainId,
          recordedBy: settlementWallet,
        },
        payoutExecution,
        onchainExecution: {
          mode: ONCHAIN_CONFIG.executionMode,
          contractEnabled: ONCHAIN_CONFIG.contractEnabled,
        },
      });
    } catch (err: any) {
      console.error("Error recording onchain settlement tx:", err);
      res.status(500).json({ message: err?.message || "Failed to record onchain settlement tx" });
    }
  });

  app.post('/api/challenges/:id/dispute', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = getUserId(req);
      const reason = req.body.reason || null;
      const dispute = await storage.openDispute(challengeId, userId, reason);

      // Send notification to counterparty
      try {
        const challenge = await storage.getChallengeById(challengeId);
        const user = await storage.getUser(userId);
        const counterpartyId = userId === challenge.challenger ? challenge.challenged : challenge.challenger;
        
        if (counterpartyId) {
          const { notifyDisputeOpened } = await import('./challengeNotifications');
          await notifyDisputeOpened(challengeId, userId, counterpartyId, user?.firstName || user?.username || 'Unknown', reason);
        }
      } catch (notifErr) {
        console.error('Error sending dispute opened notification:', notifErr);
      }

      res.json({ success: true, dispute });
    } catch (err: any) {
      console.error('Error opening dispute:', err);
      res.status(500).json({ message: err.message || 'Failed to open dispute' });
    }
  });

  // Admin endpoints for challenge details
  app.get('/api/admin/challenges/:id/votes', adminAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const votes = await storage.getChallengVotes(challengeId);
      res.json(votes);
    } catch (err: any) {
      console.error('Error fetching challenge votes:', err);
      res.status(500).json({ message: err.message || 'Failed to fetch votes' });
    }
  });

  app.get('/api/admin/challenges/:id/proofs', adminAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const proofs = await storage.getChallengeProofs(challengeId);
      res.json(proofs);
    } catch (err: any) {
      console.error('Error fetching challenge proofs:', err);
      res.status(500).json({ message: err.message || 'Failed to fetch proofs' });
    }
  });

  app.get('/api/admin/challenges/:id/state-history', adminAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const history = await storage.getChallengeStateHistory(challengeId);
      res.json(history);
    } catch (err: any) {
      console.error('Error fetching challenge state history:', err);
      res.status(500).json({ message: err.message || 'Failed to fetch state history' });
    }
  });

  app.get('/api/admin/challenges/:id/messages', adminAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const messages = await storage.getChallengeMessages(challengeId);
      res.json(messages);
    } catch (err: any) {
      console.error('Error fetching challenge messages:', err);
      res.status(500).json({ message: err.message || 'Failed to fetch messages' });
    }
  });

  app.post('/api/admin/challenges/:id/resolve', adminAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const adminId = getUserId(req);
      const resolution = req.body.resolution;
      if (!resolution) return res.status(400).json({ message: 'Missing resolution' });

      const result = await storage.adminResolve(challengeId, resolution, adminId);

      // Send notification to both users
      try {
        const challenge = await storage.getChallengeById(challengeId);
        const { notifyDisputeResolved } = await import('./challengeNotifications');
        
        // Get both user IDs
        const userIds = [challenge.challenger, challenge.challenged];
        
        // Notify both users
        for (const userId of userIds) {
          await notifyDisputeResolved(challengeId, userId, resolution);
        }
      } catch (notifErr) {
        console.error('Error sending dispute resolved notification:', notifErr);
      }

      res.json(result);
    } catch (err: any) {
      console.error('Error resolving dispute (admin):', err);
      res.status(500).json({ message: err.message || 'Failed to resolve dispute' });
    }
  });

  // Register signing public key for vote signatures
  app.post('/api/users/me/signing-key', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { publicKey } = req.body;
      if (!publicKey) return res.status(400).json({ message: 'Missing publicKey' });
      const result = await storage.registerSigningPublicKey(userId, publicKey);
      res.json({ success: true, result });
    } catch (err: any) {
      console.error('Error registering signing key:', err);
      res.status(500).json({ message: err.message || 'Failed to register signing key' });
    }
  });

  // Legacy join endpoint for admin-created challenges (now queue-based)
  app.post("/api/challenges/:id/join", PrivyAuthMiddleware, requireOnchainWallet, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id, 10);
      if (Number.isNaN(challengeId)) {
        return res.status(400).json({ message: "Invalid challenge id" });
      }

      const userId = getUserId(req);
      const stakeRaw = typeof req.body?.stake === "string" ? req.body.stake.toUpperCase() : "";
      if (stakeRaw !== "YES" && stakeRaw !== "NO") {
        return res.status(400).json({ message: "Invalid stake. Must be 'YES' or 'NO'" });
      }

      const challengeData = await storage.getChallengeById(challengeId);
      if (!challengeData) {
        return res.status(404).json({ message: "Challenge not found" });
      }
      if (!challengeData.adminCreated) {
        return res.status(400).json({ message: "This endpoint is only for admin-created challenges" });
      }
      if (challengeData.status !== "open") {
        return res.status(400).json({ message: "Challenge is not open for new entries" });
      }

      const requiredAmount = Number(challengeData.amount || 0);
      if (!Number.isInteger(requiredAmount) || requiredAmount <= 0) {
        return res.status(400).json({ message: "Invalid challenge stake amount" });
      }

      const isOnchainChallenge =
        String(challengeData.settlementRail || "").toLowerCase() === "onchain";
      let joinEscrowTxHash: string | null = null;

      if (isOnchainChallenge && ONCHAIN_CONFIG.contractEnabled) {
        const chainId = Number(
          challengeData.chainId || ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId,
        );
        const chainConfig =
          ONCHAIN_CONFIG.chains[String(chainId)] ||
          ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)] ||
          ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.chainId)];

        if (!chainConfig) {
          return res.status(400).json({ message: "Unsupported chainId for onchain challenge" });
        }

        const escrowContract = normalizeEvmAddress(chainConfig.escrowContractAddress);
        if (!escrowContract) {
          return res.status(500).json({
            message: `Escrow contract not configured for chainId ${chainConfig.chainId}`,
          });
        }

        const participantWallet = normalizeEvmAddress(req.user.walletAddress);
        if (!participantWallet) {
          return res.status(403).json({
            message: "Wallet required. Connect an EVM wallet to continue.",
            code: "WALLET_REQUIRED",
          });
        }

        if (!req.body?.escrowTxHash) {
          return res.status(400).json({
            message:
              "escrowTxHash is required in contract mode. Send the wallet escrow transaction hash.",
          });
        }

        const tokenSymbol = normalizeOnchainTokenSymbol(
          challengeData.tokenSymbol || ONCHAIN_CONFIG.defaultToken,
        ) as OnchainTokenSymbol;
        const tokenConfig = chainConfig.tokens[tokenSymbol];
        if (!tokenConfig) {
          return res.status(400).json({ message: "Unsupported token for this challenge" });
        }
        if (!tokenConfig.isNative) {
          const resolvedTokenAddress = normalizeEvmAddress(
            challengeData.tokenAddress || tokenConfig.address,
          );
          if (!resolvedTokenAddress) {
            return res.status(400).json({
              message: `Token ${tokenSymbol} is not configured on chainId ${chainConfig.chainId}.`,
            });
          }
          try {
            await assertAllowedStakeToken({
              rpcUrl: chainConfig.rpcUrl,
              tokenAddress: resolvedTokenAddress,
              tokenSymbol,
            });
          } catch (tokenError: any) {
            return res.status(400).json({
              message:
                tokenError?.message ||
                `Token ${tokenSymbol} is not allowed for onchain challenge staking.`,
            });
          }
        }

        const verifiedEscrowTx = await verifyEscrowTransaction({
          rpcUrl: chainConfig.rpcUrl,
          expectedChainId: chainConfig.chainId,
          expectedFrom: participantWallet,
          expectedEscrowContract: escrowContract,
          tokenSymbol,
          txHash: String(req.body.escrowTxHash),
        });

        const alreadyUsed = await findChallengeUsingEscrowTxHash(
          verifiedEscrowTx.txHash,
          challengeId,
        );
        if (alreadyUsed) {
          return res.status(409).json({
            message: "This escrow transaction hash has already been used for another challenge.",
            challengeId: alreadyUsed.id,
          });
        }
        joinEscrowTxHash = verifiedEscrowTx.txHash;
      } else {
        const balance = await storage.getUserBalance(userId);
        if (Number(balance.balance) < requiredAmount) {
          return res.status(400).json({ message: "Insufficient balance to join this challenge" });
        }
      }

      const result = await pairingEngine.joinChallenge(
        userId,
        String(challengeId),
        stakeRaw as "YES" | "NO",
        requiredAmount,
      );

      if (!result.success) {
        return res.status(400).json({ message: result.message });
      }

      if (!isOnchainChallenge) {
        await storage.createTransaction({
          userId,
          type: 'challenge_queue_stake',
          amount: `-${requiredAmount}`,
          description: `Challenge queue stake (Challenge #${challengeId}) - ${stakeRaw}`,
          relatedId: challengeId,
          status: 'completed',
        });
      }

      const user = await storage.getUser(userId);
      let updatedChallenge = await storage.getChallengeById(challengeId);
      if (joinEscrowTxHash && updatedChallenge) {
        const mergedEscrowHashes = mergeEscrowTxHashes(
          updatedChallenge.escrowTxHash,
          joinEscrowTxHash,
        );
        if (mergedEscrowHashes !== updatedChallenge.escrowTxHash) {
          updatedChallenge = await storage.updateChallenge(challengeId, {
            escrowTxHash: mergedEscrowHashes,
          } as any);
        }
      }

      try {
        await pusher.trigger('global', 'challenge-joined', {
          type: 'challenge_joined',
          challengeId: challengeId,
          userId: userId,
          username: user?.username,
          firstName: user?.firstName,
          side: stakeRaw,
          status: updatedChallenge?.status || challengeData.status,
          participantCount: Number((updatedChallenge as any)?.participantCount || 0),
          participantPreviewUsers: (updatedChallenge as any)?.participantPreviewUsers || [],
        });
      } catch (error) {
        console.error('Error broadcasting challenge-joined event:', error);
      }

      res.json({
        ...result,
        challenge: updatedChallenge,
        message: result.match
          ? 'Matched! Your stake is now locked in escrow.'
          : `Added to ${stakeRaw} queue. Waiting for an opponent.`,
      });
    } catch (error) {
      console.error("Error joining challenge:", error);
      res.status(500).json({ message: error instanceof Error ? error.message : "Failed to join challenge" });
    }
  });
  app.get('/api/challenges/:id/messages', async (req: Request, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = await getOptionalPrivyUserId(req);

      // Get challenge details
      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      const isAdminChallenge = !!challenge.adminCreated;
      const isParticipant =
        !!userId && (userId === challenge.challenger || userId === challenge.challenged);

      // All non-admin challenges (direct + open) are private.
      // Only participants can access challenge messages.
      if (!isAdminChallenge && !isParticipant) {
        return res.status(403).json({ message: "You don't have access to this private chat" });
      }
      // Admin challenges: public read is allowed (including unauthenticated users).

      // Get all messages for the challenge
      const messages = await storage.getChallengeMessages(challengeId);
      res.json(messages);
    } catch (error) {
      console.error("Error fetching challenge messages:", error);
      res.status(500).json({ message: "Failed to fetch challenge messages" });
    }
  });

  app.post('/api/challenges/:id/messages', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = getUserId(req);
      const { message, type = 'text', evidence } = req.body;

      console.log(`[Messages] Creating message for challenge ${challengeId}, user ${userId}`);

      // Verify challenge exists
      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      const isAdminChallenge = !!challenge.adminCreated;
      const isParticipant = userId === challenge.challenger || userId === challenge.challenged;

      // All non-admin challenges (direct + open) are private.
      // Only participants can post messages.
      if (!isAdminChallenge && !isParticipant) {
        return res.status(403).json({ message: "Only challenge participants can post in this private chat" });
      }
      // Admin challenges: anyone authenticated can post comments.

      const newMessage = await storage.createChallengeMessage(challengeId, userId, message);
      console.log(`[Messages] Message created:`, newMessage.id);

      // Get user info for real-time message
      const user = await storage.getUser(userId);
      const messageWithUser = {
        ...newMessage,
        user: {
          id: user?.id,
          username: user?.username,
          firstName: user?.firstName,
          profileImageUrl: user?.profileImageUrl
        }
      };

      // Send real-time message
      try {
        await pusher.trigger(`challenge-${challengeId}`, 'new-message', {
          message: messageWithUser,
          timestamp: new Date().toISOString(),
        });

        // Also broadcast to global channel so the challenges list can update
        await pusher.trigger('global', 'new-message', {
          type: 'challenge_message',
          challengeId: challengeId,
          message: messageWithUser,
          timestamp: new Date().toISOString(),
        });

        // Send notifications to direct participants if they exist
        if (challenge.challenger && challenge.challenger !== userId) {
          await storage.createNotification({
            userId: challenge.challenger,
            type: 'challenge_message',
            title: '💬 New Challenge Message',
            message: `${user?.firstName || user?.username} sent a message in challenge "${challenge.title}"`,
            data: { 
              challengeId: challengeId,
              challengeTitle: challenge.title,
              messagePreview: message.substring(0, 50) + (message.length > 50 ? '...' : '')
            },
          });
        }
        
        if (challenge.challenged && challenge.challenged !== userId) {
          await storage.createNotification({
            userId: challenge.challenged,
            type: 'challenge_message',
            title: '💬 New Challenge Message',
            message: `${user?.firstName || user?.username} sent a message in challenge "${challenge.title}"`,
            data: { 
              challengeId: challengeId,
              challengeTitle: challenge.title,
              messagePreview: message.substring(0, 50) + (message.length > 50 ? '...' : '')
            },
          });
        }
      } catch (pusherError) {
        console.error("Error sending real-time message:", pusherError);
      }

      res.json(messageWithUser);
    } catch (error) {
      console.error("Error creating challenge message:", error);
      res.status(500).json({ message: "Failed to create message" });
    }
  });

  // Friend routes
  app.get('/api/friends', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const friendsList = await storage.getFriends(userId);
      res.json(friendsList);
    } catch (error) {
      console.error("Error fetching friends:", error);
      res.status(500).json({ message: "Failed to fetch friends" });
    }
  });

  app.get('/api/friends/requests', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const requests = await db
        .select({
          friend: friends,
          requester: users,
        })
        .from(friends)
        .leftJoin(users, eq(friends.requesterId, users.id))
        .where(
          and(
            eq(friends.addresseeId, userId),
            eq(friends.status, "pending")
          )
        );
      res.json(requests);
    } catch (error) {
      console.error("Error fetching friend requests:", error);
      res.status(500).json({ message: "Failed to fetch friend requests" });
    }
  });

  app.post('/api/friends/request/:addresseeId', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const requesterId = getUserId(req);
      const addresseeId = req.params.addresseeId;
      const request = await storage.sendFriendRequest(requesterId, addresseeId);
      res.json(request);
    } catch (error) {
      console.error("Error sending friend request:", error);
      res.status(500).json({ message: "Failed to send friend request" });
    }
  });

  app.post('/api/friends/accept/:requestId', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const requestId = parseInt(req.params.requestId);
      const friend = await storage.acceptFriendRequest(requestId);
      res.json(friend);
    } catch (error) {
      console.error("Error accepting friend request:", error);
      res.status(500).json({ message: "Failed to accept friend request" });
    }
  });

  app.post('/api/friends/decline/:requestId', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const requestId = parseInt(req.params.requestId);
      await db.delete(friends).where(eq(friends.id, requestId));
      res.json({ success: true });
    } catch (error) {
      console.error("Error declining friend request:", error);
      res.status(500).json({ message: "Failed to decline friend request" });
    }
  });

  // Notification routes
  app.get('/api/notifications', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const rawNotifications = await storage.getNotifications(userId);
      const challengeTypes = new Set([
        "challenge",
        "challenge_received",
        "challenge_sent",
        "challenge_accepted",
        "challenge_active",
        "challenge_message",
        "challenge_joined",
      ]);
      const challengeCache = new Map<number, any | null>();

      const enrichedNotifications = await Promise.all(
        (Array.isArray(rawNotifications) ? rawNotifications : []).map(async (notification: any) => {
          if (!challengeTypes.has(String(notification?.type || ""))) {
            return notification;
          }

          const notificationData = parseNotificationData(notification?.data) || {};
          if (notificationData.scanUrl || notificationData.explorerUrl) {
            return notification;
          }

          const challengeId = getNotificationChallengeId(notification, notificationData);
          if (!challengeId) {
            return notification;
          }

          let challengeMeta = challengeCache.get(challengeId);
          if (typeof challengeMeta === "undefined") {
            challengeMeta = await storage.getChallengeById(challengeId);
            challengeCache.set(challengeId, challengeMeta || null);
          }
          if (!challengeMeta) {
            return notification;
          }

          const scanUrl = getChallengeScanUrl(challengeMeta);
          if (!scanUrl) {
            return notification;
          }

          return {
            ...notification,
            data: {
              ...notificationData,
              challengeId: notificationData.challengeId ?? challengeId,
              chainId: notificationData.chainId ?? challengeMeta.chainId ?? null,
              settlementRail:
                notificationData.settlementRail ??
                challengeMeta.settlementRail ??
                null,
              tokenSymbol: notificationData.tokenSymbol ?? challengeMeta.tokenSymbol ?? null,
              scanUrl,
              explorerUrl: notificationData.explorerUrl || scanUrl,
            },
          };
        }),
      );

      res.json(enrichedNotifications);
    } catch (error) {
      console.error("Error fetching notifications:", error);
      res.status(500).json({ message: "Failed to fetch notifications" });
    }
  });

  app.patch('/api/notifications/:id/read', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const notificationId = req.params.id;
      const notification = await storage.markNotificationRead(notificationId);
      res.json(notification);
    } catch (error) {
      console.error("Error marking notification as read:", error);
      res.status(500).json({ message: "Failed to mark notification as read" });
    }
  });

  // Treasury Notification Endpoints
  app.get('/api/notifications/treasury', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const treasuryEvents = ['match.found', 'challenge.settled', 'admin.treasury.match_created', 'admin.treasury.settlement'];
      
      const notifs = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            sql`${notifications.event} IN (${sql.join(treasuryEvents)})`
          )
        )
        .orderBy(sql`${notifications.createdAt} DESC`)
        .limit(100);

      res.json(notifs);
    } catch (error) {
      console.error("Error fetching Treasury notifications:", error);
      res.status(500).json({ message: "Failed to fetch Treasury notifications" });
    }
  });

  app.get('/api/notifications/unread-count', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const count = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.read, false)
          )
        );

      res.json({ count: count.length, unreadCount: count.length });
    } catch (error) {
      console.error("Error fetching unread count:", error);
      res.status(500).json({ message: "Failed to fetch unread count" });
    }
  });

  app.delete('/api/notifications/:id', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const notificationId = req.params.id;
      const userId = getUserId(req);

      // Verify ownership
      const notif = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .limit(1);

      if (!notif.length || notif[0].userId !== userId) {
        return res.status(403).json({ message: "Unauthorized" });
      }

      await db
        .delete(notifications)
        .where(eq(notifications.id, notificationId));

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting notification:", error);
      res.status(500).json({ message: "Failed to delete notification" });
    }
  });

  // ========================================
  // BOTA (Battle of the Agents) Notifications
  // ========================================

  /**
   * GET /api/bantahbro/notifications
   * Fetch BOTA activity notifications for authenticated user
   */
  app.get('/api/bantahbro/notifications', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      // Fetch notifications for user's agents
      const botaNotifs = await db
        .select()
        .from(notifications)
        .where(and(
          eq(notifications.userId, userId),
          eq(notifications.type, 'bota_activity')
        ))
        .orderBy(notifications.createdAt)
        .limit(limit)
        .offset(offset);

      res.json(botaNotifs);
    } catch (error) {
      console.error('Error fetching BOTA notifications:', error);
      res.status(500).json({ error: 'Failed to fetch notifications' });
    }
  });

  /**
   * POST /api/bantahbro/notifications
   * Create test notification (dev only)
   */
  app.post('/api/bantahbro/notifications', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { eventType, agentName, agentId, opponentName, earnedBC, earnedUSDT, battleId, metadata } = req.body;

      if (!eventType || !agentName || !agentId) {
        return res.status(400).json({ error: 'Missing required fields: eventType, agentName, agentId' });
      }

      const notificationData: Record<string, any> = {
        eventType,
        agentName,
        agentId,
        timestamp: new Date().toISOString(),
        read: false,
      };

      if (opponentName) notificationData.opponentName = opponentName;
      if (earnedBC) notificationData.earnedBC = earnedBC;
      if (earnedUSDT) notificationData.earnedUSDT = earnedUSDT;
      if (battleId) notificationData.battleId = battleId;
      if (metadata) Object.assign(notificationData, metadata);

      const newNotif = await db
        .insert(notifications)
        .values({
          userId,
          type: 'bota_activity',
          title: `[${eventType.toUpperCase()}] ${agentName}`,
          message: `Agent activity: ${eventType}`,
          data: notificationData,
          read: false,
          createdAt: new Date(),
        })
        .returning();

      res.json(newNotif[0]);
    } catch (error) {
      console.error('Error creating notification:', error);
      res.status(500).json({ error: 'Failed to create notification' });
    }
  });

  /**
   * POST /api/bantahbro/notifications/test-create
   * Create test notifications (no auth required)
   */
  app.post('/api/bantahbro/notifications/test-create', async (req: Request, res: Response) => {
    try {
      // Use fixed test user ID
      const userId = 'demo-user-001';
      
      const testNotifications = [
        {
          eventType: 'queued',
          agentName: 'vitalik.eth',
          agentId: 'agent-001',
        },
        {
          eventType: 'match_found',
          agentName: 'wizard.eth',
          agentId: 'agent-002',
          opponentName: 'satoshi.eth',
        },
        {
          eventType: 'win',
          agentName: 'vitalik.eth',
          agentId: 'agent-001',
          opponentName: 'wizard.eth',
          earnedBC: 45,
          earnedUSDT: 0.009,
          battleId: 'battle-001',
        },
        {
          eventType: 'loss',
          agentName: 'wizard.eth',
          agentId: 'agent-002',
          opponentName: 'satoshi.eth',
          battleId: 'battle-002',
        },
        {
          eventType: 'pot_payout',
          agentName: 'bantah.eth',
          agentId: 'agent-003',
          earnedUSDT: 4.20,
        },
        {
          eventType: 'tool_drop',
          agentName: 'elite.eth',
          agentId: 'agent-004',
        },
        {
          eventType: 'royale_result',
          agentName: 'royale.eth',
          agentId: 'agent-005',
        },
      ];

      const created = [];
      for (const notif of testNotifications) {
        const notificationData: Record<string, any> = {
          eventType: notif.eventType,
          agentName: notif.agentName,
          agentId: notif.agentId,
          timestamp: new Date().toISOString(),
          read: false,
        };

        if (notif.opponentName) notificationData.opponentName = notif.opponentName;
        if (notif.earnedBC) notificationData.earnedBC = notif.earnedBC;
        if (notif.earnedUSDT) notificationData.earnedUSDT = notif.earnedUSDT;
        if (notif.battleId) notificationData.battleId = notif.battleId;

        const newNotif = await db
          .insert(notifications)
          .values({
            userId,
            type: 'bota_activity',
            title: `[${notif.eventType.toUpperCase()}] ${notif.agentName}`,
            message: `Agent activity: ${notif.eventType}`,
            data: notificationData,
            read: false,
            createdAt: new Date(),
          })
          .returning();

        created.push(newNotif[0]);
      }

      res.json({ success: true, created: created.length, notifications: created });
    } catch (error) {
      console.error('Error creating test notifications:', error);
      res.status(500).json({ error: 'Failed to create test notifications', details: String(error) });
    }
  });

  /**
   * PATCH /api/bantahbro/notifications/:id/read
   * Mark BOTA notification as read
   */
  app.patch('/api/bantahbro/notifications/:id/read', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const notificationId = req.params.id;
      const userId = getUserId(req);

      // Verify ownership
      const notif = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .limit(1);

      if (!notif.length || notif[0].userId !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      const updated = await db
        .update(notifications)
        .set({ read: true })
        .where(eq(notifications.id, notificationId))
        .returning();

      res.json(updated[0]);
    } catch (error) {
      console.error('Error marking notification as read:', error);
      res.status(500).json({ error: 'Failed to update notification' });
    }
  });

  /**
   * DELETE /api/bantahbro/notifications/:id
   * Dismiss/delete BOTA notification
   */
  app.delete('/api/bantahbro/notifications/:id', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const notificationId = req.params.id;
      const userId = getUserId(req);

      // Verify ownership
      const notif = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .limit(1);

      if (!notif.length || notif[0].userId !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      await db
        .delete(notifications)
        .where(eq(notifications.id, notificationId));

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting notification:', error);
      res.status(500).json({ error: 'Failed to delete notification' });
    }
  });

  // Treasury Analytics Routes
  app.get('/api/admin/treasury/analytics/metrics', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { getTreasuryMetrics } = await import('./treasuryAnalytics');
      const metrics = await getTreasuryMetrics();

      res.json(metrics);
    } catch (error) {
      console.error('Error fetching Treasury metrics:', error);
      res.status(500).json({ message: 'Failed to fetch metrics' });
    }
  });

  app.get('/api/admin/treasury/analytics/daily-trends', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user?.id;
      const range = req.query.range as string || '30d';

      if (!adminId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { getDailyPnLTrends } = await import('./treasuryAnalytics');
      
      let startDate: Date | undefined;
      const endDate = new Date();

      if (range === '7d') {
        startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      } else if (range === '30d') {
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      } else if (range === '90d') {
        startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      }

      const trends = await getDailyPnLTrends(startDate, endDate);
      res.json(trends);
    } catch (error) {
      console.error('Error fetching daily trends:', error);
      res.status(500).json({ message: 'Failed to fetch daily trends' });
    }
  });

  app.get('/api/admin/treasury/analytics/challenges', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { getChallengeAnalytics } = await import('./treasuryAnalytics');
      const analytics = await getChallengeAnalytics();

      res.json(analytics);
    } catch (error) {
      console.error('Error fetching challenge analytics:', error);
      res.status(500).json({ message: 'Failed to fetch challenge analytics' });
    }
  });

  app.get('/api/admin/treasury/analytics/user-performance', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { getPerformanceByUser } = await import('./treasuryAnalytics');
      const performance = await getPerformanceByUser();

      res.json(performance);
    } catch (error) {
      console.error('Error fetching user performance:', error);
      res.status(500).json({ message: 'Failed to fetch user performance' });
    }
  });

  app.get('/api/admin/treasury/analytics/risk-analysis', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { getRiskAnalysis } = await import('./treasuryAnalytics');
      const analysis = await getRiskAnalysis();

      res.json(analysis);
    } catch (error) {
      console.error('Error fetching risk analysis:', error);
      res.status(500).json({ message: 'Failed to fetch risk analysis' });
    }
  });

  app.get('/api/admin/treasury/analytics/export', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user?.id;
      const format = (req.query.format as string) || 'csv';

      if (!adminId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { exportAnalyticsData } = await import('./treasuryAnalytics');
      const data = await exportAnalyticsData(format as 'csv' | 'json');

      if (format === 'json') {
        res.json(data);
      } else {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="treasury-analytics-${new Date().toISOString().split('T')[0]}.csv"`);
        res.send(data);
      }
    } catch (error) {
      console.error('Error exporting analytics:', error);
      res.status(500).json({ message: 'Failed to export analytics' });
    }
  });

  // User preferences routes
  app.get('/api/user/preferences', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const preferences = await storage.getUserPreferences(userId);

      // Return default preferences if none exist
      if (!preferences) {
        const defaultPreferences = {
          notifications: {
            email: true,
            push: true,
            challenge: true,
            event: true,
            friend: true
          },
          appearance: {
            theme: 'system',
            compactView: false,
            language: 'en'
          },
          performance: {
            autoRefresh: true,
            soundEffects: true,
            dataUsage: 'medium'
          },
          regional: {
            currency: 'USDC',
            timezone: 'Africa/Lagos'
          },
          privacy: {
            profileVisibility: 'public',
            activityVisibility: 'friends'
          }
        };
        return res.json(defaultPreferences);
      }

      res.json(preferences);
    } catch (error) {
      console.error("Error fetching user preferences:", error);
      res.status(500).json({ message: "Failed to fetch user preferences" });
    }
  });

  app.patch('/api/user/preferences', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { notifications, appearance, performance, regional, privacy } = req.body;

      const preferences = await storage.updateUserPreferences(userId, {
        notifications,
        appearance,
        performance,
        regional,
        privacy
      });

      res.json(preferences);
    } catch (error) {
      console.error("Error updating user preferences:", error);
      res.status(500).json({ message: "Failed to update user preferences" });
    }
  });

  // Transaction routes
  app.get('/api/transactions', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const transactions = await storage.getTransactions(userId);
      res.json(transactions);
    } catch (error) {
      console.error("Error fetching transactions:", error);
      res.status(500).json({ message: "Failed to fetch transactions" });
    }
  });

  app.get('/api/wallet/balance', async (req: AuthenticatedRequest, res) => {
    try {
      const optionalUserId = await getOptionalPrivyUserId(req);
      if (!optionalUserId) {
        return res.json({ balance: 0, coins: 0, points: 0 });
      }

      const userId = optionalUserId;
      console.log(`Fetching balance for user: ${userId}`);

      const balance = await storage.getUserBalance(userId);
      console.log(`Balance result for user ${userId}:`, balance);

      res.json(balance);
    } catch (error) {
      console.error("Error fetching balance:", error);
      res.status(500).json({ message: "Failed to fetch balance" });
    }
  });

  // Wallet deposit route
  app.post('/api/wallet/deposit', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });      }

      if (!process.env.PAYSTACK_SECRET_KEY) {
        console.error("PAYSTACK_SECRET_KEY environment variable not set");
        return res.status(500).json({ message: "Payment service not configured" });
      }

      console.log("Initializing Paystack transaction for user:", userId, "amount:", amount);

      // Generate unique reference with random component to prevent duplicates
      // Sanitize userId by removing colons which Paystack doesn't allow
      const sanitizedUserId = userId.replace(/:/g, '-');
      const uniqueRef = `dep_${sanitizedUserId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      // Initialize Paystack transaction
      const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: "dummy@betchat.com", // Dummy email for Paystack, not user email
          amount: amount * 100, // Paystack expects amount in kobo
          currency: 'NGN',
          reference: uniqueRef,
          metadata: {
            userId,
            type: 'deposit'
          }
        })
      });

      const paystackData = await paystackResponse.json();
      console.log("Paystack response:", paystackData);

      if (!paystackData.status) {
        console.error("Paystack error:", paystackData);
        return res.status(400).json({ message: paystackData.message || "Failed to initialize payment" });
      }

      console.log("Sending authorization URL:", paystackData.data.authorization_url);
      res.json({ 
        authorization_url: paystackData.data.authorization_url,
        access_code: paystackData.data.access_code,
        reference: paystackData.data.reference,
        publicKey: process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_' // You'll need to set this in secrets
      });
    } catch (error) {
      console.error("Error processing deposit:", error);
      res.status(500).json({ message: "Failed to process deposit" });
    }
  });

  // Wallet swap route (Money ↔ Coins)
  app.post('/api/wallet/swap', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { amount, fromCurrency } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      if (!fromCurrency || !['money', 'coins'].includes(fromCurrency)) {
        return res.status(400).json({ message: "Invalid currency type" });
      }

      console.log(`Processing swap for user ${userId}: ${amount} ${fromCurrency}`);

      // Get current balance
      const balance = await storage.getUserBalance(userId);

      if (fromCurrency === 'money') {
        // Money to Coins (1:10 ratio)
        if (balance.balance < amount) {
          return res.status(400).json({ message: "Insufficient money balance" });
        }

        const coinsToAdd = amount * 10;

        // Create debit transaction for money
        await storage.createTransaction({
          userId,
          type: 'currency_swap',
          amount: (-amount).toString(),
          description: `Swapped ${formatBalance(amount)} to ${coinsToAdd.toLocaleString()} coins`,
          status: 'completed'
        });

        // Update user coins
        await db
          .update(users)
          .set({ 
            coins: sql`${users.coins} + ${coinsToAdd}`,
            updatedAt: new Date()
          })
          .where(eq(users.id, userId));

        // Create notification
        await storage.createNotification({
          userId,
          type: 'currency_swap',
          title: '🔄 Currency Swap Complete',
          message: `Successfully swapped ${formatBalance(amount)} for ${coinsToAdd.toLocaleString()} coins!`,
          data: { 
            fromAmount: amount,
            toAmount: coinsToAdd,
            fromCurrency: 'money',
            toCurrency: 'coins'
          },
        });

        console.log(`✅ Swapped ${formatBalance(amount)} to ${coinsToAdd} coins for user ${userId}`);
        res.json({ 
          message: "Swap completed successfully",
          fromAmount: amount,
          toAmount: coinsToAdd,
          fromCurrency: 'money',
          toCurrency: 'coins'
        });

      } else {
        // Coins to Money (10:1 ratio)
        if (balance.coins < amount) {
          return res.status(400).json({ message: "Insufficient coins balance" });
        }

        const moneyToAdd = amount * 0.1;

        // Update user coins (deduct)
        await db
          .update(users)
          .set({ 
            coins: sql`${users.coins} - ${amount}`,
            updatedAt: new Date()
          })
          .where(eq(users.id, userId));

        // Create credit transaction for money
        await storage.createTransaction({
          userId,
          type: 'currency_swap',
          amount: moneyToAdd.toString(),
          description: `Swapped ${amount.toLocaleString()} coins to ${formatBalance(moneyToAdd)}`,
          status: 'completed'
        });

        // Create notification
        await storage.createNotification({
          userId,
          type: 'currency_swap',
          title: '🔄 Currency Swap Complete',
          message: `Successfully swapped ${amount.toLocaleString()} coins for ${formatBalance(moneyToAdd)}!`,
          data: { 
            fromAmount: amount,
            toAmount: moneyToAdd,
            fromCurrency: 'coins',
            toCurrency: 'money'
          },
        });

        console.log(`✅ Swapped ${amount} coins to ${formatBalance(moneyToAdd)} for user ${userId}`);
        res.json({ 
          message: "Swap completed successfully",
          fromAmount: amount,
          toAmount: moneyToAdd,
          fromCurrency: 'coins',
          toCurrency: 'money'
        });
      }

      // Send real-time notification via Pusher
      try {
        await pusher.trigger(`user-${userId}`, 'currency-swap', {
          id: Date.now(),
          type: 'currency_swap',
          title: '🔄 Currency Swap Complete',
          message: fromCurrency === 'money' 
            ? `Swapped ${formatBalance(amount)} for ${(amount * 10).toLocaleString()} coins!`
            : `Swapped ${amount.toLocaleString()} coins for ${formatBalance(amount * 0.1)}!`,
          timestamp: new Date().toISOString(),
        });
      } catch (pusherError) {
        console.error("Error sending Pusher notification:", pusherError);
      }

    } catch (error) {
      console.error("Error processing swap:", error);
      res.status(500).json({ message: "Failed to process swap" });
    }
  });

  // Wallet withdraw route
  app.post('/api/wallet/withdraw', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      console.log(`Processing withdrawal for user ${userId}: ${formatBalance(amount)}`);

      // Get current balance
      const balance = await storage.getUserBalance(userId);

      if (balance.balance < amount) {
        return res.status(400).json({ message: "Insufficient balance" });
      }

      // Create debit transaction for withdrawal
      await storage.createTransaction({
        userId,
        type: 'withdrawal',
        amount: (-amount).toString(),
        description: `Withdrawal of ${formatBalance(amount)}`,
        status: 'completed'
      });

      // Create notification
      await storage.createNotification({
        userId,
        type: 'withdrawal',
        title: '💸 Withdrawal Complete',
        message: `Successfully withdrew ${formatBalance(amount)} from your account!`,
        data: { 
          amount: amount,
          type: 'withdrawal'
        },
      });

      // Send real-time notification via Pusher
      try {
        await pusher.trigger(`user-${userId}`, 'withdrawal', {
          id: Date.now(),
          type: 'withdrawal',
          title: '💸 Withdrawal Complete',
          message: `Withdrew ${formatBalance(amount)} from your account!`,
          timestamp: new Date().toISOString(),
        });
      } catch (pusherError) {
        console.error("Error sending Pusher notification:", pusherError);
      }

      console.log(`✅ Withdrawal of ${formatBalance(amount)} completed for user ${userId}`);
      res.json({ 
        message: "Withdrawal completed successfully",
        amount: amount
      });

    } catch (error) {
      console.error("Error processing withdrawal:", error);
      res.status(500).json({ message: "Failed to process withdrawal" });
    }
  });

  // Paystack webhook for payment verification
  app.post('/api/webhook/paystack', async (req, res) => {
    try {
      const hash = req.headers['x-paystack-signature'];
      let event = req.body;

      console.log('Webhook received:', {
        headers: req.headers,
        bodyType: typeof event,
        hasBody: !!event
      });

      // If body is already parsed as object, use it directly
      if (typeof event === 'object' && event !== null) {
        console.log('Using pre-parsed webhook body');
      } else {
        // Handle string bodies
        const bodyString = typeof event === 'string' ? event : JSON.stringify(event);

        // Verify signature if secret key is available
        if (process.env.PAYSTACK_SECRET_KEY) {
          const expectedHash = require('crypto')
            .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
            .update(bodyString)
            .digest('hex');

          console.log('Signature verification:', {
            receivedHash: hash,
            expectedHash,
            match: hash === expectedHash
          });

          if (hash !== expectedHash) {
            console.log('Invalid webhook signature');
            return res.status(400).json({ message: "Invalid signature" });
          }
        }

        // Parse the event if it's a string
        try {
          event = JSON.parse(bodyString);
        } catch (parseError) {
          console.error('Failed to parse webhook body:', parseError);
          return res.status(400).json({ message: "Invalid JSON" });
        }
      }

      console.log('Webhook event:', event);

      if (event.event === 'charge.success') {
        const { reference, amount, metadata, status } = event.data;

        console.log('Processing charge.success:', {
          reference,
          amount,
          metadata,
          status
        });

        if (status === 'success' && metadata && metadata.userId) {
          const userId = metadata.userId;
          const depositAmount = amount / 100; // Convert from kobo to naira

          console.log(`Processing successful deposit for user ${userId}: ₦${depositAmount}`);

          try {
            // Create transaction record
            await storage.createTransaction({
              userId,
              type: 'deposit',
              amount: depositAmount.toString(),
              description: `Deposit via Paystack - ${reference}`,
              status: 'completed',
            });

            // Create notification for successful deposit
            await storage.createNotification({
              userId,
              type: 'deposit',
              title: '💰 Deposit Successful',
              message: `Your deposit of ₦${depositAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} has been credited to your account!`,
              data: { 
                amount: depositAmount,
                reference: reference,
                type: 'deposit',
                timestamp: new Date().toISOString()
              },
            });

            console.log(`✅ Deposit completed for user ${userId}: ₦${depositAmount}`);
          } catch (dbError) {
            console.error('Database error while creating transaction:', dbError);
            return res.status(500).json({ message: "Database error" });
          }
        } else {
          console.log('⚠️ Charge success but invalid status or missing metadata:', {
            status,
            hasMetadata: !!metadata,
            userId: metadata?.userId
          });
        }
      } else {
        console.log('Webhook event not charge.success:', event.event);
      }

      res.status(200).json({ message: "Webhook processed successfully" });
    } catch (error) {
      console.error("❌ Error processing webhook:", error);
      res.status(500).json({ message: "Webhook processing failed" });
    }
  });

  // Manual payment verification (for testing)
  app.post('/api/wallet/verify-payment', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const { reference } = req.body;
      const userId = getUserId(req);

      if (!reference) {
        return res.status(400).json({ message: "Reference is required" });
      }

      console.log(`Manual verification requested for reference: ${reference} by user: ${userId}`);

      if (!process.env.PAYSTACK_SECRET_KEY) {
        console.error("PAYSTACK_SECRET_KEY not set");
        return res.status(500).json({ message: "Payment service not configured" });
      }

      // Verify payment with Paystack
      const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        }
      });

      const verifyData = await verifyResponse.json();
      console.log('Paystack verification response:', {
        status: verifyData.status,
        data: verifyData.data ? {
          status: verifyData.data.status,
          amount: verifyData.data.amount,
          reference: verifyData.data.reference,
          metadata: verifyData.data.metadata
        } : null
      });

      if (verifyData.status && verifyData.data && verifyData.data.status === 'success') {
        const { amount, metadata, reference: txRef } = verifyData.data;
        const depositAmount = amount / 100; // Convert from kobo to naira

        console.log(`Processing payment verification:`, {
          amount: depositAmount,
          metadata,
          reference: txRef,
          requestedBy: userId
        });

        // Validate the user matches
        if (metadata && metadata.userId === userId) {
          // Check if transaction already exists by reference
          const existingTransactions = await storage.getTransactions(userId);
          const exists = existingTransactions.some((t: any) => 
            t.reference === reference || 
            t.description?.includes(reference) ||
            t.reference === txRef
          );

          if (!exists) {
            console.log(`Creating new deposit transaction for user ${userId}: ₦${depositAmount}`);

            const newTransaction = await storage.createTransaction({
              userId,
              type: 'deposit',
              amount: depositAmount.toString(),
              description: `Deposit via Paystack - ${reference}`,
              reference: reference,
              status: 'completed',
            });

            console.log(`Transaction created:`, newTransaction);

            // Verify the transaction was created
            const verifyTransactions = await storage.getTransactions(userId);
            console.log(`All transactions after creation:`, verifyTransactions.map(t => ({
              id: t.id,
              type: t.type,
              amount: t.amount,
              status: t.status,
              reference: t.reference
            })));

            // Get updated balance
            const updatedBalance = await storage.getUserBalance(userId);
            console.log(`Updated balance for user ${userId}:`, updatedBalance);

            // Create notification for successful deposit
            await storage.createNotification({
              userId,
              type: 'deposit',
              title: '💰 Deposit Successful',
              message: `Your deposit of ₦${depositAmount.toLocaleString()} has been credited to your account!`,
              data: { 
                amount: depositAmount,
                reference: reference,
                type: 'deposit',
                timestamp: new Date().toISOString()
              },
            });

            console.log(`✅ Manual verification completed for user ${userId}: ₦${depositAmount}`);
            res.json({ 
              message: "Payment verified successfully", 
              amount: depositAmount,
              newBalance: updatedBalance 
            });
          } else {
            console.log(`Transaction with reference ${reference} already exists for user ${userId}`);
            const currentBalance = await storage.getUserBalance(userId);
            res.json({ 
              message: "Payment already processed", 
              amount: depositAmount,
              currentBalance: currentBalance 
            });
          }
        } else {
          console.log('Metadata validation failed:', {
            metadataUserId: metadata?.userId,
            requestUserId: userId,
            hasMetadata: !!metadata
          });
          res.status(400).json({ message: "Payment verification failed - user mismatch" });
        }
      } else {
        console.log('Payment verification failed:', {
          paystackStatus: verifyData.status,
          dataStatus: verifyData.data?.status,
          message: verifyData.message
        });
        res.status(400).json({ message: verifyData.message || "Payment verification failed" });
      }
    } catch (error) {
      console.error("Error verifying payment:", error);
      res.status(500).json({ message: "Failed to verify payment" });
    }
  });

  // Wallet withdrawal route
  app.post('/api/wallet/withdraw', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { amount, method } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      const balance = await storage.getUserBalance(userId);
      if (balance.balance < amount) {
        return res.status(400).json({ message: "Insufficient balance" });
      }

      // Create withdrawal transaction
      await storage.createTransaction({
        userId,
        type: 'withdrawal',
        amount: `-${amount}`,
        description: `Withdrawal via ${method}`,
        status: 'pending',
      });

      // Create notification
      await storage.createNotification({
        userId,
        type: 'withdrawal',
        title: '📤 Withdrawal Requested',
        message: `Your withdrawal of ₦${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} is being processed.`,
        data: { amount, method },
      });

      res.json({ message: "Withdrawal request submitted successfully" });
    } catch (error) {
      console.error("Error processing withdrawal:", error);
      res.status(500).json({ message: "Failed to process withdrawal" });
    }
  });

  // Global chat routes
  app.get('/api/chat/messages', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const messages = await storage.getGlobalChatMessages(50);
      res.json(messages);
    } catch (error) {
      console.error("Error fetching global chat messages:", error);
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  app.post('/api/chat/messages', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { message } = req.body;

      if (!message?.trim()) {
        return res.status(400).json({ message: "Message content is required" });
      }

      // Get user info
      const user = await storage.getUser(userId);

      // Create message in BetChat
      const newMessage = await storage.createGlobalChatMessage({
        userId,
        user: {
          id: user?.id,
          firstName: user?.firstName,
          lastName: user?.lastName,
          username: user?.username,
          profileImageUrl: user?.profileImageUrl,
        },
        message: message.trim(),
        source: 'betchat'
      });

      // Broadcast to BetChat users via Pusher
      await pusher.trigger('global-chat', 'new-message', {
        type: 'chat_message',
        message: newMessage,
        source: 'betchat'
      });

      // Forward to Telegram if sync is available
      const telegramSync = getTelegramSync();
      if (telegramSync && telegramSync.isReady()) {
        const senderName = user?.firstName || user?.username || 'BetChat User';
        await telegramSync.sendMessageToTelegram(message.trim(), senderName);
      }

      res.json(newMessage);
    } catch (error) {
      console.error("Error creating global chat message:", error);
      res.status(500).json({ message: "Failed to create message" });
    }
  });

  // Telegram sync status route
  app.get('/api/telegram/status', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const telegramSync = getTelegramSync();
      const telegramBot = getTelegramBot();

      let syncStatus = { 
        enabled: false, 
        connected: false, 
        message: "Telegram sync not configured" 
      };

      let botStatus = { 
        enabled: false, 
        connected: false, 
        message: "Telegram bot not configured" 
      };

      if (telegramSync) {
        const isReady = telegramSync.isReady();
        const groupInfo = isReady ? await telegramSync.getGroupInfo() : null;
        syncStatus = {
          enabled: true,
          connected: isReady,
          groupInfo,
          message: isReady ? "Connected and syncing" : "Connecting..."
        };
      }

      if (telegramBot) {
        const connection = await telegramBot.testConnection();
        const channelInfo = connection ? await telegramBot.getChannelInfo() : null;
        botStatus = {
          enabled: true,
          connected: connection,
          channelInfo,
          message: connection ? "Bot connected and ready for broadcasting" : "Bot connection failed"
        };
      }

      res.json({
        sync: syncStatus,
        bot: botStatus
      });
    } catch (error) {
      console.error("Error getting Telegram status:", error);
      res.status(500).json({ message: "Failed to get Telegram status" });
    }
  });

  // Phase 1: Telegram bot webhook for /start command
  app.post('/api/telegram/bot-webhook', async (req, res) => {
    try {
      const update = req.body;
      const telegramBot = getTelegramBot();
      if (telegramBot) {
        await telegramBot.handleWebhookUpdate(update);
      }
      return res.json({ ok: true });
    } catch (error) {
      console.error('❌ Webhook error:', error);
      res.json({ ok: true });
    }
  });

  app.post('/api/telegram/bantahbro-webhook', async (req, res) => {
    try {
      const update = req.body;
      const telegramBot = getBantahBroTelegramBot();
      if (telegramBot) {
        await telegramBot.handleWebhookUpdate(update);
      }
      return res.json({ ok: true });
    } catch (error) {
      console.error('❌ BantahBro webhook error:', error);
      res.json({ ok: true });
    }
  });

  // Phase 1: Telegram auth verification endpoint
  app.get('/api/telegram/verify-link', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const { token } = req.query;
      const userId = getUserId(req);

      console.log(`🔍 Telegram link verification request - Token: ${token}, User: ${userId}`);

      if (!token || typeof token !== 'string') {
        console.log('❌ Invalid token format');
        return res.status(400).json({ success: false, message: 'Invalid token' });
      }

      const { TelegramLinkingService } = await import('./telegramLinking');

      // Verify token
      const linkData = await TelegramLinkingService.verifyLinkToken(token);

      if (!linkData) {
        console.log(`❌ Token verification failed: ${token}`);
        return res.json({ 
          success: false, 
          error: 'invalid_token',
          message: 'Link expired or invalid. Please use /start in Telegram to get a new link.' 
        });
      }

      console.log(`✅ Token verified for Telegram user ${linkData.telegramChatId}`);

      // Link account
      const linked = await TelegramLinkingService.linkTelegramAccount(
        userId,
        linkData.telegramChatId,
        linkData.telegramUsername
      );

      if (!linked) {
        console.log(`❌ Account linking failed - already linked`);
        return res.json({ 
          success: false,
          error: 'already_linked',
          message: 'This Telegram account is already linked to another user.' 
        });
      }

      // Mark token as used
      TelegramLinkingService.markTokenAsUsed(token);

      // Get user info for confirmation
      const user = await storage.getUser(userId);

      // Send confirmation to Telegram
      const telegramBot = getTelegramBot();
      if (telegramBot && user) {
        await telegramBot.sendAccountLinkedConfirmation(
          linkData.telegramChatId,
          user.username || user.firstName || 'User',
          user.coins || 0
        );
      }

      console.log(`✅ Successfully linked Telegram account ${linkData.telegramChatId} to user ${userId}`);

      res.json({ 
        success: true,
        message: 'Account linked successfully!',
        user: {
          telegramId: linkData.telegramChatId,
          telegramUsername: linkData.telegramUsername,
        }
      });
    } catch (error) {
      console.error('❌ Error verifying Telegram link:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // Telegram Mini-App: Link account endpoint
  // This endpoint is called from the Telegram mini-app after the user is authenticated with Privy
  app.post('/api/telegram/mini-app/link', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { telegramId, telegramUsername, telegramFirstName, initData } = req.body;

      if (!telegramId || !initData || !initData.hash) {
        return res.status(400).json({ success: false, message: 'Missing Telegram data' });
      }

      console.log(`🔍 Mini-app link request - User: ${userId}, Telegram ID: ${telegramId}`);

      // Verify the Telegram initData signature
      // The initData is a URL-encoded string with format: user=%7B...%7D&auth_date=...&hash=...
      const { TelegramLinkingService } = await import('./telegramLinking');
      
      // Validate the Telegram signature
      try {
        const isValid = validateTelegramWebAppData(initData, process.env.TELEGRAM_BOT_TOKEN || '');
        if (!isValid) {
          console.log('❌ Invalid Telegram signature');
          return res.json({
            success: false,
            message: 'Invalid Telegram signature. Please use the official mini-app link.'
          });
        }
      } catch (signError) {
        console.error('Error validating Telegram signature:', signError);
        return res.json({
          success: false,
          message: 'Failed to validate Telegram data'
        });
      }

      // Link the Telegram account
      const linked = await TelegramLinkingService.linkTelegramAccount(
        userId,
        telegramId.toString(),
        telegramUsername || `user_${telegramId}`
      );

      if (!linked) {
        console.log(`❌ Account linking failed - already linked`);
        return res.json({
          success: false,
          message: 'This Telegram account is already linked to another user.'
        });
      }

      // Send confirmation to Telegram
      const telegramBot = getTelegramBot();
      const user = await storage.getUser(userId);
      if (telegramBot && user) {
        await telegramBot.sendAccountLinkedConfirmation(
          telegramId,
          user.username || user.firstName || 'User',
          user.coins || 0
        );
      }

      console.log(`✅ Successfully linked Telegram account ${telegramId} to user ${userId}`);

      res.json({
        success: true,
        message: 'Account linked successfully!'
      });
    } catch (error) {
      console.error('❌ Error linking mini-app account:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // Telegram Mini-App: Auth endpoint (Telegram-only login)
  // Verify initData, create or get user, then create a server session via req.login
  app.post('/api/telegram/mini-app/auth', async (req, res) => {
    try {
      const { initData } = req.body;
      if (!initData || !initData.hash) {
        return res.status(400).json({ success: false, message: 'Missing initData' });
      }

      const isValid = validateTelegramWebAppData(initData, process.env.TELEGRAM_BOT_TOKEN || '');
      if (!isValid) {
        return res.status(400).json({ success: false, message: 'Invalid Telegram signature' });
      }

      const telegramUser = initData.user;
      if (!telegramUser || !telegramUser.id) {
        return res.status(400).json({ success: false, message: 'Invalid Telegram user data' });
      }

      // Create or find user in DB
      const telegramId = telegramUser.id.toString();
      const telegramUserId = `telegram_${telegramId}`;
      let user = await storage.getUser(telegramUserId);
      if (!user) {
        const username = telegramUser.username || `tg_${telegramId}`;
        user = await storage.createUser({
          id: telegramUserId,
          firstName: telegramUser.first_name || username,
          username: username,
          email: `${telegramUserId}@telegram.betchat.local`,
          profileImageUrl: telegramUser.photo_url || null,
          isTelegramUser: true,
          telegramId: telegramId,
          coins: 0,
          points: 0,
          level: 1,
          xp: 0,
        });
      }

      // Login the user (passport session)
      req.login(user, (err: any) => {
        if (err) {
          console.error('Error logging in Telegram user:', err);
          return res.status(500).json({ success: false, message: 'Failed to create session' });
        }
        console.log(`✅ Telegram session created for ${user.id}`);
        return res.json({ success: true, user: { id: user.id, username: user.username, firstName: user.firstName } });
      });
    } catch (error) {
      console.error('❌ Telegram mini-app auth error:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // Telegram Bot API: Get user data for bot
  // Called by the independent Telegram bot service
  // No authentication required - bot only needs telegramId which is public
  app.get('/api/telegram/user/:telegramId', async (req, res) => {
    try {
      const { telegramId } = req.params;

      console.log(`📱 Bot API request for Telegram user ${telegramId}`);

      // Find user by telegram ID
      const { TelegramLinkingService } = await import('./telegramLinking');
      const user = await TelegramLinkingService.getUserByTelegramId(telegramId);

      if (!user) {
        return res.json({
          user: null,
          message: 'User not found'
        });
      }

      // Get user balance
      const balance = await storage.getUserBalance(user.id);

      // Get active challenges count
      const allChallenges = await storage.getChallenges(user.id, 100);
      const activeChallenges = allChallenges.filter((c: any) => 
        c.status === 'active' || c.status === 'pending'
      ).length;

      return res.json({
        user: {
          id: user.id,
          username: user.username,
          firstName: user.firstName,
          balance: balance.balance || '0',
          coins: balance.coins || 0,
          activeChallenges,
          telegramId
        }
      });
    } catch (error) {
      console.error('❌ Bot API error:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Server error' 
      });
    }
  });

  // Helper function to validate Telegram WebApp initData
  function validateTelegramWebAppData(
    initData: any,
    botToken: string
  ): boolean {
    try {
      // Extract hash from initData
      const hash = initData.hash;
      if (!hash) return false;

      // Create data check string (all params except hash, sorted by key)
      const dataCheckString = Object.entries(initData)
        .filter(([key]) => key !== 'hash')
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        .map(([key, value]) => {
          if (typeof value === 'object') {
            return `${key}=${JSON.stringify(value)}`;
          }
          return `${key}=${value}`;
        })
        .join('\n');

      // Create HMAC-SHA256
      const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();

      const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      return computedHash === hash;
    } catch (error) {
      console.error('Error validating Telegram data:', error);
      return false;
    }
  }

  // Disabled: Telegram sends must come from real product usage, not mock/test blasts.
  app.post('/api/telegram/test-broadcast', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    return res.status(410).json({
      success: false,
      message: "Telegram test broadcasts are disabled. Alerts are sent only from real usage flows.",
    });
  });

  // Disabled: bulk replaying old events can create mock/noisy Telegram alerts.
  app.post('/api/telegram/broadcast-existing', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    return res.status(410).json({
      success: false,
      message: "Bulk Telegram broadcasts are disabled. Alerts are sent only from real usage flows.",
    });
  });

  // Follow/Unfollow user route
  app.post('/api/users/:userId/follow', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const followerId = getUserId(req);
      const followingId = req.params.userId;

      if (followerId === followingId) {
        return res.status(400).json({ message: "Cannot follow yourself" });
      }

      const result = await storage.toggleFollow(followerId, followingId);

      if (result.action === 'followed') {
        // Get follower info
        const follower = await storage.getUser(followerId);
        
        // Only send one notification using a unique ID to prevent duplicates
        const notificationId = `follow_${followerId}_${followingId}`;
        
        // Check if notification already exists
        const [existing] = await db
          .select()
          .from(notifications)
          .where(eq(notifications.id, notificationId))
          .limit(1);

        if (!existing) {
          // Create notification for followed user
          await storage.createNotification({
            id: notificationId,
            userId: followingId,
            type: 'new_follower',
            title: '👤 New Follower',
            message: `@${follower?.firstName || follower?.username || 'Someone'} is now following you!`,
            icon: '👤',
            data: { 
              followerId: followerId,
              followerName: follower?.firstName || follower?.username
            },
          });

          // Send real-time notification via Pusher
          const sanitizedFollowingId = followingId.replace(/[^a-zA-Z0-9_\-=@,.;]/g, '_');
          await pusher.trigger(`user-${sanitizedFollowingId}`, 'new-follower', {
            title: '👤 New Follower',
            message: `@${follower?.firstName || follower?.username || 'Someone'} is now following you!`,
            followerId: followerId,
            followerName: follower?.firstName || follower?.username,
            timestamp: new Date().toISOString(),
          });
        }
      }

      res.json({
        ...result,
        isFollowing: result.action === 'followed'
      });
    } catch (error) {
      console.error("Error toggling follow:", error);
      res.status(500).json({ message: "Failed to toggle follow" });
    }
  });

  // Track sharing and send notification
  app.post('/api/track-share', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const { platform, contentType, contentId, url } = req.body;

      // Get user info
      const user = await storage.getUser(userId);

      // Create notification for successful share
      let notificationTitle = '🔗 Content Shared!';
      let notificationMessage = '';

      if (contentType === 'event') {
        const event = await storage.getEventById(parseInt(contentId));
        notificationMessage = `You shared "${event?.title}" on ${platform}! Keep spreading the word to earn rewards.`;
      } else if (contentType === 'challenge') {
        const challenge = await storage.getChallengeById(parseInt(contentId));
        notificationMessage = `You shared your challenge "${challenge?.title}" on ${platform}! More shares = more participants.`;
      } else if (contentType === 'profile') {
        notificationMessage = `You shared your profile on ${platform}! Great way to grow your network.`;
      } else {
        notificationMessage = `You shared content on ${platform}! Keep engaging to boost your reach.`;
      }

      await storage.createNotification({
        userId,
        type: 'content_shared',
        title: notificationTitle,
        message: notificationMessage,
        data: { 
          platform,
          contentType,
          contentId,
          url,
          sharedAt: new Date().toISOString()
        },
      });

      // Send real-time notification via Pusher
      const sanitizedUserId = userId.replace(/[^a-zA-Z0-9_\-=@,.;]/g, '_');
      await pusher.trigger(`user-${sanitizedUserId}`, 'content-shared', {
        title: notificationTitle,
        message: notificationMessage,
        platform,
        contentType,
        timestamp: new Date().toISOString(),
      });

      res.json({ success: true, message: 'Share tracked successfully' });
    } catch (error) {
      console.error('Error tracking share:', error);
      res.status(500).json({ message: 'Failed to track share' });
    }
  });

  // Get navigation badge counts route
  app.get('/api/navigation/badges', async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user?.id;
      let profileCount = 0;
      if (userId) {
        const profileNotifications = await db
          .select({
            count: sql<number>`count(*)`
          })
          .from(notifications)
          .where(and(
            eq(notifications.userId, userId),
            eq(notifications.read, false),
            sql`type IN ('new_follower', 'achievement_unlocked', 'daily_signin_reminder', 'winner_challenge', 'loser_encourage')`
          ));
        profileCount = Number(profileNotifications[0]?.count || 0);
      }

      // Get new events count (events posted in last 24 hours)
      const newEvents = await db
        .select({
          count: sql<number>`count(*)`
        })
        .from(events)
        .where(sql`created_at >= NOW() - INTERVAL '24 hours'`);

      // Get new challenges count (challenges posted in last 24 hours)
      const newChallenges = await db
        .select({
          count: sql<number>`count(*)`
        })
        .from(challenges)
        .where(sql`created_at >= NOW() - INTERVAL '24 hours'`);

      res.json({
        profile: profileCount,
        events: Number(newEvents[0]?.count || 0),
        challenges: Number(newChallenges[0]?.count || 0)
      });
    } catch (error) {
      console.error("Error fetching navigation badges:", error);
      res.status(500).json({ message: "Failed to fetch navigation badges" });
    }
  });

  // Get user profile route
  app.get('/api/users/:userId', async (req, res) => {
    try {
      const userId = req.params.userId;
      const user = await storage.getUser(userId);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // Tip user route
  app.post('/api/users/:userId/tip', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const senderId = getUserId(req);
      const receiverId = req.params.userId;
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      if (senderId === receiverId) {
        return res.status(400).json({ message: "Cannot tip yourself" });
      }

      const balanceResult = await storage.getUserBalance(senderId);
      if (balanceResult.coins < amount) {
        return res.status(400).json({ message: "Insufficient coins" });
      }

      // Get sender and receiver info
      const sender = await storage.getUser(senderId);
      const receiver = await storage.getUser(receiverId);

      // Deduct coins from sender and credit receiver
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ 
            coins: sql`${users.coins} - ${amount}`,
            updatedAt: new Date()
          })
          .where(eq(users.id, senderId));

        await tx
          .update(users)
          .set({ 
            coins: sql`${users.coins} + ${amount}`,
            updatedAt: new Date()
          })
          .where(eq(users.id, receiverId));

        // Create transactions
        await tx.insert(transactions).values({
          userId: senderId,
          type: 'Gifted',
          amount: `-${amount}`,
          description: `Gifted @${receiver?.username || 'user'}`,
          status: 'completed',
        });

        await tx.insert(transactions).values({
          userId: receiverId,
          type: 'Gift received',
          amount: amount.toString(),
          description: `Gift received from @${sender?.username || 'user'}`,
          status: 'completed',
        });
      });

      // Create notification for receiver
      await storage.createNotification({
        userId: receiverId,
        type: 'gift_received',
        title: '💰 Gift Received',
        message: `You received a gift of ${amount} coins from @${sender?.username || 'Someone'}!`,
        data: { 
          amount: amount,
          senderId: senderId,
          senderName: sender?.username
        },
      });

      // Create notification for sender (confirmation)
      await storage.createNotification({
        userId: senderId,
        type: 'gift_sent',
        title: '💸 Gift Sent',
        message: `You gifted @${receiver?.username || 'User'} ${amount} coins!`,
        data: { 
          amount: amount,
          receiverId: receiverId,
          receiverName: receiver?.username
        },
      });

      // Send real-time notifications via Pusher
      const sanitizedReceiverId = receiverId.replace(/[^a-zA-Z0-9_\-=@,.;]/g, '_');
      const sanitizedSenderId = senderId.replace(/[^a-zA-Z0-9_\-=@,.;]/g, '_');

      await pusher.trigger(`user-${sanitizedReceiverId}`, 'tip-received', {
        title: '💰 Gift Received',
        message: `You received a gift of ${amount} coins from @${sender?.username || 'Someone'}!`,
        amount: amount,
        senderId: senderId,
        senderName: sender?.username,
        timestamp: new Date().toISOString(),
      });

      await pusher.trigger(`user-${sanitizedSenderId}`, 'tip-sent', {
        title: '💸 Gift Sent',
        message: `You gifted @${receiver?.username || 'User'} ${amount} coins!`,
        amount: amount,
        receiverId: receiverId,
        receiverName: receiver?.username,
        timestamp: new Date().toISOString(),
      });

      res.json({ message: "Tip sent successfully" });
    } catch (error) {
      console.error("Error sending tip:", error);
      res.status(500).json({ message: "Failed to send tip" });
    }
  });

  // Open Graph metadata endpoint
  app.get('/api/og-metadata', async (req, res) => {
    try {
      const { url } = req.query;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL parameter is required' });
      }

      // Simple OG metadata extraction
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Bantah-Bot/1.0',
          'Accept': 'text/html'
        }
      });

      if (!response.ok) {
        return res.status(400).json({ error: 'Failed to fetch URL' });
      }

      const html = await response.text();
      const ogData: Record<string, string> = {};

      // Extract basic OG tags
      const titleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*?)["']/i);
      if (titleMatch) ogData.title = titleMatch[1];

      const descMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*?)["']/i);
      if (descMatch) ogData.description = descMatch[1];

      const imageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*?)["']/i);
      if (imageMatch) ogData.image = imageMatch[1];

      res.json(ogData);
    } catch (error) {
      console.error('Error fetching OG metadata:', error);
      res.status(500).json({ error: 'Failed to fetch metadata' });
    }
  });

  // Daily Sign-In Routes
  app.get('/api/daily-signin/status', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);

      // First, check and create daily login record if needed
      await storage.checkDailyLogin(userId);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Check if user has already signed in today
      const todayLogin = await db
        .select()
        .from(dailyLogins)
        .where(and(
          eq(dailyLogins.userId, userId),
          sql`DATE(${dailyLogins.date}) = ${today.toISOString().split('T')[0]}`
        ))
        .limit(1);

      const hasSignedInToday = todayLogin.length > 0;
      const hasClaimed = hasSignedInToday ? todayLogin[0].claimed : false;

      // Get current streak
      const latestLogin = await db
        .select()
        .from(dailyLogins)
        .where(eq(dailyLogins.userId, userId))
        .orderBy(sql`${dailyLogins.date} DESC`)
        .limit(1);

      let currentStreak = 1;
      if (latestLogin.length > 0) {
        currentStreak = latestLogin[0].streak;

        // If they haven't signed in today, reset streak if yesterday wasn't their last login
        if (!hasSignedInToday) {
          const yesterday = new Date(today);
          yesterday.setDate(yesterday.getDate() - 1);

          const lastLoginDate = new Date(latestLogin[0].date);
          lastLoginDate.setHours(0, 0, 0, 0);

          if (lastLoginDate.getTime() !== yesterday.getTime()) {
            currentStreak = 1; // Reset streak
          } else {
            currentStreak = latestLogin[0].streak + 1; // Continue streak
          }
        }
      }

      const pointsToAward = BANTCREDIT_DAILY_CHECKIN_REWARD;

      res.json({
        hasSignedInToday,
        hasClaimed,
        hasClaimedToday: hasClaimed,
        canClaim: hasSignedInToday && !hasClaimed,
        streak: currentStreak,
        currentStreak,
        pointsToAward,
        showModal: hasSignedInToday && !hasClaimed
      });
    } catch (error) {
      console.error("Error checking daily sign-in status:", error);
      res.status(500).json({ message: "Failed to check daily sign-in status" });
    }
  });

  app.post('/api/daily-signin/claim', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const loginResult = await storage.checkDailyLogin(userId);
      const balance = await storage.getUserBalance(userId);

      res.json({
        message: loginResult?.awarded
          ? "Daily BantCredit awarded successfully"
          : "Daily BantCredit already awarded today",
        alreadyClaimed: !loginResult?.awarded,
        pointsEarned: Math.max(0, Math.round(Number(loginResult?.pointsAwarded || 0))),
        streak: Math.max(1, Math.round(Number(loginResult?.streak || 1))),
        balance: Math.max(0, Math.round(Number(balance?.points || 0))),
      });
    } catch (error) {
      console.error("Error claiming daily sign-in:", error);
      res.status(500).json({ message: "Failed to claim daily sign-in bonus" });
    }
  });

  // Get daily login history for user
  app.get('/api/daily-signin/history', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ message: "Not authenticated" });
      }

      const history = await db
        .select()
        .from(dailyLogins)
        .where(eq(dailyLogins.userId, userId))
        .orderBy(sql`${dailyLogins.date} DESC`)
        .limit(30); // Last 30 days

      res.json(history);
    } catch (error) {
      console.error("Error fetching daily login history:", error);
      res.status(500).json({ message: "Failed to fetch daily login history" });
    }
  });

  // Get all users route (for user search and listing)
  app.get('/api/users', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // User stats and history routes
  app.get('/api/user/stats', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const stats = await storage.getUserStats(userId);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching user stats:", error);
      res.status(500).json({ message: "Failed to fetch user stats" });
    }
  });

  app.get('/api/user/created-events', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const events = await storage.getUserCreatedEvents(userId);
      res.json(events);
    } catch (error) {
      console.error("Error fetching user created events:", error);
      res.status(500).json({ message: "Failed to fetch user created events" });
    }
  });

  app.get('/api/user/joined-events', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const events = await storage.getUserJoinedEvents(userId);
      res.json(events);
    } catch (error) {
      console.error("Error fetching user joined events:", error);
      res.status(500).json({ message: "Failed to fetch user joined events" });
    }
  });



  app.get('/api/user/achievements', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const achievements = await storage.getUserAchievements(userId);
      res.json(achievements);
    } catch (error) {
      console.error("Error fetching user achievements:", error);
      res.status(500).json({ message: "Failed to fetch user achievements" });
    }
  });

  app.get('/api/users/:userId/profile', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.params.userId;
      const currentUserId = getUserId(req);
      const profile = await storage.getUserProfile(userId, currentUserId);
      res.json(profile);
    } catch (error) {
      console.error("Error fetching user profile:", error);
      res.status(500).json({ message: "Failed to fetch user profile" });
    }
  });

  // Event lifecycle management routes
  app.post('/api/admin/events/:id/notify-starting', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      await storage.notifyEventStarting(eventId);
      res.json({ message: "Event starting notifications sent" });
    } catch (error) {
      console.error("Error sending event starting notifications:", error);
      res.status(500).json({ message: "Failed to send notifications" });
    }
  });

  app.post('/api/admin/events/:id/notify-ending', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      await storage.notifyEventEnding(eventId);
      res.json({ message: "Event ending notifications sent" });
    } catch (error) {
      console.error("Error sending event ending notifications:", error);
      res.status(500).json({ message: "Failed to send notifications" });
    }
  });

  // Admin event management routes
  app.delete('/api/admin/events/:id', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      await storage.deleteEvent(eventId);
      res.json({ message: "Event deleted successfully" });
    } catch (error) {
      console.error("Error deleting event:", error);
      res.status(500).json({ message: "Failed to delete event" });
    }
  });

  app.patch('/api/admin/events/:id/chat', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const { enabled } = req.body;
      await storage.toggleEventChat(eventId, enabled);
      res.json({ message: `Event chat ${enabled ? 'enabled' : 'disabled'}`, enabled });
    } catch (error) {
      console.error("Error toggling event chat:", error);
      res.status(500).json({ message: "Failed to toggle event chat" });
    }
  });

  // Admin challenge management routes
  app.get('/api/admin/challenges', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const challenges = await storage.getAllChallenges(limit);
      res.json(challenges);
    } catch (error) {
      console.error("Error fetching admin challenges:", error);
      res.status(500).json({ message: "Failed to fetch challenges" });
    }
  });

  app.get('/api/admin/users', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const users = await storage.getAllUsers();
      const result = limit ? users.slice(0, limit) : users;
      res.json(result);
    } catch (error) {
      console.error("Error fetching admin users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  app.post('/api/admin/users/:userId/action', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminUserId = req.user?.id || req.adminUser?.id;
      if (!adminUserId) {
        return res.status(401).json({ message: "Admin authentication required" });
      }

      const userId = String(req.params.userId || "").trim();
      const action = String(req.body?.action || "").trim().toLowerCase();
      const reason = String(req.body?.reason || "").trim();
      const value = req.body?.value;

      if (!userId) return res.status(400).json({ message: "Missing userId" });
      if (!reason) return res.status(400).json({ message: "Reason is required" });

      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ message: "User not found" });
      }

      let updatedUser: any = null;
      let resultMessage = "Action completed";

      switch (action) {
        case "ban": {
          updatedUser = await storage.banUser(userId, reason);
          resultMessage = "User banned successfully";
          break;
        }
        case "unban": {
          updatedUser = await storage.unbanUser(userId, reason);
          resultMessage = "User unbanned successfully";
          break;
        }
        case "balance": {
          const amount = Number(value);
          if (!Number.isFinite(amount) || amount === 0) {
            return res.status(400).json({ message: "Balance amount must be a non-zero number" });
          }
          updatedUser = await storage.adjustUserBalance(userId, amount, reason);
          resultMessage = `User balance ${amount > 0 ? "credited" : "debited"} successfully`;
          break;
        }
        case "admin": {
          const makeAdmin = String(value).trim().toLowerCase() === "true";
          if (!makeAdmin && userId === adminUserId) {
            return res.status(400).json({ message: "You cannot remove your own admin access" });
          }
          updatedUser = await storage.setUserAdminStatus(userId, makeAdmin, reason);
          resultMessage = makeAdmin ? "User promoted to admin" : "Admin access removed";
          break;
        }
        case "message": {
          const messageText = String(value || "").trim();
          if (!messageText) {
            return res.status(400).json({ message: "Message value is required" });
          }
          await storage.sendAdminMessage(userId, messageText, reason);
          updatedUser = await storage.getUser(userId);
          resultMessage = "Admin message sent";
          break;
        }
        case "password": {
          const nextPassword = String(value || "");
          if (nextPassword.length < 6) {
            return res.status(400).json({ message: "Password must be at least 6 characters" });
          }
          const hashedPassword = await hashPassword(nextPassword);
          updatedUser = await storage.updateUserProfile(userId, { password: hashedPassword } as any);
          resultMessage = "User password updated successfully";
          break;
        }
        default: {
          return res.status(400).json({ message: "Invalid action. Use ban|unban|balance|admin|message|password" });
        }
      }

      // Best-effort admin audit notification
      try {
        await storage.createNotification({
          userId: adminUserId,
          type: "system",
          title: "Admin action executed",
          message: `${resultMessage} for @${targetUser.username || targetUser.firstName || userId}`,
          data: {
            action,
            targetUserId: userId,
            reason,
          },
        } as any);
      } catch (auditErr) {
        console.error("Failed to create admin action audit notification:", auditErr);
      }

      const safeUser = updatedUser
        ? (() => {
            const { password, ...rest } = updatedUser as any;
            return rest;
          })()
        : null;

      res.json({
        message: resultMessage,
        user: safeUser,
      });
    } catch (error: any) {
      console.error("Error executing admin user action:", error);
      res.status(500).json({ message: error?.message || "Failed to execute user action" });
    }
  });

  // Admin challenge creation - handles both JSON and FormData
  app.post('/api/admin/challenges', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      // Log the request to debug
      console.log('\n🔍 ADMIN CHALLENGE CREATE REQUEST:');
      console.log('Body keys:', Object.keys(req.body));
      console.log('Has req.files:', !!req.files);
      console.log('req.files type:', Array.isArray(req.files) ? `Array (${req.files.length})` : typeof req.files);
      
      if (req.files) {
        if (Array.isArray(req.files)) {
          console.log('Files array:', req.files.map(f => ({ fieldname: f.fieldname, originalname: f.originalname, size: f.size })));
        } else {
          console.log('Files object:', Object.keys(req.files));
          // Handle case where multer puts files in an object instead of array
          for (const [key, val] of Object.entries(req.files)) {
            if (Array.isArray(val)) {
              console.log(`  - ${key}: [${val.map(f => f.originalname).join(', ')}]`);
            }
          }
        }
      }

      // When multer processes FormData with upload.any(), fields come in req.body
      // and files come in req.files array or object
      let { title, description, category, amount, endDate, dueDate, status, isVisible, adminCreated } = req.body;
      
      // FormData sends everything as strings, so parse them
      if (typeof amount === 'string') {
        amount = amount.trim();
      }
      if (typeof isVisible === 'string') {
        isVisible = isVisible === 'true';
      }
      if (typeof adminCreated === 'string') {
        adminCreated = adminCreated === 'true';
      }

      // Use dueDate if endDate isn't provided
      const dateField = endDate || dueDate;

      // Validate required fields
      if (!title || !category || amount === undefined || amount === null || amount === '') {
        console.log('❌ Validation failed:', { title, category, amount });
        return res.status(400).json({ message: `Missing required fields - title: ${title}, category: ${category}, amount: ${amount}` });
      }

      const amountNum = parseFloat(String(amount));
      if (isNaN(amountNum) || amountNum <= 0) {
        console.log('❌ Invalid amount:', amount);
        return res.status(400).json({ message: "Invalid amount. Must be a number greater than 0" });
      }

      // Handle cover image upload if provided - convert to base64 data URL
      let coverImageUrl: string | null = null;
      
      // Check both array format and object format for files
      let uploadedFile = null;
      if (req.files) {
        if (Array.isArray(req.files) && req.files.length > 0) {
          uploadedFile = req.files[0];
          console.log('✅ Found file in array format');
        } else if (!Array.isArray(req.files)) {
          // Check if coverImage field exists
          const files = req.files as any;
          if (files.coverImage) {
            uploadedFile = Array.isArray(files.coverImage) ? files.coverImage[0] : files.coverImage;
            console.log('✅ Found file in coverImage field');
          }
        }
      }
      
      if (uploadedFile) {
        try {
          // Convert buffer to base64 data URL
          const base64Data = uploadedFile.buffer.toString('base64');
          const mimeType = uploadedFile.mimetype || 'image/jpeg';
          coverImageUrl = `data:${mimeType};base64,${base64Data}`;
          console.log('✅ Cover image encoded as base64, size:', base64Data.length, 'bytes');
        } catch (err: any) {
          console.log('❌ Error encoding image:', err.message);
        }
      } else {
        console.log('⚠️ No file uploaded');
      }

      // Create admin challenge
      const challengeData = {
        challenger: null,
        challenged: null,
        title,
        description: description || null,
        category,
        amount: parseInt(String(amount)),
        challengerSide: req.body.challengerSide || null,
        status: status || "open",
        adminCreated: adminCreated !== false,
        bonusSide: null,
        bonusMultiplier: "1.00",
        bonusEndsAt: null,
        yesStakeTotal: 0,
        noStakeTotal: 0,
        dueDate: dateField ? new Date(dateField) : null,
        coverImageUrl,
      };

      const challenge = await storage.createAdminChallenge(challengeData);
      console.log('✅ Challenge created successfully:', challenge.id);

      // Trigger notification infrastructure for newly created admin challenge
      try {
        const yesMultiplier = parseFloat(String(challenge.bonusMultiplier || '1.00')) || 1;
        // Fire-and-forget to avoid delaying the response to the admin
        notificationInfrastructure.handleChallengeCreated(String(challenge.id), challenge.title, yesMultiplier, (req as any).user?.id).catch((err) => {
          console.error('Error in notificationInfrastructure.handleChallengeCreated:', err);
        });
      } catch (notifErr) {
        console.error('Failed to trigger notifications for admin challenge:', notifErr);
      }

      // Broadcast to Telegram channel for admin-created challenges
      const telegramBot = getTelegramBot();
      if (telegramBot) {
        try {
          const admin = await storage.getUser((req as any).user?.id);
          const stakeBroadcastMeta = buildChallengeStakeBroadcastMeta(challenge);
          await telegramBot.broadcastChallenge({
            id: challenge.id,
            title: challenge.title,
            description: challenge.description || undefined,
            creator: {
              name: admin?.firstName || admin?.username || 'Admin',
              username: admin?.username || undefined,
            },
            stake_amount: parseFloat(String(challenge.amount || '0')),
            stake_display: stakeBroadcastMeta.stakeDisplay,
            settlement_label: stakeBroadcastMeta.settlementLabel,
            status: challenge.status,
            end_time: challenge.dueDate,
            category: category,
          });
          console.log("📤 Admin challenge broadcasted to Telegram successfully");
        } catch (error) {
          console.error("❌ Failed to broadcast admin challenge to Telegram:", error);
        }
      }

      res.json(challenge);
    } catch (error: any) {
      console.error("❌ Error creating admin challenge:", error);
      console.error("Error details:", {
        message: error?.message,
        code: error?.code,
        detail: error?.detail,
        stack: error?.stack,
      });
      res.status(500).json({ 
        message: "Failed to create admin challenge",
        error: error?.message || "Unknown error"
      });
    }
  });
        


  // Get challenges awaiting admin resolution (pending_admin status)
  app.get('/api/admin/challenges/pending', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const allChallenges = await storage.getAllChallenges(1000); // Get more to filter
      const pendingChallenges = allChallenges.filter((c: any) => c.status === 'pending_admin');
      res.json(pendingChallenges);
    } catch (error) {
      console.error("Error fetching pending challenges:", error);
      res.status(500).json({ message: "Failed to fetch pending challenges" });
    }
  });

  app.post('/api/admin/challenges/:id/result', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const { result } = req.body;

      if (!['challenger_won', 'challenged_won', 'draw'].includes(result)) {
        return res.status(400).json({ message: "Invalid result. Must be 'challenger_won', 'challenged_won', or 'draw'" });
      }

      const outcome = await settleChallengeResultAndQueuePayout({
        challengeId,
        result,
        resolvedByUserId: req.user?.id || null,
      });

      res.json(outcome);
    } catch (error: any) {
      console.error("Error setting challenge result:", error);
      res.status(500).json({ message: error?.message || "Failed to set challenge result" });
    }
  });

  // Get escrow status for a specific challenge
  app.get('/api/admin/challenges/:id/escrow', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      if (isNaN(challengeId)) return res.status(400).json({ message: 'Invalid challenge id' });
      const escrowStatus = await storage.getChallengeEscrowStatus(challengeId);
      res.json(escrowStatus);
    } catch (error) {
      console.error('Error fetching escrow status:', error);
      res.status(500).json({ message: 'Failed to fetch escrow status' });
    }
  });

  // Get payout job status
  app.get('/api/admin/payout-jobs/:jobId/status', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const jobId = req.params.jobId;
      const jobStatus = await payoutQueue.getJobStatus(jobId);
      
      if (!jobStatus) {
        return res.status(404).json({ message: 'Payout job not found' });
      }
      
      // Calculate progress percentage
      const progressPercent = jobStatus.totalWinners > 0 
        ? Math.round((jobStatus.processedWinners / jobStatus.totalWinners) * 100)
        : 0;
      
      res.json({
        jobId: jobStatus.id,
        challengeId: jobStatus.challengeId,
        status: jobStatus.status,
        totalWinners: jobStatus.totalWinners,
        processedWinners: jobStatus.processedWinners,
        progressPercent,
        createdAt: jobStatus.createdAt,
        completedAt: jobStatus.completedAt,
        error: jobStatus.error
      });
    } catch (error) {
      console.error('Error fetching payout job status:', error);
      res.status(500).json({ message: 'Failed to fetch payout job status' });
    }
  });

  app.delete('/api/admin/challenges/:id', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      await storage.deleteChallenge(challengeId);
      res.json({ message: "Challenge deleted successfully" });
    } catch (error) {
      console.error("Error deleting challenge:", error);
      res.status(500).json({ message: "Failed to delete challenge" });
    }
  });

  // Toggle challenge pin status
  app.patch('/api/admin/challenges/:id/pin', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const { isPinned } = req.body;
      
      const updatedChallenge = await db.update(challenges)
        .set({ isPinned })
        .where(eq(challenges.id, challengeId))
        .returning();

      if (updatedChallenge.length === 0) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      res.json({
        message: isPinned ? "Challenge pinned to the top" : "Challenge unpinned",
        isPinned,
        challenge: updatedChallenge[0]
      });
    } catch (error) {
      console.error("Error toggling challenge pin:", error);
      res.status(500).json({ message: "Failed to toggle challenge pin status" });
    }
  });

  // Get all escrow data and statistics
  app.get('/api/admin/escrow', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challenges = await storage.getAllEscrowData(100);
      const stats = await storage.getEscrowStats();
      res.json({
        stats,
        challenges
      });
    } catch (error) {
      console.error('Error fetching escrow data:', error);
      res.status(500).json({ message: 'Failed to fetch escrow data' });
    }
  });

  // Get escrow statistics summary
  app.get('/api/admin/escrow/stats', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const stats = await storage.getEscrowStats();
      res.json(stats);
    } catch (error) {
      console.error('Error fetching escrow stats:', error);
      res.status(500).json({ message: 'Failed to fetch escrow stats' });
    }
  });

  // Get detailed escrow data for a specific challenge
  app.get('/api/admin/escrow/challenge/:id', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const escrowData = await storage.getDetailedEscrowData(challengeId);
      res.json(escrowData);
    } catch (error) {
      console.error('Error fetching detailed escrow data:', error);
      res.status(500).json({ message: 'Failed to fetch escrow details' });
    }
  });

  // Update challenge (admin editable fields at any time)
  app.put('/api/admin/challenges/:id', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const {
        title,
        description,
        isVisible,
        endDate,
        coverImageUrl,
        category,
        amount,
        status,
        bonusSide,
        bonusAmount,
        bonusMultiplier,
        bonusEndsAt,
        earlyBirdSlots,
        earlyBirdBonus,
        streakBonusEnabled,
        convictionBonusEnabled,
        firstTimeBonusEnabled,
        socialTagBonus,
      } = req.body;

      // Build update object - only update provided fields
      const updates: any = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (isVisible !== undefined) updates.isVisible = isVisible;
      if (endDate !== undefined) updates.dueDate = endDate ? new Date(endDate) : null;
      if (coverImageUrl !== undefined) updates.coverImageUrl = coverImageUrl;
      if (category !== undefined) updates.category = category;
      if (amount !== undefined) updates.amount = String(amount);
      
      const oldStatus = (await db.select().from(challenges).where(eq(challenges.id, challengeId)).limit(1))[0]?.status;
      if (status !== undefined) updates.status = status;

      // Bonus related fields
      if (bonusSide !== undefined) updates.bonusSide = bonusSide;
      if (bonusAmount !== undefined) updates.bonusAmount = bonusAmount;
      if (bonusMultiplier !== undefined) updates.bonusMultiplier = bonusMultiplier;
      if (bonusEndsAt !== undefined) updates.bonusEndsAt = bonusEndsAt ? new Date(bonusEndsAt) : null;

      // Other optional bonus/feature flags
      if (earlyBirdSlots !== undefined) updates.earlyBirdSlots = earlyBirdSlots;
      if (earlyBirdBonus !== undefined) updates.earlyBirdBonus = earlyBirdBonus;
      if (streakBonusEnabled !== undefined) updates.streakBonusEnabled = streakBonusEnabled;
      if (convictionBonusEnabled !== undefined) updates.convictionBonusEnabled = convictionBonusEnabled;
      if (firstTimeBonusEnabled !== undefined) updates.firstTimeBonusEnabled = firstTimeBonusEnabled;
      if (socialTagBonus !== undefined) updates.socialTagBonus = socialTagBonus;

      const updatedChallenge = await storage.updateChallenge(challengeId, updates);

      // Trigger status-based notifications if status changed
      if (status !== undefined && status !== oldStatus) {
        try {
          const { challengeNotificationTriggers } = await import('./challengeNotificationTriggers');
          if (status === 'pending_admin') {
            await challengeNotificationTriggers.onChallengePendingAdmin(String(challengeId));
          } else if (status === 'completed') {
            // Note: usually handled by payout or result route, but here for manual admin override
            await challengeNotificationTriggers.onChallengeCompleted(String(challengeId), 'DRAW');
          } else if (status === 'cancelled') {
            await challengeNotificationTriggers.onChallengeCancelled(String(challengeId), 'Admin update');
          }
        } catch (notifErr) {
          console.error('Error triggering status change notification:', notifErr);
        }
      }

      res.json(updatedChallenge);
    } catch (error) {
      console.error("Error updating challenge:", error);
      res.status(500).json({ message: "Failed to update challenge" });
    }
  });

  app.post('/api/admin/challenges/:id/repair-cover', adminAuth, async (req: AdminAuthRequest, res, next) => {
    try {
      if (!upload || typeof upload.single !== "function") {
        return res.status(500).json({ message: "Upload middleware unavailable" });
      }
      return upload.single("coverImage")(req, res, next);
    } catch (error) {
      return next(error);
    }
  }, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = Number.parseInt(String(req.params.id || ""), 10);
      if (!Number.isFinite(challengeId) || challengeId <= 0) {
        return res.status(400).json({ message: "Invalid challenge ID" });
      }

      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      const imageFile = (req as any).file as {
        mimetype?: string;
        size?: number;
        originalname?: string;
        buffer: Buffer;
      } | undefined;

      let repairedCoverImageUrl: string | null = null;

      if (imageFile) {
        const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
        if (!allowedTypes.includes(String(imageFile.mimetype || "").toLowerCase())) {
          return res.status(400).json({
            message: "Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.",
          });
        }

        const maxSize = 8 * 1024 * 1024;
        if (Number(imageFile.size || 0) > maxSize) {
          return res.status(400).json({ message: "File too large. Maximum size is 8MB." });
        }

        const stored = await storeUploadedImage(imageFile, {
          userId: req.adminUser?.id || req.user?.id || null,
          prefix: "challenge-cover",
        });

        repairedCoverImageUrl = stored.imageUrl;
      } else if (typeof req.body?.coverImageUrl === "string") {
        repairedCoverImageUrl = normalizeChallengeCoverImageUrl(req.body.coverImageUrl);
        if (!repairedCoverImageUrl) {
          return res.status(400).json({
            message: "coverImageUrl must be a valid Bantah media path, asset path, data image, or public URL.",
          });
        }
      } else {
        return res.status(400).json({
          message: "Provide a coverImage upload or a valid coverImageUrl to repair the challenge cover.",
        });
      }

      const updatedChallenge = await storage.updateChallenge(challengeId, {
        coverImageUrl: repairedCoverImageUrl,
      });

      return res.json({
        success: true,
        challengeId,
        previousCoverImageUrl: challenge.coverImageUrl || null,
        coverImageUrl: repairedCoverImageUrl,
        challenge: updatedChallenge,
      });
    } catch (error) {
      console.error("Error repairing challenge cover:", error);
      return res.status(500).json({ message: "Failed to repair challenge cover" });
    }
  });

  // Toggle challenge visibility
  app.patch('/api/admin/challenges/:id/visibility', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const { isVisible } = req.body;

      if (isVisible === undefined) {
        return res.status(400).json({ message: "Missing field: isVisible" });
      }

      const updatedChallenge = await storage.updateChallenge(challengeId, { isVisible });
      res.json({
        message: `Challenge ${isVisible ? 'unhidden' : 'hidden'} successfully`,
        challenge: updatedChallenge,
      });
    } catch (error) {
      console.error("Error toggling challenge visibility:", error);
      res.status(500).json({ message: "Failed to toggle challenge visibility" });
    }
  });

  // Admin Wallet - Get balance and stats
  app.get('/api/admin/wallet', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user.id;
      const admin = await db.query.users.findFirst({
        where: eq(users.id, adminId),
      });

      if (!admin) {
        return res.status(404).json({ message: "Admin not found" });
      }

      // Get transaction history
      const transactions = await db.query.adminWalletTransactions.findMany({
        where: eq(adminWalletTransactions.adminId, adminId),
        orderBy: (t) => sql`${t.createdAt} DESC`,
        limit: 50,
      });

      res.json({
        balance: parseFloat(String(admin.adminWalletBalance || '0')),
        totalCommission: parseFloat(String(admin.adminTotalCommission || '0')),
        totalBonusesGiven: parseFloat(String(admin.adminTotalBonusesGiven || '0')),
        transactions,
      });
    } catch (error) {
      console.error("Error fetching admin wallet:", error);
      res.status(500).json({ message: "Failed to fetch wallet details" });
    }
  });

  // Admin Wallet - Load funds (from Paystack)
  app.post('/api/admin/wallet/load', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const { amount } = req.body;
      const adminId = req.user.id;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      if (!process.env.PAYSTACK_SECRET_KEY) {
        console.error("PAYSTACK_SECRET_KEY environment variable not set");
        return res.status(500).json({ message: "Payment service not configured" });
      }

      console.log("Initializing Paystack transaction for admin:", adminId, "amount:", amount);

      // Generate unique reference
      const uniqueRef = `adm_load_${adminId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      // Initialize Paystack transaction
      const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: "admin@betchat.com",
          amount: amount * 100, // Paystack expects amount in kobo
          currency: 'NGN',
          reference: uniqueRef,
          metadata: {
            adminId,
            type: 'admin_load'
          }
        })
      });

      const paystackData = await paystackResponse.json();
      console.log("Paystack response:", paystackData);

      if (!paystackData.status) {
        console.error("Paystack error:", paystackData);
        return res.status(400).json({ message: paystackData.message || "Failed to initialize payment" });
      }

      console.log("Sending authorization URL:", paystackData.data.authorization_url);
      res.json({ 
        authorization_url: paystackData.data.authorization_url,
        access_code: paystackData.data.access_code,
        reference: paystackData.data.reference,
      });
    } catch (error) {
      console.error("Error processing admin wallet load:", error);
      res.status(500).json({ message: "Failed to process payment" });
    }
  });

  // Admin Wallet - Verify payment
  app.post('/api/admin/wallet/verify-payment', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const { reference } = req.body;
      const adminId = req.user.id;

      if (!reference) {
        return res.status(400).json({ message: "Reference is required" });
      }

      console.log(`Admin payment verification requested for reference: ${reference} by admin: ${adminId}`);

      if (!process.env.PAYSTACK_SECRET_KEY) {
        console.error("PAYSTACK_SECRET_KEY not set");
        return res.status(500).json({ message: "Payment service not configured" });
      }

      // Verify payment with Paystack
      const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        }
      });

      const verifyData = await verifyResponse.json();
      console.log('Paystack verification response:', {
        status: verifyData.status,
        data: verifyData.data ? {
          status: verifyData.data.status,
          amount: verifyData.data.amount,
          reference: verifyData.data.reference,
          metadata: verifyData.data.metadata
        } : null
      });

      if (verifyData.status && verifyData.data && verifyData.data.status === 'success') {
        const { amount, metadata, reference: txRef } = verifyData.data;
        const depositAmount = amount / 100; // Convert from kobo to naira

        console.log(`Processing admin payment verification:`, {
          amount: depositAmount,
          metadata,
          reference: txRef,
          adminId
        });

        // Validate the admin matches
        if (metadata && metadata.adminId === adminId) {
          const admin = await db.query.users.findFirst({
            where: eq(users.id, adminId),
          });

          if (!admin) {
            return res.status(404).json({ message: "Admin not found" });
          }

          // Check if transaction already exists by reference
          const existingTransactions = await db.query.adminWalletTransactions.findMany({
            where: eq(adminWalletTransactions.adminId, adminId),
          });

          const exists = existingTransactions.some((t: any) => 
            t.reference === reference || 
            t.reference === txRef
          );

          if (exists) {
            return res.status(400).json({ message: "This payment has already been processed" });
          }

          const currentBalance = parseFloat(String(admin.adminWalletBalance || '0'));
          const newBalance = currentBalance + depositAmount;

          // Update admin wallet balance
          await db
            .update(users)
            .set({ adminWalletBalance: newBalance.toString() })
            .where(eq(users.id, adminId));

          // Log transaction
          await db.insert(adminWalletTransactions).values({
            adminId,
            type: 'fund_load',
            amount: depositAmount.toString(),
            description: `Funds loaded via Paystack`,
            reference: reference,
            status: 'completed',
            balanceBefore: currentBalance.toString(),
            balanceAfter: newBalance.toString(),
          });

          console.log(`Admin payment verified and processed successfully`);
          return res.json({
            message: 'Payment verified and balance updated',
            balance: newBalance,
          });
        } else {
          return res.status(400).json({ message: "Payment verification failed: Admin mismatch" });
        }
      } else {
        return res.status(400).json({ message: "Payment not successful or already processed" });
      }
    } catch (error) {
      console.error("Error verifying admin payment:", error);
      res.status(500).json({ message: "Failed to verify payment" });
    }
  });

  // Admin Wallet - Withdraw funds
  app.post('/api/admin/wallet/withdraw', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const { amount } = req.body;
      const adminId = req.user.id;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      if (!process.env.PAYSTACK_SECRET_KEY) {
        console.error("PAYSTACK_SECRET_KEY environment variable not set");
        return res.status(500).json({ message: "Payment service not configured" });
      }

      const admin = await db.query.users.findFirst({
        where: eq(users.id, adminId),
      });

      if (!admin) {
        return res.status(404).json({ message: "Admin not found" });
      }

      const currentBalance = parseFloat(String(admin.adminWalletBalance || '0'));

      if (currentBalance < amount) {
        return res.status(400).json({ 
          message: `Insufficient balance. Have ₦${currentBalance.toLocaleString()}, need ₦${amount.toLocaleString()}` 
        });
      }

      // For production: Check if admin has bank details stored
      // TODO: Store and retrieve admin's bank account details
      // For now, return message that they need to set up their bank account
      
      console.log(`Processing withdrawal for admin ${adminId}: ₦${amount}`);

      // Deduct from balance first
      const newBalance = currentBalance - amount;

      await db
        .update(users)
        .set({ adminWalletBalance: newBalance.toString() })
        .where(eq(users.id, adminId));

      // Generate withdrawal reference
      const withdrawalRef = `adm_withdrawal_${adminId}_${Date.now()}`;

      // Log transaction as pending (awaiting bank processing)
      await db.insert(adminWalletTransactions).values({
        adminId,
        type: 'withdrawal',
        amount: amount.toString(),
        description: `Withdrawal from admin wallet to bank account`,
        reference: withdrawalRef,
        status: 'pending',
        balanceBefore: currentBalance.toString(),
        balanceAfter: newBalance.toString(),
      });

      // In production, this would:
      // 1. Create transfer recipient in Paystack using stored bank details
      // 2. Initiate transfer using Paystack Transfer API
      // 3. Update transaction status to 'processing'
      // 4. Handle webhooks for transfer completion
      
      // For now, return pending status with instructions
      res.json({
        message: 'Withdrawal initiated - funds pending to your registered bank account',
        amount: amount,
        balance: newBalance,
        reference: withdrawalRef,
        status: 'pending',
        note: 'This withdrawal will be processed to your bank account. Please allow 1-3 business days for the funds to arrive.'
      });
    } catch (error) {
      console.error("Error withdrawing funds:", error);
      res.status(500).json({ message: "Failed to process withdrawal" });
    }
  });

  // Activate bonus for imbalanced challenge
  app.post('/api/admin/challenges/bonus', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const { challengeId, bonusSide, bonusMultiplier, durationHours, bonusAmount } = req.body;
      const adminId = req.user.id;

      // Validate required fields
      if (!challengeId || !bonusSide || !bonusMultiplier || !durationHours) {
        return res.status(400).json({ message: "Missing required fields: challengeId, bonusSide, bonusMultiplier, durationHours" });
      }

      // Validate bonus side
      if (!['YES', 'NO'].includes(bonusSide)) {
        return res.status(400).json({ message: "Invalid bonus side. Must be 'YES' or 'NO'" });
      }

      // Validate multiplier range
      if (bonusMultiplier < 1.0 || bonusMultiplier > 5.0) {
        return res.status(400).json({ message: "Bonus multiplier must be between 1.0 and 5.0" });
      }

      // Check admin wallet balance
      const admin = await db.query.users.findFirst({
        where: eq(users.id, adminId),
      });

      if (!admin) {
        return res.status(404).json({ message: "Admin not found" });
      }

      const adminBalance = parseFloat(String(admin.adminWalletBalance || '0'));
      const bonusAmountNum = bonusAmount || 0;

      if (bonusAmountNum > 0 && adminBalance < bonusAmountNum) {
        return res.status(400).json({ 
          message: `Insufficient wallet balance. Need ₦${bonusAmountNum.toLocaleString()}, but only have ₦${adminBalance.toLocaleString()}` 
        });
      }

      // Calculate bonus end time
      const bonusEndsAt = new Date();
      bonusEndsAt.setHours(bonusEndsAt.getHours() + durationHours);

      // Deduct from admin wallet if bonus amount specified
      if (bonusAmountNum > 0) {
        const newBalance = adminBalance - bonusAmountNum;
        const totalGiven = parseFloat(String(admin.adminTotalBonusesGiven || '0')) + bonusAmountNum;

        await db
          .update(users)
          .set({
            adminWalletBalance: newBalance.toString(),
            adminTotalBonusesGiven: totalGiven.toString(),
          })
          .where(eq(users.id, adminId));

        // Log the transaction
        await db.insert(adminWalletTransactions).values({
          adminId,
          type: 'bonus_sent',
          amount: bonusAmountNum.toString(),
          description: `Bonus sent to challenge #${challengeId}: ${bonusMultiplier}x multiplier on ${bonusSide} side`,
          relatedId: challengeId,
          relatedType: 'challenge',
          balanceBefore: adminBalance.toString(),
          balanceAfter: newBalance.toString(),
        });
      }

      // Update challenge with bonus
      const updatedChallenge = await storage.activateChallengeBonus(challengeId, {
        bonusSide,
        bonusMultiplier: bonusMultiplier.toString(),
        bonusAmount: bonusAmount || 0,
        bonusEndsAt,
      });

      res.json({ 
        challenge: updatedChallenge,
        message: `Bonus activated for ${bonusSide} side: ${bonusMultiplier}x multiplier for ${durationHours} hours`
      });
    } catch (error) {
      console.error("Error activating bonus:", error);
      res.status(500).json({ message: error.message || "Failed to activate bonus" });
    }
  });

  // Admin transactions - list recent transactions across platform
  app.get('/api/admin/transactions', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;

      const txs = await db
        .select({
          id: transactions.id,
          userId: transactions.userId,
          type: transactions.type,
          amount: transactions.amount,
          status: transactions.status,
          description: transactions.description,
          createdAt: transactions.createdAt,
          username: users.username,
          email: users.email,
        })
        .from(transactions)
        .leftJoin(users, eq(transactions.userId, users.id))
        .orderBy(desc(transactions.createdAt))
        .limit(limit);

      res.json(txs);
    } catch (error) {
      console.error('Error fetching admin transactions:', error);
      res.status(500).json({ message: 'Failed to fetch transactions' });
    }
  });

  // Admin statistics routes

  // Get current admin users
  app.get('/api/admin/list', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const admins = await storage.getAdminUsers();
      res.json(admins);
    } catch (error) {
      console.error("Error fetching admin users:", error);
      res.status(500).json({ message: "Failed to fetch admin users" });
    }
  });

  // Smart Search API
  app.get('/api/search', async (req, res) => {
    try {
      const { q: searchTerm } = req.query;

      if (!searchTerm || typeof searchTerm !== 'string' || searchTerm.length < 3) {
        return res.json([]);
      }

      const search = `%${searchTerm.toLowerCase()}%`;

      // Search events
      const eventResults = await db
        .select({
          id: events.id,
          title: events.title,
          description: events.description,
          imageUrl: events.imageUrl,
          createdAt: events.createdAt,
          status: events.status,
        })
        .from(events)
        .where(
          sql`LOWER(${events.title}) LIKE ${search} OR LOWER(${events.description}) LIKE ${search}`
        )
        .limit(5);

      // Search challenges  
      const challengeResults = await db
        .select({
          id: challenges.id,
          title: challenges.title,
          description: challenges.description,
          amount: challenges.amount,
          createdAt: challenges.createdAt,
          status: challenges.status,
        })
        .from(challenges)
        .where(
          sql`LOWER(${challenges.title}) LIKE ${search} OR LOWER(${challenges.description}) LIKE ${search}`
        )
        .limit(5);

      // Search users
      const userResults = await db
        .select({
          id: users.id,
          username: users.username,
          firstName: users.firstName,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(
          sql`LOWER(${users.username}) LIKE ${search} OR LOWER(${users.firstName}) LIKE ${search}`
        )
        .limit(5);

      // Format results
      const results = [
        ...eventResults.map(event => ({
          id: event.id.toString(),
          type: 'event' as const,
          title: event.title,
          description: event.description,
          imageUrl: event.imageUrl,
          createdAt: event.createdAt,
          status: event.status,
          participantCount: 0, // TODO: Add participant count query
        })),
        ...challengeResults.map(challenge => ({
          id: challenge.id.toString(),
          type: 'challenge' as const,
          title: challenge.title,
          description: challenge.description,
          amount: Number(challenge.amount),
          createdAt: challenge.createdAt,
          status: challenge.status,
        })),
        ...userResults.map(user => ({
          id: user.id,
          type: 'user' as const,
          title: user.firstName || user.username || 'Unknown User',
          username: user.username,
          createdAt: user.createdAt,
        })),
      ];

      // Sort by relevance and creation date
      results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      res.json(results.slice(0, 10));
    } catch (error) {
      console.error("Error performing search:", error);
      res.status(500).json({ message: "Search failed" });
    }
  });

  // Public profile routes (no authentication required)
  app.get('/api/public/users/:userId/basic', async (req, res) => {
    try {
      const { userId } = req.params;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      return res.json({
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        profileImageUrl: user.profileImageUrl,
      });
    } catch (error) {
      console.error("Error fetching public user basic profile:", error);
      res.status(500).json({ message: "Failed to fetch user profile" });
    }
  });

  app.get('/api/public/profile/:username', async (req, res) => {
    try {
      const { username } = req.params;

      // Get user by username
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get user stats
      const stats = await storage.getUserStats(user.id);

      // Return public profile data (excluding sensitive information)
      const publicProfile = {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        profileImageUrl: user.profileImageUrl,
        level: user.level,
        xp: user.xp,
        streak: user.streak,
        createdAt: user.createdAt,
        stats: {
          wins: stats.wins || 0,
          activeChallenges: stats.activeChallenges || 0,
          totalEarnings: stats.totalEarnings || 0,
        }
      };

      res.json(publicProfile);
    } catch (error) {
      console.error("Error fetching public profile:", error);
      res.status(500).json({ message: "Failed to fetch public profile" });
    }
  });

  app.get('/api/public/achievements/:username', async (req, res) => {
    try {
      const { username } = req.params;

      // Get user by username
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get user achievements
      const achievements = await storage.getUserAchievements(user.id);
      res.json(achievements);
    } catch (error) {
      console.error("Error fetching public achievements:", error);
      res.status(500).json({ message: "Failed to fetch public achievements" });
    }
  });

  app.get('/api/public/events/:username', async (req, res) => {
    try {
      const { username } = req.params;

      // Get user by username
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get user's public events (recent 10)
      const events = await storage.getUserCreatedEvents(user.id);

      // Filter out private events and return only public data
      const publicEvents = events
        .filter((event: any) => !event.isPrivate)
        .slice(0, 10)
        .map((event: any) => ({
          id: event.id,
          title: event.title,
          category: event.category,
          status: event.status,
          createdAt: event.createdAt,
          endDate: event.endDate,
        }));

      res.json(publicEvents);
    } catch (error) {
      console.error("Error fetching public events:", error);
      res.status(500).json({ message: "Failed to fetch public events" });
    }
  });

  // Redirect old /u/:username format to new /@username format
  app.get('/u/:username', async (req, res) => {
    const { username } = req.params;
    res.redirect(301, `/@${username}`);
  });

  // Server-side route for events/:id with OG metadata for social sharing
  app.get('/events/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const baseUrl = `${req.protocol}://${req.get('host')}`;

      // Check if this is likely a social media crawler
      const userAgent = req.get('User-Agent') || '';
      console.log(`[EVENTS ROUTE] Event ${id}, User-Agent: ${userAgent}`);

      const isCrawler = userAgent.includes('facebookexternalhit') || 
                       userAgent.includes('Twitterbot') || 
                       userAgent.includes('LinkedInBot') ||
                       userAgent.includes('WhatsApp') ||
                       userAgent.includes('TelegramBot') ||
                       userAgent.includes('SkypeUriPreview');

      console.log(`[EVENTS ROUTE] isCrawler: ${isCrawler}`);

      if (isCrawler) {
        console.log(`[EVENTS ROUTE] Generating OG meta for event ${id}`);
        const ogMeta = await generateEventOGMeta(id, baseUrl);
        console.log(`[EVENTS ROUTE] Generated OG meta:`, ogMeta.title);

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${ogMeta.title}</title>
    ${generateOGMetaTags(ogMeta)}
</head>
<body>
    <h1>${ogMeta.title}</h1>
    <p>${ogMeta.description}</p>
    <p><a href="${baseUrl}/events/${id}">View Event on Bantah</a></p>
</body>
</html>`;

        res.set('Content-Type', 'text/html');
        res.send(html);
        return;
      }

      // For regular browsers, serve the React app (will be handled by client-side routing)
      res.redirect(`/#/events/${id}`);
    } catch (error) {
      console.error('Error generating event page:', error);
      res.redirect('/#/events');
    }
  });

  app.get('/share/challenges/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const numericId = parseInt(id, 10);
      if (Number.isNaN(numericId)) {
        return res.status(400).send("Invalid challenge id");
      }

      const challenge = await storage.getChallengeById(numericId);
      if (!challenge) {
        return res.status(404).send("Challenge not found");
      }

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const ogMeta = await generateChallengeOGMeta(id, baseUrl);
      const redirectPath = `/challenges/${numericId}`;
      const html = renderShareRedirectPage(ogMeta, redirectPath, generateOGMetaTags(ogMeta));

      res.set("Content-Type", "text/html");
      res.set("Cache-Control", "no-store, max-age=0");
      res.send(html);
    } catch (error) {
      console.error("Error generating challenge share page:", error);
      res.redirect("/challenges");
    }
  });

  app.get('/profile/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const ogMeta = await generateProfileOGMeta(userId, baseUrl);

      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${generateOGMetaTags(ogMeta)}
    <script>
      // Redirect to main app
      window.location.href = '/#/profile/${userId}';
    </script>
</head>
<body>
    <p>Redirecting to Bantah...</p>
    <a href="/#/profile/${userId}">Click here if you're not redirected automatically</a>
</body>
</html>`;

      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      console.error('Error generating profile page:', error);
      res.redirect('/#/profile');
    }
  });

  // Stories API endpoints
  app.get('/api/stories', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const stories = await storage.getActiveStories();
      res.json(stories);
    } catch (error) {
      console.error("Error fetching stories:", error);
      res.status(500).json({ message: "Failed to fetch stories" });
    }
  });

  app.post('/api/stories', isAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const storyData = req.body;
      const story = await storage.createStory(storyData);
      res.json(story);
    } catch (error) {
      console.error("Error creating story:", error);
      res.status(500).json({ message: "Failed to create story" });
    }
  });

  app.patch('/api/stories/:id', isAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const storyId = parseInt(req.params.id);
      const updates = req.body;
      const story = await storage.updateStory(storyId, updates);
      res.json(story);
    } catch (error) {
      console.error("Error updating story:", error);
      res.status(500).json({ message: "Failed to update story" });
    }
  });

  app.delete('/api/stories/:id', isAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const storyId = parseInt(req.params.id);
      await storage.deleteStory(storyId);
      res.json({ message: "Story deleted successfully" });
    } catch (error) {
      console.error("Error deleting story:", error);
      res.status(500).json({ message: "Failed to delete story" });
    }
  });

  app.post('/api/stories/:id/view', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const storyId = parseInt(req.params.id);
      await storage.markStoryAsViewed(storyId, userId);
      res.json({ message: "Story marked as viewed" });
    } catch (error) {
      console.error("Error marking story as viewed:", error);
      res.status(500).json({ message: "Failed to mark story as viewed" });
    }
  });

  // Image upload route for event banners and profile photos
  app.post('/api/upload/image', PrivyAuthMiddleware, async (req, res, next) => {
    try {
      if (!upload || typeof upload.single !== "function") {
        return res.status(500).json({ message: "Upload middleware unavailable" });
      }
      return upload.single("image")(req, res, next);
    } catch (error) {
      return next(error);
    }
  }, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user?.id || req.user?.claims?.sub;
      const imageFile = (req as any).file;

      if (!imageFile) {
        return res.status(400).json({ message: 'No image file provided' });
      }

      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(String(imageFile.mimetype || '').toLowerCase())) {
        return res.status(400).json({ message: 'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.' });
      }

      const maxSize = 5 * 1024 * 1024;
      if (Number(imageFile.size || 0) > maxSize) {
        return res.status(400).json({ message: 'File too large. Maximum size is 5MB.' });
      }

      const stored = await storeUploadedImage(imageFile, {
        userId: typeof userId === "string" ? userId : null,
        prefix: "image",
      });

      console.log(`Image uploaded successfully: ${stored.imageUrl} by user ${userId}`);

      res.json({
        success: true,
        imageUrl: stored.imageUrl,
        filename: stored.filename,
      });
    } catch (error) {
      console.error('Error uploading image:', error);
      res.status(500).json({ message: 'Failed to upload image' });
    }
  });

  app.get('/api/media/:id', async (req, res) => {
    try {
      const asset = await getStoredMediaAsset(String(req.params.id || ""));
      if (!asset) {
        return res.status(404).json({ message: "Media asset not found" });
      }

      if (asset.storage_kind === "cloudinary" && asset.remote_url) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.redirect(302, asset.remote_url);
      }

      if (asset.storage_kind === "database" && asset.data_base64) {
        const payload = Buffer.from(asset.data_base64, "base64");
        res.setHeader("Content-Type", asset.mime_type || "application/octet-stream");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.send(payload);
      }

      if (asset.storage_kind === "local" && asset.local_path) {
        return res.sendFile(path.resolve(asset.local_path));
      }

      return res.status(404).json({ message: "Media asset payload unavailable" });
    } catch (error) {
      console.error("Error serving media asset:", error);
      return res.status(500).json({ message: "Failed to load media asset" });
    }
  });

  // Serve uploaded images
  app.use('/attached_assets', (await import('express')).static('./attached_assets'));

  // Setup OG image generation routes
  setupOGImageRoutes(app, storage);

  // Add leaderboard endpoint
  app.get("/api/leaderboard", async (_req, res) => {
    try {
      const leaderboard = await storage.getLeaderboard();
      console.log(`Leaderboard query returned ${leaderboard.length} users`);
      res.json(leaderboard);
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

  // Get user stats for performance comparison
  app.get("/api/performance-stats", PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);
      const stats = await storage.getUserStats(userId);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching user stats:", error);
      res.status(500).json({ message: "Failed to fetch user stats" });
    }
  });

  // Bant Map - Get all users with their category preferences for map visualization
  app.get("/api/bant-map", PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getUserId(req);

      // Get all active users with basic info
      const allUsers = await db
        .select({
          id: users.id,
          username: users.username,
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
          level: users.level,
          xp: users.xp,
          coins: users.coins,
          lastLogin: users.lastLogin,
        })
        .from(users)
        .where(eq(users.status, 'active'))
        .orderBy(desc(users.level), desc(users.xp));

      // Get current user's friends
      const userFriends = await db
        .select({
          requesterId: friends.requesterId,
          addresseeId: friends.addresseeId,
        })
        .from(friends)
        .where(
          and(
            or(eq(friends.requesterId, userId), eq(friends.addresseeId, userId)),
            eq(friends.status, "accepted")
          )
        );

      const friendIds = new Set(
        userFriends.map(f => f.requesterId === userId ? f.addresseeId : f.requesterId)
      );

      // Get category preferences for each user based on their event participation
      const usersWithCategories = await Promise.all(
        allUsers.map(async (user) => {
          // Get user's most participated category
          const categoryStats = await db
            .select({
              category: events.category,
              count: sql<number>`count(*)`,
            })
            .from(eventParticipants)
            .innerJoin(events, eq(eventParticipants.eventId, events.id))
            .where(eq(eventParticipants.userId, user.id))
            .groupBy(events.category)
            .orderBy(desc(sql`count(*)`))
            .limit(1);

          const primaryCategory = categoryStats.length > 0 ? categoryStats[0].category : 'newcomer';
          const isFriend = friendIds.has(user.id);
          const isCurrentUser = user.id === userId;

          return {
            ...user,
            primaryCategory,
            isFriend,
            isCurrentUser,
          };
        })
      );

      res.json(usersWithCategories);
    } catch (error) {
      console.error("Error fetching bant map data:", error);
      res.status(500).json({ error: "Failed to fetch bant map data" });
    }
  });

  // Register all other routes
  registerBlinkActionRoutes(app);
  app.use('/api/notifications', notificationsApi);
  app.use('/api/admin/notifications', adminNotificationsApi);
  app.use('/api/agents', agentsApi);
  app.use('/api/bantahbro', bantahBroApi);
  app.use('/api/rewards-pool', (await import('./routes/rewardsPoolApi')).rewardsPoolApiRouter);
  app.use('/api', ogMetadataRouter);

  // ============ PAIRING ENGINE ROUTES ============
  // Queue-based challenge matching with deterministic FCFS algorithm
  
  const pairingEngine = createPairingEngine(db);

  // Join challenge queue (FCFS matching with ±20% stake tolerance)
  app.post('/api/challenges/:id/queue/join', PrivyAuthMiddleware, requireOnchainWallet, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = req.params.id;
      const numericChallengeId = parseInt(challengeId, 10);
      if (Number.isNaN(numericChallengeId)) {
        return res.status(400).json({ message: "Invalid challenge id" });
      }

      const userId = getUserId(req);
      const sideRaw = typeof req.body?.side === "string" ? req.body.side.toUpperCase() : "";
      const stakeAmount = Number(req.body?.stakeAmount);

      const challenge = await storage.getChallengeById(numericChallengeId);
      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }
      if (!challenge.adminCreated) {
        return res.status(400).json({ message: "Queue joining is only available for admin-created challenges" });
      }
      if (challenge.status !== "open") {
        return res.status(400).json({ message: "Challenge is not open for new entries" });
      }

      const requiredAmount = Number(challenge.amount || 0);
      if (!Number.isInteger(requiredAmount) || requiredAmount <= 0) {
        return res.status(400).json({ message: "Invalid challenge stake amount" });
      }

      if (!['YES', 'NO'].includes(sideRaw)) {
        return res.status(400).json({ message: "Invalid side. Must be 'YES' or 'NO'" });
      }

      if (!Number.isInteger(stakeAmount) || stakeAmount <= 0) {
        return res.status(400).json({ message: "Invalid stake amount. Must be positive integer" });
      }

      if (stakeAmount !== requiredAmount) {
        const tokenLabel = String(
          challenge.tokenSymbol || challenge.token_symbol || ONCHAIN_CONFIG.defaultToken || "USDC",
        ).toUpperCase();
        const stakeDisplay =
          String(challenge.settlementRail || "").toLowerCase() === "onchain"
            ? `${requiredAmount.toLocaleString()} ${tokenLabel}`
            : `NGN ${requiredAmount.toLocaleString()}`;
        return res.status(400).json({
          message: `Invalid stake amount. This challenge requires exactly ${stakeDisplay}`,
        });
      }

      const isOnchainChallenge =
        String(challenge.settlementRail || "").toLowerCase() === "onchain";
      let joinEscrowTxHash: string | null = null;

      if (isOnchainChallenge && ONCHAIN_CONFIG.contractEnabled) {
        const chainId = Number(challenge.chainId || ONCHAIN_CONFIG.defaultChainId || ONCHAIN_CONFIG.chainId);
        const chainConfig =
          ONCHAIN_CONFIG.chains[String(chainId)] ||
          ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.defaultChainId)] ||
          ONCHAIN_CONFIG.chains[String(ONCHAIN_CONFIG.chainId)];

        if (!chainConfig) {
          return res.status(400).json({ message: "Unsupported chainId for onchain challenge" });
        }

        const escrowContract = normalizeEvmAddress(chainConfig.escrowContractAddress);
        if (!escrowContract) {
          return res.status(500).json({
            message: `Escrow contract not configured for chainId ${chainConfig.chainId}`,
          });
        }

        const participantWallet = normalizeEvmAddress(req.user.walletAddress);
        if (!participantWallet) {
          return res.status(403).json({
            message: "Wallet required. Connect an EVM wallet to continue.",
            code: "WALLET_REQUIRED",
          });
        }

        if (!req.body?.escrowTxHash) {
          return res.status(400).json({
            message:
              "escrowTxHash is required in contract mode. Send the wallet escrow transaction hash.",
          });
        }

        const tokenSymbol = normalizeOnchainTokenSymbol(
          challenge.tokenSymbol || ONCHAIN_CONFIG.defaultToken,
        ) as OnchainTokenSymbol;
        const tokenConfig = chainConfig.tokens[tokenSymbol];
        if (!tokenConfig || !isSupportedOnchainToken(chainConfig, tokenSymbol)) {
          return res.status(400).json({ message: "Unsupported token for this challenge" });
        }
        if (!tokenConfig.isNative) {
          const resolvedTokenAddress = normalizeEvmAddress(
            challenge.tokenAddress || tokenConfig.address,
          );
          if (!resolvedTokenAddress) {
            return res.status(400).json({
              message: `Token ${tokenSymbol} is not configured on chainId ${chainConfig.chainId}.`,
            });
          }
          try {
            await assertAllowedStakeToken({
              rpcUrl: chainConfig.rpcUrl,
              tokenAddress: resolvedTokenAddress,
              tokenSymbol,
            });
          } catch (tokenError: any) {
            return res.status(400).json({
              message:
                tokenError?.message ||
                `Token ${tokenSymbol} is not allowed for onchain challenge staking.`,
            });
          }
        }

        const verifiedEscrowTx = await verifyEscrowTransaction({
          rpcUrl: chainConfig.rpcUrl,
          expectedChainId: chainConfig.chainId,
          expectedFrom: participantWallet,
          expectedEscrowContract: escrowContract,
          tokenSymbol,
          txHash: String(req.body.escrowTxHash),
        });

        const alreadyUsed = await findChallengeUsingEscrowTxHash(
          verifiedEscrowTx.txHash,
          numericChallengeId,
        );
        if (alreadyUsed) {
          return res.status(409).json({
            message: "This escrow transaction hash has already been used for another challenge.",
            challengeId: alreadyUsed.id,
          });
        }
        joinEscrowTxHash = verifiedEscrowTx.txHash;
      } else {
        const balance = await storage.getUserBalance(userId);
        if (Number(balance.balance) < stakeAmount) {
          return res.status(400).json({ message: "Insufficient balance" });
        }
      }

      const result = await pairingEngine.joinChallenge(userId, challengeId, sideRaw as "YES" | "NO", stakeAmount);
      if (!result.success) {
        return res.status(400).json(result);
      }

      if (!isOnchainChallenge) {
        // Deduct stake for the joining user only.
        // Opponent stake is already deducted when they first entered the queue.
        await storage.createTransaction({
          userId,
          type: 'challenge_queue_stake',
          amount: `-${stakeAmount}`,
          description: `Challenge queue stake (Challenge #${challengeId}) - ${sideRaw}`,
          relatedId: numericChallengeId,
          status: 'completed',
        });
      }

      const joinedUser = await storage.getUser(userId);
      let refreshedChallenge = await storage.getChallengeById(numericChallengeId);
      if (joinEscrowTxHash && refreshedChallenge) {
        const mergedEscrowHashes = mergeEscrowTxHashes(
          refreshedChallenge.escrowTxHash,
          joinEscrowTxHash,
        );
        if (mergedEscrowHashes !== refreshedChallenge.escrowTxHash) {
          refreshedChallenge = await storage.updateChallenge(numericChallengeId, {
            escrowTxHash: mergedEscrowHashes,
          } as any);
        }
      }
      try {
        await pusher.trigger('global', 'challenge-joined', {
          type: 'challenge_joined',
          challengeId: numericChallengeId,
          userId,
          username: joinedUser?.username,
          firstName: joinedUser?.firstName,
          side: sideRaw,
          status: refreshedChallenge?.status || challenge.status,
          participantCount: Number((refreshedChallenge as any)?.participantCount || 0),
          participantPreviewUsers: (refreshedChallenge as any)?.participantPreviewUsers || [],
        });
      } catch (error) {
        console.error('Error broadcasting queue join event:', error);
      }

      res.json({
        ...result,
        challenge: refreshedChallenge,
        message: result.match
          ? 'Match found! Stakes locked in escrow.'
          : `Added to ${sideRaw} queue. Your stake is held in escrow.`,
        escrowId: result.match?.escrowId,
        totalPot: result.match?.amount,
        queuePosition: result.queuePosition,
      });
    } catch (error) {
      console.error('Queue join error:', error);
      res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to join queue' });
    }
  });
  // Cancel queue entry (only if not yet matched)
  app.post('/api/challenges/:id/queue/cancel', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = req.params.id; // UUID as string
      const userId = getUserId(req);

      const result = await pairingEngine.cancelFromQueue(userId, challengeId);

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (error) {
      console.error('Queue cancel error:', error);
      res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to cancel queue entry' });
    }
  });

  // Get queue status for a challenge
  app.get('/api/challenges/:id/queue/status', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = req.params.id; // UUID as string

      const overview = await pairingEngine.getChallengeOverview(challengeId);
      
      res.json(overview);
    } catch (error) {
      console.error('Queue status error:', error);
      res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to get queue status' });
    }
  });

  // Get user's status in a challenge queue
  app.get('/api/challenges/:id/queue/user-status', PrivyAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = req.params.id; // UUID as string
      const userId = getUserId(req);

      const status = await pairingEngine.getUserStatus(userId, challengeId);
      
      res.json(status);
    } catch (error) {
      console.error('User status error:', error);
      res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to get user status' });
    }
  });

  // Manual trigger: Expire a challenge (admin only)
  // Refunds all waiting users and closes the challenge
  app.post('/api/admin/challenges/:id/expire', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = req.params.id;

      const result = await pairingEngine.expireChallenge(challengeId);

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json({
        success: true,
        message: result.message,
        refundedCount: result.refundedCount,
        challengeId: challengeId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Challenge expire error:', error);
      res.status(500).json({ 
        success: false,
        message: error instanceof Error ? error.message : 'Failed to expire challenge' 
      });
    }
  });

  // ===== TREASURY MANAGEMENT ENDPOINTS =====

  // Get imbalance status for a challenge (for Admin Dashboard)
  app.get('/api/admin/challenges/:id/imbalance', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id, 10);
      const { getChallengeImbalance } = await import('./treasuryManagement');
      
      const imbalance = await getChallengeImbalance(challengeId);
      res.json(imbalance);
    } catch (error) {
      console.error('Get imbalance error:', error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Failed to get imbalance' 
      });
    }
  });

  // Create Treasury configuration for a challenge
  app.post('/api/admin/challenges/:id/treasury-config', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id, 10);
      const { maxTreasuryRisk, adminNotes } = req.body;

      if (!maxTreasuryRisk || maxTreasuryRisk <= 0) {
        return res.status(400).json({ 
          message: 'maxTreasuryRisk must be a positive number' 
        });
      }

      const { createTreasuryChallengeConfig } = await import('./treasuryManagement');
      const config = await createTreasuryChallengeConfig(
        challengeId,
        maxTreasuryRisk,
        adminNotes
      );

      res.json({
        success: true,
        config,
        message: `Treasury config created: max risk ₦${maxTreasuryRisk}`,
      });
    } catch (error) {
      console.error('Create Treasury config error:', error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Failed to create Treasury config' 
      });
    }
  });

  // Execute Treasury match fulfillment (the "Match All" button)
  app.post('/api/admin/challenges/:id/fulfill-treasury', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id, 10);
      const { matchCount, sideToFill } = req.body;
      const adminId = req.user?.id; // Get admin ID from auth

      if (!matchCount || matchCount <= 0) {
        return res.status(400).json({ 
          message: 'matchCount must be a positive number' 
        });
      }

      if (!sideToFill || !['YES', 'NO'].includes(sideToFill)) {
        return res.status(400).json({ 
          message: 'sideToFill must be either "YES" or "NO"' 
        });
      }

      const { fulfillTreasuryMatches } = await import('./treasuryManagement');
      const result = await fulfillTreasuryMatches(
        challengeId,
        matchCount,
        sideToFill,
        adminId // Pass admin ID for notifications
      );

      res.json({
        success: true,
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Fulfill Treasury matches error:', error);
      res.status(500).json({ 
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fulfill Treasury matches' 
      });
    }
  });

  // Get Treasury dashboard summary (for admin overview)
  app.get('/api/admin/treasury/dashboard', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const { getTreasuryDashboardSummary } = await import('./treasuryManagement');
      const summary = await getTreasuryDashboardSummary();
      res.json(summary);
    } catch (error) {
      console.error('Get Treasury dashboard error:', error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Failed to get Treasury dashboard' 
      });
    }
  });

  // Get Treasury wallet balance and summary
  app.get('/api/admin/treasury/wallet', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { getTreasuryWalletSummary, createOrGetTreasuryWallet } = await import('./treasuryWalletService');
      
      // Ensure wallet exists
      await createOrGetTreasuryWallet(adminId);
      const summary = await getTreasuryWalletSummary(adminId);

      res.json(summary);
    } catch (error) {
      console.error('Get Treasury wallet error:', error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Failed to get Treasury wallet' 
      });
    }
  });

  // Initiate Paystack deposit to Treasury wallet
  app.post('/api/admin/treasury/wallet/deposit/initiate', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user?.id;
      const { amount, email } = req.body;

      if (!adminId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: 'Amount must be positive' });
      }

      if (!email) {
        return res.status(400).json({ message: 'Email required' });
      }

      // Initialize Paystack transaction
      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          amount: Math.round(amount * 100), // Convert to cents
          metadata: {
            type: 'treasury_wallet_deposit',
            adminId,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        return res.status(400).json({ 
          message: 'Failed to initiate payment',
          error: data.message 
        });
      }

      res.json({
        authorizationUrl: data.data.authorization_url,
        accessCode: data.data.access_code,
        reference: data.data.reference,
        publicKey: process.env.PAYSTACK_PUBLIC_KEY,
      });
    } catch (error) {
      console.error('Initiate Treasury deposit error:', error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Failed to initiate deposit' 
      });
    }
  });

  // Verify Paystack payment and credit Treasury wallet
  app.post('/api/admin/treasury/wallet/deposit/verify', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user?.id;
      const { reference } = req.body;

      if (!adminId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      if (!reference) {
        return res.status(400).json({ message: 'Reference required' });
      }

      // Verify with Paystack
      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          },
        }
      );

      const data = await response.json();

      if (!response.ok || !data.data || data.data.status !== 'success') {
        return res.status(400).json({ 
          message: 'Payment verification failed',
          error: data.message 
        });
      }

      // Credit Treasury wallet
      const { depositToTreasuryWallet } = await import('./treasuryWalletService');
      const amount = data.data.amount / 100; // Convert from cents
      
      const newBalance = await depositToTreasuryWallet(
        adminId,
        amount,
        reference
      );

      res.json({
        success: true,
        message: 'Treasury wallet credited successfully',
        amount,
        newBalance,
      });
    } catch (error) {
      console.error('Verify Treasury deposit error:', error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Failed to verify deposit' 
      });
    }
  });

  // Get Treasury wallet transaction history
  app.get('/api/admin/treasury/wallet/transactions', adminAuth, async (req: AdminAuthRequest, res) => {
    try {
      const adminId = req.user?.id;
      const limit = parseInt(req.query.limit as string) || 50;

      if (!adminId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { getTreasuryWalletTransactions } = await import('./treasuryWalletService');
      const transactions = await getTreasuryWalletTransactions(adminId, limit);

      res.json(transactions);
    } catch (error) {
      console.error('Get Treasury wallet transactions error:', error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Failed to get transactions' 
      });
    }
  });

  return httpServer;
}
