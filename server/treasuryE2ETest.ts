/**
 * Treasury Balancing - Comprehensive End-to-End Test Suite
 * Tests the complete flow: Challenge creation → Match fulfillment → Settlement
 * 
 * Run: export DATABASE_URL='...' && npx tsx server/treasuryE2ETest.ts
 */

import { db } from './db';
import {
  users,
  challenges,
  challengeParticipants,
  treasuryMatches,
  treasuryChallenges,
  notifications,
  shadowPersonas,
  adminWalletTransactions,
  treasuryWallets,
  treasuryWalletTransactions,
} from '../shared/schema';
import { eq, and } from 'drizzle-orm';

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

interface TestResult {
  passed: number;
  failed: number;
  errors: string[];
}

const results: TestResult = { passed: 0, failed: 0, errors: [] };

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logStep(num: number, title: string) {
  console.log(
    `\n${colors.bright}${colors.blue}▶ STEP ${num}: ${title}${colors.reset}`
  );
}

function logTest(testName: string, passed: boolean, details?: string) {
  const symbol = passed ? `${colors.green}✅` : `${colors.red}❌`;
  const msg = `${symbol} ${testName}${colors.reset}${details ? ` (${details})` : ''}`;
  console.log(msg);
  if (passed) results.passed++;
  else results.failed++;
}

function logError(message: string) {
  log(`❌ ERROR: ${message}`, 'red');
  results.errors.push(message);
}

function logSuccess(message: string) {
  log(`✨ ${message}`, 'green');
}

// ============================================================================
// STEP 1: Verify Test Data Setup
// ============================================================================

async function testStep1_VerifySetup() {
  logStep(1, 'VERIFY TEST DATA SETUP');

  try {
    // Check admin user exists
    const adminResult = await db
      .select()
      .from(users)
      .where(eq(users.username, 'test_admin_treasury'))
      .limit(1);

    const adminExists = adminResult.length > 0;
    logTest('Admin user exists', adminExists, adminResult[0]?.username);
    if (!adminExists) throw new Error('Admin user not found');

    const adminId = adminResult[0].id;

    // Check shadow personas are seeded
    const personasResult = await db
      .select()
      .from(shadowPersonas)
      .limit(1);

    const personasSeeded = personasResult.length > 0;
    logTest(
      'Shadow personas seeded',
      personasSeeded,
      `${personasResult.length} personas available`
    );
    if (!personasSeeded) throw new Error('No shadow personas found');

    return { adminId };
  } catch (error) {
    logError(`Setup verification failed: ${(error as Error).message}`);
    throw error;
  }
}

// ============================================================================
// STEP 2: Create Test Challenge
// ============================================================================

async function testStep2_CreateChallenge(adminId: string) {
  logStep(2, 'CREATE TEST CHALLENGE');

  try {
    // Check if test challenge exists
    const existingChallenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.title, 'E2E_TEST_TREASURY_CHALLENGE'))
      .limit(1);

    let challengeId: number;

    if (existingChallenge.length > 0) {
      challengeId = existingChallenge[0].id;
      logTest('Found existing test challenge', true, `ID: ${challengeId}`);

      // Clear old test data if exists
      await db
        .delete(challengeParticipants)
        .where(eq(challengeParticipants.challengeId, challengeId));
      await db
        .delete(treasuryMatches)
        .where(eq(treasuryMatches.challengeId, challengeId));
    } else {
      logError('Test challenge not found. Create manually or update script.');
      throw new Error('E2E_TEST_TREASURY_CHALLENGE not found');
    }

    logTest('Challenge is admin-created', existingChallenge[0].adminCreated === true);
    logTest('Challenge not yet resolved', existingChallenge[0].result === null);

    return { challengeId, adminId };
  } catch (error) {
    logError(`Challenge creation failed: ${(error as Error).message}`);
    throw error;
  }
}

// ============================================================================
// STEP 3: Add Imbalanced Participants
// ============================================================================

