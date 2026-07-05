import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import { User as SelectUser, registerSchema, loginSchema } from "@shared/schema";
import {
  BANTCREDIT_REFERRED_REWARD,
  BANTCREDIT_REFERRER_REWARD,
  BANTCREDIT_SIGNUP_REWARD,
} from "@shared/bantCredit";
import { fromZodError } from "zod-validation-error";
import { nanoid } from "nanoid";

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

export async function comparePasswords(supplied: string, stored: string) {
  const [hashed, salt] = stored.split(".");
  const hashedBuf = Buffer.from(hashed, "hex");
  const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedBuf, suppliedBuf);
}

function toAuthUserPayload(user: SelectUser) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    level: user.level,
    xp: user.xp,
    points: user.points,
    balance: user.balance,
    streak: user.streak,
    status: user.status,
    isAdmin: user.isAdmin,
  };
}

export function setupAuth(app: Express) {
  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  };

  app.set("trust proxy", 1);
  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy({ usernameField: 'emailOrUsername' }, async (emailOrUsername, password, done) => {
      try {
        // Try to find user by email first, then by username
        let user = await storage.getUserByEmail(emailOrUsername);
        if (!user) {
          user = await storage.getUserByUsername(emailOrUsername);
        }
        
        if (!user || !(await comparePasswords(password, user.password))) {
          return done(null, false, { message: 'Invalid username/email or password' });
        }
        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }),
  );

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user);
    } catch (error) {
      done(error);
    }
  });

  // Register endpoint
  app.post("/api/register", async (req, res, next) => {
    try {
      const validatedData = registerSchema.parse(req.body);

      // Check if user already exists
      const existingUser = await storage.getUserByEmail(validatedData.email);
      if (existingUser) {
        return res.status(400).json({ message: "User already exists with this email" });
      }

      // Check if username is taken (if provided)
      if (validatedData.username) {
        const existingUsername = await storage.getUserByUsername(validatedData.username);
        if (existingUsername) {
          return res.status(400).json({ message: "Username is already taken" });
        }
      }

      // Hash password and create user
      const hashedPassword = await hashPassword(validatedData.password);
      const userId = nanoid();

      // Handle referral logic
      let referrerUser = null;
      let bonusPoints = BANTCREDIT_SIGNUP_REWARD; // Default signup bonus
      let bonusCoins = 0;

      if (validatedData.referralCode) {
        // Find the referrer by their referral code
        referrerUser = await storage.getUserByReferralCode(validatedData.referralCode);
        if (referrerUser) {
          bonusPoints = BANTCREDIT_REFERRED_REWARD;
          bonusCoins = 0;
        }
      }

      const user = await storage.createUser({
        id: userId,
        email: validatedData.email,
        password: hashedPassword,
        firstName: validatedData.firstName,
        lastName: validatedData.lastName,
        username: validatedData.username || `user_${userId.slice(0, 8)}`,
        level: 1,
        xp: 0,
        points: bonusPoints,
        balance: "0.00",
        streak: 0,
        status: "active",
        isAdmin: false,
        isTelegramUser: false,
        coins: bonusCoins,
        referralCode: validatedData.username || `user_${userId.slice(0, 8)}`,
        referredBy: referrerUser?.id || null,
      });

      // Create welcome notification and transaction for new user signup bonus
      const welcomeMessage = referrerUser 
        ? `You received ${bonusPoints} BantCredit for joining through a referral! Start betting and challenging friends to earn more.`
        : `You received ${BANTCREDIT_SIGNUP_REWARD} BantCredit for joining! Start betting and challenging friends to earn more.`;

      await storage.createNotification({
        userId: user.id,
        type: 'welcome_bonus',
        title: referrerUser ? 'Referral Welcome Bonus' : 'Welcome to Bantah',
        message: welcomeMessage,
        data: { points: bonusPoints, coins: bonusCoins, type: 'welcome_bonus' },
        channels: ['in_app_feed', 'push_notification'],
        fomoLevel: 'medium',
        priority: 2,
      } as any);

      // Create transaction records
      await storage.createTransaction({
        userId: user.id,
        type: 'signup_bonus',
        amount: bonusPoints.toString(),
        description: referrerUser ? 'Referral signup bonus' : 'Welcome bonus for new user registration',
        status: 'completed',
      });

      if (bonusCoins > 0) {
        await storage.createTransaction({
          userId: user.id,
          type: 'referral_bonus',
          amount: bonusCoins.toString(),
          description: 'Referral bonus coins for new user',
          status: 'completed',
        });
      }

      // Process referral rewards if applicable
      if (referrerUser) {
        // Give referrer bonus
        const referrerBonus = BANTCREDIT_REFERRER_REWARD;
        const referrerCoinBonus = 0;

        await storage.updateUserPoints(referrerUser.id, referrerBonus);
        if (referrerCoinBonus > 0) {
          await storage.updateUserCoins(referrerUser.id, referrerCoinBonus);
        }

        // Create referral record
        await storage.createReferral({
          referrerId: referrerUser.id,
          referredId: user.id,
          code: validatedData.referralCode,
          status: 'active',
        });

        // Notify referrer
        await storage.createNotification({
          userId: referrerUser.id,
          type: 'referral_success',
          title: 'Referral Success',
          message: `${user.firstName} joined using your referral code! You earned ${referrerBonus} BantCredit.`,
          data: { points: referrerBonus, referredUser: user.firstName },
          channels: ['in_app_feed', 'push_notification'],
          fomoLevel: 'medium',
          priority: 2,
        } as any);

        // Create transaction records for referrer
        await storage.createTransaction({
          userId: referrerUser.id,
          type: 'referral_reward',
          amount: referrerBonus.toString(),
          description: `Referral bonus for ${user.firstName} joining`,
          status: 'completed',
        });

        if (referrerCoinBonus > 0) {
          await storage.createTransaction({
            userId: referrerUser.id,
            type: 'referral_reward',
            amount: referrerCoinBonus.toString(),
            description: `Referral coin bonus for ${user.firstName} joining`,
            status: 'completed',
          });
        }
      }

      // Create initial daily login record for new user
      await storage.checkDailyLogin(user.id);
      const freshUser = await storage.getUser(user.id) || user;

      req.login(freshUser, (err) => {
        if (err) return next(err);
        res.status(201).json(toAuthUserPayload(freshUser));
      });
    } catch (error: any) {
      if (error.name === 'ZodError') {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      next(error);
    }
  });

  // Login endpoint
  app.post("/api/login", (req, res, next) => {
    try {
      const validatedData = loginSchema.parse(req.body);

      passport.authenticate("local", (err: any, user: any, info: any) => {
        if (err) return next(err);
        if (!user) {
          return res.status(401).json({ message: info?.message || "Authentication failed" });
        }

        req.login(user, async (err) => {
          if (err) return next(err);
          
          // Create daily login record for existing user
          await storage.checkDailyLogin(user.id);
          const freshUser = await storage.getUser(user.id) || user;

          res.json(toAuthUserPayload(freshUser));
        });
      })(req, res, next);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        const validationError = fromZodError(error);
        return res.status(400).json({ message: validationError.message });
      }
      next(error);
    }
  });

  // Logout endpoint
  app.post("/api/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.sendStatus(200);
    });
  });

  // Get current user
  app.get("/api/auth/user", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    // Normalize Privy DID to compact ID (remove "did:privy:" prefix if present)
    const userId = req.user.id.replace(/^did:privy:/, '').trim();
    const user = await storage.getUser(userId) || req.user;
    res.json(toAuthUserPayload(user));
  });
}

// Middleware to check if user is authenticated
export const isAuthenticated = (req: any, res: any, next: any) => {
  if (req.isAuthenticated() && req.user) {
    // Ensure user object has the expected structure for routes
    if (!req.user.claims) {
      req.user.claims = { 
        sub: req.user.id,
        email: req.user.email,
        first_name: req.user.firstName,
        last_name: req.user.lastName
      };
    }
    return next();
  }
  res.status(401).json({ message: "Authentication required" });
};

// Middleware to check if user is admin
export const isAdmin = async (req: any, res: any, next: any) => {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }

  if (!req.user.isAdmin) {
    return res.status(403).json({ message: "Admin access required" });
  }

  next();
};
