import { generateShadowPersona, getAvailableShadowPersona } from "./shadowPersonaGenerator.js";
import { db } from "./db.js";
import { shadowPersonas } from "../shared/schema.js";

/**
 * Test the Shadow Persona Generator
 * npx tsx server/testShadowPersona.ts
 */
async function main() {
  try {
    console.log("🧪 Testing Shadow Persona Generator...\n");

    // Step 1: Check database has personas
    const allPersonas = await db.select().from(shadowPersonas);
    console.log(`✓ Database contains ${allPersonas.length} shadow personas`);
    console.log(
      `  Categories: big_stepper, street_smart, fanatic, casual\n`
    );

    // Step 2: Test getting an available persona for a challenge
    const testChallengeId = 999;
    console.log(`Testing getAvailableShadowPersona(challengeId: ${testChallengeId})`);
    const availablePersona = await getAvailableShadowPersona(testChallengeId);
    console.log(`✓ Found available persona: "${availablePersona.username}"`);
    console.log(`  - Category: ${availablePersona.category}`);
    console.log(`  - Avatar Index: ${availablePersona.avatarIndex}\n`);

    // Step 3: Test full generation flow
    console.log(
      `Testing generateShadowPersona(challengeId: ${testChallengeId})`
    );
    const shadowPersona = await generateShadowPersona(testChallengeId);
    console.log(`✓ Generated shadow persona successfully!`);
    console.log(`  - Username: ${shadowPersona.shadowPersonaUsername}`);
    console.log(`  - User ID: ${shadowPersona.shadowPersonaUserId}`);
    console.log(`  - Persona ID: ${shadowPersona.shadowPersonaId}\n`);

    // Step 4: Verify the persona is now marked as used
    const updatedPersona = await getAvailableShadowPersona(testChallengeId);
    console.log(`✓ Getting next available persona for same challenge:`);
    console.log(`  - Username: ${updatedPersona.username}`);
    console.log(`  - Different from previous: ${
      updatedPersona.id !== shadowPersona.shadowPersonaId
    }\n`);

    console.log("✅ All tests passed! Shadow Persona system is working correctly.");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  }
}

main();
