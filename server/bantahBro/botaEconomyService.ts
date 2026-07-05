import { db } from "../db";
import { eq, sql } from "drizzle-orm";
import { bantcreditBalances, bantcreditLedger, bantcreditPot } from "@shared/schema";

export const BASELINE_MULTIPLIER = 1.0;
export const INITIAL_RATE = 1.0;

export class EconomyService {
  /**
   * Recalculates and updates the Pot rate.
   */
  async updatePotRate(): Promise<{ usdtReserve: number; bcCirculation: number; currentRate: number }> {
    let pot = await db.query.bantcreditPot.findFirst({
      where: eq(bantcreditPot.id, 1)
    });

    if (!pot) {
      const [newPot] = await db.insert(bantcreditPot).values({
        id: 1,
        usdtReserve: "0",
        bcCirculation: "0",
        currentRate: INITIAL_RATE.toString(),
      }).returning();
      pot = newPot;
    }

    const usdt = parseFloat(pot.usdtReserve);
    const bc = parseFloat(pot.bcCirculation);
    
    let newRate = INITIAL_RATE;
    if (bc > 0 && usdt > 0) {
      newRate = (usdt / bc) * BASELINE_MULTIPLIER;
    }

    const [updated] = await db.update(bantcreditPot)
      .set({ currentRate: newRate.toString(), lastUpdated: new Date() })
      .where(eq(bantcreditPot.id, 1))
      .returning();

    return {
      usdtReserve: parseFloat(updated.usdtReserve),
      bcCirculation: parseFloat(updated.bcCirculation),
      currentRate: parseFloat(updated.currentRate),
    };
  }

  /**
   * User deposits USDT to receive BC.
   */
  async deposit(walletAddress: string, amountUsdt: number): Promise<void> {
    if (amountUsdt <= 0) throw new Error("Deposit amount must be positive");

    const stats = await this.updatePotRate();
    const bcToMint = amountUsdt / stats.currentRate;

    // 1. Update the Pot
    await db.update(bantcreditPot)
      .set({
        usdtReserve: sql`usdt_reserve + ${amountUsdt}`,
        bcCirculation: sql`bc_circulation + ${bcToMint}`,
        lastUpdated: new Date()
      })
      .where(eq(bantcreditPot.id, 1));

    // 2. Update user balance
    await db.insert(bantcreditBalances)
      .values({ walletAddress, balance: bcToMint.toString() })
      .onConflictDoUpdate({
        target: bantcreditBalances.walletAddress,
        set: {
          balance: sql`bantcredit_balances.balance + ${bcToMint}`,
          lastUpdated: new Date()
        }
      });

    // 3. Record transaction
    await db.insert(bantcreditLedger).values({
      walletAddress,
      amount: bcToMint.toString(),
      transactionType: "deposit",
    });
  }

  /**
   * User withdraws BC to receive USDT.
   */
  async withdraw(walletAddress: string, amountBc: number): Promise<void> {
    if (amountBc <= 0) throw new Error("Withdraw amount must be positive");

    const balanceRes = await db.query.bantcreditBalances.findFirst({
      where: eq(bantcreditBalances.walletAddress, walletAddress)
    });

    if (!balanceRes || parseFloat(balanceRes.balance) < amountBc) {
      throw new Error("Insufficient BC balance");
    }

    const stats = await this.updatePotRate();
    const usdtToReturn = amountBc * stats.currentRate;

    if (stats.usdtReserve < usdtToReturn) {
      throw new Error("Insufficient USDT in the Pot to fulfill withdrawal");
    }

    // 1. Update user balance
    await db.update(bantcreditBalances)
      .set({
        balance: sql`bantcredit_balances.balance - ${amountBc}`,
        lastUpdated: new Date()
      })
      .where(eq(bantcreditBalances.walletAddress, walletAddress));

    // 2. Update the Pot
    await db.update(bantcreditPot)
      .set({
        usdtReserve: sql`usdt_reserve - ${usdtToReturn}`,
        bcCirculation: sql`bc_circulation - ${amountBc}`,
        lastUpdated: new Date()
      })
      .where(eq(bantcreditPot.id, 1));

    // 3. Record transaction
    await db.insert(bantcreditLedger).values({
      walletAddress,
      amount: (-amountBc).toString(),
      transactionType: "withdraw",
    });
  }

  /**
   * Burn BC from user (e.g., Soul Drain burn penalty).
   */
  async burn(walletAddress: string, amountBc: number, reason: string): Promise<void> {
    if (amountBc <= 0) return;
    
    // Update balance
    await db.update(bantcreditBalances)
      .set({
        balance: sql`bantcredit_balances.balance - ${amountBc}`,
        lastUpdated: new Date()
      })
      .where(eq(bantcreditBalances.walletAddress, walletAddress));

    // Update the Pot to reflect burned BC (leaving USDT inside!)
    await db.update(bantcreditPot)
      .set({
        bcCirculation: sql`bc_circulation - ${amountBc}`,
        lastUpdated: new Date()
      })
      .where(eq(bantcreditPot.id, 1));
      
    // Record transaction
    await db.insert(bantcreditLedger).values({
      walletAddress,
      amount: (-amountBc).toString(),
      transactionType: `burn_${reason}`,
    });
    
    await this.updatePotRate();
  }

  /**
   * Transfer BC between users (e.g., Soul Drain win).
   */
  async transfer(fromWallet: string, toWallet: string, amountBc: number, reason: string): Promise<void> {
    if (amountBc <= 0) return;
    
    await db.update(bantcreditBalances)
      .set({ balance: sql`bantcredit_balances.balance - ${amountBc}` })
      .where(eq(bantcreditBalances.walletAddress, fromWallet));
      
    await db.insert(bantcreditBalances)
      .values({ walletAddress: toWallet, balance: amountBc.toString() })
      .onConflictDoUpdate({
        target: bantcreditBalances.walletAddress,
        set: { balance: sql`bantcredit_balances.balance + ${amountBc}` }
      });
      
    await db.insert(bantcreditLedger).values([
      { walletAddress: fromWallet, amount: (-amountBc).toString(), transactionType: `transfer_out_${reason}` },
      { walletAddress: toWallet, amount: amountBc.toString(), transactionType: `transfer_in_${reason}` },
    ]);
  }

  async getPotStats() {
    return this.updatePotRate();
  }
}

export const botaEconomyService = new EconomyService();
export default botaEconomyService;
