import { db } from './db';
import {
  treasuryMatches,
  treasuryChallenges,
  users,
  challenges,
  pairQueue,
} from '../shared/schema';
import { eq, and, gte, lte, sql } from 'drizzle-orm';

export interface DailyPnL {
  date: string;
  matches_count: number;
  wins: number;
  losses: number;
  draws: number;
  total_amount_wagered: number;
  total_payout: number;
  net_pnl: number;
  win_rate: number;
}

export interface ChallengeAnalytics {
  challenge_id: string;
  challenge_title: string;
  admin_id: string;
  admin_username: string;
  total_matches: number;
  wins: number;
  losses: number;
  draws: number;
  total_wagered: number;
  total_payout: number;
  net_pnl: number;
  win_rate: number;
  avg_match_amount: number;
  created_at: string;
  settled_at: string | null;
}

export interface TreasuryMetrics {
  total_matches: number;
  total_matches_settled: number;
  pending_settlement: number;
  total_amount_wagered: number;
  total_payouts: number;
  total_net_pnl: number;
  overall_win_rate: number;
  avg_match_size: number;
  days_active: number;
  most_profitable_day: DailyPnL | null;
  most_challenging_day: DailyPnL | null;
}

export interface PerformanceByUser {
  user_id: string;
  username: string;
  is_shadow: boolean;
  matches_count: number;
  wins: number;
  losses: number;
  draws: number;
  win_rate: number;
  total_wagered: number;
  total_payout: number;
  net_pnl: number;
}

export interface RiskAnalysis {
  date: string;
  max_daily_risk: number;
  actual_daily_loss: number;
  risk_utilization: number;
  challenges_at_risk: number;
  total_exposed: number;
}

// Get daily P&L trends
export async function getDailyPnLTrends(
  startDate?: Date,
  endDate?: Date
): Promise<DailyPnL[]> {
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Last 30 days
  const end = endDate || new Date();

  const results = await db
    .selectDistinct({
      date: sql<string>`DATE(${treasury_matches.settled_at})`,
      matches_count: sql<number>`COUNT(*)`,
      wins: sql<number>`SUM(CASE WHEN ${treasury_matches.result} = 'treasury_won' THEN 1 ELSE 0 END)`,
      losses: sql<number>`SUM(CASE WHEN ${treasury_matches.result} = 'treasury_lost' THEN 1 ELSE 0 END)`,
      draws: sql<number>`SUM(CASE WHEN ${treasury_matches.result} = 'draw' THEN 1 ELSE 0 END)`,
      total_wagered: sql<number>`SUM(${treasury_matches.amount_wagered})`,
      total_payout: sql<number>`SUM(${treasury_matches.payout})`,
    })
    .from(treasury_matches)
    .where(
      and(
        gte(treasury_matches.settled_at, start),
        lte(treasury_matches.settled_at, end),
        eq(treasury_matches.status, 'settled')
      )
    )
    .groupBy(sql`DATE(${treasury_matches.settled_at})`)
    .orderBy(sql`DATE(${treasury_matches.settled_at}) DESC`);

  return results.map((r) => ({
    date: r.date || new Date().toISOString().split('T')[0],
    matches_count: r.matches_count || 0,
    wins: r.wins || 0,
    losses: r.losses || 0,
    draws: r.draws || 0,
    total_amount_wagered: r.total_wagered || 0,
    total_payout: r.total_payout || 0,
    net_pnl: (r.total_payout || 0) - (r.total_wagered || 0),
    win_rate:
      r.matches_count && r.matches_count > 0
        ? ((r.wins || 0) / r.matches_count) * 100
        : 0,
  }));
}

