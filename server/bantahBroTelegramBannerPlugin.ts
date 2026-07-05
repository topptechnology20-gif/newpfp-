import fs from "fs";
import path from "path";
import type { Plugin } from "@elizaos/core";
import {
  buildBantahBroTelegramStartInlineReplyMarkup,
  buildBantahBroTelegramWelcomeMessage,
} from "./bantahBro/telegramSupport";

function resolveBannerPath() {
  const configured = String(process.env.BANTAHBRO_TELEGRAM_BANNER_PATH || "").trim();
  const candidates = [
    configured,
    path.resolve(process.cwd(), "public", "bantahbro", "telegram-banner.jpg"),
    path.resolve(process.cwd(), "public", "bantahbro", "telegram-banner.png"),
    path.resolve(process.cwd(), "client", "public", "assets", "bantahbro-telegram-banner.jpg"),
    path.resolve(process.cwd(), "client", "public", "assets", "bantahbro-telegram-banner.png"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildStartReplyMarkup() {
  return buildBantahBroTelegramStartInlineReplyMarkup();
}

async function sendStartBanner(ctx: any) {
  const firstName = String(ctx?.from?.first_name || "there").trim() || "there";
  const text = buildBantahBroTelegramWelcomeMessage(firstName);
  const replyMarkup = buildStartReplyMarkup();
  const bannerPath = resolveBannerPath();

  if (bannerPath && typeof ctx?.replyWithPhoto === "function") {
    await ctx.replyWithPhoto(
      { source: fs.createReadStream(bannerPath) },
      {
        caption: text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
    );
    return;
  }

  if (typeof ctx?.reply === "function") {
    await ctx.reply(
      text,
      replyMarkup ? { reply_markup: replyMarkup } : undefined,
    );
  }
}

export const bantahBroTelegramBannerPlugin: Plugin = {
  name: "bantahbro-telegram-banner",
  description: "Sends a branded BantahBro welcome banner on Telegram /start.",
  events: {
    TELEGRAM_SLASH_START: [
      async ({ ctx }: { ctx?: any }) => {
        if (!ctx) {
          return;
        }
        await sendStartBanner(ctx);
      },
    ],
  },
};
