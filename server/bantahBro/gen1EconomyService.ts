import { sql } from "drizzle-orm";
import { db } from "../db";

export type Gen1ToolRarity = "common" | "rare" | "epic";

type SeasonOneToolSeed = {
  toolId: string;
  name: string;
  rarity: Gen1ToolRarity;
  description: string;
  supplyTotal: number;
  metadata: Record<string, unknown>;
};

const GEN1_SEASON_ID = "gen1-season-1";
const GEN1_SEASON_NAME = "Gen 1 Season 1";

const GEN1_SEASON_ONE_TOOLS: SeasonOneToolSeed[] = [
  {
    toolId: "s1-common-laser-shot",
    name: "Laser Shot",
    rarity: "common",
    description: "Fires a direct energy beam. Simple, reliable, and easy to read in battle.",
    supplyTotal: 1700,
    metadata: { tierLabel: "Basic Ability", priceBc: 500, priceUsd: 0.05, tacticalEffect: "Direct single-target pressure", purchasePath: "earned_or_purchased_bantcredit", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23451a03'/%3E%3Cline x1='4' y1='16' x2='28' y2='16' stroke='%23fbbf24' stroke-width='3' stroke-linecap='round'/%3E%3Ccircle cx='26' cy='16' r='3' fill='%23fbbf24'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-common-static-pulse",
    name: "Static Pulse",
    rarity: "common",
    description: "Sends a short shockwave that can stagger an opponent for one round.",
    supplyTotal: 1700,
    metadata: { tierLabel: "Basic Ability", priceBc: 500, priceUsd: 0.05, tacticalEffect: "Small stagger chance", purchasePath: "earned_or_purchased_bantcredit", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23451a03'/%3E%3Cpath d='M8 16 Q12 8 16 16 Q20 24 24 16' stroke='%23fbbf24' stroke-width='2.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-common-decoy-ping",
    name: "Decoy Ping",
    rarity: "common",
    description: "Creates a fake signal that can distract the opponent for a turn.",
    supplyTotal: 1700,
    metadata: { tierLabel: "Basic Ability", priceBc: 500, priceUsd: 0.05, tacticalEffect: "Distracts one action", purchasePath: "earned_or_purchased_bantcredit", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23451a03'/%3E%3Ccircle cx='16' cy='16' r='4' fill='%23fbbf24'/%3E%3Ccircle cx='16' cy='16' r='8' fill='none' stroke='%23fbbf24' stroke-width='1.5' opacity='0.6'/%3E%3Ccircle cx='16' cy='16' r='12' fill='none' stroke='%23fbbf24' stroke-width='1' opacity='0.3'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-common-shield-bubble",
    name: "Shield Bubble",
    rarity: "common",
    description: "Blocks the next incoming hit once per round.",
    supplyTotal: 1700,
    metadata: { tierLabel: "Basic Ability", priceBc: 500, priceUsd: 0.05, tacticalEffect: "Safe defensive timing", purchasePath: "earned_or_purchased_bantcredit", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23451a03'/%3E%3Cpath d='M16 6 L6 11 L6 18 C6 23 11 27 16 28 C21 27 26 23 26 18 L26 11 Z' fill='none' stroke='%23fbbf24' stroke-width='2' stroke-linejoin='round'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-common-power-dash",
    name: "Power Dash",
    rarity: "common",
    description: "Closes distance quickly so the next action is harder to avoid.",
    supplyTotal: 1600,
    metadata: { tierLabel: "Basic Ability", priceBc: 500, priceUsd: 0.05, tacticalEffect: "Next action becomes harder to dodge", purchasePath: "earned_or_purchased_bantcredit", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23451a03'/%3E%3Cpath d='M8 16 L22 16 M18 11 L23 16 L18 21' stroke='%23fbbf24' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3Cline x1='6' y1='12' x2='14' y2='12' stroke='%23fbbf24' stroke-width='1.5' stroke-linecap='round' opacity='0.5'/%3Cline x1='6' y1='20' x2='14' y2='20' stroke='%23fbbf24' stroke-width='1.5' stroke-linecap='round' opacity='0.5'/%3C/svg%3E" },
  },
  {
    toolId: "s1-common-overclock",
    name: "Overclock",
    rarity: "common",
    description: "Lets the fighter take an extra action during the current round.",
    supplyTotal: 1600,
    metadata: { tierLabel: "Basic Ability", priceBc: 500, priceUsd: 0.05, tacticalEffect: "Short burst tempo", purchasePath: "earned_or_purchased_bantcredit", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23451a03'/%3E%3Ccircle cx='16' cy='16' r='8' fill='none' stroke='%23fbbf24' stroke-width='2'/%3E%3Cpath d='M16 10 L16 16 L20 18' stroke='%23fbbf24' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3Cpath d='M12 5 L14 8' stroke='%23fbbf24' stroke-width='1.5' stroke-linecap='round'/%3E%3Cpath d='M20 5 L18 8' stroke='%23fbbf24' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-rare-bounce-laser",
    name: "Bounce Laser",
    rarity: "rare",
    description: "Laser ricochets, reaches protected targets, and applies slow for the next round.",
    supplyTotal: 170,
    metadata: { tierLabel: "Advanced Ability", priceBc: 50000, priceUsd: 4.99, tacticalEffect: "Bounces and applies slow", purchasePath: "purchased_bantcredit", unlockRequiresFights: 10, imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%231e3a5f'/%3E%3Cpath d='M5 22 L14 12 L22 20 L27 10' stroke='%2360a5fa' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3Ccircle cx='14' cy='12' r='2' fill='%2360a5fa'/%3E%3Ccircle cx='22' cy='20' r='2' fill='%2360a5fa'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-rare-chain-pulse",
    name: "Chain Pulse",
    rarity: "rare",
    description: "Pulse chains into a second hit at reduced force.",
    supplyTotal: 170,
    metadata: { tierLabel: "Advanced Ability", priceBc: 50000, priceUsd: 4.99, tacticalEffect: "Second chain hit", purchasePath: "purchased_bantcredit", unlockRequiresFights: 10, imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%231e3a5f'/%3E%3Cpath d='M6 16 Q10 8 14 16' stroke='%2360a5fa' stroke-width='2.5' fill='none' stroke-linecap='round'/%3E%3Cpath d='M14 16 Q18 8 22 16' stroke='%2360a5fa' stroke-width='2' fill='none' stroke-linecap='round' opacity='0.7'/%3E%3Cpath d='M22 16 Q25 10 27 16' stroke='%2360a5fa' stroke-width='1.5' fill='none' stroke-linecap='round' opacity='0.4'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-rare-mirror-decoy",
    name: "Mirror Decoy",
    rarity: "rare",
    description: "The decoy copies the fighter's last move if the opponent ignores it.",
    supplyTotal: 170,
    metadata: { tierLabel: "Advanced Ability", priceBc: 50000, priceUsd: 4.99, tacticalEffect: "Copies last move", purchasePath: "purchased_bantcredit", unlockRequiresFights: 10, imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%231e3a5f'/%3E%3Crect x='14' y='6' width='4' height='20' rx='1' fill='%2360a5fa' opacity='0.3'/%3E%3Ccircle cx='10' cy='13' r='3' fill='%2360a5fa'/%3E%3Ccircle cx='22' cy='13' r='3' fill='%2360a5fa' opacity='0.6'/%3E%3Cpath d='M10 13 L22 13' stroke='%2360a5fa' stroke-width='1' stroke-dasharray='2 2'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-rare-reactive-shield",
    name: "Reactive Shield",
    rarity: "rare",
    description: "Shield absorbs a hit and reflects a portion back.",
    supplyTotal: 170,
    metadata: { tierLabel: "Advanced Ability", priceBc: 50000, priceUsd: 4.99, tacticalEffect: "Reflects pressure", purchasePath: "purchased_bantcredit", unlockRequiresFights: 10, imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%231e3a5f'/%3E%3Cpath d='M16 6 L7 10 L7 17 C7 22 11 26 16 27 C21 26 25 22 25 17 L25 10 Z' fill='none' stroke='%2360a5fa' stroke-width='2' stroke-linejoin='round'/%3E%3Cpath d='M13 17 L16 14 L19 17' stroke='%2360a5fa' stroke-width='1.5' stroke-linecap='round' fill='none'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-rare-phase-dash",
    name: "Phase Dash",
    rarity: "rare",
    description: "Dash becomes a dodge and counter setup in the same move.",
    supplyTotal: 160,
    metadata: { tierLabel: "Advanced Ability", priceBc: 50000, priceUsd: 4.99, tacticalEffect: "Dodge plus counter setup", purchasePath: "purchased_bantcredit", unlockRequiresFights: 10, imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%231e3a5f'/%3E%3Cpath d='M8 16 L20 16 M16 11 L21 16 L16 21' stroke='%2360a5fa' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3Cpath d='M6 11 L10 16 L6 21' stroke='%2360a5fa' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' fill='none' opacity='0.5'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-rare-turbo-clock",
    name: "Turbo Clock",
    rarity: "rare",
    description: "Overclock stays active for two rounds instead of one.",
    supplyTotal: 160,
    metadata: { tierLabel: "Advanced Ability", priceBc: 50000, priceUsd: 4.99, tacticalEffect: "Two-round tempo", purchasePath: "purchased_bantcredit", unlockRequiresFights: 10, imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%231e3a5f'/%3E%3Ccircle cx='16' cy='16' r='8' fill='none' stroke='%2360a5fa' stroke-width='2'/%3E%3Cpath d='M16 10 L16 16 L20 14' stroke='%2360a5fa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3Cpath d='M20 6 L23 8' stroke='%2360a5fa' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M24 10 L26 8' stroke='%2360a5fa' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-epic-mark-laser",
    name: "Mark Laser",
    rarity: "epic",
    description: "Laser marks the opponent so the next two actions can focus that target.",
    supplyTotal: 17,
    metadata: { tierLabel: "Signature Ability", priceBc: 200000, priceUsd: 19.99, tacticalEffect: "Marks target for follow-up focus", purchasePath: "purchased_bantcredit", unlockRequiresFights: 50, requiresRareTool: true, passive: "Memory Extraction on win", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%233b0764'/%3E%3Cline x1='4' y1='16' x2='28' y2='16' stroke='%23c084fc' stroke-width='2.5' stroke-linecap='round'/%3E%3Ccircle cx='16' cy='16' r='4' fill='none' stroke='%23c084fc' stroke-width='2'/%3E%3Ccircle cx='16' cy='16' r='1.5' fill='%23c084fc'/%3Cline x1='16' y1='6' x2='16' y2='28' stroke='%23c084fc' stroke-width='1' opacity='0.4'/%3C/svg%3E" },
  },
  {
    toolId: "s1-epic-cascade-pulse",
    name: "Cascade Pulse",
    rarity: "epic",
    description: "Shockwave splits into three effects: slow, stagger, and blind.",
    supplyTotal: 17,
    metadata: { tierLabel: "Signature Ability", priceBc: 200000, priceUsd: 19.99, tacticalEffect: "Three tactical status effects", purchasePath: "purchased_bantcredit", unlockRequiresFights: 50, requiresRareTool: true, passive: "Memory Extraction on win", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%233b0764'/%3E%3Cpath d='M6 20 Q10 10 16 16' stroke='%23c084fc' stroke-width='2.5' fill='none' stroke-linecap='round'/%3E%3Cpath d='M16 16 Q20 6 26 12' stroke='%23c084fc' stroke-width='2' fill='none' stroke-linecap='round' opacity='0.8'/%3E%3Cpath d='M16 16 Q14 22 20 24' stroke='%23c084fc' stroke-width='1.5' fill='none' stroke-linecap='round' opacity='0.6'/%3E%3Ccircle cx='16' cy='16' r='2' fill='%23c084fc'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-epic-phantom-decoy",
    name: "Phantom Decoy",
    rarity: "epic",
    description: "Decoy becomes a temporary fighter for one round.",
    supplyTotal: 17,
    metadata: { tierLabel: "Signature Ability", priceBc: 200000, priceUsd: 19.99, tacticalEffect: "One-round phantom assist", purchasePath: "purchased_bantcredit", unlockRequiresFights: 50, requiresRareTool: true, passive: "Memory Extraction on win", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%233b0764'/%3E%3Ccircle cx='12' cy='14' r='4' fill='%23c084fc' opacity='0.4'/%3E%3Ccircle cx='20' cy='14' r='4' fill='%23c084fc' opacity='0.8'/%3E%3Cpath d='M8 22 Q12 18 16 22 Q20 18 24 22' stroke='%23c084fc' stroke-width='1.5' fill='none' stroke-linecap='round' opacity='0.6'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-epic-fortress-shield",
    name: "Fortress Shield",
    rarity: "epic",
    description: "Shield lasts a full round and restores a small amount when it blocks.",
    supplyTotal: 17,
    metadata: { tierLabel: "Signature Ability", priceBc: 200000, priceUsd: 19.99, tacticalEffect: "Full-round shield plus recovery", purchasePath: "purchased_bantcredit", unlockRequiresFights: 50, requiresRareTool: true, passive: "Memory Extraction on win", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%233b0764'/%3E%3Cpath d='M16 5 L7 9 L7 17 C7 23 11 27 16 28 C21 27 25 23 25 17 L25 9 Z' fill='%23c084fc' opacity='0.2' stroke='%23c084fc' stroke-width='2' stroke-linejoin='round'/%3E%3Cpath d='M13 16 L15 18 L19 13' stroke='%23c084fc' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-epic-ghost-dash",
    name: "Ghost Dash",
    rarity: "epic",
    description: "Fighter becomes untargetable for one round and repositions anywhere.",
    supplyTotal: 16,
    metadata: { tierLabel: "Signature Ability", priceBc: 200000, priceUsd: 19.99, tacticalEffect: "Untargetable reposition", purchasePath: "purchased_bantcredit", unlockRequiresFights: 50, requiresRareTool: true, passive: "Memory Extraction on win", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%233b0764'/%3E%3Cpath d='M10 16 L22 16 M18 11 L23 16 L18 21' stroke='%23c084fc' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3Ccircle cx='10' cy='16' r='3' fill='%23c084fc' opacity='0.3'/%3E%3Ccircle cx='10' cy='16' r='3' fill='none' stroke='%23c084fc' stroke-width='1.5' stroke-dasharray='2 2'/%3E%3C/svg%3E" },
  },
  {
    toolId: "s1-epic-infinite-clock",
    name: "Infinite Clock",
    rarity: "epic",
    description: "If the fighter wins a round, Overclock carries into the next one.",
    supplyTotal: 16,
    metadata: { tierLabel: "Signature Ability", priceBc: 200000, priceUsd: 19.99, tacticalEffect: "Tempo chain on round win", purchasePath: "purchased_bantcredit", unlockRequiresFights: 50, requiresRareTool: true, passive: "Memory Extraction on win", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%233b0764'/%3E%3Ccircle cx='16' cy='16' r='8' fill='none' stroke='%23c084fc' stroke-width='2'/%3E%3Cpath d='M16 10 L16 16 L21 18' stroke='%23c084fc' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3Cpath d='M22 8 Q26 12 24 17' stroke='%23c084fc' stroke-width='1.5' fill='none' stroke-linecap='round' opacity='0.7'/%3E%3Cpath d='M24 17 L22 14 L26 15' fill='%23c084fc' opacity='0.7'/%3E%3C/svg%3E" },
  },
];

let ensureGen1EconomyTablesPromise: Promise<void> | null = null;
let seedGen1ToolsPromise: Promise<void> | null = null;
let ensureListingReservationsTablePromise: Promise<void> | null = null;

function rowsFromResult(result: unknown): any[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as any).rows)) return (result as any).rows;
  return [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rarityRank(rarity: string | null | undefined) {
  const normalized = String(rarity || "").toLowerCase();
  if (normalized === "epic") return 3;
  if (normalized === "rare") return 2;
  if (normalized === "common") return 1;
  return 0;
}

export async function ensureGen1EconomyTables() {
  if (!ensureGen1EconomyTablesPromise) {
    ensureGen1EconomyTablesPromise = (async () => {
      try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "tool_seasons" (
          "season_id" varchar(80) PRIMARY KEY NOT NULL,
          "name" varchar(180) NOT NULL,
          "start_at" timestamp,
          "end_at" timestamp,
          "cap_common" integer NOT NULL DEFAULT 10000,
          "cap_rare" integer NOT NULL DEFAULT 1000,
          "cap_epic" integer NOT NULL DEFAULT 100,
          "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        );
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "tools" (
          "tool_id" varchar(180) PRIMARY KEY NOT NULL,
          "season_id" varchar(80) REFERENCES "tool_seasons" ("season_id") ON DELETE SET NULL,
          "name" varchar(180) NOT NULL,
          "rarity" varchar(40) NOT NULL,
          "description" text,
          "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "supply_total" integer NOT NULL DEFAULT 0,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        );
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "tool_inventories" (
          "owner_user_id" varchar(180) NOT NULL,
          "tool_id" varchar(180) NOT NULL REFERENCES "tools" ("tool_id") ON DELETE CASCADE,
          "quantity" integer NOT NULL DEFAULT 0,
          "updated_at" timestamp NOT NULL DEFAULT now(),
          PRIMARY KEY ("owner_user_id", "tool_id")
        );
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "tool_purchases" (
          "purchase_id" varchar(180) PRIMARY KEY NOT NULL,
          "buyer_user_id" varchar(180) NOT NULL,
          "tool_id" varchar(180) NOT NULL REFERENCES "tools" ("tool_id") ON DELETE RESTRICT,
          "quantity" integer NOT NULL DEFAULT 1,
          "price_bc" integer NOT NULL DEFAULT 0,
          "price_native" numeric(38, 18) NOT NULL DEFAULT 0,
          "token_symbol" varchar(32) NOT NULL DEFAULT 'BC',
          "payment_tx_hash" varchar(128),
          "status" varchar(40) NOT NULL DEFAULT 'completed',
          "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "created_at" timestamp NOT NULL DEFAULT now()
        );
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "fighter_tool_loadouts" (
          "loadout_id" varchar(180) PRIMARY KEY NOT NULL,
          "agent_id" varchar(180) NOT NULL,
          "owner_user_id" varchar(180) NOT NULL,
          "tool_id" varchar(180) NOT NULL REFERENCES "tools" ("tool_id") ON DELETE RESTRICT,
          "status" varchar(40) NOT NULL DEFAULT 'equipped',
          "equipped" boolean NOT NULL DEFAULT true,
          "source_purchase_id" varchar(180),
          "source_tx_hash" varchar(128),
          "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "installed_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        );
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "listings" (
          "listing_id" varchar(180) PRIMARY KEY NOT NULL,
          "seller_user_id" varchar(180) NOT NULL,
          "tool_id" varchar(180) NOT NULL REFERENCES "tools" ("tool_id") ON DELETE RESTRICT,
          "quantity" integer NOT NULL DEFAULT 1,
          "price_native" numeric(38, 18) NOT NULL DEFAULT 0,
          "token_symbol" varchar(32) NOT NULL DEFAULT 'BNB',
          "status" varchar(40) NOT NULL DEFAULT 'open',
          "created_at" timestamp NOT NULL DEFAULT now(),
          "expires_at" timestamp,
          "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
        );
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "fighter_listings" (
          "listing_id" varchar(180) PRIMARY KEY NOT NULL,
          "seller_user_id" varchar(180) NOT NULL,
          "agent_id" varchar(180) NOT NULL,
          "price_native" numeric(38, 18) NOT NULL DEFAULT 0,
          "token_symbol" varchar(32) NOT NULL DEFAULT 'USDC',
          "status" varchar(40) NOT NULL DEFAULT 'open',
          "created_at" timestamp NOT NULL DEFAULT now(),
          "expires_at" timestamp,
          "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
        );
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "sales" (
          "sale_id" varchar(180) PRIMARY KEY NOT NULL,
          "listing_id" varchar(180) NOT NULL REFERENCES "listings" ("listing_id") ON DELETE CASCADE,
          "buyer_user_id" varchar(180) NOT NULL,
          "quantity" integer NOT NULL DEFAULT 1,
          "total_price_native" numeric(38, 18) NOT NULL DEFAULT 0,
          "sale_tx_hash" varchar(128),
          "created_at" timestamp NOT NULL DEFAULT now()
        );
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_tools_season" ON "tools" ("season_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_tool_purchases_buyer" ON "tool_purchases" ("buyer_user_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_tool_purchases_tool" ON "tool_purchases" ("tool_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_fighter_tool_loadouts_agent" ON "fighter_tool_loadouts" ("agent_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_fighter_tool_loadouts_owner" ON "fighter_tool_loadouts" ("owner_user_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_fighter_tool_loadouts_status" ON "fighter_tool_loadouts" ("status")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_listings_seller" ON "listings" ("seller_user_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_listings_status" ON "listings" ("status")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_fighter_listings_agent" ON "fighter_listings" ("agent_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_fighter_listings_seller" ON "fighter_listings" ("seller_user_id")`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_fighter_listings_status" ON "fighter_listings" ("status")`);
      } catch (err) {
        console.warn('Skipped DDL in ensureGen1EconomyTables (likely connection pooler):', err instanceof Error ? err.message : String(err));
      }
    })();
  }
  return ensureGen1EconomyTablesPromise;
}

export async function seedGen1SeasonOneTools() {
  if (!seedGen1ToolsPromise) {
    seedGen1ToolsPromise = (async () => {
      await ensureGen1EconomyTables();
      await db.execute(sql`
        INSERT INTO "tool_seasons" (
          "season_id", "name", "cap_common", "cap_rare", "cap_epic", "metadata", "updated_at"
        ) VALUES (
          ${GEN1_SEASON_ID}, ${GEN1_SEASON_NAME}, 10000, 1000, 100,
          ${JSON.stringify({ model: "limited_replenishing", common: 10000, rare: 1000, epic: 100 })}::jsonb,
          now()
        )
        ON CONFLICT ("season_id") DO UPDATE SET
          "name" = EXCLUDED."name",
          "cap_common" = EXCLUDED."cap_common",
          "cap_rare" = EXCLUDED."cap_rare",
          "cap_epic" = EXCLUDED."cap_epic",
          "metadata" = EXCLUDED."metadata",
          "updated_at" = now();
      `);

      for (const tool of GEN1_SEASON_ONE_TOOLS) {
        await upsertTool({
          toolId: tool.toolId,
          seasonId: GEN1_SEASON_ID,
          name: tool.name,
          rarity: tool.rarity,
          description: tool.description,
          metadata: { ...tool.metadata, seasonId: GEN1_SEASON_ID, seasonName: GEN1_SEASON_NAME, catalog: "official" },
          supplyTotal: tool.supplyTotal,
        });
      }
    })();
  }
  return seedGen1ToolsPromise;
}

export async function getTool(toolId: string) {
  await seedGen1SeasonOneTools();
  const result = await db.execute(sql`SELECT * FROM "tools" WHERE "tool_id" = ${toolId} LIMIT 1;`);
  return rowsFromResult(result)[0] || null;
}

export async function upsertTool(params: {
  toolId: string;
  seasonId?: string | null;
  name: string;
  rarity: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  supplyTotal?: number | null;
}) {
  await ensureGen1EconomyTables();
  const result = await db.execute(sql`
    INSERT INTO "tools" (
      "tool_id", "season_id", "name", "rarity", "description", "metadata", "supply_total", "updated_at"
    ) VALUES (
      ${params.toolId}, ${params.seasonId || null}, ${params.name}, ${params.rarity}, ${params.description || null},
      ${JSON.stringify(params.metadata || {})}::jsonb, ${params.supplyTotal || 0}, now()
    )
    ON CONFLICT ("tool_id") DO UPDATE SET
      "season_id" = COALESCE(EXCLUDED."season_id", "tools"."season_id"),
      "name" = COALESCE(EXCLUDED."name", "tools"."name"),
      "rarity" = COALESCE(EXCLUDED."rarity", "tools"."rarity"),
      "description" = COALESCE(EXCLUDED."description", "tools"."description"),
      "metadata" = COALESCE(EXCLUDED."metadata", "tools"."metadata"),
      "supply_total" = COALESCE(EXCLUDED."supply_total", "tools"."supply_total"),
      "updated_at" = now()
    RETURNING *;
  `);
  return rowsFromResult(result)[0] || null;
}

export async function adjustInventory(ownerUserId: string, toolId: string, delta: number) {
  await ensureGen1EconomyTables();
  const normalizedDelta = Math.round(Number(delta) || 0);
  await db.execute(sql`
    INSERT INTO "tool_inventories" ("owner_user_id", "tool_id", "quantity", "updated_at")
    VALUES (${ownerUserId}, ${toolId}, 0, now())
    ON CONFLICT ("owner_user_id", "tool_id") DO NOTHING;
  `);
  if (normalizedDelta) {
    await db.execute(sql`
      UPDATE "tool_inventories"
      SET "quantity" = GREATEST(0, "quantity" + ${normalizedDelta}), "updated_at" = now()
      WHERE "owner_user_id" = ${ownerUserId} AND "tool_id" = ${toolId};
    `);
  }
  const result = await db.execute(sql`
    SELECT "quantity" FROM "tool_inventories"
    WHERE "owner_user_id" = ${ownerUserId} AND "tool_id" = ${toolId}
    LIMIT 1;
  `);
  const rows = rowsFromResult(result);
  return rows[0] ? Number(rows[0].quantity || 0) : 0;
}

export async function purchaseToolWithBantCredit(params: {
  purchaseId: string;
  buyerUserId: string;
  toolId: string;
  quantity?: number;
  metadata?: Record<string, unknown> | null;
}) {
  await seedGen1SeasonOneTools();
  const tool = await getTool(params.toolId);
  if (!tool) throw new Error("Tool not found");

  const metadata = objectValue(tool.metadata);
  const rarity = String(tool.rarity || "").toLowerCase();
  if (rarity !== "common") {
    const error = new Error("Rare and Epic tools require purchased BantCredit checkout before inventory can be granted.");
    (error as Error & { statusCode?: number }).statusCode = 402;
    throw error;
  }

  const quantity = Math.max(1, Math.min(25, Math.round(params.quantity || 1)));
  const unitPriceBc = Math.max(0, Math.round(numberValue(metadata.priceBc, 0)));
  const totalPriceBc = unitPriceBc * quantity;
  if (totalPriceBc <= 0) throw new Error("Tool price is not configured");

  const balanceUpdate = await db.execute(sql`
    UPDATE "users"
    SET "points" = COALESCE("points", 0) - ${totalPriceBc}
    WHERE "id" = ${params.buyerUserId} AND COALESCE("points", 0) >= ${totalPriceBc}
    RETURNING "points";
  `);
  const balanceRows = rowsFromResult(balanceUpdate);
  if (!balanceRows.length) {
    const error = new Error(`Insufficient BantCredit. Need ${totalPriceBc} BC.`);
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  const purchase = await db.execute(sql`
    INSERT INTO "tool_purchases" (
      "purchase_id", "buyer_user_id", "tool_id", "quantity", "price_bc", "price_native",
      "token_symbol", "status", "metadata"
    ) VALUES (
      ${params.purchaseId}, ${params.buyerUserId}, ${params.toolId}, ${quantity}, ${totalPriceBc}, 0,
      'BC', 'completed', ${JSON.stringify({ ...(params.metadata || {}), unitPriceBc, totalPriceBc, purchasePath: "earned_bantcredit" })}::jsonb
    )
    RETURNING *;
  `);
  await adjustInventory(params.buyerUserId, params.toolId, quantity);
  return { purchase: rowsFromResult(purchase)[0] || null, balance: Number(balanceRows[0]?.points || 0) };
}

export async function purchaseToolWithNativeToken(params: {
  purchaseId: string;
  buyerUserId: string;
  toolId: string;
  quantity?: number;
  priceNative: string | number;
  tokenSymbol?: string;
  paymentTxHash?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  await seedGen1SeasonOneTools();
  const tool = await getTool(params.toolId);
  if (!tool) throw new Error("Tool not found");

  const metadata = objectValue(tool.metadata);
  const quantity = Math.max(1, Math.min(25, Math.round(params.quantity || 1)));
  const unitPriceBc = Math.max(0, Math.round(numberValue(metadata.priceBc, 0)));
  const totalPriceBc = unitPriceBc * quantity;
  if (totalPriceBc <= 0) throw new Error("Tool price is not configured");

  const priceNativeStr = String(params.priceNative || "0");
  const tokenSymbol = params.tokenSymbol || "BNB";

  const purchase = await db.execute(sql`
    INSERT INTO "tool_purchases" (
      "purchase_id", "buyer_user_id", "tool_id", "quantity", "price_bc", "price_native",
      "token_symbol", "status", "payment_tx_hash", "metadata"
    ) VALUES (
      ${params.purchaseId}, ${params.buyerUserId}, ${params.toolId}, ${quantity}, ${totalPriceBc}, ${priceNativeStr},
      ${tokenSymbol}, 'completed', ${params.paymentTxHash || null}, ${JSON.stringify({ ...(params.metadata || {}), unitPriceBc, totalPriceBc, purchasePath: "native_purchase" })}::jsonb
    )
    RETURNING *;
  `);

  await adjustInventory(params.buyerUserId, params.toolId, quantity);
  return rowsFromResult(purchase)[0] || null;
}

export async function createListing(params: {
  listingId: string;
  sellerUserId: string;
  toolId: string;
  quantity: number;
  priceNative: string | number;
  tokenSymbol?: string;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  await ensureGen1EconomyTables();
  const result = await db.execute(sql`
    INSERT INTO "listings" (
      "listing_id", "seller_user_id", "tool_id", "quantity", "price_native", "token_symbol", "expires_at", "metadata"
    ) VALUES (
      ${params.listingId}, ${params.sellerUserId}, ${params.toolId}, ${Math.max(1, Math.round(params.quantity || 1))},
      ${String(params.priceNative)}, ${params.tokenSymbol || "BNB"}, ${params.expiresAt || null}, ${JSON.stringify(params.metadata || {})}::jsonb
    )
    RETURNING *;
  `);
  return rowsFromResult(result)[0] || null;
}

export async function recordSale(params: {
  saleId: string;
  listingId: string;
  buyerUserId: string;
  quantity: number;
  totalPriceNative: string | number;
  saleTxHash?: string | null;
}) {
  await ensureGen1EconomyTables();
  const result = await db.execute(sql`
    INSERT INTO "sales" ("sale_id", "listing_id", "buyer_user_id", "quantity", "total_price_native", "sale_tx_hash")
    VALUES (${params.saleId}, ${params.listingId}, ${params.buyerUserId}, ${Math.max(1, Math.round(params.quantity || 1))}, ${String(params.totalPriceNative)}, ${params.saleTxHash || null})
    RETURNING *;
  `);
  return rowsFromResult(result)[0] || null;
}

export async function purchaseListing(params: { listingId: string; buyerUserId: string; paymentTxHash?: string | null }) {
  await ensureGen1EconomyTables();
  return db.transaction(async (tx) => {
    // Lock the listing row to prevent concurrent purchases
    const listingRes = await tx.execute(sql`SELECT * FROM "listings" WHERE "listing_id" = ${params.listingId} LIMIT 1 FOR UPDATE;`);
    let listing = rowsFromResult(listingRes)[0] || null;
    if (!listing) {
      const error = new Error('Listing not found');
      (error as any).statusCode = 404;
      throw error;
    }
    if (String(listing.status) === 'reserved') {
      await cleanupExpiredListingReservationForListing(tx, params.listingId);
      const refreshedRes = await tx.execute(sql`SELECT * FROM "listings" WHERE "listing_id" = ${params.listingId} LIMIT 1 FOR UPDATE;`);
      listing = rowsFromResult(refreshedRes)[0] || null;
    }
    if (!listing || String(listing.status) !== 'open') {
      const error = new Error('Listing is no longer available');
      (error as any).statusCode = 400;
      throw error;
    }

    const qty = Math.max(1, Math.round(Number(listing.quantity || 1)));

    // Ensure seller has inventory (lock row)
    const invRes = await tx.execute(sql`SELECT * FROM "tool_inventories" WHERE "owner_user_id" = ${listing.seller_user_id} AND "tool_id" = ${listing.tool_id} LIMIT 1 FOR UPDATE;`);
    const inv = rowsFromResult(invRes)[0] || null;
    const sellerQty = inv ? Number(inv.quantity || 0) : 0;
    if (sellerQty < qty) {
      const error = new Error(`Seller has insufficient inventory. Have ${sellerQty}, need ${qty}`);
      (error as any).statusCode = 400;
      throw error;
    }

    // Mark listing as sold (atomic conditional update)
    const updatedListingRes = await tx.execute(sql`UPDATE "listings" SET "status" = 'sold' WHERE "listing_id" = ${params.listingId} AND "status" = 'open' RETURNING *;`);
    const updatedListing = rowsFromResult(updatedListingRes)[0] || null;
    if (!updatedListing) {
      const error = new Error('Listing could not be reserved (concurrent)');
      (error as any).statusCode = 409;
      throw error;
    }

    const saleId = `sale_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const saleRes = await tx.execute(sql`
      INSERT INTO "sales" ("sale_id", "listing_id", "buyer_user_id", "quantity", "total_price_native", "sale_tx_hash")
      VALUES (${saleId}, ${params.listingId}, ${params.buyerUserId}, ${qty}, ${String(listing.price_native)}, ${params.paymentTxHash || null})
      RETURNING *;
    `);

    // Decrement seller inventory and increment buyer inventory
    await tx.execute(sql`UPDATE "tool_inventories" SET "quantity" = GREATEST(0, "quantity" - ${qty}), "updated_at" = now() WHERE "owner_user_id" = ${listing.seller_user_id} AND "tool_id" = ${listing.tool_id};`);

    await tx.execute(sql`INSERT INTO "tool_inventories" ("owner_user_id", "tool_id", "quantity", "updated_at") VALUES (${params.buyerUserId}, ${listing.tool_id}, 0, now()) ON CONFLICT ("owner_user_id", "tool_id") DO NOTHING;`);
    await tx.execute(sql`UPDATE "tool_inventories" SET "quantity" = COALESCE("quantity", 0) + ${qty}, "updated_at" = now() WHERE "owner_user_id" = ${params.buyerUserId} AND "tool_id" = ${listing.tool_id};`);
    // Remove any reservation for this listing if present
    await tx.execute(sql`DELETE FROM "listing_reservations" WHERE "listing_id" = ${params.listingId};`);

    return rowsFromResult(saleRes)[0] || null;
  });
}

export async function ensureListingReservationsTable() {
  if (!ensureListingReservationsTablePromise) {
    ensureListingReservationsTablePromise = (async () => {
      try {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS "listing_reservations" (
            "listing_id" varchar(180) PRIMARY KEY NOT NULL REFERENCES "listings" ("listing_id") ON DELETE CASCADE,
            "reserver_user_id" varchar(180) NOT NULL,
            "reserved_at" timestamp NOT NULL DEFAULT now(),
            "reserved_until" timestamp
          );
        `);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_listing_reservations_reserver" ON "listing_reservations" ("reserver_user_id");`);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_listing_reservations_reserved_until" ON "listing_reservations" ("reserved_until");`);
      } catch (err) {
        console.warn('Skipped DDL in ensureListingReservationsTable:', err instanceof Error ? err.message : String(err));
      }
    })();
  }
  return ensureListingReservationsTablePromise;
}

async function cleanupExpiredListingReservationForListing(tx: any, listingId: string) {
  await ensureListingReservationsTable();
  const reservationRes = await tx.execute(sql`
    SELECT * FROM "listing_reservations"
    WHERE "listing_id" = ${listingId}
    LIMIT 1
    FOR UPDATE;
  `);
  const reservation = rowsFromResult(reservationRes)[0] || null;
  if (!reservation) return false;
  const reservedUntil = reservation.reserved_until ? new Date(reservation.reserved_until) : null;
  if (reservedUntil && reservedUntil.getTime() <= Date.now()) {
    await tx.execute(sql`DELETE FROM "listing_reservations" WHERE "listing_id" = ${listingId};`);
    await tx.execute(sql`UPDATE "listings" SET "status" = 'open' WHERE "listing_id" = ${listingId} AND "status" = 'reserved';`);
    return true;
  }
  return false;
}

export async function reserveListing(params: { listingId: string; reserverUserId: string; ttlSeconds?: number }) {
  await ensureGen1EconomyTables();
  await ensureListingReservationsTable();
  const ttl = Number(params.ttlSeconds || 300);
  return db.transaction(async (tx) => {
    const listingRes = await tx.execute(sql`SELECT * FROM "listings" WHERE "listing_id" = ${params.listingId} LIMIT 1 FOR UPDATE;`);
    let listing = rowsFromResult(listingRes)[0] || null;
    if (!listing) {
      const error = new Error('Listing not found');
      (error as any).statusCode = 404;
      throw error;
    }
    if (String(listing.status) === 'reserved') {
      await cleanupExpiredListingReservationForListing(tx, params.listingId);
      const refreshedRes = await tx.execute(sql`SELECT * FROM "listings" WHERE "listing_id" = ${params.listingId} LIMIT 1 FOR UPDATE;`);
      listing = rowsFromResult(refreshedRes)[0] || null;
    }
    if (!listing || String(listing.status) !== 'open') {
      const error = new Error('Listing is not open for reservation');
      (error as any).statusCode = 400;
      throw error;
    }

    const reservedUntil = new Date(Date.now() + Math.max(1, ttl) * 1000);

    await tx.execute(sql`
      INSERT INTO "listing_reservations" ("listing_id", "reserver_user_id", "reserved_at", "reserved_until")
      VALUES (${params.listingId}, ${params.reserverUserId}, now(), ${reservedUntil})
      ON CONFLICT ("listing_id") DO UPDATE SET "reserver_user_id" = EXCLUDED."reserver_user_id", "reserved_at" = EXCLUDED."reserved_at", "reserved_until" = EXCLUDED."reserved_until";
    `);

    await tx.execute(sql`UPDATE "listings" SET "status" = 'reserved' WHERE "listing_id" = ${params.listingId};`);

    const res = await tx.execute(sql`SELECT * FROM "listing_reservations" WHERE "listing_id" = ${params.listingId} LIMIT 1;`);
    return rowsFromResult(res)[0] || null;
  });
}

export async function cancelReservation(params: { listingId: string; requesterUserId: string; force?: boolean }) {
  await ensureGen1EconomyTables();
  await ensureListingReservationsTable();
  return db.transaction(async (tx) => {
    const resRow = await tx.execute(sql`SELECT * FROM "listing_reservations" WHERE "listing_id" = ${params.listingId} LIMIT 1 FOR UPDATE;`);
    const reservation = rowsFromResult(resRow)[0] || null;
    if (!reservation) return null;
    if (!params.force && String(reservation.reserver_user_id) !== String(params.requesterUserId)) {
      const error = new Error('Only reserver or admin can cancel reservation');
      (error as any).statusCode = 403;
      throw error;
    }

    await tx.execute(sql`DELETE FROM "listing_reservations" WHERE "listing_id" = ${params.listingId};`);
    await tx.execute(sql`UPDATE "listings" SET "status" = 'open' WHERE "listing_id" = ${params.listingId} AND "status" = 'reserved';`);
    return reservation;
  });
}

export async function cleanupExpiredListingReservations() {
  await ensureGen1EconomyTables();
  await ensureListingReservationsTable();
  const result = await db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      WITH expired AS (
        DELETE FROM "listing_reservations"
        WHERE "reserved_until" IS NOT NULL AND "reserved_until" <= now()
        RETURNING "listing_id"
      )
      UPDATE "listings"
      SET "status" = 'open'
      WHERE "listing_id" IN (SELECT "listing_id" FROM expired) AND "status" = 'reserved'
      RETURNING "listing_id";
    `);
    const rows = rowsFromResult(res);
    return {
      expiredReservations: rows.length,
      reopenedListings: rows.map((row) => String(row.listing_id || "")),
    };
  });
  return result;
}

export async function getListing(listingId: string) {
  await ensureGen1EconomyTables();
  const result = await db.execute(sql`SELECT * FROM "listings" WHERE "listing_id" = ${listingId} LIMIT 1;`);
  return rowsFromResult(result)[0] || null;
}

export async function getTools() {
  await seedGen1SeasonOneTools();
  const result = await db.execute(sql`
    SELECT * FROM "tools"
    ORDER BY CASE "rarity" WHEN 'epic' THEN 1 WHEN 'rare' THEN 2 WHEN 'common' THEN 3 ELSE 4 END, "name" ASC;
  `);
  return rowsFromResult(result);
}

export async function getListings(status?: string) {
  await ensureGen1EconomyTables();
  if (status) {
    const result = await db.execute(sql`SELECT * FROM "listings" WHERE "status" = ${status} ORDER BY "created_at" DESC;`);
    return rowsFromResult(result);
  }
  const result = await db.execute(sql`SELECT * FROM "listings" ORDER BY "created_at" DESC;`);
  return rowsFromResult(result);
}

export async function getInventory(ownerUserId: string, toolId?: string | null) {
  await ensureGen1EconomyTables();
  if (toolId) {
    const result = await db.execute(sql`
      SELECT * FROM "tool_inventories"
      WHERE "owner_user_id" = ${ownerUserId} AND "tool_id" = ${toolId}
      LIMIT 1;
    `);
    return rowsFromResult(result)[0] || null;
  }
  const result = await db.execute(sql`SELECT * FROM "tool_inventories" WHERE "owner_user_id" = ${ownerUserId};`);
  return rowsFromResult(result);
}

export async function updateListingStatus(listingId: string, status: string) {
  await ensureGen1EconomyTables();
  const result = await db.execute(sql`UPDATE "listings" SET "status" = ${status} WHERE "listing_id" = ${listingId} RETURNING *;`);
  return rowsFromResult(result)[0] || null;
}

export async function getListingsByOwner(ownerUserId: string, status?: string) {
  await ensureGen1EconomyTables();
  if (status) {
    const result = await db.execute(sql`SELECT * FROM "listings" WHERE "seller_user_id" = ${ownerUserId} AND "status" = ${status};`);
    return rowsFromResult(result);
  }
  const result = await db.execute(sql`SELECT * FROM "listings" WHERE "seller_user_id" = ${ownerUserId};`);
  return rowsFromResult(result);
}

export async function installToolOnFighter(params: {
  loadoutId: string;
  ownerUserId: string;
  agentId: string;
  toolId: string;
  sourcePurchaseId?: string | null;
  sourceTxHash?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  await seedGen1SeasonOneTools();
  const inventory = await getInventory(params.ownerUserId, params.toolId);
  const currentQuantity = inventory ? Number(inventory.quantity || 0) : 0;
  if (currentQuantity < 1) {
    const error = new Error("You do not own this tool in available inventory.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  await db.execute(sql`
    UPDATE "fighter_tool_loadouts"
    SET "equipped" = false, "status" = CASE WHEN "status" = 'equipped' THEN 'installed' ELSE "status" END, "updated_at" = now()
    WHERE "agent_id" = ${params.agentId} AND "owner_user_id" = ${params.ownerUserId} AND "status" IN ('installed', 'equipped');
  `);

  const result = await db.execute(sql`
    INSERT INTO "fighter_tool_loadouts" (
      "loadout_id", "agent_id", "owner_user_id", "tool_id", "status", "equipped",
      "source_purchase_id", "source_tx_hash", "metadata", "updated_at"
    ) VALUES (
      ${params.loadoutId}, ${params.agentId}, ${params.ownerUserId}, ${params.toolId}, 'equipped', true,
      ${params.sourcePurchaseId || null}, ${params.sourceTxHash || null}, ${JSON.stringify(params.metadata || {})}::jsonb, now()
    )
    RETURNING *;
  `);
  await adjustInventory(params.ownerUserId, params.toolId, -1);
  return rowsFromResult(result)[0] || null;
}

export async function getFighterToolLoadouts(agentId: string) {
  await seedGen1SeasonOneTools();
  const result = await db.execute(sql`
    SELECT
      loadout.*,
      tool."name" AS "tool_name",
      tool."rarity" AS "tool_rarity",
      tool."description" AS "tool_description",
      tool."metadata" AS "tool_metadata",
      tool."supply_total" AS "tool_supply_total"
    FROM "fighter_tool_loadouts" loadout
    JOIN "tools" tool ON tool."tool_id" = loadout."tool_id"
    WHERE loadout."agent_id" = ${agentId} AND loadout."status" IN ('installed', 'equipped')
    ORDER BY loadout."equipped" DESC, loadout."installed_at" DESC;
  `);
  return rowsFromResult(result);
}

export async function getFighterToolLoadoutMap(agentIds: string[]) {
  const uniqueAgentIds = Array.from(new Set(agentIds.map((agentId) => String(agentId || "").trim()).filter(Boolean)));
  if (!uniqueAgentIds.length) return new Map<string, any[]>();
  await seedGen1SeasonOneTools();
  const result = await db.execute(sql`
    SELECT
      loadout.*,
      tool."name" AS "tool_name",
      tool."rarity" AS "tool_rarity",
      tool."description" AS "tool_description",
      tool."metadata" AS "tool_metadata",
      tool."supply_total" AS "tool_supply_total"
    FROM "fighter_tool_loadouts" loadout
    JOIN "tools" tool ON tool."tool_id" = loadout."tool_id"
    WHERE loadout."agent_id" IN (${sql.raw(uniqueAgentIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', '))}) AND loadout."status" IN ('installed', 'equipped')
    ORDER BY loadout."equipped" DESC, loadout."installed_at" DESC;
  `);
  const map = new Map<string, any[]>();
  for (const row of rowsFromResult(result)) {
    const agentId = String(row.agent_id || "");
    const list = map.get(agentId) || [];
    list.push(row);
    map.set(agentId, list);
  }
  return map;
}

export function buildFighterGen1EconomySummary(params: {
  agentId: string;
  wins?: number | null;
  losses?: number | null;
  loadouts?: any[];
  activeListing?: any | null;
}) {
  const loadouts = Array.isArray(params.loadouts) ? params.loadouts : [];
  const installedTools = loadouts.map((row) => {
    const toolMetadata = objectValue(row.tool_metadata);
    return {
      loadoutId: row.loadout_id,
      toolId: row.tool_id,
      name: row.tool_name,
      rarity: String(row.tool_rarity || "common").toLowerCase(),
      description: row.tool_description || null,
      equipped: Boolean(row.equipped),
      tierLabel: String(toolMetadata.tierLabel || ""),
      tacticalEffect: String(toolMetadata.tacticalEffect || ""),
      passive: toolMetadata.passive || null,
      installedAt: row.installed_at || null,
    };
  });
  const equippedTool = installedTools.find((tool) => tool.equipped) || installedTools[0] || null;
  const highestRarityRank = installedTools.reduce((highest, tool) => Math.max(highest, rarityRank(tool.rarity)), 0);
  const highestRarity = highestRarityRank === 3 ? "epic" : highestRarityRank === 2 ? "rare" : highestRarityRank === 1 ? "common" : "none";
  const battles = Math.max(0, Math.round(Number(params.wins || 0) + Number(params.losses || 0)));
  const hasTool = installedTools.length > 0;
  const commonReady = highestRarity === "common" && battles >= 10;
  const rareOrEpicReady = highestRarity === "rare" || highestRarity === "epic";
  const canList = hasTool && (commonReady || rareOrEpicReady);
  const reason = canList
    ? "eligible"
    : !hasTool
      ? "install_tool_first"
      : highestRarity === "common"
        ? "common_tool_needs_10_fights"
        : "not_eligible";

  return {
    seasonId: GEN1_SEASON_ID,
    seasonName: GEN1_SEASON_NAME,
    installedTools,
    equippedTool,
    highestRarity,
    battles,
    resaleEligibility: {
      canList,
      reason,
      requiredBattles: highestRarity === "common" ? 10 : 0,
      currentBattles: battles,
      ownerSetsPrice: true,
      sellerKeepsBantCreditBalance: true,
      transfersWithFighter: ["installed tools", "equipped tool", "battle history", "rank", "reputation"],
    },
    listing: params.activeListing || null,
  };
}

export async function getFighterGen1EconomySummary(params: {
  agentId: string;
  wins?: number | null;
  losses?: number | null;
}) {
  const [loadouts, listing] = await Promise.all([
    getFighterToolLoadouts(params.agentId),
    getActiveFighterListing(params.agentId),
  ]);
  return buildFighterGen1EconomySummary({ ...params, loadouts, activeListing: listing });
}

export async function getActiveFighterListing(agentId: string) {
  await ensureGen1EconomyTables();
  const result = await db.execute(sql`
    SELECT * FROM "fighter_listings"
    WHERE "agent_id" = ${agentId} AND "status" = 'open'
    ORDER BY "created_at" DESC
    LIMIT 1;
  `);
  return rowsFromResult(result)[0] || null;
}

export async function getFighterListings(status = "open") {
  await ensureGen1EconomyTables();
  const result = status
    ? await db.execute(sql`SELECT * FROM "fighter_listings" WHERE "status" = ${status} ORDER BY "created_at" DESC;`)
    : await db.execute(sql`SELECT * FROM "fighter_listings" ORDER BY "created_at" DESC;`);
  return rowsFromResult(result);
}

export async function createFighterListing(params: {
  listingId: string;
  sellerUserId: string;
  agentId: string;
  priceNative: string | number;
  tokenSymbol?: string;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  await ensureGen1EconomyTables();
  const result = await db.execute(sql`
    INSERT INTO "fighter_listings" (
      "listing_id", "seller_user_id", "agent_id", "price_native", "token_symbol", "expires_at", "metadata"
    ) VALUES (
      ${params.listingId}, ${params.sellerUserId}, ${params.agentId}, ${String(params.priceNative)},
      ${params.tokenSymbol || "USDC"}, ${params.expiresAt || null}, ${JSON.stringify(params.metadata || {})}::jsonb
    )
    RETURNING *;
  `);
  return rowsFromResult(result)[0] || null;
}

export async function updateFighterListingStatus(listingId: string, status: string) {
  await ensureGen1EconomyTables();
  const result = await db.execute(sql`UPDATE "fighter_listings" SET "status" = ${status} WHERE "listing_id" = ${listingId} RETURNING *;`);
  return rowsFromResult(result)[0] || null;
}

export async function attachGen1EconomyToProfiles<T extends { agentId: string; wins?: number | null; losses?: number | null; metadata?: Record<string, unknown> }>(
  profiles: T[],
) {
  if (!profiles.length) return profiles;
  try {
    const agentIds = profiles.map((profile) => profile.agentId);
    const [loadoutMap, fighterListings] = await Promise.all([
      getFighterToolLoadoutMap(agentIds),
      getFighterListings("open"),
    ]);
    const listingMap = new Map<string, any>();
    for (const listing of fighterListings) {
      const agentId = String(listing.agent_id || "");
      if (agentId && !listingMap.has(agentId)) listingMap.set(agentId, listing);
    }
    return profiles.map((profile) => {
      const gen1 = buildFighterGen1EconomySummary({
        agentId: profile.agentId,
        wins: profile.wins,
        losses: profile.losses,
        loadouts: loadoutMap.get(profile.agentId) || [],
        activeListing: listingMap.get(profile.agentId) || null,
      });
      return {
        ...profile,
        metadata: {
          ...(profile.metadata || {}),
          gen1,
          marketplaceListing: gen1.listing
            ? {
                status: "listed",
                price: Number(gen1.listing.price_native || 0),
                currency: gen1.listing.token_symbol || "USDC",
                seller: gen1.listing.seller_user_id,
                listingId: gen1.listing.listing_id,
              }
            : (profile.metadata || {}).marketplaceListing,
        },
      };
    });
  } catch (error) {
    console.warn("[BOTA Gen1] Could not attach fighter economy metadata:", error);
    return profiles;
  }
}

export default {
  ensureGen1EconomyTables,
  seedGen1SeasonOneTools,
  getTool,
  upsertTool,
  adjustInventory,
  purchaseToolWithBantCredit,
  purchaseToolWithNativeToken,
  createListing,
  getListing,
  recordSale,
  getTools,
  getListings,
  getInventory,
  updateListingStatus,
  getListingsByOwner,
  installToolOnFighter,
  getFighterToolLoadouts,
  getFighterToolLoadoutMap,
  getFighterGen1EconomySummary,
  getFighterListings,
  getActiveFighterListing,
  createFighterListing,
  updateFighterListingStatus,
  attachGen1EconomyToProfiles,
  purchaseListing,
  ensureListingReservationsTable,
  reserveListing,
  cancelReservation,
  cleanupExpiredListingReservations,
};
