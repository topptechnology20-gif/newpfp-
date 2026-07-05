import { sql } from 'drizzle-orm'
import { db } from '../db'

export type Pot = {
  id: string
  fight_id: string
  total: number
  created_at: string
  resolved_at?: string | null
}

export type PotEntry = {
  id: string
  pot_id: string
  user_id: string
  amount: number
  kind: 'stake' | 'spectator' | 'fee'
}

export class FightPotService {
  async createPot(fightId: string) {
    const potId = `pot_${fightId}_${Date.now()}`
    await db.execute(sql`INSERT INTO "pots" (id, fight_id, total, created_at) VALUES (${potId}, ${fightId}, 0, NOW())`)
    return potId
  }

  async addStake(potId: string, userId: string, amount: number) {
    await db.execute(sql`INSERT INTO "pot_entries" (pot_id, user_id, amount, kind) VALUES (${potId}, ${userId}, ${amount}, 'stake')`)
    await db.execute(sql`UPDATE "pots" SET total = COALESCE(total,0) + ${amount} WHERE id = ${potId}`)
  }

  async addSpectatorBoost(potId: string, userId: string, amount: number) {
    await db.execute(sql`INSERT INTO "pot_entries" (pot_id, user_id, amount, kind) VALUES (${potId}, ${userId}, ${amount}, 'spectator')`)
    await db.execute(sql`UPDATE "pots" SET total = COALESCE(total,0) + ${amount} WHERE id = ${potId}`)
  }

  async getPot(potId: string) {
    const r = await db.execute(sql`SELECT * FROM "pots" WHERE id = ${potId} LIMIT 1`)
    return (r as any).rows?.[0] || null
  }

  async calculateSplit(potId: string) {
    // Default split: platformFee = 5%, burn = 1%, winner = rest
    const pot = await this.getPot(potId)
    if (!pot) throw new Error('Pot not found')
    const total = Number(pot.total || 0)
    const platformFee = Math.floor(total * 0.05)
    const burnAmount = Math.floor(total * 0.01)
    const winnerShare = total - platformFee - burnAmount
    return { total, platformFee, burnAmount, winnerShare }
  }

  async finalizePot(potId: string, winnerUserId: string) {
    const split = await this.calculateSplit(potId)
    // record distribution entries
    await db.execute(sql`UPDATE "pots" SET resolved_at = NOW() WHERE id = ${potId}`)
    // credit winner via users.points
    await db.execute(sql`UPDATE "users" SET points = COALESCE(points,0) + ${split.winnerShare} WHERE id = ${winnerUserId}`)
    // collect platform fee to treasury via pot_entries kind=fee (left as an implementation detail)
    return split
  }
}