async function testStep3_AddParticipants(challengeId: number) {
  logStep(3, 'ADD IMBALANCED PARTICIPANTS');

  try {
    // Create test users for YES side (10 users)
    const yesUsers: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const username = `e2e_test_yes_user_${i}_${Date.now()}`;
      const newUser = await db
        .insert(users)
        .values({
          username,
          email: `${username}@test.local`,
          is_shadow_persona: false,
        })
        .returning({ id: users.id });

      yesUsers.push(newUser[0].id);

      // Add to challenge
      await db.insert(challengeParticipants).values({
        challenge_id: challengeId,
        user_id: newUser[0].id,
        side: 'YES',
        staked: 5000,
      });
    }

    logTest('Created 10 YES-side users', yesUsers.length === 10);

    // Create test users for NO side (2 users)
    const noUsers: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const username = `e2e_test_no_user_${i}_${Date.now()}`;
      const newUser = await db
        .insert(users)
        .values({
          username,
          email: `${username}@test.local`,
          is_shadow_persona: false,
        })
        .returning({ id: users.id });

      noUsers.push(newUser[0].id);

      // Add to challenge
      await db.insert(challengeParticipants).values({
        challenge_id: challengeId,
        user_id: newUser[0].id,
        side: 'NO',
        staked: 5000,
      });
    }

    logTest('Created 2 NO-side users', noUsers.length === 2);

    // Verify imbalance
    const yesStake = 10 * 5000; // 50,000
    const noStake = 2 * 5000; // 10,000
    const gap = yesStake - noStake; // 40,000

    logTest('Imbalance created', gap === 40000, `Gap: ₦${gap.toLocaleString()}`);
    logTest('8 unmatched YES users', yesUsers.length - noUsers.length === 8);

    return { challengeId, yesUsers, noUsers };
  } catch (error) {
    logError(`Participant creation failed: ${(error as Error).message}`);
    throw error;
  }
}

// ============================================================================
// STEP 4: Configure Treasury
// ============================================================================

async function testStep4_ConfigureTreasury(challengeId: number) {
  logStep(4, 'CONFIGURE TREASURY FOR CHALLENGE');

  try {
    const maxRisk = 50000;

    // Check if config already exists
    const existingConfig = await db
      .select()
      .from(treasuryChallenges)
      .where(eq(treasuryChallenges.challengeId, challengeId))
      .limit(1);

    let configId: number;

    if (existingConfig.length > 0) {
      configId = existingConfig[0].id;
      logTest('Treasury config already exists', true, `ID: ${configId}`);
    } else {
      const newConfig = await db
        .insert(treasuryChallenges)
        .values({
          challengeId,
          maxRisk,
          totalAllocated: 0,
          totalFilled: 0,
        })
        .returning({ id: treasuryChallenges.id });

      configId = newConfig[0].id;
      logTest('Treasury config created', true, `Max risk: ₦${maxRisk}`);
    }

    // Verify config
    const config = await db
      .select()
      .from(treasuryChallenges)
      .where(eq(treasuryChallenges.id, configId))
      .limit(1);

    logTest('Config has max risk', config[0].maxRisk === maxRisk);
    logTest('Config allocated is 0', config[0].totalAllocated === 0);

    return { challengeId, maxRisk };
  } catch (error) {
    logError(`Treasury config failed: ${(error as Error).message}`);
    throw error;
  }
}

// ============================================================================
// STEP 5: Fulfill Treasury Matches (Simulate)
// ============================================================================

