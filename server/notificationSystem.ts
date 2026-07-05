/**
 * 🔔 FOMO Notification System
 * Event-driven notification engine for Dynamic + Admin-Controlled Challenges
 * 
 * Categories:
 * 1. Challenge Lifecycle (new, starting, ending)
 * 2. User Activity (friend joins, friend wins, bonus expiring)
 * 3. Admin/System Events (bonus surge, imbalance, system character)
 */

import { db } from './db';
import { users, notifications, userNotificationPreferences } from '../shared/schema';
import { eq, and, or, ne, gte, desc, lt } from 'drizzle-orm';
import Pusher from 'pusher';

// Notification Types - Matches FOMO Framework
export enum NotificationType {
  // Challenge Lifecycle
  NEW_CHALLENGE_CREATED = 'new_challenge_created',
  CHALLENGE_ABOUT_TO_START = 'challenge_about_to_start',
  CHALLENGE_NEAR_END = 'challenge_near_end',
  
  // User Activity
  FRIEND_JOINED_CHALLENGE = 'friend_joined_challenge',
  FRIEND_WON_BONUS = 'friend_won_bonus',
  PENDING_BONUS_EXPIRING = 'pending_bonus_expiring',
  YOUR_SIDE_LAGGING = 'your_side_lagging',
  
  // Admin/System Events
  ADMIN_BONUS_SURGE_ACTIVATED = 'admin_bonus_surge_activated',
  IMBALANCE_DETECTED = 'imbalance_detected',
  EARLY_JOIN_SPOTS_REMAINING = 'early_join_spots_remaining',
  SYSTEM_CHARACTER_JOINED = 'system_character_joined',
  
  // FOMO/Engagement
  FRIEND_ACTIVITY_SUMMARY = 'friend_activity_summary',
  OPPORTUNITY_REMINDER = 'opportunity_reminder',
  
  // Transactional
  CHALLENGE_RESULT = 'challenge_result',
  CHALLENGE_COMPLETED = 'challenge_completed',
  PAYOUT_RECEIVED = 'payout_received',
  CHALLENGE_CANCELLED = 'challenge_cancelled',
}

// Notification Channels
export enum NotificationChannel {
  IN_APP_FEED = 'in_app_feed',
  PUSH_NOTIFICATION = 'push_notification',
  TELEGRAM_BOT = 'telegram_bot',
}

// FOMO Urgency Levels
export enum FOMOLevel {
  LOW = 'low',           // System character joined, friend joined
  MEDIUM = 'medium',     // Imbalance detected, early join spots
  HIGH = 'high',         // Friend won, early bonus expiring
  URGENT = 'urgent',     // Bonus surge, last 5 minutes
}

// Notification Priority for queue processing
export enum NotificationPriority {
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
  URGENT = 4,
}

interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  icon?: string;           // emoji icon
  data: {
    challengeId?: string;
    userId?: string;
    friendName?: string;
    side?: 'YES' | 'NO';
    multiplier?: number;
    daysLeft?: number;
    remainingSpots?: number;
    remainingMinutes?: number;
    [key: string]: any;
  };
  channels: NotificationChannel[];
  fomoLevel: FOMOLevel;
  priority: NotificationPriority;
  deduplicationKey?: string; // For preventing duplicate notifications
  expiresAt?: Date;          // Notification becomes stale after this time
}

interface UserPreferences {
  userId: string;
  enablePushNotifications: boolean;
  enableTelegramNotifications: boolean;
  enableInAppNotifications: boolean;
  mutedChallenges: string[];  // Challenge IDs to mute
  mutedUsers: string[];       // Friend IDs to mute
  notificationFrequency: 'immediate' | 'batched' | 'digest'; // How often to send
}

/**
 * FOMO Notification Service
 * Handles creation, routing, and delivery of notifications
 */
export class FOSMNotificationService {
  private pusher: Pusher;
  private readonly DEDUP_WINDOW = 5 * 60 * 1000; // 5 minutes
  
  constructor() {
    this.pusher = new Pusher({
      appId: process.env.PUSHER_APP_ID || '1553294',
      key: process.env.PUSHER_KEY || 'decd2cca5e39cf0cbcd4',
      secret: process.env.PUSHER_SECRET || '1dd966e56c465ea285d9',
      cluster: process.env.PUSHER_CLUSTER || 'mt1',
      useTLS: true,
    });
  }

