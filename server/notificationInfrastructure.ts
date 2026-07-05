/**
 * 1️⃣ NOTIFICATION INFRASTRUCTURE
 * Wire triggers into challenge routes
 * 
 * Import these functions and call them when events happen
 */

import {
  notifyNewChallenge,
  notifyChallengeStartingSoon,
  notifyChallengeEndingSoon,
  notifyFriendJoined,
  notifyImbalanceDetected,
  notifyBonusActivated,
  notifyBonusExpiring,
  notifyMatchFound,
  notifyQueueAdded,
  notifyQueueCancelled,
  notifyChallengeExpiringIn1Hour,
  notifyChallengeExpiringIn10Minutes,
  notifyChallengeExpired,
  notifySystemJoined,
  notifyWhatYouAreMissing,
} from './notificationTriggers';
import { db } from './db';
import { users, challenges } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * EVENT HANDLER: Challenge Created
 * Call this when admin creates a new challenge
 */
export async function handleChallengeCreated(
  challengeId: string,
  title: string,
  yesMultiplier: number,
  creatorId?: string
) {
  console.log(`📢 [EVENT] Challenge Created: ${challengeId}`);

  // Get all active users
  const activeUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, 'active'));

  // Notify featured challenges to all users
  for (const user of activeUsers) {
    await notifyNewChallenge(user.id, challengeId, title, yesMultiplier);
  }
}

/**
 * EVENT HANDLER: Challenge Starting Soon
 * Call this 5 mins before challenge starts
 * Notify only participants
 */
export async function handleChallengeStartingSoon(
  challengeId: string,
  title: string,
  participantIds: string[]
) {
  console.log(`📢 [EVENT] Challenge Starting Soon: ${challengeId}`);

  for (const userId of participantIds) {
    await notifyChallengeStartingSoon(userId, challengeId, title);
  }
}

/**
 * EVENT HANDLER: Challenge Ending Soon
 * Call this 5 mins before challenge ends
 * Notify non-participants
 */
export async function handleChallengeEndingSoon(
  challengeId: string,
  title: string,
  participantIds: string[],
  bonusActive: boolean
) {
  console.log(`📢 [EVENT] Challenge Ending Soon: ${challengeId}`);

  const allUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, 'active'));

  const participantSet = new Set(participantIds);

  for (const user of allUsers) {
    if (!participantSet.has(user.id)) {
      await notifyChallengeEndingSoon(user.id, challengeId, title, bonusActive);
    }
  }
}

/**
 * EVENT HANDLER: Friend Joined Challenge
 * Call this when a user joins
 * Notify mutual friends
 */
export async function handleFriendJoinedChallenge(
  challengeId: string,
  userId: string,
  side: 'YES' | 'NO'
) {
  console.log(`📢 [EVENT] Friend Joined: ${userId} on ${side} side`);

  // Get the user's info
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (!user[0]) return;

  // TODO: Get mutual friends from friends table
  // For now, just log
  const mutualFriends: any[] = [];

  for (const friend of mutualFriends) {
    await notifyFriendJoined(friend.id, challengeId, user[0].username || user[0].firstName || 'Friend', side);
  }
}

/**
 * EVENT HANDLER: Imbalance Detected
 * Call this when one side has 60%+ of pool
 * Notify non-participants
 */
export async function handleImbalanceDetected(
  challengeId: string,
  laggingSide: 'YES' | 'NO',
  bonus: number,
  participantIds: string[]
) {
  console.log(`📢 [EVENT] Imbalance Detected: ${laggingSide} side lagging with +${bonus}× bonus`);

  const allUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, 'active'));

  const participantSet = new Set(participantIds);

  for (const user of allUsers) {
    if (!participantSet.has(user.id)) {
      await notifyImbalanceDetected(user.id, challengeId, laggingSide, bonus);
    }
  }
}

/**
 * EVENT HANDLER: Bonus Activated
 * Call this when bonus surge or early join bonus is active
 * Notify all users
 */
export async function handleBonusActivated(
  challengeId: string,
  side: 'YES' | 'NO',
  multiplier: number
) {
  console.log(`📢 [EVENT] Bonus Activated: ${side} side × ${multiplier}`);

  const activeUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, 'active'));

  for (const user of activeUsers) {
    await notifyBonusActivated(user.id, challengeId, side, multiplier);
  }
}

/**
 * EVENT HANDLER: Bonus Expiring
 * Call this 2 mins before bonus window closes
 * Notify all users (CRITICAL)
 */
export async function handleBonusExpiring(
  challengeId: string,
  minutesLeft: number
) {
  console.log(`📢 [EVENT] Bonus Expiring: ${minutesLeft} mins left`);

  const activeUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, 'active'));

  for (const user of activeUsers) {
    await notifyBonusExpiring(user.id, challengeId, minutesLeft);
  }
}