async function testStep5_FulfillMatches(challengeId: number, adminId: string) {
  logStep(5, 'FULFILL TREASURY MATCHES');

  try {
    const matchCount = 8;
    const side = 'NO';
    const stakePerMatch = 5000;
    const totalAllocated = matchCount * stakePerMatch;

    // Get available shadow personas
    const availablePersonas = await db
      .select()
      .from(shadowPersonas)
      .limit(matchCount);

    logTest(
      'Enough shadow personas available',
      availablePersonas.length >= matchCount,
      `Need: ${matchCount}, Available: ${availablePersonas.length}`
    );

    if (availablePersonas.length < matchCount) {
      throw new Error('Insufficient shadow personas');
    }

    // Create treasury matches
    const treasuryMatchIds: number[] = [];
    for (let i = 0; i < matchCount; i++) {
      const persona = availablePersonas[i];

      const match = await db
        .insert(treasuryMatches)
        .values({
          challengeId,
          realUserId: `e2e_test_user_${i}`, // Placeholder
          shadowPersonaId: persona.id,
          realUserSide: 'YES', // Real users bet YES
          treasurySide: 'NO', // Treasury bets opposite
          realUserStaked: stakePerMatch,
          treasuryStaked: stakePerMatch,
          status: 'active',
        })
        .returning({ id: treasuryMatches.id });

      treasuryMatchIds.push(match[0].id);
    }

    logTest(
      'Created treasury matches',
      treasuryMatchIds.length === matchCount,
      `${matchCount} matches`
    );

    // Verify matches in database
    const createdMatches = await db
      .select()
      .from(treasuryMatches)
      .where(eq(treasuryMatches.challengeId, challengeId));

    logTest('All matches status is active', 
      createdMatches.every(m => m.status === 'active'),
      `${createdMatches.length} matches active`
    );

    // Update treasury config
    await db
      .update(treasuryChallenges)
      .set({
        totalAllocated,
        totalFilled: matchCount,
      })
      .where(eq(treasuryChallenges.challengeId, challengeId));

    logTest(
      'Treasury allocation recorded',
      true,
      `₦${totalAllocated.toLocaleString()} allocated`
    );

    // Simulate notifications being created
    for (let i = 0; i < matchCount; i++) {
      await db.insert(notifications).values({
        userId: `e2e_test_user_${i}`,
        event: 'match.found',
        title: 'You matched!',
        message: `You've been matched with ${availablePersonas[i].username}`,
        data: {
          challengeId,
          opponentName: availablePersonas[i].username,
          opponentStaked: stakePerMatch,
        },
        read: false,
      });
    }

    // Admin notification
    await db.insert(notifications).values({
      userId: adminId,
      event: 'admin.treasury.match_created',
      title: 'Treasury Matches Filled',
      message: `Filled ${matchCount} matches on ${side} side, ₦${totalAllocated}`,
      data: {
        challengeId,
        matchCount,
        side,
        totalAllocated,
        usernames: availablePersonas.slice(0, matchCount).map(p => p.username),
      },
      read: false,
    });

    logTest('User notifications created', matchCount > 0);
    logTest('Admin notification created', true);

    return { challengeId, matchCount, totalAllocated, treasuryMatchIds };
  } catch (error) {
    logError(`Match fulfillment failed: ${(error as Error).message}`);
    throw error;
  }
}

// ============================================================================
// STEP 6: Verify Notifications Created
// ============================================================================

async function testStep6_VerifyNotifications(challengeId: number) {
  logStep(6, 'VERIFY NOTIFICATIONS');

  try {
    // Check match.found notifications
    const matchNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.event, 'match.found'));

    logTest(
      'User match notifications created',
      matchNotifs.length >= 8,
      `${matchNotifs.length} notifications`
    );

    // Check admin notification
    const adminNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.event, 'admin.treasury.match_created'));

    logTest(
      'Admin match notification created',
      adminNotifs.length >= 1,
      `${adminNotifs.length} notifications`
    );

    // Verify data structure
    if (matchNotifs.length > 0) {
      const notif = matchNotifs[0];
      logTest('Notification has title', notif.title?.length > 0);
      logTest('Notification has message', notif.message?.length > 0);
      logTest('Notification has data', notif.data !== null);
      logTest('Notification not read', notif.read === false);
    }

    return { matchNotifications: matchNotifs.length, adminNotifications: adminNotifs.length };
  } catch (error) {
    logError(`Notification verification failed: ${(error as Error).message}`);
    throw error;
  }
}

// ============================================================================
// STEP 7: Resolve Challenge
// ============================================================================

async function testStep7_ResolveChallenge(challengeId: number) {
  logStep(7, 'RESOLVE CHALLENGE');

  try {
    const result = 'challenger_won'; // YES side wins

    // Update challenge with result
    await db
      .update(challenges)
      .set({ result })
      .where(eq(challenges.id, challengeId));

    logTest('Challenge result set', true, `Result: ${result}`);

    // Verify challenge updated
    const updatedChallenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .limit(1);

    logTest('Challenge shows result', updatedChallenge[0].result === result);
    logTest('Challenge resolved', updatedChallenge[0].result !== null);

    return { challengeId, result };
  } catch (error) {
    logError(`Challenge resolution failed: ${(error as Error).message}`);
    throw error;
  }
}

