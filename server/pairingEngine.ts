/**
 * PAIRING ENGINE - Deterministic matching for challenges
 * 
 * Model: Uber/Bolt-style FCFS with stake tolerance (±20%)
 * Features:
 * - Atomic transactions with row-level locking (FOR UPDATE)
 * - First-come-first-serve queue ordering by timestamp
 * - Stake tolerance matching: ±20% range
 * - No race conditions, no double matches
 * - Immediate escrow locking on match
 * - Event emissions for notifications
 */

import { db } from "./db";
import { eq, and, isNull, gte, lte, asc, not } from "drizzle-orm";
import { pairQueue, challenges, escrow } from "../shared/schema";
import { notificationInfrastructure } from "./notificationInfrastructure";

interface MatchResult {
  success: boolean;
  message: string;
  match?: {
    user1Id: string;
    user2Id: string;
    challengeId: string;
    amount: number;
    escrowId: number;
    user1DisplayName?: string;
    user2DisplayName?: string;
  };
  queuePosition?: number;
}

interface JoinChallengeOptions {
  participantType?: "human" | "agent";
  agentId?: string | null;
  participantLabel?: string | null;
}

type Database = typeof db;

export class PairingEngine {
  constructor(private database: Database = db) {}

  /**
   * Join a challenge queue (YES or NO side)
   * Returns immediately with queue position or match
   */
  async joinChallenge(
    userId: string,
    challengeId: string,
    side: "YES" | "NO",
    stakeAmount: number,
    options: JoinChallengeOptions = {},
  ): Promise<MatchResult> {
    try {
      const participantType =
        options.participantType === "agent" && options.agentId ? "agent" : "human";
      const participantAgentId = participantType === "agent" ? String(options.agentId || "") : null;
      const participantLabel =
        typeof options.participantLabel === "string" && options.participantLabel.trim().length > 0
          ? options.participantLabel.trim()
          : null;
      // Convert string challengeId to numeric for database queries
      const numericChallengeId = parseInt(challengeId, 10);
      if (isNaN(numericChallengeId)) {
        throw new Error("Invalid challenge ID format");
      }

      // Use transaction for atomicity
      const result = await this.database.transaction(async (tx) => {
        // Step 1: Verify challenge exists and is open
        const [challenge] = await tx
          .select()
          .from(challenges)
          .where(eq(challenges.id, numericChallengeId));

        if (!challenge || challenge.status !== "open") {
          throw new Error("Challenge not open for joining");
        }

        // Step 2: Verify user hasn't already joined this challenge
        const existingQueueConditions = [
          eq(pairQueue.challengeId, numericChallengeId),
          isNull(pairQueue.matchedWith),
        ];

        if (participantType === "agent" && participantAgentId) {
          existingQueueConditions.push(eq(pairQueue.agentId, participantAgentId));
        } else {
          existingQueueConditions.push(eq(pairQueue.userId, userId));
        }

        const existingQueue = await tx
          .select()
          .from(pairQueue)
          .where(and(...existingQueueConditions));

        if (existingQueue.length > 0) {
          throw new Error("User already in queue for this challenge");
        }

        // Step 3: Find opponent (FCFS with stake tolerance ±20%)
        const oppositeSide = side === "YES" ? "NO" : "YES";
        const minStake = Math.floor(stakeAmount * 0.8); // -20%
        const maxStake = Math.ceil(stakeAmount * 1.2); // +20%

        // Lock and fetch opponent (FOR UPDATE ensures atomicity)
        const [opponent] = await tx
          .select()
          .from(pairQueue)
          .where(
            and(
              eq(pairQueue.challengeId, numericChallengeId),
              eq(pairQueue.side, oppositeSide),
              eq(pairQueue.status, "waiting"),
              isNull(pairQueue.matchedWith),
              gte(pairQueue.stakeAmount, minStake),
              lte(pairQueue.stakeAmount, maxStake)
            )
          )
          .orderBy(asc(pairQueue.createdAt)) // FCFS order
          .limit(1)
          .for("update"); // Row lock for atomicity

        // Step 4: If opponent found, match both users
        if (opponent) {
          const matchTime = new Date();
          const opponentParticipantType =
            String(opponent.participantType || "").trim().toLowerCase() === "agent" && opponent.agentId
              ? "agent"
              : "human";
          const opponentDisplayName =
            opponentParticipantType === "agent" && opponent.agentId
              ? `Agent ${String(opponent.agentId).slice(0, 6)}`
              : `User #${opponent.userId.slice(-6)}`;
          const joiningDisplayName =
            participantType === "agent" && participantLabel
              ? participantLabel
              : participantType === "agent" && participantAgentId
                ? `Agent ${participantAgentId.slice(0, 6)}`
                : `User #${userId.slice(-6)}`;

          // Update opponent: mark as matched
          await tx
            .update(pairQueue)
            .set({
              status: "matched",
              matchedWith: userId,
              matchedAt: matchTime,
            })
            .where(eq(pairQueue.id, opponent.id));

          // Add joining user to queue as already matched
          const [addedUser] = await tx
            .insert(pairQueue)
            .values({
              challengeId: numericChallengeId,
              userId,
              participantType,
              agentId: participantAgentId,
              side,
              stakeAmount,
              status: "matched",
              matchedWith: opponent.userId,
              createdAt: new Date(),
              matchedAt: matchTime,
            })
            .returning();

          // Step 5: Lock escrow for both users atomically
          const escrowAmounts = [opponent.stakeAmount, stakeAmount];
          const escrowIds = [];

          for (const amount of escrowAmounts) {
            const [escrowRecord] = await tx
              .insert(escrow)
              .values({
                challengeId: numericChallengeId,
                amount,
                status: "holding",
                createdAt: matchTime,
              })
              .returning();

            escrowIds.push(escrowRecord.id);
          }

          // Step 6: Update challenge stake totals
          const updateData: any = {};
          if (side === "YES") {
            updateData.yesStakeTotal = (challenge.yesStakeTotal || 0) + stakeAmount;
            updateData.noStakeTotal = (challenge.noStakeTotal || 0) + opponent.stakeAmount;
          } else {
            updateData.noStakeTotal = (challenge.noStakeTotal || 0) + stakeAmount;
            updateData.yesStakeTotal = (challenge.yesStakeTotal || 0) + opponent.stakeAmount;
          }

          const applyAgentChallengeMetadata = (
            participantSide: "YES" | "NO",
            kind: "human" | "agent",
            agentIdValue?: string | null,
          ) => {
            if (kind !== "agent" || !agentIdValue) return;
            updateData.agentInvolved = true;
            if (participantSide === "YES" && !challenge.challengerAgentId) {
              updateData.challengerType = "agent";
              updateData.challengerAgentId = agentIdValue;
            }
            if (participantSide === "NO" && !challenge.challengedAgentId) {
              updateData.challengedType = "agent";
              updateData.challengedAgentId = agentIdValue;
            }
          };

          applyAgentChallengeMetadata(side, participantType, participantAgentId);
          applyAgentChallengeMetadata(opponent.side as "YES" | "NO", opponentParticipantType, opponent.agentId);

          await tx.update(challenges).set(updateData).where(eq(challenges.id, numericChallengeId));

          return {
            success: true,
            message: "Match found!",
            match: {
              user1Id: opponent.userId,
              user2Id: userId,
              challengeId: numericChallengeId,
              amount: stakeAmount + opponent.stakeAmount,
              escrowId: escrowIds[0],
              user1DisplayName: opponentDisplayName,
              user2DisplayName: joiningDisplayName,
            },
          };
        }

        // Step 7: No opponent found, add to queue
        const [queueEntry] = await tx
          .insert(pairQueue)
          .values({
            challengeId: numericChallengeId,
            userId,
            participantType,
            agentId: participantAgentId,
            side,
            stakeAmount,
            status: "waiting",
            createdAt: new Date(),
          })
          .returning();

        if (participantType === "agent" && participantAgentId) {
          const challengeUpdate: Record<string, unknown> = {
            agentInvolved: true,
          };
          if (side === "YES" && !challenge.challengerAgentId) {
            challengeUpdate.challengerType = "agent";
            challengeUpdate.challengerAgentId = participantAgentId;
          }
          if (side === "NO" && !challenge.challengedAgentId) {
            challengeUpdate.challengedType = "agent";
            challengeUpdate.challengedAgentId = participantAgentId;
          }
          await tx.update(challenges).set(challengeUpdate).where(eq(challenges.id, numericChallengeId));
        }

        // Get queue position
        const queuePosition = await tx
          .select()
          .from(pairQueue)
          .where(
            and(
              eq(pairQueue.challengeId, numericChallengeId),
              eq(pairQueue.side, side),
              eq(pairQueue.status, "waiting")
            )
          )
          .orderBy(asc(pairQueue.createdAt));

        const position = queuePosition.findIndex((q) => q.id === queueEntry.id) + 1;

        return {
          success: true,
          message: `Added to ${side} queue`,
          queuePosition: position,
        };
      });

      // After transaction: Fire notifications
      if (result.match) {
        try {
          await notificationInfrastructure.handleMatchFound(
            String(result.match.challengeId),
            result.match.user1Id,
            result.match.user2Id,
            result.match.user1DisplayName || `User #${result.match.user1Id.slice(-6)}`,
            result.match.user2DisplayName || `User #${result.match.user2Id.slice(-6)}`,
            result.match.amount
          );
        } catch (notifError) {
          console.error("Notification error (not critical):", notifError);
        }
      } else {
        // User added to queue (not matched), notify them
        try {
          await notificationInfrastructure.handleQueueAdded(
            String(numericChallengeId),
            userId,
            side,
            stakeAmount,
            result.queuePosition || 1
          );
        } catch (notifError) {
          console.error("Queue notification error (not critical):", notifError);
        }
      }

      return result;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Join failed",
      };
    }
  }

  /**
   * Cancel user's entry from queue
   * Only works if not yet matched
   */
  async cancelFromQueue(userId: string, challengeId: string): Promise<MatchResult> {
    try {
      // Convert challengeId to numeric to match pair_queue.challenge_id type
      const challengeIdNum = parseInt(challengeId, 10);
      if (isNaN(challengeIdNum)) {
        throw new Error("Invalid challenge ID format");
      }

      const result = await this.database.transaction(async (tx) => {
        // Find waiting entry
        const [entry] = await tx
          .select()
          .from(pairQueue)
          .where(
            and(
              eq(pairQueue.userId, userId),
              eq(pairQueue.challengeId, challengeIdNum),
              eq(pairQueue.status, "waiting")
            )
          )
          .for("update");

        if (!entry) {
          throw new Error("No waiting queue entry found");
        }

        // Update status to cancelled
        await tx
          .update(pairQueue)
          .set({ status: "cancelled" })
          .where(eq(pairQueue.id, entry.id));

        return {
          success: true,
          message: "Removed from queue",
          stakeAmount: entry.stakeAmount,
          side: entry.side,
        };
      });

      // After transaction: Refund stake and send notification
      if (result.success) {
        try {
          // Create refund transaction
          const storage = require('./storage').storage;
          await storage.createTransaction({
            userId: userId,
            type: 'challenge_queue_refund',
            amount: `+${(result as any).stakeAmount}`,
            description: `Queue cancellation refund (Challenge #${challengeId})`,
            relatedId: challengeId,
            status: 'completed',
          });

          // Send notification about refund
          await notificationInfrastructure.handleQueueCancelled(
            challengeId,
            userId,
            (result as any).side,
            (result as any).stakeAmount
          );
        } catch (notifError) {
          console.error("Refund/notification error (not critical):", notifError);
        }
      }

      return result;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Cancellation failed",
      };
    }
  }

  /**
   * Expire a challenge: refund all unmatched users and close the challenge
   */
  async expireChallenge(challengeId: string): Promise<{ success: boolean; message: string; refundedCount: number }> {
    try {
      // Convert string challengeId to numeric for challenges and pair_queue
      const numericChallengeId = parseInt(challengeId, 10);
      if (isNaN(numericChallengeId)) {
        throw new Error("Invalid challenge ID format");
      }

      const result = await this.database.transaction(async (tx) => {
        // Get all waiting queue entries for this challenge
        const waitingEntries = await tx
          .select()
          .from(pairQueue)
            .where(
            and(
              eq(pairQueue.challengeId, numericChallengeId),
              eq(pairQueue.status, "waiting")
            )
          );

        // Update challenge status to closed/expired
        await tx
          .update(challenges)
          .set({ status: "completed" })
          .where(eq(challenges.id, numericChallengeId));

        // Trigger lifecycle notification for cancellation/expiry
        try {
          const { challengeNotificationTriggers } = require('./challengeNotificationTriggers');
          await challengeNotificationTriggers.onChallengeCancelled(String(numericChallengeId), 'Challenge expired before being matched');
        } catch (notifErr) {
          console.error('Error triggering cancellation notification in expireChallenge:', notifErr);
        }

        return {
          success: true,
          refundedCount: waitingEntries.length,
          entries: waitingEntries,
        };
      });

      // After transaction: Refund each user and send notifications
      if (result.success && (result as any).entries.length > 0) {
        try {
          const storage = require('./storage').storage;
          const refundMap = new Map<string, number>();

          for (const entry of (result as any).entries) {
            // Create refund transaction for each user
            await storage.createTransaction({
              userId: entry.userId,
              type: 'challenge_expired_refund',
              amount: `+${entry.stakeAmount}`,
              description: `Challenge expired refund (Challenge #${challengeId})`,
              relatedId: challengeId,
              status: 'completed',
            });

            refundMap.set(entry.userId, entry.stakeAmount);
          }

          // Get challenge title for notification
          const [challenge] = await this.database
            .select()
            .from(challenges)
            .where(eq(challenges.id, numericChallengeId));

          // Refund admin bonus if exists (challenge expired before anyone joined)
          if (challenge && challenge.bonusAmount && challenge.bonusAmount > 0) {
            try {
              await storage.refundBonusToAdmin(numericChallengeId, challenge, 'expired');
            } catch (bonusRefundError) {
              console.error("Bonus refund error:", bonusRefundError);
            }
          }

          // Send notifications to all refunded users
          await notificationInfrastructure.handleChallengeExpired(
            challengeId,
            challenge?.title || 'Challenge',
            refundMap
          );
        } catch (notifError) {
          console.error("Refund/notification error (not critical):", notifError);
        }
      }

      return {
        success: true,
        message: `Challenge expired. ${(result as any).refundedCount} users refunded.`,
        refundedCount: (result as any).refundedCount,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Expiry processing failed",
        refundedCount: 0,
      };
    }
  }

  /**
   * Get queue status for a challenge side
   */
  async getQueueStatus(challengeId: string, side: "YES" | "NO") {
    const numericId = parseInt(challengeId, 10);
    if (isNaN(numericId)) {
      throw new Error("Invalid challenge ID format");
    }

    const waiting = await this.database
      .select()
      .from(pairQueue)
      .where(
        and(
          eq(pairQueue.challengeId, numericId),
          eq(pairQueue.side, side),
          eq(pairQueue.status, "waiting")
        )
      )
      .orderBy(asc(pairQueue.createdAt));

    return {
      side,
      waitingCount: waiting.length,
      queue: waiting,
    };
  }

  /**
   * Get user's status in a challenge
   */
  async getUserStatus(userId: string, challengeId: string) {
    const numericId2 = parseInt(challengeId, 10);
    if (isNaN(numericId2)) {
      throw new Error("Invalid challenge ID format");
    }

    const entries = await this.database
      .select()
      .from(pairQueue)
      .where(
        and(
          eq(pairQueue.userId, userId),
          eq(pairQueue.challengeId, numericId2)
        )
      );

    if (entries.length === 0) {
      return { status: "not_joined" };
    }

    const entry = entries[0];
    return {
      status: entry.status,
      side: entry.side,
      stakeAmount: entry.stakeAmount,
      matchedWith: entry.matchedWith,
      matchedAt: entry.matchedAt,
      joinedAt: entry.createdAt,
    };
  }

  /**
   * Get challenge overview (queue stats)
   */
  async getChallengeOverview(challengeId: string) {
    const numericChallengeId = parseInt(challengeId, 10);
    if (isNaN(numericChallengeId)) {
      throw new Error("Invalid challenge ID format");
    }

    const yesQueue = await this.getQueueStatus(challengeId, "YES");
    const noQueue = await this.getQueueStatus(challengeId, "NO");

    const [challengeData] = await this.database
      .select()
      .from(challenges)
      .where(eq(challenges.id, numericChallengeId));

    return {
      challenge: challengeData,
      yesQueue: yesQueue.waitingCount,
      noQueue: noQueue.waitingCount,
      yesStakeTotal: challengeData?.yesStakeTotal || 0,
      noStakeTotal: challengeData?.noStakeTotal || 0,
    };
  }
}

/**
 * Factory for creating PairingEngine instance
 */
export function createPairingEngine(db: Database): PairingEngine {
  return new PairingEngine(db);
}
