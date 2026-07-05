import { seedShadowPersonas } from "./shadowPersonaGenerator.js";

/**
 * Initialize Treasury Shadow Personas
 * Run this script once during platform setup
 * npx tsx server/seedShadowPersonas.ts
 */
async function main() {
  try {
    console.log("🌱 Starting Shadow Personas Initialization...\n");

    await seedShadowPersonas();

    console.log("\n✅ Shadow Personas initialization complete!");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Failed to initialize Shadow Personas:", error);
    process.exit(1);
  }
}

main();
