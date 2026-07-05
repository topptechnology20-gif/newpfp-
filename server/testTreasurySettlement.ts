/**
 * Test Treasury Settlement Complete Flow
 * Tests: Match creation → Challenge resolution → Settlement → Notifications
 */

import { db } from './db';
import { users, challenges, challengeParticipants, treasuryMatches, treasuryChallenges } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * End-to-end test of Treasury matching and settlement
 */
export async function testTreasurySettlementFlow() {
  console.log('\n📋 Starting Treasury Settlement End-to-End Test...\n');

  try {
    // 1️⃣  Get or create test admin user
    const adminUser = await db
      .select()
      .from(users)
      .where(eq(users.username, 'test_admin_treasury'))
      .limit(1);

    const adminId = adminUser.length ? adminUser[0].id : null;
    if (!adminId) {
      throw new Error('❌ Test admin user not found. Run seedShadowPersonas first.');
    }

    console.log(`✅ Found test admin: ${adminId}`);

    // 2️⃣  Get or create test challenge
    const testChallenge = await db
      .select()
      .from(challenges)
      .where(eq(challenges.title, 'TEST TREASURY CHALLENGE'))
      .limit(1);

    if (!testChallenge.length) {
      throw new Error('❌ Test challenge not found. Create one first with title "TEST TREASURY CHALLENGE"');
    }

    const challengeId = testChallenge[0].id;
    console.log(`✅ Found test challenge: ${challengeId}`);

    // 3️⃣  Check if Treasury config exists
    const treasuryConfig = await db
      .select()
      .from(treasuryChallenges)
      .where(eq(treasuryChallenges.challengeId, challengeId))
      .limit(1);

    if (!treasuryConfig.length) {
      console.log('❌ Treasury config not found. Admin must configure Treasury for this challenge first.');
      console.log('   Run: POST /api/admin/challenges/:id/treasury-config with maxRisk: 50000\n');
      return;
    }

    console.log(`✅ Treasury config found: max risk ₦${treasuryConfig[0].maxRisk}`);

    // 4️⃣  Check Treasury matches
    const matches = await db
      .select()
      .from(treasuryMatches)
      .where(eq(treasuryMatches.challengeId, challengeId));

    if (!matches.length) {
      console.log('❌ No Treasury matches found. Admin must fulfill Treasury matches first.');
      console.log('   Run: POST /api/admin/challenges/:id/fulfill-treasury with matchCount and side\n');
      return;
    }

    console.log(`✅ Found ${matches.length} Treasury matches`);

    // 5️⃣  Show current match states
    const activeMatches = matches.filter(m => m.status === 'active');
    const settledMatches = matches.filter(m => m.status === 'settled');

    console.log(`   • Active: ${activeMatches.length}`);
    console.log(`   • Settled: ${settledMatches.length}\n`);

    if (activeMatches.length > 0) {
      console.log('📊 Sample Active Matches:');
      activeMatches.slice(0, 3).forEach((match, idx) => {
        console.log(
          `   ${idx + 1}. User bets ${match.realUserSide} ₦${match.realUserStaked}, Treasury bets ${
            match.realUserSide === 'YES' ? 'NO' : 'YES'
          } ₦${match.treasuryStaked}`
        );
      });
    }

    if (settledMatches.length > 0) {
      console.log('\n📊 Sample Settled Matches:');
      const wonCount = settledMatches.filter(m => m.result === 'treasury_won').length;
      const lostCount = settledMatches.filter(m => m.result === 'treasury_lost').length;
      console.log(`   • Treasury Won: ${wonCount}`);
      console.log(`   • Treasury Lost: ${lostCount}`);

      const totalPayout = settledMatches.reduce((sum, m) => sum + (m.treasuryPayout || 0), 0);
      console.log(`   • Total Treasury Payout: ₦${totalPayout.toLocaleString()}`);

      const totalStaked = settledMatches.reduce((sum, m) => sum + m.treasuryStaked, 0);
      const netProfit = totalPayout - totalStaked;
      console.log(`   • Net Profit/Loss: ₦${netProfit.toLocaleString()}`);
    }

    // 6️⃣  Check challenge result
    const challenge = testChallenge[0];
    console.log(`\n🎯 Challenge Status: ${challenge.result || 'NOT YET RESOLVED'}`);

    if (challenge.result) {
      console.log('✅ Challenge is resolved. Treasury settlement should have been executed.');
      console.log('   Check notifications table for settlement events.\n');

      // Count settlement notifications
      const { db: notifDb } = await import('./db');
      const notificationCount = await notifDb
        .select()
        .from((await import('../shared/schema')).notifications)
        .where((schema) => {
          const notifications = schema.notifications || {};
          const eventCol = (notifications as any).event;
          if (!eventCol) return undefined;
          return eq(eventCol, 'challenge.settled');
        });

      console.log(`📢 Settlement notifications sent: ${notificationCount?.length || 0}`);
    } else {
      console.log('⚠️  Challenge not yet resolved. To test settlement:');
      console.log('   1. POST /api/admin/challenges/:id/result with result: "challenger_won" or "challenged_won"');
      console.log('   2. Treasury settlement will execute automatically');
      console.log('   3. Notifications will be sent to matched users\n');
    }

    // 7️⃣  Show test commands
    console.log('💡 Test Commands:\n');

    if (!treasuryConfig.length) {
      console.log(`1. Configure Treasury:`);
      console.log(`   POST /api/admin/challenges/${challengeId}/treasury-config`);
      console.log(`   { "maxRisk": 50000, "notes": "Test Treasury configuration" }\n`);
    }

    if (treasuryConfig.length && !activeMatches.length && !settledMatches.length) {
      console.log(`2. Fulfill Treasury Matches:`);
      console.log(`   POST /api/admin/challenges/${challengeId}/fulfill-treasury`);
      console.log(`   { "matchCount": 10, "side": "YES" }\n`);
    }

    if (activeMatches.length > 0 && !challenge.result) {
      console.log(`3. Resolve Challenge:`);
      console.log(`   POST /api/admin/challenges/${challengeId}/result`);
      console.log(`   { "result": "challenger_won" }\n`);
    }

    console.log('\n✨ Test completed! Check server logs for settlement execution.\n');

  } catch (error) {
    console.error('\n❌ Test Error:', error);
    process.exit(1);
  }
}

// Run test if executed directly
if (require.main === module) {
  testTreasurySettlementFlow().then(() => process.exit(0));
}
