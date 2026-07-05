import fs from "fs";
import path from "path";
import type { Plugin, Provider } from "@elizaos/core";

type KnowledgeDoc = {
  id: string;
  title: string;
  text: string;
  keywords: Set<string>;
};

const KNOWLEDGE_DIR = path.resolve(process.cwd(), "docs", "bantahbro", "knowledge");
let cachedDocs: KnowledgeDoc[] | null = null;

function tokenize(text: string) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_$\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function extractTitle(markdown: string, fallback: string) {
  const firstHeading = markdown.match(/^#\s+(.+)$/m);
  return firstHeading?.[1]?.trim() || fallback;
}

function loadKnowledgeDocs() {
  if (cachedDocs) return cachedDocs;
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    cachedDocs = [];
    return cachedDocs;
  }

  cachedDocs = fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const fullPath = path.join(KNOWLEDGE_DIR, file);
      const text = fs.readFileSync(fullPath, "utf8").trim();
      return {
        id: file.replace(/\.md$/, ""),
        title: extractTitle(text, file),
        text,
        keywords: new Set(tokenize(text)),
      };
    });

  return cachedDocs;
}

function scoreDoc(doc: KnowledgeDoc, queryTokens: string[]) {
  let score = 0;
  for (const token of queryTokens) {
    if (doc.keywords.has(token)) {
      score += 1;
    }
  }
  return score;
}

function getRelevantKnowledge(query: string, limit = 3) {
  const docs = loadKnowledgeDocs();
  const queryTokens = tokenize(query);
  if (docs.length === 0 || queryTokens.length === 0) {
    return [];
  }

  return docs
    .map((doc) => ({
      doc,
      score: scoreDoc(doc, queryTokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.doc);
}

const bantahBroKnowledgeProvider: Provider = {
  name: "BANTAHBRO_KNOWLEDGE_CONTEXT",
  description:
    "Static BantahBro knowledge about Bantah, BXBT, Telegram behavior, market rules, supported chains, and safety policy.",
  position: -4,
  get: async (_runtime, message) => {
    const text = String(message?.content?.text || "").trim();
    const docs = getRelevantKnowledge(text);

    if (docs.length === 0) {
      return {
        values: {
          bantahBroKnowledge: [],
        },
        data: {
          bantahBroKnowledge: [],
        },
        text: "",
      };
    }

    const contextText = [
      "BANTAHBRO STATIC KNOWLEDGE",
      ...docs.map((doc) => [`## ${doc.title}`, doc.text].join("\n")),
      "Instruction: Use this static knowledge for product, BXBT, market-rule, Telegram, chain, and safety questions. Do not use it for volatile live prices, balances, rankings, or market status.",
    ].join("\n\n");

    return {
      values: {
        bantahBroKnowledge: docs.map((doc) => doc.title),
      },
      data: {
        bantahBroKnowledge: docs,
      },
      text: contextText,
    };
  },
};

export function resetBantahBroKnowledgeCacheForTests() {
  cachedDocs = null;
}

export const bantahBroKnowledgePlugin: Plugin = {
  name: "bantahbro-knowledge",
  description: "Adds static BantahBro product and policy knowledge to the Eliza runtime.",
  providers: [bantahBroKnowledgeProvider],
};
