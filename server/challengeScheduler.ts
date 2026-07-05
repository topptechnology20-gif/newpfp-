
import { storage } from './storage';
import { db } from './db';
import { challenges, notifications, pairQueue } from '../shared/schema';
import { eq, lte, and, gt, gte, lt } from 'drizzle-orm';
import { notificationInfrastructure } from './notificationInfrastructure';
import { PairingEngine } from './pairingEngine';

// Challenge lifecycle management - Auto-completes challenges when dueDate passes
export class ChallengeScheduler {
  private static instance: ChallengeScheduler;
  private intervalId: NodeJS.Timeout | null = null;
  private pairingEngine: PairingEngine;

  static getInstance(): ChallengeScheduler {
    if (!ChallengeScheduler.instance) {
      ChallengeScheduler.instance = new ChallengeScheduler();
    }
    return ChallengeScheduler.instance;
  }

  constructor() {
    this.pairingEngine = new PairingEngine(db);
  }

  start() {
    if (this.intervalId) {
      return;
    }

    // Check every 5 minutes for challenge lifecycle changes
    this.intervalId = setInterval(() => {
      this.checkChallengeLifecycle();
    }, 5 * 60 * 1000); // 5 minutes
    this.intervalId.unref?.();

    console.log('Challenge scheduler started');
  }

  async runOnce() {
    await this.checkChallengeLifecycle();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('Challenge scheduler stopped');
  }

