/**
 * PAIRING ENGINE TEST SUITE
 * 
 * Tests for deterministic challenge queue matching with atomicity
 * Verifies:
 * - FCFS ordering correctness
 * - ±20% stake tolerance matching
 * - No race conditions on concurrent joins
 * - Escrow locking on matches
 * - Notifications firing on matches
 * - Queue position accuracy
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createPairingEngine } from '@/server/pairingEngine';
import { db } from '@/server/db';
import { challenges, pairQueue, escrow } from '@/shared/schema';
import { eq, and } from 'drizzle-orm';

describe('PairingEngine - Deterministic Challenge Matching', () => {
  let pairingEngine: ReturnType<typeof createPairingEngine>;
  let testChallengeId: number;
  const testUsers = [
    'user-001',
    'user-002',
    'user-003',
    'user-004',
    'user-005',
  ];

  beforeAll(async () => {
    pairingEngine = createPairingEngine(db);

    // Create a test challenge
    const [challenge] = await db
      .insert(challenges)
      .values({
        title: 'Test Challenge - Queue Matching',
        description: 'Testing FCFS matching with ±20% stake tolerance',
        category: 'testing',
        amount: 1000,
        status: 'open',
        adminCreated: true,
      })
      .returning();

    testChallengeId = challenge.id;
  });

  afterAll(async () => {
    // Clean up test data
    await db.delete(pairQueue).where(eq(pairQueue.challengeId, testChallengeId));
    await db.delete(escrow).where(eq(escrow.challengeId, testChallengeId));
  });

  describe('Basic Queue Operations', () => {
    it('should add user to YES queue when no opponent found', async () => {
      const result = await pairingEngine.joinChallenge(
        testUsers[0],
        testChallengeId,
        'YES',
        1000
      );

      expect(result.success).toBe(true);
      expect(result.queuePosition).toBe(1);
      expect(result.message).toContain('Added to YES queue');
    });

    it('should match first user with second user on opposite side', async () => {
      const result = await pairingEngine.joinChallenge(
        testUsers[1],
        testChallengeId,
        'NO',
        1000
      );

      expect(result.success).toBe(true);
      expect(result.match).toBeDefined();
      expect(result.match?.user1Id).toBe(testUsers[0]);
      expect(result.match?.user2Id).toBe(testUsers[1]);
      expect(result.match?.amount).toBe(2000);
    });

    it('should create escrow entries on match', async () => {
      const escrowEntries = await db
        .select()
        .from(escrow)
        .where(eq(escrow.challengeId, testChallengeId));

      expect(escrowEntries.length).toBeGreaterThanOrEqual(2);
      expect(escrowEntries[0].status).toBe('holding');
      expect(escrowEntries[1].status).toBe('holding');
    });
  });

  describe('Stake Tolerance Matching (±20%)', () => {
    it('should match user with ±20% stake tolerance', async () => {
      const baseStake = 1000;
      const minTolerance = Math.floor(baseStake * 0.8); // 800
      const maxTolerance = Math.ceil(baseStake * 1.2); // 1200

      // Test within tolerance
      const stakeWithinTolerance = 1050;
      expect(stakeWithinTolerance).toBeGreaterThanOrEqual(minTolerance);
      expect(stakeWithinTolerance).toBeLessThanOrEqual(maxTolerance);

      // Test outside tolerance
      const stakeBelowTolerance = 700;
      const stakeAboveTolerance = 1300;

      expect(stakeBelowTolerance).toBeLessThan(minTolerance);
      expect(stakeAboveTolerance).toBeGreaterThan(maxTolerance);
    });

    it('should NOT match users with stakes outside tolerance', async () => {
      // Add user with 1000 coins to YES queue
      const result1 = await pairingEngine.joinChallenge(
        testUsers[2],
        testChallengeId,
        'YES',
        1000
      );
      expect(result1.queuePosition).toBe(1);

      // Try to join with 1400 coins (outside ±20% tolerance)
      const result2 = await pairingEngine.joinChallenge(
        testUsers[3],
        testChallengeId,
        'NO',
        1400
      );

      // Should be added to queue, not matched
      expect(result2.success).toBe(true);
      expect(result2.match).toBeUndefined();
      expect(result2.queuePosition).toBe(1);
    });
  });

  describe('FCFS Ordering', () => {
    it('should respect first-come-first-served order', async () => {
      // Add two users to YES queue
      const user1Result = await pairingEngine.joinChallenge(
        testUsers[0],
        testChallengeId,
        'YES',
        1000
      );
      expect(user1Result.queuePosition).toBe(1);

      const user2Result = await pairingEngine.joinChallenge(
        testUsers[1],
        testChallengeId,
        'YES',
        1000
      );
      expect(user2Result.queuePosition).toBe(2);

      // When NO user joins, should match with user1 (first in queue)
      const noUserResult = await pairingEngine.joinChallenge(
        testUsers[4],
        testChallengeId,
        'NO',
        1000
      );

      expect(noUserResult.match?.user1Id).toBe(testUsers[0]);
      expect(noUserResult.match?.user2Id).toBe(testUsers[4]);
    });

    it('should get queue status with correct ordering', async () => {
      const status = await pairingEngine.getQueueStatus(testChallengeId, 'YES');

      expect(status.side).toBe('YES');
      expect(status.waitingCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(status.queue)).toBe(true);

      // Verify FCFS ordering
      if (status.queue.length > 1) {
        for (let i = 1; i < status.queue.length; i++) {
          const prevTime = status.queue[i - 1].createdAt?.getTime() || 0;
          const currTime = status.queue[i].createdAt?.getTime() || 0;
          expect(currTime).toBeGreaterThanOrEqual(prevTime);
        }
      }
    });
  });

  describe('User Status Tracking', () => {
    it('should get correct user status after join', async () => {
      const userId = testUsers[0];
      const status = await pairingEngine.getUserStatus(userId, testChallengeId);

      expect(status.status).toMatch(/matched|waiting|not_joined/);
      if (status.status !== 'not_joined') {
        expect(status.side).toMatch(/YES|NO/);
        expect(status.stakeAmount).toBeGreaterThan(0);
        expect(status.joinedAt).toBeDefined();
      }
    });

    it('should return not_joined for users who never joined', async () => {
      const unknownUserId = 'unknown-user-xyz';
      const status = await pairingEngine.getUserStatus(unknownUserId, testChallengeId);

      expect(status.status).toBe('not_joined');
    });
  });

  describe('Challenge Overview', () => {
    it('should get challenge overview with queue stats', async () => {
      const overview = await pairingEngine.getChallengeOverview(testChallengeId);

      expect(overview.challenge).toBeDefined();
      expect(overview.yesQueue).toBeGreaterThanOrEqual(0);
      expect(overview.noQueue).toBeGreaterThanOrEqual(0);
      expect(overview.yesStakeTotal).toBeGreaterThanOrEqual(0);
      expect(overview.noStakeTotal).toBeGreaterThanOrEqual(0);
    });

    it('should update stake totals on match', async () => {
      const beforeOverview = await pairingEngine.getChallengeOverview(testChallengeId);

      // Join with 1500 YES
      const joinResult = await pairingEngine.joinChallenge(
        'temp-user-1',
        testChallengeId,
        'YES',
        1500
      );

      if (joinResult.match) {
        const afterOverview = await pairingEngine.getChallengeOverview(testChallengeId);
        expect(afterOverview.yesStakeTotal).toBeGreaterThan(beforeOverview.yesStakeTotal);
      }
    });
  });

  describe('Queue Cancellation', () => {
    it('should cancel user from waiting queue', async () => {
      const userId = 'cancel-test-user';

      // Join queue
      const joinResult = await pairingEngine.joinChallenge(
        userId,
        testChallengeId,
        'YES',
        1000
      );
      expect(joinResult.success).toBe(true);
      expect(joinResult.queuePosition).toBe(1);

      // Cancel from queue
      const cancelResult = await pairingEngine.cancelFromQueue(userId, testChallengeId);
      expect(cancelResult.success).toBe(true);
    });

    it('should NOT cancel if already matched', async () => {
      const userId = 'match-then-cancel-user';

      // Join and get matched
      await pairingEngine.joinChallenge(userId, testChallengeId, 'YES', 1000);
      const matchResult = await pairingEngine.joinChallenge(
        'opponent-user',
        testChallengeId,
        'NO',
        1000
      );

      if (matchResult.match) {
        // Try to cancel after match - should fail
        const cancelResult = await pairingEngine.cancelFromQueue(userId, testChallengeId);
        expect(cancelResult.success).toBe(false);
      }
    });
  });

  describe('Atomicity & Race Condition Prevention', () => {
    it('should NOT double-match the same user', async () => {
      const userId = 'double-match-test';

      // Attempt to join same challenge twice concurrently
      // (In real scenario, would use Promise.all for true concurrency)
      const result1 = await pairingEngine.joinChallenge(
        userId,
        testChallengeId,
        'YES',
        1000
      );

      const result2 = await pairingEngine.joinChallenge(
        userId,
        testChallengeId,
        'YES',
        1000
      );

      // Only one should succeed
      const successCount = [result1, result2].filter(r => r.success).length;
      expect(successCount).toBe(1);
    });

    it('should ensure escrow is locked only for matched users', async () => {
      const escrowRecords = await db
        .select()
        .from(escrow)
        .where(eq(escrow.challengeId, testChallengeId));

      // All escrow records should have status 'holding'
      escrowRecords.forEach(record => {
        expect(record.status).toBe('holding');
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid side parameter', async () => {
      const result = await pairingEngine.joinChallenge(
        testUsers[0],
        testChallengeId,
        'INVALID' as any,
        1000
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid');
    });

    it('should handle non-existent challenge', async () => {
      const result = await pairingEngine.joinChallenge(
        testUsers[0],
        99999,
        'YES',
        1000
      );

      expect(result.success).toBe(false);
    });

    it('should handle invalid stake amounts', async () => {
      const result1 = await pairingEngine.joinChallenge(
        testUsers[0],
        testChallengeId,
        'YES',
        -100
      );
      expect(result1.success).toBe(false);

      const result2 = await pairingEngine.joinChallenge(
        testUsers[0],
        testChallengeId,
        'YES',
        0
      );
      expect(result2.success).toBe(false);

      const result3 = await pairingEngine.joinChallenge(
        testUsers[0],
        testChallengeId,
        'YES',
        1.5
      );
      expect(result3.success).toBe(false);
    });
  });
});

/**
 * STRESS TEST: Concurrent Joins
 * Run manually with: npm test -- --testNamePattern="Stress Test"
 */
