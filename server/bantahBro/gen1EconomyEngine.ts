import { TreasuryService } from './treasuryService'
import { FightPotService } from './fightPotService'
import { sql } from 'drizzle-orm'
import { db } from '../db'

export const BC_MINT_RATE = 10000 // 1 USDT = 10,000 BC (base)

export class Gen1EconomyEngine {
  treasury: TreasuryService
  potService: FightPotService

  constructor(opts?: { treasury?: TreasuryService; potService?: FightPotService }) {
    this.treasury = opts?.treasury || new TreasuryService()
    this.potService = opts?.potService || new FightPotService()
  }

  async mintBCFromFiat(userId: string, usdtAmount: number, bonusMultiplier = 1) {
    const bc = Math.floor(usdtAmount * BC_MINT_RATE * bonusMultiplier)
    // deposit into treasury
    await this.treasury.depositUSDT(usdtAmount)
    await this.treasury.mintBC(bc)
    // credit user
    await db.execute(sql`UPDATE "users" SET points = COALESCE(points,0) + ${bc} WHERE id = ${userId}`)
    // record mint event for auditing
    await db.execute(sql`INSERT INTO "bc_events" (user_id, type, amount, metadata, created_at) VALUES (${userId}, ${'mint'}, ${bc}, ${JSON.stringify({ usdtAmount, bonusMultiplier })}::jsonb, NOW())`)
    return { bc }
  }

  async burnBC(userId: string, amount: number, reason = 'unknown') {
    await db.execute(sql`UPDATE "users" SET points = GREATEST(COALESCE(points,0) - ${amount}, 0) WHERE id = ${userId}`)
    await this.treasury.burnBC(amount)
    // optionally record burn event
    await db.execute(sql`INSERT INTO "bc_events" (user_id, type, amount, metadata, created_at) VALUES (${userId}, ${'burn'}, ${amount}, ${JSON.stringify({ reason })}::jsonb, NOW())`)
  }

  async rewardSpectator(userId: string, watchSeconds: number) {
    // simple reward calc: 5 BC per 30s watched (configurable)
    const bc = Math.max(0, Math.floor((watchSeconds / 30) * 5))
    if (bc <= 0) return { bc: 0 }
    await db.execute(sql`UPDATE "users" SET points = COALESCE(points,0) + ${bc} WHERE id = ${userId}`)
    // record emission
    await db.execute(sql`INSERT INTO "bc_events" (user_id, type, amount, metadata, created_at) VALUES (${userId}, ${'spectator_reward'}, ${bc}, ${JSON.stringify({ watchSeconds })}::jsonb, NOW())`)
    return { bc }
  }

  async stakeForFight(userId: string, fightId: string, amount: number) {
    // debit user immediately
    await db.execute(sql`UPDATE "users" SET points = GREATEST(COALESCE(points,0) - ${amount}, 0) WHERE id = ${userId}`)
    // ensure pot exists
    const potId = await this.potService.createPot(fightId)
    await this.potService.addStake(potId, userId, amount)
    return { potId }
  }

  async resolveFight(fightId: string, winnerUserId: string) {
    // find pot for fight
    const pots = await db.execute(sql`SELECT * FROM "pots" WHERE fight_id = ${fightId} ORDER BY created_at DESC LIMIT 1`)
    const pot = (pots as any).rows?.[0]
    if (!pot) throw new Error('Pot not found')
    const split = await this.potService.calculateSplit(pot.id)
    await this.potService.finalizePot(pot.id, winnerUserId)
    // ledger updates: collect fees to treasury
    await this.treasury.depositUSDT(split.platformFee) // placeholder: platformFee stored as USDT-equivalent for simplicity
    await this.treasury.burnBC(split.burnAmount)
    return split
  }
}