  private async hasNotificationOfType(
    userId: string,
    type: string,
    challengeId: number
  ): Promise<boolean> {
    try {
      const recentNotifications = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.type, type)
          )
        )
        .orderBy(notifications.createdAt)
        .limit(5);

      // Check if any notification for this challenge in the past 30 minutes
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      return recentNotifications.some(
        (n) => {
          const notificationData = n.data as { challengeId?: number } | null;
          const createdAt = n.createdAt ? new Date(n.createdAt) : null;
          return (
            notificationData?.challengeId === challengeId &&
            createdAt !== null &&
            createdAt > thirtyMinutesAgo
          );
        }
      );
    } catch (error) {
      console.error(`Error checking notification history for user ${userId}:`, error);
      return false;
    }
  }

  private async checkChallengeLifecycle() {
    try {
      const now = new Date();

      // Check 1: Challenges ending in 10 minutes - send URGENT warning
      const tenMinutesLater = new Date(now.getTime() + 10 * 60 * 1000);
      const challengesEnding10Mins = await db
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.status, 'active'),
            gt(challenges.dueDate, now),
            lte(challenges.dueDate, tenMinutesLater)
          )
        );

      for (const challenge of challengesEnding10Mins) {
        // Check if we've already sent 10-minute warning for this challenge
        const hasNotification = await this.hasNotificationOfType(
          challenge.challenger || '',
          'challenge_ending_10_mins',
          challenge.id
        );

        if (!hasNotification && challenge.challenger) {
          // Send to creator
          await storage.createNotification({
            userId: challenge.challenger,
            type: 'challenge_ending_10_mins',
            title: '⏰ Challenge Ending in 10 Minutes!',
            message: `Your challenge "${challenge.title}" ends in just 10 minutes! Be ready to resolve immediately.`,
            data: {
              challengeId: challenge.id,
              title: challenge.title,
              endsAt: challenge.dueDate,
              urgency: 'critical',
            },
          });

          // Send to participants
          if (challenge.challenger) {
            await storage.createNotification({
              userId: challenge.challenger,
              type: 'challenge_ending_10_mins',
              title: '⏰ Challenge Ending in 10 Minutes!',
              message: `Your challenge "${challenge.title}" ends in 10 minutes!`,
              data: {
                challengeId: challenge.id,
                title: challenge.title,
                endsAt: challenge.dueDate,
                urgency: 'critical',
              },
            });
          }

          if (challenge.challenged) {
            await storage.createNotification({
              userId: challenge.challenged,
              type: 'challenge_ending_10_mins',
              title: '⏰ Challenge Ending in 10 Minutes!',
              message: `Your challenge "${challenge.title}" ends in 10 minutes!`,
              data: {
                challengeId: challenge.id,
                title: challenge.title,
                endsAt: challenge.dueDate,
                urgency: 'critical',
              },
            });
          }

          console.log(`Sent 10-minute warning for challenge ${challenge.id}: ${challenge.title}`);
        }
      }

      // Check 2: Challenges ending in 1 hour - send warning notification
      const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
      const challengesEnding1Hour = await db
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.status, 'active'),
            gt(challenges.dueDate, now),
            lte(challenges.dueDate, oneHourLater)
          )
        );

      for (const challenge of challengesEnding1Hour) {
        // Skip if within 10 minutes (already notified)
        if (!challenge.dueDate) continue;
        const minutesUntilDue = (new Date(challenge.dueDate).getTime() - now.getTime()) / (1000 * 60);
        if (minutesUntilDue < 10) {
          continue;
        }

        // Check if we've already sent 1-hour warning for this challenge
        const hasNotification = await this.hasNotificationOfType(
          challenge.challenger || '',
          'challenge_ending_1_hour',
          challenge.id
        );

        if (!hasNotification && challenge.challenger) {
          // Send to creator
          await storage.createNotification({
            userId: challenge.challenger,
            type: 'challenge_ending_1_hour',
            title: '⏱️ Challenge Ending in 1 Hour',
            message: `Your challenge "${challenge.title}" ends in 1 hour. Make sure you're ready to resolve it!`,
            data: {
              challengeId: challenge.id,
              title: challenge.title,
              endsAt: challenge.dueDate,
              urgency: 'high',
            },
          });

          // Send to participants
          if (challenge.challenger) {
            await storage.createNotification({
              userId: challenge.challenger,
              type: 'challenge_ending_1_hour',
              title: '⏱️ Challenge Ending in 1 Hour',
              message: `Your challenge "${challenge.title}" ends in 1 hour!`,
              data: {
                challengeId: challenge.id,
                title: challenge.title,
                endsAt: challenge.dueDate,
                urgency: 'high',
              },
            });
          }

          if (challenge.challenged) {
            await storage.createNotification({
              userId: challenge.challenged,
              type: 'challenge_ending_1_hour',
              title: '⏱️ Challenge Ending in 1 Hour',
              message: `Your challenge "${challenge.title}" ends in 1 hour!`,
              data: {
                challengeId: challenge.id,
                title: challenge.title,
                endsAt: challenge.dueDate,
                urgency: 'high',
              },
            });
          }

          console.log(`Sent 1-hour warning for challenge ${challenge.id}: ${challenge.title}`);
        }
      }

      // Check 2: Challenges that have passed their dueDate and should transition to pending_admin
      const overdueChallenge = await db
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.status, 'active'),
            lte(challenges.dueDate, now)
          )
        );

      for (const challenge of overdueChallenge) {
        // Skip if already in pending_admin or completed
        if (challenge.status === 'pending_admin' || challenge.status === 'completed') {
          continue;
        }

        // Update challenge status to pending_admin
        await db
          .update(challenges)
          .set({
            status: 'pending_admin',
          })
          .where(eq(challenges.id, challenge.id));

        // Trigger Lifecycle Notifications
        try {
          const { challengeNotificationTriggers } = await import('./challengeNotificationTriggers');
          await challengeNotificationTriggers.onChallengePendingAdmin(String(challenge.id));
        } catch (notifErr) {
          console.error('Error triggering lifecycle notifications in scheduler:', notifErr);
        }

        console.log(`Challenge ${challenge.id} marked as pending admin review: ${challenge.title}`);
      }

    } catch (error) {
      console.error('Error in challenge lifecycle check:', error);
    }

    // Check for admin challenges expiring soon or already expired
    await this.checkAdminChallengeExpiry();
  }

  /**
   * Check admin challenges for expiry warnings and auto-expire
   */
  private async checkAdminChallengeExpiry() {
    try {
      const now = new Date();

      // Check 1: Admin challenges expiring in 1 hour
      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
      const twoHoursFromNow = new Date(now.getTime() + 120 * 60 * 1000);

      const adminChallenges1Hour = await db
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.status, 'open'),
            eq(challenges.adminCreated, true),
            gt(challenges.dueDate, oneHourFromNow),
            lt(challenges.dueDate, twoHoursFromNow)
          )
        );

      for (const challenge of adminChallenges1Hour) {
        try {
          await notificationInfrastructure.handleChallengeExpiringIn1Hour(
            challenge.id.toString(),
            challenge.title || 'Challenge'
          );
          console.log(`[Scheduler] 1-hour expiry warning sent for challenge ${challenge.id}`);
        } catch (error) {
          console.error(`[Scheduler] Error sending 1-hour warning for challenge ${challenge.id}:`, error);
        }
      }

      // Check 2: Admin challenges expiring in 10 minutes
      const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
      const fifteenMinutesFromNow = new Date(now.getTime() + 15 * 60 * 1000);

      const adminChallenges10Mins = await db
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.status, 'open'),
            eq(challenges.adminCreated, true),
            gt(challenges.dueDate, tenMinutesFromNow),
            lt(challenges.dueDate, fifteenMinutesFromNow)
          )
        );

      for (const challenge of adminChallenges10Mins) {
        try {
          await notificationInfrastructure.handleChallengeExpiringIn10Minutes(
            challenge.id.toString(),
            challenge.title || 'Challenge'
          );
          console.log(`[Scheduler] 10-minute expiry warning sent for challenge ${challenge.id}`);
        } catch (error) {
          console.error(`[Scheduler] Error sending 10-minute warning for challenge ${challenge.id}:`, error);
        }
      }

      // Check 3: Auto-expire past-due admin challenges
      const overdueAdminChallenges = await db
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.status, 'open'),
            eq(challenges.adminCreated, true),
            lt(challenges.dueDate, now)
          )
        );

      for (const challenge of overdueAdminChallenges) {
        try {
          const result = await this.pairingEngine.expireChallenge(challenge.id.toString());
          if (result.success) {
            console.log(`[Scheduler] Admin challenge ${challenge.id} auto-expired. Refunded ${result.refundedCount} users`);
          }
        } catch (error) {
          console.error(`[Scheduler] Error auto-expiring challenge ${challenge.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[Scheduler] Error in checkAdminChallengeExpiry:', error);
    }
  }
}

// Auto-start the scheduler
if (process.env.VERCEL !== "1" && !process.env.VERCEL_ENV) {
  ChallengeScheduler.getInstance().start();
}

export const challengeScheduler = ChallengeScheduler.getInstance();
