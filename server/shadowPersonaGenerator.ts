import { db } from "./db";
import { shadowPersonas, users, treasuryMatches } from "../shared/schema";
import { eq, inArray, notInArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { scrypt, randomBytes } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

/**
 * Nigerian Persona Names Library - Organized by Category
 * Each name should be unique and culturally relevant
 */
export const NIGERIAN_PERSONA_LIBRARY = {
  big_stepper: [
    "Odogwu_Bets",
    "ChopLife_King",
    "Big_Baller_9ja",
    "CashOut_General",
    "Money_Palava",
    "Naira_Thunder",
    "Big_Energy_Bets",
    "Wicked_Payout",
    "Flex_Master_99",
    "Guap_Getter",
    "Lagos_Baller",
    "Moneybag_Kingpin",
    "Chips_Lord",
  ],

  street_smart: [
    "No_Shaking_77",
    "Wafi_Boy_Prediction",
    "Gbedu_Master",
    "Sharp_Guy_Bets",
    "Japa_Expert",
    "Street_Vibes_King",
    "Smart_Money_Move",
    "Naija_Hustler",
    "Game_Tight",
    "Lagos_Connect",
    "Gutter_Sage",
    "Sly_Fox_Bets",
  ],

  fanatic: [
    "StarBoy_Stan_99",
    "Goal_Getter_Vibe",
    "Naija_SuperFan",
    "Grammy_Predictor",
    "Pitch_Lord",
    "Music_Prophet",
    "Sports_Oracle",
    "Crypto_Enthusiast",
    "Prediction_King",
    "Gaming_Legend",
    "Entertainment_Guru",
    "Fan_Absolute",
  ],

  casual: [
    "Tunde_Predictions",
    "Amaka_Challenger",
    "Segun_Matches",
    "Ifeanyi_Stakes",
    "Kemi_Bants",
    "Chioma_Vibes",
    "Adebayo_Picks",
    "Zainab_Bets",
    "Okafor_Wins",
    "Blessing_Luck",
    "Victor_Chances",
    "Folake_Matches",
  ],
};

/**
 * Hash password using scrypt - same as user registration
 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

/**
 * Flatten the persona library into a single array with categories
 */
function getFlattenedPersonaList(): Array<{
  username: string;
  category: keyof typeof NIGERIAN_PERSONA_LIBRARY;
}> {
  const flattened: Array<{
    username: string;
    category: keyof typeof NIGERIAN_PERSONA_LIBRARY;
  }> = [];

  Object.entries(NIGERIAN_PERSONA_LIBRARY).forEach(([category, names]) => {
    names.forEach((username) => {
      flattened.push({
        username,
        category: category as keyof typeof NIGERIAN_PERSONA_LIBRARY,
      });
    });
  });

  return flattened;
}

/**
 * Seed the shadow_personas table with the entire Nigerian persona library
 * Run this once on platform initialization
 */
export async function seedShadowPersonas() {
  try {
    const flatList = getFlattenedPersonaList();

    // Check if personas already exist
    const existingCount = await db
      .select()
      .from(shadowPersonas)
      .limit(1);

    if (existingCount.length > 0) {
      console.log(
        "✓ Shadow personas already seeded. Skipping initialization."
      );
      return;
    }

    // Insert all personas
    const personasToInsert = flatList.map((item, index) => ({
      username: item.username,
      avatarIndex: index % 30, // Cycle through 30 avatar indices
      category: item.category,
      usedInChallengeIds: [] as any[],
      isActive: true,
    }));

    await db.insert(shadowPersonas).values(personasToInsert);

    console.log(
      `✓ Successfully seeded ${flatList.length} shadow personas to database`
    );
  } catch (error) {
    console.error("Error seeding shadow personas:", error);
    throw error;
  }
}

/**
 * Get an available Shadow Persona for a specific challenge
 * Returns a persona that hasn't been used in this challenge yet
 */
export async function getAvailableShadowPersona(challengeId: number) {
  try {
    // Find all personas
    const allPersonas = await db
      .select()
      .from(shadowPersonas)
      .where(eq(shadowPersonas.isActive, true));

    if (allPersonas.length === 0) {
      throw new Error(
        "No shadow personas available. Run seedShadowPersonas() first."
      );
    }

    // Filter to find one not used in this challenge
    const availablePersona = allPersonas.find((persona) => {
      const usedIds = (persona.usedInChallengeIds as any[]) || [];
      return !usedIds.includes(challengeId);
    });

    if (!availablePersona) {
      throw new Error(
        `All shadow personas have been used in challenge ${challengeId}. Consider expanding the persona library.`
      );
    }

    return availablePersona;
  } catch (error) {
    console.error("Error getting available shadow persona:", error);
    throw error;
  }
}

/**
 * Create a Shadow Persona user account and register it in the system
 * Returns the created user ID
 */
export async function createShadowPersonaUser(
  shadowPersonaId: number,
  username: string
): Promise<string> {
  try {
    const userId = `shadow_${shadowPersonaId}_${uuidv4()}`;

    // Create a dummy password (never used for login)
    const dummyPassword = await hashPassword(uuidv4());

    // Create the shadow persona user
    const shadowUser = {
      id: userId,
      username: username,
      email: `${username.toLowerCase()}@shadow.bantah.fun`, // Non-routable email
      password: dummyPassword,
      firstName: "Shadow",
      lastName: "Persona",
      isShadowPersona: true,
      isAdmin: false,
      balance: "0.00",
      adminWalletBalance: "0.00",
      adminTotalCommission: "0.00",
      adminTotalBonusesGiven: "0.00",
      status: "active",
      level: 1,
      xp: 0,
      points: 0,
      streak: 0,
    };

    await db.insert(users).values(shadowUser as any);

    return userId;
  } catch (error) {
    console.error("Error creating shadow persona user:", error);
    throw error;
  }
}

/**
 * Mark a Shadow Persona as used in a specific challenge
 * Call this after successfully creating a Treasury match
 */
export async function markPersonaUsedInChallenge(
  shadowPersonaId: number,
  challengeId: number
) {
  try {
    const persona = await db
      .select()
      .from(shadowPersonas)
      .where(eq(shadowPersonas.id, shadowPersonaId))
      .limit(1);

    if (persona.length === 0) {
      throw new Error(`Shadow persona ${shadowPersonaId} not found`);
    }

    const usedIds = ((persona[0].usedInChallengeIds as any) || []).concat(
      challengeId
    );

    await db
      .update(shadowPersonas)
      .set({ usedInChallengeIds: usedIds })
      .where(eq(shadowPersonas.id, shadowPersonaId));
  } catch (error) {
    console.error("Error marking persona as used:", error);
    throw error;
  }
}

/**
 * Complete flow: Generate and create a Shadow Persona for a Treasury match
 * This is the main function called by the Fulfillment Engine
 *
 * Returns: { shadowPersonaUserId, shadowPersonaUsername }
 */
export async function generateShadowPersona(challengeId: number): Promise<{
  shadowPersonaUserId: string;
  shadowPersonaUsername: string;
  shadowPersonaId: number;
}> {
  try {
    // Step 1: Get available persona
    const availablePersona = await getAvailableShadowPersona(challengeId);

    // Step 2: Create user account
    const shadowPersonaUserId = await createShadowPersonaUser(
      availablePersona.id,
      availablePersona.username
    );

    // Step 3: Mark as used
    await markPersonaUsedInChallenge(availablePersona.id, challengeId);

    return {
      shadowPersonaUserId,
      shadowPersonaUsername: availablePersona.username,
      shadowPersonaId: availablePersona.id,
    };
  } catch (error) {
    console.error("Error generating shadow persona:", error);
    throw error;
  }
}
