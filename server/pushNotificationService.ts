/**
 * 3️⃣ PUSH NOTIFICATION INTEGRATION
 * Firebase Cloud Messaging setup
 * Handle browser push subscriptions & sending
 */

import { db } from './db';
import { users } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * Firebase Cloud Messaging - Initialize
 * Call this on app startup (client-side)
 */
export async function initializeFCM() {
  if (typeof window === 'undefined') return;

  try {
    // Import Firebase modules
    const { initializeApp } = await import('firebase/app');
    const { getMessaging, getToken, onMessage } = await import('firebase/messaging');

    const firebaseConfig = {
      apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
      authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
      storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.REACT_APP_FIREBASE_APP_ID,
    };

    const app = initializeApp(firebaseConfig);
    const messaging = getMessaging(app);

    // Request permission and get token
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        const token = await getToken(messaging, {
          vapidKey: process.env.REACT_APP_FIREBASE_VAPID_KEY,
        });

        if (token) {
          // Store token on server
          await saveFCMToken(token);
          console.log('✅ FCM initialized, token saved');
        }
      }
    } catch (error) {
      console.error('Error getting FCM token:', error);
    }

    // Handle foreground messages
    onMessage(messaging, (payload) => {
      console.log('📱 Foreground message received:', payload);
      // Show toast or notification in-app
    });
  } catch (error) {
    console.error('Error initializing FCM:', error);
  }
}

/**
 * Save FCM token to server
 */
async function saveFCMToken(token: string) {
  try {
    await fetch('/api/user/fcm-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    console.error('Error saving FCM token:', error);
  }
}

/**
 * Server-side: Send push notification via Firebase
 */
export async function sendPushNotificationViaFirebase(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<boolean> {
  try {
    // Get user's FCM token
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (!user[0] || !user[0].fcmToken) {
      console.log(`No FCM token for user ${userId}`);
      return false;
    }

    // Use Firebase Admin SDK to send
    const admin = await import('firebase-admin');

    const message = {
      notification: { title, body },
      data: data || {},
      token: user[0].fcmToken,
    };

    const response = await admin.messaging().send(message as any);
    console.log(`✅ Push sent to ${userId}:`, response);
    return true;
  } catch (error) {
    console.error('Error sending push notification:', error);
    return false;
  }
}

/**
 * Send push to multiple users
 */
export async function sendPushToMultipleUsers(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<number> {
  let successCount = 0;

  for (const userId of userIds) {
    const success = await sendPushNotificationViaFirebase(userId, title, body, data);
    if (success) successCount++;
  }

  return successCount;
}

/**
 * API Endpoint: Save FCM token (server)
 * POST /api/user/fcm-token
 */
export async function handleSaveFCMToken(userId: string, token: string) {
  try {
    await db.update(users).set({ fcmToken: token }).where(eq(users.id, userId));
    console.log(`✅ FCM token saved for user ${userId}`);
    return true;
  } catch (error) {
    console.error('Error saving FCM token:', error);
    return false;
  }
}

/**
 * Throttle push notifications
 * Only send HIGH priority pushes more frequently
 * MEDIUM: max 1 per challenge per hour
 * HIGH: max 3 per hour total
 */
export async function shouldSendPush(
  userId: string,
  priority: 'low' | 'medium' | 'high'
): Promise<boolean> {
  // TODO: Check user's push history in last hour
  // Compare against limits

  if (priority === 'low') {
    return false; // Never send LOW priority as push
  }

  return true; // TODO: Implement throttling logic
}

/**
 * Integration: Call from notificationService.sendPush()
 */
export async function handlePushNotification(
  userId: string,
  title: string,
  body: string,
  priority: string,
  data?: Record<string, string>
): Promise<void> {
  try {
    // Check throttling
    const shouldSend = await shouldSendPush(userId, priority as any);
    if (!shouldSend) {
      console.log(`⏸ Push throttled for user ${userId}`);
      return;
    }

    // Send via Firebase
    await sendPushNotificationViaFirebase(userId, title, body, data);
  } catch (error) {
    console.error('Error handling push notification:', error);
  }
}

export const pushNotificationService = {
  initializeFCM,
  saveFCMToken,
  sendPushNotificationViaFirebase,
  sendPushToMultipleUsers,
  handleSaveFCMToken,
  shouldSendPush,
  handlePushNotification,
};