  /**
   * Main entry point: Create and send a notification
   */
  async sendNotification(payload: NotificationPayload): Promise<void> {
    try {
      // Check user preferences
      const preferences = await this.getUserPreferences(payload.userId);
      if (!preferences) {
        console.warn(`No preferences found for user ${payload.userId}`);
        return;
      }

      // Filter channels based on preferences
      const activeChannels = this.filterChannelsByPreferences(payload.channels, preferences);
      if (activeChannels.length === 0) {
        console.log(`User ${payload.userId} has disabled all channels for ${payload.type}`);
        return;
      }

      // Check for duplicate notifications (deduplication)
      const isDuplicate = await this.checkIfDuplicate(payload);
      if (isDuplicate) {
        console.log(`Skipping duplicate notification: ${payload.deduplicationKey}`);
        return;
      }

      // Save notification to database
      const notificationId = await this.saveNotificationToDatabase(payload);

      // Route to active channels
      for (const channel of activeChannels) {
        await this.routeNotificationToChannel(notificationId, payload, channel, preferences);
      }

      console.log(`✅ Notification sent: ${payload.type} to user ${payload.userId}`);
    } catch (error) {
      console.error(`❌ Error sending notification: ${payload.type}`, error);
    }
  }

  /**
   * Save notification to database for persistence and tracking
   */
  private async saveNotificationToDatabase(payload: NotificationPayload): Promise<string> {
    const result = await db.insert(notifications).values({
      userId: payload.userId,
      type: payload.type,
      title: payload.title,
      message: payload.message,
      icon: payload.icon,
      data: payload.data as any,
      channels: payload.channels,
      fomoLevel: payload.fomoLevel,
      priority: payload.priority,
      read: false,
      createdAt: new Date(),
      expiresAt: payload.expiresAt,
    }).returning({ id: notifications.id });

    return result[0]?.id || '';
  }

  /**
   * Filter notification channels based on user preferences
   */
  private filterChannelsByPreferences(
    requestedChannels: NotificationChannel[],
    preferences: UserPreferences
  ): NotificationChannel[] {
    return requestedChannels.filter(channel => {
      switch (channel) {
        case NotificationChannel.PUSH_NOTIFICATION:
          return preferences.enablePushNotifications;
        case NotificationChannel.TELEGRAM_BOT:
          return preferences.enableTelegramNotifications;
        case NotificationChannel.IN_APP_FEED:
          return preferences.enableInAppNotifications;
        default:
          return false;
      }
    });
  }

