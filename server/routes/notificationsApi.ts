/**
 * 🔔 Notification API Endpoints
 * 
 * Routes for:
 * - Getting notifications
 * - Marking notifications as read
 * - Managing notification preferences
 * - Clearing notifications
 */

import { Router, Request, Response } from 'express';
import { FOSMNotificationService } from '../notificationSystem';
import { db } from '../db';
import { notifications, userNotificationPreferences } from '../../shared/schema';
import { eq, and, desc, count } from 'drizzle-orm';

const router = Router();
const notificationService = new FOSMNotificationService();

// Middleware to ensure user is authenticated
const ensureAuth = (req: Request, res: Response, next: Function) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

/**
 * GET /api/notifications
 * Get unread notifications for current user
 * 
 * Query params:
 * - limit: number (default: 20)
 * - offset: number (default: 0)
 */
router.get('/', ensureAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const userNotifications = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);

    const total = await db
      .select({ count: count(notifications.id) })
      .from(notifications)
      .where(eq(notifications.userId, userId));

    res.json({
      data: userNotifications,
      total: total[0].count,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

/**
 * GET /api/notifications/unread
 * Get count of unread notifications
 */
router.get('/unread-count', ensureAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    const unreadCount = await db
      .select({ count: count(notifications.id) })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));

    res.json({ unreadCount: unreadCount[0].count });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

/**
 * PUT /api/notifications/:id/read
 * Mark notification as read
 */
router.put('/:id/read', ensureAuth, async (req: Request, res: Response) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user?.id;

    // Verify ownership
    const notification = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .limit(1);

    if (!notification[0]) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    await notificationService.markAsRead(notificationId);

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// Support PATCH method for clients that use PATCH instead of PUT
router.patch('/:id/read', ensureAuth, async (req: Request, res: Response) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user?.id;

    // Verify ownership
    const notification = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .limit(1);

    if (!notification[0]) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    await notificationService.markAsRead(notificationId);

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking notification as read (PATCH):', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

/**
 * PUT /api/notifications/read-all
 * Mark all notifications as read
 */
router.put('/read-all', ensureAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    await db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));

    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

/**
 * DELETE /api/notifications/:id
 * Delete a notification
 */
router.delete('/:id', ensureAuth, async (req: Request, res: Response) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user?.id;

    // Verify ownership
    const notification = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .limit(1);

    if (!notification[0]) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    await db.delete(notifications).where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));

    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

/**
 * DELETE /api/notifications/clear-all
 * Delete all notifications for user
 */
router.delete('/clear-all', ensureAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    await notificationService.clearAllNotifications(userId);

    res.json({ success: true, message: 'All notifications cleared' });
  } catch (error) {
    console.error('Error clearing notifications:', error);
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

/**
 * GET /api/notifications/preferences
 * Get user notification preferences
 */
router.get('/preferences', ensureAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    const prefs = await db
      .select()
      .from(userNotificationPreferences)
      .where(eq(userNotificationPreferences.userId, userId))
      .limit(1);

    if (!prefs[0]) {
      // Return default preferences
      return res.json({
        enablePush: true,
        enableTelegram: false,
        enableInApp: true,
        notificationFrequency: 'immediate',
        mutedChallenges: [],
        mutedUsers: [],
      });
    }

    res.json({
      enablePush: prefs[0].enablePush,
      enableTelegram: prefs[0].enableTelegram,
      enableInApp: prefs[0].enableInApp,
      notificationFrequency: prefs[0].notificationFrequency,
      mutedChallenges: prefs[0].mutedChallenges || [],
      mutedUsers: prefs[0].mutedUsers || [],
    });
  } catch (error) {
    console.error('Error fetching preferences:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

/**
 * PUT /api/notifications/preferences
 * Update user notification preferences
 */
router.put('/preferences', ensureAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const {
      enablePush,
      enableTelegram,
      enableInApp,
      notificationFrequency,
      mutedChallenges,
      mutedUsers,
    } = req.body;

    await notificationService.updateUserPreferences(userId, {
      userId,
      enablePushNotifications: enablePush,
      enableTelegramNotifications: enableTelegram,
      enableInAppNotifications: enableInApp,
      notificationFrequency,
      mutedChallenges,
      mutedUsers,
    });

    res.json({ success: true, message: 'Preferences updated' });
  } catch (error) {
    console.error('Error updating preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * POST /api/notifications/mute-challenge/:challengeId
 * Mute notifications for a challenge
 */
router.post('/mute-challenge/:challengeId', ensureAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const challengeId = req.params.challengeId;

    const prefs = await db
      .select()
      .from(userNotificationPreferences)
      .where(eq(userNotificationPreferences.userId, userId))
      .limit(1);

    const mutedChallenges = prefs[0]?.mutedChallenges || [];
    if (!mutedChallenges.includes(challengeId)) {
      mutedChallenges.push(challengeId);
    }

    await notificationService.updateUserPreferences(userId, {
      userId,
      mutedChallenges,
    });

    res.json({ success: true, message: 'Challenge muted' });
  } catch (error) {
    console.error('Error muting challenge:', error);
    res.status(500).json({ error: 'Failed to mute challenge' });
  }
});

/**
 * POST /api/notifications/unmute-challenge/:challengeId
 * Unmute notifications for a challenge
 */
router.post('/unmute-challenge/:challengeId', ensureAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const challengeId = req.params.challengeId;

    const prefs = await db
      .select()
      .from(userNotificationPreferences)
      .where(eq(userNotificationPreferences.userId, userId))
      .limit(1);

    const mutedChallenges = (prefs[0]?.mutedChallenges || []).filter((id) => id !== challengeId);

    await notificationService.updateUserPreferences(userId, {
      userId,
      mutedChallenges,
    });

    res.json({ success: true, message: 'Challenge unmuted' });
  } catch (error) {
    console.error('Error unmuting challenge:', error);
    res.status(500).json({ error: 'Failed to unmute challenge' });
  }
});

export default router;
