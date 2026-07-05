import { db } from './db';
import { treasuryWallets, treasuryWalletTransactions } from '../shared/schema';
import { eq, desc } from 'drizzle-orm';
import { Decimal } from 'decimal.js';

/**
 * Treasury Wallet Service
 * Manages admin Treasury wallets (separate from admin wallets)
 * Used for funding Treasury matches
 */

export async function getTreasuryWallet(adminId: string) {
  const wallet = await db
    .select()
    .from(treasuryWallets)
    .where(eq(treasuryWallets.adminId, adminId))
    .limit(1);

  return wallet.length > 0 ? wallet[0] : null;
}

export async function createOrGetTreasuryWallet(adminId: string) {
  const existing = await getTreasuryWallet(adminId);

  if (existing) {
    return existing;
  }

  // Create new wallet
  const result = await db
    .insert(treasuryWallets)
    .values({
      adminId,
      balance: '0.00',
      totalDeposited: '0.00',
      totalUsed: '0.00',
      totalEarned: '0.00',
    })
    .returning();

  return result[0];
}

export async function depositToTreasuryWallet(
  adminId: string,
  amount: number,
  paystackReference: string,
) {
  const wallet = await createOrGetTreasuryWallet(adminId);

  const newBalance = new Decimal(wallet.balance).plus(new Decimal(amount));
  const newDeposited = new Decimal(wallet.totalDeposited).plus(new Decimal(amount));

  // Update wallet balance
  await db
    .update(treasuryWallets)
    .set({
      balance: newBalance.toString(),
      totalDeposited: newDeposited.toString(),
      updatedAt: new Date(),
    })
    .where(eq(treasuryWallets.adminId, adminId));

  // Record transaction
  await db.insert(treasuryWalletTransactions).values({
    adminId,
    type: 'deposit',
    amount: new Decimal(amount).toString(),
    description: `Deposited to Treasury wallet`,
    reference: paystackReference,
    status: 'completed',
    balanceBefore: new Decimal(wallet.balance).toString(),
    balanceAfter: newBalance.toString(),
  });

  return newBalance;
}

export async function debitTreasuryWallet(
  adminId: string,
  amount: number,
  description: string,
  challengeId?: number,
) {
  const wallet = await getTreasuryWallet(adminId);

  if (!wallet) {
    throw new Error('Treasury wallet not found');
  }

  const walletBalance = new Decimal(wallet.balance);
  if (walletBalance.lessThan(new Decimal(amount))) {
    throw new Error(
      `Insufficient Treasury balance. Have: ₦${walletBalance.toFixed(2)}, Need: ₦${amount}`,
    );
  }

  const newBalance = walletBalance.minus(new Decimal(amount));
  const newUsed = new Decimal(wallet.totalUsed).plus(new Decimal(amount));

  // Update wallet
  await db
    .update(treasuryWallets)
    .set({
      balance: newBalance.toString(),
      totalUsed: newUsed.toString(),
      updatedAt: new Date(),
    })
    .where(eq(treasuryWallets.adminId, adminId));

  // Record transaction
  await db.insert(treasuryWalletTransactions).values({
    adminId,
    type: 'debit',
    amount: new Decimal(amount).toString(),
    description,
    relatedChallengeId: challengeId,
    status: 'completed',
    balanceBefore: walletBalance.toString(),
    balanceAfter: newBalance.toString(),
  });

  return newBalance;
}

/**
 * Credit Treasury wallet when Treasury wins (settle matches)
 */
export async function creditTreasuryWallet(
  adminId: string,
  amount: number,
  description: string,
  challengeId?: number,
  matchId?: number,
) {
  const wallet = await getTreasuryWallet(adminId);

  if (!wallet) {
    throw new Error('Treasury wallet not found');
  }

  const newBalance = new Decimal(wallet.balance).plus(new Decimal(amount));
  const newEarned = new Decimal(wallet.totalEarned).plus(new Decimal(amount));

  // Update wallet
  await db
    .update(treasuryWallets)
    .set({
      balance: newBalance.toString(),
      totalEarned: newEarned.toString(),
      updatedAt: new Date(),
    })
    .where(eq(treasuryWallets.adminId, adminId));

  // Record transaction
  await db.insert(treasuryWalletTransactions).values({
    adminId,
    type: 'credit',
    amount: new Decimal(amount).toString(),
    description,
    relatedChallengeId: challengeId,
    relatedMatchId: matchId,
    status: 'completed',
    balanceBefore: new Decimal(wallet.balance).toString(),
    balanceAfter: newBalance.toString(),
  });

  return newBalance;
}

export async function getTreasuryWalletTransactions(
  adminId: string,
  limit: number = 50,
) {
  return await db
    .select()
    .from(treasuryWalletTransactions)
    .where(eq(treasuryWalletTransactions.adminId, adminId))
    .orderBy(desc(treasuryWalletTransactions.createdAt))
    .limit(limit);
}

export async function getTreasuryWalletSummary(adminId: string) {
  const wallet = await getTreasuryWallet(adminId);

  if (!wallet) {
    return null;
  }

  return {
    balance: wallet.balance,
    totalDeposited: wallet.totalDeposited,
    totalUsed: wallet.totalUsed,
    totalEarned: wallet.totalEarned,
    netPnL: new Decimal(wallet.totalEarned).minus(new Decimal(wallet.totalUsed)),
    status: wallet.status,
  };
}
