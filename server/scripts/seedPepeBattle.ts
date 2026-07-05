import { db } from "../db";
import { sql } from "drizzle-orm";
import { ensureBotaFighterProfilesTable } from "../bantahBro/botaFighterProfileService";
import { ensureBotaAgentChallengesTable } from "../bantahBro/botaAgentChallengeService";

async function run() {
  console.log("Ensuring tables exist...");
  await ensureBotaFighterProfilesTable();
  await ensureBotaAgentChallengesTable();

  console.log("Seeding Pepe profile...");
  await db.execute(sql`
    INSERT INTO "bota_fighter_profiles" (
      "agent_id", "display_name", "origin", "avatar_url", "token_symbol", "agent_class"
    ) VALUES (
      'bota:pepe', 'CVBHEPE', 'bota', '/2dgame/icons/icon-5.jpg', 'PEPE', 'striker'
    ) ON CONFLICT ("agent_id") DO NOTHING;
  `);

  console.log("Seeding Bantah profile...");
  await db.execute(sql`
    INSERT INTO "bota_fighter_profiles" (
      "agent_id", "display_name", "origin", "avatar_url", "token_symbol", "agent_class"
    ) VALUES (
      'bota:bantah', 'BANTAH BOT', 'bota', '/2dgame/icons/bantah-bot-full.png', 'BANTAH', 'defender'
    ) ON CONFLICT ("agent_id") DO NOTHING;
  `);

  console.log("Seeding fake pvp challenge...");
  const code = "PEPE_VS_BANTAH_" + Math.floor(Math.random() * 10000);
  await db.execute(sql`
    INSERT INTO "bota_agent_pvp_challenges" (
      "challenge_code", "status", "challenger_user_id", "challenger_agent_id", "opponent_agent_id", "expires_at", "challenger_agent", "opponent_agent"
    ) VALUES (
      ${code},
      'pending',
      'system_generated_challenge',
      'bota:pepe',
      'bota:bantah',
      NOW() + INTERVAL '2 days',
      '{"id": "bota:pepe", "name": "CVBHEPE", "avatarUrl": "/2dgame/icons/icon-5.jpg", "ticker": "PEPE"}'::jsonb,
      '{"id": "bota:bantah", "name": "BANTAH BOT", "avatarUrl": "/2dgame/icons/bantah-bot-full.png", "ticker": "BANTAH"}'::jsonb
    ) ON CONFLICT ("challenge_code") DO NOTHING;
  `);

  console.log("Done!");
}

run().catch(console.error).finally(() => process.exit(0));
