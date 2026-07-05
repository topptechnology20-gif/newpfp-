import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from './db';
import * as schema from '../shared/schema';
import { eq, or, desc, and } from 'drizzle-orm';
import { storage } from './storage';
import { TelegramLinkingService } from './telegramLinking';
import { analyzeToken } from './bantahBro/tokenIntelligence';
import {
  buildAlertFromAnalysis,
  buildReceiptFromAlert,
} from './bantahBro/contentEngine';
import { runBantahBroSurfaceScan } from './bantahBro/rugScorerSurface';
import {
  getBantahBroAlert,
  getBantahBroReceiptBySourceAlert,
  listBantahBroAlerts,
  publishBantahBroAlert,
  publishBantahBroReceipt,
} from './bantahBro/alertFeed';
import { createBantahBroMarketFromSignal } from './bantahBro/marketService';
import { getBantahBroBxbtStatus } from './bantahBro/bxbtUtility';
import { maybeHandleBantahBroCommandSurface } from './bantahBro/commandSurface';
import { getBantahBroSystemAgentStatus } from './bantahBro/systemAgent';
import {
  buildBantahBroAgentUrl,
  buildBantahBroAgentsUrl,
  buildBantahBroBattlesUrl,
  buildBantahBroTelegramAlertMessage,
  buildBantahBroTelegramAlertsDigest,
  buildBantahBroTelegramBxbtMessage,
  buildBantahBroTelegramBotDescription,
  buildBantahBroTelegramBotShortDescription,
  buildBantahBroTelegramCommandMenu,
  buildBantahBroTelegramFriendsMessage,
  buildBantahBroTelegramHelp,
  buildBantahBroTelegramLeaderboardMessage,
  buildBantahBroTelegramMarketsDigest,
  buildBantahBroTelegramReceiptMessage,
  buildBantahBroTelegramStartButtonPrompt,
  buildBantahBroTelegramStartReplyMarkup,
  buildBantahBroTelegramWelcomeMessage,
  buildBantahBroTokenScanUrl,
  defaultBantahBroMarketCurrency,
  parseBantahBroTelegramStartButton,
  parseBantahBroTelegramTokenCommand,
} from './bantahBro/telegramSupport';
import { recordBantahBroTelegramPost } from './bantahBro/socialFeedService';
import { getBantahBroLeaderboard } from './bantahBro/communityService';
import type {
  BantahBroAlert,
  BantahBroReceipt,
  BantahBroTokenAnalysis,
} from '@shared/bantahBro';
import type {
  BantahBroAgentBattle,
  BantahBroAgentBattleSide,
} from './bantahBro/agentBattleService';


interface TelegramBotConfig {
  token: string;
  channelId: string;
  username?: string | null;
  label?: string;
}

interface EventBroadcast {
  id: string | number;
  title: string;
  description?: string;
  creator: {
    name: string;
    username?: string;
  };
  pool?: {
    total_amount?: number;
    entry_amount?: number;
  };
  eventPool?: string;
  yesPool?: string;
  noPool?: string;
  entryFee?: string;
  end_time?: string;
  endDate?: string;
  is_private?: boolean;
  max_participants?: number;
  category?: string;
}

interface ChallengeBroadcast {
  id: string | number;
  title: string;
  description?: string;
  creator: {
    name: string;
    username?: string;
  };
  challenged?: {
    name: string;
    username?: string;
  };
  stake_amount: number;
  stake_display?: string;
  settlement_label?: string;
  tokenSymbol?: string;
  token_symbol?: string;
  status: string;
  end_time?: string;
  category?: string;
  imageUrl?: string;
}

interface ChallengeResultBroadcast {
  id: string | number;
  title: string;
  winner: {
    name: string;
    username?: string;
  };
  loser: {
    name: string;
    username?: string;
  };
  stake_amount: number;
  tokenSymbol?: string;
  token_symbol?: string;
  category?: string;
  result_type: 'challenger_wins' | 'challenged_wins' | 'draw';
}

interface MatchmakingBroadcast {
  challengeId: string | number;
  challenger: {
    name: string;
    username?: string;
  };
  challenged: {
    name: string;
    username?: string;
  };
  stake_amount: number;
  tokenSymbol?: string;
  token_symbol?: string;
  category?: string;
}

interface LeaderboardBroadcast {
  user: {
    name: string;
    username?: string;
  };
  new_rank: number;
  old_rank?: number;
  total_wins: number;
  total_earnings: number;
  achievement?: string;
}

interface ChallengeJoinedBroadcast {
  challengeId: string | number;
  title: string;
  joiner: {
    name: string;
    username?: string;
  };
  participant_count: number;
  stake_amount: number;
  tokenSymbol?: string;
  token_symbol?: string;
  category?: string;
  imageUrl?: string;
}

interface ChallengeParticipantCountBroadcast {
  challengeId: string | number;
  title: string;
  current_participants: number;
  max_participants?: number;
  category?: string;
}

interface ChallengeBonusAddedBroadcast {
  challengeId: string | number;
  title: string;
  bonus_type: 'early_join' | 'underdog' | 'imbalance';
  bonus_multiplier: number;
  category?: string;
}

interface ChallengeAwaitingBroadcast {
  challengeId: string | number;
  title: string;
  creator: {
    name: string;
    username?: string;
  };
  stake_amount: number;
  tokenSymbol?: string;
  token_symbol?: string;
  category?: string;
  imageUrl?: string;
}

export class TelegramBotService {
  private token: string;
  private channelId: string;
  private baseUrl: string;
  private webhookUrl: string | null = null;
  private bot: TelegramBot; // Add TelegramBot instance
  private username: string | null;
  private label: string;

  constructor(config: TelegramBotConfig) {
    this.token = config.token;
    this.channelId = config.channelId;
    this.username = config.username?.trim() || null;
    this.label = config.label?.trim() || "Telegram";
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.bot = new TelegramBot(config.token, { polling: false }); // Initialize bot instance, polling disabled as we handle it manually
  }

  private normalizeTokenSymbol(tokenLike: unknown): string | null {
    if (typeof tokenLike !== 'string') return null;
    const trimmed = tokenLike.trim();
    if (!trimmed) return null;
    return trimmed.toUpperCase();
  }

