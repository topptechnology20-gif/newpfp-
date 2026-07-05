import crypto from "crypto";
import { storage } from "./storage";

type AgentTokenPayload = {
  v: 1;
  sub: string;
  acting_as: string;
  scopes?: string[];
  aud?: string;
  iat: number;
  exp: number;
  nonce?: string;
};

export type VerifiedAgentToken = {
  serviceId: string;
  actingAsUserId: string;
  scopes: string[];
  audience: string | null;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type DelegatedAgentAuthResult = {
  user: any;
  agentAuth: VerifiedAgentToken;
};

const AGENT_TOKEN_PREFIX = "agt1";
const DEFAULT_AGENT_TOKEN_TTL_MS = 15 * 60 * 1000;

function toBase64Url(input: Buffer | string): string {
  const raw = Buffer.isBuffer(input)
    ? input.toString("base64")
    : Buffer.from(input).toString("base64");
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

function normalizeScopes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function getAgentTokenSecret(): string {
  return String(process.env.AGENT_TOKEN_SECRET || "").trim();
}

function getAgentTokenTtlMs(): number {
  const configured = parsePositiveInt(process.env.AGENT_TOKEN_TTL_MS);
  return configured ?? DEFAULT_AGENT_TOKEN_TTL_MS;
}

function getExpectedAgentAudience(): string | null {
  const configured = String(process.env.AGENT_TOKEN_AUDIENCE || "").trim();
  return configured || null;
}

function signPayload(payloadEncoded: string, secret: string): string {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadEncoded)
    .digest();
  return toBase64Url(signature);
}

export function generateDelegatedAgentToken(params: {
  serviceId: string;
  actingAsUserId: string;
  scopes?: string[];
  audience?: string;
  ttlMs?: number;
}): string {
  const secret = getAgentTokenSecret();
  if (!secret) {
    throw new Error("AGENT_TOKEN_SECRET must be configured to issue agent tokens");
  }

  const serviceId = String(params.serviceId || "").trim();
  const actingAsUserId = String(params.actingAsUserId || "").trim();
  if (!serviceId || !actingAsUserId) {
    throw new Error("serviceId and actingAsUserId are required");
  }

  const ttlMs = params.ttlMs && params.ttlMs > 0 ? params.ttlMs : getAgentTokenTtlMs();
  const nowMs = Date.now();
  const payload: AgentTokenPayload = {
    v: 1,
    sub: serviceId,
    acting_as: actingAsUserId,
    scopes: normalizeScopes(params.scopes),
    aud: params.audience?.trim() || undefined,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + ttlMs) / 1000),
    nonce: crypto.randomBytes(12).toString("hex"),
  };

  const payloadEncoded = toBase64Url(JSON.stringify(payload));
  const signature = signPayload(payloadEncoded, secret);
  return `${AGENT_TOKEN_PREFIX}.${payloadEncoded}.${signature}`;
}

export function verifyAgentToken(agentToken: string): VerifiedAgentToken | null {
  const secret = getAgentTokenSecret();
  if (!secret) return null;

  const parts = agentToken.split(".");
  if (parts.length !== 3) return null;
  if (parts[0] !== AGENT_TOKEN_PREFIX) return null;

  const payloadEncoded = parts[1];
  const signature = parts[2];
  if (!payloadEncoded || !signature) return null;

  const expectedSignature = signPayload(payloadEncoded, secret);
  if (!safeTimingEqual(signature, expectedSignature)) return null;

  let payload: AgentTokenPayload;
  try {
    payload = JSON.parse(fromBase64Url(payloadEncoded).toString("utf8"));
  } catch {
    return null;
  }

  if (!payload || payload.v !== 1) return null;

  const serviceId = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const actingAsUserId =
    typeof payload.acting_as === "string" ? payload.acting_as.trim() : "";
  if (!serviceId || !actingAsUserId) return null;
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSec) return null;
  if (payload.iat > nowSec + 60) return null;

  const expectedAudience = getExpectedAgentAudience();
  const audience = typeof payload.aud === "string" ? payload.aud.trim() : "";
  if (expectedAudience && audience !== expectedAudience) {
    return null;
  }

  return {
    serviceId,
    actingAsUserId,
    scopes: normalizeScopes(payload.scopes),
    audience: audience || null,
    issuedAtMs: payload.iat * 1000,
    expiresAtMs: payload.exp * 1000,
  };
}

export function isAgentToken(token: string | null | undefined): boolean {
  return typeof token === "string" && token.startsWith(`${AGENT_TOKEN_PREFIX}.`);
}

export function hasAgentScope(
  agentAuth: Pick<VerifiedAgentToken, "scopes"> | null | undefined,
  requiredScope: string,
): boolean {
  if (!agentAuth) return false;
  const normalizedRequired = String(requiredScope || "").trim();
  if (!normalizedRequired) return false;

  return agentAuth.scopes.some((scope) => {
    if (scope === "*" || scope === normalizedRequired) return true;
    if (scope.endsWith("*")) {
      return normalizedRequired.startsWith(scope.slice(0, -1));
    }
    return false;
  });
}

export async function getDelegatedAgentAuth(
  token: string,
): Promise<DelegatedAgentAuthResult | null> {
  const agentAuth = verifyAgentToken(token);
  if (!agentAuth) return null;

  const user = await storage.getUser(agentAuth.actingAsUserId);
  if (!user) return null;

  return { user, agentAuth };
}

export async function getDelegatedAgentUserIdFromAuthHeader(
  authHeader: string | undefined,
): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;

  const delegatedAuth = await getDelegatedAgentAuth(token);
  return delegatedAuth?.user?.id || null;
}
