import { db } from "../db";
import { users } from "../../shared/schema";
import { eq, or } from "drizzle-orm";
import {
  createBotaAgentChallenge,
  acceptBotaAgentChallenge,
  declineBotaAgentChallenge,
} from "./botaAgentChallengeService";

// Helper to resolve twitter handle to a user ID
export async function getBantahUserByTwitterHandle(twitterHandle: string) {
  // Assuming users table has some twitter handle field, though standard is generic username
  // For now, we search by username case insensitive.
  // In a real app, you would add `twitterHandle` to users or a linked accounts table.
  const handleNoAt = twitterHandle.replace(/^@/, "").toLowerCase();
  
  const results = await db.select().from(users).where(
    // We try to match username.
    eq(users.username, handleNoAt)
  ).limit(1);
  
  return results[0] || null;
}

export type ParsedTwitterMention = {
  intent: "challenge" | "accept" | "decline" | "unknown";
  targetUserHandle?: string;
  amount?: number;
  challengeCode?: string; // for accept/decline if they pass it, or we rely on thread reply
};

export function parseTwitterMention(text: string): ParsedTwitterMention {
  const lowerText = text.toLowerCase();
  
  // Parse: @bantahfun challenge @rival 100bc
  const challengeMatch = text.match(/challenge\s+@([a-zA-Z0-9_]+)\s+(\d+)/i);
  if (challengeMatch) {
    return {
      intent: "challenge",
      targetUserHandle: challengeMatch[1],
      amount: parseInt(challengeMatch[2], 10)
    };
  }

  // Parse accept
  if (lowerText.includes("accept")) {
    const codeMatch = text.match(/BOTA-[A-Z0-9-]+-[A-Z0-9-]+/i);
    return {
      intent: "accept",
      challengeCode: codeMatch ? codeMatch[0].toUpperCase() : undefined
    };
  }

  // Parse decline
  if (lowerText.includes("decline") || lowerText.includes("dodge")) {
    const codeMatch = text.match(/BOTA-[A-Z0-9-]+-[A-Z0-9-]+/i);
    return {
      intent: "decline",
      challengeCode: codeMatch ? codeMatch[0].toUpperCase() : undefined
    };
  }

  return { intent: "unknown" };
}

export async function handleTwitterChallengeIntent(
  challengerTwitterHandle: string,
  targetHandle: string,
  amount: number,
  replyCallback: (text: string, mediaBuffer?: Buffer) => Promise<string> // Returns tweet ID
) {
  const challenger = await getBantahUserByTwitterHandle(challengerTwitterHandle);
  if (!challenger) {
    await replyCallback(`🔐 @${challengerTwitterHandle.replace(/^@/, '')} please link your Twitter account to Bantah first before challenging someone!`);
    return;
  }

  const opponent = await getBantahUserByTwitterHandle(targetHandle);

  if (challenger.id === opponent?.id) {
    await replyCallback(`⚠️ You cannot challenge yourself.`);
    return;
  }

  const opponentId = opponent ? opponent.id : `twitter:${targetHandle}`;

  try {
    // Generate URL for user to finish challenge creation on Web.
    // Normally, this would generate an image and tweet it. 
    // We send back the challenge deep link.
    const url = `https://bota.bantah.fun/challenge?opponent=${opponentId}&amount=${amount}&source=twitter`;
    await replyCallback(
      `⚔️ CHALLENGE INITIATED\n\n@${challengerTwitterHandle.replace(/^@/, '')} challenges @${targetHandle.replace(/^@/, '')} for ${amount} BC.\n\nFinish selecting your agent to make it live:\n${url}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Challenge failed.";
    await replyCallback(`⚠️ Challenge failed.\n\n${message}`);
  }
}
