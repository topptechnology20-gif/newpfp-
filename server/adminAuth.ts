
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { storage } from "./storage";
import { getDelegatedAgentAuth, hasAgentScope, isAgentToken } from "./agentAuth";

interface AdminAuthRequest extends Request {
  adminUser?: any;
  user?: any;
}

type VerifiedAdminToken = {
  userId: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

type AdminTokenPayload = {
  v: 1;
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
};

const ADMIN_TOKEN_PREFIX = "adm1";
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function toBase64Url(input: Buffer | string): string {
  const raw = Buffer.isBuffer(input) ? input.toString("base64") : Buffer.from(input).toString("base64");
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const padded = `${input}${"=".repeat((4 - (input.length % 4)) % 4)}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function safeTimingEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) return false;
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function getAdminTokenSecret(): string {
  return String(process.env.ADMIN_TOKEN_SECRET || process.env.SESSION_SECRET || "").trim();
}

function getAdminTokenTtlMs(): number {
  const configured = parsePositiveInt(process.env.ADMIN_TOKEN_TTL_MS);
  return configured ?? DEFAULT_TOKEN_TTL_MS;
}

function signPayload(payloadEncoded: string, secret: string): string {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadEncoded)
    .digest();
  return toBase64Url(signature);
}

export function generateAdminToken(userId: string): string {
  const secret = getAdminTokenSecret();
  if (!secret) {
    throw new Error("ADMIN_TOKEN_SECRET (or SESSION_SECRET) must be configured to issue admin tokens");
  }

  const nowMs = Date.now();
  const payload: AdminTokenPayload = {
    v: 1,
    sub: userId,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + getAdminTokenTtlMs()) / 1000),
    nonce: crypto.randomBytes(12).toString("hex"),
  };

  const payloadEncoded = toBase64Url(JSON.stringify(payload));
  const signature = signPayload(payloadEncoded, secret);
  return `${ADMIN_TOKEN_PREFIX}.${payloadEncoded}.${signature}`;
}

function verifySignedAdminToken(adminToken: string): VerifiedAdminToken | null {
  const secret = getAdminTokenSecret();
  if (!secret) return null;

  const parts = adminToken.split(".");
  if (parts.length !== 3) return null;
  if (parts[0] !== ADMIN_TOKEN_PREFIX) return null;

  const payloadEncoded = parts[1];
  const signature = parts[2];
  if (!payloadEncoded || !signature) return null;

  const expectedSignature = signPayload(payloadEncoded, secret);
  if (!safeTimingEqual(signature, expectedSignature)) return null;

  let payload: AdminTokenPayload;
  try {
    payload = JSON.parse(fromBase64Url(payloadEncoded).toString("utf8"));
  } catch {
    return null;
  }

  if (!payload || payload.v !== 1) return null;
  if (typeof payload.sub !== "string" || !payload.sub.trim()) return null;
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSec) return null;
  if (payload.iat > nowSec + 60) return null;

  return {
    userId: payload.sub,
    issuedAtMs: payload.iat * 1000,
    expiresAtMs: payload.exp * 1000,
  };
}

function verifyLegacyAdminToken(adminToken: string): VerifiedAdminToken | null {
  const match = adminToken.match(/^admin_(.+)_(\d+)$/);
  if (!match) return null;

  const userId = match[1];
  const tokenTime = parseInt(match[2], 10);
  if (!Number.isFinite(tokenTime) || tokenTime <= 0) return null;

  const tokenAge = Date.now() - tokenTime;
  const maxAge = getAdminTokenTtlMs();
  if (tokenAge > maxAge) return null;

  return {
    userId,
    issuedAtMs: tokenTime,
    expiresAtMs: tokenTime + maxAge,
  };
}

function verifyAdminToken(adminToken: string): VerifiedAdminToken | null {
  const signed = verifySignedAdminToken(adminToken);
  if (signed) return signed;

  const allowLegacy = String(process.env.ALLOW_LEGACY_ADMIN_TOKEN || "")
    .trim()
    .toLowerCase() === "true";
  if (!allowLegacy) return null;

  return verifyLegacyAdminToken(adminToken);
}

export const adminAuth = async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
  try {
    const adminToken = req.headers.authorization?.replace('Bearer ', '');
    
    if (!adminToken) {
      return res.status(401).json({ message: 'Admin authentication required' });
    }

    const delegatedAgentAuth = await getDelegatedAgentAuth(adminToken.trim());
    if (delegatedAgentAuth) {
      if (!delegatedAgentAuth.user?.isAdmin) {
        return res.status(403).json({ message: 'Admin access denied' });
      }
      if (!hasAgentScope(delegatedAgentAuth.agentAuth, 'admin:access')) {
        return res.status(403).json({ message: 'Agent token missing admin scope' });
      }

      req.adminUser = delegatedAgentAuth.user;
      req.user = delegatedAgentAuth.user;
      (req as any).agentAuth = {
        serviceId: delegatedAgentAuth.agentAuth.serviceId,
        scopes: delegatedAgentAuth.agentAuth.scopes,
        actingAsUserId: delegatedAgentAuth.agentAuth.actingAsUserId,
        audience: delegatedAgentAuth.agentAuth.audience,
      };
      return next();
    }

    if (isAgentToken(adminToken.trim())) {
      return res.status(401).json({ message: 'Invalid or expired agent token' });
    }

    const verifiedToken = verifyAdminToken(adminToken);
    if (!verifiedToken) {
      return res.status(401).json({ message: 'Invalid or expired admin token' });
    }

    // Verify user exists and is admin
    const user = await storage.getUser(verifiedToken.userId);
    if (!user || !user.isAdmin) {
      return res.status(403).json({ message: 'Admin access denied' });
    }

    req.adminUser = user;
    // Also set `req.user` for compatibility with existing handlers
    req.user = user;
    next();
  } catch (error) {
    console.error('Admin authentication error:', error);
    res.status(500).json({ message: 'Admin authentication failed' });
  }
};
