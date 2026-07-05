/**
 * Treasury Notifications Integration
 * Handles notifications for Treasury-funded matches and settlements
 */

import { NotificationService, NotificationEvent, NotificationChannel, NotificationPriority } from './notificationService';
import { db } from './db';
import { notifications, treasuryMatches, users } from '../shared/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const notificationService = new NotificationService();

/**
 * Notification event types specific to Treasury
 */
export enum TreasuryNotificationEvent {
  TREASURY_MATCH_CREATED = 'treasury.match.created',
  TREASURY_MATCH_WON = 'treasury.match.won',
  TREASURY_MATCH_LOST = 'treasury.match.lost',
  TREASURY_PAYOUT_SENT = 'treasury.payout.sent',
  ADMIN_TREASURY_SUMMARY = 'admin.treasury.summary',
}

/**
 * Send notification when user is matched with Treasury
 * Called immediately after creating Treasury match
 */
export async function notifyTreasuryMatchCreated(
  userId: string,
  challengeId: number,
  shadowPersonaUsername: string,
  stakeAmount: number,
  challengeTitle: string
): Promise<boolean> {
  try {
    const notificationId = uuidv4();

    // Create database record
    await db.insert(notifications).values({
      id: notificationId,
      userId,
      type: 'match.found', // Use existing MATCH_FOUND event type
      title: '⚔️ Match Found!',
      message: `You've been matched with ${shadowPersonaUsername} in "${challengeTitle}". Your stake: ₦${stakeAmount.toLocaleString()}`,
      icon: '⚔️',
      channels: ['in_app_feed', 'push_notification'],
      priority: 3, // HIGH
      data: {
        challengeId,
        matchType: 'treasury',
        shadowPersonaUsername,
        stakeAmount,
      },
      read: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    console.log(`✅ Treasury match notification sent to user ${userId}`);
    return true;
  } catch (error) {
    console.error('Error sending Treasury match notification:', error);
    return false;
  }
}

/**
 * Send notification when Treasury match is settled
 * Called when challenge resolves and payout is determined
 */
export async function notifyTreasuryMatchSettled(
  userId: string,
  challengeId: number,
  result: 'won' | 'lost',
  payout: number,
  shadowPersonaUsername: string,
  challengeTitle: string
): Promise<boolean> {
  try {
    const notificationId = uuidv4();

    const isWin = result === 'won';
    const title = isWin ? '🎉 You Won!' : '😞 You Lost';
    const icon = isWin ? '🎉' : '😞';
    const message = isWin
      ? `You won against ${shadowPersonaUsername}! Payout: ₦${payout.toLocaleString()}`
      : `You lost to ${shadowPersonaUsername} in "${challengeTitle}". Better luck next time!`;

    await db.insert(notifications).values({
      id: notificationId,
      userId,
      type: result === 'won' ? 'challenge.won' : 'challenge.lost',
      title,
      message,
      icon,
      channels: ['in_app_feed', 'push_notification'],
      priority: 3, // HIGH
      data: {
        challengeId,
        result,
        payout,
        shadowPersonaUsername,
      },
      read: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    console.log(`✅ Treasury settlement notification sent to user ${userId}`);
    return true;
  } catch (error) {
    console.error('Error sending Treasury settlement notification:', error);
    return false;
  }
}

/**
 * Send admin notification when Treasury match is created
 * (Optional: for audit trail if admin wants to know)
 */
export async function notifyAdminTreasuryMatchCreated(
  adminId: string,
  challengeId: number,
  matchCount: number,
  totalStaked: number,
  sideToFill: 'YES' | 'NO',
  shadowPersonaUsernames: string[]
): Promise<boolean> {
  try {
    const notificationId = uuidv4();

    await db.insert(notifications).values({
      id: notificationId,
      userId: adminId,
      type: 'system.notification',
      title: '💰 Treasury Matches Created',
      message: `${matchCount} Treasury matches created on ${sideToFill} side for challenge ${challengeId}. Total Treasury allocated: ₦${totalStaked.toLocaleString()}`,
      icon: '💰',
      channels: ['in_app_feed'],
      priority: 2, // MEDIUM
      data: {
        challengeId,
        matchCount,
        totalStaked,
        sideToFill,
        shadowPersonas: shadowPersonaUsernames,
      },
      read: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    console.log(`✅ Admin Treasury notification sent to ${adminId}`);
    return true;
  } catch (error) {
    console.error('Error sending admin Treasury notification:', error);
    return false;
  }
}

/**
 * Send daily Treasury summary to admin
 * Shows P&L, utilization, and pending matches
 */
export async function sendAdminTreasurySummary(
  adminId: string,
  summary: {
    totalChallenges: number;
    totalAllocated: number;
    remainingBudget: number;
    utilization: number;
    matchesCreated: number;
    matchesWon: number;
    matchesLost: number;
    matchesPending: number;
    totalWon: number;
    totalLost: number;
    netPnL: number;
  }
): Promise<boolean> {
  try {
    const notificationId = uuidv4();

    const performanceColor = summary.netPnL >= 0 ? '📈' : '📉';
    const pnLStatus = summary.netPnL >= 0 ? 'profitable' : 'at loss';

    await db.insert(notifications).values({
      id: notificationId,
      userId: adminId,
      type: 'admin.report',
      title: `${performanceColor} Daily Treasury Report`,
      message: `Treasury is ${pnLStatus}: Net P&L ₦${Math.abs(summary.netPnL).toLocaleString()}. ${summary.matchesPending} matches pending settlement.`,
      icon: performanceColor,
      channels: ['in_app_feed'],
      priority: 2, // MEDIUM
      data: {
        ...summary,
      },
      read: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    console.log(`✅ Daily Treasury summary sent to admin ${adminId}`);
    return true;
  } catch (error) {
    console.error('Error sending Treasury summary:', error);
    return false;
  }
}

/**
 * Bulk notify all users affected by a Treasury match when it's settled
 * Call after challenge resolves
 */
export async function notifyAllTreasuryMatchesSettled(
  challengeId: number,
  challengeTitle: string
): Promise<{ success: number; failed: number }> {
  try {
    const matches = await db
      .select()
      .from(treasuryMatches)
      .where(eq(treasuryMatches.challengeId, challengeId));

    let success = 0;
    let failed = 0;

    for (const match of matches) {
      const result = match.result === 'treasury_won' ? 'lost' : 'won';
      const notified = await notifyTreasuryMatchSettled(
        match.realUserId,
        challengeId,
        result,
        match.treasuryPayout || 0,
        match.shadowPersonaUserId, // Get username from user record
        challengeTitle
      );

      if (notified) success++;
      else failed++;
    }

    console.log(
      `📬 Treasury settlement notifications: ${success} sent, ${failed} failed`
    );
    return { success, failed };
  } catch (error) {
    console.error('Error notifying Treasury matches settlement:', error);
    return { success: 0, failed: 0 };
  }
}

/**
 * Export singleton instance for use in other modules
 */
export const getTreasuryNotifications = () => ({
  notifyTreasuryMatchCreated,
  notifyTreasuryMatchSettled,
  notifyAdminTreasuryMatchCreated,
  sendAdminTreasurySummary,
  notifyAllTreasuryMatchesSettled,
});
