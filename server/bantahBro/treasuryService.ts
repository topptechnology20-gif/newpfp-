import { sql } from 'drizzle-orm'
import { db } from '../db'

export type TreasuryState = {
  id: string
  usdt_balance: number
  bnb_balance: number
  total_bc_minted: number
  total_bc_burned: number
}

export class TreasuryService {
  private readonly STATE_ID = 'main'

  async getState(): Promise<TreasuryState> {
    const res = await db.execute(sql`SELECT * FROM "treasury_state" WHERE id = ${this.STATE_ID} LIMIT 1`)
    const rows = (res as any).rows || []
    if (rows.length) return rows[0]
    // initialize
    await db.execute(sql`INSERT INTO "treasury_state" (id, usdt_balance, bnb_balance, total_bc_minted, total_bc_burned) VALUES (${this.STATE_ID}, 0, 0, 0, 0)`)
    const r2 = await db.execute(sql`SELECT * FROM "treasury_state" WHERE id = ${this.STATE_ID} LIMIT 1`)
    return (r2 as any).rows[0]
  }

  async depositUSDT(amount: number) {
    await db.execute(sql`UPDATE "treasury_state" SET usdt_balance = COALESCE(usdt_balance,0) + ${amount} WHERE id = ${this.STATE_ID}`)
  }

  async depositBNB(amount: number) {
    await db.execute(sql`UPDATE "treasury_state" SET bnb_balance = COALESCE(bnb_balance,0) + ${amount} WHERE id = ${this.STATE_ID}`)
  }

  async mintBC(bcAmount: number) {
    await db.execute(sql`UPDATE "treasury_state" SET total_bc_minted = COALESCE(total_bc_minted,0) + ${bcAmount} WHERE id = ${this.STATE_ID}`)
  }

  async burnBC(bcAmount: number) {
    await db.execute(sql`UPDATE "treasury_state" SET total_bc_burned = COALESCE(total_bc_burned,0) + ${bcAmount} WHERE id = ${this.STATE_ID}`)
  }
}
