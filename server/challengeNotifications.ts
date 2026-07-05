/**
 * Challenge Voting/Dispute Notifications
 * Handles notifications for new voting model: proofs, votes, and disputes
 */

import { NotificationService, NotificationEvent, NotificationChannel, NotificationPriority } from './notificationService';
import { pool } from './db';

const notificationService = new NotificationService();

/**
 * Notify challenged user when a new challenge is created
 */
export async function notifyChallengeCreated(
  challengeId: number,
  challengerName: string,
  challengedUserId: string,
  challengeTitle: string,
  amount: number
): Promise<void> {
  try {
    await notificationService.send({
      userId: challengedUserId,
      challengeId: String(challengeId),
      event: 'CHALLENGE_CREATED',
      title: '⚔️ New Challenge!',
      body: `${challengerName} challenged you to: ${challengeTitle}`,
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
      priority: NotificationPriority.HIGH,
      data: { challengeId, amount, from: challengerName },
    });
    console.log(`✅ Challenge created notification sent to ${challengedUserId}`);
  } catch (err) {
    console.error('Error sending challenge created notification:', err);
  }
}

/**
 * Notify both users when challenge is declined/cancelled
 */
export async function notifyChallengeCancelled(
  challengeId: number,
  cancelledByName: string,
  challengerUserId: string,
  challengedUserId: string,
  challengeTitle: string
): Promise<void> {
  try {
    // Notify challenger
    if (challengerUserId) {
      await notificationService.send({
        userId: challengerUserId,
        challengeId: String(challengeId),
        event: 'CHALLENGE_CANCELLED',
        title: '❌ Challenge Cancelled',
        body: `${cancelledByName} declined your challenge "${challengeTitle}"`,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        priority: NotificationPriority.MEDIUM,
        data: { challengeId, cancelledBy: cancelledByName },
      });
    }

    // Notify challenged
    if (challengedUserId) {
      await notificationService.send({
        userId: challengedUserId,
        challengeId: String(challengeId),
        event: 'CHALLENGE_CANCELLED',
        title: '❌ Challenge Cancelled',
        body: `${cancelledByName} cancelled the challenge "${challengeTitle}"`,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        priority: NotificationPriority.MEDIUM,
        data: { challengeId, cancelledBy: cancelledByName },
      });
    }

    console.log(`✅ Challenge cancelled notification sent`);
  } catch (err) {
    console.error('Error sending challenge cancelled notification:', err);
  }
}

/**
 * Notify counterparty when a participant uploads proof
 */
export async function notifyProofUploaded(
  challengeId: number,
  uploadedByUserId: string,
  counterpartyUserId: string,
  participantName: string
): Promise<void> {
  try {
    await notificationService.send({
      userId: counterpartyUserId,
      challengeId: String(challengeId),
      event: NotificationEvent.CHALLENGE_PROOF_UPLOADED,
      title: 'Proof Uploaded',
      body: `${participantName} uploaded their proof for the challenge.`,
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
      priority: NotificationPriority.HIGH,
      data: { challengeId, uploadedBy: uploadedByUserId },
    });
    console.log(`✅ Proof upload notification sent to ${counterpartyUserId}`);
  } catch (err) {
    console.error('Error sending proof upload notification:', err);
  }
}

/**
 * Notify challenger when their challenge is accepted
 */
export async function notifyChallengeAccepted(
  challengeId: number,
  challengerUserId: string,
  challengedName: string,
  battleId: string
): Promise<void> {
  try {
    await notificationService.send({
      userId: challengerUserId,
      challengeId: String(challengeId),
      event: 'CHALLENGE_ACCEPTED',
      title: '⚔️ Challenge Accepted!',
      body: `${challengedName} has accepted your challenge! The Arena is ready.`,
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
      priority: NotificationPriority.HIGH,
      data: { challengeId, acceptedBy: challengedName, battleId },
    });
    console.log(`✅ Challenge accepted notification sent to ${challengerUserId}`);
  } catch (err) {
    console.error('Error sending challenge accepted notification:', err);
  }
}

/**
 * Notify challenger when their challenge is declined
 */
export async function notifyChallengeDeclined(
  challengeId: number,
  challengerUserId: string,
  challengedName: string
): Promise<void> {
  try {
    await notificationService.send({
      userId: challengerUserId,
      challengeId: String(challengeId),
      event: 'CHALLENGE_DECLINED',
      title: '❌ Challenge Declined',
      body: `${challengedName} declined your challenge. Your BC stake has been refunded.`,
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
      priority: NotificationPriority.MEDIUM,
      data: { challengeId, declinedBy: challengedName },
    });
    console.log(`✅ Challenge declined notification sent to ${challengerUserId}`);
  } catch (err) {
    console.error('Error sending challenge declined notification:', err);
  }
}

/**
 * Notify counterparty when a participant submits a vote
 */