  private formatNumber(value: number): string {
    const safeValue = Number.isFinite(value) ? value : 0;
    const absolute = Math.abs(safeValue);
    const maxFractionDigits =
      absolute >= 1000 ? 2 : absolute >= 1 ? 4 : absolute > 0 ? 8 : 0;

    return safeValue.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFractionDigits,
    });
  }

  private formatAmount(value: number, tokenLike?: unknown): string {
    const amountText = this.formatNumber(value);
    const tokenSymbol = this.normalizeTokenSymbol(tokenLike);
    return tokenSymbol ? `${amountText} ${tokenSymbol}` : amountText;
  }

  private escapeHtml(value: unknown): string {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private formatCompactUsd(value: number | null | undefined): string {
    const resolved = Number(value);
    if (!Number.isFinite(resolved) || resolved <= 0) return "n/a";
    if (resolved >= 1_000_000_000) return `$${(resolved / 1_000_000_000).toFixed(2)}B`;
    if (resolved >= 1_000_000) return `$${(resolved / 1_000_000).toFixed(2)}M`;
    if (resolved >= 1_000) return `$${(resolved / 1_000).toFixed(1)}K`;
    return `$${resolved.toFixed(2)}`;
  }

  private formatCompactPrice(value: number | null | undefined): string {
    const resolved = Number(value);
    if (!Number.isFinite(resolved) || resolved <= 0) return "n/a";
    if (resolved >= 1) return `$${resolved.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
    return `$${resolved.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`;
  }

  private formatSignedPercent(value: number | null | undefined): string {
    const resolved = Number(value);
    if (!Number.isFinite(resolved)) return "0.00%";
    const absolute = Math.abs(resolved);
    const precision = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
    return `${resolved > 0 ? "+" : ""}${resolved.toFixed(precision)}%`;
  }

  private formatBattleDuration(seconds: number | null | undefined): string {
    const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    return `${minutes}:${remainder.toString().padStart(2, "0")}`;
  }

  private battleSideSymbol(side: BantahBroAgentBattleSide): string {
    const tokenSymbol = side.tokenSymbol || side.label || "LIVE";
    const normalized = String(tokenSymbol).replace(/^\$/, "").trim() || "LIVE";
    return `$${normalized}`;
  }

  private formatStakeDisplay(
    rawDisplay: unknown,
    value: number,
    tokenLike?: unknown,
  ): string {
    if (typeof rawDisplay === 'string' && rawDisplay.trim().length > 0) {
      return rawDisplay.trim();
    }
    return this.formatAmount(value, tokenLike);
  }

  private resolveBantahBroBannerPath(): string | null {
    const configured = String(process.env.BANTAHBRO_TELEGRAM_BANNER_PATH || '').trim();
    const candidates = [
      configured,
      path.resolve(process.cwd(), 'dist', 'public', 'bantahbro', 'telegram-banner.jpg'),
      path.resolve(process.cwd(), 'dist', 'public', 'bantahbro', 'telegram-banner.png'),
      path.resolve(process.cwd(), 'public', 'bantahbro', 'telegram-banner.jpg'),
      path.resolve(process.cwd(), 'public', 'bantahbro', 'telegram-banner.png'),
      path.resolve(process.cwd(), 'client', 'public', 'bantahbro', 'telegram-banner.jpg'),
      path.resolve(process.cwd(), 'client', 'public', 'bantahbro', 'telegram-banner.png'),
      path.resolve(process.cwd(), 'client', 'public', 'assets', 'bantahbro-telegram-banner.jpg'),
      path.resolve(process.cwd(), 'client', 'public', 'assets', 'bantahbro-telegram-banner.png'),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private resolveBantahBroAlertBannerPath(): string | null {
    const configured = String(process.env.BANTAHBRO_TELEGRAM_ALERT_BANNER_PATH || '').trim();
    const candidates = [
      configured,
      path.resolve(process.cwd(), 'dist', 'public', 'bantahbro', 'alert-banner.png'),
      path.resolve(process.cwd(), 'dist', 'public', 'bantahbro', 'alert-banner.jpg'),
      path.resolve(process.cwd(), 'public', 'bantahbro', 'alert-banner.png'),
      path.resolve(process.cwd(), 'public', 'bantahbro', 'alert-banner.jpg'),
      path.resolve(process.cwd(), 'client', 'public', 'bantahbro', 'alert-banner.png'),
      path.resolve(process.cwd(), 'client', 'public', 'bantahbro', 'alert-banner.jpg'),
      path.resolve(process.cwd(), 'client', 'public', 'assets', 'bantahbro-alert-banner.png'),
      path.resolve(process.cwd(), 'client', 'public', 'assets', 'bantahbro-alert-banner.jpg'),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private resolveBantahBroMarketAlertBannerPath(): string | null {
    const configured = String(process.env.BANTAHBRO_TELEGRAM_MARKET_BANNER_PATH || '').trim();
    const candidates = [
      configured,
      path.resolve(process.cwd(), 'dist', 'public', 'bantahbro', 'market-banner.jpg'),
      path.resolve(process.cwd(), 'dist', 'public', 'bantahbro', 'market-banner.png'),
      path.resolve(process.cwd(), 'public', 'bantahbro', 'market-banner.jpg'),
      path.resolve(process.cwd(), 'public', 'bantahbro', 'market-banner.png'),
      path.resolve(process.cwd(), 'client', 'public', 'bantahbro', 'market-banner.jpg'),
      path.resolve(process.cwd(), 'client', 'public', 'bantahbro', 'market-banner.png'),
      path.resolve(process.cwd(), 'client', 'public', 'assets', 'bantahbro-market-banner.jpg'),
      path.resolve(process.cwd(), 'client', 'public', 'assets', 'bantahbro-market-banner.png'),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private isBantahBroMarketAlert(alert: BantahBroAlert): boolean {
    return alert.type === 'market_live' || alert.type === 'boost_live' || Boolean(alert.market?.url);
  }

  private buildBantahBroStartReplyMarkup() {
    return buildBantahBroTelegramStartReplyMarkup();
  }

  private isBantahBroBot() {
    return this.label.trim().toLowerCase() === 'bantahbro';
  }

  async syncBantahBroProfile(): Promise<boolean> {
    if (!this.isBantahBroBot()) {
      return true;
    }

    try {
      await this.bot.setMyCommands([...buildBantahBroTelegramCommandMenu()]);
      await axios.post(`${this.baseUrl}/setMyShortDescription`, {
        short_description: buildBantahBroTelegramBotShortDescription(),
      });
      await axios.post(`${this.baseUrl}/setMyDescription`, {
        description: buildBantahBroTelegramBotDescription(),
      });
      await axios.post(`${this.baseUrl}/setChatMenuButton`, {
        menu_button: { type: 'commands' },
      });
      console.log(`✅ ${this.label} Telegram profile synced`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to sync ${this.label} Telegram profile:`, error);
      return false;
    }
  }

  private async sendPhotoMessage(
    chatId: number | string,
    photoPath: string,
    caption: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.bot.sendPhoto(chatId, photoPath, {
        caption,
        ...(replyMarkup ? { reply_markup: replyMarkup as any } : {}),
      });
      return true;
    } catch (error) {
      console.error(`❌ Error sending photo message for ${this.label}:`, error);
      return false;
    }
  }

  private async sendPhotoPathToChannel(
    photoPath: string,
    caption: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      console.log(`📸 Attempting to send local photo to channel: ${this.channelId}`);
      await this.bot.sendPhoto(this.channelId, photoPath, {
        caption,
        parse_mode: 'Markdown',
        ...(replyMarkup ? { reply_markup: replyMarkup as any } : {}),
      });
      console.log('📸 Local photo sent to Telegram channel successfully');
      return true;
    } catch (error) {
      console.error(`❌ Error sending local photo to Telegram channel for ${this.label}:`, error);
      return false;
    }
  }

  // Test bot connection
  async testConnection(): Promise<{ connected: boolean; error?: string; botInfo?: any; channelInfo?: any }> {
    try {
      // Test bot token
      const botInfo = await axios.get(
        `https://api.telegram.org/bot${this.token}/getMe`
      );

      if (!botInfo.data.ok) {
        return {
          connected: false,
          error: `Bot token invalid: ${botInfo.data.description}`
        };
      }

      // Test channel access - handle common issues
      try {
        const channelInfo = await axios.get(
          `https://api.telegram.org/bot${this.token}/getChat`,
          {
            params: { chat_id: this.channelId }
          }
        );

        if (!channelInfo.data.ok) {
          return {
            connected: false,
            error: `Channel access failed: ${channelInfo.data.description}`,
            botInfo: botInfo.data.result
          };
        }

        return {
          connected: true,
          botInfo: botInfo.data.result,
          channelInfo: channelInfo.data.result
        };
      } catch (channelError: any) {
        const errorMsg = channelError.response?.data?.description || channelError.message;

        // Provide specific guidance based on error
        let guidance = '';
        if (errorMsg.includes('chat not found')) {
          guidance = '\n\n📝 How to get the correct channel ID:\n' +
                    '   1. Add @myBantahbot to your channel as admin\n' +
                    '   2. Forward any message from the channel to @userinfobot\n' +
                    '   3. Copy the "Forwarded from chat" ID (should start with -100)\n' +
                    '   4. Update TELEGRAM_CHANNEL_ID in Secrets\n' +
                    '\n   Alternatively, use @mychannelname format (e.g., @mybantahchannel)';
        } else if (errorMsg.includes('bot is not a member')) {
          guidance = '\n\n📝 Bot needs to be added:\n' +
                    '   1. Go to your Telegram channel\n' +
                    '   2. Add @myBantahbot as an administrator\n' +
                    '   3. Grant "Post Messages" permission';
        }

        return {
          connected: false,
          error: errorMsg + guidance,
          botInfo: botInfo.data.result
        };
      }
    } catch (error: any) {
      console.error('❌ Telegram bot test connection error:', error);
      return {
        connected: false,
        error: error.response?.data?.description || error.message
      };
    }
  }

  // Format event message for Telegram
  private formatEventMessage(event: EventBroadcast): string {
    const webAppUrl = (process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '');
    const eventUrl = `https://${webAppUrl}/events/${event.id}/chat`;

    // Calculate pool total
    const eventPoolValue = parseFloat(event.eventPool || '0');
    const yesPoolValue = parseFloat(event.yesPool || '0');
    const noPoolValue = parseFloat(event.noPool || '0');
    const poolTotal = event.pool?.total_amount ||
      (eventPoolValue > 0 ? eventPoolValue : yesPoolValue + noPoolValue) || 0;

    // Format entry fee
    const entryFee = event.pool?.entry_amount || parseFloat(event.entryFee || '0');

    // Format time
    const endTime = event.end_time || event.endDate;
    let timeInfo = '';
    if (endTime) {
      try {
        const endDate = new Date(endTime);
        if (!isNaN(endDate.getTime())) {
          const now = new Date();
          const diffMs = endDate.getTime() - now.getTime();
          const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
          const diffDays = Math.floor(diffHours / 24);

          if (diffDays > 0) {
            timeInfo = `⏰ *${diffDays}d ${diffHours % 24}h remaining*`;
          } else if (diffHours > 0) {
            timeInfo = `⏰ *${diffHours}h remaining*`;
          } else {
            timeInfo = `⏰ *Ending soon!*`;
          }
        }
      } catch (error) {
        console.warn('Invalid date in event:', endTime);
      }
    }

    // Get category emoji
    const getCategoryEmoji = (category: string) => {
      const categoryMap: { [key: string]: string } = {
        'crypto': '₿',
        'sports': '⚽',
        'gaming': '🎮',
        'music': '🎵',
        'politics': '🏛️',
        'entertainment': '🎬',
        'tech': '💻',
        'science': '🔬'
      };
      return categoryMap[category?.toLowerCase()] || '🎯';
    };

    const categoryEmoji = getCategoryEmoji(event.category || '');
    const privacyEmoji = event.is_private ? '🔒' : '🌍';
    const creatorDisplay = event.creator.username ? `@${event.creator.username}` : event.creator.name;

    const message = `🔥 *NEW PREDICTION EVENT*

━━━━━━━━━━━━━━━━━━━━━
${categoryEmoji} *${event.title}*
━━━━━━━━━━━━━━━━━━━━━

${event.description ? `💭 _${event.description}_\n` : ''}
👤 *Creator:* ${creatorDisplay}
💰 *Current Pool:* ${this.formatAmount(poolTotal)}
🎫 *Entry Fee:* ${this.formatAmount(entryFee)}
👥 *Max Players:* ${event.max_participants || 'Unlimited'}
${privacyEmoji} *${event.is_private ? 'Private' : 'Public'}* • ${categoryEmoji} *${(event.category || 'General').charAt(0).toUpperCase() + (event.category || 'General').slice(1)}*

${timeInfo}

━━━━━━━━━━━━━━━━━━━━━
🚀 [*JOIN EVENT NOW*](${eventUrl})
━━━━━━━━━━━━━━━━━━━━━

#BetChat #Prediction #${event.category || 'Event'}`;

    return message;
  }

  // Format challenge message for Telegram
  private formatChallengeMessage(challenge: ChallengeBroadcast): string {
    const webAppUrl = (process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '');
    const challengeUrl = `https://${webAppUrl}/challenges/${challenge.id}`;

    // Format time
    const endTime = challenge.end_time;
    let timeInfo = '';
    if (endTime) {
      try {
        const endDate = new Date(endTime);
        if (!isNaN(endDate.getTime())) {
          const now = new Date();
          const diffMs = endDate.getTime() - now.getTime();
          const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
          const diffDays = Math.floor(diffHours / 24);

          if (diffDays > 0) {
            timeInfo = `⏰ *${diffDays}d ${diffHours % 24}h to accept*`;
          } else if (diffHours > 0) {
            timeInfo = `⏰ *${diffHours}h to accept*`;
          } else {
            timeInfo = `⏰ *Accept soon!*`;
          }
        }
      } catch (error) {
        console.warn('Invalid date in challenge:', endTime);
      }
    }

    // Get category emoji
    const getCategoryEmoji = (category: string) => {
      const categoryMap: { [key: string]: string } = {
        'crypto': '₿',
        'sports': '⚽',
        'gaming': '🎮',
        'music': '🎵',
        'politics': '🏛️',
        'entertainment': '🎬',
        'tech': '💻',
        'science': '🔬'
      };
      return categoryMap[category?.toLowerCase()] || '⚔️';
    };

    const categoryEmoji = getCategoryEmoji(challenge.category || '');
    const challengerDisplay = challenge.creator.username ? `@${challenge.creator.username}` : challenge.creator.name;
    const challengedDisplay = challenge.challenged
      ? (challenge.challenged.username ? `@${challenge.challenged.username}` : challenge.challenged.name)
      : null;

    const statusEmoji = challenge.status === 'pending' ? '⏳' :
                       challenge.status === 'active' ? '🔥' :
                       challenge.status === 'completed' ? '✅' : '📋';

    const stakeDisplay =
      this.formatStakeDisplay(
        challenge.stake_display,
        challenge.stake_amount,
        challenge.tokenSymbol || challenge.token_symbol,
      );
    const settlementLine =
      typeof challenge.settlement_label === 'string' && challenge.settlement_label.trim().length > 0
        ? `🧾 *Settlement:* ${challenge.settlement_label.trim()}`
        : '';

    const message = `⚔️ *NEW P2P CHALLENGE*

━━━━━━━━━━━━━━━━━━━━━
${categoryEmoji} *${challenge.title}*
━━━━━━━━━━━━━━━━━━━━━

${challenge.description ? `💭 _${challenge.description}_\n` : ''}
🚀 *Challenger:* ${challengerDisplay}
${challengedDisplay ? `🎯 *Challenged:* ${challengedDisplay}` : '🌍 *Open Challenge - Anyone can accept!*'}
💰 *Stake Amount:* ${stakeDisplay}
${settlementLine}
${statusEmoji} *Status:* ${challenge.status.charAt(0).toUpperCase() + challenge.status.slice(1)}
${challenge.category ? `${categoryEmoji} *Category:* ${challenge.category.charAt(0).toUpperCase() + challenge.category.slice(1)}` : ''}

${timeInfo}

━━━━━━━━━━━━━━━━━━━━━
🎯 [*VIEW CHALLENGE*](${challengeUrl})
━━━━━━━━━━━━━━━━━━━━━

#BetChat #Challenge #P2P #${challenge.category || 'Battle'}`;

    return message;
  }

  // Format challenge result message for Telegram
  private formatChallengeResultMessage(result: ChallengeResultBroadcast): string {
    const getCategoryEmoji = (category: string) => {
      const categoryMap: { [key: string]: string } = {
        'crypto': '₿', 'sports': '⚽', 'gaming': '🎮', 'music': '🎵',
        'politics': '🏛️', 'entertainment': '🎬', 'tech': '💻', 'science': '🔬'
      };
      return categoryMap[category?.toLowerCase()] || '⚔️';
    };

    const categoryEmoji = getCategoryEmoji(result.category || '');
    const winnerDisplay = result.winner.username ? `@${result.winner.username}` : result.winner.name;
    const loserDisplay = result.loser.username ? `@${result.loser.username}` : result.loser.name;

    const resultEmoji = result.result_type === 'draw' ? '🤝' : '🏆';
    const resultText = result.result_type === 'draw' ? 'DRAW' : 'VICTORY';

    const message = `${resultEmoji} *CHALLENGE ${resultText}*

━━━━━━━━━━━━━━━━━━━━━
${categoryEmoji} *${result.title}*
━━━━━━━━━━━━━━━━━━━━━

${result.result_type === 'draw' ?
  `🤝 *Both players fought well!*
💰 *Stakes returned:* ${this.formatAmount(result.stake_amount, result.tokenSymbol || result.token_symbol)} each
👥 *${winnerDisplay}* vs *${loserDisplay}*` :
  `🏆 *Winner:* ${winnerDisplay}
💸 *Loser:* ${loserDisplay}
💰 *Prize:* ${this.formatAmount(result.stake_amount * 2, result.tokenSymbol || result.token_symbol)}`}

${result.category ? `${categoryEmoji} *Category:* ${result.category.charAt(0).toUpperCase() + result.category.slice(1)}` : ''}

━━━━━━━━━━━━━━━━━━━━━

#BetChat #Challenge #${result.result_type === 'draw' ? 'Draw' : 'Victory'} #${result.category || 'Battle'}`;

    return message;
  }

  // Format matchmaking message for Telegram
  private formatMatchmakingMessage(match: MatchmakingBroadcast): string {
    const getCategoryEmoji = (category: string) => {
      const categoryMap: { [key: string]: string } = {
        'crypto': '₿', 'sports': '⚽', 'gaming': '🎮', 'music': '🎵',
        'politics': '🏛️', 'entertainment': '🎬', 'tech': '💻', 'science': '🔬'
      };
      return categoryMap[category?.toLowerCase()] || '⚔️';
    };

    const categoryEmoji = getCategoryEmoji(match.category || '');
    const challengerDisplay = match.challenger.username ? `@${match.challenger.username}` : match.challenger.name;
    const challengedDisplay = match.challenged.username ? `@${match.challenged.username}` : match.challenged.name;

    const message = `🔥 *CHALLENGE ACCEPTED*

━━━━━━━━━━━━━━━━━━━━━
⚔️ *BATTLE BEGINS*
━━━━━━━━━━━━━━━━━━━━━

🚀 *Challenger:* ${challengerDisplay}
🎯 *Accepted by:* ${challengedDisplay}
💰 *Stakes:* ${this.formatAmount(match.stake_amount, match.tokenSymbol || match.token_symbol)} each
${match.category ? `${categoryEmoji} *Category:* ${match.category.charAt(0).toUpperCase() + match.category.slice(1)}` : ''}

🍿 *The battle is ON! May the best player win!*

━━━━━━━━━━━━━━━━━━━━━

#BetChat #MatchMade #Battle #${match.category || 'Challenge'}`;

    return message;
  }

  // Format leaderboard update message for Telegram
  private formatLeaderboardMessage(update: LeaderboardBroadcast): string {
    const userDisplay = update.user.username ? `@${update.user.username}` : update.user.name;

    const rankEmoji = update.new_rank <= 3 ?
      (update.new_rank === 1 ? '🥇' : update.new_rank === 2 ? '🥈' : '🥉') : '🏅';

    const changeEmoji = update.old_rank ?
      (update.new_rank < update.old_rank ? '📈' : update.new_rank > update.old_rank ? '📉' : '➡️') : '⭐';

    const changeText = update.old_rank ?
      (update.new_rank < update.old_rank ?
        `climbed from #${update.old_rank} to #${update.new_rank}` :
        update.new_rank > update.old_rank ?
        `dropped from #${update.old_rank} to #${update.new_rank}` :
        `maintained #${update.new_rank}`) :
      `entered the leaderboard at #${update.new_rank}`;

    const message = `${rankEmoji} *LEADERBOARD UPDATE*

━━━━━━━━━━━━━━━━━━━━━
${changeEmoji} *RANK CHANGE*
━━━━━━━━━━━━━━━━━━━━━

👤 *Player:* ${userDisplay}
${rankEmoji} *New Rank:* #${update.new_rank}
${changeEmoji} *${userDisplay}* ${changeText}

📊 *Stats:*
🏆 *Total Wins:* ${update.total_wins}
💰 *Total Earnings:* ${this.formatAmount(update.total_earnings)}
${update.achievement ? `🎯 *Achievement:* ${update.achievement}` : ''}

━━━━━━━━━━━━━━━━━━━━━
🏆 *Climb the ranks and dominate!*
━━━━━━━━━━━━━━━━━━━━━

#BetChat #Leaderboard #Ranking #Champion`;

    return message;
  }

  // Format challenge awaiting participants message
  private formatChallengeAwaitingMessage(challenge: ChallengeAwaitingBroadcast): string {
    const creatorDisplay = challenge.creator.username ? `@${challenge.creator.username}` : challenge.creator.name;
    const message = `⏳ *AWAITING PARTICIPANTS*

━━━━━━━━━━━━━━━━━━━━━
${challenge.title}
━━━━━━━━━━━━━━━━━━━━━

👤 *Creator:* ${creatorDisplay}
💰 *Stake:* ${this.formatAmount(challenge.stake_amount, challenge.tokenSymbol || challenge.token_symbol)}
⏱ *Waiting for challenger...*

${challenge.category ? `📂 *Category:* ${challenge.category}` : ''}

━━━━━━━━━━━━━━━━━━━━━
🔗 [*JOIN CHALLENGE*](https://${(process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '')}/challenges/${challenge.challengeId})
━━━━━━━━━━━━━━━━━━━━━

#BetChat #Challenge #LookingForOpponent`;

    return message;
  }

  // Format challenge joined message
  private formatChallengeJoinedMessage(join: ChallengeJoinedBroadcast): string {
    const joinerDisplay = join.joiner.username ? `@${join.joiner.username}` : join.joiner.name;
    const message = `✅ *CHALLENGE JOINED*

━━━━━━━━━━━━━━━━━━━━━
${join.title}
━━━━━━━━━━━━━━━━━━━━━

👤 *New Participant:* ${joinerDisplay}
👥 *Total Participants:* ${join.participant_count}
💰 *Stake:* ${this.formatAmount(join.stake_amount, join.tokenSymbol || join.token_symbol)}

${join.category ? `📂 *Category:* ${join.category}` : ''}

━━━━━━━━━━━━━━━━━━━━━

#BetChat #Challenge #PlayerJoined`;

    return message;
  }

  // Format participant count update message
  private formatParticipantCountMessage(update: ChallengeParticipantCountBroadcast): string {
    const message = `👥 *PARTICIPANT UPDATE*

━━━━━━━━━━━━━━━━━━━━━
${update.title}
━━━━━━━━━━━━━━━━━━━━━

👥 *Current:* ${update.current_participants}${update.max_participants ? `/${update.max_participants}` : ''}

${update.category ? `📂 *Category:* ${update.category}` : ''}

━━━━━━━━━━━━━━━━━━━━━

#BetChat #Challenge #Update`;

    return message;
  }

  // Format bonus added message
  private formatBonusAddedMessage(bonus: ChallengeBonusAddedBroadcast): string {
    const bonusLabel = bonus.bonus_type === 'early_join' ? '⏰ Early Join Bonus' :
                       bonus.bonus_type === 'underdog' ? '📈 Underdog Boost' :
                       '🔥 Imbalance Bonus';

    const message = `🎁 *BONUS ACTIVATED*

━━━━━━━━━━━━━━━━━━━━━
${bonus.title}
━━━━━━━━━━━━━━━━━━━━━

${bonusLabel}
💥 *Multiplier:* ${bonus.bonus_multiplier}x

${bonus.category ? `📂 *Category:* ${bonus.category}` : ''}

⚡ *Bonus is LIVE! Grab the opportunity!*

━━━━━━━━━━━━━━━━━━━━━

#BetChat #Challenge #Bonus`;

    return message;
  }

  // Send message to Telegram channel
  private async sendToChannel(
    message: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      console.log(`🔍 Attempting to send message to channel: ${this.channelId}`);

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: this.channelId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });

      if (response.data.ok) {
        console.log('📤 Message sent to Telegram channel successfully');
        return true;
      } else {
        console.error('❌ Failed to send to Telegram:');
        console.error('Channel ID:', this.channelId);
        console.error('Error:', response.data);

        if (response.data.error_code === 400 && response.data.description?.includes('chat not found')) {
          console.error('🚨 TELEGRAM SETUP ISSUE:');
          console.error('   1. Check if TELEGRAM_CHANNEL_ID is correct');
          console.error('   2. Ensure bot is added to the channel as admin');
          console.error('   3. Channel ID should start with -100 for channels or @ for usernames');
        }

        return false;
      }
    } catch (error) {
      console.error('❌ Error sending to Telegram channel:', error);
      if (axios.isAxiosError(error)) {
        console.error('Response status:', error.response?.status);
        console.error('Response data:', error.response?.data);
      }
      return false;
    }
  }

  private async sendHtmlToChannel(
    message: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      console.log(`ðŸ” Attempting to send HTML message to channel: ${this.channelId}`);

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: this.channelId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });

      if (response.data.ok) {
        console.log('ðŸ“¤ HTML message sent to Telegram channel successfully');
        return true;
      }

      console.error('âŒ Failed to send HTML message to Telegram:');
      console.error('Channel ID:', this.channelId);
      console.error('Error:', response.data);
      return false;
    } catch (error) {
      console.error('âŒ Error sending HTML message to Telegram channel:', error);
      if (axios.isAxiosError(error)) {
        console.error('Response status:', error.response?.status);
        console.error('Response data:', error.response?.data);
      }
      return false;
    }
  }

  // Send photo with caption to Telegram channel
  private async sendPhotoToChannel(
    photoUrl: string,
    caption: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      console.log(`🔍 Attempting to send photo to channel: ${this.channelId}`);

      const response = await axios.post(`${this.baseUrl}/sendPhoto`, {
        chat_id: this.channelId,
        photo: photoUrl,
        caption: caption,
        parse_mode: 'Markdown',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });

      if (response.data.ok) {
        console.log('📸 Photo sent to Telegram channel successfully');
        return true;
      } else {
        console.error('❌ Failed to send photo to Telegram:');
        console.error('Channel ID:', this.channelId);
        console.error('Error:', response.data);
        // Fallback to text message if photo fails
        return await this.sendToChannel(caption, replyMarkup);
      }
    } catch (error) {
      console.error('❌ Error sending photo to Telegram channel:', error);
      if (axios.isAxiosError(error)) {
        console.error('Response status:', error.response?.status);
        console.error('Response data:', error.response?.data);
      }
      // Fallback to text message if photo fails
      return await this.sendToChannel(caption, replyMarkup);
    }
  }

  // Broadcast new event
  async broadcastEvent(event: EventBroadcast): Promise<boolean> {
    try {
      const message = this.formatEventMessage(event);
      return await this.sendToChannel(message);
    } catch (error) {
      console.error('❌ Error broadcasting event:', error);
      return false;
    }
  }

  // Broadcast new challenge (with photo support for admin challenges)
  async broadcastChallenge(challenge: ChallengeBroadcast): Promise<boolean> {
    try {
      const message = this.formatChallengeMessage(challenge);
      let sent = false;
      // If challenge has an image (admin challenge), send as photo with caption
      if (challenge.imageUrl) {
        sent = await this.sendPhotoToChannel(challenge.imageUrl, message);
      } else {
        // Otherwise send as text message
        sent = await this.sendToChannel(message);
      }
      if (sent) {
        await recordBantahBroTelegramPost({
          id: `telegram-challenge-${challenge.id}`,
          content: message,
          market: challenge.title,
          marketEmoji: '🏟',
          tags: ['BantahBro', 'Challenge'],
          url: typeof challenge.id !== 'undefined' ? `/challenges/${challenge.id}/activity` : undefined,
        });
      }
      return sent;
    } catch (error) {
      console.error('❌ Error broadcasting challenge:', error);
      return false;
    }
  }

  // Send custom message to channel
  async sendCustomMessage(message: string): Promise<boolean> {
    try {
      return await this.sendToChannel(message);
    } catch (error) {
      console.error('❌ Error sending custom message:', error);
      return false;
    }
  }

  async sendCustomHtmlMessage(
    message: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      return await this.sendHtmlToChannel(message, replyMarkup);
    } catch (error) {
      console.error('Error sending custom HTML message:', error);
      return false;
    }
  }

  private buildBantahBroAlertReplyMarkup(
    alert: BantahBroAlert,
    analysis?: BantahBroTokenAnalysis | null,
  ) {
    const rows: Array<Array<Record<string, unknown>>> = [];
    const marketMode = alert.type === 'runner_alert' ? 'runner' : 'rug';

    if (alert.market?.url) {
      rows.push([
        {
          text: '🏟 View market',
          url: alert.market.url,
        },
      ]);
    } else {
      rows.push([
        {
          text: alert.type === 'runner_alert' ? '🚀 Open runner market' : '⚠️ Open rug market',
          callback_data: `bb|market|${alert.id}|${marketMode}`,
        },
      ]);
    }

    const secondaryRow: Array<Record<string, unknown>> = [];
    secondaryRow.push({
      text: '🔎 Open scan',
      url: buildBantahBroTokenScanUrl(alert.chainId, alert.tokenAddress),
    });
    if (analysis?.primaryPair?.url) {
      secondaryRow.push({
        text: '📊 View chart',
        url: analysis.primaryPair.url,
      });
    }
    secondaryRow.push({
      text: '😎 Open BantahBro',
      url: buildBantahBroAgentsUrl(),
    });
    rows.push(secondaryRow);

    return {
      inline_keyboard: rows,
    };
  }

  async broadcastBantahBroAlert(
    alert: BantahBroAlert,
    analysis?: BantahBroTokenAnalysis | null,
  ): Promise<boolean> {
    try {
      const { text } = buildBantahBroTelegramAlertMessage(alert, analysis);
      const replyMarkup = this.buildBantahBroAlertReplyMarkup(alert, analysis);
      const alertBannerPath = this.isBantahBroMarketAlert(alert)
        ? this.resolveBantahBroMarketAlertBannerPath() || this.resolveBantahBroAlertBannerPath()
        : this.resolveBantahBroAlertBannerPath();
      let sent = false;

      if (alertBannerPath) {
        if (text.length <= 1000) {
          const sentPhoto = await this.sendPhotoPathToChannel(alertBannerPath, text, replyMarkup);
          if (sentPhoto) sent = true;
        } else {
          const sentPhoto = await this.sendPhotoPathToChannel(
            alertBannerPath,
            this.isBantahBroMarketAlert(alert)
              ? '🏟 BantahBro market alert incoming. Full market card below.'
              : '🚨 BantahBro alert incoming. Full scan below.',
          );
          if (sentPhoto) {
            sent = await this.sendToChannel(text, replyMarkup);
          }
        }
      }

      if (!sent) {
        sent = await this.sendToChannel(text, replyMarkup);
      }
      if (sent) {
        await recordBantahBroTelegramPost({
          id: `telegram-alert-${alert.id}`,
          content: text,
          market: alert.market?.url ? alert.headline : undefined,
          marketEmoji: alert.market?.url ? '🎯' : undefined,
          tags: alert.tokenSymbol ? [alert.tokenSymbol, alert.type, 'BantahBro'] : [alert.type, 'BantahBro'],
          url: alert.market?.url || undefined,
        });
      }

      return sent;
    } catch (error) {
      console.error('❌ Error broadcasting BantahBro alert:', error);
      return false;
    }
  }

  async broadcastBantahBroReceipt(
    receipt: BantahBroReceipt,
  ): Promise<boolean> {
    try {
      const text = buildBantahBroTelegramReceiptMessage(receipt);
      const replyMarkup = {
        inline_keyboard: [
          [
            receipt.market?.url
              ? {
                  text: '🏟 View market',
                  url: receipt.market.url,
                }
              : {
                  text: '😎 Open BantahBro',
                  url: buildBantahBroAgentsUrl(),
                },
          ],
        ],
      };
      const sent = await this.sendToChannel(text, replyMarkup);
      if (sent) {
        await recordBantahBroTelegramPost({
          id: `telegram-receipt-${receipt.id}`,
          content: text,
          market: receipt.market?.url ? receipt.headline : undefined,
          marketEmoji: receipt.market?.url ? '🧾' : undefined,
          tags: receipt.tokenSymbol
            ? [receipt.tokenSymbol, receipt.status, 'Receipt', 'BantahBro']
            : [receipt.status, 'Receipt', 'BantahBro'],
          url: receipt.market?.url || undefined,
        });
      }
      return sent;
    } catch (error) {
      console.error('❌ Error broadcasting BantahBro receipt:', error);
      return false;
    }
  }

  private buildBantahBroAgentBattleTelegramMessage(battle: BantahBroAgentBattle) {
    const [left, right] = battle.sides;
    const leftSymbol = this.battleSideSymbol(left);
    const rightSymbol = this.battleSideSymbol(right);
    const leader = battle.leadingSideId === left.id ? left : right;
    const trailer = leader.id === left.id ? right : left;
    const battleUrl = buildBantahBroBattlesUrl(battle.id);
    const updatedAt = new Date(battle.updatedAt).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const sideLine = (side: BantahBroAgentBattleSide) => {
      const symbol = this.battleSideSymbol(side);
      const leadLabel = side.id === leader.id ? " | LEADING" : "";
      return [
        `<b>${this.escapeHtml(symbol)}</b>${leadLabel}`,
        `Price ${this.escapeHtml(this.formatCompactPrice(side.priceUsd))}`,
        `5M ${this.escapeHtml(this.formatSignedPercent(side.priceChangeM5))}`,
        `24H ${this.escapeHtml(this.formatSignedPercent(side.priceChangeH24))}`,
        `Vol ${this.escapeHtml(this.formatCompactUsd(side.volumeH24))}`,
        `Liq ${this.escapeHtml(this.formatCompactUsd(side.liquidityUsd))}`,
        `Confidence ${side.confidence}%`,
      ].join(" · ");
    };

    const html = [
      "⚔️ <b>LIVE AGENT BATTLE</b>",
      `<b>${this.escapeHtml(leftSymbol)}</b> vs <b>${this.escapeHtml(rightSymbol)}</b>`,
      `Round: 3 min · Ends in <b>${this.escapeHtml(this.formatBattleDuration(battle.timeRemainingSeconds))}</b> · Updated ${this.escapeHtml(updatedAt)}`,
      "",
      `🔥 ${sideLine(left)}`,
      `😈 ${sideLine(right)}`,
      "",
      `<b>Live score:</b> ${left.confidence}% ${this.escapeHtml(leftSymbol)} / ${right.confidence}% ${this.escapeHtml(rightSymbol)}`,
      `<b>Momentum:</b> ${this.escapeHtml(leader.label)} is ahead by ${battle.confidenceSpread}%. ${this.escapeHtml(trailer.label)} needs fresh volume to flip it.`,
      "",
      "Data: Dexscreener live market windows. P2P prediction arena, not a token buy signal.",
    ].join("\n");

    const plain = [
      "LIVE AGENT BATTLE",
      `${leftSymbol} vs ${rightSymbol}`,
      `Round: 3 min | Ends in ${this.formatBattleDuration(battle.timeRemainingSeconds)} | Updated ${updatedAt}`,
      "",
      `${leftSymbol}: price ${this.formatCompactPrice(left.priceUsd)} | 5M ${this.formatSignedPercent(left.priceChangeM5)} | 24H ${this.formatSignedPercent(left.priceChangeH24)} | vol ${this.formatCompactUsd(left.volumeH24)} | confidence ${left.confidence}%`,
      `${rightSymbol}: price ${this.formatCompactPrice(right.priceUsd)} | 5M ${this.formatSignedPercent(right.priceChangeM5)} | 24H ${this.formatSignedPercent(right.priceChangeH24)} | vol ${this.formatCompactUsd(right.volumeH24)} | confidence ${right.confidence}%`,
      "",
      `Live score: ${left.confidence}% ${leftSymbol} / ${right.confidence}% ${rightSymbol}`,
      "Data: Dexscreener live market windows.",
    ].join("\n");

    const chartButtons = [left, right]
      .filter((side) => Boolean(side.pairUrl))
      .map((side) => ({
        text: `Chart ${this.battleSideSymbol(side).slice(0, 20)}`,
        url: side.pairUrl as string,
      }));

    return {
      html,
      plain,
      battleUrl,
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "Open Battle Arena",
              url: battleUrl,
            },
          ],
          ...(chartButtons.length > 0 ? [chartButtons.slice(0, 2)] : []),
        ],
      },
    };
  }

  async broadcastBantahBroAgentBattle(
    battle: BantahBroAgentBattle,
    options: { broadcastId?: string } = {},
  ): Promise<boolean> {
    try {
      const { html, plain, battleUrl, replyMarkup } =
        this.buildBantahBroAgentBattleTelegramMessage(battle);
      const sent = await this.sendHtmlToChannel(html, replyMarkup);

      if (sent) {
        const [left, right] = battle.sides;
        await recordBantahBroTelegramPost({
          id: options.broadcastId || `telegram-agent-battle-${battle.id}-${battle.startsAt}`,
          content: plain,
          market: battle.title,
          marketEmoji: "⚔️",
          tags: [
            left.tokenSymbol || left.label,
            right.tokenSymbol || right.label,
            "AgentBattle",
            "Dexscreener",
            "BantahBro",
          ],
          url: battleUrl,
        });
      }

      return sent;
    } catch (error) {
      console.error('❌ Error broadcasting BantahBro agent battle:', error);
      return false;
    }
  }

  private buildBotaAgentChallengeTelegramMessage(challenge: any) {
    // Assuming challenge has .challengerAgent and .opponentAgent
    const c1 = challenge.challengerAgent?.name || 'Unknown Agent';
    const c2 = challenge.opponentAgent?.name || 'Unknown Opponent';
    const amount = challenge.stakeAmount || 0;
    
    // Different text based on status
    let html = '';
    let plain = '';
    let url = challenge.challengeUrl || 'https://bota.bantah.fun/challenges';
    let replyMarkup: any = undefined;

    if (challenge.status === 'pending') {
      html = `⚔️ <b>NEW CHALLENGE INITIATED!</b>\n\n<b>${c1}</b> has challenged <b>${c2}</b> for <b>${amount} BC</b>!\n\n<a href="${url}">Will they accept or dodge?</a>`;
      plain = `⚔️ NEW CHALLENGE INITIATED!\n\n${c1} has challenged ${c2} for ${amount} BC!\n\nWill they accept or dodge? ${url}`;
      replyMarkup = {
        inline_keyboard: [[
          { text: "🔥 View Challenge", url: url }
        ]]
      };
    } else if (challenge.status === 'cancelled' || challenge.status === 'expired') {
      html = `🫡 <b>CHALLENGE DODGED!</b>\n\nThe challenge against <b>${c2}</b> has expired/declined. Nobody wants to be the visible dodger.`;
      plain = `🫡 CHALLENGE DODGED!\n\nThe challenge against ${c2} has expired/declined. Nobody wants to be the visible dodger.`;
    } else if (challenge.status === 'scheduled' || challenge.status === 'live') {
      html = `🔥 <b>CHALLENGE ACCEPTED!</b>\n\n<b>${c2}</b> accepted the challenge from <b>${c1}</b> for <b>${amount} BC</b>! The battle is on.`;
      plain = `🔥 CHALLENGE ACCEPTED!\n\n${c2} accepted the challenge from ${c1} for ${amount} BC! The battle is on.`;
    }

    return { html, plain, url, replyMarkup };
  }

  async broadcastBotaAgentChallenge(
    challenge: any,
    options: { broadcastId?: string } = {},
  ): Promise<boolean> {
    try {
      const { html, plain, url, replyMarkup } =
        this.buildBotaAgentChallengeTelegramMessage(challenge);
      
      if (!html) return false;

      const sent = await this.sendHtmlToChannel(html, replyMarkup);

      if (sent) {
        await recordBantahBroTelegramPost({
          id: options.broadcastId || `telegram-challenge-${challenge.id}-${challenge.status}`,
          content: plain,
          market: `Challenge: ${challenge.challengerAgent?.name} vs ${challenge.opponentAgent?.name}`,
          marketEmoji: "⚔️",
          tags: ["Challenge", "BantahBro", "PvP"],
          url: url,
        });
      }

      return sent;
    } catch (error) {
      console.error('❌ Error broadcasting BOTA challenge:', error);
      return false;
    }
  }

  // Broadcast challenge result (win/loss)
  async broadcastChallengeResult(result: ChallengeResultBroadcast): Promise<boolean> {
    try {
      const message = this.formatChallengeResultMessage(result);
      return await this.sendToChannel(message);
    } catch (error) {
      console.error('❌ Error broadcasting challenge result:', error);
      return false;
    }
  }

  // Broadcast matchmaking (challenge accepted)
  async broadcastMatchmaking(match: MatchmakingBroadcast): Promise<boolean> {
    try {
      const message = this.formatMatchmakingMessage(match);
      return await this.sendToChannel(message);
    } catch (error) {
      console.error('❌ Error broadcasting matchmaking:', error);
      return false;
    }
  }

  // Broadcast leaderboard update
  async broadcastLeaderboardUpdate(update: LeaderboardBroadcast): Promise<boolean> {
    try {
      const message = this.formatLeaderboardMessage(update);
      return await this.sendToChannel(message);
    } catch (error) {
      console.error('❌ Error broadcasting leaderboard update:', error);
      return false;
    }
  }

  // Broadcast challenge awaiting participants (with photo support)
  async broadcastChallengeAwaiting(challenge: ChallengeAwaitingBroadcast): Promise<boolean> {
    try {
      const message = this.formatChallengeAwaitingMessage(challenge);
      // If challenge has an image, send as photo with caption
      if (challenge.imageUrl) {
        return await this.sendPhotoToChannel(challenge.imageUrl, message);
      }
      return await this.sendToChannel(message);
    } catch (error) {
      console.error('❌ Error broadcasting challenge awaiting:', error);
      return false;
    }
  }

  // Broadcast when someone joins a challenge (with photo support)
  async broadcastChallengeJoined(join: ChallengeJoinedBroadcast): Promise<boolean> {
    try {
      const message = this.formatChallengeJoinedMessage(join);
      // If challenge has an image, send as photo with caption
      if (join.imageUrl) {
        return await this.sendPhotoToChannel(join.imageUrl, message);
      }
      return await this.sendToChannel(message);
    } catch (error) {
      console.error('❌ Error broadcasting challenge joined:', error);
      return false;
    }
  }

  // Broadcast participant count updates
  async broadcastParticipantCountUpdate(update: ChallengeParticipantCountBroadcast): Promise<boolean> {
    try {
      const message = this.formatParticipantCountMessage(update);
      return await this.sendToChannel(message);
    } catch (error) {
      console.error('❌ Error broadcasting participant count update:', error);
      return false;
    }
  }

  // Broadcast when bonus is activated
  async broadcastBonusActivated(bonus: ChallengeBonusAddedBroadcast): Promise<boolean> {
    try {
      const message = this.formatBonusAddedMessage(bonus);
      return await this.sendToChannel(message);
    } catch (error) {
      console.error('❌ Error broadcasting bonus activated:', error);
      return false;
    }
  }

  // Get channel info
  async getChannelInfo(): Promise<any> {
    try {
      const response = await axios.get(`${this.baseUrl}/getChat`, {
        params: { chat_id: this.channelId }
      });

      if (response.data.ok) {
        return response.data.result;
      } else {
        console.error('❌ Failed to get channel info:', response.data);
        return null;
      }
    } catch (error) {
      console.error('❌ Error getting channel info:', error);
      return null;
    }
  }

  // Phase 1: Account Linking - Set up webhook
  async setupWebhook(webhookUrl: string): Promise<boolean> {
    try {
      this.webhookUrl = webhookUrl;
      await this.syncBantahBroProfile();
      const response = await axios.post(`${this.baseUrl}/setWebhook`, {
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query', 'inline_query', 'chosen_inline_result'],
      });

      if (response.data.ok) {
        console.log(`✅ ${this.label} webhook set up successfully`);
        console.log(`📡 Webhook URL: ${webhookUrl}`);
        return true;
      } else {
        console.error(`❌ Failed to set ${this.label} webhook:`, response.data);
        return false;
      }
    } catch (error) {
      console.error(`❌ Error setting up ${this.label} webhook:`, error);
      return false;
    }
  }

  async sendBantahBroBannerStartMessage(chatId: number, firstName: string): Promise<boolean> {
    const message = buildBantahBroTelegramWelcomeMessage(firstName);
    const replyMarkup = this.buildBantahBroStartReplyMarkup();
    const bannerPath = this.resolveBantahBroBannerPath();

    if (bannerPath) {
      const sentBanner = await this.sendPhotoMessage(chatId, bannerPath, message, replyMarkup);
      if (sentBanner) {
        return true;
      }
    }

    return await this.sendMessage(
      chatId,
      message,
      replyMarkup ? { reply_markup: replyMarkup } : undefined,
    );
  }

  // Simplified /start message - just open mini-app
  async sendStartMessage(chatId: number, firstName: string): Promise<boolean> {
    const message = buildBantahBroTelegramWelcomeMessage(firstName);
    const replyMarkup = this.buildBantahBroStartReplyMarkup();
    return await this.sendMessage(
      chatId,
      message,
      replyMarkup ? { reply_markup: replyMarkup } : undefined,
    );
    try {
      const miniAppUrl = (process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '');
      const miniAppFullUrl = `https://${miniAppUrl}/telegram-mini-app`;

      const message = `👋 *Welcome to Bantah, ${firstName}!*

━━━━━━━━━━━━━━━━━━━━━

🚀 Open the app below to:
✅ Create & accept challenges
✅ Manage your wallet
✅ Track your stats
✅ Get instant updates`;

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🎯 Open Bantah',
                web_app: { url: miniAppFullUrl }
              }
            ]
          ]
        }
      });

      return response.data.ok;
    } catch (error) {
      console.error('❌ Error sending start message:', error);
      return false;
    }
  }


  // Phase 1: Send /start response with login link (via mini-app)
  async sendLoginLink(chatId: number, firstName: string, linkToken: string): Promise<boolean> {
    try {
      const miniAppUrl = (process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '');
      const miniAppFullUrl = `https://${miniAppUrl}/telegram-mini-app`;

      const message = `👋 *Welcome to Bantah, ${firstName}!*

🔗 *Link Your Account*

To start using Bantah through Telegram, you need to link your Telegram account to your Bantah account.

Click the button below to securely link your account. You'll be able to:

✅ Create challenges from Telegram
✅ Accept challenges with one tap
✅ Get instant notifications
✅ View your balance and stats

🔒 *Secure & Private* - Your data is protected

#Bantah #GetStarted`;

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🔗 Link My Account',
                web_app: {
                  url: miniAppFullUrl
                }
              }
            ]
          ]
        }
      });

      if (response.data.ok) {
        console.log(`✅ Mini-app link sent to Telegram user ${chatId}`);
        return true;
      } else {
        console.error('❌ Failed to send mini-app link:', response.data);
        return false;
      }
    } catch (error) {
      console.error('❌ Error sending mini-app link:', error);
      return false;
    }
  }

  // Phase 1: Send account linked confirmation
  async sendAccountLinkedConfirmation(chatId: number, username: string, balance: number): Promise<boolean> {
    try {
      const message = `✅ *Account Linked Successfully!*

━━━━━━━━━━━━━━━━━━━━━
🎉 *Welcome to Bantah, @${username}!*
━━━━━━━━━━━━━━━━━━━━━

Your Telegram account is now linked to your Bantah account.

💰 *Current Balance:* ${this.formatAmount(balance)}

🎯 *What's Next?*
• Create challenges using /challenge
• Check your balance with /balance
• View active challenges with /mychallenges
• Get help anytime with /help

━━━━━━━━━━━━━━━━━━━━━
🔥 *You're all set! Let's start betting!*
━━━━━━━━━━━━━━━━━━━━━

#Bantah #Linked #Ready`;

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Return to Bot',
                url: `https://t.me/${this.username || ''}`
              },
              {
                text: 'Open Web Profile',
                url: `${process.env.FRONTEND_URL || ''}/profile`
              }
            ]
          ]
        }
      });

      return response.data.ok;
    } catch (error) {
      console.error('❌ Error sending confirmation:', error);
      return false;
    }
  }

  // Phase 2: Send challenge with inline accept buttons
  async sendChallengeAcceptCard(
    chatId: number,
      challenge: {
      id: number;
      title: string;
      description?: string;
      challenger: { name: string; username?: string };
      challenged: { name: string; username?: string };
      amount: number;
      tokenSymbol?: string;
      category?: string;
    }
  ): Promise<boolean> {
    try {
      const webAppUrl = (process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '');
      const challengeUrl = `https://${webAppUrl}/challenges/${challenge.id}`;

      const categoryEmoji = this.getCategoryEmoji(challenge.category || '');

      const message = `⚔️ *CHALLENGE RECEIVED*

━━━━━━━━━━━━━━━━━━━━━
${categoryEmoji} *${challenge.title}*
━━━━━━━━━━━━━━━━━━━━━

${challenge.description ? `💭 _${challenge.description}_\n` : ''}
🚀 *Challenger:* ${challenge.challenger.username ? `@${challenge.challenger.username}` : challenge.challenger.name}
🎯 *You've been challenged!*
💰 *Stake Amount:* ${this.formatAmount(challenge.amount, challenge.tokenSymbol)}
${challenge.category ? `${categoryEmoji} *Category:* ${challenge.category.charAt(0).toUpperCase() + challenge.category.slice(1)}` : ''}

⏰ *Quick Actions Below* ⬇️

━━━━━━━━━━━━━━━━━━━━━

#Bantah #Challenge #YourMove`;

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Accept Challenge',
                callback_data: `accept_${challenge.id}`
              }
            ],
            [
              {
                text: '💰 Deposit & Accept',
                url: `${challengeUrl}?action=deposit_accept`
              }
            ],
            [
              {
                text: '❌ Decline',
                callback_data: `decline_challenge_${challenge.id}`
              },
              {
                text: '👀 View Details',
                url: challengeUrl
              }
            ]
          ]
        }
      });

      return response.data.ok;
    } catch (error) {
      console.error('❌ Error sending challenge accept card:', error);
      return false;
    }
  }

  // Phase 2: Send challenge accepted confirmation
  async sendChallengeAcceptedConfirmation(
    chatId: number,
    challenge: {
      id: number;
      title: string;
      challenger: { name: string };
      challenged: { name: string };
      amount: number;
    }
  ): Promise<boolean> {
    try {
      const message = `🎯 *CHALLENGE ACCEPTED!*

━━━━━━━━━━━━━━━━━━━━━
⚔️ *${challenge.title}*
━━━━━━━━━━━━━━━━━━━━━

🔥 *The battle is ON!*

🚀 *${challenge.challenger.name}*
     vs
🎯 *${challenge.challenged.name}*

💰 *Stakes:* ${this.formatAmount(challenge.amount, challenge.tokenSymbol)} each
🔒 *Funds are now in escrow*

🍿 *May the best player win!*

━━━━━━━━━━━━━━━━━━━━━

#Bantah #MatchMade #LetsGo`;

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      });

      return response.data.ok;
    } catch (error) {
      console.error('❌ Error sending acceptance confirmation:', error);
      return false;
    }
  }

  // Phase 2: Send insufficient funds notification
  async sendInsufficientFundsNotification(
    chatId: number,
    requiredAmount: number,
    currentBalance: number
  ): Promise<boolean> {
    try {
      const webAppUrl = (process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '');
      const walletUrl = `https://${webAppUrl}/wallet`;

      const shortfall = requiredAmount - currentBalance;

      const message = `⚠️ *Insufficient Funds*

━━━━━━━━━━━━━━━━━━━━━
💰 *Current Balance:* ${this.formatAmount(currentBalance)}
📊 *Required:* ${this.formatAmount(requiredAmount)}
❌ *Shortfall:* ${this.formatAmount(shortfall)}
━━━━━━━━━━━━━━━━━━━━━

Please deposit funds to accept this challenge.

💡 *Tip:* Use the "Deposit & Accept" button to fund your wallet and accept in one step!`;

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '💰 Add Funds',
                url: walletUrl
              }
            ]
          ]
        }
      });

      return response.data.ok;
    } catch (error) {
      console.error('❌ Error sending insufficient funds notification:', error);
      return false;
    }
  }

  // Helper: Get category emoji
  private getCategoryEmoji(category: string): string {
    const categoryMap: { [key: string]: string } = {
      'crypto': '₿',
      'sports': '⚽',
      'gaming': '🎮',
      'music': '🎵',
      'politics': '🏛️',
      'entertainment': '🎬',
      'tech': '💻',
      'science': '🔬',
      'trading': '📈',
      'fitness': '🏃',
      'skill': '🧠'
    };
    return categoryMap[category?.toLowerCase()] || '⚔️';
  }

  // Phase 1: Send error message
  async sendErrorMessage(chatId: number, errorType: 'link_expired' | 'already_linked' | 'general'): Promise<boolean> {
    try {
      let message = '';

      switch (errorType) {
        case 'link_expired':
          message = `⚠️ *Link Expired*

Your login link has expired for security reasons.

Please use /start to get a new link.`;
          break;
        case 'already_linked':
          message = `✅ *Already Linked*

Your Telegram account is already linked to a Bantah account.

Use /help to see available commands.`;
          break;
        default:
          message = `❌ *Error Occurred*

Something went wrong. Please try again or contact support.

Use /start to try linking again.`;
      }

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      });

      return response.data.ok;
    } catch (error) {
      console.error('❌ Error sending error message:', error);
      return false;
    }
  }

  // Phase 2: Send quick-access menu with mini-app buttons
  async sendQuickAccessMenu(chatId: number, username: string): Promise<boolean> {
    try {
      const miniAppUrl = (process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '');
      const baseUrl = `https://${miniAppUrl}/telegram-mini-app`;

      const message = `👋 *Welcome to Bantah, @${username}!*

━━━━━━━━━━━━━━━━━━━━━

🔥 *Quick Access*

Use the buttons below to jump straight into your favorite features:`;

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '💰 Wallet',
                web_app: { url: `${baseUrl}?tab=wallet` }
              },
              {
                text: '👤 Profile',
                web_app: { url: `${baseUrl}?tab=profile` }
              }
            ],
            [
              {
                text: '⚔️ Challenges',
                web_app: { url: `${baseUrl}?tab=challenges` }
              },
              {
                text: '🎯 Create New',
                url: `${baseUrl}?action=create`
              }
            ]
          ]
        }
      });

      return response.data.ok;
    } catch (error) {
      console.error('❌ Error sending quick access menu:', error);
      return false;
    }
  }

  // Send balance notification with wallet button
  async sendBalanceNotification(chatId: number, balance: number, coins: number): Promise<boolean> {
    try {
      const miniAppUrl = (process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '');
      const walletUrl = `https://${miniAppUrl}/telegram-mini-app?tab=wallet`;

      const message = `💰 *Your Wallet*

━━━━━━━━━━━━━━━━━━━━━
💵 Balance: ${this.formatAmount(balance)}
🪙 Coins: ${coins}
━━━━━━━━━━━━━━━━━━━━━`;

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '💳 Add Funds',
                web_app: { url: walletUrl }
              }
            ]
          ]
        }
      });

      return response.data.ok;
    } catch (error) {
      console.error('❌ Error sending balance notification:', error);
      return false;
    }
  }

  // Send challenges list with quick view button
  async sendChallengesNotification(chatId: number, challengeCount: number): Promise<boolean> {
    try {
      const miniAppUrl = (process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '');
      const challengesUrl = `https://${miniAppUrl}/telegram-mini-app?tab=challenges`;

      const message = `⚔️ *Your Challenges*

━━━━━━━━━━━━━━━━━━━━━
🔥 Active Challenges: ${challengeCount}
━━━━━━━━━━━━━━━━━━━━━

Tap below to view and manage your challenges!`;

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '👀 View All',
                web_app: { url: challengesUrl }
              },
              {
                text: '➕ Create New',
                callback_data: 'create_challenge'
              }
            ]
          ]
        }
      });

      return response.data.ok;
    } catch (error) {
      console.error('❌ Error sending challenges notification:', error);
      return false;
    }
  }

  // Polling for updates (alternative to webhooks)
  private pollingActive: boolean = false;
  private lastUpdateId: number = 0;
  private isRunning: boolean = false; // Added to track polling state

  async startPolling(): Promise<void> {
    if (this.pollingActive) {
      console.log('⚠️ Polling already active');
      return;
    }

    // Delete any existing webhook first
    try {
      await axios.post(`${this.baseUrl}/deleteWebhook`);
      console.log('🗑️ Deleted existing webhook for polling mode');
    } catch (error) {
      console.log('⚠️ Could not delete webhook:', error);
    }

    // Set up bot command menu
    if (this.isBantahBroBot()) {
      await this.syncBantahBroProfile();
    } else {
      await this.bot.setMyCommands([
        { command: 'start', description: '🔗 Link your Telegram account to Bantah' },
        { command: 'help', description: '📚 Show available commands and usage' },
        { command: 'balance', description: '👛 Check your wallet balance' },
        { command: 'mychallenges', description: '🏟 View your active challenges' },
        { command: 'challenge', description: '🎯 Create a new challenge' },
        { command: 'analyze', description: '🔎 BantahBro token scan' },
        { command: 'rug', description: '⚠️ BantahBro rug score' },
        { command: 'runner', description: '🚀 BantahBro runner score' },
        { command: 'alerts', description: '📣 Latest BantahBro alerts' },
        { command: 'markets', description: '🏟 Live BantahBro markets' },
        { command: 'create', description: '🎯 Create market from a token signal' },
        { command: 'bxbt', description: '🪙 BantahBro BXBT status' },
        { command: 'leaderboard', description: '🏆 View the global leaderboard' },
        { command: 'friends', description: '🤝 Manage your friends list' },
        { command: 'wallet', description: '👛 Access your wallet' }
      ]);
    }
    console.log('✅ Bot command menu configured');

    console.log('🔄 Starting Telegram bot polling...');
    
    // Set up message handlers before starting polling
    this.bot.on('message', async (msg) => {
      console.log('🎯 Message received:', msg.text, 'from', msg.from?.id);
      const update = { message: msg };
      await this.processUpdate(update);
    });

    this.bot.on('callback_query', async (query) => {
      await this.handleCallbackQuery(query);
    });

    this.bot.startPolling();
    this.isRunning = true;
    console.log('✅ Telegram bot polling started with message handlers');
  }

  async handleWebhookUpdate(update: any): Promise<void> {
    await this.processUpdate(update);

    if (update?.inline_query) {
      await this.handleInlineQuery(update.inline_query, axios);
    }

    if (update?.chosen_inline_result) {
      await this.handleChosenInlineResult(update.chosen_inline_result, axios);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.pollingActive) {
      try {
        const response = await axios.get(`${this.baseUrl}/getUpdates`, {
          params: {
            offset: this.lastUpdateId + 1,
            timeout: 30,
            allowed_updates: ['message', 'callback_query']
          },
          timeout: 35000
        });

        if (response.data.ok && response.data.result.length > 0) {
          for (const update of response.data.result) {
            this.lastUpdateId = update.update_id;
            await this.processUpdate(update);
          }
        }
      } catch (error: any) {
        if (error.code !== 'ECONNABORTED') {
          console.error('❌ Polling error:', error.message);
        }
        // Wait before retrying on error
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  private async processUpdate(update: any): Promise<void> {
    try {
      const message = update.message;
      if (message?.text) {
        const chatId = message.chat.id;
        const text = message.text;
        const firstName = message.from?.first_name || 'User';
        const telegramId = message.from?.id.toString();
        const startButtonAction = parseBantahBroTelegramStartButton(text);
        const isBantahBro = this.isBantahBroBot();

        console.log(`📨 Processing message: "${text}" from user ${telegramId}`);

        // Handle /start command - Always open mini-app
        if (text.startsWith('/start')) {
          console.log(`📱 Received /start from Telegram user ${chatId}`);
          await this.sendBantahBroBannerStartMessage(chatId, firstName);
          return;
        }

        // Handle /help command
        else if (text.startsWith('/help')) {
          await this.sendHelpMessage(chatId);
        }

        // Handle /balance command
        else if (text.startsWith('/balance')) {
          console.log(`📊 Received /balance from Telegram user ${telegramId}`);
          if (isBantahBro) {
            await this.handleBantahBroSharedPowerCommand(chatId, 'what is my wallet balance', telegramId!);
          } else {
            await this.handleBalanceCommand(chatId, telegramId!);
          }
        }

        // Handle /mychallenges command
        else if (text.startsWith('/mychallenges')) {
          console.log(`⚔️ Received /mychallenges from Telegram user ${telegramId}`);
          await this.handleMyChallengesCommand(chatId, telegramId!);
        }

        // Handle /challenge command
        else if (text.startsWith('/challenge')) {
          await this.handleChallengeCommand(chatId, text, telegramId!);
        }

        else if (text.startsWith('/analyze')) {
          await this.handleBantahBroAnalyzeCommand(chatId, text, 'auto');
        }

        else if (text.startsWith('/rug')) {
          await this.handleBantahBroAnalyzeCommand(chatId, text, 'rug');
        }

        else if (text.startsWith('/runner')) {
          await this.handleBantahBroAnalyzeCommand(chatId, text, 'runner');
        }

        else if (text.startsWith('/alerts')) {
          await this.handleBantahBroAlertsCommand(chatId);
        }

        else if (text.startsWith('/markets')) {
          await this.handleBantahBroMarketsCommand(chatId);
        }

        else if (text.startsWith('/create')) {
          await this.handleBantahBroCreateCommand(chatId, text);
        }

        else if (text.startsWith('/leaderboard')) {
          await this.handleBantahBroLeaderboardCommand(chatId);
        }

        else if (text.startsWith('/friends')) {
          await this.handleBantahBroFriendsCommand(chatId, telegramId!);
        }

        else if (text.startsWith('/bxbt')) {
          await this.handleBantahBroBxbtCommand(chatId);
        }

        else if (
          isBantahBro &&
          (
            text.startsWith('/wallet') ||
            text.startsWith('/discover') ||
            text.startsWith('/trending') ||
            text.startsWith('/battle') ||
            text.startsWith('/battles') ||
            text.startsWith('/buy') ||
            text.startsWith('/sell') ||
            text.startsWith('/swap') ||
            text.startsWith('/send') ||
            text.startsWith('/bridge') ||
            text.startsWith('/approve') ||
            text.startsWith('/revoke')
          )
        ) {
          await this.handleBantahBroSharedPowerCommand(chatId, text, telegramId!);
        }

        else if (startButtonAction === 'analyze' || startButtonAction === 'rug' || startButtonAction === 'runner') {
          await this.sendMessage(chatId, buildBantahBroTelegramStartButtonPrompt(startButtonAction));
        }

        else if (startButtonAction === 'alerts') {
          await this.handleBantahBroAlertsCommand(chatId);
        }

        else if (startButtonAction === 'markets') {
          await this.handleBantahBroMarketsCommand(chatId);
        }

        else if (startButtonAction === 'leaderboard') {
          await this.handleBantahBroLeaderboardCommand(chatId);
        }

        else if (isBantahBro && message.chat?.type === 'private') {
          await this.handleBantahBroSharedPowerCommand(chatId, text, telegramId!);
        }
      }

      // Handle callback queries (inline button clicks)
      if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      console.error('❌ Error processing update:', error);
    }
  }

  private async handleCallbackQuery(callbackQuery: any) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const telegramId = callbackQuery.from.id.toString();

    try {
      if (typeof data === 'string' && data.startsWith('bb|')) {
        const [, action, alertId, mode] = data.split('|');

        if (action === 'market') {
          const alert = getBantahBroAlert(alertId);
          if (!alert) {
            await this.bot.answerCallbackQuery(callbackQuery.id, {
              text: '📭 Alert not found',
              show_alert: true,
            });
            return;
          }

          const marketResult = await createBantahBroMarketFromSignal({
            sourceAlertId: alertId,
            durationHours: mode === 'runner' ? 24 : 6,
            stakeAmount: '10',
            currency: defaultBantahBroMarketCurrency(alert.chainId),
            sourcePlatform: 'telegram',
            chargeBxbt: String(process.env.BANTAHBRO_TELEGRAM_CHARGE_BXBT_MARKETS || '').trim().toLowerCase() === 'true',
          });

          await this.bot.answerCallbackQuery(callbackQuery.id, {
            text: '🎯 Market opened',
          });

          await this.sendMessage(
            chatId,
            `🎯 Market live.\n\n${marketResult.market.url}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🏟 View market',
                      url: marketResult.market.url,
                    },
                  ],
                ],
              },
            },
          );
          return;
        }

        if (action === 'receipt') {
          const alert = getBantahBroAlert(alertId);
          if (!alert) {
            await this.bot.answerCallbackQuery(callbackQuery.id, {
              text: '📭 Alert not found',
              show_alert: true,
            });
            return;
          }

          const analysis = await analyzeToken({
            chainId: alert.chainId,
            tokenAddress: alert.tokenAddress,
          });
          const existingReceipt = getBantahBroReceiptBySourceAlert(alertId);
          const receipt = existingReceipt || publishBantahBroReceipt(buildReceiptFromAlert(alert, analysis));

          await this.bot.answerCallbackQuery(callbackQuery.id, {
            text: 'Receipt updated',
          });
          await this.sendMessage(chatId, buildBantahBroTelegramReceiptMessage(receipt));
          return;
        }
      }

      const [action, challengeId] = data.split('_');

      if (action === 'accept' || action === 'decline') {
        const user = await storage.getUserByTelegramId(telegramId);
        if (!user) {
          await this.bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ Account not linked',
            show_alert: true,
          });
          return;
        }

        const [challenge] = await db
          .select()
          .from(schema.challenges)
          .where(eq(schema.challenges.id, challengeId))
          .limit(1);

        if (!challenge || challenge.status !== 'pending') {
          await this.bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ Challenge no longer available',
            show_alert: true,
          });
          return;
        }

        if (action === 'accept') {
          await db
            .update(schema.challenges)
            .set({ status: 'active' })
            .where(eq(schema.challenges.id, challengeId));

          await this.bot.editMessageText(
            '✅ Challenge accepted! Good luck!',
            {
              chat_id: chatId,
              message_id: callbackQuery.message.message_id,
            }
          );

          // Notify creator
          const creatorChatId = await TelegramLinkingService.getTelegramChatIdByUserId(challenge.creatorId);
          if (creatorChatId) {
            await this.bot.sendMessage(
              creatorChatId,
              `✅ @${user.username} accepted your challenge!`
            );
          }
        } else {
          await db
            .update(schema.challenges)
            .set({ status: 'declined' })
            .where(eq(schema.challenges.id, challengeId));

          await this.bot.editMessageText(
            '❌ Challenge declined',
            {
              chat_id: chatId,
              message_id: callbackQuery.message.message_id,
            }
          );

          // Notify creator
          const creatorChatId = await TelegramLinkingService.getTelegramChatIdByUserId(challenge.creatorId);
          if (creatorChatId) {
            await this.bot.sendMessage(
              creatorChatId,
              `❌ @${user.username} declined your challenge`
            );
          }
        }

        await this.bot.answerCallbackQuery(callbackQuery.id);
      }
    } catch (error) {
      console.error('Error handling callback query:', error);
      await this.bot.answerCallbackQuery(callbackQuery.id, {
        text: '❌ An error occurred',
        show_alert: true,
      });
    }
  }

  stopPolling(): void {
    this.pollingActive = false;
    console.log('🛑 Telegram bot polling stopped');
  }

  // Phase 3: Bot Commands

  private async sendHelpMessage(chatId: number): Promise<void> {
    await this.sendMessage(chatId, buildBantahBroTelegramHelp());
    return;
    const message = `🎮 *Bantah Bot Commands*

━━━━━━━━━━━━━━━━━━━━━

📋 *Available Commands:*

/start - Link your Telegram account
/help - Show this help message
/balance - Check your wallet balance
/mychallenges - View your active challenges
/challenge - Create a new challenge

━━━━━━━━━━━━━━━━━━━━━

💡 *How to create a challenge:*
\`/challenge @username 1000 Who wins the game?\`

Format: /challenge @opponent amount title

━━━━━━━━━━━━━━━━━━━━━

🔗 Need more? Visit the web app for full features!`;

    await this.sendMessage(chatId, message);
  }

  private async handleBantahBroSharedPowerCommand(
    chatId: number,
    text: string,
    telegramId: string,
  ): Promise<boolean> {
    const tool =
      /^\/wallet\b/i.test(text)
        ? 'wallet'
        : /^\/discover\b|^\/trending\b/i.test(text)
          ? 'discover'
          : /^\/battle\b|^\/battles\b/i.test(text)
            ? 'battle'
            : /^\/analyze\b/i.test(text)
              ? 'analyze'
              : /^\/rug\b/i.test(text)
                ? 'rug'
                : /^\/runner\b/i.test(text)
                  ? 'runner'
                  : null;
    const linkedUser = telegramId ? await storage.getUserByTelegramId(telegramId).catch(() => null) : null;
    const surfaceReply = await maybeHandleBantahBroCommandSurface({
      text,
      tool,
      source: 'telegram',
      actor: linkedUser
        ? {
            userId: linkedUser.id,
            username: linkedUser.username || null,
            firstName: linkedUser.firstName || null,
            walletAddress: (linkedUser as any).primaryWalletAddress || null,
          }
        : null,
    });

    if (!surfaceReply) {
      return false;
    }

    const inlineButtons = surfaceReply.links
      .slice(0, 2)
      .map((link) => ({ text: link.label, url: link.url }));

    await this.sendMessage(
      chatId,
      surfaceReply.reply,
      inlineButtons.length > 0
        ? {
            reply_markup: {
              inline_keyboard: [inlineButtons],
            },
          }
        : undefined,
    );

    return true;
  }

  private async sendNotLinkedMessage(chatId: number): Promise<void> {
    const message = `⚠️ *Account Not Linked*

You need to link your Telegram account to use this command.

Type /start to link your account first!`;

    await this.sendMessage(chatId, message);
  }

  private async handleBalanceCommand(chatId: number, telegramId: string): Promise<void> {
    try {
      const user = await storage.getUserByTelegramId(telegramId);
      if (!user) {
        const message = `💰 *Your Wallet*

No account linked yet. Open the mini-app to get started!`;
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        return;
      }

      const balance = await storage.getUserBalance(user.id);
      await this.sendBalanceNotification(chatId, parseInt(balance.balance || '0'), balance.coins || 0);
    } catch (error) {
      console.error('Error getting balance:', error);
      await this.bot.sendMessage(chatId, '❌ Failed to fetch balance. Try again in the mini-app.');
    }
  }

  private async handleMyChallengesCommand(chatId: number, telegramId: string): Promise<void> {
    try {
      const user = await storage.getUserByTelegramId(telegramId);
      if (!user) {
        const message = `⚔️ *Your Challenges*

No account linked yet. Open the mini-app to get started!`;
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        return;
      }

      const challenges = await storage.getChallenges(user.id, 10);
      const activeChallenges = challenges.filter((c: any) => c.status === 'active' || c.status === 'pending');
      
      await this.sendChallengesNotification(chatId, activeChallenges.length);
    } catch (error) {
      console.error('Error getting challenges:', error);
      await this.bot.sendMessage(chatId, '❌ Failed to fetch challenges. Try again in the mini-app.');
    }
  }

  private async handleChallengeCommand(chatId: number, text: string, telegramId: string): Promise<void> {
    // Parse: /challenge @username amount title
    const parts = text.split(' ');
    if (parts.length < 4) {
      const message = `❌ *Invalid Format*

Use: \`/challenge @username amount title\`

Example:
\`/challenge @john 1000 Who wins the match?\``;
      await this.sendMessage(chatId, message);
      return;
    }

    const opponentUsername = parts[1].replace('@', '');
    const amount = parseInt(parts[2]);
    const title = parts.slice(3).join(' ');

    if (isNaN(amount) || amount <= 0) {
      await this.sendMessage(chatId, '❌ Invalid amount. Please enter a valid number.');
      return;
    }

    // Check balance
    const creator = await storage.getUserByTelegramId(telegramId);
    if (!creator) {
      await this.sendMessage(chatId, '❌ Your account is not linked. Use /start to link your account.');
      return;
    }

    const currentBalance = Number.parseFloat(String((creator as any)?.balance ?? "0"));
    if (!Number.isFinite(currentBalance) || currentBalance < amount) {
      await this.sendMessage(
        chatId,
        `❌ Insufficient balance. You have ${this.formatAmount(
          Math.max(0, Number.isFinite(currentBalance) ? currentBalance : 0),
        )}`,
      );
      return;
    }

    // Find opponent
    const opponent = await storage.getUserByUsername(opponentUsername);
    if (!opponent) {
      await this.sendMessage(chatId, `❌ User @${opponentUsername} not found.`);
      return;
    }

    if (opponent.id === creator.id) {
      await this.sendMessage(chatId, `❌ You can't challenge yourself!`);
      return;
    }

    // Create challenge
    const challenge = await storage.createChallenge({
      title,
      description: `Challenge created via Telegram by @${creator.username}`,
      creatorId: creator.id,
      challengedId: opponent.id,
      stakeAmount: amount,
      status: 'pending',
      category: 'general'
    });

    const successMessage = `✅ *Challenge Created!*

━━━━━━━━━━━━━━━━━━━━━
🎯 *${title}*
━━━━━━━━━━━━━━━━━━━━━

👤 Challenger: @${creator.username || creator.firstName}
🎮 Opponent: @${opponentUsername}
💰 Stake: ${this.formatAmount(amount, challenge.tokenSymbol || challenge.token_symbol)}

📱 @${opponentUsername} will be notified to accept!`;

    await this.sendMessage(chatId, successMessage);

    // Notify opponent if they have Telegram linked (Phase 4)
    await this.notifyNewChallenge(opponent.id, creator, challenge, amount, title);
  }

  // Phase 4: Real-time Notifications

  async sendLinkedUserMessage(
    userId: string,
    text: string,
    options: TelegramBot.SendMessageOptions = {},
  ): Promise<boolean> {
    const chatId = await TelegramLinkingService.getTelegramChatIdByUserId(userId);
    if (!chatId) return false;

    try {
      await this.bot.sendMessage(chatId, text, options);
      return true;
    } catch (error) {
      console.error('Error sending linked user Telegram message:', error);
      return false;
    }
  }

  async notifyNewChallenge(opponentId: string, challenger: any, challenge: any, amount: number, title: string): Promise<void> {
    const { TelegramLinkingService } = await import('./telegramLinking');
    const opponentChatId = await TelegramLinkingService.getTelegramChatIdByUserId(opponentId);

    if (!opponentChatId) return;

    const webAppUrl = (process.env.FRONTEND_URL || process.env.REPLIT_DOMAINS?.split(',')[0] || 'https://betchat.replit.app').replace('https://', '');

    const message = `🎯 *New Challenge!*

━━━━━━━━━━━━━━━━━━━━━
📢 *${title}*
━━━━━━━━━━━━━━━━━━━━━

👤 *@${challenger.username || challenger.firstName}* challenges you!
💰 Stake: ${this.formatAmount(amount, challenge.tokenSymbol || challenge.token_symbol)}

Ready to accept?`;

    try {
      await this.bot.sendMessage(opponentChatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Accept', callback_data: `accept_${challenge.id}` },
              { text: '❌ Decline', callback_data: `decline_${challenge.id}` }
            ],
            [
              { text: '👀 View Details', url: `https://${webAppUrl}/challenges/${challenge.id}` }
            ]
          ]
        }
      });
      console.log(`📨 Challenge notification sent to user ${opponentId}`);
    } catch (error) {
      console.error('Error sending challenge notification:', error);
    }
  }

  async notifyChallengeAccepted(challengerId: string, opponent: any, challenge: any): Promise<void> {
    const { TelegramLinkingService } = await import('./telegramLinking');
    const challengerChatId = await TelegramLinkingService.getTelegramChatIdByUserId(challengerId);

    if (!challengerChatId) return;

    const message = `✅ *Challenge Accepted!*

━━━━━━━━━━━━━━━━━━━━━
🎯 *${challenge.title}*
━━━━━━━━━━━━━━━━━━━━━

🎮 *@${opponent.username || opponent.firstName}* accepted your challenge!
💰 Stake: ${this.formatAmount(Number(challenge.stakeAmount || 0), challenge.tokenSymbol || challenge.token_symbol)}
🏆 Total Pool: ${this.formatAmount(Number(challenge.stakeAmount || 0) * 2, challenge.tokenSymbol || challenge.token_symbol)}

Game on! 🔥`;

    await this.sendMessage(challengerChatId, message);
  }

  async notifyChallengeResult(userId: string, challenge: any, isWinner: boolean, payout: number): Promise<void> {
    const { TelegramLinkingService } = await import('./telegramLinking');
    const chatId = await TelegramLinkingService.getTelegramChatIdByUserId(userId);

    if (!chatId) return;

    const message = isWinner
      ? `🏆 *You Won!*

━━━━━━━━━━━━━━━━━━━━━
🎯 *${challenge.title}*
━━━━━━━━━━━━━━━━━━━━━

🎉 Congratulations!
💰 Winnings: ${this.formatAmount(payout, challenge.tokenSymbol || challenge.token_symbol)}

Keep the winning streak going! 🔥`
      : `😔 *Challenge Lost*

━━━━━━━━━━━━━━━━━━━━━
🎯 *${challenge.title}*
━━━━━━━━━━━━━━━━━━━━━

Better luck next time!
💡 Create a new challenge to win it back!`;

    await this.sendMessage(chatId, message);
  }

  async notifyPaymentReceived(userId: string, amount: number, newBalance: number): Promise<void> {
    const { TelegramLinkingService } = await import('./telegramLinking');
    const chatId = await TelegramLinkingService.getTelegramChatIdByUserId(userId);

    if (!chatId) return;

    const message = `💰 *Payment Received!*

━━━━━━━━━━━━━━━━━━━━━

✅ ${this.formatAmount(amount)} added to your wallet!
💵 New Balance: ${this.formatAmount(newBalance)}

Ready to place some bets? 🎯`;

    await this.sendMessage(chatId, message);
  }

  private async handleBantahBroAnalyzeCommand(
    chatId: number,
    text: string,
    mode: 'auto' | 'rug' | 'runner',
  ): Promise<void> {
    const tokenRef = parseBantahBroTelegramTokenCommand(text);
    if (!tokenRef) {
      await this.sendMessage(chatId, buildBantahBroTelegramHelp());
      return;
    }

    try {
      const scan = await runBantahBroSurfaceScan({
        query: tokenRef.tokenAddress,
        chainId: tokenRef.chainId,
      });
      if (!scan) {
        throw new Error('No live Rug Scorer result was returned for that token.');
      }
      const analysis = scan.analysis;
      const alert = publishBantahBroAlert(buildAlertFromAnalysis(analysis, mode));
      const { text: messageText, chartUrl, scanUrl } = buildBantahBroTelegramAlertMessage(alert, analysis);
      const systemAgent = await getBantahBroSystemAgentStatus().catch(() => null);

      await this.sendMessage(chatId, messageText, {
        disable_web_page_preview: false,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: alert.type === 'runner_alert' ? '🚀 Open runner market' : '⚠️ Open rug market',
                callback_data: `bb|market|${alert.id}|${alert.type === 'runner_alert' ? 'runner' : 'rug'}`,
              },
            ],
            [
              { text: '🔎 Open scan', url: scanUrl },
              ...(chartUrl ? [{ text: '📊 View chart', url: chartUrl }] : []),
              {
                text: '😎 Open BantahBro',
                url: buildBantahBroAgentUrl(systemAgent?.agentId),
              },
            ],
            [
              {
                text: '🧾 Receipt check',
                callback_data: `bb|receipt|${alert.id}|now`,
              },
            ],
          ],
        },
      });
    } catch (error) {
      await this.sendMessage(
        chatId,
        error instanceof Error ? `⚠️ Analyze failed.\n\n${error.message}` : '⚠️ Analyze failed.',
      );
    }
  }

  private async handleBantahBroAlertsCommand(chatId: number): Promise<void> {
    const alerts = listBantahBroAlerts(5);
    await this.sendMessage(chatId, buildBantahBroTelegramAlertsDigest(alerts));
  }

  private async handleBantahBroMarketsCommand(chatId: number): Promise<void> {
    const alerts = listBantahBroAlerts(10);
    await this.sendMessage(chatId, buildBantahBroTelegramMarketsDigest(alerts));
  }

  private async handleBantahBroCreateCommand(chatId: number, text: string): Promise<void> {
    const tokenRef = parseBantahBroTelegramTokenCommand(text);
    if (!tokenRef) {
      await this.sendMessage(
        chatId,
        '🎯 Usage:\n/create <token>\n/create <chain> <token>',
      );
      return;
    }

    try {
      const result = await createBantahBroMarketFromSignal({
        chainId: tokenRef.chainId,
        tokenAddress: tokenRef.tokenAddress,
        durationHours: 24,
        stakeAmount: '10',
        currency: defaultBantahBroMarketCurrency(tokenRef.chainId),
        sourcePlatform: 'telegram',
        chargeBxbt: String(process.env.BANTAHBRO_TELEGRAM_CHARGE_BXBT_MARKETS || '').trim().toLowerCase() === 'true',
      });

      await this.sendMessage(chatId, `🎯 Market live.\n\n${result.market.url}`, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🏟 View market',
                url: result.market.url,
              },
            ],
          ],
        },
      });
    } catch (error) {
      await this.sendMessage(
        chatId,
        error instanceof Error ? `⚠️ Create failed.\n\n${error.message}` : '⚠️ Create failed.',
      );
    }
  }

  private async handleBantahBroLeaderboardCommand(chatId: number): Promise<void> {
    try {
      const leaderboard = await getBantahBroLeaderboard(10);
      await this.sendMessage(chatId, buildBantahBroTelegramLeaderboardMessage(leaderboard.entries));
    } catch (error) {
      await this.sendMessage(
        chatId,
        error instanceof Error ? `⚠️ Leaderboard fetch failed.\n\n${error.message}` : '⚠️ Leaderboard fetch failed.',
      );
    }
  }

  private async handleBantahBroFriendsCommand(chatId: number, telegramId: string): Promise<void> {
    try {
      const user = await storage.getUserByTelegramId(telegramId);
      if (!user) {
        await this.sendMessage(
          chatId,
          '👥 Link your Telegram account first from Bantah, then /friends will show your circle.',
        );
        return;
      }

      const friends = await storage.getFriends(user.id);
      const normalizedFriends = friends.map((friend) => {
        const counterpart =
          friend.requesterId === user.id ? friend.addressee : friend.requester;
        return {
          username: counterpart?.username || null,
          firstName: counterpart?.firstName || null,
          connectedAt: friend.createdAt,
        };
      });
      await this.sendMessage(chatId, buildBantahBroTelegramFriendsMessage(normalizedFriends));
    } catch (error) {
      await this.sendMessage(
        chatId,
        error instanceof Error ? `⚠️ Friends fetch failed.\n\n${error.message}` : '⚠️ Friends fetch failed.',
      );
    }
  }

  private async handleBantahBroBxbtCommand(chatId: number): Promise<void> {
    try {
      const status = await getBantahBroBxbtStatus();
      await this.sendMessage(chatId, buildBantahBroTelegramBxbtMessage(status));
    } catch (error) {
      await this.sendMessage(
        chatId,
        error instanceof Error ? `⚠️ BXBT check failed.\n\n${error.message}` : '⚠️ BXBT check failed.',
      );
    }
  }

  private async sendMessage(
    chatId: number,
    text: string,
    options: TelegramBot.SendMessageOptions = {},
  ): Promise<boolean> {
    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        ...options,
      });
      return true;
    } catch (error) {
      console.error('Error sending message:', error);
      return false;
    }
  }

  // Handle inline queries for group challenges
  async handleInlineQuery(inlineQuery: any, apiClient: any): Promise<boolean> {
    try {
      const { id: inlineQueryId, query, from } = inlineQuery;
      const userId = from.id;

      // Get or create user for inline query
      let user = await db.query.users.findFirst({
        where: eq(schema.users.telegramId, userId.toString()),
      });

      if (!user) {
        // Create user from inline query context
        user = await db.insert(schema.users).values({
          telegramId: userId.toString(),
          username: from.username || `user_${userId}`,
          firstName: from.first_name || 'User',
          lastName: from.last_name || '',
          profileImageUrl: '',
        }).returning();
        user = user[0];
      }

      // Search for users based on query
      const searchQuery = query.trim().toLowerCase();
      let results: any[] = [];

      if (searchQuery.length >= 2) {
        // Search users by username or name
        results = await db.query.users.findMany({
          where: or(
            ...(searchQuery ? [
              or(
                ...[
                  { username: { like: `%${searchQuery}%` } },
                  { firstName: { like: `%${searchQuery}%` } },
                  { lastName: { like: `%${searchQuery}%` } },
                ].filter(Boolean)
              ),
            ] : [])
          ),
          limit: 10,
        });

        // Exclude current user
        results = results.filter((u) => u.id !== user.id);
      } else {
        // Return top players if no query (excluding admins)
        results = await db.query.users.findMany({
          orderBy: desc(schema.users.points),
          limit: 5,
          where: and(
            eq(schema.users.isAdmin, false), // Exclude admins
            eq(schema.users.status, 'active')
          ),
        });
      }

      // Format results as inline query results for group challenge templates
      const formattedResults = results.slice(0, 10).map((u, idx) => ({
        type: 'article',
        id: `challenge_${u.id}_${Date.now()}`,
        title: `Challenge ${u.firstName}`,
        description: `@${u.username} • Level ${u.level || 1} • ${u.points || 0} pts`,
        input_message_content: {
          message_text: `🥊 *${u.firstName} has been challenged!*\n\nYou were challenged by @${user.username}\n\nWill you accept? Use the mini-app to respond.`,
          parse_mode: 'Markdown',
        },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '⚔️ Accept Challenge',
                web_app: {
                  url: `${(process.env.FRONTEND_URL || 'https://betchat.replit.app').replace('https://', 'https://')}/telegram-mini-app?action=accept_challenge&challenger=${user.id}&challengedUser=${u.id}`,
                },
              },
            ],
          ],
        },
      }));

      // Send results to Telegram
      const response = await axios.post(`${this.baseUrl}/answerInlineQuery`, {
        inline_query_id: inlineQueryId,
        results: formattedResults.length > 0 ? formattedResults : [
          {
            type: 'article',
            id: 'no_results',
            title: 'No users found',
            description: 'Try searching with 2+ characters',
            input_message_content: {
              message_text: `No users found matching "${query}"`,
              parse_mode: 'Markdown',
            },
          },
        ],
        cache_time: 0, // No cache for real-time results
      });

      if (!response.data.ok) {
        console.error('❌ Failed to answer inline query:', response.data);
        return false;
      }

      console.log(`✅ Answered inline query: "${query}" with ${formattedResults.length} results`);
      return true;
    } catch (error) {
      console.error('❌ Error handling inline query:', error);
      return false;
    }
  }

  // Track when bot is added to a group
  async handleGroupJoin(message: any): Promise<boolean> {
    try {
      const { chat, from } = message;

      // Only track groups and supergroups
      if (chat.type !== 'group' && chat.type !== 'supergroup') {
        return false;
      }

      // Store group info in database (extended user data or new groups table)
      const groupInfo = {
        groupId: chat.id.toString(),
        groupTitle: chat.title,
        groupType: chat.type,
        addedBy: from?.id.toString(),
        addedAt: new Date(),
      };

      console.log(`✅ Bot added to group: ${chat.title} (ID: ${chat.id})`);

      // Store group info in database for member discovery
      try {
        // addGroup returns existing or created group
        const created = await storage.addGroup(chat.id.toString(), chat.title, chat.type, from?.id?.toString());
        // Add the user who added the bot as a member if present
        if (from && created && created.id) {
          await storage.addGroupMember(created.id, `telegram-${from.id}`, from.id.toString(), from.username || undefined);
        }
      } catch (err) {
        console.error('Error storing group info:', err);
      }

      // Send welcome message to group
      await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: chat.id,
        text: `👋 *Welcome to Bantah!*\n\nI'm here to help you challenge your friends!\n\n🥊 Use me inline to search and challenge users:\n\`@${(await this.getBotUsername())}\` \`username\`\n\nExample: \`@BantahBot football\`\n\n🚀 Open the mini-app to manage challenges and track your stats.`,
        parse_mode: 'Markdown',
      });

      return true;
    } catch (error) {
      console.error('❌ Error handling group join:', error);
      return false;
    }
  }

  // Get bot username
  private async getBotUsername(): Promise<string> {
    try {
      const response = await axios.get(`${this.baseUrl}/getMe`);
      return response.data.result?.username || 'BantahBot';
    } catch {
      return 'BantahBot';
    }
  }

  // Handle chosen inline result (when user selects an inline result)
  async handleChosenInlineResult(result: any, apiClient: any): Promise<boolean> {
    try {
      const { from, inline_query_id, result_id } = result;

      console.log(`✅ Inline result selected: ${result_id} by user ${from.id}`);

      // Optionally track this for analytics
      // This is where we could log user interaction data

      return true;
    } catch (error) {
      console.error('❌ Error handling chosen inline result:', error);
      return false;
    }
  }
}

