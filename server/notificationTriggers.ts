/**
 * 🔥 Notification Triggers
 * Event-driven notifications for 9 core events
 */

import { notificationService, NotificationEvent, NotificationChannel, NotificationPriority } from './notificationService';

/**
 * CHALLENGE.CREATED
 * ⚡ New Admin Challenge
 * YES side pays up to 2.5×
 */
export async function notifyNewChallenge(
  userId: string,
  challengeId: string,
  title: string,
  yesMultiplier: number
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.CHALLENGE_CREATED,
    title: '⚡ New Admin Challenge',
    body: `${title}\nYES side pays up to ${yesMultiplier}×\nEarly bonus available`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.MEDIUM,
    data: { yesMultiplier, title },
  });
}

/**
 * CHALLENGE.STARTING_SOON
 * 5 minutes before challenge starts
 */
export async function notifyChallengeStartingSoon(
  userId: string,
  challengeId: string,
  title: string
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.CHALLENGE_STARTING_SOON,
    title: '⏱ Challenge starting soon',
    body: `${title} starts in 5 mins\nDon't miss early bonus!`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.HIGH,
    data: { title },
  });
}

/**
 * CHALLENGE.ENDING_SOON
 * 5 minutes before challenge ends
 */
export async function notifyChallengeEndingSoon(
  userId: string,
  challengeId: string,
  title: string,
  bonusActive: boolean
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.CHALLENGE_ENDING_SOON,
    title: '⏳ Challenge ends soon',
    body: bonusActive
      ? `Last 5 mins!\n${title}\nBonus still active`
      : `Last 5 mins to join ${title}!`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.HIGH,
    data: { title, bonusActive },
  });
}

/**
 * CHALLENGE.JOINED.FRIEND
 * Friend joined challenge (in-app only)
 */
export async function notifyFriendJoined(
  userId: string,
  challengeId: string,
  friendName: string,
  side: 'YES' | 'NO'
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.CHALLENGE_JOINED_FRIEND,
    title: '👀 Friend joined',
    body: `${friendName} just joined ${side} side\nBonus still active`,
    channels: [NotificationChannel.IN_APP],
    priority: NotificationPriority.LOW,
    data: { friendName, side },
  });
}

/**
 * IMBALANCE.DETECTED
 * One side has 60%+ of pool
 */
export async function notifyImbalanceDetected(
  userId: string,
  challengeId: string,
  laggingSide: 'YES' | 'NO',
  bonus: number
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.IMBALANCE_DETECTED,
    title: `🔥 ${laggingSide} side underdog`,
    body: `Earn +${bonus}× right now`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.MEDIUM,
    data: { laggingSide, bonus },
  });
}

/**
 * BONUS.ACTIVATED
 * Bonus surge or early join bonus available
 */
export async function notifyBonusActivated(
  userId: string,
  challengeId: string,
  side: 'YES' | 'NO',
  multiplier: number
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.BONUS_ACTIVATED,
    title: '🚀 BONUS SURGE',
    body: `${side} side pays up to ${multiplier}×`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.HIGH,
    data: { side, multiplier },
  });
}

/**
 * BONUS.EXPIRING
 * Early bonus ends in 2 minutes (CRITICAL)
 */
export async function notifyBonusExpiring(
  userId: string,
  challengeId: string,
  minutesLeft: number
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.BONUS_EXPIRING,
    title: '⏳ Early bonus ends',
    body: `Last ${minutesLeft} mins — join now`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.HIGH,
    data: { minutesLeft },
  });
}

/**
 * MATCH.FOUND
 * User is matched with opponent
 */
export async function notifyMatchFound(
  userId: string,
  challengeId: string,
  opponentName: string,
  amount: number
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.MATCH_FOUND,
    title: `✅ Matched vs ${opponentName}`,
    body: `₦${amount.toLocaleString()} locked in escrow`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.HIGH,
    data: { opponentName, amount },
  });
}

/**
 * SYSTEM.JOINED
 * System character joined to balance pool (in-app only)
 */
