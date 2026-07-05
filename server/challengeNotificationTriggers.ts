/**
 * 🔥 Challenge Notification Triggers
 * Event-driven triggers for Challenge Lifecycle, User Activity, and Admin Events
 * Implements the FOMO notification timeline
 */

import { FOSMNotificationService, NotificationType, NotificationChannel, FOMOLevel, NotificationPriority } from './notificationSystem';
import { db } from './db';
import { users, challenges, challengeParticipants } from '../shared/schema';
import { eq, and, or, ne, gt, gte, lte, desc } from 'drizzle-orm';

export class ChallengeNotificationTriggers {
  private notificationService: FOSMNotificationService;

  constructor() {
    this.notificationService = new FOSMNotificationService();
  }

  // ========== CHALLENGE LIFECYCLE TRIGGERS ==========

  /**
   * 🎯 Trigger: New Admin Challenge Created
   * 
   * Sends to: All users
   * Urgency: HIGH
   * Channels: Push + In-App Feed
   * Message: "⚡ New Challenge: Friday Showdown! YES side pays up to 2.5×. Join before it fills!"
   */
  async onNewChallengeCreated(challengeId: string): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    // Get all active users
    const allUsers = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.status, 'active'));

    // Send to each user
    for (const user of allUsers) {
      const maxYesMultiplier = challenge[0].yesMultiplier || 2.5;
      const maxNoMultiplier = challenge[0].noMultiplier || 2.0;

      await this.notificationService.sendNotification({
        userId: user.id,
        type: NotificationType.NEW_CHALLENGE_CREATED,
        title: `⚡ New Challenge: ${challenge[0].title}`,
        message: `YES side pays up to ${maxYesMultiplier}×! Join before it fills!`,
        icon: '⚡',
        data: {
          challengeId: challenge[0].id,
          title: challenge[0].title,
          maxYesMultiplier,
          maxNoMultiplier,
          entryFee: challenge[0].entryFee,
          endsAt: challenge[0].endsAt,
        },
        channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED],
        fomoLevel: FOMOLevel.HIGH,
        priority: NotificationPriority.HIGH,
        deduplicationKey: `new_challenge_${challengeId}`,
      });
    }

    console.log(`✅ New challenge notification sent to ${allUsers.length} users`);
  }

  /**
   * ⏱ Trigger: Challenge About to Start (5 mins before)
   * 
   * Sends to: Users in challenge
   * Urgency: HIGH
   * Channels: Push + In-App Feed
   * Message: "⏱ Starts in 5 mins! Don't miss your early bonus!"
   */
  async onChallengeAboutToStart(challengeId: string): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    // Get all participants
    const participants = await db
      .select({ userId: challengeParticipants.userId })
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, challengeId));

    for (const participant of participants) {
      await this.notificationService.sendNotification({
        userId: participant.userId,
        type: NotificationType.CHALLENGE_ABOUT_TO_START,
        title: `⏱ ${challenge[0].title} starts in 5 mins!`,
        message: "Don't miss your early bonus!",
        icon: '⏱',
        data: {
          challengeId: challenge[0].id,
          startsAt: challenge[0].startsAt,
        },
        channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED],
        fomoLevel: FOMOLevel.HIGH,
        priority: NotificationPriority.HIGH,
        deduplicationKey: `challenge_starting_${challengeId}`,
      });
    }

    console.log(`✅ Challenge about to start notification sent to ${participants.length} participants`);
  }

  /**
   * ⏳ Trigger: Challenge Near End (5 mins before end)
   * 
   * Sends to: Users not yet joined or undecided
   * Urgency: URGENT
   * Channels: Push + In-App Feed
   * Message: "⏳ Only 5 mins left! YES side still has +0.5× bonus"
   */
  async onChallengeNearEnd(challengeId: string): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    // Get users NOT yet joined
    const joinedUsers = await db
      .select({ userId: challengeParticipants.userId })
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, challengeId));

    const joinedUserIds = joinedUsers.map(p => p.userId);

    const nonJoinedUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.status, 'active'),
          or(
            ...joinedUserIds.length > 0
              ? [ne(users.id, joinedUserIds[0])] // This is a workaround
              : []
          )
        )
      );

    for (const user of nonJoinedUsers) {
      // Skip users who already joined
      if (joinedUserIds.includes(user.id)) continue;

      const remainingMinutes = 5;
      const yesBonus = challenge[0].yesBonus || 0.5;

      await this.notificationService.sendNotification({
        userId: user.id,
        type: NotificationType.CHALLENGE_NEAR_END,
        title: `⏳ ${challenge[0].title} ends soon!`,
        message: `Only ${remainingMinutes} mins left! YES side still has +${yesBonus}× bonus`,
        icon: '⏳',
        data: {
          challengeId: challenge[0].id,
          remainingMinutes,
          yesBonus,
          endsAt: challenge[0].endsAt,
        },
        channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED],
        fomoLevel: FOMOLevel.URGENT,
        priority: NotificationPriority.URGENT,
        deduplicationKey: `challenge_ending_${challengeId}`,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });
    }
  }

  // ========== USER ACTIVITY TRIGGERS ==========

  /**
   * 👀 Trigger: Friend Joined Challenge
   * 
   * Sends to: Mutual friends not yet joined
   * Urgency: MEDIUM
   * Channels: In-App Feed + Push
   * Message: "👀 @Ayo just joined YES side in 'Friday Showdown'!"
   */
  async onFriendJoinedChallenge(challengeId: string, friendUserId: string): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    const friend = await db
      .select()
      .from(users)
      .where(eq(users.id, friendUserId))
      .limit(1);

    if (!challenge[0] || !friend[0]) return;

    // Get friend's side
    const friendParticipant = await db
      .select({ side: challengeParticipants.side })
      .from(challengeParticipants)
      .where(and(eq(challengeParticipants.challengeId, challengeId), eq(challengeParticipants.userId, friendUserId)))
      .limit(1);

    if (!friendParticipant[0]) return;

    // TODO: Get mutual friends and send notification
    // For now, mock implementation
    const mutualFriends = []; // Replace with actual friend list query

    for (const mutualFriend of mutualFriends) {
      // Skip if already joined
      const alreadyJoined = await db
        .select()
        .from(challengeParticipants)
        .where(and(eq(challengeParticipants.challengeId, challengeId), eq(challengeParticipants.userId, mutualFriend.id)))
        .limit(1);

      if (alreadyJoined.length > 0) continue;

      await this.notificationService.sendNotification({
        userId: mutualFriend.id,
        type: NotificationType.FRIEND_JOINED_CHALLENGE,
        title: `👀 Friend joined!`,
        message: `@${friend[0].username} just joined ${friendParticipant[0].side} side in "${challenge[0].title}"!`,
        icon: '👀',
        data: {
          challengeId: challenge[0].id,
          friendUserId,
          friendName: friend[0].username || friend[0].firstName,
          side: friendParticipant[0].side,
        },
        channels: [NotificationChannel.IN_APP_FEED, NotificationChannel.PUSH_NOTIFICATION],
        fomoLevel: FOMOLevel.MEDIUM,
        priority: NotificationPriority.MEDIUM,
        deduplicationKey: `friend_joined_${challengeId}_${friendUserId}`,
      });
    }
  }

  /**
   * 🎉 Trigger: Friend Won / Bonus Realized
   * 
   * Sends to: Mutual friends
   * Urgency: HIGH
   * Channels: Push + In-App Feed
   * Message: "🎉 @Tunde earned 1.8× on NO side! You could still join!"
   */
  async onFriendWonBonus(challengeId: string, friendUserId: string, multiplier: number): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    const friend = await db
      .select()
      .from(users)
      .where(eq(users.id, friendUserId))
      .limit(1);

    if (!challenge[0] || !friend[0]) return;

    // TODO: Get mutual friends
    const mutualFriends = [];

    for (const mutualFriend of mutualFriends) {
      await this.notificationService.sendNotification({
        userId: mutualFriend.id,
        type: NotificationType.FRIEND_WON_BONUS,
        title: `🎉 Friend won big!`,
        message: `@${friend[0].username} earned ${multiplier}× on this challenge!`,
        icon: '🎉',
        data: {
          challengeId: challenge[0].id,
          friendUserId,
          friendName: friend[0].username || friend[0].firstName,
          multiplier,
        },
        channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED],
        fomoLevel: FOMOLevel.HIGH,
        priority: NotificationPriority.HIGH,
        deduplicationKey: `friend_won_${challengeId}_${friendUserId}`,
      });
    }
  }

  /**
   * ⚠️ Trigger: Your Pending Bonus Expiring
   * 
   * Sends to: Users with active bonus window
   * Urgency: URGENT
   * Channels: Push + In-App Feed
   * Message: "⚠️ Early join bonus ends in 2 mins!"
   */
  async onPendingBonusExpiring(challengeId: string, userId: string, minutesLeft: number): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    await this.notificationService.sendNotification({
      userId,
      type: NotificationType.PENDING_BONUS_EXPIRING,
      title: `⚠️ Bonus ending soon!`,
      message: `Early join bonus ends in ${minutesLeft} mins!`,
      icon: '⚠️',
      data: {
        challengeId: challenge[0].id,
        minutesLeft,
        challengeTitle: challenge[0].title,
      },
      channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED],
      fomoLevel: FOMOLevel.URGENT,
      priority: NotificationPriority.URGENT,
      deduplicationKey: `bonus_expiring_${challengeId}_${userId}`,
      expiresAt: new Date(Date.now() + minutesLeft * 60 * 1000),
    });
  }

  /**
   * 🔥 Trigger: Your Side Is Lagging (Imbalance)
   * 
   * Sends to: Users on lagging side
   * Urgency: MEDIUM
   * Channels: In-App Feed + Push
   * Message: "🔥 NO side is underdog! Earn +0.5× now"
   */
  async onSideLagging(challengeId: string, laggingSide: 'YES' | 'NO', bonusMultiplier: number): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    // Get all active users (not yet joined this challenge)
    const allActiveUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.status, 'active'));

    // Filter out already joined users
    const joinedUsers = await db
      .select({ userId: challengeParticipants.userId })
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, challengeId));

    const joinedUserIds = new Set(joinedUsers.map(p => p.userId));

    for (const user of allActiveUsers) {
      if (joinedUserIds.has(user.id)) continue;

      await this.notificationService.sendNotification({
        userId: user.id,
        type: NotificationType.YOUR_SIDE_LAGGING,
        title: `🔥 ${laggingSide} side underdog!`,
        message: `Earn +${bonusMultiplier}× now to help balance!`,
        icon: '🔥',
        data: {
          challengeId: challenge[0].id,
          laggingSide,
          bonusMultiplier,
          challengeTitle: challenge[0].title,
        },
        channels: [NotificationChannel.IN_APP_FEED, NotificationChannel.PUSH_NOTIFICATION],
        fomoLevel: FOMOLevel.MEDIUM,
        priority: NotificationPriority.MEDIUM,
        deduplicationKey: `side_lagging_${challengeId}_${laggingSide}`,
      });
    }
  }

  // ========== ADMIN / SYSTEM EVENT TRIGGERS ==========

  /**
   * 🚀 Trigger: Admin Activates Bonus Surge
   * 
   * Sends to: All users / specific side users
   * Urgency: URGENT
   * Channels: Push + Telegram + In-App Feed
   * Message: "🚀 SURGE ACTIVE! NO side pays up to 3.0×. Limited time!"
   */
  async onAdminBonusSurgeActivated(challengeId: string, side: 'YES' | 'NO', multiplier: number, durationMinutes: number): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    const allUsers = await db.select({ id: users.id }).from(users).where(eq(users.status, 'active'));

    for (const user of allUsers) {
      await this.notificationService.sendNotification({
        userId: user.id,
        type: NotificationType.ADMIN_BONUS_SURGE_ACTIVATED,
        title: `🚀 SURGE ACTIVE!`,
        message: `${side} side pays up to ${multiplier}×. Limited time!`,
        icon: '🚀',
        data: {
          challengeId: challenge[0].id,
          side,
          multiplier,
          durationMinutes,
          challengeTitle: challenge[0].title,
        },
        channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.TELEGRAM_BOT, NotificationChannel.IN_APP_FEED],
        fomoLevel: FOMOLevel.URGENT,
        priority: NotificationPriority.URGENT,
        deduplicationKey: `surge_active_${challengeId}`,
        expiresAt: new Date(Date.now() + durationMinutes * 60 * 1000),
      });
    }

    console.log(`✅ Bonus surge notification sent: ${side} side × ${multiplier}`);
  }

  /**
   * ⚠️ Trigger: Imbalance Detected
   * 
   * Sends to: All users / lagging side
   * Urgency: MEDIUM
   * Channels: Push + In-App Feed
   * Message: "⚠️ YES side dominating! NO side gets +0.6× bonus"
   */
  async onImbalanceDetected(challengeId: string, dominantSide: 'YES' | 'NO', laggingSide: 'YES' | 'NO', bonus: number): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    const allUsers = await db.select({ id: users.id }).from(users).where(eq(users.status, 'active'));

    for (const user of allUsers) {
      await this.notificationService.sendNotification({
        userId: user.id,
        type: NotificationType.IMBALANCE_DETECTED,
        title: `⚠️ ${dominantSide} side dominating!`,
        message: `${laggingSide} side gets +${bonus}× bonus to balance!`,
        icon: '⚠️',
        data: {
          challengeId: challenge[0].id,
          dominantSide,
          laggingSide,
          bonus,
          challengeTitle: challenge[0].title,
        },
        channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED],
        fomoLevel: FOMOLevel.MEDIUM,
        priority: NotificationPriority.MEDIUM,
        deduplicationKey: `imbalance_${challengeId}`,
      });
    }
  }

  /**
   * ⏳ Trigger: Early Join Spots Remaining
   * 
   * Sends to: All users
   * Urgency: HIGH
   * Channels: Push + In-App Feed
   * Message: "⏳ Only 2 early bonus spots left on YES side!"
   */
  async onEarlyJoinSpotsRemaining(challengeId: string, side: 'YES' | 'NO', spotsLeft: number): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    const allUsers = await db.select({ id: users.id }).from(users).where(eq(users.status, 'active'));

    for (const user of allUsers) {
      if (spotsLeft > 0) {
        await this.notificationService.sendNotification({
          userId: user.id,
          type: NotificationType.EARLY_JOIN_SPOTS_REMAINING,
          title: `⏳ Limited spots available!`,
          message: `Only ${spotsLeft} early bonus spots left on ${side} side!`,
          icon: '⏳',
          data: {
            challengeId: challenge[0].id,
            side,
            spotsLeft,
            challengeTitle: challenge[0].title,
          },
          channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED],
          fomoLevel: FOMOLevel.HIGH,
          priority: NotificationPriority.HIGH,
          deduplicationKey: `early_spots_${challengeId}_${side}`,
        });
      }
    }
  }

  /**
   * 🤖 Trigger: System Character Joined
   * 
   * Sends to: All users
   * Urgency: LOW
   * Channels: In-App Feed
   * Message: "🤖 Helper joined NO side to keep things fair"
   */
  async onSystemCharacterJoined(challengeId: string, side: 'YES' | 'NO'): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    const allUsers = await db.select({ id: users.id }).from(users).where(eq(users.status, 'active'));

    for (const user of allUsers) {
      await this.notificationService.sendNotification({
        userId: user.id,
        type: NotificationType.SYSTEM_CHARACTER_JOINED,
        title: `🤖 Helper joined!`,
        message: `A system helper joined ${side} side to keep things fair.`,
        icon: '🤖',
        data: {
          challengeId: challenge[0].id,
          side,
          challengeTitle: challenge[0].title,
        },
        channels: [NotificationChannel.IN_APP_FEED],
        fomoLevel: FOMOLevel.LOW,
        priority: NotificationPriority.LOW,
        deduplicationKey: `system_joined_${challengeId}_${side}`,
      });
    }
  }
  /**
   * 💰 Trigger: Challenge Marked for Admin Review (Pending Admin)
   * 
   * Sends to: All participants
   * Urgency: MEDIUM
   * Channels: In-App Feed + Push
   * Message: "💰 Challenge ended! Admin is reviewing results for payout."
   */
  async onChallengePendingAdmin(challengeId: string): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    // Get all participants
    const participants = await db
      .select({ userId: challengeParticipants.userId })
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, challengeId));

    for (const participant of participants) {
      await this.notificationService.sendNotification({
        userId: participant.userId,
        type: NotificationType.CHALLENGE_RESULT, // Reusing result type for lifecycle
        title: `💰 Reviewing: ${challenge[0].title}`,
        message: "Challenge ended! Admin is reviewing results for payout.",
        icon: '💰',
        data: {
          challengeId: challenge[0].id,
          status: 'pending_admin',
        },
        channels: [NotificationChannel.IN_APP_FEED, NotificationChannel.PUSH_NOTIFICATION],
        fomoLevel: FOMOLevel.MEDIUM,
        priority: NotificationPriority.MEDIUM,
        deduplicationKey: `challenge_pending_${challengeId}_${participant.userId}`,
      });
    }

    console.log(`✅ Challenge pending admin notifications sent to ${participants.length} participants`);
  }

  /**
   * 🚫 Trigger: Challenge Cancelled / Refunded
   * 
   * Sends to: All participants
   * Urgency: HIGH
   * Channels: Push + In-App Feed
   */
  async onChallengeCancelled(challengeId: string, reason: string): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    // Get all participants
    const participants = await db
      .select({ userId: challengeParticipants.userId })
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, challengeId));

    for (const participant of participants) {
      await this.notificationService.sendNotification({
        userId: participant.userId,
        type: NotificationType.CHALLENGE_CANCELLED,
        title: `🚫 Cancelled: ${challenge[0].title}`,
        message: `This challenge was cancelled. Reason: ${reason}. All stakes have been refunded.`,
        icon: '🚫',
        data: {
          challengeId: challenge[0].id,
          reason,
        },
        channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED],
        fomoLevel: FOMOLevel.HIGH,
        priority: NotificationPriority.HIGH,
        deduplicationKey: `challenge_cancelled_${challengeId}_${participant.userId}`,
      });
    }

    console.log(`✅ Challenge cancelled notifications sent to ${participants.length} participants`);
  }

  /**
   * 🎁 Trigger: Bonus Awarded to User
   * 
   * Sends to: User receiving the bonus
   * Urgency: HIGH
   * Channels: Push + In-App Feed
   */
  async onBonusAwarded(userId: string, amount: number, bonusType: string, challengeId?: string): Promise<void> {
    const bonusNames: Record<string, string> = {
      'early_bird': 'Early Bird Bonus',
      'streak': 'Streak Bonus',
      'conviction': 'Conviction Bonus',
      'first_time': 'First Timer Bonus',
      'social_tag': 'Social Tag Bonus',
      'daily_login': 'Daily Login Bonus'
    };

    const bonusName = bonusNames[bonusType] || 'Bonus';
    let challengeTitle = '';

    if (challengeId) {
      const challenge = await db
        .select({ title: challenges.title })
        .from(challenges)
        .where(eq(challenges.id, parseInt(challengeId)))
        .limit(1);
      challengeTitle = challenge[0]?.title ? ` for "${challenge[0].title}"` : '';
    }

    await this.notificationService.sendNotification({
      userId,
      type: NotificationType.BONUS_AWARDED,
      title: `🎁 ${bonusName} Received!`,
      message: `You've been awarded ${amount.toLocaleString()} coins${challengeTitle}! Keep it up!`,
      icon: '🎁',
      data: {
        amount,
        bonusType,
        challengeId,
      },
      channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED],
      fomoLevel: FOMOLevel.HIGH,
      priority: NotificationPriority.HIGH,
      deduplicationKey: `bonus_${bonusType}_${userId}_${challengeId || Date.now()}`,
    });
  }

  /**
   * 💰 Trigger: Payout Successfully Delivered
   * 
   * Sends to: User receiving payout
   * Urgency: HIGH
   * Channels: Push + In-App Feed
   */
  async onPayoutDelivered(userId: string, amount: number, challengeId: string): Promise<void> {
    const challenge = await db
      .select({ title: challenges.title })
      .from(challenges)
      .where(eq(challenges.id, parseInt(challengeId)))
      .limit(1);

    const challengeTitle = challenge[0]?.title || 'Challenge';

    await this.notificationService.sendNotification({
      userId,
      type: NotificationType.PAYOUT_RECEIVED,
      title: `💰 Payout Credited!`,
      message: `₦${amount.toLocaleString()} has been added to your wallet for "${challengeTitle}".`,
      icon: '💰',
      data: {
        challengeId,
        amount,
        challengeTitle,
      },
      channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED],
      fomoLevel: FOMOLevel.HIGH,
      priority: NotificationPriority.HIGH,
      deduplicationKey: `payout_delivered_${challengeId}_${userId}`,
    });
  }

  /**
   * 🏆 Trigger: Challenge Result Announced / Payout Distributed
   * 
   * Sends to: All participants
   * Urgency: HIGH
   * Channels: Push + In-App Feed + Telegram
   */
  async onChallengeCompleted(challengeId: string, winnerSide: 'YES' | 'NO' | 'DRAW'): Promise<void> {
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    if (!challenge[0]) return;

    // Get all participants
    const participants = await db
      .select({ 
        userId: challengeParticipants.userId,
        side: challengeParticipants.side,
        payoutAmount: challengeParticipants.payoutAmount
      })
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, challengeId));

    for (const participant of participants) {
      let title = '';
      let message = '';
      let icon = '';

      if (winnerSide === 'DRAW') {
        title = `🤝 Challenge Draw: ${challenge[0].title}`;
        message = `It's a draw! Your entry fee has been refunded.`;
        icon = '🤝';
      } else if (participant.side === winnerSide) {
        title = `🎉 You Won: ${challenge[0].title}!`;
        message = `Congratulations! You earned ${participant.payoutAmount} coins on the ${winnerSide} side.`;
        icon = '🏆';
      } else {
        title = `💔 Challenge Ended: ${challenge[0].title}`;
        message = `The ${winnerSide} side won. Better luck next time!`;
        icon = '📉';
      }

      await this.notificationService.sendNotification({
        userId: participant.userId,
        type: NotificationType.CHALLENGE_RESULT,
        title,
        message,
        icon,
        data: {
          challengeId: challenge[0].id,
          winnerSide,
          payoutAmount: participant.payoutAmount,
          side: participant.side,
        },
        channels: [NotificationChannel.PUSH_NOTIFICATION, NotificationChannel.IN_APP_FEED, NotificationChannel.TELEGRAM_BOT],
        fomoLevel: FOMOLevel.HIGH,
        priority: NotificationPriority.HIGH,
        deduplicationKey: `challenge_result_${challengeId}_${participant.userId}`,
      });
    }

    console.log(`✅ Challenge completion notifications sent to ${participants.length} participants`);
  }
}

export const challengeNotificationTriggers = new ChallengeNotificationTriggers();
