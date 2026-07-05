import { db } from './db';
import { payoutJobs, payoutEntries, challenges } from '../shared/schema';
import { eq, and, lte } from 'drizzle-orm';

/**
 * Payout Queue Management System
 * Handles creation and tracking of payout jobs for batched processing
 */
export class PayoutQueue {
  private static instance: PayoutQueue;
  private payoutTablesAvailable = true;

  static getInstance(): PayoutQueue {
    if (!PayoutQueue.instance) {
      PayoutQueue.instance = new PayoutQueue();
    }
    return PayoutQueue.instance;
  }

  /**
   * Create a new payout job for a challenge
   * @param challengeId Challenge ID
   * @param winners Array of {userId, amount}
   * @returns Created job ID
   */
  async createPayoutJob(
    challengeId: number,
    winners: Array<{ userId: string; amount: number }>,
    totalPool: number,
    platformFee: number
  ): Promise<string> {
    try {
      // Insert job
      const job = await db
        .insert(payoutJobs)
        .values({
          challengeId,
          totalWinners: winners.length,
          totalPool: BigInt(totalPool),
          platformFee: BigInt(platformFee),
          status: 'queued',
        })
        .returning({ id: payoutJobs.id });

      if (!job[0]) {
        throw new Error('Failed to create payout job');
      }

      const jobId = job[0].id;

      // Insert payout entries
      const entries = winners.map((winner) => ({
        jobId,
        userId: winner.userId,
        amount: BigInt(winner.amount),
        status: 'pending' as const,
      }));

      await db.insert(payoutEntries).values(entries);

      console.log(
        `Created payout job ${jobId} for challenge ${challengeId} with ${winners.length} winners`
      );

      return jobId;
    } catch (error) {
      console.error('Error creating payout job:', error);
      throw error;
    }
  }

  /**
   * Get a job by ID
   */
  async getJob(jobId: string) {
    try {
      const job = await db
        .select()
        .from(payoutJobs)
        .where(eq(payoutJobs.id, jobId));

      return job[0];
    } catch (error) {
      console.error(`Error getting job ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Get pending entries for a job
   * @param jobId Job ID
   * @param limit Maximum number of entries to return
   */
  async getPendingEntries(jobId: string, limit: number = 500) {
    try {
      const entries = await db
        .select()
        .from(payoutEntries)
        .where(
          and(
            eq(payoutEntries.jobId, jobId),
            eq(payoutEntries.status, 'pending')
          )
        )
        .limit(limit);

      return entries;
    } catch (error) {
      console.error(`Error getting pending entries for job ${jobId}:`, error);
      return [];
    }
  }

  /**
   * Mark entry as completed
   */
  async markEntryCompleted(entryId: string) {
    try {
      await db
        .update(payoutEntries)
        .set({ status: 'completed', processedAt: new Date() })
        .where(eq(payoutEntries.id, entryId));
    } catch (error) {
      console.error(`Error marking entry ${entryId} as completed:`, error);
      throw error;
    }
  }

  /**
   * Mark entry as failed
   */
  async markEntryFailed(entryId: string, error: string) {
    try {
      await db
        .update(payoutEntries)
        .set({ status: 'failed', processedAt: new Date() })
        .where(eq(payoutEntries.id, entryId));
    } catch (err) {
      console.error(`Error marking entry ${entryId} as failed:`, err);
    }
  }

  /**
   * Update job progress
   */
  async updateJobProgress(jobId: string, processedCount: number) {
    try {
      await db
        .update(payoutJobs)
        .set({ processedWinners: processedCount })
        .where(eq(payoutJobs.id, jobId));
    } catch (error) {
      console.error(`Error updating job progress for ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Mark job as running
   */
  async startJob(jobId: string) {
    try {
      await db
        .update(payoutJobs)
        .set({ status: 'running' })
        .where(eq(payoutJobs.id, jobId));

      console.log(`Job ${jobId} started`);
    } catch (error) {
      console.error(`Error starting job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Mark job as completed
   */
  async completeJob(jobId: string) {
    try {
      await db
        .update(payoutJobs)
        .set({
          status: 'completed',
          completedAt: new Date(),
        })
        .where(eq(payoutJobs.id, jobId));

      console.log(`Job ${jobId} completed`);
    } catch (error) {
      console.error(`Error completing job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Mark job as failed
   */
  async failJob(jobId: string, errorMessage: string) {
    try {
      await db
        .update(payoutJobs)
        .set({
          status: 'failed',
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(payoutJobs.id, jobId));

      console.error(`Job ${jobId} failed: ${errorMessage}`);
    } catch (error) {
      console.error(`Error failing job ${jobId}:`, error);
    }
  }

  /**
   * Get all pending jobs
   */
  async getPendingJobs() {
    if (!this.payoutTablesAvailable) {
      return [];
    }

    try {
      const jobs = await db
        .select()
        .from(payoutJobs)
        .where(eq(payoutJobs.status, 'queued'));

      return jobs;
    } catch (error: any) {
      if (error?.code === '42P01') {
        this.payoutTablesAvailable = false;
        console.warn('[db] payout_jobs table is missing; payout worker will stay idle until migrations are applied.');
        return [];
      }

      console.error('Error getting pending jobs:', error);
      return [];
    }
  }

  /**
   * Get job status with progress
   */
  async getJobStatus(jobId: string) {
    try {
      const job = await this.getJob(jobId);
      if (!job) return null;

      const completedCount = await db
        .select()
        .from(payoutEntries)
        .where(
          and(
            eq(payoutEntries.jobId, jobId),
            eq(payoutEntries.status, 'completed')
          )
        );

      return {
        id: job.id,
        challengeId: job.challengeId,
        status: job.status,
        totalWinners: job.totalWinners,
        processedWinners: job.processedWinners || 0,
        completedCount: completedCount.length,
        progress: job.totalWinners > 0 ? (job.processedWinners || 0) / job.totalWinners : 0,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        error: job.error,
      };
    } catch (error) {
      console.error(`Error getting job status for ${jobId}:`, error);
      return null;
    }
  }
}

export const payoutQueue = PayoutQueue.getInstance();
