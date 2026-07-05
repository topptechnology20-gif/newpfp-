import { db } from "../db";
import { botaToolsCatalog } from "@shared/schema";

const toolsData = [
  // COMMON - Primary (3)
  { id: "c-p-1", name: "Rusty Blaster", tier: "common", role: "primary", powerRating: 15, triggerCondition: "always", effectDesc: "Basic damage, no special effect.", intGateRequirement: 0, soulDrainEnabled: false },
  { id: "c-p-2", name: "Iron Sword", tier: "common", role: "primary", powerRating: 18, triggerCondition: "always", effectDesc: "Slightly higher damage melee.", intGateRequirement: 10, soulDrainEnabled: false },
  { id: "c-p-3", name: "Plasma Pistol", tier: "common", role: "primary", powerRating: 12, triggerCondition: "always", effectDesc: "Fast firing basic attack.", intGateRequirement: 0, soulDrainEnabled: false },
  
  // COMMON - Secondary (3)
  { id: "c-s-1", name: "Basic Shield", tier: "common", role: "secondary", powerRating: 10, triggerCondition: "hp_below_50", effectDesc: "Reduces damage by 10%.", intGateRequirement: 0, soulDrainEnabled: false },
  { id: "c-s-2", name: "Energy Drink", tier: "common", role: "secondary", powerRating: 8, triggerCondition: "energy_below_20", effectDesc: "Restores 15 energy.", intGateRequirement: 15, soulDrainEnabled: false },
  { id: "c-s-3", name: "Smoke Grenade", tier: "common", role: "secondary", powerRating: 12, triggerCondition: "enemy_attack", effectDesc: "Increases dodge chance slightly.", intGateRequirement: 20, soulDrainEnabled: false },
  
  // COMMON - Passive (3)
  { id: "c-pa-1", name: "Thick Skin", tier: "common", role: "passive", powerRating: 5, triggerCondition: "passive", effectDesc: "+5 Max HP.", intGateRequirement: 0, soulDrainEnabled: false },
  { id: "c-pa-2", name: "Lightweight Boots", tier: "common", role: "passive", powerRating: 5, triggerCondition: "passive", effectDesc: "+2 Speed.", intGateRequirement: 0, soulDrainEnabled: false },
  { id: "c-pa-3", name: "Lucky Charm", tier: "common", role: "passive", powerRating: 5, triggerCondition: "passive", effectDesc: "+1% Crit Chance.", intGateRequirement: 10, soulDrainEnabled: false },

  // RARE - Primary (3)
  { id: "r-p-1", name: "Laser Rifle", tier: "rare", role: "primary", powerRating: 35, triggerCondition: "always", effectDesc: "High accuracy and moderate damage.", intGateRequirement: 30, soulDrainEnabled: false },
  { id: "r-p-2", name: "Vibro-Blade", tier: "rare", role: "primary", powerRating: 40, triggerCondition: "always", effectDesc: "High damage, pierces minor armor.", intGateRequirement: 25, soulDrainEnabled: false },
  { id: "r-p-3", name: "Sonic Cannon", tier: "rare", role: "primary", powerRating: 30, triggerCondition: "always", effectDesc: "AOE potential, disorients target.", intGateRequirement: 40, soulDrainEnabled: false },

  // RARE - Secondary (3)
  { id: "r-s-1", name: "Deflector Shield", tier: "rare", role: "secondary", powerRating: 25, triggerCondition: "hp_below_40", effectDesc: "Blocks 30% of incoming damage.", intGateRequirement: 35, soulDrainEnabled: false },
  { id: "r-s-2", name: "Stim Pack", tier: "rare", role: "secondary", powerRating: 20, triggerCondition: "energy_below_30", effectDesc: "Restores 30 HP and 20 energy.", intGateRequirement: 30, soulDrainEnabled: false },
  { id: "r-s-3", name: "EMP Grenade", tier: "rare", role: "secondary", powerRating: 28, triggerCondition: "enemy_special", effectDesc: "Interrupts enemy actions.", intGateRequirement: 45, soulDrainEnabled: false },

  // RARE - Passive (3)
  { id: "r-pa-1", name: "Titanium Plating", tier: "rare", role: "passive", powerRating: 15, triggerCondition: "passive", effectDesc: "+15 Max HP, +5 Defense.", intGateRequirement: 20, soulDrainEnabled: false },
  { id: "r-pa-2", name: "Neural Implant", tier: "rare", role: "passive", powerRating: 15, triggerCondition: "passive", effectDesc: "+10 Intelligence, +5% Accuracy.", intGateRequirement: 50, soulDrainEnabled: false },
  { id: "r-pa-3", name: "Adrenaline Gland", tier: "rare", role: "passive", powerRating: 15, triggerCondition: "passive", effectDesc: "Boosts speed as HP decreases.", intGateRequirement: 25, soulDrainEnabled: false },

  // EPIC - Primary (3)
  { id: "e-p-1", name: "Soul Reaper Scythe", tier: "epic", role: "primary", powerRating: 85, triggerCondition: "always", effectDesc: "Massive damage, drains soul on win.", intGateRequirement: 70, soulDrainEnabled: true },
  { id: "e-p-2", name: "Plasma Annihilator", tier: "epic", role: "primary", powerRating: 80, triggerCondition: "always", effectDesc: "Devastating energy attack, melts armor.", intGateRequirement: 75, soulDrainEnabled: true },
  { id: "e-p-3", name: "Void Caster", tier: "epic", role: "primary", powerRating: 75, triggerCondition: "always", effectDesc: "Bypasses all shields, direct HP damage.", intGateRequirement: 85, soulDrainEnabled: true },

  // EPIC - Secondary (3)
  { id: "e-s-1", name: "Aegis Core", tier: "epic", role: "secondary", powerRating: 60, triggerCondition: "fatal_hit", effectDesc: "Prevents death once per battle, restores 20% HP.", intGateRequirement: 65, soulDrainEnabled: true },
  { id: "e-s-2", name: "Time Warp Drive", tier: "epic", role: "secondary", powerRating: 65, triggerCondition: "enemy_crit", effectDesc: "Evades attack completely and guarantees next hit.", intGateRequirement: 80, soulDrainEnabled: true },
  { id: "e-s-3", name: "Vampiric Aura", tier: "epic", role: "secondary", powerRating: 55, triggerCondition: "attack_landed", effectDesc: "Heals for 50% of damage dealt.", intGateRequirement: 60, soulDrainEnabled: true },

  // EPIC - Passive (3)
  { id: "e-pa-1", name: "Heart of the Swarm", tier: "epic", role: "passive", powerRating: 45, triggerCondition: "passive", effectDesc: "Constant HP regeneration (+5/round).", intGateRequirement: 50, soulDrainEnabled: true },
  { id: "e-pa-2", name: "Quantum Processor", tier: "epic", role: "passive", powerRating: 50, triggerCondition: "passive", effectDesc: "+30 Intelligence, +15% Crit Chance.", intGateRequirement: 90, soulDrainEnabled: true },
  { id: "e-pa-3", name: "Soul Catcher Gem", tier: "epic", role: "passive", powerRating: 40, triggerCondition: "passive", effectDesc: "Increases all Soul Drain effects by 50%.", intGateRequirement: 75, soulDrainEnabled: true }
];

export async function seedToolsCatalog() {
  console.log("Seeding BOTA V2 Tools Catalog...");
  try {
    // Clear existing to avoid duplicates on re-run
    await db.delete(botaToolsCatalog);
    const formattedData = toolsData.map(t => ({
      id: t.id,
      name: t.name,
      tier: t.tier,
      role: t.role,
      compatibleTrait: "intelligence",
      triggerConditionDesc: t.triggerCondition,
      triggerConditionJson: {},
      effectDesc: t.effectDesc,
      effectJson: {},
      powerRating: t.powerRating,
      soulDrainEnabled: t.soulDrainEnabled
    }));
    await db.insert(botaToolsCatalog).values(formattedData);
    console.log(`Successfully seeded ${toolsData.length} tools!`);
  } catch (error) {
    console.error("Error seeding tools:", error);
  }
}

// Allow running directly
const isMain = import.meta.url ? import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!) : require.main === module;
if (isMain || process.argv[1]?.includes('botaToolsSeeder')) {
  seedToolsCatalog().then(() => process.exit(0)).catch(() => process.exit(1));
}