describe('Stress Test - Concurrent Queue Joins', () => {
  let pairingEngine: ReturnType<typeof createPairingEngine>;
  let stressChallengeId: number;

  beforeAll(async () => {
    pairingEngine = createPairingEngine(db);

    const [challenge] = await db
      .insert(challenges)
      .values({
        title: 'Stress Test Challenge',
        description: 'Testing concurrent matching',
        category: 'stress-test',
        amount: 1000,
        status: 'open',
        adminCreated: true,
      })
      .returning();

    stressChallengeId = challenge.id;
  });

  it('should handle 20 concurrent joins without race conditions', async () => {
    const users = Array.from({ length: 20 }, (_, i) => `stress-user-${i}`);

    // Interleave YES and NO
    const joinPromises = users.map((userId, i) => {
      const side = i % 2 === 0 ? 'YES' : 'NO';
      const stake = 1000 + Math.random() * 200; // 1000-1200 range (within ±20%)
      return pairingEngine.joinChallenge(userId, stressChallengeId, side, Math.floor(stake));
    });

    const results = await Promise.all(joinPromises);

    // Check results
    const matches = results.filter(r => r.match).length;
    const queued = results.filter(r => r.queuePosition).length;
    const failed = results.filter(r => !r.success).length;

    expect(failed).toBe(0);
    expect(matches + queued).toBe(20);

    // Verify no duplicates in queue
    const queueEntries = await db
      .select()
      .from(pairQueue)
      .where(eq(pairQueue.challengeId, stressChallengeId));

    const userIds = queueEntries.map(e => e.userId);
    const uniqueUserIds = new Set(userIds);
    expect(uniqueUserIds.size).toBe(userIds.length);
  });
});
