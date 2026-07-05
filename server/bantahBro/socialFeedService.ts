import type { BantahBroAlert, BantahBroReceipt } from "@shared/bantahBro";
import { pool } from "../db";
import { listBantahBroAlerts, listBantahBroReceipts } from "./alertFeed";
import {
  buildBantahBroTelegramAlertMessage,
  buildBantahBroTelegramReceiptMessage,
} from "./telegramSupport";

export type BantahBroFeedSource = "bantah" | "twitter" | "telegram";

export interface BantahBroFeedItem {
  id: string;
  user: string;
  avatar: string;
  handle: string;
  timestamp: string;
  content: string;
  market?: string;
  marketEmoji?: string;
  betChoice?: "yes" | "no";
  betAmount?: string;
  likes: number;
  comments: number;
  tags: string[];
  source: BantahBroFeedSource;
  url?: string;
}

type FeedOptions = {
  limit?: number;
  source?: BantahBroFeedSource;
};

const MAX_RECORDED_TELEGRAM_POSTS = 200;
const recordedTelegramPosts: BantahBroFeedItem[] = [];
let telegramFeedTableReady = false;
let telegramFeedTablePromise: Promise<void> | null = null;

function sortNewest<T extends { timestamp: string }>(items: T[]) {
  return [...items].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function upsertRecordedPost(post: BantahBroFeedItem) {
  const index = recordedTelegramPosts.findIndex((item) => item.id === post.id);
  if (index >= 0) {
    recordedTelegramPosts[index] = post;
  } else {
    recordedTelegramPosts.unshift(post);
  }
  if (recordedTelegramPosts.length > MAX_RECORDED_TELEGRAM_POSTS) {
    recordedTelegramPosts.length = MAX_RECORDED_TELEGRAM_POSTS;
  }
}

function compactTags(tags: Array<string | null | undefined>) {
  const seen = new Set<string>();
  return tags
    .map((tag) => String(tag || "").replace(/^#|\$/g, "").trim())
    .filter(Boolean)
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

async function ensureTelegramFeedTable() {
  if (telegramFeedTableReady) return;
  if (!telegramFeedTablePromise) {
    telegramFeedTablePromise = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS bantah_telegram_feed_posts (
           id text PRIMARY KEY,
           post jsonb NOT NULL,
           created_at timestamp NOT NULL DEFAULT now(),
           updated_at timestamp NOT NULL DEFAULT now()
         )`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_bantah_telegram_feed_posts_updated
           ON bantah_telegram_feed_posts (updated_at DESC)`,
      );
      telegramFeedTableReady = true;
    })().finally(() => {
      telegramFeedTablePromise = null;
    });
  }
  await telegramFeedTablePromise;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeTelegramFeedPost(input: unknown): BantahBroFeedItem | null {
  if (!input || typeof input !== "object") return null;
  const post = input as Partial<BantahBroFeedItem>;
  if (!post.id || !post.content) return null;

  const likes = Number(post.likes);
  const comments = Number(post.comments);
  const betChoice = post.betChoice === "yes" || post.betChoice === "no" ? post.betChoice : undefined;

  return {
    id: String(post.id),
    user: post.user || "BantahBro Official",
    avatar: post.avatar || "BOTA",
    handle: post.handle || "BantahBroOfficial",
    timestamp: post.timestamp || new Date().toISOString(),
    content: String(post.content),
    market: optionalString(post.market),
    marketEmoji: optionalString(post.marketEmoji),
    betChoice,
    betAmount: optionalString(post.betAmount),
    likes: Number.isFinite(likes) ? likes : 0,
    comments: Number.isFinite(comments) ? comments : 0,
    tags: compactTags(Array.isArray(post.tags) ? post.tags : ["BantahBro"]),
    source: "telegram",
    url: optionalString(post.url),
  };
}

async function persistRecordedPost(post: BantahBroFeedItem) {
  await ensureTelegramFeedTable();
  await pool.query(
    `INSERT INTO bantah_telegram_feed_posts (id, post, created_at, updated_at)
       VALUES ($1, $2::jsonb, now(), now())
       ON CONFLICT (id)
       DO UPDATE SET post = excluded.post, updated_at = excluded.updated_at`,
    [post.id, JSON.stringify(post)],
  );
}

async function loadPersistedTelegramPosts(limit: number) {
  try {
    await ensureTelegramFeedTable();
    const result = await pool.query(
      `SELECT post
         FROM bantah_telegram_feed_posts
        ORDER BY updated_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(limit, MAX_RECORDED_TELEGRAM_POSTS))],
    );
    return result.rows
      .map((row) => normalizeTelegramFeedPost(row.post))
      .filter((item): item is BantahBroFeedItem => Boolean(item));
  } catch (error) {
    console.warn("[WARN] Unable to load persisted BantahBro Telegram feed posts:", error);
    return [];
  }
}

function alertTypeTag(type: BantahBroAlert["type"]) {
  if (type === "rug_alert") return "RugScore";
  if (type === "runner_alert") return "RunnerScore";
  if (type === "market_live") return "NewMarket";
  if (type === "boost_live") return "Boost";
  if (type === "receipt") return "Receipt";
  if (type === "aftermath") return "Aftermath";
  return "Watch";
}

function marketEmojiForAlert(type: BantahBroAlert["type"]) {
  if (type === "rug_alert") return "⚠️";
  if (type === "runner_alert") return "🚀";
  if (type === "market_live") return "🎯";
  if (type === "boost_live") return "📣";
  if (type === "receipt") return "🧾";
  return "👀";
}

function firstBodyLine(body: string) {
  return (
    String(body || "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !/^market live:/i.test(line) && !/^https?:\/\//i.test(line)) || ""
  );
}

function marketLabelFromAlert(alert: BantahBroAlert) {
  if (!alert.market?.url) return undefined;
  return firstBodyLine(alert.body) || alert.headline;
}

function sourceUrlForAlert(alert: BantahBroAlert) {
  return alert.market?.url || undefined;
}

function toTelegramAlertItem(alert: BantahBroAlert): BantahBroFeedItem {
  const { text } = buildBantahBroTelegramAlertMessage(alert, null);
  return {
    id: `telegram-alert-${alert.id}`,
    user: "BantahBro Official",
    avatar: "📣",
    handle: "BantahBroOfficial",
    timestamp: alert.updatedAt || alert.createdAt,
    content: text,
    market: marketLabelFromAlert(alert),
    marketEmoji: alert.market ? marketEmojiForAlert(alert.type) : undefined,
    likes: 0,
    comments: 0,
    tags: compactTags([alert.tokenSymbol, alertTypeTag(alert.type), alert.chainId, "BantahBro"]),
    source: "telegram",
    url: sourceUrlForAlert(alert),
  };
}

function toTelegramReceiptItem(receipt: BantahBroReceipt): BantahBroFeedItem {
  return {
    id: `telegram-receipt-${receipt.id}`,
    user: "BantahBro Official",
    avatar: "🧾",
    handle: "BantahBroOfficial",
    timestamp: receipt.updatedAt || receipt.createdAt,
    content: buildBantahBroTelegramReceiptMessage(receipt),
    market: receipt.market?.url ? firstBodyLine(receipt.body) || receipt.headline : undefined,
    marketEmoji: receipt.market ? "🧾" : undefined,
    likes: 0,
    comments: 0,
    tags: compactTags([receipt.tokenSymbol, receipt.status, "Receipt", "BantahBro"]),
    source: "telegram",
    url: receipt.market?.url || undefined,
  };
}

export async function recordBantahBroTelegramPost(
  post: Omit<Partial<BantahBroFeedItem>, "id" | "content" | "source"> & {
    id: string;
    content: string;
  },
) {
  const item: BantahBroFeedItem = {
    id: post.id,
    user: post.user || "BantahBro Official",
    avatar: post.avatar || "📣",
    handle: post.handle || "BantahBroOfficial",
    timestamp: post.timestamp || new Date().toISOString(),
    content: post.content,
    market: post.market,
    marketEmoji: post.marketEmoji,
    betChoice: post.betChoice,
    betAmount: post.betAmount,
    likes: post.likes ?? 0,
    comments: post.comments ?? 0,
    tags: compactTags(post.tags || ["BantahBro"]),
    source: "telegram",
    url: post.url,
  };
  upsertRecordedPost(item);
  try {
    await persistRecordedPost(item);
  } catch (error) {
    console.warn("[WARN] Unable to persist BantahBro Telegram feed post:", error);
  }
}

export async function getBantahBroSocialFeed(options: FeedOptions = {}) {
  const limit = Math.max(1, Math.min(options.limit || 50, 100));
  const source = options.source;
  const itemsById = new Map<string, BantahBroFeedItem>();

  if (!source || source === "telegram") {
    for (const item of await loadPersistedTelegramPosts(limit)) {
      itemsById.set(item.id, item);
    }
    for (const item of listBantahBroAlerts(limit).map(toTelegramAlertItem)) {
      itemsById.set(item.id, item);
    }
    for (const item of listBantahBroReceipts(limit).map(toTelegramReceiptItem)) {
      itemsById.set(item.id, item);
    }
    for (const item of recordedTelegramPosts) {
      itemsById.set(item.id, item);
    }
  }

  const items = sortNewest(Array.from(itemsById.values())).slice(0, limit);
  return {
    items,
    sources: {
      bantah: { status: "live", count: source === "bantah" ? items.length : 0 },
      telegram: { status: "live", count: items.filter((item) => item.source === "telegram").length },
      twitter: { status: "pending", count: 0 },
    },
    generatedAt: new Date().toISOString(),
  };
}