// Get per-challenge analytics
export async function getChallengeAnalytics(
  challengeId?: string
): Promise<ChallengeAnalytics[]> {
  const query = db
    .select({
      challenge_id: challenges.id,
      challenge_title: challenges.title,
      admin_id: challenges.admin_id,
      admin_username: users.username,
      total_matches: sql<number>`COUNT(${treasury_matches.id})`,
      wins: sql<number>`SUM(CASE WHEN ${treasury_matches.result} = 'treasury_won' THEN 1 ELSE 0 END)`,
      losses: sql<number>`SUM(CASE WHEN ${treasury_matches.result} = 'treasury_lost' THEN 1 ELSE 0 END)`,
      draws: sql<number>`SUM(CASE WHEN ${treasury_matches.result} = 'draw' THEN 1 ELSE 0 END)`,
      total_wagered: sql<number>`SUM(${treasury_matches.amount_wagered})`,
      total_payout: sql<number>`SUM(${treasury_matches.payout})`,
      avg_match_amount: sql<number>`AVG(${treasury_matches.amount_wagered})`,
      created_at: challenges.created_at,
      settled_at: sql<string>`MAX(${treasury_matches.settled_at})`,
    })
    .from(treasury_matches)
    .innerJoin(
      challenges,
      eq(treasury_matches.challenge_id, challenges.id)
    )
    .innerJoin(users, eq(challenges.admin_id, users.id))
    .where(eq(treasury_matches.status, 'settled'));

  if (challengeId) {
    query.where(eq(challenges.id, challengeId));
  }

  const results = await query
    .groupBy(challenges.id, challenges.title, challenges.admin_id, users.username, challenges.created_at);

  return results.map((r) => ({
    challenge_id: r.challenge_id,
    challenge_title: r.challenge_title,
    admin_id: r.admin_id,
    admin_username: r.admin_username,
    total_matches: r.total_matches || 0,
    wins: r.wins || 0,
    losses: r.losses || 0,
    draws: r.draws || 0,
    total_wagered: r.total_wagered || 0,
    total_payout: r.total_payout || 0,
    net_pnl: (r.total_payout || 0) - (r.total_wagered || 0),
    win_rate:
      r.total_matches && r.total_matches > 0
        ? ((r.wins || 0) / r.total_matches) * 100
        : 0,
    avg_match_amount: r.avg_match_amount || 0,
    created_at: r.created_at,
    settled_at: r.settled_at || null,
  }));
}

// Get overall Treasury metrics
export async function getTreasuryMetrics(): Promise<TreasuryMetrics> {
  // Get all matches summary
  const [allMatches] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      settled: sql<number>`SUM(CASE WHEN ${treasury_matches.status} = 'settled' THEN 1 ELSE 0 END)`,
      wins: sql<number>`SUM(CASE WHEN ${treasury_matches.result} = 'treasury_won' THEN 1 ELSE 0 END)`,
      wagered: sql<number>`SUM(${treasury_matches.amount_wagered})`,
      payouts: sql<number>`SUM(${treasury_matches.payout})`,
    })
    .from(treasury_matches);

  const settled = allMatches?.settled || 0;
  const pending = (allMatches?.total || 0) - settled;
  const wins = allMatches?.wins || 0;
  const wagered = allMatches?.wagered || 0;
  const payouts = allMatches?.payouts || 0;
  const netPnL = payouts - wagered;

  // Get days active
  const [firstMatch] = await db
    .select({ earliest: sql<Date>`MIN(${treasury_matches.created_at})` })
    .from(treasury_matches);

  const daysActive = firstMatch?.earliest
    ? Math.floor(
        (new Date().getTime() - new Date(firstMatch.earliest).getTime()) /
          (1000 * 60 * 60 * 24)
      ) + 1
    : 0;

  // Get best and worst days
  const dailyTrends = await getDailyPnLTrends();
  const bestDay =
    dailyTrends.length > 0
      ? dailyTrends.reduce((best, current) =>
          current.net_pnl > (best.net_pnl || 0) ? current : best
        )
      : null;
  const worstDay =
    dailyTrends.length > 0
      ? dailyTrends.reduce((worst, current) =>
          current.net_pnl < (worst.net_pnl || 0) ? current : worst
        )
      : null;

  return {
    total_matches: allMatches?.total || 0,
    total_matches_settled: settled,
    pending_settlement: pending,
    total_amount_wagered: wagered,
    total_payouts: payouts,
    total_net_pnl: netPnL,
    overall_win_rate:
      settled > 0 ? (wins / settled) * 100 : 0,
    avg_match_size: settled > 0 ? wagered / settled : 0,
    days_active: daysActive,
    most_profitable_day: bestDay || null,
    most_challenging_day: worstDay || null,
  };
}

