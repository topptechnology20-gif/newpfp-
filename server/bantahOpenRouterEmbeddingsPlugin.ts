import { ModelType, type Plugin } from "@elizaos/core";

function getSetting(runtime: { getSetting: (key: string) => unknown }, key: string, fallback = "") {
  const value = runtime.getSetting(key);
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  const envValue = String(process.env[key] || "").trim();
  return envValue || fallback;
}

function getOpenRouterBaseUrl(runtime: { getSetting: (key: string) => unknown }) {
  return getSetting(runtime, "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
}

function getOpenRouterApiKey(runtime: { getSetting: (key: string) => unknown }) {
  return getSetting(runtime, "OPENROUTER_API_KEY");
}

function getEmbeddingModel(runtime: { getSetting: (key: string) => unknown }) {
  return (
    getSetting(runtime, "OPENROUTER_EMBEDDING_MODEL") ||
    getSetting(runtime, "EMBEDDING_MODEL") ||
    "openai/text-embedding-3-small"
  );
}

async function createEmbedding(
  runtime: { getSetting: (key: string) => unknown },
  params: { text: string } | string | null,
) {
  const apiKey = getOpenRouterApiKey(runtime);
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for TEXT_EMBEDDING.");
  }

  const input =
    typeof params === "string" ? params : params?.text ?? "";

  const response = await fetch(`${getOpenRouterBaseUrl(runtime)}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getEmbeddingModel(runtime),
      input,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter embeddings request failed (${response.status}): ${body}`);
  }

  const payload = await response.json() as {
    data?: Array<{ embedding?: number[] }>;
  };

  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("OpenRouter embeddings response did not contain a usable embedding.");
  }

  return embedding;
}

export const bantahOpenRouterEmbeddingsPlugin: Plugin = {
  name: "bantah-openrouter-embeddings",
  description: "Adds a real OpenRouter-backed TEXT_EMBEDDING handler for Bantah-managed runtimes.",
  models: {
    [ModelType.TEXT_EMBEDDING]: async (runtime, params) => createEmbedding(runtime as any, params as any),
  },
};
