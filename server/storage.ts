import {
  userRewardsClaims,
  users,
  agents,
  agentFollows,
  events,
  challenges,
  notifications,
  transactions,
  friends,
  achievements,
  userAchievements,
  eventParticipants,
  eventMessages,
  challengeMessages,
  dailyLogins,
  referrals,
  referralRewards,
  userPreferences,
  userInteractions,
  eventJoinRequests,
  eventPools,
  messageReactions,
  eventTyping,
  eventActivity,
  escrow,
  platformSettings,
  pushSubscriptions,
  userRecommendationProfiles,
  eventRecommendations,
  userEventInteractions,
  stories,
  storyViews,
  adminWalletTransactions,
  pairQueue,
  type Agent,
  type InsertAgent,
  type User,
  type UpsertUser,
  type Event,
  type InsertEvent,
  type Challenge,
  type InsertChallenge,
  type Notification,
  type InsertNotification,
  type Transaction,
  type InsertTransaction,
  type Achievement,
  type Friend,
  type EventParticipant,
  type EventMessage,
  type ChallengeMessage,
  type EventJoinRequest,
  type InsertEventJoinRequest,
  type MessageReaction,
  type InsertMessageReaction,
  type PlatformSettings,
  type InsertPlatformSettings,
  type UserPreferences,
  type InsertUserPreferences,
  type UserRecommendationProfile,
  type EventRecommendation,
  type UserEventInteraction,
  type InsertUserRecommendationProfile,
  type InsertEventRecommendation,
  type InsertUserEventInteraction,
  groups,
  groupMembers,
} from "@shared/schema";
import type { AgentListQuery } from "@shared/agentApi";
import { db, pool } from "./db";
import { eq, ne, desc, and, or, sql, count, sum, inArray, asc, isNull, not } from "drizzle-orm";
import { randomBytes } from 'crypto';
// CJS-safe nanoid replacement using Node built-ins
function nanoid(size = 21): string {
  return randomBytes(size).toString('base64url').slice(0, size);
}
import session from "express-session";
import createMemoryStore from "memorystore";
import { challengeNotifications } from './challengeNotifications';
import { normalizeEvmAddress, parseWalletAddresses } from "@shared/onchainConfig";
import { getOnchainServerConfig } from "./onchainConfig";
import { CHALLENGE_PLATFORM_FEE_RATE } from "@shared/feeConfig";
import {
  BANTCREDIT_ACTIVITY_EXCLUDED_TRANSACTION_TYPES,
  BANTCREDIT_AGENT_WIN_REWARD,
  BANTCREDIT_DAILY_CHECKIN_REWARD,
  calculateChallengeCreationBantCredit,
  BANTCREDIT_SIGNUP_REWARD,
  type BantCreditChallengeRewardResult,
} from "@shared/bantCredit";

const ONCHAIN_CONFIG = getOnchainServerConfig();
export const AGENT_WIN_BANTCREDIT_REWARD = BANTCREDIT_AGENT_WIN_REWARD;

function clampCurrencyAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function calculateLoserSideChallengeFee(losingStakeAmount: number): number {
  return clampCurrencyAmount(losingStakeAmount) * CHALLENGE_PLATFORM_FEE_RATE;
}

type StoredAgentWithOwner = Agent & {
  owner: Pick<User, "id" | "username" | "firstName" | "lastName" | "profileImageUrl">;
};

export type CreateAgentRecordInput = InsertAgent & {
  agentId?: string;
  walletData?: unknown;
};

export interface IStorage {
  // User operations - Updated for email/password auth
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByUsernameOrEmail(usernameOrEmail: string): Promise<User | undefined>;
  getUserByTelegramId(telegramId: string): Promise<User | null>;
  upsertUser(user: UpsertUser): Promise<User>;
  createUser(user: any): Promise<User>;
  updateUserProfile(id: string, updates: Partial<User>): Promise<User>;
  updateNotificationPreferences(userId: string, preferences: any): Promise<void>;
  updateUserTelegramInfo(userId: string, telegramInfo: {
    telegramId: string;
    telegramUsername: string | null;
    isTelegramUser: boolean;
  }): Promise<void>;

  // Agent registry operations
  createAgent(agent: CreateAgentRecordInput): Promise<Agent>;
  getAgentById(agentId: string): Promise<StoredAgentWithOwner | undefined>;
  getAgentByWalletAddress(walletAddress: string): Promise<Agent | undefined>;
  getAgentByEndpointUrl(endpointUrl: string): Promise<Agent | undefined>;
  listAgents(
    options: Pick<AgentListQuery, "page" | "limit" | "specialty" | "agentType" | "status" | "sort">,
  ): Promise<{ items: StoredAgentWithOwner[]; total: number }>;
  countImportedAgentsByOwnerSince(ownerId: string, since: Date): Promise<number>;
  updateAgentSkillCheck(
    agentId: string,
    updates: {
      bantahSkillVersion?: string;
      lastSkillCheckAt: Date;
      lastSkillCheckScore: number;
      lastSkillCheckStatus: "passed" | "failed";
    },
  ): Promise<Agent>;
  incrementAgentMarketCount(agentId: string, delta?: number): Promise<Agent>;
  recordAgentChallengeOutcome(
    agentId: string,
    outcome: "win" | "loss",
    delta?: number,
  ): Promise<Agent>;
  toggleAgentFollow(
    userId: string,
    agentId: string,
  ): Promise<{ action: "followed" | "unfollowed" }>;
  getAgentFollowState(
    agentId: string,
    userId?: string | null,
  ): Promise<{ isFollowing: boolean; followerCount: number }>;
  getAgentFollowerIds(agentId: string): Promise<string[]>;

  // User preferences operations
  getUserPreferences(userId: string): Promise<UserPreferences | undefined>;
  updateUserPreferences(userId: string, preferences: Partial<InsertUserPreferences>): Promise<UserPreferences>;
  getUserStats(userId: string): Promise<any>;
  getUserCreatedEvents(userId: string): Promise<any[]>;
  getUserJoinedEvents(userId: string): Promise<any[]>;
  getUserAchievements(userId: string): Promise<any[]>;
  getUserProfile(userId: string, currentUserId: string): Promise<any>;
  getAdminStats(): Promise<any>;
  getRecentUsers(limit: number): Promise<any[]>;
  getPlatformActivity(limit: number): Promise<any[]>;
  banUser(userId: string, reason: string): Promise<User>;
  unbanUser(userId: string, reason: string): Promise<User>;
  adjustUserBalance(userId: string, amount: number, reason: string): Promise<User>;
  setUserAdminStatus(userId: string, isAdmin: boolean, reason: string): Promise<User>;
  sendAdminMessage(userId: string, message: string, reason: string): Promise<any>;
  checkDailyLogin(userId: string): Promise<any>;

  // Event operations
  getEvents(limit?: number): Promise<Event[]>;
  getEventById(id: number): Promise<Event | undefined>;
  createEvent(event: InsertEvent): Promise<Event>;
  updateEvent(id: number, updates: Partial<Event>): Promise<Event>;
  joinEvent(eventId: number, userId: string, prediction: boolean, amount: number): Promise<EventParticipant>;
  getEventParticipants(eventId: number): Promise<EventParticipant[]>;
  getEventMessages(eventId: number, limit?: number): Promise<any[]>;
  createEventMessage(eventId: number, userId: string, message: string, replyToId?: string, mentions?: string[], telegramUser?: any): Promise<EventMessage>;
  getEventMessageById(messageId: string): Promise<EventMessage | undefined>;
  toggleMessageReaction(messageId: string, userId: string, emoji: string): Promise<any>;
  getMessageReactions(messageId: string): Promise<any[]>;
  getEventParticipantsWithUsers(eventId: number): Promise<any[]>;
  searchEventsByTitle(query: string): Promise<Event[]>;

  // Event Pool operations
  adminSetEventResult(eventId: number, result: boolean): Promise<Event>;
  processEventPayout(eventId: number): Promise<{ winnersCount: number; totalPayout: number; creatorFee: number }>;
  getEventPoolStats(eventId: number): Promise<{ totalPool: number; yesPool: number; noPool: number; participantsCount: number }>;

  // Private event operations
  requestEventJoin(eventId: number, userId: string, prediction: boolean, amount: number): Promise<EventJoinRequest>;
  getEventJoinRequests(eventId: number): Promise<(EventJoinRequest & { user: User })[]>;
  approveEventJoinRequest(requestId: number): Promise<EventParticipant>;
  rejectEventJoinRequest(requestId: number): Promise<EventJoinRequest>;

  // Challenge operations
  getChallenges(userId: string, limit?: number): Promise<(Challenge & { challengerUser: User, challengedUser: User })[]>;
  getChallengeById(id: number): Promise<Challenge | undefined>;
  createChallenge(challenge: InsertChallenge): Promise<Challenge>;
  createChallengeDraft(challenge: InsertChallenge): Promise<Challenge>;
  updateChallenge(id: number, updates: Partial<Challenge>): Promise<Challenge>;
  recordChallengeEscrowHold(challengeId: number, amount: number): Promise<void>;
  getChallengeMessages(challengeId: number): Promise<(ChallengeMessage & { user: User })[]>;
  createChallengeMessage(challengeId: number, userId: string, message: string): Promise<ChallengeMessage>;

  // New voting/escrow operations (offchain)
  reserveStake(challengeId: number, userId: string, amount: number, paymentMethod?: string): Promise<any>;
  createProof(challengeId: number, userId: string, proofUri: string, proofHash: string): Promise<any>;
  submitVote(challengeId: number, userId: string, voteChoice: string, proofHash: string, signedVote: string): Promise<any>;
  tryAutoRelease(challengeId: number): Promise<{ released: boolean; reason?: string }>;
  resolveChallengeFromArenaMatch(battleId: string, winnerAgentId: string | null): Promise<{ released: boolean; reason?: string }>;
  openDispute(challengeId: number, userId: string, reason: string): Promise<any>;
  adminResolve(challengeId: number, resolution: any, adminId: string): Promise<any>;
  registerSigningPublicKey(userId: string, publicKeyBase64: string): Promise<any>;

  // Admin challenge operations
  getAllChallenges(limit?: number): Promise<(Challenge & { challengerUser?: User, challengedUser?: User })[]>;
  adminSetChallengeResult(challengeId: number, result: 'challenger_won' | 'challenged_won' | 'draw'): Promise<Challenge>;
  activateChallengeBonus(challengeId: number, bonusData: { bonusSide: string; bonusMultiplier: string; bonusEndsAt: Date }): Promise<Challenge>;
  joinAdminChallenge(challengeId: number, userId: string, stake: 'YES' | 'NO'): Promise<Challenge>;
  processChallengePayouts(challengeId: number): Promise<{ winnerPayout: number; platformFee: number; winnerId?: string }>;
  getChallengeEscrowStatus(challengeId: number): Promise<{ totalEscrow: number; status: string } | null>;
  getAllEscrowData(limit?: number): Promise<(Challenge & { totalEscrow: number; escrowCount: number })[]>;
  getEscrowStats(): Promise<{ totalEscrow: number; pendingChallenges: number; holdingAmount: number; releasedAmount: number; refundedAmount: number }>;
  getDetailedEscrowData(challengeId: number): Promise<any>;

  // Friend operations
  getFriends(userId: string): Promise<(Friend & { requester: User, addressee: User })[]>;
  sendFriendRequest(requesterId: string, addresseeId: string): Promise<Friend>;
  acceptFriendRequest(id: number): Promise<Friend>;
  toggleFollow(followerId: string, followingId: string): Promise<{ action: 'followed' | 'unfollowed' }>;

  // Notification operations
  getNotifications(userId: string, limit?: number): Promise<Notification[]>;
  createNotification(notification: InsertNotification): Promise<Notification>;
  markNotificationRead(id: string): Promise<Notification>;

  // Transaction operations
  getTransactions(userId: string, limit?: number): Promise<Transaction[]>;
  createTransaction(transaction: InsertTransaction & { reference?: string }): Promise<Transaction>;
  getUserBalance(userId: string): Promise<{ balance: number; coins: number; points: number; usdcEarned: number }>;
  updateUserBalance(userId: string, amount: number): Promise<User>;

  // Achievement operations
  getAchievements(): Promise<Achievement[]>;
  getUserAchievements(userId: string): Promise<(Achievement & { unlockedAt: Date })[]>;
  unlockAchievement(userId: string, achievementId: number): Promise<void>;

  // Leaderboard operations
  getLeaderboard(limit?: number): Promise<(User & { rank: number })[]>;

  // Referral operations
  createReferral(referrerId: string, referredId: string, code: string): Promise<void>;
  getReferrals(userId: string): Promise<any[]>;
  getUserByReferralCode(referralCode: string): Promise<User | undefined>;

  // User stats
  getUserStats(userId: string): Promise<{
    wins: number;
    activeChallenges: number;
    friendsOnline: number;
  }>;

  // Update user points
  updateUserPoints(userId: string, pointsAmount: number): Promise<void>;
  awardChallengeCreationBantCredit(
    userId: string,
    rewardInput: {
      challengeId: number;
      marketSize: number;
      challengeTitle?: string | null;
    },
  ): Promise<BantCreditChallengeRewardResult>;

  // Get all users
  getAllUsers(): Promise<User[]>;
  getGroupByTelegramId(telegramId: string): Promise<any | null>;

  // Group / Telegram membership tracking
  addGroup(telegramId: string, title?: string, type?: string, addedBy?: string): Promise<any>;
  addGroupMember(groupId: number, userId: string, telegramId: string, username?: string): Promise<any>;
  removeGroupMember(groupId: number, telegramId: string): Promise<void>;
  getGroupMembers(groupId: number): Promise<any[]>;

  // Stories operations
  getActiveStories(): Promise<any[]>;
  createStory(storyData: any): Promise<any>;
  updateStory(storyId: number, updates: any): Promise<any>;
  deleteStory(storyId: number): Promise<void>;
  markStoryAsViewed(storyId: number, userId: string): Promise<void>;

  // Global Chat
  createGlobalChatMessage(messageData: any): Promise<any>;
  getGlobalChatMessages(limit?: number): Promise<any[]>;

  // Admin Management Functions
  deleteEvent(eventId: number): Promise<void>;
  toggleEventChat(eventId: number, enabled: boolean): Promise<void>;
  deleteChallenge(challengeId: number): Promise<void>;

  // Admin Functions
  getAdminStats(): Promise<any>;

  // Platform Settings
  getPlatformSettings(): Promise<PlatformSettings>;
  updatePlatformSettings(settings: Partial<PlatformSettings>): Promise<PlatformSettings>;

  // Advanced Admin Tools
  addEventFunds(eventId: number, amount: number): Promise<void>;
  giveUserPoints(userId: string, points: number): Promise<void>;
  updateEventCapacity(eventId: number, additionalSlots: number): Promise<void>;

  // Event lifecycle notifications
  notifyEventStarting(eventId: number): Promise<void>;
  notifyEventEnding(eventId: number): Promise<void>;
  notifyFundsReleased(userId: string, eventId: number, amount: number, isWinner: boolean): Promise<void>;

  // Push Notification operations
  savePushSubscription(userId: string, subscription: any): Promise<void>;
  getPushSubscriptions(userId: string): Promise<any[]>;
  removePushSubscription(endpoint: string): Promise<void>;
  broadcastMessage(message: string, type: string): Promise<void>;

  // Missing admin functions
  getAdminNotifications(limit: number): Promise<any[]>;
  broadcastNotification(data: any): Promise<any>;
  searchUsers(query: string, limit: number): Promise<any[]>;

  // Recommendation engine operations
  getUserRecommendationProfile(userId: string): Promise<UserRecommendationProfile | undefined>;
  updateUserRecommendationProfile(userId: string, profile: Partial<InsertUserRecommendationProfile>): Promise<UserRecommendationProfile>;
  generateEventRecommendations(userId: string, limit?: number): Promise<EventRecommendation[]>;
  getPersonalizedEvents(userId: string, limit?: number): Promise<(Event & { recommendationScore: number, recommendationReason: string })[]>;
  trackUserInteraction(interaction: InsertUserEventInteraction): Promise<UserEventInteraction>;
  updateRecommendationProfile(userId: string): Promise<void>;

  // Session store for authentication
  sessionStore: any;
}

export class DatabaseStorage implements IStorage {
  sessionStore: any;
  private db = db; // Alias db for internal use
  private challengeSideColumnsAvailable: boolean | null = null;
  private challengeSideColumnsWarningShown = false;
  private leaderboardCache: {
    expiresAt: number;
    limit: number;
    data: (User & { rank: number; coins: number; eventsWon: number; challengesWon: number })[];
  } | null = null;

  private normalizeP2PChallengeStatus(
    status: string | null | undefined,
    adminCreated: boolean | null | undefined,
    challenged: string | null | undefined,
    challengedWalletAddress?: string | null | undefined,
  ): string {
    const rawStatus = String(status || '').toLowerCase();
    if (adminCreated) return rawStatus || 'open';

    const hasDesignatedOpponent =
      (typeof challenged === 'string' ? challenged.trim().length > 0 : !!challenged) ||
      (typeof challengedWalletAddress === 'string'
        ? challengedWalletAddress.trim().length > 0
        : !!challengedWalletAddress);

    // Canonical state for user-created challenges:
    // - open   => no designated opponent yet
    // - pending => direct challenge to a designated opponent
    if (rawStatus === 'open' || rawStatus === 'pending') {
      return hasDesignatedOpponent ? 'pending' : 'open';
    }

    return rawStatus || 'pending';
  }

  private async supportsChallengeSideColumns(): Promise<boolean> {
    if (this.challengeSideColumnsAvailable !== null) {
      return this.challengeSideColumnsAvailable;
    }

    try {
      const result = await pool.query(
        `
          select count(*)::int as count
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'challenges'
            and column_name = any($1::text[])
        `,
        [["challenger_side", "challenged_side"]],
      );

      this.challengeSideColumnsAvailable = Number(result.rows[0]?.count || 0) >= 2;
    } catch (error) {
      console.error("[db] Failed to inspect challenge side columns:", error);
      this.challengeSideColumnsAvailable = false;
    }

    if (!this.challengeSideColumnsAvailable && !this.challengeSideColumnsWarningShown) {
      this.challengeSideColumnsWarningShown = true;
      console.warn("[db] challenges table is missing challenger/challenged side columns; falling back to null side fields.");
    }

    return this.challengeSideColumnsAvailable;
  }

  private getChallengeSideSelects(includeSideColumns: boolean) {
    return {
      challengerSide: includeSideColumns ? challenges.challengerSide : sql<string | null>`null`,
      challengedSide: includeSideColumns ? challenges.challengedSide : sql<string | null>`null`,
    };
  }

  private async sanitizeChallengeSideFields<T extends Record<string, any>>(data: T): Promise<T> {
    if (await this.supportsChallengeSideColumns()) {
      return data;
    }

    const sanitized = { ...data };
    delete sanitized.challengerSide;
    delete sanitized.challengedSide;
    return sanitized as T;
  }

  private async getChallengeCommentCount(challengeId: number): Promise<number> {
    const [commentResult] = await this.db
      .select({ count: count() })
      .from(challengeMessages)
      .where(eq(challengeMessages.challengeId, challengeId));

    return Number(commentResult?.count || 0);
  }

  private async getAdminChallengeParticipantMeta(challenge: any): Promise<{
    participantCount: number;
    participantPreviewUsers: Array<{
      id: string;
      username?: string | null;
      firstName?: string | null;
      profileImageUrl?: string | null;
      side?: string | null;
    }>;
  }> {
    const [activeParticipants] = await this.db
      .select({
        count: sql<number>`count(distinct coalesce(${pairQueue.agentId}::text, ${pairQueue.userId}))`,
      })
      .from(pairQueue)
      .where(
        and(
          eq(pairQueue.challengeId, challenge.id),
          inArray(pairQueue.status, ["waiting", "matched"]),
        ),
      );

    const queueRows = await this.db
      .select({
        userId: pairQueue.userId,
        participantType: pairQueue.participantType,
        agentId: pairQueue.agentId,
        side: pairQueue.side,
        createdAt: pairQueue.createdAt,
        user: {
          id: users.id,
          username: users.username,
          firstName: users.firstName,
          profileImageUrl: users.profileImageUrl,
        },
        agent: {
          agentId: agents.agentId,
          agentName: agents.agentName,
        },
      })
      .from(pairQueue)
      .leftJoin(users, eq(pairQueue.userId, users.id))
      .leftJoin(agents, eq(pairQueue.agentId, agents.agentId))
      .where(
        and(
          eq(pairQueue.challengeId, challenge.id),
          inArray(pairQueue.status, ["waiting", "matched"]),
        ),
      )
      .orderBy(desc(pairQueue.createdAt))
      .limit(24);

    const participantPreviewUsers: Array<{
      id: string;
      username?: string | null;
      firstName?: string | null;
      profileImageUrl?: string | null;
      side?: string | null;
    }> = [];
    const seen = new Set<string>();

    for (const row of queueRows) {
      const participantType =
        String(row.participantType || "").trim().toLowerCase() === "agent" && row.agentId
          ? "agent"
          : "human";
      const participantId =
        participantType === "agent"
          ? String(row.agentId || "")
          : String(row.userId || row.user?.id || "");
      const seenKey = `${participantType}:${participantId}`;
      if (!participantId || seen.has(seenKey)) continue;
      seen.add(seenKey);
      participantPreviewUsers.push({
        id: participantId,
        username:
          participantType === "agent"
            ? row.agent?.agentName || null
            : row.user?.username || null,
        firstName: participantType === "agent" ? "Agent" : row.user?.firstName || null,
        profileImageUrl: participantType === "agent" ? null : row.user?.profileImageUrl || null,
        side: row.side || null,
      });
      if (participantPreviewUsers.length >= 2) break;
    }

    const participantCount = Math.max(
      Number(activeParticipants?.count || 0),
      participantPreviewUsers.length,
    );

    return {
      participantCount,
      participantPreviewUsers,
    };
  }