  /**
   * Check if this notification was recently sent (deduplication)
   */
  private async checkIfDuplicate(payload: NotificationPayload): Promise<boolean> {
    if (!payload.deduplicationKey) return false;

    const recent = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, payload.userId),
          eq(notifications.type, payload.type),
          gte(notifications.createdAt, new Date(Date.now() - this.DEDUP_WINDOW))
        )
      )
      .limit(1);

    return recent.length > 0;
  }

  /**
   * Route notification to appropriate channel
   */
  private async routeNotificationToChannel(
    notificationId: string,
    payload: NotificationPayload,
    channel: NotificationChannel,
    preferences: UserPreferences
  ): Promise<void> {
    switch (channel) {
      case NotificationChannel.IN_APP_FEED:
        await this.sendToInAppFeed(payload);
        break;
      case NotificationChannel.PUSH_NOTIFICATION:
        await this.sendPushNotification(payload);
        break;
      case NotificationChannel.TELEGRAM_BOT:
        await this.sendTelegramNotification(payload);
        break;
    }
  }

  /**
   * Send to real-time in-app notification feed via Pusher
   */
  private async sendToInAppFeed(payload: NotificationPayload): Promise<void> {
    try {
      // Validate channel name (only alphanumeric, underscore, hyphen allowed)
      const channelName = `user-${payload.userId}`;
      const sanitizedChannel = channelName.replace(/[^a-zA-Z0-9_-]/g, '_');

      await this.pusher.trigger(sanitizedChannel, 'notification', {
        id: payload.deduplicationKey || Date.now(),
        type: payload.type,
        title: payload.title,
        message: payload.message,
        icon: payload.icon,
        data: payload.data,
        fomoLevel: payload.fomoLevel,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('Error sending to in-app feed:', error);
    }
  }

  /**
   * Send push notification to mobile/web
   */
  private async sendPushNotification(payload: NotificationPayload): Promise<void> {
    try {
      // Get user's push subscription tokens
      const user = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
      if (!user[0]) return;

      // Implementation: Send to push service (Firebase, OneSignal, etc.)
      // For now, log as placeholder
      console.log(`📱 Push notification: ${payload.title} → ${user[0].username}`);
    } catch (error) {
      console.error('Error sending push notification:', error);
    }
  }

  /**
   * Send Telegram bot message
   */
  private async sendTelegramNotification(payload: NotificationPayload): Promise<void> {
    try {
      const user = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
      if (!user[0] || !user[0].telegramId) return;

      // Implementation: Send via Telegram Bot API
      // For now, log as placeholder
      console.log(`📨 Telegram notification: ${payload.title} → ${user[0].telegramUsername}`);
    } catch (error) {
      console.error('Error sending Telegram notification:', error);
    }
  }

  /**
   * Get user notification preferences
   */
  private async getUserPreferences(userId: string): Promise<UserPreferences | null> {
    const prefs = await db
      .select()
      .from(userNotificationPreferences)
      .where(eq(userNotificationPreferences.userId, userId))
      .limit(1);

    if (prefs.length === 0) {
      // Return default preferences if none exist
      return {
        userId,
        enablePushNotifications: true,
        enableTelegramNotifications: false,
        enableInAppNotifications: true,
        mutedChallenges: [],
        mutedUsers: [],
        notificationFrequency: 'immediate',
      };
    }

    return {
      userId,
      enablePushNotifications: prefs[0].enablePush ?? true,
      enableTelegramNotifications: prefs[0].enableTelegram ?? false,
      enableInAppNotifications: prefs[0].enableInApp ?? true,
      mutedChallenges: (prefs[0].mutedChallenges as string[]) ?? [],
      mutedUsers: (prefs[0].mutedUsers as string[]) ?? [],
      notificationFrequency: (prefs[0].notificationFrequency as any) ?? 'immediate',
    };
  }

  /**
   * Update user notification preferences
   */
  async updateUserPreferences(userId: string, updates: Partial<UserPreferences>): Promise<void> {
    // Check if preferences exist
    const existing = await db
      .select()
      .from(userNotificationPreferences)
      .where(eq(userNotificationPreferences.userId, userId));

    if (existing.length === 0) {
      // Create new preferences
      await db.insert(userNotificationPreferences).values({
        userId,
        enablePush: updates.enablePushNotifications ?? true,
        enableTelegram: updates.enableTelegramNotifications ?? false,
        enableInApp: updates.enableInAppNotifications ?? true,
        mutedChallenges: updates.mutedChallenges ?? [],
        mutedUsers: updates.mutedUsers ?? [],
        notificationFrequency: updates.notificationFrequency ?? 'immediate',
      });
    } else {
      // Update existing preferences
      const nextValues: Partial<typeof userNotificationPreferences.$inferInsert> = {};
      if (updates.enablePushNotifications !== undefined) {
        nextValues.enablePush = updates.enablePushNotifications;
      }
      if (updates.enableTelegramNotifications !== undefined) {
        nextValues.enableTelegram = updates.enableTelegramNotifications;
      }
      if (updates.enableInAppNotifications !== undefined) {
        nextValues.enableInApp = updates.enableInAppNotifications;
      }
      if (updates.mutedChallenges !== undefined) {
        nextValues.mutedChallenges = updates.mutedChallenges;
      }
      if (updates.mutedUsers !== undefined) {
        nextValues.mutedUsers = updates.mutedUsers;
      }
      if (updates.notificationFrequency !== undefined) {
        nextValues.notificationFrequency = updates.notificationFrequency;
      }
      nextValues.updatedAt = new Date();

      await db
        .update(userNotificationPreferences)
        .set(nextValues)
        .where(eq(userNotificationPreferences.userId, userId));
    }
  }

  /**
   * Get unread notifications for a user
   */
  async getUnreadNotifications(userId: string, limit = 20): Promise<any[]> {
    return db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  /**
   * Mark notification as read
   */
  async markAsRead(notificationId: string): Promise<void> {
    await db.update(notifications).set({ read: true }).where(eq(notifications.id, notificationId));
  }

  /**
   * Clear all notifications for a user
   */
  async clearAllNotifications(userId: string): Promise<void> {
    await db.delete(notifications).where(eq(notifications.userId, userId));
  }
}

export const fomoNotificationService = new FOSMNotificationService();