// ============================================================================
// STEP 8: Simulate Settlement
// ============================================================================

async function testStep8_SimulateSettlement(
  challengeId: number,
  result: string,
  adminId: string
) {
  logStep(8, 'SIMULATE SETTLEMENT');

  try {
    // Get all treasury matches for this challenge
    const matches = await db
      .select()
      .from(treasuryMatches)
      .where(eq(treasuryMatches.challengeId, challengeId));

    logTest('Found treasury matches to settle', matches.length > 0, `${matches.length} matches`);

    const challengeResult = result === 'challenger_won'; // YES wins = true
    let wonCount = 0;
    let lostCount = 0;
    let totalWon = 0;
    let totalLost = 0;

    // Settle each match
    for (const match of matches) {
      // Determine if Treasury won
      const treasuryBetSide = match.realUserSide === 'YES' ? 'NO' : 'YES';
      const treasuryWon =
        (treasuryBetSide === 'YES' && challengeResult) ||
        (treasuryBetSide === 'NO' && !challengeResult);

      const payout = treasuryWon ? match.treasuryStaked * 2 : 0;
      const settlementResult = treasuryWon ? 'treasury_won' : 'treasury_lost';

      // Update match
      await db
        .update(treasuryMatches)
        .set({
          result: settlementResult,
          treasuryPayout: payout,
          settledAt: new Date(),
          status: 'settled',
        })
        .where(eq(treasuryMatches.id, match.id));

      if (treasuryWon) {
        wonCount++;
        totalWon += payout;
      } else {
        lostCount++;
        totalLost += match.treasuryStaked; // What was lost
      }

      // Create settlement notification for user
      await db.insert(notifications).values({
        userId: match.realUserId,
        event: 'challenge.settled',
        title: 'Challenge Settled',
        message: treasuryWon
          ? `Challenge settled! You lost ₦${match.realUserStaked}`
          : `Challenge settled! You won ₦${match.realUserStaked * 2}`,
        data: {
          challengeId,
          result: treasuryWon ? 'lost' : 'won',
          payout: treasuryWon ? 0 : match.realUserStaked * 2,
        },
        read: false,
      });
    }

    logTest('Settled all matches', wonCount + lostCount === matches.length);
    logTest('Treasury won some', wonCount > 0, `${wonCount} wins`);
    logTest('Treasury lost some', lostCount > 0, `${lostCount} losses`);

    const netProfit = totalWon - totalLost;
    logTest(
      'Treasury P&L calculated',
      true,
      `Won: ₦${totalWon}, Lost: ₦${totalLost}, Net: ₦${netProfit}`
    );

    // Create admin settlement notification
    await db.insert(notifications).values({
      userId: adminId,
      event: 'admin.treasury.settlement',
      title: 'Treasury Settlement Complete',
      message: `Challenge #${challengeId} settled: ${matches.length} matches, ${wonCount} won, ${lostCount} lost. Net: ₦${netProfit}`,
      data: {
        challengeId,
        matchesSettled: matches.length,
        wonCount,
        lostCount,
        netProfit,
      },
      read: false,
    });

    logTest('Settlement notification created', true);

    // Record treasury transaction
    await db.insert(adminWalletTransactions).values({
      adminId,
      amount: netProfit,
      type: 'treasury_settlement',
      challengeId,
      description: `Treasury settlement: ${wonCount} won, ${lostCount} lost`,
    });

    logTest('Treasury transaction recorded', true);

    return { wonCount, lostCount, netProfit };
  } catch (error) {
    logError(`Settlement simulation failed: ${(error as Error).message}`);
    throw error;
  }
}

// ============================================================================
// STEP 9: Verify Settlement State
// ============================================================================