/**
 * EVENT HANDLER: Match Found
 * Call this when user is matched with opponent
 * Notify the matched users only
 */
export async function handleMatchFound(
  challengeId: string,
  userId1: string,
  userId2: string,
  user1Name: string,
  user2Name: string,
  amount: number
) {
  console.log(`📢 [EVENT] Match Found: ${userId1} vs ${userId2}`);

  await notifyMatchFound(userId1, challengeId, user2Name, amount);
  await notifyMatchFound(userId2, challengeId, user1Name, amount);
}

/**
 * EVENT HANDLER: Queue Added
 * Call this when user is added to matching queue (waiting)
 * Notify only the queued user
 */
export async function handleQueueAdded(
  challengeId: string,
  userId: string,
  side: 'YES' | 'NO',
  stakeAmount: number,
  queuePosition: number
) {
  console.log(`📢 [EVENT] Queue Added: ${userId} (Position: ${queuePosition})`);

  await notifyQueueAdded(userId, challengeId, side, stakeAmount, queuePosition);
}

/**
 * EVENT HANDLER: System Character Joined
 * Call this when system joins to balance pool
 * Notify all users
 */
export async function handleSystemJoined(
  challengeId: string,
  side: 'YES' | 'NO'
) {
  console.log(`📢 [EVENT] System Character Joined: ${side} side`);

  const activeUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, 'active'));

  for (const user of activeUsers) {
    await notifySystemJoined(user.id, challengeId, side);
  }
}

/**
 * EVENT HANDLER: Queue Cancelled
 * Call this when user cancels their queue entry
 * Notify only the user who cancelled
 */
export async function handleQueueCancelled(
  challengeId: string,
  userId: string,
  side: 'YES' | 'NO',
  refundAmount: number
) {
  console.log(`📢 [EVENT] Queue Cancelled: ${userId} refunded ₦${refundAmount}`);

  await notifyQueueCancelled(userId, challengeId, side, refundAmount);
}

/**
 * EVENT HANDLER: Challenge Expiring in 1 Hour
 * Call this to notify all users in queue
 */
export async function handleChallengeExpiringIn1Hour(
  challengeId: string,
  title: string
) {
  console.log(`📢 [EVENT] Challenge Expiring in 1 Hour: ${title}`);

  const activeUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, 'active'));

  for (const user of activeUsers) {
    await notifyChallengeExpiringIn1Hour(user.id, challengeId, title);
  }
}

/**
 * EVENT HANDLER: Challenge Expiring in 10 Minutes
 * Call this to notify all users in queue - URGENT
 */
export async function handleChallengeExpiringIn10Minutes(
  challengeId: string,
  title: string
) {
  console.log(`📢 [EVENT] Challenge Expiring in 10 Minutes: ${title}`);

  const activeUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, 'active'));

  for (const user of activeUsers) {
    await notifyChallengeExpiringIn10Minutes(user.id, challengeId, title);
  }
}

/**
 * EVENT HANDLER: Challenge Expired
 * Call this when challenge expires and stakes are refunded
 * Notify all unmatched participants
 */
export async function handleChallengeExpired(
  challengeId: string,
  title: string,
  refundAmounts: Map<string, number> // userId -> refundAmount
) {
  console.log(`📢 [EVENT] Challenge Expired: ${title}`);

  // Convert Map to Array for iteration (TypeScript compatibility)
  const refunds = Array.from(refundAmounts.entries());
  for (const [userId, refundAmount] of refunds) {
    await notifyChallengeExpired(userId, challengeId, title, refundAmount);
  }
}

/**
 * SCHEDULED TASK: What You're Missing Engine
 * Run every 5-10 minutes
 * 
 * Triggers if:
 * - User viewed challenge but did NOT join
 * - Bonus or imbalance exists
 * - Challenge has < 10 mins left
 */
export async function runWhatYouAreMissingEngine() {
  console.log(`📢 [SCHEDULED] What You're Missing Engine Running...`);

  // TODO: Implement
  // 1. Get all challenges ending in next 10 mins
  // 2. For each challenge, find users who viewed but didn't join
  // 3. Check if bonus/imbalance exists
  // 4. Send "What You're Missing" notification
  
  console.log('✅ What You\'re Missing Engine Complete');
}

export const notificationInfrastructure = {
  handleChallengeCreated,
  handleChallengeStartingSoon,
  handleChallengeEndingSoon,
  handleFriendJoinedChallenge,
  handleImbalanceDetected,
  handleBonusActivated,
  handleBonusExpiring,
  handleMatchFound,
  handleQueueAdded,
  handleQueueCancelled,
  handleChallengeExpiringIn1Hour,
  handleChallengeExpiringIn10Minutes,
  handleChallengeExpired,
  handleSystemJoined,
  runWhatYouAreMissingEngine,
};