// Get performance by user (shadow and real)
export async function getPerformanceByUser(): Promise<PerformanceByUser[]> {
  const results = await db
    .select({
      user_id: users.id,
      username: users.username,
      is_shadow: users.is_shadow_persona,
      matches_count: sql<number>`COUNT(${pair_queue.id})`,
      wins: sql<number>`SUM(CASE WHEN ${pair_queue.result} = 'user_won' THEN 1 ELSE 0 END)`,
      losses: sql<number>`SUM(CASE WHEN ${pair_queue.result} = 'user_lost' THEN 1 ELSE 0 END)`,
      draws: sql<number>`SUM(CASE WHEN ${pair_queue.result} = 'draw' THEN 1 ELSE 0 END)`,
      wagered: sql<number>`SUM(${pair_queue.amount})`,
      payouts: sql<number>`SUM(${pair_queue.payout})`,
    })
    .from(pair_queue)
    .innerJoin(users, eq(pair_queue.user_id, users.id))
    .where(eq(pair_queue.is_treasury_match, true))
    .groupBy(users.id, users.username, users.is_shadow_persona);

  return results.map((r) => ({
    user_id: r.user_id,
    username: r.username,
    is_shadow: r.is_shadow || false,
    matches_count: r.matches_count || 0,
    wins: r.wins || 0,
    losses: r.losses || 0,
    draws: r.draws || 0,
    win_rate:
      r.matches_count && r.matches_count > 0
        ? ((r.wins || 0) / r.matches_count) * 100
        : 0,
    total_wagered: r.wagered || 0,
    total_payout: r.payouts || 0,
    net_pnl: (r.payouts || 0) - (r.wagered || 0),
  }));
}

// Get risk analysis
export async function getRiskAnalysis(days: number = 30): Promise<RiskAnalysis[]> {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const results = await db
    .selectDistinct({
      date: sql<string>`DATE(${treasury_challenges.created_at})`,
      max_risk: sql<number>`SUM(${treasury_challenges.max_risk})`,
      actual_loss: sql<number>`SUM(CASE WHEN ${treasury_matches.result} = 'treasury_lost' THEN ${treasury_matches.amount_wagered} ELSE 0 END)`,
      challenges: sql<number>`COUNT(DISTINCT ${treasury_challenges.id})`,
      total_exposed: sql<number>`SUM(${treasury_challenges.allocated})`,
    })
    .from(treasury_challenges)
    .leftJoin(
      treasury_matches,
      and(
        eq(treasury_challenges.id, treasury_matches.challenge_id),
        eq(treasury_matches.status, 'settled')
      )
    )
    .where(gte(treasury_challenges.created_at, startDate))
    .groupBy(sql`DATE(${treasury_challenges.created_at})`);

  return results.map((r) => ({
    date: r.date || new Date().toISOString().split('T')[0],
    max_daily_risk: r.max_risk || 0,
    actual_daily_loss: r.actual_loss || 0,
    risk_utilization: r.max_risk && r.max_risk > 0 ? ((r.actual_loss || 0) / r.max_risk) * 100 : 0,
    challenges_at_risk: r.challenges || 0,
    total_exposed: r.total_exposed || 0,
  }));
}

// Get top performing challenges (by profitability)
export async function getTopChallenges(limit: number = 10) {
  const analytics = await getChallengeAnalytics();
  return analytics
    .sort((a, b) => b.net_pnl - a.net_pnl)
    .slice(0, limit);
}