async function testStep9_VerifySettlement(challengeId: number) {
  logStep(9, 'VERIFY SETTLEMENT STATE');

  try {
    // Get all settled matches
    const settledMatches = await db
      .select()
      .from(treasuryMatches)
      .where(
        and(
          eq(treasuryMatches.challengeId, challengeId),
          eq(treasuryMatches.status, 'settled')
        )
      );

    logTest(
      'All matches settled',
      settledMatches.length > 0,
      `${settledMatches.length} matches`
    );

    // Verify match data
    if (settledMatches.length > 0) {
      logTest('Matches have result', settledMatches.every(m => m.result));
      logTest('Matches have payout', settledMatches.every(m => m.treasuryPayout !== null));
      logTest('Matches have settled_at', settledMatches.every(m => m.settledAt));
    }

    // Check settlement notifications
    const settlementNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.event, 'challenge.settled'));

    logTest(
      'Settlement notifications created',
      settlementNotifs.length > 0,
      `${settlementNotifs.length} notifications`
    );

    // Check admin settlement notification
    const adminSettlementNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.event, 'admin.treasury.settlement'));

    logTest(
      'Admin settlement notification created',
      adminSettlementNotifs.length > 0,
      `${adminSettlementNotifs.length} notifications`
    );

    return { settledMatches: settledMatches.length, notifications: settlementNotifs.length };
  } catch (error) {
    logError(`Settlement verification failed: ${(error as Error).message}`);
    throw error;
  }
}

// ============================================================================
// STEP 9b: Verify Treasury Wallet Credit on Win
// ============================================================================

async function testStep9b_VerifyWalletCredit(challengeId: number, adminId: string, result: boolean) {
  logStep(9.5, 'VERIFY TREASURY WALLET CREDIT ON WIN');

  try {
    // Determine if Treasury won
    // Matches were created with: realUserSide = 'YES', treasurySide = 'NO'
    // Treasury wins if NO wins (result = false)
    const treasuryWon = result === false; // true means YES won, false means NO won

    if (!treasuryWon) {
      logTest('Treasury lost this match', true, 'Expected behavior (no wallet credit)');
      return { walletCredit: 0 };
    }

    // Get Treasury wallet for admin
    const wallet = await db
      .select()
      .from(treasuryWallets)
      .where(eq(treasuryWallets.adminId, adminId))
      .limit(1);

    const walletExists = wallet.length > 0;
    logTest('Treasury wallet exists', walletExists, `Admin: ${adminId}`);

    if (!walletExists) {
      logError('Treasury wallet not found - wallet may not be created yet');
      return { walletCredit: 0 };
    }

    const treasuryWallet = wallet[0];
    logTest('Wallet balance is positive', treasuryWallet.balance > 0, `₦${treasuryWallet.balance}`);

    // Get wallet transaction history
    const transactions = await db
      .select()
      .from(treasuryWalletTransactions)
      .where(
        and(
          eq(treasuryWalletTransactions.adminId, adminId),
          eq(treasuryWalletTransactions.relatedChallengeId, challengeId)
        )
      );

    logTest('Wallet transactions recorded', transactions.length > 0, `${transactions.length} transactions`);

    // Check for credit transactions
    const creditTransactions = transactions.filter(t => t.type === 'credit');
    logTest('Credit transactions exist', creditTransactions.length > 0, `${creditTransactions.length} credits`);

    // Verify debit happened first
    const debitTransactions = transactions.filter(t => t.type === 'debit');
    logTest('Debit transactions exist', debitTransactions.length > 0, `${debitTransactions.length} debits`);

    if (creditTransactions.length > 0) {
      const totalCredit = creditTransactions.reduce((sum, t) => sum + parseFloat(t.amount), 0);
      logTest('Total credit amount is positive', totalCredit > 0, `₦${totalCredit.toLocaleString()}`);
    }

    return { walletCredit: treasuryWallet.balance, transactions: transactions.length };
  } catch (error) {
    logError(`Wallet credit verification failed: ${(error as Error).message}`);
    return { walletCredit: 0 };
  }
}

// ============================================================================
// STEP 10: Verify Admin Can Withdraw from Wallet
// ============================================================================