// Singleton instance
let telegramBot: TelegramBotService | null = null;
let bantahBroTelegramBot: TelegramBotService | null = null;

function createScopedTelegramBot(config: {
  tokenEnv: string;
  channelEnv: string;
  usernameEnv?: string;
  label: string;
  existing: TelegramBotService | null;
}): TelegramBotService | null {
  const token = String(process.env[config.tokenEnv] || "").trim();
  const channelId = String(process.env[config.channelEnv] || "").trim();
  const username = config.usernameEnv
    ? String(process.env[config.usernameEnv] || "").trim()
    : "";

  if (!token || !channelId) {
    console.log(`⚠️ ${config.label} Telegram credentials not found. Broadcasting disabled.`);
    console.log(`💡 Set ${config.tokenEnv} and ${config.channelEnv} to enable ${config.label} Telegram.`);
    return null;
  }

  if (config.existing) {
    return config.existing;
  }

  try {
    return new TelegramBotService({
      token,
      channelId,
      username: username || null,
      label: config.label,
    });
  } catch {
    return null;
  }
}

export function createTelegramBot(): TelegramBotService | null {
  telegramBot =
    createScopedTelegramBot({
      tokenEnv: "TELEGRAM_BOT_TOKEN",
      channelEnv: "TELEGRAM_CHANNEL_ID",
      usernameEnv: "TELEGRAM_BOT_USERNAME",
      label: "Platform",
      existing: telegramBot,
    }) || null;
  return telegramBot;
}

export function getTelegramBot(): TelegramBotService | null {
  return telegramBot;
}

export function createBantahBroTelegramBot(): TelegramBotService | null {
  bantahBroTelegramBot =
    createScopedTelegramBot({
      tokenEnv: "BANTAHBRO_TELEGRAM_BOT_TOKEN",
      channelEnv: "BANTAHBRO_TELEGRAM_CHANNEL_ID",
      usernameEnv: "BANTAHBRO_TELEGRAM_BOT_USERNAME",
      label: "BantahBro",
      existing: bantahBroTelegramBot,
    }) || null;
  return bantahBroTelegramBot;
}

export function getBantahBroTelegramBot(): TelegramBotService | null {
  return bantahBroTelegramBot;
}
