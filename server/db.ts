import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const isProd = process.env.NODE_ENV === 'production';
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const rejectUnauthorizedRaw = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || "").trim().toLowerCase();
const rejectUnauthorized =
  rejectUnauthorizedRaw === "true"
    ? true
    : rejectUnauthorizedRaw === "false"
      ? false
      : false;
const poolMaxRaw = Number(process.env.DB_POOL_MAX || "");
const poolMax = Number.isFinite(poolMaxRaw)
  ? Math.max(1, Math.min(40, Math.floor(poolMaxRaw)))
  : isProd
    ? 25
    : 10;

type DatabaseIdentity = {
  host: string;
  database: string;
  port: number | null;
  isLocal: boolean;
};

function parseDatabaseIdentity(connectionString: string): DatabaseIdentity {
  try {
    const parsed = new URL(connectionString);
    const host = parsed.hostname || "unknown";
    const database = parsed.pathname?.replace(/^\//, "") || "unknown";
    const port = parsed.port ? Number(parsed.port) : null;
    const normalizedHost = host.toLowerCase();
    const isLocal =
      normalizedHost === "localhost" ||
      normalizedHost === "127.0.0.1" ||
      normalizedHost === "::1";
    return { host, database, port: Number.isFinite(port as number) ? port : null, isLocal };
  } catch {
    return { host: "unknown", database: "unknown", port: null, isLocal: false };
  }
}

export const DB_IDENTITY = parseDatabaseIdentity(databaseUrl);

const requireRemoteDb = isProd || String(process.env.REQUIRE_REMOTE_DATABASE || "").toLowerCase() === "true";
if (requireRemoteDb && DB_IDENTITY.isLocal) {
  throw new Error(
    `Refusing to start with local DATABASE_URL in ${isProd ? "production" : "remote-required"} mode. ` +
      "Set DATABASE_URL to a remote managed database (Railway/Supabase).",
  );
}

// Session Pooler configuration for Supabase
// Optimized for Vercel Serverless Functions
export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false,
  },
  // Keep bounded but allow concurrency; max=1 can bottleneck challenge feed queries.
  max: poolMax,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 10000, // Close idle connections after 10s so Vercel doesn't freeze them
  allowExitOnIdle: true, // Prevent the event loop from hanging on Vercel
});

pool.on('connect', () => {
  console.log(
    `[db] connected host=${DB_IDENTITY.host} db=${DB_IDENTITY.database}` +
      `${DB_IDENTITY.port ? ` port=${DB_IDENTITY.port}` : ""}`,
  );
});

pool.on('error', (err) => {
  console.error('❌ Database pool error:', err);
});

export const db = drizzle(pool, { schema });
