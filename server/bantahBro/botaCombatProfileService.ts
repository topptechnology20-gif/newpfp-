import { db } from "../db";
import { eq } from "drizzle-orm";
import { botaFighterCombatProfiles, botaFighterProfiles, InsertBotaFighterCombatProfile } from "@shared/schema";
import crypto from "crypto";

export type CombatProfile = {
  aggression: number;
  defense: number;
  intelligence: number;
  speed: number;
  luck: number;
  hp: number;
  generationBonus?: number;
};

export type ENSMetadata = {
  name: string;
  registrationAgeDays: number;
  hasEmoji: boolean;
  isPalindrome: boolean;
  isNumericOnly: boolean;
  isThreeLetter: boolean;
};

export type TokenMetadata = {
  volume24h: number;
  holderCount: number;
  ageInDays: number;
  priceChangeAbs24h: number; // absolute %
  priceChange7dAbs: number; // absolute %
  marketCapUSD: number;
};

export type AgentConfig = {
  goal: string;
  description: string;
  personality: string;
};

export type NFTMetadata = {
  rarityScore: number;
  generation?: number;
  attributes: Array<{ type: string; value: string }>;
};

function normalize(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

function hashEntropy(str: string): number {
  const hash = crypto.createHash("md5").update(str).digest("hex");
  const num = parseInt(hash.slice(0, 8), 16);
  return (num % 100) / 100; // 0.0 to 0.99
}

function luckScore(ens: ENSMetadata): number {
  let score = 20; // base
  if (ens.hasEmoji) score += 30;
  if (ens.isPalindrome) score += 20;
  if (ens.isNumericOnly) score += 15;
  if (ens.isThreeLetter) score += 10;
  return Math.min(100, score);
}

export function generateENSCombatProfile(ens: ENSMetadata): CombatProfile {
  const nameLen = ens.name.replace(".eth", "").length;

  let traits = {
    aggression: Math.max(10, 100 - nameLen * 10),
    defense: Math.min(100, ens.registrationAgeDays / 7),
    intelligence: hashEntropy(ens.name) * 100,
    speed: Math.max(10, 90 - nameLen * 8),
    luck: luckScore(ens),
    hp: 80 + ens.registrationAgeDays / 14 + nameLen * 2,
  };

  const nameLower = ens.name.toLowerCase();
  if (nameLower.includes("whale")) traits.defense += 30;
  if (nameLower.includes("degen")) { traits.aggression += 25; traits.luck += 20; }
  if (nameLower.includes("wizard")) traits.intelligence += 30;
  if (nameLower.includes("gm")) { traits.luck += 25; traits.speed += 10; }
  if (nameLower.includes("pepe")) traits.luck += 30;
  if (nameLower.includes("vitalik") || nameLower.includes("buterin")) { traits.intelligence += 25; traits.defense += 20; }
  if (nameLower.includes("pump") || nameLower.includes("moon") || nameLower.includes("ape")) traits.aggression += 20;
  if (nameLower.includes("safe") || nameLower.includes("shield") || nameLower.includes("guard")) traits.defense += 25;
  if (nameLower.includes("fast") || nameLower.includes("flash") || nameLower.includes("quick")) traits.speed += 30;

  Object.keys(traits).forEach((k) => {
    if (k !== "hp") traits[k as keyof typeof traits] = Math.min(100, Math.floor(traits[k as keyof typeof traits]));
  });
  traits.hp = Math.floor(traits.hp);

  return traits;
}

export function generateTokenCombatProfile(token: TokenMetadata): CombatProfile {
  let traits = {
    aggression: normalize(token.volume24h, 0, 1_000_000_000) * 100,
    defense: normalize(token.holderCount, 0, 100_000) * 100,
    intelligence: normalize(token.ageInDays, 0, 1000) * 100,
    speed: normalize(token.priceChangeAbs24h, 0, 50) * 100,
    luck: normalize(token.priceChange7dAbs, 0, 100) * 100,
    hp: 100 + normalize(token.marketCapUSD, 0, 10_000_000_000) * 200,
  };

  Object.keys(traits).forEach((k) => {
    if (k !== "hp") traits[k as keyof typeof traits] = Math.min(100, Math.floor(traits[k as keyof typeof traits]));
  });
  traits.hp = Math.floor(traits.hp);

  return traits;
}

export function generateAgentCombatProfile(agent: AgentConfig): CombatProfile {
  let traits = { aggression: 40, defense: 40, intelligence: 40, speed: 40, luck: 40, hp: 0 };
  const text = `${agent.goal} ${agent.description} ${agent.personality}`.toLowerCase();

  if (/aggressiv|dominat|attack|win|conquer|destroy/.test(text)) traits.aggression += 30;
  if (/analyz|research|calculat|optimiz|strateg|predict/.test(text)) traits.intelligence += 30;
  if (/protect|defend|shield|hold|preserve|guard/.test(text)) traits.defense += 30;
  if (/fast|quick|rapid|react|instant|speed/.test(text)) traits.speed += 30;
  if (/random|chaos|gamble|luck|wild|unpredictab/.test(text)) traits.luck += 30;

  if (/trading|market|trader/.test(text)) { traits.aggression += 15; traits.intelligence += 20; }
  if (/social|influenc|viral/.test(text)) { traits.luck += 20; traits.intelligence += 10; }
  if (/research|data|analyt/.test(text)) traits.intelligence += 20;

  Object.keys(traits).forEach((k) => {
    if (k !== "hp") traits[k as keyof typeof traits] = Math.min(100, Math.floor(traits[k as keyof typeof traits]));
  });
  
  traits.hp = Math.floor(120 + traits.intelligence * 0.5);

  return traits;
}

export function generateNFTCombatProfile(nft: NFTMetadata): CombatProfile {
  const rarityBase = normalize(nft.rarityScore, 0, 100) * 40;

  const traitBoosts = nft.attributes.reduce(
    (acc, attr) => {
      const typeStr = attr.type.toLowerCase();
      const valStr = attr.value.toLowerCase();
      const combined = `${typeStr} ${valStr}`;
      
      if (/attack|weapon|sword|fist/.test(combined)) acc.aggression += 15;
      if (/defense|shield|armor|tough/.test(combined)) acc.defense += 15;
      if (/eyes|brain|smart/.test(combined)) acc.intelligence += 10;
      if (/speed|wings|dash/.test(combined)) acc.speed += 15;
      if (/luck|gem|sparkle/.test(combined)) acc.luck += 15;
      return acc;
    },
    { aggression: 0, defense: 0, intelligence: 0, speed: 0, luck: 0 }
  );

  const genBonus = nft.generation !== undefined ? Math.max(0, 20 - nft.generation * 2) : 0;

  let traits = {
    aggression: Math.min(100, 30 + rarityBase + traitBoosts.aggression + genBonus),
    defense: Math.min(100, 30 + rarityBase + traitBoosts.defense),
    intelligence: Math.min(100, 25 + rarityBase + traitBoosts.intelligence + nft.attributes.length * 2),
    speed: Math.min(100, 30 + rarityBase + traitBoosts.speed),
    luck: Math.min(100, 25 + rarityBase + traitBoosts.luck),
    hp: Math.floor(100 + genBonus * 5 + nft.rarityScore),
    generationBonus: genBonus,
  };

  Object.keys(traits).forEach((k) => {
    if (k !== "hp" && k !== "generationBonus") {
      traits[k as keyof typeof traits] = Math.min(100, Math.floor(traits[k as keyof typeof traits]));
    }
  });

  return traits;
}

export async function upsertCombatProfile(fighterId: string, source: "ENS" | "ERC20" | "NFT" | "AGENT" | "manual", profile: CombatProfile) {
  const newProfile: InsertBotaFighterCombatProfile = {
    fighterId,
    source,
    aggression: profile.aggression,
    defense: profile.defense,
    intelligence: profile.intelligence,
    speed: profile.speed,
    luck: profile.luck,
    hp: profile.hp,
    generationBonus: profile.generationBonus ?? 0,
    profileGeneratedAt: new Date(),
    profileVersion: 1, // Basic logic for now
  };

  await db.insert(botaFighterCombatProfiles)
    .values(newProfile)
    .onConflictDoUpdate({
      target: botaFighterCombatProfiles.fighterId,
      set: {
        source,
        aggression: profile.aggression,
        defense: profile.defense,
        intelligence: profile.intelligence,
        speed: profile.speed,
        luck: profile.luck,
        hp: profile.hp,
        generationBonus: profile.generationBonus ?? 0,
        profileGeneratedAt: new Date(),
        profileVersion: sql`bota_fighter_combat_profiles.profile_version + 1`,
      }
    });
    
  // Link it to the main fighter profile if exists
  await db.update(botaFighterProfiles)
    .set({ combatProfileId: fighterId })
    .where(eq(botaFighterProfiles.agentId, fighterId));
    
  return newProfile;
}

export default {
  generateENSCombatProfile,
  generateTokenCombatProfile,
  generateAgentCombatProfile,
  generateNFTCombatProfile,
  upsertCombatProfile,
};
