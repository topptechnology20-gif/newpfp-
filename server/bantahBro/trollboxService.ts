export type BantahBroTrollboxSource = "web" | "telegram" | "system";

export interface BantahBroTrollboxMessage {
  id: string;
  roomId: string;
  battleId: string | null;
  source: BantahBroTrollboxSource;
  user: string;
  handle: string | null;
  message: string;
  createdAt: string;
  telegram: {
    chatId: string | null;
    messageId: string | null;
    username: string | null;
  } | null;
}

export interface BantahBroTrollboxFeed {
  roomId: string;
  battleId: string | null;
  generatedAt: string;
  messages: BantahBroTrollboxMessage[];
  counts: Record<BantahBroTrollboxSource, number>;
}

type RecordMessageInput = {
  roomId?: string | null;
  battleId?: string | null;
  source: BantahBroTrollboxSource;
  user?: string | null;
  handle?: string | null;
  message: string;
  createdAt?: string | null;
  telegram?: {
    chatId?: string | null;
    messageId?: string | number | null;
    username?: string | null;
  } | null;
};

const MAX_MESSAGES = 500;
const DEFAULT_ROOM_ID = "agent-battle";

const messages: BantahBroTrollboxMessage[] = [];
const telegramMessageIds = new Set<string>();

function cleanText(value: unknown, fallback = "") {
  const text = String(value ?? fallback)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  return text;
}

function clampText(value: unknown, fallback: string, maxLength: number) {
  const cleaned = cleanText(value, fallback);
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

function makeMessageId(input: RecordMessageInput) {
  const telegramMessageId = input.telegram?.messageId;
  if (telegramMessageId) {
    const chatId = input.telegram?.chatId || "group";
    return `tg-${chatId}-${telegramMessageId}`;
  }

  const entropy = Math.random().toString(36).slice(2, 8);
  return `${input.source}-${Date.now()}-${entropy}`;
}

function buildTelegramDedupeId(input: RecordMessageInput) {
  const messageId = input.telegram?.messageId;
  if (!messageId) return null;
  return `${input.telegram?.chatId || "group"}:${messageId}`;
}

export function recordBantahBroTrollboxMessage(input: RecordMessageInput): BantahBroTrollboxMessage | null {
  const message = clampText(input.message, "", 1000);
  if (!message) return null;

  const telegramDedupeId = buildTelegramDedupeId(input);
  if (telegramDedupeId && telegramMessageIds.has(telegramDedupeId)) {
    return messages.find((item) => item.id === `tg-${telegramDedupeId.replace(":", "-")}`) || null;
  }

  const createdAt = input.createdAt || new Date().toISOString();
  const roomId = clampText(input.roomId, DEFAULT_ROOM_ID, 120) || DEFAULT_ROOM_ID;
  const battleId = cleanText(input.battleId) || null;
  const id = makeMessageId(input);
  const handle = cleanText(input.handle) || null;
  const username = cleanText(input.telegram?.username) || (handle?.startsWith("@") ? handle.slice(1) : null);

  const nextMessage: BantahBroTrollboxMessage = {
    id,
    roomId,
    battleId,
    source: input.source,
    user: clampText(input.user, "", 64),
    handle,
    message,
    createdAt,
    telegram: input.telegram
      ? {
          chatId: cleanText(input.telegram.chatId) || null,
          messageId: cleanText(input.telegram.messageId) || null,
          username,
        }
      : null,
  };

  if (telegramDedupeId) {
    telegramMessageIds.add(telegramDedupeId);
  }

  messages.push(nextMessage);
  messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  while (messages.length > MAX_MESSAGES) {
    const removed = messages.shift();
    if (removed?.telegram?.messageId) {
      telegramMessageIds.delete(`${removed.telegram.chatId || "group"}:${removed.telegram.messageId}`);
    }
  }

  return nextMessage;
}

export function getBantahBroTrollboxFeed(params?: {
  roomId?: string | null;
  battleId?: string | null;
  limit?: number | null;
}): BantahBroTrollboxFeed {
  const roomId = clampText(params?.roomId, DEFAULT_ROOM_ID, 120) || DEFAULT_ROOM_ID;
  const battleId = cleanText(params?.battleId) || null;
  const limit = Math.max(1, Math.min(Number(params?.limit || 60), 100));

  const filtered = messages.filter((message) => {
    if (message.roomId !== roomId) return false;
    if (battleId && message.battleId !== battleId) return false;
    return true;
  });

  const selected = filtered.slice(Math.max(0, filtered.length - limit));
  const counts: Record<BantahBroTrollboxSource, number> = {
    web: 0,
    telegram: 0,
    system: 0,
  };

  for (const message of selected) {
    counts[message.source] += 1;
  }

  return {
    roomId,
    battleId,
    generatedAt: new Date().toISOString(),
    messages: selected,
    counts,
  };
}

export function resolveBantahBroTrollboxRoom(message: string) {
  const match = message.match(/#battle[:_-]?([a-z0-9-]+)/i);
  if (!match?.[1]) {
    return { roomId: DEFAULT_ROOM_ID, battleId: null };
  }

  const battleId = match[1].toLowerCase();
  return {
    roomId: DEFAULT_ROOM_ID,
    battleId,
  };
}
