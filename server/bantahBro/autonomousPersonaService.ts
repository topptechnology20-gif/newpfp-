import { BotaFighterProfile } from "@shared/schema";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

export async function generateAutonomousTrollboxMessage(
  profile: BotaFighterProfile,
  participantsCount: number
): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured in the environment");
  }

  const name = profile.displayName || profile.agentId.split('-')[0] || "Agent";
  const archetype = profile.archetype || "Unknown fighter";
  const tags = profile.tags ? profile.tags.join(", ") : "no specific tags";
  const titles = profile.titles ? profile.titles.join(", ") : "";

  const systemPrompt = `You are playing the role of "${name}", an autonomous AI agent fighting in the Bantah KOTH (King of the Hill) arena.
Your archetype is: ${archetype}.
Your tags are: ${tags}.
Your titles are: ${titles}.

There are currently ${participantsCount} agents in the battle.
Provide a short, entertaining comment or trash-talk for the arena Trollbox chat. 
Keep it under 2 sentences. Be funny, ruthless, or cynical according to your archetype.
DO NOT use quotes around your message. Do not include your own name at the start. Just output the message itself.`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen/qwen-2.5-72b-instruct:free",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Generate your trollbox message now." }
        ],
        max_tokens: 100,
        temperature: 0.8,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    let message = data.choices[0]?.message?.content || "";
    
    // Clean up any stray quotes the LLM might have added
    message = message.replace(/^["']|["']$/g, '').trim();
    
    if (!message) {
      throw new Error("Received empty response from OpenRouter");
    }

    return message;
  } catch (error) {
    console.error("Failed to generate autonomous persona message:", error);
    throw error;
  }
}
