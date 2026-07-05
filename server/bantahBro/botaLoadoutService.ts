import { db } from "../db";
import { eq, and } from "drizzle-orm";
import {
  botaToolInventory,
  botaFighterLoadout,
  botaToolsCatalog,
} from "@shared/schema";

export async function equipTool(walletAddress: string, fighterId: string, inventoryId: string, slot: "primary" | "secondary" | "passive") {
  // Verify ownership
  const toolItem = await db.query.botaToolInventory.findFirst({
    where: and(
      eq(botaToolInventory.id, inventoryId),
      eq(botaToolInventory.ownerWallet, walletAddress)
    ),
    with: {
      catalogItem: true, // Requires relation in schema, simulating logic
    }
  });

  if (!toolItem) {
    throw new Error("Tool not found in inventory or not owned by wallet.");
  }

  // Get catalog details to verify role match
  const catalogRes = await db.query.botaToolsCatalog.findFirst({
    where: eq(botaToolsCatalog.id, toolItem.toolCatalogId)
  });

  if (!catalogRes || catalogRes.role !== slot) {
    throw new Error(`Tool role ${catalogRes?.role} does not match slot ${slot}.`);
  }

  // Find or create loadout
  let loadout = await db.query.botaFighterLoadout.findFirst({
    where: eq(botaFighterLoadout.fighterId, fighterId)
  });

  const updates: Partial<typeof botaFighterLoadout.$inferInsert> = {
    ownerWallet: walletAddress,
  };

  if (slot === "primary") updates.primaryToolId = inventoryId;
  if (slot === "secondary") updates.secondaryToolId = inventoryId;
  if (slot === "passive") updates.passiveToolId = inventoryId;

  // Assuming recalculateEffectiveTier handles the effective tier
  updates.effectiveTier = catalogRes.tier; // Simplified
  updates.soulDrainActive = catalogRes.tier === "epic" || catalogRes.soulDrainEnabled;

  if (loadout) {
    await db.update(botaFighterLoadout)
      .set({ ...updates, lastUpdated: new Date() })
      .where(eq(botaFighterLoadout.fighterId, fighterId));
  } else {
    await db.insert(botaFighterLoadout).values({
      fighterId,
      ownerWallet: walletAddress,
      primaryToolId: slot === "primary" ? inventoryId : null,
      secondaryToolId: slot === "secondary" ? inventoryId : null,
      passiveToolId: slot === "passive" ? inventoryId : null,
      effectiveTier: updates.effectiveTier as string,
      soulDrainActive: updates.soulDrainActive as boolean,
    });
  }

  // Mark inventory as equipped
  await db.update(botaToolInventory)
    .set({ equippedToFighterId: fighterId, equippedAt: new Date() })
    .where(eq(botaToolInventory.id, inventoryId));
    
  return true;
}

export async function unequipTool(walletAddress: string, fighterId: string, slot: "primary" | "secondary" | "passive") {
  const loadout = await db.query.botaFighterLoadout.findFirst({
    where: and(
      eq(botaFighterLoadout.fighterId, fighterId),
      eq(botaFighterLoadout.ownerWallet, walletAddress)
    )
  });

  if (!loadout) return false;

  const inventoryId = slot === "primary" ? loadout.primaryToolId : slot === "secondary" ? loadout.secondaryToolId : loadout.passiveToolId;
  
  if (!inventoryId) return true; // Already empty

  const updates: any = {};
  if (slot === "primary") updates.primaryToolId = null;
  if (slot === "secondary") updates.secondaryToolId = null;
  if (slot === "passive") updates.passiveToolId = null;

  await db.update(botaFighterLoadout)
    .set({ ...updates, lastUpdated: new Date() })
    .where(eq(botaFighterLoadout.fighterId, fighterId));

  await db.update(botaToolInventory)
    .set({ equippedToFighterId: null, equippedAt: null })
    .where(eq(botaToolInventory.id, inventoryId));

  return true;
}

export default {
  equipTool,
  unequipTool,
};
