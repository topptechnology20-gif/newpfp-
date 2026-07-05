/**
 * Treasury Settlement Worker
 * Processes Treasury match settlements when challenges are resolved
 * Called after challenge result is finalized
 */

import { db } from './db';
import { treasuryMatches, challenges, challengeParticipants, adminWalletTransactions, users } from '../shared/schema';
import { eq, and } from 'drizzle-orm';
import { notifyTreasuryMatchSettled, sendAdminTreasurySummary } from './treasuryNotifications';
import { getTreasuryDashboardSummary } from './treasuryManagement';
import { creditTreasuryWallet } from './treasuryWalletService';

/**
 * Settle a single Treasury match
 * Determine if Treasury won or lost and update records
 */
export async function settleTreasuryMatch(
  treasuryMatchId: number,
  challengeResult: boolean // true = YES wins, false = NO wins
): Promise<{
  success: boolean;
  matchId: number;
  result: 'treasury_won' | 'treasury_lost';
  payout: number;
}> {
  try {
    const match = await db
      .select()
      .from(treasuryMatches)
      .where(eq(treasuryMatches.id, treasuryMatchId))
      .limit(1);

    if (!match.length) {
      throw new Error(`Treasury match ${treasuryMatchId} not found`);
    }

    const treasuryMatch = match[0];

    // Determine if Treasury won
    // Treasury bet on the OPPOSITE side of the real user
    const treasuryBetSide = treasuryMatch.realUserSide === 'YES' ? 'NO' : 'YES';
    const treasuryWon = (treasuryBetSide === 'YES' && challengeResult) || 
                        (treasuryBetSide === 'NO' && !challengeResult);

    // Calculate payout (simplified: 2x return for winning, 0 for losing)
    // In reality, this would be based on pool calculations
    const payout = treasuryWon ? treasuryMatch.treasuryStaked * 2 : 0;
    const result = treasuryWon ? 'treasury_won' : 'treasury_lost';

    // Update the Treasury match record
    await db
      .update(treasuryMatches)
      .set({
        result,
        treasuryPayout: payout,
        settledAt: new Date(),
        status: 'settled',
      })
      .where(eq(treasuryMatches.id, treasuryMatchId));

    // Record transaction in admin wallet
    const transactionAmount = treasuryWon 
      ? payout 
      : -treasuryMatch.treasuryStaked; // Negative for loss

    await db.insert(adminWalletTransactions).values({
      adminId: 'treasury_system', // System account
      type: treasuryWon ? 'treasury_win' : 'treasury_loss',
      amount: transactionAmount,
      description: `Treasury match settlement for challenge ${treasuryMatch.challengeId}`,
      relatedId: treasuryMatch.challengeId,
      relatedType: 'treasury_match',
      status: 'completed',
      createdAt: new Date(),
    } as any);

    // Credit Treasury wallet if Treasury won
    if (treasuryWon && treasuryMatch.adminId) {
      try {
        const winAmount = payout - treasuryMatch.treasuryStaked; // Net profit
        await creditTreasuryWallet(
          treasuryMatch.adminId,
          winAmount,
          `Treasury match win settlement for challenge ${treasuryMatch.challengeId}`,
          treasuryMatch.challengeId,
          treasuryMatch.id
        );
        console.log(`✅ Credited ₦${winAmount.toLocaleString()} to admin ${treasuryMatch.adminId} Treasury wallet`);
      } catch (error) {
        console.error(`Error crediting Treasury wallet for admin ${treasuryMatch.adminId}:`, error);
        // Don't throw - settlement should still complete even if wallet credit fails
      }
    }

    // Notify user about settlement
    const challenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, treasuryMatch.challengeId))
      .limit(1);

    const challengeTitle = challenge[0]?.title || `Challenge #${treasuryMatch.challengeId}`;

    // Get shadow persona username
    const shadowUser = await db
      .select()
      .from(users)
      .where(eq(users.id, treasuryMatch.shadowPersonaUserId))
      .limit(1);
    const shadowUsername = shadowUser[0]?.username || 'Opponent';

    await notifyTreasuryMatchSettled(
      treasuryMatch.realUserId,
      treasuryMatch.challengeId,
      treasuryWon ? 'lost' : 'won', // From user's perspective, opposite of Treasury
      Math.floor(payout / 2), // Return user's stake
      shadowUsername,
      challengeTitle
    );

    return {
      success: true,
      matchId: treasuryMatchId,
      result,
      payout,
    };
  } catch (error) {
    console.error('Error settling Treasury match:', error);
    return {
      success: false,
      matchId: treasuryMatchId,
      result: 'treasury_lost',
      payout: 0,
    };
  }
}