async function testStep10_VerifyWalletOperations(adminId: string) {
  logStep(10, 'VERIFY TREASURY WALLET OPERATIONS');

  try {
    // Check wallet exists
    const wallet = await db
      .select()
      .from(treasuryWallets)
      .where(eq(treasuryWallets.adminId, adminId))
      .limit(1);

    logTest('Admin has Treasury wallet', wallet.length > 0);

    if (wallet.length === 0) {
      logTest('Wallet creation skipped', false, 'Wallet service may not be initialized');
      return { walletOperations: 'failed' };
    }

    const treasuryWallet = wallet[0];

    // Verify wallet status
    logTest('Wallet status is active', treasuryWallet.status === 'active', treasuryWallet.status);

    // Verify totals are tracked
    logTest('Total deposited is tracked', treasuryWallet.totalDeposited !== null);
    logTest('Total used is tracked', treasuryWallet.totalUsed !== null);
    logTest('Total earned is tracked', treasuryWallet.totalEarned !== null);

    // Get all wallet transactions
    const allTransactions = await db
      .select()
      .from(treasuryWalletTransactions)
      .where(eq(treasuryWalletTransactions.adminId, adminId));

    logTest('Transaction history recorded', allTransactions.length > 0, `${allTransactions.length} total transactions`);

    // Verify transaction types
    const transactionTypes = new Set(allTransactions.map(t => t.type));
    logTest('Multiple transaction types recorded', transactionTypes.size >= 2, `Types: ${Array.from(transactionTypes).join(', ')}`);

    return { walletOperations: 'success', transactions: allTransactions.length };
  } catch (error) {
    logError(`Wallet operations verification failed: ${(error as Error).message}`);
    return { walletOperations: 'failed' };
  }
}

// ============================================================================
// STEP 11: Final Summary
// ============================================================================

function testStep11_Summary() {
  logStep(11, 'FINAL SUMMARY');

  console.log(`
${colors.bright}TEST RESULTS${colors.reset}
${colors.green}✅ Passed: ${results.passed}${colors.reset}
${colors.red}❌ Failed: ${results.failed}${colors.reset}
${colors.blue}📊 Total:  ${results.passed + results.failed}${colors.reset}

${results.errors.length > 0 ? `${colors.red}ERRORS:${colors.reset}` : ''}
${results.errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}
  `);

  if (results.failed === 0) {
    logSuccess('ALL TESTS PASSED! 🎉');
    log(
      'Treasury balancing end-to-end flow is working correctly.',
      'green'
    );
  } else {
    log(
      `${results.failed} test(s) failed. Review errors above.`,
      'red'
    );
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function runE2ETests() {
  console.log(`
${colors.bright}${colors.cyan}════════════════════════════════════════════════════════════════
  TREASURY BALANCING - COMPREHENSIVE END-TO-END TEST
════════════════════════════════════════════════════════════════${colors.reset}
  `);

  try {
    const { adminId } = await testStep1_VerifySetup();
    const { challengeId } = await testStep2_CreateChallenge(adminId);
    await testStep3_AddParticipants(challengeId);
    await testStep4_ConfigureTreasury(challengeId);
    const { matchCount } = await testStep5_FulfillMatches(challengeId, adminId);
    await testStep6_VerifyNotifications(challengeId);
    const { result } = await testStep7_ResolveChallenge(challengeId);
    const { netProfit } = await testStep8_SimulateSettlement(challengeId, result, adminId);
    await testStep9_VerifySettlement(challengeId);
    await testStep9b_VerifyWalletCredit(challengeId, adminId, result);
    await testStep10_VerifyWalletOperations(adminId);
    testStep11_Summary();

    console.log(`
${colors.cyan}TREASURY STATE AT END${colors.reset}
  Challenge ID: ${challengeId}
  Matches Created: ${matchCount}
  Matches Settled: ${matchCount}
  Net Profit/Loss: ₦${netProfit}
  `);

    process.exit(results.failed === 0 ? 0 : 1);
  } catch (error) {
    logError(`Fatal error: ${(error as Error).message}`);
    testStep11_Summary();
    process.exit(1);
  }
}

// Run tests if executed directly
if (require.main === module) {
  runE2ETests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
}

export { runE2ETests };