  private normalizeChallengeIds(challengeIds: Array<number | string | null | undefined>): number[] {
    return Array.from(
      new Set(
        challengeIds
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0),
      ),
    );
  }

  private async getPairQueueCountMap(challengeIds: number[]): Promise<Map<number, number>> {
    const normalizedChallengeIds = this.normalizeChallengeIds(challengeIds);
    const countMap = new Map<number, number>();
    if (!normalizedChallengeIds.length) {
      return countMap;
    }

    const rows = await this.db
      .select({
        challengeId: pairQueue.challengeId,
        count: count(),
      })
      .from(pairQueue)
      .where(inArray(pairQueue.challengeId, normalizedChallengeIds))
      .groupBy(pairQueue.challengeId);

    for (const row of rows) {
      const challengeId = Number(row.challengeId);
      if (!Number.isInteger(challengeId)) continue;
      countMap.set(challengeId, Number(row.count || 0));
    }

    return countMap;
  }

  private async getChallengeCommentCountMap(challengeIds: number[]): Promise<Map<number, number>> {
    const normalizedChallengeIds = this.normalizeChallengeIds(challengeIds);
    const countMap = new Map<number, number>();
    if (!normalizedChallengeIds.length) {
      return countMap;
    }

    const rows = await this.db
      .select({
        challengeId: challengeMessages.challengeId,
        count: count(),
      })
      .from(challengeMessages)
      .where(inArray(challengeMessages.challengeId, normalizedChallengeIds))
      .groupBy(challengeMessages.challengeId);

    for (const row of rows) {
      const challengeId = Number(row.challengeId);
      if (!Number.isInteger(challengeId)) continue;
      countMap.set(challengeId, Number(row.count || 0));
    }

    return countMap;
  }

  private async getAdminChallengeParticipantMetaMap(challengeIds: number[]): Promise<Map<number, {
    participantCount: number;
    participantPreviewUsers: Array<{
      id: string;
      username?: string | null;
      firstName?: string | null;
      profileImageUrl?: string | null;
      side?: string | null;
    }>;
  }>> {
    const normalizedChallengeIds = this.normalizeChallengeIds(challengeIds);
    const participantMetaMap = new Map<number, {
      participantCount: number;
      participantPreviewUsers: Array<{
        id: string;
        username?: string | null;
        firstName?: string | null;
        profileImageUrl?: string | null;
        side?: string | null;
      }>;
    }>();

    if (!normalizedChallengeIds.length) {
      return participantMetaMap;
    }

    const activeParticipantRows = await this.db
      .select({
        challengeId: pairQueue.challengeId,
        count: sql<number>`count(distinct coalesce(${pairQueue.agentId}::text, ${pairQueue.userId}))`,
      })
      .from(pairQueue)
      .where(
        and(
          inArray(pairQueue.challengeId, normalizedChallengeIds),
          inArray(pairQueue.status, ["waiting", "matched"]),
        ),
      )
      .groupBy(pairQueue.challengeId);

    for (const row of activeParticipantRows) {
      const challengeId = Number(row.challengeId);
      if (!Number.isInteger(challengeId)) continue;
      participantMetaMap.set(challengeId, {
        participantCount: Number(row.count || 0),
        participantPreviewUsers: [],
      });
    }

    const queueRows = await this.db
      .select({
        challengeId: pairQueue.challengeId,
        userId: pairQueue.userId,
        participantType: pairQueue.participantType,
        agentId: pairQueue.agentId,
        side: pairQueue.side,
        createdAt: pairQueue.createdAt,
        user: {
          id: users.id,
          username: users.username,
          firstName: users.firstName,
          profileImageUrl: users.profileImageUrl,
        },
        agent: {
          agentId: agents.agentId,
          agentName: agents.agentName,
        },
      })
      .from(pairQueue)
      .leftJoin(users, eq(pairQueue.userId, users.id))
      .leftJoin(agents, eq(pairQueue.agentId, agents.agentId))
      .where(
        and(
          inArray(pairQueue.challengeId, normalizedChallengeIds),
          inArray(pairQueue.status, ["waiting", "matched"]),
        ),
      )
      .orderBy(asc(pairQueue.challengeId), desc(pairQueue.createdAt));

    const seenByChallenge = new Map<number, Set<string>>();

    for (const row of queueRows) {
      const challengeId = Number(row.challengeId);
      if (!Number.isInteger(challengeId)) continue;

      if (!participantMetaMap.has(challengeId)) {
        participantMetaMap.set(challengeId, {
          participantCount: 0,
          participantPreviewUsers: [],
        });
      }

      const entry = participantMetaMap.get(challengeId)!;
      if (entry.participantPreviewUsers.length >= 2) continue;

      const participantType =
        String(row.participantType || "").trim().toLowerCase() === "agent" && row.agentId
          ? "agent"
          : "human";
      const participantId =
        participantType === "agent"
          ? String(row.agentId || "")
          : String(row.userId || row.user?.id || "");
      if (!participantId) continue;

      let seen = seenByChallenge.get(challengeId);
      if (!seen) {
        seen = new Set<string>();
        seenByChallenge.set(challengeId, seen);
      }

      const seenKey = `${participantType}:${participantId}`;
      if (seen.has(seenKey)) continue;

      seen.add(seenKey);
      entry.participantPreviewUsers.push({
        id: participantId,
        username:
          participantType === "agent"
            ? row.agent?.agentName || null
            : row.user?.username || null,
        firstName: participantType === "agent" ? "Agent" : row.user?.firstName || null,
        profileImageUrl: participantType === "agent" ? null : row.user?.profileImageUrl || null,
        side: row.side || null,
      });
    }

    for (const [challengeId, meta] of participantMetaMap.entries()) {
      meta.participantCount = Math.max(meta.participantCount, meta.participantPreviewUsers.length);
      participantMetaMap.set(challengeId, meta);
    }

    return participantMetaMap;
  }

  // --- Offchain voting/escrow methods ---
  async reserveStake(challengeId: number, userId: string, amount: number, paymentMethod?: string): Promise<any> {
    // Ensure user has sufficient balance
    const balance = await this.getUserBalance(userId);
    if (parseFloat(String(balance.balance || 0)) < amount) {
      throw new Error('Insufficient balance');
    }

    // Create ledger transaction to debit user's withdrawable balance
    await this.createTransaction({
      userId,
      type: 'challenge_reservation',
      amount: `-${amount}`,
      description: `Reservation for challenge ${challengeId}`,
      relatedId: challengeId,
      status: 'completed'
    } as any);

    // Insert reservation record
    const insertSql = `INSERT INTO escrow_reservations (challenge_id, participant_id, reserved_amount, reserved_at, status)
      VALUES ($1, $2, $3, now(), 'reserved')
      ON CONFLICT (challenge_id, participant_id) DO UPDATE SET reserved_amount = EXCLUDED.reserved_amount, reserved_at = now(), status='reserved' RETURNING *`;

    const result: any = await pool.query(insertSql, [String(challengeId), userId, amount]);
    return result.rows[0];
  }

  async createProof(challengeId: number, userId: string, proofUri: string, proofHash: string): Promise<any> {
    const insertSql = `INSERT INTO challenge_proofs (challenge_id, participant_id, proof_uri, proof_hash, uploaded_at)
      VALUES ($1, $2, $3, $4, now()) RETURNING *`;
    const result: any = await pool.query(insertSql, [String(challengeId), userId, proofUri, proofHash]);
    const proof = result.rows[0];

    // Notify counterparty that a proof was uploaded
    try {
      const challenge: any = await this.getChallengeById(challengeId);
      const counterparty = (challenge?.challenger === userId) ? challenge.challenged : challenge?.challenger;
      const userRes: any = await pool.query('SELECT username, first_name FROM users WHERE id = $1 LIMIT 1', [userId]);
      const userRow = userRes.rows && userRes.rows[0];
      const participantName = (userRow && (userRow.username || userRow.first_name)) || userId;
      if (counterparty) {
        challengeNotifications.notifyProofUploaded(challengeId, userId, counterparty, participantName).catch(() => {});
      }
    } catch (err) {
      // non-fatal
    }

    return proof;
  }

  async submitVote(challengeId: number, userId: string, voteChoice: string, proofHash: string, signedVote: string): Promise<any> {
    const insertSql = `INSERT INTO challenge_votes (challenge_id, participant_id, vote_choice, proof_hash, proof_uri, signed_vote, submitted_at)
      VALUES ($1, $2, $3, $4, NULL, $5, now())
      ON CONFLICT (challenge_id, participant_id) DO UPDATE SET vote_choice = EXCLUDED.vote_choice, proof_hash = EXCLUDED.proof_hash, signed_vote = EXCLUDED.signed_vote, submitted_at = now() RETURNING *`;

    const result: any = await pool.query(insertSql, [String(challengeId), userId, voteChoice, proofHash, signedVote]);

    // After inserting vote, attempt auto-release (best-effort)
    try {
      await this.tryAutoRelease(challengeId);
    } catch (err) {
      // ignore auto-release errors here; they'll be surfaced to worker/admin
    }

    const vote = result.rows[0];
    // Notify counterparty that a vote was submitted
    try {
      const challenge: any = await this.getChallengeById(challengeId);
      const counterparty = (challenge?.challenger === userId) ? challenge.challenged : challenge?.challenger;
      const userRes: any = await pool.query('SELECT username, first_name FROM users WHERE id = $1 LIMIT 1', [userId]);
      const userRow = userRes.rows && userRes.rows[0];
      const participantName = (userRow && (userRow.username || userRow.first_name)) || userId;
      if (counterparty) {
        challengeNotifications.notifyVoteSubmitted(challengeId, userId, counterparty, participantName).catch(() => {});
      }
    } catch (err) {
      // ignore
    }

    return vote;
  }

  async tryAutoRelease(challengeId: number): Promise<{ released: boolean; reason?: string }> {
    // Fetch votes for the challenge
    const votesSql = `SELECT participant_id, vote_choice, proof_hash FROM challenge_votes WHERE challenge_id = $1`;
    const votesRes: any = await pool.query(votesSql, [String(challengeId)]);
    const votes = votesRes.rows;

    if (!votes || votes.length < 2) {
      return { released: false, reason: 'insufficient_votes' };
    }

    // Check if both votes match
    const first = votes[0];
    const allMatch = votes.every((v: any) => v.vote_choice === first.vote_choice);
    if (!allMatch) {
      // Mismatch: mark dispute
      await pool.query(`INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`, [String(challengeId), 'voting', 'dispute', null, 'vote_mismatch']);
      await pool.query(`UPDATE challenges SET status = 'dispute' WHERE id = $1`, [challengeId]);
      return { released: false, reason: 'vote_mismatch' };
    }

    // Determine winner based on vote_choice
    const winnerChoice = first.vote_choice; // e.g., 'creator' or 'opponent'
    // Map to challenge participant id
    const challenge = await this.getChallengeById(challengeId as number);
    if (!challenge) return { released: false, reason: 'challenge_not_found' };

    let winnerId: string | null = null;
    if (winnerChoice === 'creator' || winnerChoice === 'challenger') {
      winnerId = challenge.challenger as string;
    } else if (winnerChoice === 'opponent' || winnerChoice === 'challenged') {
      winnerId = challenge.challenged as string;
    }

    if (!winnerId) {
      return { released: false, reason: 'invalid_winner_choice' };
    }

    const isOnchainChallenge = String(challenge.settlementRail || "").toLowerCase() === "onchain";
    if (isOnchainChallenge) {
      const resultType = winnerId === challenge.challenger ? 'challenger_won' : 'challenged_won';
      if (ONCHAIN_CONFIG.contractEnabled) {
        await pool.query(
          `UPDATE challenges SET result=$1 WHERE id = $2`,
          [resultType, challengeId],
        );
        await pool.query(
          `INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`,
          [String(challengeId), 'voting', 'voting', null, `onchain_consensus_pending_settlement winner=${winnerId}`],
        );
        return { released: false, reason: 'awaiting_onchain_settlement' };
      }

      await pool.query(
        `UPDATE challenges SET status='completed', result=$1, completed_at=now() WHERE id = $2`,
        [resultType, challengeId],
      );
      await pool.query(
        `INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`,
        [String(challengeId), 'voting', 'resolved', null, `onchain_consensus winner=${winnerId}`],
      );
      return { released: true, reason: 'onchain_consensus' };
    }

    // Compute total reserved amount
    const escRes: any = await pool.query(`SELECT SUM(reserved_amount) as total FROM escrow_reservations WHERE challenge_id = $1 AND status='reserved'`, [String(challengeId)]);
    const totalReserved = parseFloat(escRes.rows[0]?.total || '0');

    if (totalReserved <= 0) return { released: false, reason: 'no_reserved_funds' };

    const reservationsRes: any = await pool.query(
      `SELECT participant_id, reserved_amount FROM escrow_reservations WHERE challenge_id = $1 AND status='reserved'`,
      [String(challengeId)],
    );
    const reservations = reservationsRes.rows || [];
    const loserReservation = reservations.find((row: any) => row.participant_id !== winnerId);
    const losingStakeAmount = parseFloat(String(loserReservation?.reserved_amount || totalReserved / 2 || 0));
    const platformFee = calculateLoserSideChallengeFee(losingStakeAmount);
    const net = totalReserved - platformFee;

    // Perform ledger transfers in a DB transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Credit winner
      await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [net, winnerId]);
      await client.query(`INSERT INTO transactions (user_id, type, amount, description, related_id, status, created_at) VALUES ($1,$2,$3,$4,$5,'completed',now())`, [winnerId, 'challenge_payout', net.toString(), `Payout for challenge ${challengeId}`, challengeId]);

      // Credit platform fee to admin account (current offchain treasury ledger)
      const adminRes: any = await client.query(`SELECT id FROM users WHERE is_admin = true LIMIT 1`);
      if (adminRes.rows && adminRes.rows[0]) {
        const adminId = adminRes.rows[0].id;
        await client.query(`UPDATE users SET admin_wallet_balance = admin_wallet_balance + $1 WHERE id = $2`, [platformFee, adminId]);
        await client.query(`INSERT INTO admin_wallet_transactions (user_id, amount, reason, created_at) VALUES ($1,$2,$3,now())`, [adminId, platformFee.toString(), `Loser-side platform fee for challenge ${challengeId}`]);
      }

      // Mark reservations as released
      await client.query(`UPDATE escrow_reservations SET status='released' WHERE challenge_id = $1`, [String(challengeId)]);

      // Update challenge status/result
      const resultType = winnerId === challenge.challenger ? 'challenger_won' : 'challenged_won';
      await client.query(`UPDATE challenges SET status='completed', result=$1, completed_at=now() WHERE id = $2`, [resultType, challengeId]);

      // Insert state history
      await client.query(`INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`, [String(challengeId), 'voting', 'resolved', null, `auto_release winner=${winnerId}`]);

      await client.query('COMMIT');
      // Notify participants about auto-release
      try {
        const loserId = (winnerId === challenge.challenger) ? challenge.challenged : challenge.challenger;
        challengeNotifications.notifyAutoReleased(challengeId, winnerId, loserId, net).catch(() => {});
      } catch (err) {
        // ignore
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { released: true };
  }

  async resolveChallengeFromArenaMatch(battleId: string, winnerAgentId: string | null): Promise<{ released: boolean; reason?: string }> {
    const challengeRes: any = await pool.query(`SELECT * FROM challenges WHERE battle_id = $1 LIMIT 1`, [battleId]);
    const challenge = challengeRes.rows[0];
    if (!challenge) return { released: false, reason: 'challenge_not_found' };
    if (challenge.status === 'completed' || challenge.status === 'cancelled') return { released: false, reason: 'already_resolved' };

    let winnerId: string | null = null;
    let resultType = 'draw';

    if (winnerAgentId) {
      if (winnerAgentId === challenge.challenger_agent_id) {
        winnerId = challenge.challenger as string;
        resultType = 'challenger_won';
      } else if (winnerAgentId === challenge.challenged_agent_id) {
        winnerId = challenge.challenged as string;
        resultType = 'challenged_won';
      } else {
        return { released: false, reason: 'invalid_winner_agent' };
      }
    }

    const challengeId = challenge.id;
    const isOnchainChallenge = String(challenge.settlement_rail || "").toLowerCase() === "onchain";

    if (isOnchainChallenge) {
      if (ONCHAIN_CONFIG.contractEnabled) {
        await pool.query(
          `UPDATE challenges SET result=$1 WHERE id = $2`,
          [resultType, challengeId],
        );
        await pool.query(
          `INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`,
          [String(challengeId), challenge.status, challenge.status, null, `arena_resolved_pending_onchain_settlement winner=${winnerId || 'none'}`],
        );
        return { released: false, reason: 'awaiting_onchain_settlement' };
      }

      await pool.query(
        `UPDATE challenges SET status='completed', result=$1, completed_at=now() WHERE id = $2`,
        [resultType, challengeId],
      );
      await pool.query(
        `INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`,
        [String(challengeId), challenge.status, 'resolved', null, `arena_resolved_onchain_consensus winner=${winnerId || 'none'}`],
      );
      return { released: true, reason: 'onchain_consensus' };
    }

    // Compute total reserved amount
    const escRes: any = await pool.query(`SELECT SUM(reserved_amount) as total FROM escrow_reservations WHERE challenge_id = $1 AND status='reserved'`, [String(challengeId)]);
    const totalReserved = parseFloat(escRes.rows[0]?.total || '0');

    if (totalReserved <= 0) return { released: false, reason: 'no_reserved_funds' };

    const reservationsRes: any = await pool.query(
      `SELECT participant_id, reserved_amount FROM escrow_reservations WHERE challenge_id = $1 AND status='reserved'`,
      [String(challengeId)],
    );
    const reservations = reservationsRes.rows || [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!winnerId) {
        // Draw: Refund everyone
        for (const r of reservations) {
          await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [r.reserved_amount, r.participant_id]);
          await client.query(`INSERT INTO transactions (user_id, type, amount, description, related_id, status, created_at) VALUES ($1,$2,$3,$4,$5,'completed',now())`, [r.participant_id, 'challenge_refund', r.reserved_amount.toString(), `Draw refund for arena match ${challengeId}`, challengeId]);
        }
        await client.query(`UPDATE challenges SET status='completed', result='draw', completed_at=now() WHERE id = $1`, [challengeId]);
        await client.query(`INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`, [String(challengeId), challenge.status, 'resolved', null, `arena_match_draw`]);
      } else {
        const loserReservation = reservations.find((row: any) => row.participant_id !== winnerId);
        const losingStakeAmount = parseFloat(String(loserReservation?.reserved_amount || totalReserved / 2 || 0));
        const platformFee = calculateLoserSideChallengeFee(losingStakeAmount);
        const net = totalReserved - platformFee;

        // Credit winner
        await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [net, winnerId]);
        await client.query(`INSERT INTO transactions (user_id, type, amount, description, related_id, status, created_at) VALUES ($1,$2,$3,$4,$5,'completed',now())`, [winnerId, 'challenge_payout', net.toString(), `Payout for arena match ${challengeId}`, challengeId]);

        // Credit platform fee to admin account
        const adminRes: any = await client.query(`SELECT id FROM users WHERE is_admin = true LIMIT 1`);
        if (adminRes.rows && adminRes.rows[0]) {
          const adminId = adminRes.rows[0].id;
          await client.query(`UPDATE users SET admin_wallet_balance = admin_wallet_balance + $1 WHERE id = $2`, [platformFee, adminId]);
          await client.query(`INSERT INTO admin_wallet_transactions (user_id, amount, reason, created_at) VALUES ($1,$2,$3,now())`, [adminId, platformFee.toString(), `Loser-side platform fee for arena match ${challengeId}`]);
        }

        await client.query(`UPDATE challenges SET status='completed', result=$1, completed_at=now() WHERE id = $2`, [resultType, challengeId]);
        await client.query(`INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`, [String(challengeId), challenge.status, 'resolved', null, `arena_match_won winner=${winnerId}`]);
      }

      // Mark reservations as released
      await client.query(`UPDATE escrow_reservations SET status='released' WHERE challenge_id = $1`, [String(challengeId)]);

      await client.query('COMMIT');

      if (winnerId) {
        try {
          const loserId = (winnerId === challenge.challenger) ? challenge.challenged : challenge.challenger;
          const loserReservation = reservations.find((row: any) => row.participant_id !== winnerId);
          const losingStakeAmount = parseFloat(String(loserReservation?.reserved_amount || totalReserved / 2 || 0));
          const net = totalReserved - calculateLoserSideChallengeFee(losingStakeAmount);
          challengeNotifications.notifyAutoReleased(challengeId, winnerId, loserId as string, net).catch(() => {});
        } catch (err) {
          // ignore
        }
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { released: true, reason: winnerId ? 'arena_match_won' : 'arena_match_draw' };
  }

  async openDispute(challengeId: number, userId: string, reason: string): Promise<any> {
    await pool.query(`UPDATE challenges SET status='dispute' WHERE id = $1`, [challengeId]);
    await pool.query(`INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`, [String(challengeId), 'voting', 'dispute', userId, reason]);
    // Notify both participants
    try {
      const challenge: any = await this.getChallengeById(challengeId);
      if (challenge) {
        challengeNotifications.notifyDisputeOpened(challengeId, challenge.challenger, challenge.challenged).catch(() => {});
        // Notify admins as well
        challengeNotifications.notifyAdminDisputeOpened(challengeId).catch(() => {});
      }
    } catch (err) {
      // ignore
    }
    return { success: true };
  }

  async adminResolve(challengeId: number, resolution: any, adminId: string): Promise<any> {
    // resolution: { type: 'winner'|'split'|'refund', winnerParticipantId?, split?: [{participantId, pct}] }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const escRes: any = await client.query(`SELECT participant_id, reserved_amount FROM escrow_reservations WHERE challenge_id = $1 AND status='reserved'`, [String(challengeId)]);
      const rows = escRes.rows || [];
      const totalReserved = rows.reduce((s: number, r: any) => s + parseFloat(String(r.reserved_amount || 0)), 0);

      if (resolution.type === 'refund') {
        for (const r of rows) {
          await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [r.reserved_amount, r.participant_id]);
          await client.query(`INSERT INTO transactions (user_id, type, amount, description, related_id, status, created_at) VALUES ($1,$2,$3,$4,$5,'completed',now())`, [r.participant_id, 'challenge_refund', r.reserved_amount.toString(), `Refund for challenge ${challengeId}`, challengeId]);
        }
        await client.query(`UPDATE challenges SET status='cancelled' WHERE id = $1`, [challengeId]);
      } else if (resolution.type === 'winner' && resolution.winnerParticipantId) {
        const winnerId = resolution.winnerParticipantId;
        const loserReservation = rows.find((r: any) => r.participant_id !== winnerId);
        const losingStakeAmount = parseFloat(String(loserReservation?.reserved_amount || totalReserved / 2 || 0));
        const platformFee = calculateLoserSideChallengeFee(losingStakeAmount);
        const net = totalReserved - platformFee;
        await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [net, winnerId]);
        await client.query(`INSERT INTO transactions (user_id, type, amount, description, related_id, status, created_at) VALUES ($1,$2,$3,$4,$5,'completed',now())`, [winnerId, 'challenge_payout_admin', net.toString(), `Admin resolved payout for challenge ${challengeId}`, challengeId]);
        await client.query(`UPDATE challenges SET status='completed', result=$1, completed_at=now() WHERE id = $2`, [winnerId === (await this.getChallengeById(challengeId))?.challenger ? 'challenger_won' : 'challenged_won', challengeId]);
      } else if (resolution.type === 'split' && Array.isArray(resolution.split)) {
        for (const s of resolution.split) {
          const participantId = s.participantId;
          const pct = parseFloat(String(s.pct || 0)) / 100.0;
          const amount = totalReserved * pct;
          await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [amount, participantId]);
          await client.query(`INSERT INTO transactions (user_id, type, amount, description, related_id, status, created_at) VALUES ($1,$2,$3,$4,$5,'completed',now())`, [participantId, 'challenge_payout_split', amount.toString(), `Admin split payout for challenge ${challengeId}`, challengeId]);
        }
        await client.query(`UPDATE challenges SET status='completed', result='split', completed_at=now() WHERE id = $1`, [challengeId]);
      }

      await client.query(`INSERT INTO challenge_state_history (challenge_id, prev_state, new_state, changed_by, changed_at, note) VALUES ($1,$2,$3,$4,now(),$5)`, [String(challengeId), 'dispute', 'resolved', adminId, `admin_resolve: ${JSON.stringify(resolution)}`]);

      // mark reservations resolved
      await client.query(`UPDATE escrow_reservations SET status='released' WHERE challenge_id = $1`, [String(challengeId)]);

      await client.query('COMMIT');
      // Notify participants about admin resolution
      try {
        const challenge: any = await this.getChallengeById(challengeId);
        if (challenge) {
          const participantIds = rows.map((r: any) => r.participant_id);
          const winnerId = resolution.type === 'winner' ? resolution.winnerParticipantId : null;
          challengeNotifications.notifyDisputeResolved(challengeId, participantIds[0], participantIds[1], winnerId || null, JSON.stringify(resolution)).catch(() => {});
        }
      } catch (err) {
        // ignore
      }
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  constructor() {
    const MemoryStore = createMemoryStore(session);
    this.sessionStore = new MemoryStore({
      checkPeriod: 86400000, // prune expired entries every 24h
    });
  }

  // User operations - Updated for email/password auth
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async getUserByUsernameOrEmail(usernameOrEmail: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(
      or(
        eq(users.username, usernameOrEmail),
        eq(users.email, usernameOrEmail)
      )
    );
    return user;
  }

  async getUserByTelegramId(telegramId: string): Promise<User | null> {
    const result = await this.db
      .select()
      .from(users)
      .where(eq(users.telegramId, telegramId))
      .limit(1);
    return result[0] || null;
  }

  async updateUserTelegramInfo(userId: string, telegramInfo: {
    telegramId: string;
    telegramUsername: string | null;
    isTelegramUser: boolean;
  }): Promise<void> {
    await this.db
      .update(users)
      .set({
        telegramId: telegramInfo.telegramId,
        telegramUsername: telegramInfo.telegramUsername,
        isTelegramUser: telegramInfo.isTelegramUser,
      })
      .where(eq(users.id, userId));
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    // Ensure any provided username is unique; if collision occurs during upsert,
    // pick a deterministic unique variant to avoid failing auth flows (e.g., Privy).
    let usernameToUse = (userData as any).username as string | undefined;

    if (usernameToUse) {
      const [existing] = await this.db.select().from(users).where(eq(users.username, usernameToUse)).limit(1);
      if (existing && existing.id !== (userData as any).id) {
        // Generate a short unique suffix using nanoid (crypto-based)
        const base = usernameToUse.replace(/[^a-z0-9_]/gi, '').slice(0, 20) || 'user';
        let candidate = usernameToUse;
        // Try up to a few times to find a free username
        for (let i = 0; i < 5; i++) {
          candidate = `${base}_${nanoid(4)}`;
          const [found] = await this.db.select().from(users).where(eq(users.username, candidate)).limit(1);
          if (!found) {
            usernameToUse = candidate;
            break;
          }
        }
        // If still colliding (extremely unlikely), append timestamp
        if (!usernameToUse || usernameToUse === usernameToUse) {
          usernameToUse = `${base}_${Date.now().toString().slice(-5)}`;
        }
      }
    }

    const insertValues = {
      ...userData,
      referralCode: userData.referralCode || this.generateReferralCode(),
      ...(usernameToUse ? { username: usernameToUse } : {}),
    } as any;

    const [user] = await this.db
      .insert(users)
      .values(insertValues)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          ...insertValues,
          updatedAt: new Date(),
        },
      })
      .returning();

    return user;
  }

  async createUser(userData: any): Promise<User> {
    try {
      // Use username as referral code, fallback to random if no username
      const referralCode = userData.username || this.generateReferralCode();

      const [newUser] = await this.db.insert(users).values({
        ...userData,
        referralCode,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning();

      return newUser;
    } catch (error) {
      console.error("Error creating user:", error);
      throw error;
    }
  }

  async createAgent(agent: CreateAgentRecordInput): Promise<Agent> {
    const values = {
      ...agent,
      updatedAt: new Date(),
    } as typeof agents.$inferInsert;

    const [createdAgent] = await this.db
      .insert(agents)
      .values(values)
      .returning();

    return createdAgent;
  }

  async getAgentById(agentId: string): Promise<StoredAgentWithOwner | undefined> {
    const [row] = await this.db
      .select({
        agent: agents,
        owner: {
          id: users.id,
          username: users.username,
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        },
      })
      .from(agents)
      .innerJoin(users, eq(agents.ownerId, users.id))
      .where(eq(agents.agentId, agentId))
      .limit(1);

    if (!row) return undefined;

    return {
      ...row.agent,
      owner: row.owner,
    };
  }

  async getAgentByWalletAddress(walletAddress: string): Promise<Agent | undefined> {
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(eq(agents.walletAddress, walletAddress))
      .limit(1);

    return agent;
  }

  async getAgentByEndpointUrl(endpointUrl: string): Promise<Agent | undefined> {
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(eq(agents.endpointUrl, endpointUrl))
      .limit(1);

    return agent;
  }

  async listAgents(
    options: Pick<AgentListQuery, "page" | "limit" | "specialty" | "agentType" | "status" | "sort">,
  ): Promise<{ items: StoredAgentWithOwner[]; total: number }> {
    const { page, limit, specialty, agentType, status, sort } = options;
    const offset = (page - 1) * limit;
    const conditions = [];

    if (specialty) conditions.push(eq(agents.specialty, specialty));
    if (agentType) conditions.push(eq(agents.agentType, agentType));
    if (status) conditions.push(eq(agents.status, status));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const orderByClause =
      sort === "points"
        ? [desc(agents.points), desc(agents.createdAt)]
        : sort === "wins"
          ? [desc(agents.winCount), desc(agents.createdAt)]
          : [desc(agents.createdAt)];

    const rows = await this.db
      .select({
        agent: agents,
        owner: {
          id: users.id,
          username: users.username,
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        },
      })
      .from(agents)
      .innerJoin(users, eq(agents.ownerId, users.id))
      .where(whereClause)
      .orderBy(...orderByClause)
      .limit(limit)
      .offset(offset);

    const [totalRow] = await this.db
      .select({ value: count() })
      .from(agents)
      .where(whereClause);

    return {
      items: rows.map((row) => ({
        ...row.agent,
        owner: row.owner,
      })),
      total: Number(totalRow?.value ?? 0),
    };
  }

  async countImportedAgentsByOwnerSince(ownerId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.agentType, "imported"), sql`${agents.createdAt} >= ${since}`));

    return Number(row?.value ?? 0);
  }

  async updateAgentSkillCheck(
    agentId: string,
    updates: {
      bantahSkillVersion?: string;
      lastSkillCheckAt: Date;
      lastSkillCheckScore: number;
      lastSkillCheckStatus: "passed" | "failed";
    },
  ): Promise<Agent> {
    const [updatedAgent] = await this.db
      .update(agents)
      .set({
        ...(updates.bantahSkillVersion
          ? { bantahSkillVersion: updates.bantahSkillVersion }
          : {}),
        lastSkillCheckAt: updates.lastSkillCheckAt,
        lastSkillCheckScore: updates.lastSkillCheckScore,
        lastSkillCheckStatus: updates.lastSkillCheckStatus,
        updatedAt: new Date(),
      })
      .where(eq(agents.agentId, agentId))
      .returning();

    return updatedAgent;
  }

  async incrementAgentMarketCount(agentId: string, delta = 1): Promise<Agent> {
    const [updatedAgent] = await this.db
      .update(agents)
      .set({
        marketCount: sql`${agents.marketCount} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(eq(agents.agentId, agentId))
      .returning();

    return updatedAgent;
  }

  async recordAgentChallengeOutcome(
    agentId: string,
    outcome: "win" | "loss",
    delta = 1,
  ): Promise<Agent> {
    const sanitizedDelta = Math.max(1, Math.trunc(delta || 1));
    const rewardDelta =
      outcome === "win" ? sanitizedDelta * AGENT_WIN_BANTCREDIT_REWARD : 0;
    const [updatedAgent] = await this.db
      .update(agents)
      .set({
        points:
          outcome === "win"
            ? sql`${agents.points} + ${rewardDelta}`
            : agents.points,
        winCount:
          outcome === "win"
            ? sql`${agents.winCount} + ${sanitizedDelta}`
            : agents.winCount,
        lossCount:
          outcome === "loss"
            ? sql`${agents.lossCount} + ${sanitizedDelta}`
            : agents.lossCount,
        updatedAt: new Date(),
      })
      .where(eq(agents.agentId, agentId))
      .returning();

    return updatedAgent;
  }

  async toggleAgentFollow(
    userId: string,
    agentId: string,
  ): Promise<{ action: "followed" | "unfollowed" }> {
    const [existingFollow] = await this.db
      .select()
      .from(agentFollows)
      .where(and(eq(agentFollows.userId, userId), eq(agentFollows.agentId, agentId)))
      .limit(1);

    if (existingFollow) {
      await this.db.delete(agentFollows).where(eq(agentFollows.id, existingFollow.id));
      return { action: "unfollowed" };
    }

    try {
      await this.db.insert(agentFollows).values({
        userId,
        agentId,
      });
      return { action: "followed" };
    } catch (_error) {
      return { action: "followed" };
    }
  }

  async getAgentFollowState(
    agentId: string,
    userId?: string | null,
  ): Promise<{ isFollowing: boolean; followerCount: number }> {
    const [followerCountRow, followRecord] = await Promise.all([
      this.db
        .select({ count: count() })
        .from(agentFollows)
        .where(eq(agentFollows.agentId, agentId))
        .then((rows) => rows[0]),
      userId
        ? this.db
            .select({ id: agentFollows.id })
            .from(agentFollows)
            .where(and(eq(agentFollows.userId, userId), eq(agentFollows.agentId, agentId)))
            .limit(1)
            .then((rows) => rows[0])
        : Promise.resolve(undefined),
    ]);

    return {
      isFollowing: Boolean(followRecord),
      followerCount: Number(followerCountRow?.count ?? 0),
    };
  }

  async getAgentFollowerIds(agentId: string): Promise<string[]> {
    const followerRows = await this.db
      .select({ userId: agentFollows.userId })
      .from(agentFollows)
      .where(eq(agentFollows.agentId, agentId));

    return followerRows.map((row) => row.userId);
  }

  async updateUserProfile(id: string, updates: Partial<User>): Promise<User> {
    // If username is being updated, enforce uniqueness
    if (typeof updates.username === 'string' && updates.username.trim() !== '') {
      const [existing] = await this.db
        .select()
        .from(users)
        .where(eq(users.username, updates.username))
        .limit(1);

      if (existing && existing.id !== id) {
        const err: any = new Error('Username already in use');
        err.status = 400;
        throw err;
      }
    }

    const [user] = await this.db
      .update(users)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async updateNotificationPreferences(userId: string, preferences: any): Promise<void> {
    // Store notification preferences in user preferences table or update user record
    // For now, we'll store them as JSON in the user record or create a separate preferences system
    await this.db
      .update(users)
      .set({
        notificationPreferences: JSON.stringify(preferences),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  async getUserPreferences(userId: string): Promise<UserPreferences | undefined> {
    const [preferences] = await this.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    return preferences;
  }

  async updateUserPreferences(userId: string, preferences: Partial<InsertUserPreferences>): Promise<UserPreferences> {
    // Try to update existing preferences first
    const existingPrefs = await this.getUserPreferences(userId);

    if (existingPrefs) {
      const [updated] = await this.db
        .update(userPreferences)
        .set({
          ...preferences,
          updatedAt: new Date(),
        })
        .where(eq(userPreferences.userId, userId))
        .returning();
      return updated;
    } else {
      // Create new preferences if none exist
      const [created] = await this.db
        .insert(userPreferences)
        .values({
          userId,
          ...preferences,
          updatedAt: new Date(),
        })
        .returning();
      return created;
    }
  }

  // Event operations
  async getEvents(limit = 10): Promise<Event[]> {
    try {
      const eventsWithCreators = await this.db
        .select({
          id: events.id,
          title: events.title,
          description: events.description,
          category: events.category,
          imageUrl: events.imageUrl,
          status: events.status,
          isPrivate: events.isPrivate,
          maxParticipants: events.maxParticipants,
          entryFee: events.entryFee,
          endDate: events.endDate,
          yesPool: events.yesPool,
          noPool: events.noPool,
          eventPool: events.eventPool,
          creatorId: events.creatorId,
          result: events.result,
          adminResult: events.adminResult,
          creatorFee: events.creatorFee,
          chatEnabled: events.chatEnabled,
          createdAt: events.createdAt,
          updatedAt: events.updatedAt,
          // Creator information
          creatorName: users.firstName,
          creatorUsername: users.username,
          creatorEmail: users.email,
          creatorProfileImageUrl: users.profileImageUrl,
        })
        .from(events)
        .leftJoin(users, eq(events.creatorId, users.id))
        .orderBy(desc(events.createdAt))
        .limit(limit);

      // Transform the data to include nested creator object and compatibility aliases
      return eventsWithCreators.map(event => ({
        ...event,
        // Add compatibility aliases for frontend
        bannerUrl: event.imageUrl,
        banner_url: event.imageUrl,
        is_private: event.isPrivate,
        max_participants: event.maxParticipants,
        end_time: event.endDate,
        eventType: 'prediction', // Default event type
        creator: {
          id: event.creatorId,
          name: event.creatorName,
          firstName: event.creatorName,
          username: event.creatorUsername,
          email: event.creatorEmail,
          profileImageUrl: event.creatorProfileImageUrl,
          avatar_url: event.creatorProfileImageUrl,
          avatarUrl: event.creatorProfileImageUrl,
        }
      }));
    } catch (error) {
      console.error("Error fetching events:", error);
      throw new Error("Failed to fetch events");
    }
  }

  async getEventById(id: number): Promise<Event | undefined> {
    try {
      const [eventData] = await this.db
        .select({
          id: events.id,
          title: events.title,
          description: events.description,
          category: events.category,
          status: events.status,
          creatorId: events.creatorId,
          eventPool: events.eventPool,
          yesPool: events.yesPool,
          noPool: events.noPool,
          entryFee: events.entryFee,
          endDate: events.endDate,
          result: events.result,
          adminResult: events.adminResult,
          creatorFee: events.creatorFee,
          isPrivate: events.isPrivate,
          maxParticipants: events.maxParticipants,
          imageUrl: events.imageUrl,
          chatEnabled: events.chatEnabled,
          createdAt: events.createdAt,
          updatedAt: events.updatedAt,
          // Creator information
          creatorName: sql<string>`COALESCE(${users.firstName} || ' ' || ${users.lastName}, ${users.username}, ${users.email})`.as('creator_name'),
          creatorUsername: users.username,
          creatorEmail: users.email,
          creatorProfileImageUrl: users.profileImageUrl,
        })
        .from(events)
        .leftJoin(users, eq(events.creatorId, users.id))
        .where(eq(events.id, id));

      if (!eventData) {
        return undefined;
      }

      // Transform the data to include nested creator object and compatibility aliases
      return {
        ...eventData,
        // Add compatibility aliases for frontend
        bannerUrl: eventData.imageUrl,
        banner_url: eventData.imageUrl,
        image_url: eventData.imageUrl,
        is_private: eventData.isPrivate,
        max_participants: eventData.maxParticipants,
        end_time: eventData.endDate,
        start_time: eventData.createdAt, // Using createdAt as start_time fallback
        eventType: 'prediction', // Default event type
        creator: {
          id: eventData.creatorId,
          name: eventData.creatorName,
          firstName: eventData.creatorName,
          username: eventData.creatorUsername,
          email: eventData.creatorEmail,
          profileImageUrl: eventData.creatorProfileImageUrl,
          avatar_url: eventData.creatorProfileImageUrl,
          avatarUrl: eventData.creatorProfileImageUrl,
        }
      } as any;
    } catch (error) {
      console.error("Error fetching event by ID:", error);
      return undefined;
    }
  }

  async searchEventsByTitle(query: string): Promise<Event[]> {
    return await this.db
      .select()
      .from(events)
      .where(
        or(
          sql`LOWER(${events.title}) LIKE LOWER(${'%' + query + '%'})`,
          sql`LOWER(${events.description}) LIKE LOWER(${'%' + query + '%'})`
        )
      )
      .orderBy(desc(events.createdAt))
      .limit(10);
  }

  async createEvent(event: InsertEvent): Promise<Event> {
    const eventData = {
      ...event,
      eventPool: 0,
      yesPool: 0,
      noPool: 0,
      creatorFee: 0,
    };
    const [newEvent] = await this.db.insert(events).values(eventData).returning();
    return newEvent;
  }

  async updateEvent(id: number, updates: Partial<Event>): Promise<Event> {
    const [event] = await this.db
      .update(events)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(events.id, id))
      .returning();
    return event;
  }

  async joinEvent(eventId: number, userId: string, prediction: boolean, amount: number): Promise<EventParticipant> {
    // Get event to validate betting model and amount
    const event = await this.getEventById(eventId);
    if (!event) {
      throw new Error("Event not found");
    }

    const minAmount = parseFloat(event.entryFee);

    // Validate amount based on betting model
    if (event.bettingModel === "fixed") {
      if (Math.abs(amount - minAmount) > 0.01) { // Allow for floating point precision
        throw new Error(`Fixed betting model requires exactly ₦${minAmount}`);
      }
    } else if (event.bettingModel === "custom") {
      if (amount < minAmount) {
        throw new Error(`Custom betting requires minimum ₦${minAmount}`);
      }

      // Add reasonable maximum to prevent abuse (10x the minimum)
      const maxAmount = minAmount * 10;
      if (amount > maxAmount) {
        throw new Error(`Maximum bet amount is ₦${maxAmount.toLocaleString()}`);
      }
    }

    // First, try to find an unmatched participant with opposite prediction (FCFS)
    const oppositeParticipant = await this.db
      .select()
      .from(eventParticipants)
      .where(
        and(
          eq(eventParticipants.eventId, eventId),
          eq(eventParticipants.prediction, !prediction), // Opposite prediction
          eq(eventParticipants.status, "active"), // Not yet matched
          isNull(eventParticipants.matchedWith) // No opponent assigned
        )
      )
      .orderBy(asc(eventParticipants.joinedAt)) // FCFS order
      .limit(1);

    const [participant] = await this.db
      .insert(eventParticipants)
      .values({
        eventId,
        userId,
        prediction,
        amount: amount.toString(),
      })
      .returning();

    // If opponent found, match them (FCFS matching)
    if (oppositeParticipant.length > 0) {
      const opponent = oppositeParticipant[0];

      // Update both participants to "matched" status
      await this.db
        .update(eventParticipants)
        .set({ 
          status: "matched",
          matchedWith: userId 
        })
        .where(eq(eventParticipants.id, opponent.id));

      await this.db
        .update(eventParticipants)
        .set({ 
          status: "matched",
          matchedWith: opponent.userId 
        })
        .where(eq(eventParticipants.id, participant.id));
    }

    // Update event pools (both individual and total)
    if (prediction) {
      await this.db
        .update(events)
        .set({
          yesPool: sql`${events.yesPool} + ${amount}`,
          eventPool: sql`${events.eventPool} + ${amount}`,
        })
        .where(eq(events.id, eventId));
    } else {
      await this.db
        .update(events)
        .set({
          noPool: sql`${events.noPool} + ${amount}`,
          eventPool: sql`${events.eventPool} + ${amount}`,
        })
        .where(eq(events.id, eventId));
    }

    return participant;
  }

  async getEventParticipants(eventId: number): Promise<EventParticipant[]> {
    return await this.db
      .select()
      .from(eventParticipants)
      .where(eq(eventParticipants.eventId, eventId));
  }

  async getUserEventParticipations(userId: string): Promise<EventParticipant[]> {
    return await this.db
      .select()
      .from(eventParticipants)
      .where(eq(eventParticipants.userId, userId));
  }

  async getEventMessages(eventId: number, limit = 50): Promise<any[]> {
    const messages = await this.db
      .select({
        id: eventMessages.id,
        eventId: eventMessages.eventId,
        userId: eventMessages.userId,
        message: eventMessages.message,
        replyToId: eventMessages.replyToId,
        mentions: eventMessages.mentions,
        createdAt: eventMessages.createdAt,
        user: users,
      })
      .from(eventMessages)
      .innerJoin(users, eq(eventMessages.userId, users.id))
      .where(eq(eventMessages.eventId, eventId))
      .orderBy(desc(eventMessages.createdAt))
      .limit(limit);

    // Get reactions for each message
    const messageIds = messages.map(m => m.id);
    const reactions = messageIds.length > 0 ? await this.db
      .select({
        messageId: messageReactions.messageId,
        emoji: messageReactions.emoji,
        userId: messageReactions.userId,
        user: {
          id: users.id,
          username: users.username,
          firstName: users.firstName,
        }
      })
      .from(messageReactions)
      .innerJoin(users, eq(messageReactions.userId, users.id))
      .where(inArray(messageReactions.messageId, messageIds)) : [];

    // Get reply-to messages
    const replyToIds = messages.filter(m => m.replyToId).map(m => m.replyToId);
    const replyToMessages = replyToIds.length > 0 ? await this.db
      .select({
        id: eventMessages.id,
        message: eventMessages.message,
        user: {
          id: users.id,
          username: users.username,
          firstName: users.firstName,
        }
      })
      .from(eventMessages)
      .innerJoin(users, eq(eventMessages.userId, users.id))
      .where(inArray(eventMessages.id, replyToIds)) : [];

    // Combine data
    return messages.map(message => {
      const msgReactions = reactions.filter(r => r.messageId === message.id);
      const reactionSummary = msgReactions.reduce((acc: any[], reaction) => {
        const existing = acc.find(r => r.emoji === reaction.emoji);
        if (existing) {
          existing.count++;
          existing.users.push(reaction.user.username || reaction.user.firstName);
          if (reaction.userId === message.userId) {
            existing.userReacted = true;
          }
        } else {
          acc.push({
            emoji: reaction.emoji,
            count: 1,
            users: [reaction.user.username || reaction.user.firstName],
            userReacted: reaction.userId === message.userId,
          });
        }
        return acc;
      }, []);

      const replyTo = message.replyToId ? 
        replyToMessages.find(r => r.id === message.replyToId) : null;

      return {
        ...message,
        reactions: reactionSummary,
        replyTo,
      };
    });
  }

  async createGlobalChatMessage(messageData: any) {
    try {
      const [newMessage] = await this.db.insert(eventMessages).values({
        eventId: null, // Global chat messages don't belong to specific events
        userId: messageData.userId,
        message: messageData.message,
        replyToId: messageData.replyToId || null,
        mentions: messageData.mentions || null,
      }).returning();

      // Get user info for the message
      const user = messageData.user || await this.getUser(messageData.userId);

      return {
        ...newMessage,
        user: user || {
          id: messageData.userId,
          firstName: 'Unknown User',
          username: messageData.userId,
          profileImageUrl: null,
        }
      };
    } catch (error) {
      console.error("Error creating global chat message:", error);
      throw error;
    }
  }

  async getGlobalChatMessages(limit = 50) {
    try {
      const messagesWithUsers = await this.db
        .select({
          id: eventMessages.id,
          userId: eventMessages.userId,
          message: eventMessages.message,
          createdAt: eventMessages.createdAt,
          replyToId: eventMessages.replyToId,
          mentions: eventMessages.mentions,
          user: {
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            username: users.username,
            profileImageUrl: users.profileImageUrl,
          }
        })
        .from(eventMessages)
        .leftJoin(users, eq(eventMessages.userId, users.id))
        .where(sql`${eventMessages.eventId} IS NULL`) // Global chat messages
        .orderBy(sql`${eventMessages.createdAt} DESC`)
        .limit(limit);

      return messagesWithUsers;
    } catch (error) {
      console.error("Error fetching global chat messages:", error);
      throw error;
    }
  }

  async createEventMessage(eventId: number, userId: string, message: string, replyToId?: string, mentions?: string[], telegramUser?: any): Promise<EventMessage> {
    const [newMessage] = await this.db
      .insert(eventMessages)
      .values({ 
        eventId, 
        userId, 
        message, 
        replyToId: replyToId ? parseInt(replyToId) : null,
        mentions: mentions || []
      })
      .returning();

    // Get user info for the response
    let user;
    if (telegramUser) {
      // Use provided Telegram user info
      user = telegramUser;
    } else {
      // Get from database for regular BetChat users
      user = await this.getUser(userId);
    }

    return {
      ...newMessage,
      user: {
        id: user?.id,
        firstName: user?.firstName,
        lastName: user?.lastName,
        username: user?.username,
        profileImageUrl: user?.profileImageUrl,
        level: user?.level,
        isTelegramUser: telegramUser ? true : false,
      }
    };
  }

  async getEventMessageById(messageId: string): Promise<EventMessage | undefined> {
    const [message] = await this.db
      .select()
      .from(eventMessages)
      .where(eq(eventMessages.id, parseInt(messageId)));
    return message;
  }

  async toggleMessageReaction(messageId: string, userId: string, emoji: string): Promise<any> {
    // Check if reaction already exists
    const [existingReaction] = await this.db
      .select()
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, parseInt(messageId)),
          eq(messageReactions.userId, userId),
          eq(messageReactions.emoji, emoji)
        )
      );

    if (existingReaction) {
      // Remove reaction
      await this.db
        .delete(messageReactions)
        .where(eq(messageReactions.id, existingReaction.id));
      return { action: 'removed' };
    } else {
      // Add reaction
      const [newReaction] = await this.db
        .insert(messageReactions)
        .values({
          messageId: parseInt(messageId),
          userId,
          emoji,
        })
        .returning();
      return { action: 'added', reaction: newReaction };
    }
  }

  async getMessageReactions(messageId: string): Promise<any[]> {
    const reactions = await this.db
      .select({
        id: messageReactions.id,
        messageId: messageReactions.messageId,
        userId: messageReactions.userId,
        emoji: messageReactions.emoji,
        createdAt: messageReactions.createdAt,
        user: {
          id: users.id,
          username: users.username,
          firstName: users.firstName,
        }
      })
      .from(messageReactions)
      .innerJoin(users, eq(messageReactions.userId, users.id))
      .where(eq(messageReactions.messageId, parseInt(messageId)));

    // Group reactions by emoji
    const groupedReactions = reactions.reduce((acc: any[], reaction) => {
      const existing = acc.find(r => r.emoji === reaction.emoji);
      if (existing) {
        existing.count++;
        existing.users.push(reaction.user.username || reaction.user.firstName);
      } else {
        acc.push({
          emoji: reaction.emoji,
          count: 1,
          users: [reaction.user.username || reaction.user.firstName],
          userReacted: false, // Will be set by caller based on current user
        });
      }
      return acc;
    }, []);

    return groupedReactions;
  }

  async getEventParticipantsWithUsers(eventId: number): Promise<any[]> {
    return await this.db
      .select({
        id: eventParticipants.id,
        eventId: eventParticipants.eventId,
        userId: eventParticipants.userId,
        prediction: eventParticipants.prediction,
        amount: eventParticipants.amount,
        user: users,
      })
      .from(eventParticipants)
      .innerJoin(users, eq(eventParticipants.userId, users.id))
      .where(eq(eventParticipants.eventId, eventId));
  }

  // Challenge operations
  async getChallenges(userId: string, limit = 10): Promise<(Challenge & { challengerUser: User, challengedUser: User, participantCount: number })[]> {
    const includeChallengeSideColumns = await this.supportsChallengeSideColumns();
    const dbUser = await this.getUser(userId);
    const ownedAgentRows = await this.db
      .select({ agentId: agents.agentId })
      .from(agents)
      .where(eq(agents.ownerId, userId));
    const ownedAgentIds = ownedAgentRows
      .map((row) => row.agentId)
      .filter((value): value is string => Boolean(value));
    const walletTargets = new Set<string>();
    const primaryWallet = normalizeEvmAddress((dbUser as any)?.primaryWalletAddress);
    if (primaryWallet) walletTargets.add(primaryWallet);
    parseWalletAddresses((dbUser as any)?.walletAddresses).forEach((wallet) => walletTargets.add(wallet));
    const targetWalletList = Array.from(walletTargets);

    const visibilityFilters = [
      eq(challenges.challenger, userId),
      eq(challenges.challenged, userId),
      // Include admin-created open challenges so users see featured/admin challenges
      and(eq(challenges.adminCreated, true), eq(challenges.status, 'open')),
    ];

    if (targetWalletList.length > 0) {
      visibilityFilters.push(inArray(challenges.challengedWalletAddress, targetWalletList));
    }

    if (ownedAgentIds.length > 0) {
      visibilityFilters.push(
        or(
          inArray(challenges.creatorAgentId, ownedAgentIds),
          inArray(challenges.challengerAgentId, ownedAgentIds),
          inArray(challenges.challengedAgentId, ownedAgentIds),
        )!,
      );
    }

    // First get all challenges
    const challengesList = await this.db
      .select({
        id: challenges.id,
        challenger: challenges.challenger,
        challenged: challenges.challenged,
        challengedWalletAddress: challenges.challengedWalletAddress,
        creatorType: challenges.creatorType,
        challengerType: challenges.challengerType,
        challengedType: challenges.challengedType,
        creatorAgentId: challenges.creatorAgentId,
        challengerAgentId: challenges.challengerAgentId,
        challengedAgentId: challenges.challengedAgentId,
        createdByAgent: challenges.createdByAgent,
        agentInvolved: challenges.agentInvolved,
        title: challenges.title,
        description: challenges.description,
        category: challenges.category,
        amount: challenges.amount,
        ...this.getChallengeSideSelects(includeChallengeSideColumns),
        status: challenges.status,
        evidence: challenges.evidence,
        result: challenges.result,
        dueDate: challenges.dueDate,
        createdAt: challenges.createdAt,
        completedAt: challenges.completedAt,
        adminCreated: challenges.adminCreated,
        settlementRail: challenges.settlementRail,
        chainId: challenges.chainId,
        tokenSymbol: challenges.tokenSymbol,
        tokenAddress: challenges.tokenAddress,
        decimals: challenges.decimals,
        stakeAtomic: challenges.stakeAtomic,
        escrowTxHash: challenges.escrowTxHash,
        settleTxHash: challenges.settleTxHash,
        bonusSide: challenges.bonusSide,
        bonusMultiplier: challenges.bonusMultiplier,
        bonusEndsAt: challenges.bonusEndsAt,
        yesStakeTotal: challenges.yesStakeTotal,
        noStakeTotal: challenges.noStakeTotal,
        coverImageUrl: challenges.coverImageUrl,
        challengerUser: {
          id: sql`challenger_user.id`,
          username: sql`challenger_user.username`,
          firstName: sql`challenger_user.first_name`,
          lastName: sql`challenger_user.last_name`,
          profileImageUrl: sql`challenger_user.profile_image_url`,
        },
        challengedUser: {
          id: sql`challenged_user.id`,
          username: sql`challenged_user.username`,
          firstName: sql`challenged_user.first_name`,
          lastName: sql`challenged_user.last_name`,
          profileImageUrl: sql`challenged_user.profile_image_url`,
        },
      })
      .from(challenges)
      .leftJoin(sql`users challenger_user`, eq(challenges.challenger, sql`challenger_user.id`))
      .leftJoin(sql`users challenged_user`, eq(challenges.challenged, sql`challenged_user.id`))
      .where(and(or(...visibilityFilters), ne(challenges.status, "draft")))
      .orderBy(desc(challenges.createdAt))
      .limit(limit) as any;

    const challengeIds = this.normalizeChallengeIds(challengesList.map((challenge: any) => challenge.id));
    const adminChallengeIds = this.normalizeChallengeIds(
      challengesList
        .filter((challenge: any) => Boolean(challenge.adminCreated))
        .map((challenge: any) => challenge.id),
    );
    const regularChallengeIds = this.normalizeChallengeIds(
      challengesList
        .filter((challenge: any) => !challenge.adminCreated)
        .map((challenge: any) => challenge.id),
    );

    const [regularParticipantCountMap, adminParticipantMetaMap, commentCountMap] = await Promise.all([
      this.getPairQueueCountMap(regularChallengeIds),
      this.getAdminChallengeParticipantMetaMap(adminChallengeIds),
      this.getChallengeCommentCountMap(challengeIds),
    ]);

    const challengesWithParticipants = challengesList.map((challenge: any) => {
      const challengeId = Number(challenge.id);
      const adminMeta = adminParticipantMetaMap.get(challengeId);
      const participantCount = challenge.adminCreated
        ? Number(adminMeta?.participantCount || 0)
        : Number(regularParticipantCountMap.get(challengeId) || 0);
      const participantPreviewUsers = challenge.adminCreated
        ? (adminMeta?.participantPreviewUsers || [])
        : [];
      const commentCount = Number(commentCountMap.get(challengeId) || 0);

      return {
        ...challenge,
        status: this.normalizeP2PChallengeStatus(
          challenge.status,
          challenge.adminCreated,
          challenge.challenged,
          (challenge as any).challengedWalletAddress,
        ),
        participantCount,
        participantPreviewUsers,
        commentCount,
      };
    });

    return challengesWithParticipants;
  }

  // Get all challenges for public feed (no user filtering)
  async getAllChallengesFeed(limit = 100): Promise<(Challenge & { challengerUser: User, challengedUser: User, participantCount: number })[]> {
    const includeChallengeSideColumns = await this.supportsChallengeSideColumns();
    const challengesList = await this.db
      .select({
        id: challenges.id,
        challenger: challenges.challenger,
        challenged: challenges.challenged,
        challengedWalletAddress: challenges.challengedWalletAddress,
        creatorType: challenges.creatorType,
        challengerType: challenges.challengerType,
        challengedType: challenges.challengedType,
        creatorAgentId: challenges.creatorAgentId,
        challengerAgentId: challenges.challengerAgentId,
        challengedAgentId: challenges.challengedAgentId,
        createdByAgent: challenges.createdByAgent,
        agentInvolved: challenges.agentInvolved,
        title: challenges.title,
        description: challenges.description,
        category: challenges.category,
        amount: challenges.amount,
        ...this.getChallengeSideSelects(includeChallengeSideColumns),
        status: challenges.status,
        evidence: challenges.evidence,
        result: challenges.result,
        dueDate: challenges.dueDate,
        createdAt: challenges.createdAt,
        completedAt: challenges.completedAt,
        adminCreated: challenges.adminCreated,
        settlementRail: challenges.settlementRail,
        chainId: challenges.chainId,
        tokenSymbol: challenges.tokenSymbol,
        tokenAddress: challenges.tokenAddress,
        decimals: challenges.decimals,
        stakeAtomic: challenges.stakeAtomic,
        escrowTxHash: challenges.escrowTxHash,
        settleTxHash: challenges.settleTxHash,
        bonusSide: challenges.bonusSide,
        bonusMultiplier: challenges.bonusMultiplier,
        bonusEndsAt: challenges.bonusEndsAt,
        yesStakeTotal: challenges.yesStakeTotal,
        noStakeTotal: challenges.noStakeTotal,
        coverImageUrl: challenges.coverImageUrl,
        challengerUser: {
          id: sql`challenger_user.id`,
          username: sql`challenger_user.username`,
          firstName: sql`challenger_user.first_name`,
          lastName: sql`challenger_user.last_name`,
          profileImageUrl: sql`challenger_user.profile_image_url`,
        },
        challengedUser: {
          id: sql`challenged_user.id`,
          username: sql`challenged_user.username`,
          firstName: sql`challenged_user.first_name`,
          lastName: sql`challenged_user.last_name`,
          profileImageUrl: sql`challenged_user.profile_image_url`,
        },
      })
      .from(challenges)
      .leftJoin(sql`users challenger_user`, eq(challenges.challenger, sql`challenger_user.id`))
      .leftJoin(sql`users challenged_user`, eq(challenges.challenged, sql`challenged_user.id`))
      .where(ne(challenges.status, "draft"))
      .orderBy(desc(challenges.createdAt))
      .limit(limit) as any;

    const challengeIds = this.normalizeChallengeIds(challengesList.map((challenge: any) => challenge.id));
    const adminChallengeIds = this.normalizeChallengeIds(
      challengesList
        .filter((challenge: any) => Boolean(challenge.adminCreated))
        .map((challenge: any) => challenge.id),
    );
    const regularChallengeIds = this.normalizeChallengeIds(
      challengesList
        .filter((challenge: any) => !challenge.adminCreated)
        .map((challenge: any) => challenge.id),
    );

    const [regularParticipantCountMap, adminParticipantMetaMap, commentCountMap] = await Promise.all([
      this.getPairQueueCountMap(regularChallengeIds),
      this.getAdminChallengeParticipantMetaMap(adminChallengeIds),
      this.getChallengeCommentCountMap(challengeIds),
    ]);

    const challengesWithParticipants = challengesList.map((challenge: any) => {
      const challengeId = Number(challenge.id);
      const adminMeta = adminParticipantMetaMap.get(challengeId);
      const participantCount = challenge.adminCreated
        ? Number(adminMeta?.participantCount || 0)
        : Number(regularParticipantCountMap.get(challengeId) || 0);
      const participantPreviewUsers = challenge.adminCreated
        ? (adminMeta?.participantPreviewUsers || [])
        : [];
      const commentCount = Number(commentCountMap.get(challengeId) || 0);

      return {
        ...challenge,
        status: this.normalizeP2PChallengeStatus(
          challenge.status,
          challenge.adminCreated,
          challenge.challenged,
          (challenge as any).challengedWalletAddress,
        ),
        participantCount,
        participantPreviewUsers,
        commentCount,
      };
    });

    return challengesWithParticipants;
  }

  async getChallengeById(id: number): Promise<Challenge | undefined> {
    const includeChallengeSideColumns = await this.supportsChallengeSideColumns();
    const [challenge] = await this.db
      .select({
        id: challenges.id,
        challenger: challenges.challenger,
        challenged: challenges.challenged,
        challengedWalletAddress: challenges.challengedWalletAddress,
        creatorType: challenges.creatorType,
        challengerType: challenges.challengerType,
        challengedType: challenges.challengedType,
        creatorAgentId: challenges.creatorAgentId,
        challengerAgentId: challenges.challengerAgentId,
        challengedAgentId: challenges.challengedAgentId,
        createdByAgent: challenges.createdByAgent,
        agentInvolved: challenges.agentInvolved,
        title: challenges.title,
        description: challenges.description,
        category: challenges.category,
        amount: challenges.amount,
        ...this.getChallengeSideSelects(includeChallengeSideColumns),
        status: challenges.status,
        evidence: challenges.evidence,
        result: challenges.result,
        dueDate: challenges.dueDate,
        createdAt: challenges.createdAt,
        updatedAt: sql<Date | null>`null`,
        completedAt: challenges.completedAt,
        adminCreated: challenges.adminCreated,
        settlementRail: challenges.settlementRail,
        chainId: challenges.chainId,
        tokenSymbol: challenges.tokenSymbol,
        tokenAddress: challenges.tokenAddress,
        decimals: challenges.decimals,
        stakeAtomic: challenges.stakeAtomic,
        escrowTxHash: challenges.escrowTxHash,
        settleTxHash: challenges.settleTxHash,
        bonusSide: challenges.bonusSide,
        bonusMultiplier: challenges.bonusMultiplier,
        bonusAmount: challenges.bonusAmount,
        bonusEndsAt: challenges.bonusEndsAt,
        yesStakeTotal: challenges.yesStakeTotal,
        noStakeTotal: challenges.noStakeTotal,
        coverImageUrl: challenges.coverImageUrl,
        earlyBirdSlots: challenges.earlyBirdSlots,
        earlyBirdBonus: challenges.earlyBirdBonus,
        streakBonusEnabled: challenges.streakBonusEnabled,
        convictionBonusEnabled: challenges.convictionBonusEnabled,
        firstTimeBonusEnabled: challenges.firstTimeBonusEnabled,
        socialTagBonus: challenges.socialTagBonus,
      })
      .from(challenges)
      .where(eq(challenges.id, id));
    
    if (!challenge) return undefined;

    // Fetch user details manually to attach to the challenge object
    const [challengerUser] = challenge.challenger ? await this.db.select().from(users).where(eq(users.id, challenge.challenger)) : [null];
    const [challengedUser] = challenge.challenged ? await this.db.select().from(users).where(eq(users.id, challenge.challenged)) : [null];

    let participantCount = 0;
    let participantPreviewUsers: any[] = [];
    let commentCount = 0;

    if (challenge.adminCreated) {
      const participantMeta = await this.getAdminChallengeParticipantMeta({
        ...challenge,
        challengerUser,
        challengedUser,
      });
      participantCount = participantMeta.participantCount;
      participantPreviewUsers = participantMeta.participantPreviewUsers;
      commentCount = await this.getChallengeCommentCount(id);
    } else {
      const [participantResult] = await this.db
        .select({ count: count() })
        .from(pairQueue)
        .where(eq(pairQueue.challengeId, id));
      participantCount = Number(participantResult?.count || 0);
    }

    return {
      ...challenge,
      challengerUser,
      challengedUser,
      participantCount,
      participantPreviewUsers,
      commentCount,
    } as any;
  }

  async createChallenge(challenge: InsertChallenge): Promise<Challenge> {
    console.log('createChallenge called with:', challenge);
    const MAX_CHALLENGE_AMOUNT = 1_000_000; // NGN safeguard for any non-route callers
    const isOnchainChallenge =
      String((challenge as any).settlementRail || "").toLowerCase() === "onchain";
    
    let balance: { balance: number } | null = null;
    if (!isOnchainChallenge) {
      // Check challenger balance (offchain mode only)
      console.log('Checking balance for challenger:', challenge.challenger);
      balance = await this.getUserBalance(challenge.challenger);
      console.log('Challenger balance:', balance);
    }
    
    const challengeAmount = parseFloat(challenge.amount);
    console.log('Challenge amount:', challengeAmount, 'type:', typeof challengeAmount);
    if (!Number.isFinite(challengeAmount) || challengeAmount <= 0) {
      throw new Error("Invalid challenge amount");
    }
    if (challengeAmount > MAX_CHALLENGE_AMOUNT) {
      throw new Error(`Challenge amount exceeds maximum allowed (₦${MAX_CHALLENGE_AMOUNT.toLocaleString()})`);
    }

    if (!isOnchainChallenge && balance && balance.balance < challengeAmount) {
      console.error('Insufficient balance. Required:', challengeAmount, 'Available:', balance.balance);
      throw new Error("Insufficient balance to create challenge");
    }

    console.log('Balance check passed, creating challenge...');
    const insertValues = await this.sanitizeChallengeSideFields({
      ...challenge,
      adminCreated: false,
    });
    // Create the challenge
    const [newChallenge] = await this.db.insert(challenges).values(insertValues).returning();

    console.log('Challenge insert successful, ID:', newChallenge.id);

    if (!isOnchainChallenge) {
      // Deduct challenger's stake and create escrow ledger entry (offchain mode)
      console.log('Creating transaction for escrow...');
      await this.createTransaction({
        userId: challenge.challenger,
        type: 'challenge_escrow',
        amount: `-${challengeAmount}`,
        description: `Challenge escrow: ${challenge.title}`,
        relatedId: newChallenge.id,
        status: 'completed',
      });
    }

    console.log('Transaction created, creating escrow record...');
    // Create escrow record
    await this.db.insert(escrow).values({
      challengeId: newChallenge.id,
      amount: challengeAmount.toString(),
      status: 'holding',
    });

    console.log('Escrow record created successfully');
    return newChallenge;
  }

  async createChallengeDraft(challenge: InsertChallenge): Promise<Challenge> {
    console.log("createChallengeDraft called with:", challenge);
    const challengeAmount = parseFloat(challenge.amount);
    if (!Number.isFinite(challengeAmount) || challengeAmount <= 0) {
      throw new Error("Invalid challenge amount");
    }

    const insertValues = await this.sanitizeChallengeSideFields({
      ...challenge,
      status: "draft",
      adminCreated: false,
    });

    const [draftChallenge] = await this.db
      .insert(challenges)
      .values(insertValues)
      .returning();

    return draftChallenge;
  }

  // Create a challenge initiated by admin (no challenger required)
  async createAdminChallenge(challengeData: Partial<InsertChallenge>): Promise<Challenge> {
    try {
      const insertValues = await this.sanitizeChallengeSideFields({
        challenger: challengeData.challenger || null,
        challenged: challengeData.challenged || null,
        challengerSide: challengeData.challengerSide || null,
        creatorType: (challengeData as any).creatorType || 'human',
        challengerType: (challengeData as any).challengerType || 'human',
        challengedType: (challengeData as any).challengedType || 'human',
        creatorAgentId: (challengeData as any).creatorAgentId || null,
        challengerAgentId: (challengeData as any).challengerAgentId || null,
        challengedAgentId: (challengeData as any).challengedAgentId || null,
        createdByAgent: (challengeData as any).createdByAgent || false,
        agentInvolved: (challengeData as any).agentInvolved || false,
        title: challengeData.title || 'Admin Challenge',
        description: challengeData.description || null,
        category: challengeData.category || 'general',
        amount: challengeData.amount ? parseInt(String(challengeData.amount)) : 0,
        status: challengeData.status || 'open',
        adminCreated: true,
        bonusSide: challengeData.bonusSide || null,
        bonusMultiplier: '1.00',
        bonusEndsAt: challengeData.bonusEndsAt || null,
        yesStakeTotal: challengeData.yesStakeTotal || 0,
        noStakeTotal: challengeData.noStakeTotal || 0,
        dueDate: (challengeData as any).dueDate || null,
        coverImageUrl: (challengeData as any).coverImageUrl || null,
        settlementRail: (challengeData as any).settlementRail || null,
        chainId: (challengeData as any).chainId || null,
        tokenSymbol: (challengeData as any).tokenSymbol || null,
        tokenAddress: (challengeData as any).tokenAddress || null,
        decimals: (challengeData as any).decimals || null,
        stakeAtomic: (challengeData as any).stakeAtomic || null,
        evidence: (challengeData as any).evidence || null,
      } as any);

      console.log('Inserting challenge with values:', insertValues);
      const [created] = await this.db.insert(challenges).values(insertValues).returning();
      return created;
    } catch (error: any) {
      console.error('Error in createAdminChallenge:', error);
      console.error('Error details:', {
        message: error?.message,
        code: error?.code,
        detail: error?.detail,
      });
      throw error;
    }
  }

  async getPublicAdminChallenges(limit = 10): Promise<any[]> {
    const includeChallengeSideColumns = await this.supportsChallengeSideColumns();
    const challengesList = await this.db
      .select({
        id: challenges.id,
        challenger: challenges.challenger,
        challenged: challenges.challenged,
        challengedWalletAddress: challenges.challengedWalletAddress,
        creatorType: challenges.creatorType,
        challengerType: challenges.challengerType,
        challengedType: challenges.challengedType,
        creatorAgentId: challenges.creatorAgentId,
        challengerAgentId: challenges.challengerAgentId,
        challengedAgentId: challenges.challengedAgentId,
        createdByAgent: challenges.createdByAgent,
        agentInvolved: challenges.agentInvolved,
        title: challenges.title,
        description: challenges.description,
        category: challenges.category,
        amount: challenges.amount,
        ...this.getChallengeSideSelects(includeChallengeSideColumns),
        status: challenges.status,
        evidence: challenges.evidence,
        result: challenges.result,
        dueDate: challenges.dueDate,
        createdAt: challenges.createdAt,
        completedAt: challenges.completedAt,
        adminCreated: challenges.adminCreated,
        settlementRail: challenges.settlementRail,
        chainId: challenges.chainId,
        tokenSymbol: challenges.tokenSymbol,
        tokenAddress: challenges.tokenAddress,
        decimals: challenges.decimals,
        stakeAtomic: challenges.stakeAtomic,
        escrowTxHash: challenges.escrowTxHash,
        settleTxHash: challenges.settleTxHash,
        bonusSide: challenges.bonusSide,
        bonusMultiplier: challenges.bonusMultiplier,
        bonusEndsAt: challenges.bonusEndsAt,
        bonusAmount: challenges.bonusAmount,
        yesStakeTotal: challenges.yesStakeTotal,
        noStakeTotal: challenges.noStakeTotal,
        coverImageUrl: challenges.coverImageUrl,
        earlyBirdSlots: challenges.earlyBirdSlots,
        earlyBirdBonus: challenges.earlyBirdBonus,
        streakBonusEnabled: challenges.streakBonusEnabled,
        convictionBonusEnabled: challenges.convictionBonusEnabled,
        firstTimeBonusEnabled: challenges.firstTimeBonusEnabled,
        socialTagBonus: challenges.socialTagBonus,
        isPinned: challenges.isPinned,
        challengerUser: {
          id: sql`challenger_user.id`,
          username: sql`challenger_user.username`,
          firstName: sql`challenger_user.first_name`,
          lastName: sql`challenger_user.last_name`,
          profileImageUrl: sql`challenger_user.profile_image_url`,
        },
        challengedUser: {
          id: sql`challenged_user.id`,
          username: sql`challenged_user.username`,
          firstName: sql`challenged_user.first_name`,
          lastName: sql`challenged_user.last_name`,
          profileImageUrl: sql`challenged_user.profile_image_url`,
        },
        commentCount: count(challengeMessages.id),
      })
      .from(challenges)
      .leftJoin(sql`users challenger_user`, eq(challenges.challenger, sql`challenger_user.id`))
      .leftJoin(sql`users challenged_user`, eq(challenges.challenged, sql`challenged_user.id`))
      .leftJoin(challengeMessages, eq(challenges.id, challengeMessages.challengeId))
      .where(and(eq(challenges.adminCreated, true), ne(challenges.status, "draft")))
      .groupBy(
        challenges.id,
        sql`challenger_user.id`,
        sql`challenger_user.username`,
        sql`challenger_user.first_name`,
        sql`challenger_user.last_name`,
        sql`challenger_user.profile_image_url`,
        sql`challenged_user.id`,
        sql`challenged_user.username`,
        sql`challenged_user.first_name`,
        sql`challenged_user.last_name`,
        sql`challenged_user.profile_image_url`
      )
      .orderBy(desc(challenges.isPinned), desc(challenges.createdAt))
      .limit(limit) as any;

    const challengeIds = this.normalizeChallengeIds(challengesList.map((challenge: any) => challenge.id));
    const participantMetaMap = await this.getAdminChallengeParticipantMetaMap(challengeIds);

    const challengesWithCounts = challengesList.map((challenge: any) => {
      const challengeId = Number(challenge.id);
      const participantMeta = participantMetaMap.get(challengeId);

      return {
        ...challenge,
        status: this.normalizeP2PChallengeStatus(
          challenge.status,
          challenge.adminCreated,
          challenge.challenged,
          (challenge as any).challengedWalletAddress,
        ),
        commentCount: Number(challenge.commentCount || 0),
        participantCount: Number(participantMeta?.participantCount || 0),
        participantPreviewUsers: participantMeta?.participantPreviewUsers || [],
      };
    });

    return challengesWithCounts;
  }

  async updateChallenge(id: number, updates: Partial<Challenge>): Promise<Challenge> {
    const sanitizedUpdates = await this.sanitizeChallengeSideFields(updates as Record<string, any>);
    const [challenge] = await this.db
      .update(challenges)
      .set(sanitizedUpdates)
      .where(eq(challenges.id, id))
      .returning();
    return challenge;
  }

  async recordChallengeEscrowHold(challengeId: number, amount: number): Promise<void> {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const existing = await this.db
      .select({ id: escrow.id })
      .from(escrow)
      .where(eq(escrow.challengeId, challengeId))
      .limit(1);

    if (existing.length > 0) return;

    await this.db.insert(escrow).values({
      challengeId,
      amount: amount.toString(),
      status: "holding",
    });
  }

  async acceptChallenge(challengeId: number, userId: string): Promise<Challenge> {
    const challenge = await this.getChallengeById(challengeId);
    if (!challenge) {
      throw new Error("Challenge not found");
    }

    const challengeAmount = parseFloat(challenge.amount);
    const isOnchainChallenge = String(challenge.settlementRail || "").toLowerCase() === "onchain";

    if (!isOnchainChallenge) {
      const userBalance = await this.getUserBalance(userId);
      if (userBalance.balance < challengeAmount) {
        throw new Error("Insufficient balance to accept challenge");
      }
    }

    // CASE 1: USER-CREATED OPEN CHALLENGE (no designated challenged user yet)
    // Supports legacy statuses where open challenges were saved as "pending".
    if (!challenge.adminCreated && !challenge.challenged && (challenge.status === 'open' || challenge.status === 'pending')) {
      if (challenge.challenger === userId) {
        throw new Error("You cannot accept your own challenge");
      }

      if (!isOnchainChallenge) {
        await this.createTransaction({
          userId: userId,
          type: 'challenge_escrow',
          amount: `-${challengeAmount}`,
          description: `Challenge escrow: ${challenge.title}`,
          relatedId: challengeId,
          status: 'completed',
        });
      }

      await this.db.insert(escrow).values({
        challengeId: challengeId,
        amount: challengeAmount.toString(),
        status: 'holding',
      });

      const challengedSide =
        challenge.challengerSide === 'YES'
          ? 'NO'
          : challenge.challengerSide === 'NO'
            ? 'YES'
            : null;

      const [updatedChallenge] = await this.db
        .update(challenges)
        .set(await this.sanitizeChallengeSideFields({
          challenged: userId,
          status: 'active',
          challengedSide,
        }))
        .where(eq(challenges.id, challengeId))
        .returning();

      return updatedChallenge;
    }

    // CASE 2: DIRECT CHALLENGE (Specific opponent designated)
    // Allow both "pending" and "open" to cover older records.
    if ((challenge.status === 'pending' || challenge.status === 'open') && challenge.challenged === userId) {
      if (!isOnchainChallenge) {
        await this.createTransaction({
          userId: userId,
          type: 'challenge_escrow',
          amount: `-${challengeAmount}`,
          description: `Challenge escrow: ${challenge.title}`,
          relatedId: challengeId,
          status: 'completed',
        });
      }

      await this.db.insert(escrow).values({
        challengeId: challengeId,
        amount: challengeAmount.toString(),
        status: 'holding',
      });

      const challengedSide =
        challenge.challengerSide === 'YES'
          ? 'NO'
          : challenge.challengerSide === 'NO'
            ? 'YES'
            : null;

      const [updatedChallenge] = await this.db
        .update(challenges)
        .set(await this.sanitizeChallengeSideFields({
          status: 'active',
          challengedSide,
        }))
        .where(eq(challenges.id, challengeId))
        .returning();

      return updatedChallenge;
    }

    // Invalid state
    throw new Error("Challenge cannot be accepted in this state");
  }

  async getChallengeMessages(challengeId: number): Promise<(ChallengeMessage & { user: User })[]> {
    return await this.db
      .select({
        id: challengeMessages.id,
        challengeId: challengeMessages.challengeId,
        userId: challengeMessages.userId,
        message: challengeMessages.message,
        createdAt: challengeMessages.createdAt,
        user: users,
      })
      .from(challengeMessages)
      .innerJoin(users, eq(challengeMessages.userId, users.id))
      .where(eq(challengeMessages.challengeId, challengeId))
      .orderBy(challengeMessages.createdAt);
  }

  async createChallengeMessage(challengeId: number, userId: string, message: string): Promise<ChallengeMessage> {
    const [newMessage] = await this.db
      .insert(challengeMessages)
      .values({ challengeId, userId, message })
      .returning();
    return newMessage;
  }

  // Admin challenge operations
  async getAllChallenges(limit = 50): Promise<(Challenge & { challengerUser?: User, challengedUser?: User })[]> {
    const includeChallengeSideColumns = await this.supportsChallengeSideColumns();
    return await this.db
      .select({
        id: challenges.id,
        challenger: challenges.challenger,
        challenged: challenges.challenged,
        challengedWalletAddress: challenges.challengedWalletAddress,
        creatorType: challenges.creatorType,
        challengerType: challenges.challengerType,
        challengedType: challenges.challengedType,
        creatorAgentId: challenges.creatorAgentId,
        challengerAgentId: challenges.challengerAgentId,
        challengedAgentId: challenges.challengedAgentId,
        createdByAgent: challenges.createdByAgent,
        agentInvolved: challenges.agentInvolved,
        title: challenges.title,
        description: challenges.description,
        category: challenges.category,
        amount: challenges.amount,
        ...this.getChallengeSideSelects(includeChallengeSideColumns),
        status: challenges.status,
        evidence: challenges.evidence,
        result: challenges.result,
        dueDate: challenges.dueDate,
        createdAt: challenges.createdAt,
        completedAt: challenges.completedAt,
        adminCreated: challenges.adminCreated,
        bonusSide: challenges.bonusSide,
        bonusMultiplier: challenges.bonusMultiplier,
        bonusEndsAt: challenges.bonusEndsAt,
        yesStakeTotal: challenges.yesStakeTotal,
        noStakeTotal: challenges.noStakeTotal,
        coverImageUrl: challenges.coverImageUrl,
        challengerUser: {
          id: sql`challenger_user.id`,
          username: sql`challenger_user.username`,
          firstName: sql`challenger_user.first_name`,
          lastName: sql`challenger_user.last_name`,
          profileImageUrl: sql`challenger_user.profile_image_url`,
        },
        challengedUser: {
          id: sql`challenged_user.id`,
          username: sql`challenged_user.username`,
          firstName: sql`challenged_user.first_name`,
          lastName: sql`challenged_user.last_name`,
          profileImageUrl: sql`challenged_user.profile_image_url`,
        },
      })
      .from(challenges)
      .leftJoin(sql`users challenger_user`, eq(challenges.challenger, sql`challenger_user.id`))
      .leftJoin(sql`users challenged_user`, eq(challenges.challenged, sql`challenged_user.id`))
      .where(ne(challenges.status, "draft"))
      .orderBy(desc(challenges.createdAt))
      .limit(limit) as any;
  }

  async adminSetChallengeResult(challengeId: number, result: 'challenger_won' | 'challenged_won' | 'draw'): Promise<Challenge> {
    const [challenge] = await this.db
      .update(challenges)
      .set({ 
        result: result,
        status: 'completed',
        completedAt: new Date() 
      })
      .where(eq(challenges.id, challengeId))
      .returning();
    return challenge;
  }

  async processChallengePayouts(challengeId: number): Promise<{ winnerPayout: number; platformFee: number; winnerId?: string }> {
    const challenge = await this.getChallengeById(challengeId);
    if (!challenge || challenge.status !== 'completed' || !challenge.result) {
      throw new Error('Challenge not ready for payout');
    }

    const stakePerSide = parseFloat(String(challenge.amount || '0'));
    const totalAmount = stakePerSide * 2; // Both participants contributed
    const platformFee = calculateLoserSideChallengeFee(stakePerSide);
    let winnerPayout = totalAmount - platformFee;

    // Apply bonus multiplier if active and winner matches bonus side
    const bonusMultiplier = challenge.bonusMultiplier ? parseFloat(challenge.bonusMultiplier) : 1.0;
    const now = new Date();
    const isBonusActive = challenge.bonusEndsAt && new Date(challenge.bonusEndsAt) > now;

    let winnerId: string | undefined;

    if (challenge.result === 'challenger_won') {
      winnerId = challenge.challenger!;
      // Apply bonus if challenger wins and YES side (CHALLENGER) has bonus
      if (isBonusActive && challenge.bonusSide === 'YES' && bonusMultiplier > 1.0) {
        const bonusAmountValue = winnerPayout * (bonusMultiplier - 1.0);
        winnerPayout = winnerPayout * bonusMultiplier;
        
        // Deduct bonus from admin wallet
        await this.db.update(users)
          .set({ 
            adminWalletBalance: sql`${users.adminWalletBalance} - ${bonusAmountValue}`,
            adminTotalBonusesGiven: sql`${users.adminTotalBonusesGiven} + ${bonusAmountValue}`
          })
          .where(eq(users.isAdmin, true)); // Apply to platform admin wallet

        // Create notification for winner about the bonus
        await this.createNotification({
          userId: winnerId,
          type: 'bonus_payout',
          title: '🔥 Bonus Payout!',
          message: `You earned an extra ₦${bonusAmountValue.toLocaleString()} bonus for your ${challenge.bonusSide} win!`,
          data: { challengeId: challenge.id, bonusAmount: bonusAmountValue },
        });
      }
    } else if (challenge.result === 'challenged_won') {
      winnerId = challenge.challenged!;
      // Apply bonus if challenged wins and NO side (CHALLENGED) has bonus
      if (isBonusActive && challenge.bonusSide === 'NO' && bonusMultiplier > 1.0) {
        const bonusAmountValue = winnerPayout * (bonusMultiplier - 1.0);
        winnerPayout = winnerPayout * bonusMultiplier;

        // Deduct bonus from admin wallet
        await this.db.update(users)
          .set({ 
            adminWalletBalance: sql`${users.adminWalletBalance} - ${bonusAmountValue}`,
            adminTotalBonusesGiven: sql`${users.adminTotalBonusesGiven} + ${bonusAmountValue}`
          })
          .where(eq(users.isAdmin, true));

        // Create notification for winner about the bonus
        await this.createNotification({
          userId: winnerId,
          type: 'bonus_payout',
          title: '🔥 Bonus Payout!',
          message: `You earned an extra ₦${bonusAmountValue.toLocaleString()} bonus for your ${challenge.bonusSide} win!`,
          data: { challengeId: challenge.id, bonusAmount: bonusAmountValue },
        });
      }
    } else if (challenge.result === 'draw') {
      // In case of draw, return money to both participants
      const halfAmount = parseFloat(String(challenge.amount || '0'));
      await this.updateUserBalance(challenge.challenger!, halfAmount);
      await this.updateUserBalance(challenge.challenged!, halfAmount);

      // Create transactions for both
      await this.createTransaction({
        userId: challenge.challenger!,
        type: 'challenge_draw',
        amount: halfAmount.toString(),
        description: `Draw in challenge: ${challenge.title}`,
        status: 'completed',
        reference: `challenge_${challengeId}_draw_challenger`,
      });

      await this.createTransaction({
        userId: challenge.challenged!,
        type: 'challenge_draw',
        amount: halfAmount.toString(),
        description: `Draw in challenge: ${challenge.title}`,
        status: 'completed',
        reference: `challenge_${challengeId}_draw_challenged`,
      });

      // Send notifications
      await this.createNotification({
        userId: challenge.challenger!,
        type: 'challenge_draw',
        title: 'Challenge Draw',
        message: `Challenge "${challenge.title}" ended in a draw. Your stake has been returned.`,
        data: { challengeId: challengeId, result: 'draw' },
      });

      await this.createNotification({
        userId: challenge.challenged!,
        type: 'challenge_draw',
        title: 'Challenge Draw',
        message: `Challenge "${challenge.title}" ended in a draw. Your stake has been returned.`,
        data: { challengeId: challengeId, result: 'draw' },
      });

      // Refund bonus to admin (no winner to use it)
      await this.refundBonusToAdmin(challengeId, challenge, 'draw');

      return { winnerPayout: halfAmount * 2, platformFee: 0, winnerId: undefined };
    }

    if (winnerId) {
      // Update winner's balance
      await this.updateUserBalance(winnerId, winnerPayout);

      // Create transaction record
      await this.createTransaction({
        userId: winnerId,
        type: 'challenge_win',
        amount: winnerPayout.toString(),
        description: `Won challenge: ${challenge.title}`,
        status: 'completed',
        reference: `challenge_${challengeId}_win`,
      });

      // Send notifications to both participants
      const winner = await this.getUser(winnerId);
      const loser = winnerId === challenge.challenger ? challenge.challenged : challenge.challenger;

      // Calculate base payout and bonus amount for notification
      const basePayout = totalAmount - platformFee;
      const bonusApplied = isBonusActive && challenge.bonusSide && bonusMultiplier > 1.0;
      let bonusAmount = 0;
      let bonusMessage = '';

      if (bonusApplied) {
        let winnerSide = null;
        if (challenge.result === 'challenger_won') {
          winnerSide = 'CHALLENGER';
        } else if (challenge.result === 'challenged_won') {
          winnerSide = 'CHALLENGED';
        }
        const bonusSideMapping = challenge.bonusSide === 'YES' ? 'CHALLENGER' : 'CHALLENGED';
        if (winnerSide === bonusSideMapping) {
          bonusAmount = winnerPayout - basePayout;
          bonusMessage = ` including a ₦${Math.round(bonusAmount).toLocaleString()} bonus multiplier (${bonusMultiplier}x)!`;
        }
      }

      await this.createNotification({
        userId: winnerId,
        type: 'challenge_win',
        title: '🏆 Challenge Won!',
        message: `Congratulations! You won ₦${winnerPayout.toLocaleString()} from challenge "${challenge.title}"${bonusMessage}`,
        data: { 
          challengeId: challengeId, 
          result: challenge.result, 
          winnings: winnerPayout,
          basePayout: Math.round(basePayout),
          bonusAmount: Math.round(bonusAmount),
          bonusMultiplier: bonusMultiplier,
          bonusApplied: bonusApplied
        },
      });

      await this.createNotification({
        userId: loser!,
        type: 'challenge_loss',
        title: 'Challenge Result',
        message: `Challenge "${challenge.title}" has been resolved. Better luck next time!`,
        data: { challengeId: challengeId, result: challenge.result },
      });
    }

    // Award admin commission from the losing side only
    const adminCommission = platformFee;
    const admin = await this.db.query.users.findFirst({
      where: (users, { eq }) => eq(users.role, 'admin'),
    });

    if (admin && adminCommission > 0) {
      const currentBalance = parseFloat(String(admin.adminWalletBalance || '0'));
      const newBalance = currentBalance + adminCommission;

      // Update admin wallet balance
      await this.db
        .update(users)
        .set({ 
          adminWalletBalance: newBalance.toString(),
          adminTotalCommission: (parseFloat(String(admin.adminTotalCommission || '0')) + adminCommission).toString()
        })
        .where(eq(users.id, admin.id));

      // Log commission transaction
      await this.db.insert(adminWalletTransactions).values({
        adminId: admin.id,
        type: 'commission_earned',
        amount: adminCommission.toString(),
        description: `Loser-side commission from challenge: ${challenge.title}`,
        reference: `challenge_${challengeId}_commission`,
        status: 'completed',
        balanceBefore: currentBalance.toString(),
        balanceAfter: newBalance.toString(),
      });
    }

    return { winnerPayout, platformFee, winnerId };
  }

  async activateChallengeBonus(challengeId: number, bonusData: { bonusSide: string; bonusMultiplier: string; bonusAmount: number; bonusEndsAt: Date }): Promise<Challenge> {
    const [updatedChallenge] = await this.db
      .update(challenges)
      .set({
        bonusSide: bonusData.bonusSide,
        bonusMultiplier: bonusData.bonusMultiplier,
        bonusAmount: bonusData.bonusAmount,
        bonusEndsAt: bonusData.bonusEndsAt,
      })
      .where(eq(challenges.id, challengeId))
      .returning();

    if (!updatedChallenge) {
      throw new Error('Challenge not found');
    }

    return updatedChallenge;
  }

  // Refund bonus to admin if challenge expires, is cancelled, or ends in draw
  async refundBonusToAdmin(challengeId: number, challenge: Challenge, reason: 'expired' | 'cancelled' | 'draw'): Promise<void> {
    try {
      // Check if challenge has an active bonus
      if (!challenge.bonusAmount || challenge.bonusAmount === 0) {
        console.log(`No bonus to refund for challenge ${challengeId}`);
        return;
      }

      const bonusAmount = parseFloat(String(challenge.bonusAmount));
      
      // Find admin user
      const admin = await this.db.query.users.findFirst({
        where: (users, { eq }) => eq(users.role, 'admin'),
      });

      if (!admin) {
        console.error('Admin user not found for bonus refund');
        return;
      }

      // Refund bonus to admin wallet
      const currentBalance = parseFloat(String(admin.adminWalletBalance || '0'));
      const newBalance = currentBalance + bonusAmount;

      await this.db
        .update(users)
        .set({ adminWalletBalance: newBalance.toString() })
        .where(eq(users.id, admin.id));

      // Log refund transaction
      const reasonMessage = {
        'expired': 'Challenge expired without completion',
        'cancelled': 'Challenge cancelled by admin',
        'draw': 'Challenge ended in a draw - bonus unused'
      }[reason] || 'Bonus refunded';

      await this.db.insert(adminWalletTransactions).values({
        adminId: admin.id,
        type: 'bonus_refund',
        amount: bonusAmount.toString(),
        description: `Bonus refund for challenge: ${challenge.title} (${reasonMessage})`,
        reference: `challenge_${challengeId}_bonus_refund_${reason}`,
        status: 'completed',
        balanceBefore: currentBalance.toString(),
        balanceAfter: newBalance.toString(),
      });

      console.log(`✅ Bonus refunded for challenge ${challengeId}: ₦${bonusAmount} (reason: ${reason})`);
    } catch (error) {
      console.error(`Error refunding bonus for challenge ${challengeId}:`, error);
      // Don't throw - log error but continue processing
    }
  }

  async joinAdminChallenge(challengeId: number, userId: string, stake: 'YES' | 'NO'): Promise<Challenge> {
    try {
      const challenge = await this.getChallengeById(challengeId);
      if (!challenge) {
        throw new Error('Challenge not found');
      }

      // Admin challenges must be in 'open' status to join
      if (challenge.status !== 'open' || !challenge.adminCreated) {
        throw new Error('Challenge is not available to join');
      }

      // Check user balance
      const balance = await this.getUserBalance(userId);
      const challengeAmount = parseFloat(String(challenge.amount || '0'));

      if (balance.balance < challengeAmount) {
        throw new Error('Insufficient balance to join challenge');
      }

      // Prevent same user from occupying both sides.
      if (challenge.challenger === userId || challenge.challenged === userId) {
        throw new Error('You have already joined this challenge');
      }

      // Deduct stake from user
      await this.createTransaction({
        userId: userId,
        type: 'challenge_escrow',
        amount: `-${challengeAmount}`,
        description: `Admin challenge stake: ${challenge.title}`,
        relatedId: challengeId,
        status: 'completed',
      });

      // Add to escrow
      await this.db.insert(escrow).values({
        challengeId: challengeId,
        amount: Math.floor(challengeAmount),
        status: 'holding',
      });

      // Update challenge stake totals and participant info
      const updateData: any = {};
      
      if (stake === 'YES') {
        updateData.yesStakeTotal = (challenge.yesStakeTotal || 0) + challengeAmount;
      } else {
        updateData.noStakeTotal = (challenge.noStakeTotal || 0) + challengeAmount;
      }

      // Set challenger/challenged based on first vs second joiner.
      // Persist the exact side choice so UI and settlement logic can rely on backend truth.
      if (!challenge.challenger) {
        // First joiner becomes challenger on the chosen side.
        updateData.challenger = userId;
        updateData.challengerSide = stake;
      } else if (!challenge.challenged) {
        // If first side is known, second user must take opposite side.
        if (challenge.challengerSide && challenge.challengerSide === stake) {
          throw new Error(`This side is already taken by the creator. Please choose ${challenge.challengerSide === 'YES' ? 'NO' : 'YES'}`);
        }

        // Second joiner becomes challenged on the chosen/opposite side.
        updateData.challenged = userId;
        updateData.challengedSide = stake;
        updateData.status = 'active'; // Activate challenge when both have joined
      } else {
        throw new Error('Challenge is full - already has 2 participants');
      }

      const [updatedChallenge] = await this.db
        .update(challenges)
        .set(await this.sanitizeChallengeSideFields(updateData))
        .where(eq(challenges.id, challengeId))
        .returning();

      return updatedChallenge;
    } catch (error) {
      console.error(`Error joining admin challenge ${challengeId} for user ${userId}:`, error);
      throw error;
    }
  }

  async getChallengeEscrowStatus(challengeId: number): Promise<{ totalEscrow: number; status: string } | null> {
    const [escrowData] = await this.db
      .select({
        totalEscrow: sql<number>`COALESCE(SUM(CAST(${escrow.amount} AS DECIMAL)), 0)`,
        status: escrow.status,
      })
      .from(escrow)
      .where(eq(escrow.challengeId, challengeId))
      .groupBy(escrow.status);

    return escrowData || null;
  }

  async getAllEscrowData(limit = 100): Promise<(Challenge & { totalEscrow: number; escrowCount: number })[]> {
    const results = await this.db
      .select({
        challenge: challenges,
        totalEscrow: sql<number>`COALESCE(SUM(CAST(${escrow.amount} AS DECIMAL)), 0)`,
        escrowCount: count(escrow.id),
      })
      .from(challenges)
      .leftJoin(escrow, eq(challenges.id, escrow.challengeId))
      .where(sql`${escrow.id} IS NOT NULL`)
      .groupBy(challenges.id)
      .orderBy(desc(challenges.createdAt))
      .limit(limit);

    return results.map((r: any) => ({
      ...r.challenge,
      totalEscrow: Number(r.totalEscrow),
      escrowCount: Number(r.escrowCount),
    }));
  }

  async getEscrowStats(): Promise<{ totalEscrow: number; pendingChallenges: number; holdingAmount: number; releasedAmount: number; refundedAmount: number }> {
    const stats = await this.db
      .select({
        totalEscrow: sql<number>`COALESCE(SUM(CAST(${escrow.amount} AS DECIMAL)), 0)`,
        holdingAmount: sql<number>`COALESCE(SUM(CASE WHEN ${escrow.status} = 'holding' THEN CAST(${escrow.amount} AS DECIMAL) ELSE 0 END), 0)`,
        releasedAmount: sql<number>`COALESCE(SUM(CASE WHEN ${escrow.status} = 'released' THEN CAST(${escrow.amount} AS DECIMAL) ELSE 0 END), 0)`,
        refundedAmount: sql<number>`COALESCE(SUM(CASE WHEN ${escrow.status} = 'refunded' THEN CAST(${escrow.amount} AS DECIMAL) ELSE 0 END), 0)`,
        pendingChallenges: count(sql`DISTINCT ${escrow.challengeId}`),
      })
      .from(escrow);

    const [result] = stats;
    return {
      totalEscrow: Number(result?.totalEscrow) || 0,
      holdingAmount: Number(result?.holdingAmount) || 0,
      releasedAmount: Number(result?.releasedAmount) || 0,
      refundedAmount: Number(result?.refundedAmount) || 0,
      pendingChallenges: Number(result?.pendingChallenges) || 0,
    };
  }

  async getDetailedEscrowData(challengeId: number): Promise<any> {
    const escrowRecords = await this.db
      .select({
        escrow,
        challenge: challenges,
        challenger: users,
      })
      .from(escrow)
      .leftJoin(challenges, eq(escrow.challengeId, challenges.id))
      .leftJoin(users, eq(challenges.challengerId, users.id))
      .where(eq(escrow.challengeId, challengeId))
      .orderBy(desc(escrow.createdAt));

    return escrowRecords.map((r: any) => ({
      ...r.escrow,
      challengeTitle: r.challenge?.title,
      challengeStatus: r.challenge?.status,
      challengerUsername: r.challenger?.username,
      challengerName: r.challenger?.firstName ? `${r.challenger.firstName} ${r.challenger.lastName || ''}`.trim() : 'Unknown',
    }));
  }

  // Friend operations
  async getFriends(userId: string): Promise<(Friend & { requester: User, addressee: User })[]> {
    const friendList = await this.db
      .select({
        friend: friends,
        requester: users,
        addressee: users,
      })
      .from(friends)
      .leftJoin(users, eq(friends.requesterId, users.id))
      .leftJoin(users, eq(friends.addresseeId, users.id))
      .where(
        and(
          or(eq(friends.requesterId, userId), eq(friends.addresseeId, userId)),
          eq(friends.status, "accepted")
        )
      );

    return friendList.map((f: any) => ({
      ...f.friend,
      requester: f.requester,
      addressee: f.addressee,
    }));
  }

  async sendFriendRequest(requesterId: string, addresseeId: string): Promise<Friend> {
    const [existing] = await this.db
      .select()
      .from(friends)
      .where(
        or(
          and(eq(friends.requesterId, requesterId), eq(friends.addresseeId, addresseeId)),
          and(eq(friends.requesterId, addresseeId), eq(friends.addresseeId, requesterId))
        )
      )
      .limit(1);

    if (existing) {
      return existing;
    }

    const [request] = await this.db
      .insert(friends)
      .values({
        requesterId,
        addresseeId,
        status: "pending",
      })
      .returning();

      // Create notification for the addressee
      const requester = await this.getUser(requesterId);
      await this.createNotification({
        id: nanoid(),
        userId: addresseeId,
        type: "friend_request",
        title: "New Friend Request",
        message: `${requester?.username || "Someone"} sent you a friend request.`,
        icon: "👋",
        data: { requesterId, friendRequestId: request.id },
        channels: ["in_app_feed"],
        fomoLevel: "medium",
        priority: 2,
      } as any);

    return request;
  }

  async acceptFriendRequest(id: number): Promise<Friend> {
    const [request] = await this.db
      .update(friends)
      .set({
        status: "accepted",
        acceptedAt: new Date(),
      })
      .where(eq(friends.id, id))
      .returning();

    if (request) {
      // Create notification for the requester
      const addressee = await this.getUser(request.addresseeId);
      await this.createNotification({
        id: nanoid(),
        userId: request.requesterId,
        type: "friend_accepted",
        title: "Friend Request Accepted",
        message: `${addressee?.username || "Someone"} accepted your friend request!`,
        icon: "✨",
        data: { friendId: request.addresseeId },
        channels: ["in_app_feed"],
        fomoLevel: "medium",
        priority: 2,
      } as any);
    }

    return request;
  }

  async toggleFollow(followerId: string, followingId: string): Promise<{ action: 'followed' | 'unfollowed' }> {
    // Check if follow relationship exists (either pending or accepted)
    const [existingFollow] = await this.db
      .select()
      .from(friends)
      .where(
        and(
          eq(friends.requesterId, followerId),
          eq(friends.addresseeId, followingId)
        )
      );

    if (existingFollow) {
      // Unfollow: Delete the relationship
      await this.db
        .delete(friends)
        .where(eq(friends.id, existingFollow.id));
      return { action: 'unfollowed' };
    } else {
      // Follow: Create new relationship (auto-accepted for follow system)
      // Double check again within the transaction context (or just use try-catch/unique constraint)
      try {
        await this.db
          .insert(friends)
          .values({
            requesterId: followerId,
            addresseeId: followingId,
            status: 'accepted',
            acceptedAt: new Date()
          });
        return { action: 'followed' };
      } catch (error) {
        // If it already exists (race condition), just return followed
        return { action: 'followed' };
      }
    }
  }

  // Notification operations
  async getNotifications(userId: string, limit = 20): Promise<Notification[]> {
    return await this.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async createNotification(notification: InsertNotification): Promise<Notification> {
    // Generate notification ID if not provided
    const notificationWithId = {
      ...notification,
      id: notification.id || `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
    
    const [newNotification] = await this.db
      .insert(notifications)
      .values(notificationWithId)
      .returning();
    return newNotification;
  }

  async markNotificationRead(id: string): Promise<Notification> {
    const [notification] = await this.db
      .update(notifications)
      .set({ read: true })
      .where(eq(notifications.id, id))
      .returning();
    return notification;
  }

  // Transaction operations
  async getTransactions(userId: string, limit = 20): Promise<Transaction[]> {
    return await this.db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .orderBy(desc(transactions.createdAt))
      .limit(limit);
  }

  async getUserBalance(userId: string): Promise<{ balance: number; coins: number; points: number; usdcEarned: number }> {
    try {
      // Get user's current coins and BantCredit from users table
      const user = await this.db
        .select({ coins: users.coins, points: users.points })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const currentCoins = user[0]?.coins || 0;
      const currentPoints = user[0]?.points || 0;

      // Calculate Naira balance from transactions
      const userTransactions = await this.db
        .select()
        .from(transactions)
        .where(eq(transactions.userId, userId));

      console.log(`All transactions for user ${userId}:`, userTransactions.map(t => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        status: t.status,
        description: t.description,
        createdAt: t.createdAt
      })));

      let balance = 0;
      const completedTransactions = userTransactions.filter(t => t.status === 'completed');

      console.log(`Completed transactions for user ${userId}:`, completedTransactions.map(t => ({
        type: t.type,
        amount: t.amount,
        parsedAmount: parseFloat(t.amount)
      })));

      for (const transaction of completedTransactions) {
        const amount = parseFloat(transaction.amount);
        if (!isNaN(amount)) {
          balance += amount;
          console.log(`Added ${amount} to balance, new total: ${balance}`);
        } else {
          console.warn(`Invalid amount in transaction ${transaction.id}: ${transaction.amount}`);
        }
      }

        console.log(`Balance calculation for user ${userId}:`, {
          totalTransactions: userTransactions.length,
          completedTransactions: userTransactions.filter(t => t.status === 'completed').length,
          calculatedBalance: balance,
          currentCoins,
          currentPoints
        });

        const claims = await this.db
          .select()
          .from(userRewardsClaims)
          .where(eq(userRewardsClaims.userId, userId));
        
        const usdcEarned = claims.reduce((acc, claim) => acc + Number(claim.amountUsdc || 0), 0);

        const result = { 
          balance: Math.max(0, balance), // Ensure balance is never negative
          coins: currentCoins,
          points: currentPoints,
          usdcEarned: Math.max(0, usdcEarned)
        };

      console.log(`Returning balance result:`, result);
      return result;
    } catch (error) {
      console.error("Error getting user balance:", error);
      return { balance: 0, coins: 0, points: 0, usdcEarned: 0 };
    }
  }

  async updateUserBalance(userId: string, amount: number): Promise<User> {
    const [user] = await this.db
      .update(users)
      .set({
        balance: sql`${users.balance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async createTransaction(transaction: InsertTransaction & { reference?: string }): Promise<Transaction> {
    console.log('Creating transaction:', {
      userId: transaction.userId,
      type: transaction.type,
      amount: transaction.amount,
      description: transaction.description,
      reference: (transaction as any).reference
    });

    try {
      // Build insert data without unknown properties such as `reference`
      const insertData: any = {
        userId: transaction.userId,
        type: transaction.type,
        amount: transaction.amount,
        description: transaction.description,
        relatedId: (transaction as any).relatedId,
        status: (transaction as any).status,
      };

      // If reference was provided, append to description for traceability
      if ((transaction as any).reference) {
        insertData.description = `${insertData.description || ''} (ref: ${(transaction as any).reference})`;
      }

      const [newTransaction] = await this.db
        .insert(transactions)
        .values(insertData)
        .returning();

      console.log('Transaction created successfully:', newTransaction);

      // If transaction is completed and affects balance, update stored user balance atomically
      try {
        const parsedAmount = parseFloat(String(newTransaction.amount));
        if (!isNaN(parsedAmount) && newTransaction.status === 'completed') {
          // Update user balance by the transaction amount (amount may be negative for debits)
          await this.updateUserBalance(newTransaction.userId, parsedAmount);
          console.log(`Updated user balance for ${newTransaction.userId} by ${parsedAmount}`);
        }
      } catch (balanceError) {
        console.error('Error updating user balance after transaction:', balanceError);
      }

      return newTransaction;
    } catch (error) {
      console.error('Error creating transaction:', error);
      throw error;
    }
  }

  // Achievement operations
  async getAchievements(): Promise<Achievement[]> {
    return await this.db.select().from(achievements);
  }

  async getUserAchievements(userId: string): Promise<(Achievement & { unlockedAt: Date })[]> {
    return await this.db
      .select({
        id: achievements.id,
        name: achievements.name,
        description: achievements.description,
        icon: achievements.icon,
        category: achievements.category,
        xpReward: achievements.xpReward,
        pointsReward: achievements.pointsReward,
        requirement: achievements.requirement,
        createdAt: achievements.createdAt,
        unlockedAt: userAchievements.unlockedAt,
      })
      .from(userAchievements)
      .innerJoin(achievements, eq(userAchievements.achievementId, achievements.id))
      .where(eq(userAchievements.userId, userId)) as any;
  }

  async unlockAchievement(userId: string, achievementId: number): Promise<void> {
    await this.db
      .insert(userAchievements)
      .values({ userId, achievementId })
      .onConflictDoNothing();
  }

  // Leaderboard operations
  async getLeaderboard(limit = 50): Promise<(User & { rank: number; coins: number; eventsWon: number; challengesWon: number })[]> {
    const now = Date.now();
    if (this.leaderboardCache && this.leaderboardCache.expiresAt > now && this.leaderboardCache.limit >= limit) {
      return this.leaderboardCache.data.slice(0, limit);
    }

    const eventsWonSubquery = this.db
      .select({
        userId: eventParticipants.userId,
        eventsWon: sql<number>`count(*)`.as("eventsWon"),
      })
      .from(eventParticipants)
      .where(eq(eventParticipants.status, "won"))
      .groupBy(eventParticipants.userId)
      .as("events_won_subquery");

    const challengerWinsSubquery = this.db
      .select({
        userId: challenges.challenger,
        wins: sql<number>`count(*)`.as("challengerWins"),
      })
      .from(challenges)
      .where(eq(challenges.result, "challenger_won"))
      .groupBy(challenges.challenger)
      .as("challenger_wins_subquery");

    const challengedWinsSubquery = this.db
      .select({
        userId: challenges.challenged,
        wins: sql<number>`count(*)`.as("challengedWins"),
      })
      .from(challenges)
      .where(eq(challenges.result, "challenged_won"))
      .groupBy(challenges.challenged)
      .as("challenged_wins_subquery");

    const usdcEarnedSubquery = this.db
      .select({
        userId: userRewardsClaims.userId,
        usdcEarned: sql<number>`COALESCE(SUM(CAST(${userRewardsClaims.shareAmountUsdc} AS DECIMAL)), 0)`.as("usdcEarned"),
      })
      .from(userRewardsClaims)
      .groupBy(userRewardsClaims.userId)
      .as("usdc_earned_subquery");

    const result = await this.db
      .select({
        id: users.id,
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        profileImageUrl: users.profileImageUrl,
        level: users.level,
        xp: users.xp,
        points: users.points,
        balance: users.balance,
        coins: users.coins,
        rank: sql<number>`ROW_NUMBER() OVER (ORDER BY ${users.coins} DESC)`,
        eventsWon: sql<number>`COALESCE(${eventsWonSubquery.eventsWon}, 0)`,
        challengesWon: sql<number>`COALESCE(${challengerWinsSubquery.wins}, 0) + COALESCE(${challengedWinsSubquery.wins}, 0)`,
        usdcEarned: sql<number>`COALESCE(${usdcEarnedSubquery.usdcEarned}, 0)`,
      })
      .from(users)
      .leftJoin(eventsWonSubquery, eq(users.id, eventsWonSubquery.userId))
      .leftJoin(challengerWinsSubquery, eq(users.id, challengerWinsSubquery.userId))
      .leftJoin(challengedWinsSubquery, eq(users.id, challengedWinsSubquery.userId))
      .leftJoin(usdcEarnedSubquery, eq(users.id, usdcEarnedSubquery.userId))
      .where(
        and(
          eq(users.status, "active"),
          eq(users.isAdmin, false),
        ),
      )
      .orderBy(desc(users.coins))
      .limit(limit);

    const typedResult = result as (User & {
      rank: number;
      coins: number;
      eventsWon: number;
      challengesWon: number;
      usdcEarned: number;
    })[];

    this.leaderboardCache = {
      expiresAt: now + 30_000,
      limit,
      data: typedResult,
    };

    return typedResult;
  }

  // Referral operations

  async getReferrals(userId: string): Promise<any[]> {
    return await this.db
      .select({
        id: referrals.id,
        referrerId: referrals.referrerId,
        referredId: referrals.referredId,
        code: referrals.code,
        status: referrals.status,
        createdAt: referrals.createdAt,
        referredUser: {
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          username: users.username,
          profileImageUrl: users.profileImageUrl,
          createdAt: users.createdAt
        }
      })
      .from(referrals)
      .innerJoin(users, eq(referrals.referredId, users.id))
      .where(eq(referrals.referrerId, userId))
      .orderBy(desc(referrals.createdAt));
  }



  // User stats
  async getUserStats(userId: string): Promise<{
    wins: number;
    activeChallenges: number;
    friendsOnline: number;
  }> {
    // Get wins count from completed events/challenges
    const [winsResult] = await this.db
      .select({ count: count() })
      .from(challenges)
      .where(
        and(
          or(eq(challenges.challenger, userId), eq(challenges.challenged, userId)),
          eq(challenges.status, "completed"),
          or(
            and(eq(challenges.challenger, userId), eq(challenges.result, "challenger_won")),
            and(eq(challenges.challenged, userId), eq(challenges.result, "challenged_won"))
          )
        )
      );

    // Get active challenges count
    const [activeChallengesResult] = await this.db
      .select({ count: count() })
      .from(challenges)
      .where(
        and(
          or(eq(challenges.challenger, userId), eq(challenges.challenged, userId)),
          eq(challenges.status, "active")
        )
      );

    // Get friends count (simplified - would need online status tracking in real app)
    const [friendsResult] = await this.db
      .select({ count: count() })
      .from(friends)
      .where(
        and(
          or(eq(friends.requesterId, userId), eq(friends.addresseeId, userId)),
          eq(friends.status, "accepted")
        )
      );

    return {
      wins: winsResult?.count || 0,
      activeChallenges: activeChallengesResult?.count || 0,
      friendsOnline: Math.floor((friendsResult?.count || 0) * 0.35), // Simulate ~35% online
    };
  }

  // Event Pool operations
  async adminSetEventResult(eventId: number, result: boolean): Promise<Event> {
    const [event] = await this.db
      .update(events)
      .set({ 
        adminResult: result,
        result: result,
        status: 'completed',
        updatedAt: new Date() 
      })
      .where(eq(events.id, eventId))
      .returning();
    return event;
  }

  async processEventPayout(eventId: number): Promise<{ winnersCount: number; totalPayout: number; creatorFee: number }> {
    const event = await this.getEventById(eventId);
    if (!event || event.status !== 'completed' || event.adminResult === null) {
      throw new Error('Event not ready for payout');
    }

    const participants = await this.getEventParticipants(eventId);
    const winners = participants.filter(p => p.prediction === event.adminResult);

    const totalPool = parseFloat(String(event.eventPool || '0'));
    const creatorFeeAmount = totalPool * 0.03; // 3% creator fee
    const availablePayout = totalPool - creatorFeeAmount;

    if (winners.length === 0) {
      // No winners - creator gets the entire pool
      await this.updateUserBalance(event.creatorId, totalPool);
      await this.createTransaction({
        userId: event.creatorId,
        type: 'event_no_winners',
        amount: totalPool.toString(),
        description: `No winners bonus for event: ${event.title}`,
        status: 'completed',
        reference: `event_${eventId}_no_winners`,
      });

      return { winnersCount: 0, totalPayout: totalPool, creatorFee: 0 };
    }

    // Calculate individual payouts
    const totalWinnerBets = winners.reduce((sum, w) => sum + parseFloat(String(w.amount || '0')), 0);

    // Handle edge case where total winner bets exceed available payout (shouldn't happen but safety check)
    if (totalWinnerBets > availablePayout) {
      console.warn(`Event ${eventId}: Total winner bets (₦${totalWinnerBets}) exceed available payout (₦${availablePayout})`);
    }

    for (const winner of winners) {
      const winnerBet = parseFloat(String(winner.amount || '0'));
      const winnerShare = totalWinnerBets > 0 ? winnerBet / totalWinnerBets : 1 / winners.length;

      let payout;
      if (event.bettingModel === "fixed") {
        // Fixed model: equal share of the profit pool + original bet back
        const profitPool = Math.max(0, availablePayout - totalWinnerBets);
        payout = winnerBet + (profitPool / winners.length);
      } else {
        // Custom model: proportional payout
        payout = winnerBet + (Math.max(0, availablePayout - totalWinnerBets) * winnerShare);
      }

      // Ensure minimum payout is at least the original bet
      payout = Math.max(payout, winnerBet);

      // Update participant with payout info
      await this.db
        .update(eventParticipants)
        .set({ 
          status: 'won',
          payout: payout,
          payoutAt: new Date()
        })
        .where(eq(eventParticipants.id, winner.id));

      // Update user balance
      await this.updateUserBalance(winner.userId, payout);

      // Create transaction record
      await this.createTransaction({
        userId: winner.userId,
        type: 'event_win',
        amount: payout.toString(),
        description: `Won event: ${event.title}`,
        status: 'completed',
        reference: `event_${eventId}_win_${winner.id}`,
      });
    }

    // Mark losers
    const losers = participants.filter(p => p.prediction !== event.adminResult);
    for (const loser of losers) {
      await this.db
        .update(eventParticipants)
        .set({ status: 'lost' })
        .where(eq(eventParticipants.id, loser.id));
    }

    // Pay creator fee
    await this.updateUserBalance(event.creatorId, creatorFeeAmount);
    await this.createTransaction({
      userId: event.creatorId,
      type: 'creator_fee',
      amount: creatorFeeAmount.toString(),
      description: `Creator fee for event: ${event.title}`,
      status: 'completed',
      reference: `event_${eventId}_creator_fee`,
    });

    // Notify losers about funds release (they get nothing back)
    for (const loser of losers) {
      await this.notifyFundsReleased(loser.userId, eventId, 0, false);
    }

    // Notify winners about their winnings (already handled above in winner loop)
    // Update event creator fee collected
    await this.db
      .update(events)
      .set({ creatorFee: creatorFeeAmount })
      .where(eq(events.id, eventId));

    // Award admin commission (3% of total pool)
    const adminCommission = totalPool * 0.03;
    const admin = await this.db.query.users.findFirst({
      where: (users, { eq }) => eq(users.role, 'admin'),
    });

    if (admin && adminCommission > 0) {
      const currentBalance = parseFloat(String(admin.adminWalletBalance || '0'));
      const newBalance = currentBalance + adminCommission;

      // Update admin wallet balance
      await this.db
        .update(users)
        .set({ 
          adminWalletBalance: newBalance.toString(),
          adminTotalCommission: (parseFloat(String(admin.adminTotalCommission || '0')) + adminCommission).toString()
        })
        .where(eq(users.id, admin.id));

      // Log commission transaction
      await this.db.insert(adminWalletTransactions).values({
        adminId: admin.id,
        type: 'commission_earned',
        amount: adminCommission.toString(),
        description: `Commission from event: ${event.title}`,
        reference: `event_${eventId}_commission`,
        status: 'completed',
        balanceBefore: currentBalance.toString(),
        balanceAfter: newBalance.toString(),
      });
    }

    return { 
      winnersCount: winners.length, 
      totalPayout: availablePayout, 
      creatorFee: creatorFeeAmount 
    };
  }

  async getEventPoolStats(eventId: number): Promise<{ totalPool: number; yesPool: number; noPool: number; participantsCount: number }> {
    const event = await this.getEventById(eventId);
    if (!event) {
      throw new Error('Event not found');
    }

    const [participantCount] = await this.db
      .select({ count: count() })
      .from(eventParticipants)
      .where(eq(eventParticipants.eventId, eventId));

    return {
      totalPool: parseFloat(String(event.eventPool || '0')),
      yesPool: parseFloat(String(event.yesPool || '0')),
      noPool: parseFloat(String(event.noPool || '0')),
      participantsCount: participantCount.count,
    };
  }

  // Private event operations
  async requestEventJoin(eventId: number, userId: string, prediction: boolean, amount: number): Promise<EventJoinRequest> {
    const [request] = await this.db
      .insert(eventJoinRequests)
      .values({
        eventId,
        userId,
        prediction,
        amount: amount.toString(),
      })
      .returning();
    return request;
  }

  async getEventJoinRequests(eventId: number): Promise<(EventJoinRequest & { user: User })[]> {
    return await this.db
      .select({
        id: eventJoinRequests.id,
        eventId: eventJoinRequests.eventId,
        userId: eventJoinRequests.userId,
        prediction: eventJoinRequests.prediction,
        amount: eventJoinRequests.amount,
        status: eventJoinRequests.status,
        requestedAt: eventJoinRequests.requestedAt,
        respondedAt: eventJoinRequests.respondedAt,
        user: users,
      })
      .from(eventJoinRequests)
      .innerJoin(users, eq(eventJoinRequests.userId, users.id))
      .where(eq(eventJoinRequests.eventId, eventId))
      .orderBy(desc(eventJoinRequests.requestedAt));
  }

  async approveEventJoinRequest(requestId: number): Promise<EventParticipant> {
    const [request] = await this.db
      .select()
      .from(eventJoinRequests)
      .where(eq(eventJoinRequests.id, requestId));

    if (!request) {
      throw new Error('Join request not found');
    }

    // Create participant
    const participant = await this.joinEvent(
      request.eventId,
      request.userId,
      request.prediction,
      parseFloat(String(request.amount))
    );

    // Update request status
    await this.db
      .update(eventJoinRequests)
      .set({ 
        status: 'approved',
        respondedAt: new Date()
      })
      .where(eq(eventJoinRequests.id, requestId));

    return participant;
  }

  async rejectEventJoinRequest(requestId: number): Promise<EventJoinRequest> {
    const [request] = await this.db
      .update(eventJoinRequests)
      .set({ 
        status: 'rejected',
        respondedAt: new Date()
      })
      .where(eq(eventJoinRequests.id, requestId))
      .returning();
    return request;
  }

  private generateReferralCode(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }


  // Get user profile with stats
  async getAllUsers() {
    const usersResult = await this.db
      .select()
      .from(users)
      .where(and(
        eq(users.status, 'active'),
        eq(users.isAdmin, false) // Exclude admin and superadmin users
      ))
      .orderBy(desc(users.createdAt));

    return usersResult.map(user => ({
      ...user,
      status: user.lastLogin && new Date(user.lastLogin).getTime() > Date.now() - 24 * 60 * 60 * 1000 ? 'Online' : 'Offline',
    }));
  }

  // Group and member tracking
  async addGroup(telegramId: string, title?: string, type?: string, addedBy?: string): Promise<any> {
    const [g] = await this.db.insert(groups).values({
      telegramId,
      title,
      type,
      addedBy,
      addedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing().returning();

    if (g) return g;

    const [existing] = await this.db.select().from(groups).where(eq(groups.telegramId, telegramId)).limit(1);
    return existing;
  }

  async addGroupMember(groupId: number, userId: string, telegramId: string, username?: string): Promise<any> {
    // Insert or update membership
    const [member] = await this.db.insert(groupMembers).values({
      groupId,
      userId,
      telegramId,
      username,
      joinedAt: new Date(),
    }).onConflictDoUpdate({
      target: groupMembers.id,
      set: { username, leftAt: null }
    }).returning();

    return member;
  }

  async removeGroupMember(groupId: number, telegramId: string): Promise<void> {
    await this.db.update(groupMembers).set({ leftAt: new Date() }).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.telegramId, telegramId)));
  }

  async getGroupMembers(groupId: number): Promise<any[]> {
    const members = await this.db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId)).orderBy(desc(groupMembers.joinedAt));
    return members;
  }

  async getGroupByTelegramId(telegramId: string): Promise<any | null> {
    const [g] = await this.db.select().from(groups).where(eq(groups.telegramId, telegramId)).limit(1);
    return g || null;
  }

  async getUserProfile(userId: string, currentUserId: string): Promise<any> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new Error("User not found");
    }

    // Get user stats
    const [stats] = await this.db
      .select({
        wins: count(sql`CASE WHEN ${eventParticipants.status} = 'won' THEN 1 END`),
        activeChallenges: count(sql`CASE WHEN ${challenges.status} = 'active' THEN 1 END`),
        totalEarnings: sum(sql`CASE WHEN ${transactions.type} = 'win' AND CAST(${transactions.amount} AS DECIMAL) > 0 THEN CAST(${transactions.amount} AS DECIMAL) ELSE 0 END`),
      })
      .from(users)
      .leftJoin(eventParticipants, eq(eventParticipants.userId, users.id))
      .leftJoin(challenges, or(eq(challenges.challenger, users.id), eq(challenges.challenged, users.id)))
      .leftJoin(transactions, eq(transactions.userId, users.id))
      .where(eq(users.id, userId))
      .groupBy(users.id);

    // Check if current user is following this user
    const [followRecord] = await this.db
      .select()
      .from(friends)
      .where(and(
        eq(friends.requesterId, currentUserId),
        eq(friends.addresseeId, userId)
      ))
      .limit(1);

    // Get follower and following counts
    const [followerCount] = await this.db
      .select({ count: count() })
      .from(friends)
      .where(and(
        eq(friends.addresseeId, userId),
        eq(friends.status, 'accepted')
      ));

    const [followingCount] = await this.db
      .select({ count: count() })
      .from(friends)
      .where(and(
        eq(friends.requesterId, userId),
        eq(friends.status, 'accepted')
      ));

    // Check if there's an active challenge between users
    const [challengeRecord] = await this.db
      .select()
      .from(challenges)
      .where(and(
        or(
          and(eq(challenges.challenger, currentUserId), eq(challenges.challenged, userId)),
          and(eq(challenges.challenger, userId), eq(challenges.challenged, currentUserId))
        ),
        inArray(challenges.status, ['pending', 'active'])
      ))
      .limit(1);

    return {
      ...user,
      stats: {
        wins: stats?.wins || 0,
        activeChallenges: stats?.activeChallenges || 0,
        totalEarnings: parseFloat(stats?.totalEarnings || '0'),
      },
      isFollowing: !!followRecord,
      followerCount: followerCount?.count || 0,
      followingCount: followingCount?.count || 0,
      hasActiveChallenge: !!challengeRecord,
      challengeStatus: challengeRecord?.status || null,
      isChallengedByMe: challengeRecord?.challenger === currentUserId,
    };
  }

  // Get admin statistics
  async getAdminStats(): Promise<any> {
    // Query each table separately to avoid duplicate counting from JOINs
    const [userStats] = await this.db
      .select({
        totalUsers: count(),
        activeUsers: count(sql`CASE WHEN ${users.lastLogin} > NOW() - INTERVAL '7 days' THEN 1 END`),
        newUsersThisWeek: count(sql`CASE WHEN ${users.createdAt} > NOW() - INTERVAL '7 days' THEN 1 END`),
      })
      .from(users)
      .where(eq(users.isAdmin, false));

    const [eventStats] = await this.db
      .select({
        totalEvents: count(),
        activeEvents: count(sql`CASE WHEN ${events.status} = 'active' THEN 1 END`),
        completedEvents: count(sql`CASE WHEN ${events.status} = 'completed' THEN 1 END`),
        totalEventPool: sql<string>`COALESCE(SUM(CAST(${events.eventPool} AS DECIMAL)), 0)`,
        totalCreatorFees: sql<string>`COALESCE(SUM(CAST(${events.creatorFee} AS DECIMAL)), 0)`,
      })
      .from(events);

    const [challengeStats] = await this.db
      .select({
        totalChallenges: count(),
        activeChallenges: count(sql`CASE WHEN ${challenges.status} = 'active' THEN 1 END`),
        completedChallenges: count(sql`CASE WHEN ${challenges.status} = 'completed' THEN 1 END`),
        pendingChallenges: count(sql`CASE WHEN ${challenges.status} = 'pending' THEN 1 END`),
        totalChallengeStaked: sql<string>`COALESCE(SUM(CAST(${challenges.amount} AS DECIMAL) * 2), 0)`,
      })
      .from(challenges);

    const [transactionStats] = await this.db
      .select({
        totalTransactions: count(),
        totalVolume: sql<string>`COALESCE(SUM(CAST(${transactions.amount} AS DECIMAL)), 0)`,
        totalDeposits: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.type} = 'deposit' THEN CAST(${transactions.amount} AS DECIMAL) ELSE 0 END), 0)`,
        totalWithdrawals: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.type} = 'withdrawal' THEN CAST(${transactions.amount} AS DECIMAL) ELSE 0 END), 0)`,
        pendingPayouts: count(sql`CASE WHEN ${transactions.type} = 'payout' AND ${transactions.status} = 'pending' THEN 1 END`),
      })
      .from(transactions);

    // Calculate platform revenue (0.9% of the losing side on matched challenges + 3% event creator fees)
    const challengeVolume = parseFloat(challengeStats?.totalChallengeStaked || '0');
    const creatorFees = parseFloat(eventStats?.totalCreatorFees || '0');
    const estimatedChallengePlatformFees = (challengeVolume / 2) * CHALLENGE_PLATFORM_FEE_RATE;
    const platformFees = estimatedChallengePlatformFees + creatorFees;
    const totalVolume = parseFloat(eventStats?.totalEventPool || '0') + challengeVolume;

    return {
      totalUsers: userStats?.totalUsers || 0,
      activeUsers: userStats?.activeUsers || 0,
      newUsersThisWeek: userStats?.newUsersThisWeek || 0,
      totalEvents: eventStats?.totalEvents || 0,
      activeEvents: eventStats?.activeEvents || 0,
      completedEvents: eventStats?.completedEvents || 0,
      totalChallenges: challengeStats?.totalChallenges || 0,
      activeChallenges: challengeStats?.activeChallenges || 0,
      completedChallenges: challengeStats?.completedChallenges || 0,
      pendingChallenges: challengeStats?.pendingChallenges || 0,
      totalTransactions: transactionStats?.totalTransactions || 0,
      totalVolume: totalVolume,
      totalEventPool: parseFloat(eventStats?.totalEventPool || '0'),
      totalChallengeStaked: challengeVolume,
      totalRevenue: platformFees,
      totalCreatorFees: creatorFees,
      totalPlatformFees: estimatedChallengePlatformFees,
      totalDeposits: parseFloat(transactionStats?.totalDeposits || '0'),
      totalWithdrawals: parseFloat(transactionStats?.totalWithdrawals || '0'),
      pendingPayouts: transactionStats?.pendingPayouts || 0,
      dailyActiveUsers: userStats?.activeUsers || 0,
    };
  }

  // Get recent users
  async getRecentUsers(limit: number): Promise<any[]> {
    const recentUsers = await this.db
      .select({
        id: users.id,
        username: users.username,
        firstName: users.firstName,
        email: users.email,
        level: users.level,
        points: users.points,
        balance: users.balance,
        streak: users.streak,
        createdAt: users.createdAt,
        lastLogin: users.lastLogin,
      })
      .from(users)
      .where(and(
        eq(users.status, 'active'),
        eq(users.isAdmin, false) // Exclude admin and superadmin users
      ))
      .orderBy(desc(users.createdAt))
      .limit(limit);

    return recentUsers.map(user => ({
      ...user,
      status: user.lastLogin && new Date(user.lastLogin).getTime() > Date.now() - 24 * 60 * 60 * 1000 ? 'Online' : 'Offline',
    }));
  }

  // Get platform activity
  async getPlatformActivity(limit: number): Promise<any[]> {
    const recentActivity = await this.db
      .select({
        id: transactions.id,
        type: transactions.type,
        amount: transactions.amount,
        description: transactions.description,
        userId: transactions.userId,
        createdAt: transactions.createdAt,
        userFirstName: users.firstName,
        userUsername: users.username,
      })
      .from(transactions)
      .leftJoin(users, eq(users.id, transactions.userId))
      .orderBy(desc(transactions.createdAt))
      .limit(limit);

    return recentActivity.map(activity => ({
      ...activity,
      userName: activity.userFirstName || activity.userUsername || 'Unknown',
    }));
  }

  // Ban user
  async banUser(userId: string, reason: string): Promise<User> {
    const [updatedUser] = await this.db
      .update(users)
      .set({ 
        status: 'banned',
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();

    // Create admin log entry
    await this.db.insert(transactions).values({
      userId,
      type: 'admin_action',
      amount: '0',
      description: `User banned - Reason: ${reason}`,
      status: 'completed',
      createdAt: new Date()
    });

    return updatedUser;
  }

  // Unban user
  async unbanUser(userId: string, reason: string): Promise<User> {
    const [updatedUser] = await this.db
      .update(users)
      .set({ 
        status: 'active',
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();

    // Create admin log entry
    await this.db.insert(transactions).values({
      userId,
      type: 'admin_action',
      amount: '0',
      description: `User unbanned - Reason: ${reason}`,
      status: 'completed',
      createdAt: new Date()
    });

    return updatedUser;
  }

  // Adjust user balance
  async adjustUserBalance(userId: string, amount: number, reason: string): Promise<User> {
    const [updatedUser] = await this.db
      .update(users)
      .set({ 
        balance: sql`${users.balance} + ${amount}`,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();

    // Create transaction record
    await this.db.insert(transactions).values({
      userId,
      type: amount > 0 ? 'admin_credit' : 'admin_debit',
      amount: Math.abs(amount).toString(),
      description: `Admin balance adjustment - Reason: ${reason}`,
      status: 'completed',
      createdAt: new Date()
    });

    return updatedUser;
  }

  // Set user admin status
  async setUserAdminStatus(userId: string, isAdmin: boolean, reason: string): Promise<User> {
    const [updatedUser] = await this.db
      .update(users)
      .set({ 
        isAdmin,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();

    // Create admin log entry
    await this.db.insert(transactions).values({
      userId,
      type: 'admin_action',
      amount: '0',
      description: `Admin status ${isAdmin ? 'granted' : 'revoked'} - Reason: ${reason}`,
      status: 'completed',
      createdAt: new Date()
    });

    return updatedUser;
  }

  // Send admin message
  async sendAdminMessage(userId: string, message: string, reason: string): Promise<any> {
    // Create notification
    await this.db.insert(notifications).values({
      id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId,
      type: 'admin_message',
      title: 'Message from Admin',
      message,
      createdAt: new Date()
    });

    // Create admin log entry
    await this.db.insert(transactions).values({
      userId,
      type: 'admin_action',
      amount: '0',
      description: `Admin message sent - Reason: ${reason}`,
      status: 'completed',
      createdAt: new Date()
    });

    return { success: true, message: 'Admin message sent successfully' };
  }

  async checkDailyLogin(userId: string): Promise<any> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const now = new Date();
    const todayDate = today.toISOString().split('T')[0];

    // Check if user has already logged in today
    const todayLogin = await this.db
      .select()
      .from(dailyLogins)
      .where(and(
        eq(dailyLogins.userId, userId),
        sql`DATE(${dailyLogins.date}) = ${todayDate}`
      ))
      .limit(1);

    if (todayLogin.length > 0) {
      if (!todayLogin[0].claimed) {
        const pointsEarned = Math.max(
          0,
          Math.round(Number(todayLogin[0].pointsEarned ?? BANTCREDIT_DAILY_CHECKIN_REWARD) || 0),
        );
        const streak = Math.max(1, Math.round(Number(todayLogin[0].streak || 1)));

        if (pointsEarned > 0) {
          await this.db.transaction(async (tx) => {
            await tx
              .update(users)
              .set({
                points: sql`COALESCE(${users.points}, 0) + ${pointsEarned}`,
                streak,
                lastLogin: now,
                updatedAt: now,
              })
              .where(eq(users.id, userId));

            await tx.insert(transactions).values({
              userId,
              type: 'daily_signin',
              amount: String(pointsEarned),
              description: `Daily login BantCredit - Day ${streak}`,
              relatedId: todayLogin[0].id,
              status: 'completed',
            });

            await tx.insert(notifications).values({
              id: `notif_${Date.now()}_${nanoid(10)}`,
              userId,
              type: 'daily_login_reward',
              title: 'Daily BantCredit',
              message: `You received ${pointsEarned} BantCredit for logging in today. Day ${streak} streak.`,
              icon: 'bantcredit',
              data: { points: pointsEarned, streak, type: 'daily_login_reward' },
              channels: ['in_app_feed', 'push_notification'],
              fomoLevel: 'medium',
              priority: 2,
              read: false,
              createdAt: now,
              updatedAt: now,
            });

            await tx
              .update(dailyLogins)
              .set({ claimed: true })
              .where(eq(dailyLogins.id, todayLogin[0].id));
          });

          return { ...todayLogin[0], claimed: true, awarded: true, pointsAwarded: pointsEarned };
        }

        const [updatedLogin] = await this.db
          .update(dailyLogins)
          .set({ claimed: true })
          .where(eq(dailyLogins.id, todayLogin[0].id))
          .returning();

        return { ...(updatedLogin || todayLogin[0]), awarded: false, pointsAwarded: 0 };
      }

      const streak = Math.max(1, Math.round(Number(todayLogin[0].streak || 1)));
      await this.db
        .update(users)
        .set({ streak, lastLogin: now, updatedAt: now })
        .where(eq(users.id, userId));

      return { ...todayLogin[0], awarded: false, pointsAwarded: 0 };
    }

    // Get last login to determine streak
    const lastLogin = await this.db
      .select()
      .from(dailyLogins)
      .where(eq(dailyLogins.userId, userId))
      .orderBy(sql`${dailyLogins.date} DESC`)
      .limit(1);

    let currentStreak = 1;
    if (lastLogin.length > 0) {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const lastLoginDate = new Date(lastLogin[0].date);
      lastLoginDate.setHours(0, 0, 0, 0);

      if (lastLoginDate.getTime() === yesterday.getTime()) {
        currentStreak = lastLogin[0].streak + 1; // Continue streak
      } else {
        currentStreak = 1; // Reset streak
      }
    }

    const pointsEarned = BANTCREDIT_DAILY_CHECKIN_REWARD;

    // Create today's login record
    const [newLogin] = await this.db
      .insert(dailyLogins)
      .values({
        userId,
        date: today,
        streak: currentStreak,
        pointsEarned,
        claimed: true
      })
      .returning();

    await this.db
      .update(users)
      .set({
        points: sql`COALESCE(${users.points}, 0) + ${pointsEarned}`,
        streak: currentStreak,
        lastLogin: now,
        updatedAt: now
      })
      .where(eq(users.id, userId));

    await this.createTransaction({
      userId,
      type: 'daily_signin',
      amount: String(pointsEarned),
      description: `Daily login BantCredit - Day ${currentStreak}`,
      relatedId: newLogin.id,
      status: 'completed'
    });

    await this.createNotification({
      userId,
      type: 'daily_login_reward',
      title: 'Daily BantCredit',
      message: `You received ${pointsEarned} BantCredit for logging in today. Day ${currentStreak} streak.`,
      icon: 'bantcredit',
      data: { points: pointsEarned, streak: currentStreak, type: 'daily_login_reward' },
      channels: ['in_app_feed', 'push_notification'],
      fomoLevel: 'medium',
      priority: 2
    } as any);

    // If first time user, also create welcome notification
    const userCreatedToday = await this.db
      .select()
      .from(users)
      .where(and(
        eq(users.id, userId),
        sql`DATE(${users.createdAt}) = ${today.toISOString().split('T')[0]}`
      ))
      .limit(1);

    if (false && userCreatedToday.length > 0) {
      // Create welcome notification for new users
      await this.createNotification({
        userId,
        type: 'welcome',
        title: '🎉 Welcome to Bantah!',
        message: `You received ${BANTCREDIT_SIGNUP_REWARD} BantCredit for joining! Start betting and challenging friends.`,
        data: { points: BANTCREDIT_SIGNUP_REWARD, type: 'welcome_bonus' }
      });

      // Legacy referral bonus path kept disabled to avoid double-awarding.
      const user = userCreatedToday[0];
      if (false && user.referredBy) {
        // Find referrer and create referral notification
        const referrer = await this.getUser(user.referredBy);
        if (referrer) {
          await this.createNotification({
            userId: user.referredBy,
            type: 'referral_reward',
            title: '💰 Referral Bonus!',
            message: `You earned ${BANTCREDIT_REFERRER_REWARD} BantCredit for referring @${user.firstName || user.username || 'a new user'}!`,
            data: { 
              points: BANTCREDIT_REFERRER_REWARD, 
              referredUserId: userId,
              referredUserName: user.firstName || user.username,
              type: 'referral_bonus'
            }
          });

          // Add referral points to referrer
          await this.db
            .update(users)
            .set({ 
              points: sql`${users.points} + ${BANTCREDIT_REFERRER_REWARD}`,
              updatedAt: new Date()
            })
            .where(eq(users.id, user.referredBy));

          // Create transaction for referrer
          await this.createTransaction({
            userId: user.referredBy,
            type: 'referral_bonus',
            amount: String(BANTCREDIT_REFERRER_REWARD),
            description: `Referral bonus for ${user.firstName || user.username || 'new user'}`,
            status: 'completed'
          });
        }
      }
    }

    return { ...newLogin, awarded: true, pointsAwarded: pointsEarned };
  }

  // Get user created events
  async getUserCreatedEvents(userId: string): Promise<any[]> {
    const createdEvents = await this.db
      .select({
        id: events.id,
        title: events.title,
        description: events.description,
        category: events.category,
        eventPool: events.eventPool,
        status: events.status,
        endDate: events.endDate,
        createdAt: events.createdAt,
        participantCount: count(eventParticipants.id),
      })
      .from(events)
      .leftJoin(eventParticipants, eq(eventParticipants.eventId, events.id))
      .where(eq(events.creatorId, userId))
      .groupBy(events.id)
      .orderBy(desc(events.createdAt));

    return createdEvents;
  }

  // Get user joined events
  async getUserJoinedEvents(userId: string): Promise<any[]> {
    const joinedEvents = await this.db
      .select({
        id: events.id,
        title: events.title,
        description: events.description,
        category: events.category,
        eventPool: events.eventPool,
        status: events.status,
        endDate: events.endDate,
        createdAt: events.createdAt,
        participantAmount: eventParticipants.amount,
        participantStatus: eventParticipants.status,
        prediction: eventParticipants.prediction,
        joinedAt: eventParticipants.joinedAt,
      })
      .from(eventParticipants)
      .innerJoin(events, eq(events.id, eventParticipants.eventId))
      .where(eq(eventParticipants.userId, userId))
      .orderBy(desc(eventParticipants.joinedAt));

    return joinedEvents;
  }

  // Admin Management Functions
  async deleteEvent(eventId: number) {
    // Delete related records first
    await this.db.delete(eventParticipants).where(eq(eventParticipants.eventId, eventId));
    await this.db.delete(eventMessages).where(eq(eventMessages.eventId, eventId));
    await this.db.delete(messageReactions).where(eq(messageReactions.messageId, sql`(SELECT id FROM event_messages WHERE event_id = ${eventId})`));

    // Delete the event
    await this.db.delete(events).where(eq(events.id, eventId));

    console.log(`Event ${eventId} deleted by admin`);
  }

  async toggleEventChat(eventId: number, enabled: boolean) {
    await this.db.update(events)
      .set({ 
        chatEnabled: enabled,
        updatedAt: new Date()
      })
      .where(eq(events.id, eventId));

    console.log(`Event ${eventId} chat ${enabled ? 'enabled' : 'disabled'} by admin`);
  }

  async deleteChallenge(challengeId: number) {
    try {
      // Get challenge before deleting to check for bonus
      const challenge = await this.getChallengeById(challengeId);
      
      // Refund bonus if it exists
      if (challenge && challenge.bonusAmount && challenge.bonusAmount > 0) {
        await this.refundBonusToAdmin(challengeId, challenge, 'cancelled');
      }

      // Delete related records first
      // await db.delete(challengeParticipants).where(eq(challengeParticipants.challengeId, challengeId)); // Assuming you have a challengeParticipants table

      // Delete the challenge
      await this.db.delete(challenges).where(eq(challenges.id, challengeId));

      console.log(`Challenge ${challengeId} deleted by admin (bonus refunded if applicable)`);
    } catch (error) {
      console.error(`Error deleting challenge ${challengeId}:`, error);
      throw error;
    }
  }

  // Admin Functions
  async getAdminUsers() {
    const admins = await this.db.select({
      id: users.id,
      username: users.username,
      firstName: users.firstName,
      email: users.email,
      level: users.level,
      points: users.points,
      createdAt: users.createdAt,
      lastLogin: users.lastLogin,
      status: users.status
    }).from(users).where(eq(users.isAdmin, true));

    return admins;
  }



  // Platform Settings
  async getPlatformSettings(): Promise<PlatformSettings> {
    const [settings] = await this.db.select().from(platformSettings).limit(1);

    if (!settings) {
      // Create default settings if none exist
      const [defaultSettings] = await this.db.insert(platformSettings).values({}).returning();
      return defaultSettings;
    }

    return settings;
  }

  async updatePlatformSettings(settingsUpdate: Partial<PlatformSettings>): Promise<PlatformSettings> {
    const existingSettings = await this.getPlatformSettings();

    const [updatedSettings] = await this.db
      .update(platformSettings)
      .set({
        ...settingsUpdate,
        updatedAt: new Date(),
      })
      .where(eq(platformSettings.id, existingSettings.id))
      .returning();

    return updatedSettings;
  }

  // Advanced Admin Tools
  async addEventFunds(eventId: number, amount: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Add funds to event pool
      await tx
        .update(events)
        .set({
          eventPool: sql`${events.eventPool} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(events.id, eventId));

      // Create transaction record
      await tx.insert(transactions).values({
        userId: 'admin',
        type: 'admin_fund',
        amount: amount.toString(),
        description: `Admin added ₦${amount} to event ${eventId}`,
        status: 'completed',
      });
    });
  }

  async giveUserPoints(userId: string, points: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Add points to user
      await tx
        .update(users)
        .set({
          points: sql`${users.points} + ${points}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      // Create transaction record
      await tx.insert(transactions).values({
        userId: userId,
        type: 'admin_points',
        amount: points.toString(),
        description: `Admin gave ${points} points`,
        status: 'completed',
      });
    });
  }

  async updateEventCapacity(eventId: number, additionalSlots: number): Promise<void> {
    await this.db
      .update(events)
      .set({
        maxParticipants: sql`${events.maxParticipants} + ${additionalSlots}`,
        updatedAt: new Date(),
      })
      .where(eq(events.id, eventId));
  }

  async broadcastMessage(message: string, type: string): Promise<void> {
    // Get all users to broadcast to
    const allUsers = await this.db.select({ id: users.id }).from(users);

    // Create notifications for all users
    const notificationData = allUsers.map(user => ({
      userId: user.id,
      type: 'broadcast' as const,
      title: `${type.charAt(0).toUpperCase() + type.slice(1)} Message`,
      message: message,
      data: { broadcastType: type },
    }));

    await this.db.insert(notifications).values(notificationData);
  }

  // Event lifecycle notification methods
  async notifyEventStarting(eventId: number): Promise<void> {
    const event = await this.getEventById(eventId);
    if (!event) return;

    const participants = await this.getEventParticipants(eventId);

    for (const participant of participants) {
      await this.createNotification({
        userId: participant.userId,
        type: 'event_starting',
        title: '🏁 Event Starting Soon',
        message: `The event "${event.title}" is starting in 1 hour!`,
        data: { 
          eventId: eventId,
          eventTitle: event.title,
          startTime: event.endDate
        },
      });
    }

    // Notify creator
    await this.createNotification({
      userId: event.creatorId,
      type: 'event_starting',
      title: '🏁 Your Event is Starting Soon',
      message: `Your event "${event.title}" is starting in 1 hour!`,
      data: { 
        eventId: eventId,
        eventTitle: event.title,
        startTime: event.endDate
      },
    });
  }

  async notifyEventEnding(eventId: number): Promise<void> {
    const event = await this.getEventById(eventId);
    if (!event) return;

    const participants = await this.getEventParticipants(eventId);

    for (const participant of participants) {
      await this.createNotification({
        userId: participant.userId,
        type: 'event_ending',
        title: '⏰ Event Ending Soon',
        message: `The event "${event.title}" is ending in 1 hour! Make sure your prediction is locked in.`,
        data: { 
          eventId: eventId,
          eventTitle: event.title,
          endTime: event.endDate,
          prediction: participant.prediction ? 'YES' : 'NO',
          amount: parseFloat(participant.amount)
        },
      });
    }

    // Notify creator
    await this.createNotification({
      userId: event.creatorId,
      type: 'event_ending',
      title: '⏰ Your Event is Ending Soon',
      message: `Your event "${event.title}" is ending in 1 hour! Results will need to be set soon.`,
      data: { 
        eventId: eventId,
        eventTitle: event.title,
        endTime: event.endDate
      },
    });
  }

  async notifyFundsReleased(userId: string, eventId: number, amount: number, isWinner: boolean): Promise<void> {
    const event = await this.getEventById(eventId);
    if (!event) return;

    if (isWinner) {
      await this.createNotification({
        userId: userId,
        type: 'funds_released',
        title: '🎉 You Won!',
        message: `Congratulations! You won ₦${amount.toLocaleString()} from "${event.title}". Funds have been released to your wallet.`,
        data: { 
          eventId: eventId,
          eventTitle: event.title,
          amount: amount,
          isWinner: true
        },
      });
    } else {
      await this.createNotification({
        userId: userId,
        type: 'funds_released',
        title: '😔 Event Results',
        message: `The event "${event.title}" has concluded. Better luck next time!`,
        data: { 
          eventId: eventId,
          eventTitle: event.title,
          amount: 0,
          isWinner: false
        },
      });
    }
  }

  // Missing admin functions
  async getAdminNotifications(limit: number): Promise<any[]> {
    return await this.db.select().from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async broadcastNotification(data: any): Promise<any> {
    // Get all users if no target specified
    const targetUsers = data.targetUserIds || 
      (await this.db.select({ id: users.id }).from(users)).map(u => u.id);

    const notificationData = targetUsers.map((userId: string) => ({
      userId: userId,
      type: data.type || 'admin_announcement',
      title: data.title,
      message: data.message,
    }));

    await this.db.insert(notifications).values(notificationData);
    return { success: true, count: notificationData.length };
  }

  async searchUsers(query: string, limit: number): Promise<any[]> {
    return await this.db.select().from(users)
      .where(sql`${users.username} ILIKE ${`%${query}%`} OR ${users.firstName} ILIKE ${`%${query}%`}`)
      .limit(limit);
  }

  // Push notification subscription methods
  async savePushSubscription(userId: string, subscription: any): Promise<void> {
    if (subscription?.endpoint) {
      await this.db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, subscription.endpoint));
    }

    await this.db.insert(pushSubscriptions).values({
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: subscription.userAgent || null,
    });
  }

  async getPushSubscriptions(userId: string): Promise<any[]> {
    const subscriptions = await this.db
      .select({
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));

    return subscriptions.map(sub => ({
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    }));
  }

  async removePushSubscription(endpoint: string): Promise<void> {
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  }



  async getUserByReferralCode(referralCode: string): Promise<User | undefined> {
    try {
      const [user] = await this.db
        .select()
        .from(users)
        .where(eq(users.referralCode, referralCode))
        .limit(1);

      return user;
    } catch (error) {
      console.error("Error fetching user by referral code:", error);
      throw new Error("Failed to fetch user by referral code");
    }
  }

  async updateUserCoins(userId: string, coinAmount: number): Promise<void> {
    await this.db
      .update(users)
      .set({ 
        coins: sql`COALESCE(${users.coins}, 0) + ${coinAmount}`,
        updatedAt: new Date() 
      })
      .where(eq(users.id, userId));
  }

  async updateUserPoints(userId: string, pointsAmount: number): Promise<void> {
    await this.db
      .update(users)
      .set({ 
        points: sql`COALESCE(${users.points}, 0) + ${pointsAmount}`,
        updatedAt: new Date() 
      })
      .where(eq(users.id, userId));
  }

  async awardChallengeCreationBantCredit(
    userId: string,
    rewardInput: {
      challengeId: number;
      marketSize: number;
      challengeTitle?: string | null;
    },
  ): Promise<BantCreditChallengeRewardResult> {
    const [actionCountRow, existingRewardRow] = await Promise.all([
      this.db
        .select({ count: count() })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.status, "completed"),
            not(
              inArray(
                transactions.type,
                [...BANTCREDIT_ACTIVITY_EXCLUDED_TRANSACTION_TYPES],
              ),
            ),
          ),
        )
        .then((rows) => rows[0]),
      this.db
        .select({ amount: transactions.amount })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.type, "challenge_creation_reward"),
            eq(transactions.relatedId, rewardInput.challengeId),
            eq(transactions.status, "completed"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]),
    ]);

    const activityCount = Number(actionCountRow?.count ?? 0);
    const calculatedReward = calculateChallengeCreationBantCredit({
      marketSize: rewardInput.marketSize,
      activityCount,
    });

    if (existingRewardRow) {
      return {
        ...calculatedReward,
        awarded: false,
        pointsAwarded: Math.max(
          0,
          Math.round(Number.parseFloat(String(existingRewardRow.amount || 0)) || 0),
        ),
      };
    }

    if (calculatedReward.pointsAwarded <= 0) {
      return calculatedReward;
    }

    const titleSuffix = rewardInput.challengeTitle
      ? ` for "${rewardInput.challengeTitle}"`
      : "";

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          points: sql`COALESCE(${users.points}, 0) + ${calculatedReward.pointsAwarded}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      await tx.insert(transactions).values({
        userId,
        type: "challenge_creation_reward",
        amount: String(calculatedReward.pointsAwarded),
        description:
          `BantCredit reward${titleSuffix} ` +
          `(${calculatedReward.marketSize} x ${calculatedReward.activityMultiplier}x)`,
        relatedId: rewardInput.challengeId,
        status: "completed",
      });
    });

    return calculatedReward;
  }

  async createReferral(referralData: {
    referrerId: string;
    referredId: string;
    code: string;
    status: string;
  }) {
    try {
      const [result] = await this.db
        .insert(referrals)
        .values({
          referrerId: referralData.referrerId,
          referredId: referralData.referredId,
          code: referralData.code,
          status: referralData.status,
        })
        .returning();

      return result;
    } catch (error) {
      console.error("Error creating referral:", error);
      throw new Error("Failed to create referral");
    }
  }

  async getUserEvents(userId: string): Promise<Event[]> {
    try {
      const result = await this.db
        .select()
        .from(events)
        .where(eq(events.creatorId, userId))
        .orderBy(desc(events.createdAt));

      return result;
    } catch (error) {
      console.error('Error getting user events:', error);
      throw error;
    }
  }

  async getUserChallenges(userId: string): Promise<Challenge[]> {
    try {
      const result = await this.db
        .select()
        .from(challenges)
        .where(and(eq(challenges.challenger, userId), ne(challenges.status, "draft")))
        .orderBy(desc(challenges.createdAt));

      return result;
    } catch (error) {
      console.error('Error getting user challenges:', error);
      throw error;
    }
  }

  // Personalized Event Recommendation Engine Implementation

  async getUserRecommendationProfile(userId: string): Promise<UserRecommendationProfile | undefined> {
    try {
      const [profile] = await this.db
        .select()
        .from(userRecommendationProfiles)
        .where(eq(userRecommendationProfiles.userId, userId))
        .limit(1);

      return profile;
    } catch (error) {
      console.error('Error getting user recommendation profile:', error);
      return undefined;
    }
  }

  async updateUserRecommendationProfile(userId: string, profile: Partial<InsertUserRecommendationProfile>): Promise<UserRecommendationProfile> {
    try {
      // Check if profile exists
      const existingProfile = await this.getUserRecommendationProfile(userId);

      if (existingProfile) {
        // Update existing profile
        const [updated] = await this.db
          .update(userRecommendationProfiles)
          .set({ ...profile, updatedAt: new Date() })
          .where(eq(userRecommendationProfiles.userId, userId))
          .returning();
        return updated;
      } else {
        // Create new profile
        const [created] = await this.db
          .insert(userRecommendationProfiles)
          .values({ userId, ...profile })
          .returning();
        return created;
      }
    } catch (error) {
      console.error('Error updating user recommendation profile:', error);
      throw error;
    }
  }

  async generateEventRecommendations(userId: string, limit: number = 10): Promise<EventRecommendation[]> {
    try {
      // Get user's recommendation profile
      const profile = await this.getUserRecommendationProfile(userId);

      // Get active events that user hasn't joined
      const activeEvents = await this.db
        .select()
        .from(events)
        .where(and(
          eq(events.status, 'active'),
          sql`${events.creatorId} != ${userId}`, // Not created by user
          sql`${events.id} NOT IN (
            SELECT event_id FROM event_participants WHERE user_id = ${userId}
          )` // User hasn't joined
        ))
        .orderBy(desc(events.createdAt))
        .limit(50); // Get pool of candidates

      const recommendations: InsertEventRecommendation[] = [];

      for (const event of activeEvents) {
        const score = await this.calculateRecommendationScore(userId, event, profile);
        if (score > 0) {
          recommendations.push({
            userId,
            eventId: event.id,
            recommendationScore: score.toString(),
            recommendationReason: score > 80 ? 'perfect_match' : 
                                 score > 60 ? 'good_match' : 
                                 score > 40 ? 'moderate_match' : 'trending',
            matchFactors: {
              categoryMatch: score * 0.3,
              amountMatch: score * 0.25,
              creatorHistory: score * 0.2,
              trendingScore: score * 0.15,
              timeRelevance: score * 0.1
            }
          });
        }
      }

      // Sort by score and limit results
      recommendations.sort((a, b) => parseFloat(b.recommendationScore) - parseFloat(a.recommendationScore));
      const topRecommendations = recommendations.slice(0, limit);

      // Save to database
      if (topRecommendations.length > 0) {
        // Clear old recommendations for this user
        await this.db.delete(eventRecommendations).where(eq(eventRecommendations.userId, userId));

        // Insert new recommendations
        const inserted = await this.db.insert(eventRecommendations).values(topRecommendations).returning();
        return inserted;
      }

      return [];
    } catch (error) {
      console.error('Error generating event recommendations:', error);
      throw error;
    }
  }

  async getPersonalizedEvents(userId: string, limit: number = 10): Promise<(Event & { recommendationScore: number, recommendationReason: string })[]> {
    try {
      // Generate fresh recommendations
      await this.generateEventRecommendations(userId, limit);

      // Get personalized events with scores
      const personalizedEvents = await this.db
        .select({
          id: events.id,
          title: events.title,
          description: events.description,
          category: events.category,
          status: events.status,
          creatorId: events.creatorId,
          eventPool: events.eventPool,
          yesPool: events.noPool,
          entryFee: events.entryFee,
          endDate: events.endDate,
          result: events.result,
          adminResult: events.adminResult,
          creatorFee: events.creatorFee,
          isPrivate: events.isPrivate,
          maxParticipants: events.maxParticipants,
          imageUrl: events.imageUrl,
          chatEnabled: events.chatEnabled,
          createdAt: events.createdAt,
          updatedAt: events.updatedAt,
          recommendationScore: eventRecommendations.recommendationScore,
          recommendationReason: eventRecommendations.recommendationReason,
        })
        .from(eventRecommendations)
        .innerJoin(events, eq(events.id, eventRecommendations.eventId))
        .where(eq(eventRecommendations.userId, userId))
        .orderBy(desc(eventRecommendations.recommendationScore))
        .limit(limit);

      return personalizedEvents.map(event => ({
        ...event,
        recommendationScore: parseFloat(event.recommendationScore),
      }));
    } catch (error) {
      console.error('Error getting personalized events:', error);
      throw error;
    }
  }

  async trackUserInteraction(interaction: InsertUserEventInteraction): Promise<UserEventInteraction> {
    try {
      const [tracked] = await this.db.insert(userEventInteractions).values(interaction).returning();

      // Update user's recommendation profile based on interaction
      await this.updateRecommendationProfile(interaction.userId);

      return tracked;
    } catch (error) {
      console.error('Error tracking user interaction:', error);
      throw error;
    }
  }

  async updateRecommendationProfile(userId: string): Promise<void> {
    try {
      // Get user's participation history
      const participationHistory = await this.db
        .select({
          eventId: eventParticipants.eventId,
          prediction: eventParticipants.prediction,
          amount: eventParticipants.amount,
          status: eventParticipants.status,
          category: events.category,
          entryFee: events.entryFee,
        })
        .from(eventParticipants)
        .innerJoin(events, eq(events.id, eventParticipants.eventId))
        .where(eq(eventParticipants.userId, userId));

      // Get interaction history
      const interactions = await this.db
        .select()
        .from(userEventInteractions)
        .where(eq(userEventInteractions.userId, userId));

      // Calculate profile metrics
      const totalEvents = participationHistory.length;
      const totalWins = participationHistory.filter(p => p.status === 'won').length;
      const winRate = totalEvents > 0 ? (totalWins / totalEvents) * 100 : 0;

      // Calculate favorite categories
      const categoryCount: Record<string, number> = {};
      participationHistory.forEach(p => {
        categoryCount[p.category] = (categoryCount[p.category] || 0) + 1;
      });
      const favoriteCategories = Object.entries(categoryCount)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3)
        .map(([category]) => category);

      // Calculate average bet amount
      const totalAmount = participationHistory.reduce((sum, p) => sum + parseInt(p.amount.toString()), 0);
      const averageBetAmount = totalEvents > 0 ? Math.round(totalAmount / totalEvents) : 0;

      // Calculate engagement score based on interactions
      const engagementScore = Math.min(100, interactions.length * 2 + totalEvents * 5);

      // Update profile
      await this.updateUserRecommendationProfile(userId, {
        favoriteCategories,
        averageBetAmount,
        winRate: winRate.toString(),
        totalEventsJoined: totalEvents,
        totalEventsWon: totalWins,
        engagementScore: engagementScore.toString(),
        lastActivityAt: new Date(),
        socialInteractions: interactions.filter(i => i.interactionType === 'comment').length,
      });
    } catch (error) {
      console.error('Error updating recommendation profile:', error);
      // Don't throw - this is a background update
    }
  }

  private async calculateRecommendationScore(userId: string, event: Event, profile?: UserRecommendationProfile): Promise<number> {
    let score = 0;

    // Base trending score
    const participantCount = await this.db
      .select({ count: count() })
      .from(eventParticipants)
      .where(eq(eventParticipants.eventId, event.id));

    const trendingScore = Math.min(20, participantCount[0]?.count || 0);
    score += trendingScore;

    if (!profile) return score;

    // Category matching (30 points max)
    const favoriteCategories = profile.favoriteCategories as string[] || [];
    if (favoriteCategories.includes(event.category)) {
      score += 30;
    }

    // Amount matching (25 points max)
    const userAvgAmount = profile.averageBetAmount || 0;
    const eventAmount = event.entryFee;
    const amountDiff = Math.abs(userAvgAmount - eventAmount);
    const amountScore = Math.max(0, 25 - (amountDiff / userAvgAmount) * 25);
    score += amountScore;

    // Creator history (20 points max)  
    const creatorEvents = await this.db
      .select({ count: count() })
      .from(events)
      .where(eq(events.creatorId, event.creatorId));

    const creatorScore = Math.min(20, (creatorEvents[0]?.count || 0) * 2);
    score += creatorScore;

    // Time relevance (10 points max)
    const hoursUntilEnd = (new Date(event.endDate).getTime() - Date.now()) / (1000 * 60 * 60);
    const timeScore = hoursUntilEnd > 24 ? 10 : hoursUntilEnd > 12 ? 7 : hoursUntilEnd > 2 ? 5 : 2;
    score += timeScore;

    // Engagement boost (15 points max)
    const engagementBoost = Math.min(15, (parseFloat(profile.engagementScore) || 0) * 0.15);
    score += engagementBoost;

    return Math.min(100, Math.round(score));
  }

  // Stories operations
  async getActiveStories(): Promise<any[]> {
    try {
      const results = await this.db
        .select()
        .from(stories)
        .where(eq(stories.isActive, true))
        .orderBy(desc(stories.createdAt));

      return results;
    } catch (error) {
      console.error('Error getting active stories:', error);
      throw error;
    }
  }

  async createStory(storyData: any): Promise<any> {
    try {
      const [story] = await this.db
        .insert(stories)
        .values({
          title: storyData.title,
          content: storyData.content,
          imageUrl: storyData.imageUrl,
          backgroundColor: storyData.backgroundColor || "#6366f1",
          textColor: storyData.textColor || "#ffffff",
          duration: storyData.duration || 15,
          category: storyData.category || "general",
          isActive: storyData.isActive !== false,
        })
        .returning();

      return story;
    } catch (error) {
      console.error('Error creating story:', error);
      throw error;
    }
  }

  async updateStory(storyId: number, updates: any): Promise<any> {
    try {
      const [story] = await this.db
        .update(stories)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(stories.id, storyId))
        .returning();

      return story;
    } catch (error) {
      console.error('Error updating story:', error);
      throw error;
    }
  }

  async deleteStory(storyId: number): Promise<void> {
    try {
      await this.db
        .delete(stories)
        .where(eq(stories.id, storyId));
    } catch (error) {
      console.error('Error deleting story:', error);
      throw error;
    }
  }

  async markStoryAsViewed(storyId: number, userId: string): Promise<void> {
    try {
      // Check if already viewed
      const existingView = await this.db
        .select()
        .from(storyViews)
        .where(and(eq(storyViews.storyId, storyId), eq(storyViews.userId, userId)))
        .limit(1);

      if (!existingView.length) {
        // Add view record
        await this.db
          .insert(storyViews)
          .values({
            storyId,
            userId,
          });

        // Increment view count
        await this.db
          .update(stories)
          .set({
            viewCount: sql`${stories.viewCount} + 1`,
          })
          .where(eq(stories.id, storyId));
      }
    } catch (error) {
      console.error('Error marking story as viewed:', error);
      throw error;
    }
  }

  async registerSigningPublicKey(userId: string, publicKeyBase64: string): Promise<any> {
    const res: any = await pool.query(`UPDATE users SET signing_pubkey = $1 WHERE id = $2 RETURNING id, signing_pubkey`, [publicKeyBase64, userId]);
    return res.rows[0];
  }

  // --- Admin getters for challenge details ---
  async getChallengVotes(challengeId: number): Promise<any[]> {
    const res: any = await pool.query(`
      SELECT 
        cv.*, 
        u.username, 
        u.first_name 
      FROM challenge_votes cv
      LEFT JOIN users u ON cv.participant_id = u.id
      WHERE cv.challenge_id = $1
      ORDER BY cv.submitted_at DESC
    `, [String(challengeId)]);
    return res.rows || [];
  }

  async getChallengeProofs(challengeId: number): Promise<any[]> {
    const res: any = await pool.query(`
      SELECT 
        cp.*, 
        u.username, 
        u.first_name 
      FROM challenge_proofs cp
      LEFT JOIN users u ON cp.participant_id = u.id
      WHERE cp.challenge_id = $1
      ORDER BY cp.uploaded_at DESC
    `, [String(challengeId)]);
    return res.rows || [];
  }

  async getChallengeStateHistory(challengeId: number): Promise<any[]> {
    const res: any = await pool.query(`
      SELECT 
        csh.*, 
        u.username, 
        u.first_name 
      FROM challenge_state_history csh
      LEFT JOIN users u ON csh.changed_by = u.id
      WHERE csh.challenge_id = $1
      ORDER BY csh.changed_at DESC
    `, [String(challengeId)]);
    return res.rows || [];
  }

}

export const storage = new DatabaseStorage();
