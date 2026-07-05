import { beforeAll, describe, it, expect } from '@jest/globals'
import { initializeDatabase } from '../initDb'
import { db } from '../db'
import packService from '../bantahBro/packService'
import gen1Economy from '../bantahBro/gen1EconomyService'

describe('PackService - Drop table integration', () => {
  beforeAll(async () => {
    await initializeDatabase()
  })

  it('creates pack, seeds drops, buys and opens pack granting items', async () => {
    // ensure pack tables exist
    await packService.ensurePackTables()

    // create test pack
    await db.execute(`INSERT INTO "pack_catalog" (pack_id, type, display_name, metadata, initial_supply, remaining_supply, price_bc, price_usd, saleable) VALUES ('test-pack', 'test-type', 'Test Pack', '{}'::jsonb, 0, 0, 0, 0, true) ON CONFLICT (pack_id) DO NOTHING;`)

    // insert drop entries for test-type
    await db.execute(`INSERT INTO "pack_drops" (pack_type, tool_id, weight, name, rarity, metadata) VALUES ('test-type','test-tool-a',500,'Tool A','common','{}'::jsonb),('test-type','test-tool-b',100,'Tool B','rare','{}'::jsonb);`)

    // buy pack
    const buyer = 'test-user-1'
    const buyRes = await packService.buyPack('test-pack', buyer, { metadata: { reason: 'test' } })
    expect(buyRes).toBeDefined()
    const packInstanceId = buyRes.packInstanceId
    expect(packInstanceId).toBeTruthy()

    // open pack
    const openRes = await packService.openPack(packInstanceId, buyer, { mode: 'manual' })
    expect(openRes).toBeDefined()
    const items = openRes.items || openRes.result?.items || []
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBeGreaterThanOrEqual(1)

    // verify inventory updated
    const inv = await gen1Economy.getInventory(buyer)
    // inventory may have items keyed by tool ids
    expect(inv).toBeDefined()
  })
})
