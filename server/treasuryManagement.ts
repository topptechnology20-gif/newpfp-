/**
 * Treasury Management Utility
 * Handles all Treasury-related operations for admin challenges
 */

import { db } from "./db";
import {
  challenges,
  pairQueue,
  treasuryChallenges,
  treasuryMatches,
  challengeParticipants,
  users,
} from "../shared/schema";
import { eq, and, sql } from "drizzle-orm";
import {
  generateShadowPersona,
  markPersonaUsedInChallenge,
} from "./shadowPersonaGenerator";
import { debitTreasuryWallet } from "./treasuryWalletService";

/**
 * Get imbalance metrics for a challenge
 * Returns: YES/NO stakes, total waiting users, and gap
 */
export async function getChallengeImbalance(challengeId: number) {
  try {
    // Get all participants by side
    const participants = await db
      .select({
        side: challengeParticipants.side,
        totalStake: sql<number>`COALESCE(SUM(${challengeParticipants.amount}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, challengeId))
      .groupBy(challengeParticipants.side);

    const yesData = participants.find((p) => p.side === "YES") || {
      side: "YES",
      totalStake: 0,
      count: 0,
    };
    const noData = participants.find((p) => p.side === "NO") || {
      side: "NO",
      totalStake: 0,
      count: 0,
    };

    // Calculate imbalance
    const yesTotal = Number(yesData.totalStake) || 0;
    const noTotal = Number(noData.totalStake) || 0;
    const yesCount = Number(yesData.count) || 0;
    const noCount = Number(noData.count) || 0;

    const gap = Math.abs(yesTotal - noTotal);
    const imbalancedSide = yesTotal > noTotal ? "YES" : noTotal > yesTotal ? "NO" : null;
    const imbalancedCount =
      yesTotal > noTotal ? yesCount : noTotal > yesTotal ? noCount : 0;

    // Get existing Treasury configuration
    const treasuryConfig = await db
      .select()
      .from(treasuryChallenges)
      .where(eq(treasuryChallenges.challengeId, challengeId))
      .limit(1);

    return {
      challengeId,
      yesStakes: yesTotal,
      noStakes: noTotal,
      yesCount,
      noCount,
      gap,
      imbalancedSide,
      imbalancedCount,
      totalParticipants: yesCount + noCount,
      matchRate: yesCount + noCount > 0 
        ? Math.round((Math.min(yesCount, noCount) / (yesCount + noCount)) * 100) 
        : 0,
      treasuryConfig: treasuryConfig[0] || null,
    };
  } catch (error) {
    console.error("Error calculating imbalance:", error);
    throw error;
  }
}

/**
 * Create Treasury configuration for a challenge
 * Admin sets max risk and chooses which side to fill
 */
export async function createTreasuryChallengeConfig(
  challengeId: number,
  maxTreasuryRisk: number,
  adminNotes?: string
) {
  try {
    const config = {
      challengeId,
      maxTreasuryRisk,
      totalTreasuryAllocated: 0,
      filledSide: null,
      filledCount: 0,
      status: "active" as const,
      adminNotes: adminNotes || "",
    };

    const result = await db.insert(treasuryChallenges).values(config);
    return config;
  } catch (error) {
    console.error("Error creating Treasury config:", error);
    throw error;
  }
}

/**
 * Execute Treasury match fulfillment
 * Creates Treasury-funded matches for unmatched users
 */
export async function fulfillTreasuryMatches(
  challengeId: number,
  matchCount: number,
  sideToFill: "YES" | "NO",
  adminId?: string // For admin notification
) {
  try {
    // Import notifications here to avoid circular dependencies
    const { notifyTreasuryMatchCreated, notifyAdminTreasuryMatchCreated } = await import(
      "./treasuryNotifications"
    );

    // Verify Treasury config exists and has budget
    const config = await db
      .select()
      .from(treasuryChallenges)
      .where(eq(treasuryChallenges.challengeId, challengeId))
      .limit(1);

    if (config.length === 0) {
      throw new Error(`No Treasury configuration found for challenge ${challengeId}`);
    }

    const treasuryConfig = config[0];
    const remainingBudget =
      treasuryConfig.maxTreasuryRisk - treasuryConfig.totalTreasuryAllocated;

    // Get challenge details for notifications
    const challengeData = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);
    const challengeTitle = challengeData[0]?.title || `Challenge #${challengeId}`;

    // Get unmatched users on the opposite side
    const unmatchedUsers = await db
      .select()
      .from(challengeParticipants)
      .where(
        and(
          eq(challengeParticipants.challengeId, challengeId),
          eq(challengeParticipants.side, sideToFill),
          eq(challengeParticipants.status, "active")
        )
      )
      .limit(matchCount);

    if (unmatchedUsers.length === 0) {
      throw new Error(
        `No unmatched users found on ${sideToFill} side for challenge ${challengeId}`
      );
    }

    // Create Treasury matches
    const matches: typeof treasuryMatches.$inferInsert[] = [];
    const shadowPersonaUsernames: string[] = [];
    let totalStaked = 0;

    for (const user of unmatchedUsers) {
      // Generate shadow persona
      const shadowPersona = await generateShadowPersona(challengeId);

      // Create the match record
      const matchRecord = {
        challengeId,
        shadowPersonaId: shadowPersona.shadowPersonaId,
        shadowPersonaUserId: shadowPersona.shadowPersonaUserId,
        realUserId: user.userId,
        realUserSide: sideToFill,
        treasuryStaked: user.amount,
        status: "active" as const,
      };

      matches.push(matchRecord);
      shadowPersonaUsernames.push(shadowPersona.shadowPersonaUsername);
      totalStaked += user.amount;

      // Send notification to user immediately
      await notifyTreasuryMatchCreated(
        user.userId,
        challengeId,
        shadowPersona.shadowPersonaUsername,
        user.amount,
        challengeTitle
      );

      // Verify we don't exceed budget
      if (totalStaked > remainingBudget) {
        throw new Error(
          `Treasury budget exceeded. Can only fund ${Math.floor(remainingBudget / user.amount)} more matches with ₦${remainingBudget}`
        );
      }
    }

    // Debit Treasury wallet BEFORE creating matches
    if (adminId) {
      try {
        await debitTreasuryWallet(
          adminId,
          totalStaked,
          `Created ${matches.length} Treasury matches for challenge "${challengeTitle}"`,
          challengeId
        );
      } catch (error) {
        throw new Error(`Treasury wallet error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Insert all matches
    await db.insert(treasuryMatches).values(matches);

    // Update Treasury config
    await db
      .update(treasuryChallenges)
      .set({
        totalTreasuryAllocated:
          treasuryConfig.totalTreasuryAllocated + totalStaked,
        filledSide: sideToFill,
        filledCount: treasuryConfig.filledCount + matches.length,
        filledAt: new Date(),
      })
      .where(eq(treasuryChallenges.challengeId, challengeId));

    // Send notification to admin if provided
    if (adminId) {
      await notifyAdminTreasuryMatchCreated(
        adminId,
        challengeId,
        matches.length,
        totalStaked,
        sideToFill,
        shadowPersonaUsernames
      );
    }

    return {
      success: true,
      matchesCreated: matches.length,
      totalTreasuryStaked: totalStaked,
      remainingBudget: remainingBudget - totalStaked,
      sideToFill,
    };
  } catch (error) {
    console.error("Error fulfilling Treasury matches:", error);
    throw error;
  }
}

/**
 * Get Treasury dashboard summary for admin
 */
export async function getTreasuryDashboardSummary() {
  try {
    // Get all active Treasury configurations
    const configs = await db
      .select()
      .from(treasuryChallenges)
      .where(eq(treasuryChallenges.status, "active"));

    // Get all Treasury matches and their results
    const matches = await db.select().from(treasuryMatches);

    const totalRisk = configs.reduce((sum, c) => sum + c.maxTreasuryRisk, 0);
    const totalAllocated = configs.reduce(
      (sum, c) => sum + c.totalTreasuryAllocated,
      0
    );

    const wonMatches = matches.filter((m) => m.result === "treasury_won");
    const lostMatches = matches.filter((m) => m.result === "treasury_lost");
    const pendingMatches = matches.filter((m) => !m.result);

    const totalWon = wonMatches.reduce((sum, m) => sum + (m.treasuryPayout || 0), 0);
    const totalLost = lostMatches.reduce((sum, m) => sum + m.treasuryStaked, 0);

    return {
      totalChallenges: configs.length,
      totalRiskBudget: totalRisk,
      totalAllocated,
      remainingBudget: totalRisk - totalAllocated,
      utilization: totalRisk > 0 ? Math.round((totalAllocated / totalRisk) * 100) : 0,
      matchesCreated: matches.length,
      matchesWon: wonMatches.length,
      matchesLost: lostMatches.length,
      matchesPending: pendingMatches.length,
      totalWon,
      totalLost,
      netPnL: totalWon - totalLost,
    };
  } catch (error) {
    console.error("Error getting Treasury dashboard summary:", error);
    throw error;
  }
}