/**
 * Settle all Treasury matches for a challenge
 * Call this when challenge result is finalized
 */
export async function settleChallengeTreasuryMatches(
  challengeId: number,
  challengeResult: boolean, // true = YES wins, false = NO wins
  adminId?: string // For admin notification
): Promise<{
  totalMatches: number;
  settled: number;
  failed: number;
  totalWon: number;
  totalLost: number;
  netProfit: number;
}> {
  try {
    // Get all Treasury matches for this challenge
    const matches = await db
      .select()
      .from(treasuryMatches)
      .where(
        and(
          eq(treasuryMatches.challengeId, challengeId),
          eq(treasuryMatches.status, 'active')
        )
      );

    let settled = 0;
    let failed = 0;
    let totalWon = 0;
    let totalLost = 0;

    for (const match of matches) {
      const result = await settleTreasuryMatch(match.id, challengeResult);
      if (result.success) {
        settled++;
        if (result.result === 'treasury_won') {
          totalWon += result.payout;
        } else {
          totalLost += match.treasuryStaked;
        }
      } else {
        failed++;
      }
    }

    const netProfit = totalWon - totalLost;

    console.log(
      `✅ Challenge #${challengeId} Treasury settlements: ${settled} settled, ${failed} failed. Net: ₦${netProfit.toLocaleString()}`
    );

    // Send admin notification about settlement batch
    if (adminId && settled > 0) {
      await sendAdminTreasurySettlementSummary(
        adminId,
        challengeId,
        settled,
        totalWon,
        totalLost,
        netProfit
      );
    }

    return {
      totalMatches: matches.length,
      settled,
      failed,
      totalWon,
      totalLost,
      netProfit,
    };
  } catch (error) {
    console.error('Error settling challenge Treasury matches:', error);
    return {
      totalMatches: 0,
      settled: 0,
      failed: 0,
      totalWon: 0,
      totalLost: 0,
      netProfit: 0,
    };
  }
}

/**
 * Send admin notification about Treasury settlement summary
 */
async function sendAdminTreasurySettlementSummary(
  adminId: string,
  challengeId: number,
  matchesSettled: number,
  totalWon: number,
  totalLost: number,
  netProfit: number
): Promise<void> {
  try {
    const { v4: uuidv4 } = await import('uuid');
    const { notifications } = await import('../shared/schema');

    const icon = netProfit >= 0 ? '📈' : '📉';
    const status = netProfit >= 0 ? 'profitable' : 'at loss';

    await db.insert(notifications).values({
      id: uuidv4(),
      userId: adminId,
      type: 'admin.settlement',
      title: `${icon} Challenge #${challengeId} Treasury Settled`,
      message: `${matchesSettled} matches settled. Treasury ${status}: ₦${Math.abs(netProfit).toLocaleString()}`,
      icon,
      channels: ['in_app_feed'],
      priority: 2,
      data: {
        challengeId,
        matchesSettled,
        totalWon,
        totalLost,
        netProfit,
      },
      read: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
  } catch (error) {
    console.error('Error sending settlement notification:', error);
  }
}

/**
 * Daily Treasury summary report for admin
 * Call this once per day to send summary metrics
 */
export async function sendDailyTreasurySummaryToAdmin(adminId: string): Promise<void> {
  try {
    const { sendAdminTreasurySummary } = await import('./treasuryNotifications');
    const { getTreasuryDashboardSummary } = await import('./treasuryManagement');

    const summary = await getTreasuryDashboardSummary();
    await sendAdminTreasurySummary(adminId, summary);

    console.log(`✅ Daily Treasury summary sent to admin ${adminId}`);
  } catch (error) {
    console.error('Error sending daily Treasury summary:', error);
  }
}
