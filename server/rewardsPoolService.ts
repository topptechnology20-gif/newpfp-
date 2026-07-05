import { eq, desc, sum, gte } from "drizzle-orm";
import { db } from "./db";
import {
  users,
  platformRewardsPools,
  platformRewardsDistributions,
  userRewardsClaims,
} from "@shared/schema";
import { fomoNotificationService } from "./notificationSystem";
import { NotificationType, NotificationChannel, FOMOLevel, NotificationPriority } from "./notificationSystem";

export class RewardsPoolService {
  /**
   * Add surplus USDC to the active rewards pot.
   * Creates a new active pot if one doesn't exist.
   */
  async addSurplusToPot(amountUsdc: number): Promise<void> {
    if (amountUsdc <= 0) return;

    let [activePool] = await db
      .select()
      .from(platformRewardsPools)
      .where(eq(platformRewardsPools.status, "active"))
      .limit(1);

    if (!activePool) {
      [activePool] = await db
        .insert(platformRewardsPools)
        .values({
          currency: "USDC",
          totalAmount: amountUsdc.toString(),
          status: "active",
        })
        .returning();
    } else {
      const newTotal = (parseFloat(activePool.totalAmount) + amountUsdc).toFixed(8);
      await db
        .update(platformRewardsPools)
        .set({
          totalAmount: newTotal,
          updatedAt: new Date(),
        })
        .where(eq(platformRewardsPools.id, activePool.id));
    }
  }

  /**
   * Run the weekly distribution of the active pot.
   * Snapshots the pot, calculates shares for users >= 10000 BC, creates claims, and resets pot.
   */
  async executeWeeklyDistribution(): Promise<any> {
    // 1. Lock/Snapshot the active pot
    const [activePool] = await db
      .select()
      .from(platformRewardsPools)
      .where(eq(platformRewardsPools.status, "active"))
      .limit(1);

    if (!activePool) {
      return { status: "no_active_pool" };
    }

    const potAmount = parseFloat(activePool.totalAmount);
    if (potAmount <= 0) {
      return { status: "empty_pot" };
    }

    // 2. Fetch eligible users (BC >= 10000)
    const MINIMUM_BC = 10000;
    const eligibleUsers = await db
      .select({
        id: users.id,
        points: users.points,
      })
      .from(users)
      .where(gte(users.points, MINIMUM_BC));

    if (eligibleUsers.length === 0) {
      return { status: "no_eligible_users" };
    }

    const totalEligibleBc = eligibleUsers.reduce((sum, u) => sum + (u.points || 0), 0);

    // 3. Mark the current pool as distributed
    await db
      .update(platformRewardsPools)
      .set({ status: "distributed", updatedAt: new Date() })
      .where(eq(platformRewardsPools.id, activePool.id));

    // 4. Create the distribution record
    const [distribution] = await db
      .insert(platformRewardsDistributions)
      .values({
        totalPot: potAmount.toString(),
        eligibleUsersCount: eligibleUsers.length,
        totalEligibleBc,
      })
      .returning();

    // 5. Calculate and insert individual user claims
    const claims = eligibleUsers.map(user => {
      const userBc = user.points || 0;
      const sharePercentage = userBc / totalEligibleBc;
      const shareAmount = potAmount * sharePercentage;
      
      return {
        userId: user.id,
        distributionId: distribution.id,
        bcSnapshot: userBc,
        shareAmountUsdc: shareAmount.toFixed(8),
        status: "pending",
      };
    });

    // Batch insert claims if there are any
    if (claims.length > 0) {
      await db.insert(userRewardsClaims).values(claims);

      // Trigger notifications for all eligible users asynchronously
      for (const claim of claims) {
        if (parseFloat(claim.shareAmountUsdc) > 0) {
          fomoNotificationService.sendNotification({
            userId: claim.userId,
            type: NotificationType.ACHIEVEMENT_UNLOCKED, // Reusing achievement unlocked for now
            title: "Rewards Pool Distribution 💰",
            message: `You received ${parseFloat(claim.shareAmountUsdc).toFixed(2)} USDC from the weekly rewards pool! Claim it on the Rewards page.`,
            actionUrl: "/points",
            channels: [NotificationChannel.IN_APP],
            priority: NotificationPriority.HIGH,
            fomoLevel: FOMOLevel.HOT,
            metadata: {
              source: "platform_rewards_pool",
              amount: claim.shareAmountUsdc
            }
          }).catch(err => console.error("Failed to send reward notification", err));
        }
      }
    }

    // 6. Create a new active pool starting at 0
    await db
      .insert(platformRewardsPools)
      .values({
        currency: "USDC",
        totalAmount: "0",
        status: "active",
      });

    return {
      status: "success",
      distributionId: distribution.id,
      potDistributed: potAmount,
      eligibleUsers: eligibleUsers.length
    };
  }

