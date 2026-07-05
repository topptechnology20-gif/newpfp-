import { db } from "../db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { 
  marketplaceListings, 
  botaFighterProfiles, 
  botaToolInventory, 
  botaFighterLoadout,
  bantcreditPot 
} from "@shared/schema";

export async function listFighterForSale(sellerWallet: string, fighterId: string, priceUsdt: number) {
  // Verify ownership
  const fighter = await db.query.botaFighterProfiles.findFirst({
    where: eq(botaFighterProfiles.agentId, fighterId)
  });

  if (!fighter || fighter.walletAddress !== sellerWallet) {
    throw new Error("Fighter not owned by seller");
  }

  // Check if already listed
  const existing = await db.query.marketplaceListings.findFirst({
    where: and(
      eq(marketplaceListings.fighterId, fighterId),
      eq(marketplaceListings.status, "active")
    )
  });

  if (existing) {
    throw new Error("Fighter is already listed");
  }

  // Create listing
  const [listing] = await db.insert(marketplaceListings)
    .values({
      sellerWallet,
      fighterId,
      priceUsdt: priceUsdt.toString(),
      status: "active",
    })
    .returning();

  return listing;
}

export async function buyFighter(buyerWallet: string, listingId: string) {
  const listing = await db.query.marketplaceListings.findFirst({
    where: and(
      eq(marketplaceListings.id, listingId),
      eq(marketplaceListings.status, "active")
    )
  });

  if (!listing) {
    throw new Error("Listing not found or not active");
  }

  const priceUsdt = parseFloat(listing.priceUsdt);
  const feeUsdt = priceUsdt * 0.05; // 5% fee goes to the pot
  const sellerReceives = priceUsdt - feeUsdt;

  // In a real system, you'd transfer USDT from buyer to seller here.
  // For this economy engine, we simulate the fee going to the Pot.
  
  // Add 5% fee to BantCredit Pot
  await db.update(bantcreditPot)
    .set({
      usdtReserve: sql`usdt_reserve + ${feeUsdt}`,
      lastUpdated: new Date()
    })
    .where(eq(bantcreditPot.id, 1));

  // Mark listing as sold
  await db.update(marketplaceListings)
    .set({ status: "sold" })
    .where(eq(marketplaceListings.id, listingId));

  // Transfer Fighter Ownership
  await db.update(botaFighterProfiles)
    .set({ walletAddress: buyerWallet, updatedAt: new Date() })
    .where(eq(botaFighterProfiles.agentId, listing.fighterId));

  // Transfer all equipped tools in loadout
  const loadout = await db.query.botaFighterLoadout.findFirst({
    where: eq(botaFighterLoadout.fighterId, listing.fighterId)
  });

  if (loadout) {
    await db.update(botaFighterLoadout)
      .set({ ownerWallet: buyerWallet, lastUpdated: new Date() })
      .where(eq(botaFighterLoadout.fighterId, listing.fighterId));

    const toolIds = [loadout.primaryToolId, loadout.secondaryToolId, loadout.passiveToolId].filter(Boolean) as string[];
    
    if (toolIds.length > 0) {
      await db.update(botaToolInventory)
        .set({ ownerWallet: buyerWallet })
        .where(inArray(botaToolInventory.id, toolIds));
    }
  }

  return { success: true, listingId, sellerReceives, feeUsdt };
}

export async function cancelListing(sellerWallet: string, listingId: string) {
  const listing = await db.query.marketplaceListings.findFirst({
    where: and(
      eq(marketplaceListings.id, listingId),
      eq(marketplaceListings.sellerWallet, sellerWallet),
      eq(marketplaceListings.status, "active")
    )
  });

  if (!listing) throw new Error("Listing not found or unauthorized");

  await db.update(marketplaceListings)
    .set({ status: "cancelled" })
    .where(eq(marketplaceListings.id, listingId));

  return { success: true };
}

export default {
  listFighterForSale,
  buyFighter,
  cancelListing,
};
