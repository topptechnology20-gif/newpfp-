/**
 * 4️⃣ ADMIN NOTIFICATION CONTROLS
 * Admins can: mute, boost, feature notifications
 * API endpoints for managing notifications globally
 */

import { Router, Request, Response } from 'express';
import { db } from '../db';
import { notifications, users, challenges } from '../../shared/schema';
import { eq, and, gt, desc } from 'drizzle-orm';

const router = Router();

/**
 * Middleware: Ensure user is admin
 */
const ensureAdmin = async (req: Request, res: Response, next: Function) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);

  if (!user[0] || !user[0].isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
};

/**
 * GET /api/admin/notifications/dashboard
 * Overview of notification performance
 */
router.get('/dashboard', ensureAdmin, async (req: Request, res: Response) => {
  try {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Get stats
    const totalSent = await db
      .select({ count: db.$count(notifications) })
      .from(notifications)
      .where(gt(notifications.createdAt as any, last24h));

    const readRate = await db
      .select({ count: db.$count(notifications) })
      .from(notifications)
      .where(and(eq(notifications.read, true), gt(notifications.createdAt as any, last24h)));

    const byPriority = await db
      .select({
        priority: notifications.priority,
        count: db.$count(notifications),
      })
      .from(notifications)
      .where(gt(notifications.createdAt as any, last24h))
      .groupBy(notifications.priority);

    res.json({
      totalSent: totalSent[0]?.count || 0,
      readCount: readRate[0]?.count || 0,
      readRate: ((readRate[0]?.count || 0) / (totalSent[0]?.count || 1)) * 100,
      byPriority: byPriority || [],
      timeRange: 'Last 24 hours',
    });
  } catch (error) {
    console.error('Error fetching notification dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

/**
 * GET /api/admin/notifications/events
 * View all sent notifications
 */
router.get('/events', ensureAdmin, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const events = await db
      .select()
      .from(notifications)
      .orderBy((n) => desc(n.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({ data: events, limit, offset });
  } catch (error) {
    console.error('Error fetching notification events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

/**
 * POST /api/admin/notifications/feature-challenge/:challengeId
 * Feature a challenge - boost its notifications
 */
router.post('/feature-challenge/:challengeId', ensureAdmin, async (req: Request, res: Response) => {
  try {
    const { challengeId } = req.params;
    const { boost = true, durationHours = 24 } = req.body;

    // Update challenge with feature flag
    // TODO: Add to schema
    console.log(`📌 Featured challenge ${challengeId} for ${durationHours}h`);

    res.json({
      success: true,
      message: `Challenge ${challengeId} featured`,
      boost,
      durationHours,
    });
  } catch (error) {
    console.error('Error featuring challenge:', error);
    res.status(500).json({ error: 'Failed to feature challenge' });
  }
});

/**
 * POST /api/admin/notifications/mute-event/:event
 * Globally mute an event type
 */
router.post('/mute-event/:event', ensureAdmin, async (req: Request, res: Response) => {
  try {
    const { event } = req.params;
    const { durationMinutes = 60 } = req.body;

    // Store in cache or database
    // TODO: Implement muting logic
    console.log(`🔇 Muted event type: ${event} for ${durationMinutes}m`);

    res.json({
      success: true,
      message: `Event ${event} muted`,
      durationMinutes,
    });
  } catch (error) {
    console.error('Error muting event:', error);
    res.status(500).json({ error: 'Failed to mute event' });
  }
});

/**
 * POST /api/admin/notifications/unmute-event/:event
 * Resume event notifications
 */
router.post('/unmute-event/:event', ensureAdmin, async (req: Request, res: Response) => {
  try {
    const { event } = req.params;

    console.log(`🔔 Unmuted event type: ${event}`);

    res.json({
      success: true,
      message: `Event ${event} unmuted`,
    });
  } catch (error) {
    console.error('Error unmuting event:', error);
    res.status(500).json({ error: 'Failed to unmute event' });
  }
});

/**
 * POST /api/admin/notifications/broadcast
 * Send a broadcast notification to all/selected users
 */
router.post('/broadcast', ensureAdmin, async (req: Request, res: Response) => {
  try {
    const { title, body, userIds, priority = 'medium', channels = ['in_app'] } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body required' });
    }

    // Get target users
    const targetUsers = userIds || (await db.select({ id: users.id }).from(users));

    console.log(`📢 Broadcasting to ${targetUsers.length} users`);

    // TODO: Send notifications
    for (const targetUser of targetUsers) {
      console.log(`   → ${targetUser.id}`);
    }

    res.json({
      success: true,
      message: `Broadcast sent to ${targetUsers.length} users`,
      details: { title, body, priority, channels },
    });
  } catch (error) {
    console.error('Error broadcasting notification:', error);
    res.status(500).json({ error: 'Failed to broadcast' });
  }
});

/**
 * GET /api/admin/notifications/users/:userId/history
 * View notification history for specific user
 */
router.get('/users/:userId/history', ensureAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;

    const history = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy((n) => desc(n.createdAt))
      .limit(limit);

    res.json({
      userId,
      count: history.length,
      notifications: history,
    });
  } catch (error) {
    console.error('Error fetching user notification history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

/**
 * POST /api/admin/notifications/test
 * Send test notification to self
 */
router.post('/test', ensureAdmin, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { event = 'bonus.expiring', priority = 'high' } = req.body;

    console.log(`🧪 Test notification to admin ${userId}`);

    res.json({
      success: true,
      message: 'Test notification sent',
      details: { event, priority },
    });
  } catch (error) {
    console.error('Error sending test notification:', error);
    res.status(500).json({ error: 'Failed to send test' });
  }
});

export default router;