export async function notifySystemJoined(
  userId: string,
  challengeId: string,
  side: 'YES' | 'NO'
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.SYSTEM_JOINED,
    title: '🤖 Helper joined',
    body: `System helper joined ${side} side to keep things fair`,
    channels: [NotificationChannel.IN_APP],
    priority: NotificationPriority.LOW,
    data: { side },
  });
}

/**
 * QUEUE.ADDED
 * User added to waiting queue (not matched yet)
 */
export async function notifyQueueAdded(
  userId: string,
  challengeId: string,
  side: 'YES' | 'NO',
  stakeAmount: number,
  queuePosition: number
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.CHALLENGE_ENDING_SOON, // Reuse event type for rate limiting
    title: '⏳ Queued for matching',
    body: `Your ₦${stakeAmount.toLocaleString()} ${side} stake is locked.\nPosition ${queuePosition} in queue.`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.MEDIUM,
    data: { side, stakeAmount, queuePosition },
  });
}

/**
 * QUEUE.CANCELLED
 * User cancelled their queue entry and stake is refunded
 */
export async function notifyQueueCancelled(
  userId: string,
  challengeId: string,
  side: 'YES' | 'NO',
  refundAmount: number
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.CHALLENGE_ENDING_SOON, // Reuse event type
    title: '✅ Stake Refunded',
    body: `You cancelled your ${side} position. ₦${refundAmount.toLocaleString()} refunded to your wallet.`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.MEDIUM,
    data: { side, refundAmount },
  });
}

/**
 * CHALLENGE.EXPIRING_IN_1_HOUR
 * Challenge will close in 1 hour, users can still join
 */
export async function notifyChallengeExpiringIn1Hour(
  userId: string,
  challengeId: string,
  title: string
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.CHALLENGE_ENDING_SOON,
    title: '⏰ 1 hour left',
    body: `"${title}" closes in 1 hour. Last chance to join!`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.HIGH,
    data: { title },
  });
}

/**
 * CHALLENGE.EXPIRING_IN_10_MINUTES
 * Challenge will close in 10 minutes - URGENT
 */
export async function notifyChallengeExpiringIn10Minutes(
  userId: string,
  challengeId: string,
  title: string
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.CHALLENGE_ENDING_SOON,
    title: '🚨 10 minutes left',
    body: `"${title}" closes in 10 mins! Last chance to join or rebalance.`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.HIGH,
    data: { title },
  });
}

/**
 * CHALLENGE.EXPIRED
 * Challenge has expired and stakes are being refunded
 */
export async function notifyChallengeExpired(
  userId: string,
  challengeId: string,
  title: string,
  refundAmount: number
) {
  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.CHALLENGE_ENDING_SOON,
    title: '⏸ Challenge Expired',
    body: `"${title}" expired with no match. ₦${refundAmount.toLocaleString()} refunded to your wallet.`,
    channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    priority: NotificationPriority.MEDIUM,
    data: { title, refundAmount },
  });
}

/**
 * "WHAT YOU'RE MISSING" ENGINE
 * Runs every 5-10 minutes
 * 
 * Triggers if:
 * - User viewed challenge
 * - Did NOT join
 * - Bonus or imbalance exists
 */
export async function notifyWhatYouAreMissing(
  userId: string,
  challengeId: string,
  title: string,
  side: 'YES' | 'NO',
  multiplier: number,
  minutesLeft: number
) {
  const channels =
    minutesLeft < 5 ? [NotificationChannel.IN_APP, NotificationChannel.PUSH] : [NotificationChannel.IN_APP];

  const priority = minutesLeft < 5 ? NotificationPriority.HIGH : NotificationPriority.LOW;

  await notificationService.send({
    userId,
    challengeId,
    event: NotificationEvent.CHALLENGE_ENDING_SOON, // Reuse existing event for rate limiting
    title: '👀 You checked this challenge',
    body:
      minutesLeft < 5
        ? `${side} side still pays ${multiplier}×\n⏰ Last ${minutesLeft} mins!`
        : `${side} side still pays ${multiplier}×\nEnds soon`,
    channels,
    priority,
    data: { side, multiplier, minutesLeft },
  });
}