  /**
   * Get the current state of the pool and the user's estimated share.
   */
  async getRewardsPoolState(userId?: string): Promise<any> {
    const MINIMUM_BC = 10000;

    const [activePool] = await db
      .select()
      .from(platformRewardsPools)
      .where(eq(platformRewardsPools.status, "active"))
      .limit(1);

    const potAmount = activePool ? parseFloat(activePool.totalAmount) : 0;

    // Get all eligible users to calculate total BC
    const eligibleUsersResult = await db
      .select({ points: users.points })
      .from(users)
      .where(gte(users.points, MINIMUM_BC));

    let totalEligibleBc = eligibleUsersResult.reduce((sum, u) => sum + (u.points || 0), 0);

    let userState = null;
    let pendingClaims = [];

    if (userId) {
      const [user] = await db.select({ points: users.points }).from(users).where(eq(users.id, userId)).limit(1);
      const userBc = user ? (user.points || 0) : 0;
      
      const isEligible = userBc >= MINIMUM_BC;
      let estimatedShareUsdc = 0;

      if (isEligible) {
        // If the user's BC wasn't counted (e.g. they just crossed the threshold before we cached), include them.
        // Actually, the above query includes them. So we just do proportional math.
        if (totalEligibleBc === 0) totalEligibleBc = userBc; // Edge case
        const sharePercentage = userBc / totalEligibleBc;
        estimatedShareUsdc = potAmount * sharePercentage;
      }

      const bcNeeded = isEligible ? 0 : MINIMUM_BC - userBc;

      // Fetch pending claims
      pendingClaims = await db
        .select({
          id: userRewardsClaims.id,
          shareAmountUsdc: userRewardsClaims.shareAmountUsdc,
          createdAt: userRewardsClaims.createdAt,
        })
        .from(userRewardsClaims)
        .where(eq(userRewardsClaims.userId, userId))
        .where(eq(userRewardsClaims.status, "pending"));

      userState = {
        currentBc: userBc,
        isEligible,
        bcNeeded,
        estimatedShareUsdc,
        totalPendingUsdc: pendingClaims.reduce((s, c) => s + parseFloat(c.shareAmountUsdc), 0)
      };
    }

    return {
      potAmountUsdc: potAmount,
      totalEligibleBc,
      eligibleUsersCount: eligibleUsersResult.length,
      userState,
      pendingClaims
    };
  }

  /**
   * Process a user's claim to add USDC to their balance
   */
  async claimUserRewards(userId: string): Promise<any> {
    const pendingClaims = await db
      .select()
      .from(userRewardsClaims)
      .where(eq(userRewardsClaims.userId, userId))
      .where(eq(userRewardsClaims.status, "pending"));

    if (pendingClaims.length === 0) {
      return { success: false, message: "No pending rewards to claim." };
    }

    let totalUsdcToClaim = 0;
    const claimIds = [];

    for (const claim of pendingClaims) {
      totalUsdcToClaim += parseFloat(claim.shareAmountUsdc);
      claimIds.push(claim.id);
    }

    if (totalUsdcToClaim > 0) {
      // 1. Get user to update balance
      const [user] = await db.select({ balance: users.balance }).from(users).where(eq(users.id, userId)).limit(1);
      const newBalance = (parseFloat(user?.balance?.toString() || "0") + totalUsdcToClaim).toFixed(2);

      // 2. Update user balance
      await db.update(users).set({ balance: newBalance }).where(eq(users.id, userId));

      // 3. Mark claims as claimed
      for (const id of claimIds) {
        await db.update(userRewardsClaims)
          .set({ status: "claimed", claimedAt: new Date() })
          .where(eq(userRewardsClaims.id, id));
      }
    }

    return {
      success: true,
      amountClaimed: totalUsdcToClaim,
      message: `Successfully claimed ${totalUsdcToClaim.toFixed(2)} USDC`
    };
  }
}

export const rewardsPoolService = new RewardsPoolService();