export async function notifyVoteSubmitted(
  challengeId: number,
  votedByUserId: string,
  counterpartyUserId: string,
  participantName: string
): Promise<void> {
  try {
    await notificationService.send({
      userId: counterpartyUserId,
      challengeId: String(challengeId),
      event: NotificationEvent.CHALLENGE_VOTE_SUBMITTED,
      title: 'Vote Submitted',
      body: `${participantName} submitted their vote. Submit yours to proceed.`,
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
      priority: NotificationPriority.HIGH,
      data: { challengeId, votedBy: votedByUserId },
    });
    console.log(`✅ Vote submission notification sent to ${counterpartyUserId}`);
  } catch (err) {
    console.error('Error sending vote notification:', err);
  }
}

/**
 * Notify both participants when challenge is auto-released (payout sent)
 */
export async function notifyAutoReleased(
  challengeId: number,
  winnerUserId: string,
  loserUserId: string,
  winAmount: number
): Promise<void> {
  try {
    // Notify winner
    await notificationService.send({
      userId: winnerUserId,
      challengeId: String(challengeId),
      event: NotificationEvent.CHALLENGE_AUTO_RELEASED,
      title: 'Challenge Completed!',
      body: `You won! ₦${winAmount.toLocaleString()} has been credited to your wallet.`,
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
      priority: NotificationPriority.HIGH,
      data: { challengeId, amount: winAmount, winner: true },
    });

    // Notify loser
    await notificationService.send({
      userId: loserUserId,
      challengeId: String(challengeId),
      event: NotificationEvent.CHALLENGE_AUTO_RELEASED,
      title: 'Challenge Ended',
      body: `The challenge has been settled. Better luck next time!`,
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
      priority: NotificationPriority.MEDIUM,
      data: { challengeId, winner: false },
    });
    console.log(`✅ Auto-release notifications sent to winner ${winnerUserId} and loser ${loserUserId}`);
  } catch (err) {
    console.error('Error sending auto-release notification:', err);
  }
}

/**
 * Notify both participants when a dispute is opened (votes don't match)
 */
export async function notifyDisputeOpened(
  challengeId: number,
  participant1UserId: string,
  participant2UserId: string
): Promise<void> {
  try {
    // Notify both participants
    for (const userId of [participant1UserId, participant2UserId]) {
      await notificationService.send({
        userId,
        challengeId: String(challengeId),
        event: NotificationEvent.CHALLENGE_DISPUTE_OPENED,
        title: 'Dispute Opened',
        body: `The votes don't match. An admin will review the proofs and settle this challenge.`,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        priority: NotificationPriority.HIGH,
        data: { challengeId },
      });
    }
    console.log(`✅ Dispute open notification sent to both participants`);
  } catch (err) {
    console.error('Error sending dispute open notification:', err);
  }
}

/**
 * Notify both participants when admin resolves a dispute
 */
export async function notifyDisputeResolved(
  challengeId: number,
  participant1UserId: string,
  participant2UserId: string,
  winnerUserId: string | null,
  resolution: string
): Promise<void> {
  try {
    for (const userId of [participant1UserId, participant2UserId]) {
      const isWinner = userId === winnerUserId;
      const title = isWinner ? 'Dispute Resolved - You Won!' : 'Dispute Resolved';
      const body = isWinner
        ? `Admin review complete. You won the challenge.`
        : `Admin review complete. The dispute has been settled.`;

      await notificationService.send({
        userId,
        challengeId: String(challengeId),
        event: NotificationEvent.CHALLENGE_DISPUTE_RESOLVED,
        title,
        body,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        priority: NotificationPriority.HIGH,
        data: { challengeId, resolution, isWinner },
      });
    }
    console.log(`✅ Dispute resolved notification sent to both participants`);
  } catch (err) {
    console.error('Error sending dispute resolved notification:', err);
  }
}

export const challengeNotifications = {
  notifyProofUploaded,
  notifyVoteSubmitted,
  notifyAutoReleased,
  notifyDisputeOpened,
  notifyDisputeResolved,
  notifyChallengeCreated,
  notifyChallengeCancelled,
  notifyChallengeAccepted,
  notifyChallengeDeclined,
};

/**
 * Notify admin(s) when a dispute is opened so they can review immediately
 */
export async function notifyAdminDisputeOpened(challengeId: number): Promise<void> {
  try {
    const adminsRes: any = await pool.query(`SELECT id FROM users WHERE is_admin = true`);
    const admins = adminsRes.rows || [];
    for (const a of admins) {
      await notificationService.send({
        userId: a.id,
        challengeId: String(challengeId),
        event: NotificationEvent.CHALLENGE_DISPUTE_OPENED,
        title: 'Dispute Requires Review',
        body: `A dispute has been opened for challenge ${challengeId}. Please review and resolve.`,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        priority: NotificationPriority.HIGH,
        data: { challengeId },
      });
    }
    console.log(`✅ Admin dispute notifications sent to ${admins.length} admins`);
  } catch (err) {
    console.error('Error sending admin dispute notification:', err);
  }
}