// Get top losing challenges (for risk review)
export async function getBottomChallenges(limit: number = 10) {
  const analytics = await getChallengeAnalytics();
  return analytics
    .sort((a, b) => a.net_pnl - b.net_pnl)
    .slice(0, limit);
}

// Generate daily summary report
export async function generateDailyReport(date: Date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const [dailyMatches] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      settled: sql<number>`SUM(CASE WHEN ${treasury_matches.status} = 'settled' THEN 1 ELSE 0 END)`,
      wins: sql<number>`SUM(CASE WHEN ${treasury_matches.result} = 'treasury_won' THEN 1 ELSE 0 END)`,
      wagered: sql<number>`SUM(${treasury_matches.amount_wagered})`,
      payouts: sql<number>`SUM(${treasury_matches.payout})`,
    })
    .from(treasury_matches)
    .where(
      and(
        gte(treasury_matches.created_at, dayStart),
        lte(treasury_matches.created_at, dayEnd)
      )
    );

  const wagered = dailyMatches?.wagered || 0;
  const payouts = dailyMatches?.payouts || 0;

  return {
    date: date.toISOString().split('T')[0],
    total_matches: dailyMatches?.total || 0,
    settled_matches: dailyMatches?.settled || 0,
    wins: dailyMatches?.wins || 0,
    total_wagered: wagered,
    total_payouts: payouts,
    net_pnl: payouts - wagered,
    win_rate:
      dailyMatches?.settled && dailyMatches.settled > 0
        ? ((dailyMatches.wins || 0) / dailyMatches.settled) * 100
        : 0,
  };
}

// Export data for reporting (CSV format)
export async function exportAnalyticsData(format: 'csv' | 'json' = 'csv') {
  const metrics = await getTreasuryMetrics();
  const dailyPnL = await getDailyPnLTrends();
  const challenges = await getChallengeAnalytics();
  const userPerformance = await getPerformanceByUser();

  if (format === 'json') {
    return {
      export_date: new Date().toISOString(),
      metrics,
      daily_pnl: dailyPnL,
      challenges,
      user_performance: userPerformance,
    };
  }

  // CSV format
  let csv = 'Treasury Analytics Export\n\n';
  csv += `Export Date: ${new Date().toISOString()}\n\n`;

  // Metrics section
  csv += 'OVERALL METRICS\n';
  csv += `Total Matches,${metrics.total_matches}\n`;
  csv += `Total Settled,${metrics.total_matches_settled}\n`;
  csv += `Pending Settlement,${metrics.pending_settlement}\n`;
  csv += `Total Wagered,${metrics.total_amount_wagered}\n`;
  csv += `Total Payouts,${metrics.total_payouts}\n`;
  csv += `Net P&L,${metrics.total_net_pnl}\n`;
  csv += `Win Rate %,${metrics.overall_win_rate.toFixed(2)}\n`;
  csv += `Days Active,${metrics.days_active}\n\n`;

  // Daily P&L
  csv += 'DAILY P&L TRENDS\n';
  csv += 'Date,Matches,Wins,Losses,Draws,Wagered,Payouts,Net P&L,Win Rate %\n';
  dailyPnL.forEach((day) => {
    csv += `${day.date},${day.matches_count},${day.wins},${day.losses},${day.draws},${day.total_amount_wagered},${day.total_payout},${day.net_pnl},${day.win_rate.toFixed(2)}\n`;
  });

  csv += '\nCHALLENGE ANALYTICS\n';
  csv += 'Challenge,Admin,Total Matches,Wins,Losses,Draws,Wagered,Payouts,Net P&L,Win Rate %\n';
  challenges.forEach((ch) => {
    csv += `"${ch.challenge_title}",${ch.admin_username},${ch.total_matches},${ch.wins},${ch.losses},${ch.draws},${ch.total_wagered},${ch.total_payout},${ch.net_pnl},${ch.win_rate.toFixed(2)}\n`;
  });

  return csv;
}
