import type { PrivyClient as PrivyClientType } from '@privy-io/server-auth';
import { normalizeEvmAddress, parseWalletAddresses } from '@shared/onchainConfig';
import { getDelegatedAgentAuth, isAgentToken } from './agentAuth';
import { storage } from './storage';

function requirePrivyEnv(name: "PRIVY_APP_ID" | "PRIVY_APP_SECRET") {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required for Privy authentication.`);
  }
  return value;
}

let cachedPrivyClient: PrivyClientType | null = null;
let cachedPrivyClientPromise: Promise<PrivyClientType> | null = null;

export async function getPrivyClient() {
  if (cachedPrivyClient) {
    return cachedPrivyClient;
  }

  if (!cachedPrivyClientPromise) {
    cachedPrivyClientPromise = import('@privy-io/server-auth')
      .then(({ PrivyClient }) => {
        cachedPrivyClient = new PrivyClient(
          requirePrivyEnv("PRIVY_APP_ID"),
          requirePrivyEnv("PRIVY_APP_SECRET"),
        );
        return cachedPrivyClient;
      })
      .catch((error) => {
        cachedPrivyClientPromise = null;
        throw error;
      });
  }

  return cachedPrivyClientPromise;
}

export async function verifyPrivyToken(token: string) {
  try {
    const privyClient = await getPrivyClient();
    const verifiedClaims = await privyClient.verifyAuthToken(token);
    return verifiedClaims;
  } catch (error) {
    console.error('Privy token verification failed:', error);
    return null;
  }
}

function getInitialsFromEmail(email?: string) {
  if (!email || typeof email !== 'string') return '';
  const local = email.split('@')[0] || '';
  const parts = local.split(/[^a-z0-9]+/i).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  if (parts.length === 1) {
    const p = parts[0];
    return p.slice(0, 2).toUpperCase();
  }
  return '';
}

function extractWalletAddressesFromClaims(verifiedClaims: any): string[] {
  const found = new Set<string>();

  const add = (candidate: unknown) => {
    const normalized = normalizeEvmAddress(candidate);
    if (normalized) found.add(normalized);
  };

  add(verifiedClaims?.walletAddress);
  add(verifiedClaims?.wallet?.address);
  add(verifiedClaims?.address);

  const linkedAccounts = Array.isArray(verifiedClaims?.linkedAccounts)
    ? verifiedClaims.linkedAccounts
    : Array.isArray(verifiedClaims?.linked_accounts)
      ? verifiedClaims.linked_accounts
      : [];

  for (const account of linkedAccounts) {
    if (!account || typeof account !== 'object') continue;
    const accountType = String((account as any).type || '').toLowerCase();
    if (accountType.includes('wallet') || (account as any).address || (account as any).walletAddress) {
      add((account as any).address);
      add((account as any).walletAddress);
    }
  }

  return Array.from(found);
}

async function getUserFromDb(userId: string) {
  try {
    // Try to get user with normalized ID first
    let user = await storage.getUser(userId);
    if (user) return user;

    // If not found, try with the did:privy: prefix (for existing users created with unnormalized IDs)
    const privyFormatId = `did:privy:${userId}`;
    user = await storage.getUser(privyFormatId);
    if (user) {
      // Update user to have normalized ID for consistency
      // This will be handled in the next sync
      return user;
    }

    return null;
  } catch (error) {
    console.error('Error fetching user from database:', error);
    return null;
  }
}

async function upsertPrivyUser(verifiedClaims: any) {
  try {
    let userId = verifiedClaims.userId || verifiedClaims.sub;
    // Normalize Privy DID to compact ID (remove "did:privy:" prefix if present)
    userId = userId.replace(/^did:privy:/, '').trim();
    
    let dbUser = await getUserFromDb(userId);

    if (!dbUser) {
      const email = verifiedClaims.email || `${userId}@privy.user`;
      const existingByEmail = await storage.getUserByEmail(email);
      if (existingByEmail) {
        return existingByEmail;
      }

      const username = verifiedClaims.email?.split('@')[0] || `user_${userId.slice(-8)}`;
      const fallbackFirstName = getInitialsFromEmail(verifiedClaims.email) || 'User';

      dbUser = await storage.upsertUser({
        id: userId,
        email,
        password: 'PRIVY_AUTH_USER',
        firstName: verifiedClaims.given_name || verifiedClaims.name || fallbackFirstName,
        lastName: verifiedClaims.family_name || 'User',
        username,
        profileImageUrl: verifiedClaims.picture,
      });

      // Award signup bonus for new Privy users
      const { BANTCREDIT_SIGNUP_REWARD } = await import('@shared/bantCredit');
      await storage.updateUserPoints(userId, BANTCREDIT_SIGNUP_REWARD);
      
      await storage.createNotification({
        userId: userId,
        type: 'welcome_bonus',
        title: 'Welcome to Bantah',
        message: `You received ${BANTCREDIT_SIGNUP_REWARD} BantCredit for joining! Start betting and challenging friends to earn more.`,
        data: { points: BANTCREDIT_SIGNUP_REWARD, type: 'welcome_bonus' },
        channels: ['in_app_feed', 'push_notification'],
        fomoLevel: 'medium',
        priority: 2,
      } as any);

      await storage.createTransaction({
        userId: userId,
        type: 'signup_bonus',
        amount: BANTCREDIT_SIGNUP_REWARD.toString(),
        description: 'Welcome bonus for new user registration via Wallet',
        status: 'completed',
      });
    }

    if (verifiedClaims.linkedAccounts) {
      const telegramAccount = verifiedClaims.linkedAccounts.find(
        (account: any) => account.type === 'telegram',
      );
      if (telegramAccount && telegramAccount.telegramUserId && !dbUser.telegramId) {
        console.log(`Telegram account detected in Privy claims: ${telegramAccount.telegramUserId}`);
        await storage.updateUserTelegramInfo(userId, {
          telegramId: telegramAccount.telegramUserId.toString(),
          telegramUsername:
            telegramAccount.telegramUsername || `tg_${telegramAccount.telegramUserId}`,
          isTelegramUser: true,
        });
        const refreshedUser = await storage.getUser(userId);
        if (refreshedUser) {
          dbUser = refreshedUser;
        }
        console.log(`User ${userId} linked with Telegram ID ${telegramAccount.telegramUserId}`);
      }
    }

    const walletsFromClaims = extractWalletAddressesFromClaims(verifiedClaims);
    if (walletsFromClaims.length > 0) {
      const currentPrimary = normalizeEvmAddress((dbUser as any)?.primaryWalletAddress);
      const existingWallets = parseWalletAddresses((dbUser as any)?.walletAddresses);
      const mergedWallets = Array.from(new Set([...existingWallets, ...walletsFromClaims]));
      const nextPrimary = walletsFromClaims[0] || currentPrimary;

      if (nextPrimary !== currentPrimary || mergedWallets.length !== existingWallets.length) {
        dbUser = await storage.updateUserProfile(dbUser.id, {
          primaryWalletAddress: nextPrimary,
          walletAddresses: mergedWallets,
        } as any);
      }
    }

    return dbUser;
  } catch (error) {
    console.error('Error upserting Privy user:', error);
    throw error;
  }
}

function toAuthenticatedUser(dbUser: any) {
  return {
    id: dbUser.id,
    email: dbUser.email || '',
    firstName: dbUser.firstName,
    lastName: dbUser.lastName,
    username: dbUser.username,
    walletAddress:
      normalizeEvmAddress((dbUser as any)?.primaryWalletAddress) ||
      parseWalletAddresses((dbUser as any)?.walletAddresses)[0] ||
      undefined,
    isAdmin: dbUser.isAdmin || false,
    claims: {
      sub: dbUser.id,
      email: dbUser.email,
      first_name: dbUser.firstName,
      last_name: dbUser.lastName,
    },
  };
}

export async function PrivyAuthMiddleware(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;

  if (!authHeader && req.isAuthenticated && req.isAuthenticated()) {
    try {
      const sessionUser = req.user;
      if (sessionUser) {
        req.user = sessionUser;
        return next();
      }
    } catch (err) {
      console.error('Error using session-based auth fallback:', err);
    }
  }

  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization header missing' });
  }

  const token = authHeader.replace('Bearer ', '').trim();

  try {
    const delegatedAgentAuth = await getDelegatedAgentAuth(token);
    if (delegatedAgentAuth) {
      req.user = toAuthenticatedUser(delegatedAgentAuth.user);
      req.agentAuth = {
        serviceId: delegatedAgentAuth.agentAuth.serviceId,
        scopes: delegatedAgentAuth.agentAuth.scopes,
        actingAsUserId: delegatedAgentAuth.agentAuth.actingAsUserId,
        audience: delegatedAgentAuth.agentAuth.audience,
      };
      return next();
    }

    if (isAgentToken(token)) {
      return res.status(401).json({ message: 'Invalid or expired agent token' });
    }

    const verifiedClaims = await verifyPrivyToken(token);
    let userId = verifiedClaims?.userId || verifiedClaims?.sub;
    // Normalize Privy DID to compact ID (remove "did:privy:" prefix if present)
    userId = userId?.replace(/^did:privy:/, '').trim();
    if (!verifiedClaims || !userId) {
      return res.status(401).json({ message: 'Invalid token or user ID not found' });
    }

    const dbUser = await upsertPrivyUser(verifiedClaims);
    if (!dbUser) {
      return res.status(500).json({ message: 'Failed to create or retrieve user' });
    }

    req.user = toAuthenticatedUser(dbUser);
    return next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({ message: 'Internal server error during authentication' });
  }
}
