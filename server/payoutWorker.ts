import { db } from './db';
import { users, transactions, payoutEntries } from '../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { payoutQueue } from './payoutQueue';
import { storage } from './storage';

/**
 * Payout Worker - Processes payout jobs in batches
 * Runs every 5 minutes in the background
 */
export class PayoutWorker {
  private static instance: PayoutWorker;
  private intervalId: NodeJS.Timeout | null = null;
  private BATCH_SIZE = 500;

  static getInstance(): PayoutWorker {
    if (!PayoutWorker.instance) {
      PayoutWorker.instance = new PayoutWorker();
    }
    return PayoutWorker.instance;
  }

  start() {
    if (this.intervalId) {
      return;
    }

    this.intervalId = setInterval(() => {
      this.processPayoutBatches();
    }, 5 * 60 * 1000); // 5 minutes
    this.intervalId.unref?.();

    console.log('Payout worker started');
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('Payout worker stopped');
  }

  /**
   * Main processing loop
   * Gets all pending jobs and processes one batch each
   */
  async processPendingBatchesOnce() {
    await this.processPayoutBatches();
  }

  private async processPayoutBatches() {
    try {
      const pendingJobs = await payoutQueue.getPendingJobs();

      for (const job of pendingJobs) {
        if (job.status === 'queued') {
          // Start the job
          await payoutQueue.startJob(job.id);
        }

        if (job.status === 'running') {
          // Process next batch
          await this.processBatch(job.id);
        }
      }
    } catch (error) {
      console.error('Error in payout batch processing:', error);
    }
  }

  /**
   * Process a single batch of 500 entries
   */
  private async processBatch(jobId: string): Promise<void> {
    try {
      const job = await payoutQueue.getJob(jobId);
      if (!job) {
        console.error(`Job ${jobId} not found`);
        return;
      }

      // Get next batch of pending entries
      const entries = await payoutQueue.getPendingEntries(jobId, this.BATCH_SIZE);

      if (entries.length === 0) {
        // All entries processed
        await payoutQueue.completeJob(jobId);
        console.log(`✅ Payout job ${jobId} completed successfully`);
        return;
      }

      console.log(
        `Processing batch for job ${jobId}: ${entries.length} entries (total: ${job.totalWinners})`
      );

      // Process each entry in a transaction
      for (const entry of entries) {
        try {
          await this.processPayoutEntry(entry);
        } catch (error) {
          console.error(
            `Error processing payout entry ${entry.id} for user ${entry.userId}:`,
            error
          );
          await payoutQueue.markEntryFailed(entry.id, String(error));
        }
      }

      // Update progress
      const completedCount = await db
        .select()
        .from(payoutEntries)
        .where(eq(payoutEntries.jobId, jobId));

      await payoutQueue.updateJobProgress(jobId, completedCount.length);

      console.log(`Batch progress for job ${jobId}: ${completedCount.length}/${job.totalWinners}`);
    } catch (error) {
      console.error(`Error processing batch for job ${jobId}:`, error);
      await payoutQueue.failJob(jobId, String(error));
    }
  }

  /**
   * Process a single payout entry
   */
  private async processPayoutEntry(
    entry: typeof payoutEntries.$inferSelect
  ): Promise<void> {
    // Use transaction to ensure atomicity
    await db.transaction(async (tx) => {
      // Update user balance
      await tx
        .update(users)
        .set({
          coins: sql`coins + ${entry.amount}::bigint`,
        })
        .where(eq(users.id, entry.userId));

      // Create transaction record
      await tx.insert(transactions).values({
        userId: entry.userId,
        type: 'challenge_payout',
        amount: (Number(entry.amount) / 100).toFixed(2), // Convert back to decimal
        description: `Challenge payout - Job ${entry.jobId}`,
        status: 'completed',
      });

      // Mark entry as completed
      await payoutQueue.markEntryCompleted(entry.id);

      // Trigger Payout Notification
      try {
        const { challengeNotificationTriggers } = require('./challengeNotificationTriggers');
        // amount is in kobo, convert to naira for notification message
        const amountNaira = Number(entry.amount) / 100;
        await challengeNotificationTriggers.onPayoutDelivered(
          entry.userId,
          amountNaira,
          String(entry.challengeId)
        );
      } catch (notifErr) {
        console.error('Error triggering payout notification in worker:', notifErr);
      }
    });
  }

  /**
   * Manually trigger payout processing for a job
   * Used immediately after job creation
   */
  async triggerImmediate(jobId: string) {
    try {
      const job = await payoutQueue.getJob(jobId);
      if (!job) {
        console.error(`Job ${jobId} not found`);
        return;
      }

      if (job.status === 'queued') {
        await payoutQueue.startJob(jobId);
      }

      if (job.status === 'running') {
        await this.processBatch(jobId);
      }
    } catch (error) {
      console.error(`Error triggering immediate processing for job ${jobId}:`, error);
    }
  }
}

export const payoutWorker = PayoutWorker.getInstance();

// Auto-start the worker
if (process.env.VERCEL !== "1" && !process.env.VERCEL_ENV) {
  payoutWorker.start();
}
