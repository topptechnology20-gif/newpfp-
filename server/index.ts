import "dotenv/config";

// Suppress gramJS/telegram library logging
if (typeof window === "undefined") {
  const originalLog = console.log;
  console.log = function (...args: any[]) {
    const message = args.join(" ");
    if (
      !message.includes("[INFO]") &&
      !message.includes("gramJS") &&
      !message.includes("Running gramJS") &&
      !message.includes("Connecting to") &&
      !message.includes("Connection to") &&
      !message.includes("Using LAYER")
    ) {
      originalLog.apply(console, args);
    }
  };
}

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { registerRoutes } from "./routes";
import { addAuthTestRoutes } from "./authTest";
import { registerCronRoutes } from "./cronRoutes";
import { createBantahBroTelegramBot, createTelegramBot } from "./telegramBot";
import { NotificationAlgorithmService } from "./notificationAlgorithm";
import { seedAdmin } from "./seedAdmin";
import { initializeDatabase } from "./initDb";
import {
  ensureBantahBroTelegramRuntimeStarted,
  isBantahBroElizaTelegramEnabled,
} from "./bantahBro/systemAgent";
import { startBantahBroAutomationService } from "./bantahBro/automationService";
import { startBantahBroAgentBattleTelegramBroadcaster } from "./bantahBro/agentBattleTelegramBroadcaster";
import { startBantahBroAgentBattleSettlementWorker } from "./bantahBro/agentBattleSettlementWorker";
import { cleanupExpiredListingReservations } from "./bantahBro/gen1EconomyService";
import { BLINK_ACTION_HEADERS, isBlinkActionRequest } from "./blinkActionHeaders";

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function log(message: string) {
  console.log(message);
}

function resolveConfiguredTelegramWebhookUrl(explicitEnvName: string, routePath: string) {
  const explicit = String(process.env[explicitEnvName] || "").trim();
  if (explicit) return explicit;

  const externalBase = normalizePublicBaseUrl(
    process.env.RENDER_EXTERNAL_URL ||
      process.env.FRONTEND_URL ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      process.env.VERCEL_URL ||
      "",
  );
  if (!externalBase) return null;

  try {
    return new URL(routePath, externalBase).toString();
  } catch {
    return null;
  }
}

function normalizePublicBaseUrl(value: unknown) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function resolveTelegramWebhookUrl() {
  return resolveConfiguredTelegramWebhookUrl(
    "TELEGRAM_BOT_WEBHOOK_URL",
    "/api/telegram/bot-webhook",
  );
}

function resolveBantahBroTelegramWebhookUrl() {
  return resolveConfiguredTelegramWebhookUrl(
    "BANTAHBRO_TELEGRAM_BOT_WEBHOOK_URL",
    "/api/telegram/bantahbro-webhook",
  );
}

function isPlatformTelegramBotEnabled() {
  return String(process.env.TELEGRAM_BOT_ENABLED || "true").trim().toLowerCase() !== "false";
}

function parseBooleanEnv(name: string, fallback = false) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isLocalDevRuntime() {
  return process.env.npm_lifecycle_event === "dev" || process.env.NODE_ENV !== "production";
}

function shouldUseBantahBroElizaTelegramRuntime() {
  return isBantahBroElizaTelegramEnabled() && !isLocalDevRuntime();
}

function parseIntegerEnv(name: string, fallback: number) {
  const raw = Number.parseInt(String(process.env[name] || "").trim(), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function shouldRunBackgroundWorkers() {
  if (!isLocalDevRuntime()) return true;
  return parseBooleanEnv("LOCAL_DEV_BACKGROUND_WORKERS", false);
}

async function initializeTelegramBotRuntime(options: {
  bot: {
    testConnection: () => Promise<unknown>;
    setupWebhook: (webhookUrl: string) => Promise<boolean>;
    startPolling?: () => Promise<void>;
  } | null;
  label: string;
  webhookUrl: string | null;
  enableWebhook: boolean;
  allowPollingFallback: boolean;
}) {
  const { bot, label, webhookUrl, enableWebhook, allowPollingFallback } = options;

  if (!bot) return;

  try {
    await bot.testConnection();

    if (enableWebhook && webhookUrl) {
      await bot.setupWebhook(webhookUrl);
      return;
    }

    if (allowPollingFallback && typeof bot.startPolling === "function") {
      console.log(`[INIT] ${label} Telegram bot starting in polling mode`);
      await bot.startPolling();
      return;
    }

    console.warn(
      `[WARN] ${label} Telegram bot connected but is not listening. ` +
        `Set a public webhook URL or enable local polling.`,
    );
  } catch (err) {
    console.error(`[WARN] ${label} Telegram bot connection test failed:`, err);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientPublicPath = path.resolve(__dirname, "../client/public");
const twoDGamePath = path.join(clientPublicPath, "2dgame");

function isMainModule() {
  // After bundling with esbuild, __filename may not match process.argv[1] exactly.
  // Instead, check if the entry point ends with the expected bundle name or if it's
  // being executed directly (not being required/imported as a module).
  const entrypoint = process.argv[1] || "";
  if (!entrypoint) return false;
  
  // Check if it looks like our built index.js or if it contains server/index
  if (entrypoint.includes("dist/index.js") || entrypoint.includes("dist/index")) {
    return true;
  }
  
  // Fallback to original check for dev environments
  try {
    return path.resolve(entrypoint) === __filename;
  } catch {
    return false;
  }
}

function isVercelRuntime() {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

function register2DGameStatic(app: Express) {
  if (!fs.existsSync(twoDGamePath)) return;

  app.get(["/2dgame", "/2dgame/"], (_req, res) => {
    res.sendFile(path.join(twoDGamePath, "index.html"));
  });
  app.use("/2dgame", express.static(twoDGamePath));
}

// -------------------------------------------------------------------
// App setup
// -------------------------------------------------------------------

const app = express();

// Multer config
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "coverImage" || file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  }
});

// Webhooks & parsers
app.use("/api/webhook/paystack", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false, limit: "50mb" }));

// File uploads
app.use("/api/admin/", upload.any());

// Blinks require permissive CORS preflight headers. This must run before the
// global app CORS middleware, which otherwise handles OPTIONS first.
app.use((req, res, next) => {
  if (!isBlinkActionRequest(req)) {
    return next();
  }

  res.set(BLINK_ACTION_HEADERS);
  if (req.method === "OPTIONS") {
    return res.status(204).send();
  }
  return next();
});

const configuredCorsOrigins = [
  process.env.FRONTEND_URL,
  process.env.PUBLIC_APP_URL,
  "https://bota.bantah.fun",
  "https://onchain.bantah.fun",
  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:5173",
]
  .flatMap((value) => String(value || "").split(","))
  .map((value) => value.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const corsAllowedOrigins = new Set(configuredCorsOrigins);

// CORS
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalizedOrigin = origin.replace(/\/+$/, "");
      return callback(null, corsAllowedOrigins.has(normalizedOrigin) ? origin : false);
    },
    credentials: true
  })
);

// Cache control
app.use((_req, res, next) => {
  res.header("Cache-Control", "no-cache, no-store, must-revalidate");
  res.header("Pragma", "no-cache");
  res.header("Expires", "0");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    runtime: isVercelRuntime() ? "vercel" : "node",
    timestamp: new Date().toISOString(),
  });
});

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;

  res.on("finish", () => {
    if (reqPath.startsWith("/api")) {
      const duration = Date.now() - start;
      log(`${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

// -------------------------------------------------------------------
// Main bootstrap
// -------------------------------------------------------------------

async function startHttpServer() {
  registerCronRoutes(app);

  // Routes
  const server = await registerRoutes(app, upload);
  addAuthTestRoutes(app);

  // Global error handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ message: err.message || "Internal Server Error" });
  });

  // -----------------------------------------------------------------
  // Frontend handling
  // -----------------------------------------------------------------

  const distPublicPath = path.resolve(__dirname, "../dist/public");
  register2DGameStatic(app);

  // `npm run dev` must always use Vite, even when local .env mirrors production.
  const isDevCommand = process.env.npm_lifecycle_event === "dev";
  if (isDevCommand || process.env.NODE_ENV !== "production") {
    // Dev only: dynamic Vite import
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    // Production: serve static files
    if (fs.existsSync(distPublicPath)) {
      const rootPublicPath = path.resolve(__dirname, "../public");
      const mapPublicPath = path.resolve(__dirname, "../map");

      // Serve source public assets first so runtime files like service workers/fonts
      // are available even when omitted from dist by the build pipeline.
      app.use("/assets", express.static(path.join(clientPublicPath, "assets")));
      app.use("/fonts", express.static(path.join(clientPublicPath, "fonts")));
      app.use("/map", express.static(mapPublicPath));
      app.use(express.static(clientPublicPath));
      app.use(express.static(rootPublicPath));
      
      // Serve server-side assets (avatars, arena pictures, etc.)
      const serverAssetsPath = path.resolve(__dirname, "../server/assets");
      app.use("/assets", express.static(serverAssetsPath));

      app.use(express.static(distPublicPath));

      app.get("*", (_req, res) => {
        res.sendFile(path.join(distPublicPath, "index.html"));
      });
    }
  }

  // -----------------------------------------------------------------
  // Start server (hosting providers inject PORT)
  // -----------------------------------------------------------------

  const port = Number(process.env.PORT || 5000);

  server.listen(
    {
      port,
      host: "0.0.0.0",
      // Windows does not support SO_REUSEPORT on Node HTTP servers.
      reusePort: process.platform !== "win32"
    },
    () => {
      log(`[OK] Server running on port ${port}`);
    }
  );
  // Run slow/non-critical startup tasks in the background so deploy healthchecks pass quickly.
  void (async () => {
    const runBackgroundWorkers = shouldRunBackgroundWorkers();
    if (!runBackgroundWorkers) {
      console.log(
        "[INIT] Local dev background workers disabled. Set LOCAL_DEV_BACKGROUND_WORKERS=true to enable Telegram, automation, indexer, and schedulers.",
      );
    }

    if (runBackgroundWorkers) {
      // Telegram bot (safe in production)
      if (isPlatformTelegramBotEnabled()) {
        await initializeTelegramBotRuntime({
          bot: createTelegramBot(),
          label: "Platform",
          webhookUrl: resolveTelegramWebhookUrl(),
          enableWebhook:
            String(process.env.TELEGRAM_BOT_ENABLE_WEBHOOK || "true").trim().toLowerCase() !==
            "false",
          allowPollingFallback: !isLocalDevRuntime(),
        });
      } else {
        console.log("[INIT] Platform Telegram bot disabled by TELEGRAM_BOT_ENABLED=false");
      }
    }

    // Initialize database
    try {
      await initializeDatabase();
    } catch (err) {
      console.error("[ERROR] Failed to initialize database:", err);
    }

    if (runBackgroundWorkers) {
      try {
        const { restoreManagedBantahAgentRuntimes } = await import("./bantahElizaRuntimeManager");
        const restored = await restoreManagedBantahAgentRuntimes();
        console.log(`[OK] Bantah Eliza runtimes restored: ${restored.started}/${restored.attempted}`);
      } catch (err) {
        console.error("[WARN] Failed to restore Bantah Eliza runtimes:", err);
      }

      const bantahBroTelegramBot = createBantahBroTelegramBot();
      if (bantahBroTelegramBot) {
        try {
          await bantahBroTelegramBot.syncBantahBroProfile();
        } catch (err) {
          console.error("[WARN] Failed to sync BantahBro Telegram profile:", err);
        }
      }

      if (shouldUseBantahBroElizaTelegramRuntime()) {
        try {
          const result = await ensureBantahBroTelegramRuntimeStarted();
          console.log(
            `[OK] BantahBro Eliza Telegram runtime ready: ${result.systemAgent.agentId} (${result.runtime?.status || "no-runtime"})`,
          );
        } catch (err) {
          console.error("[WARN] Failed to start BantahBro Eliza Telegram runtime:", err);
        }
      } else {
        if (isBantahBroElizaTelegramEnabled() && isLocalDevRuntime()) {
          console.log(
            "[INIT] Local dev detected. Using classic BantahBro Telegram polling instead of the Eliza Telegram plugin.",
          );
        }
        await initializeTelegramBotRuntime({
          bot: bantahBroTelegramBot,
          label: "BantahBro",
          webhookUrl: resolveBantahBroTelegramWebhookUrl(),
          enableWebhook:
            String(process.env.BANTAHBRO_TELEGRAM_BOT_ENABLE_WEBHOOK || "true")
              .trim()
              .toLowerCase() !== "false",
          allowPollingFallback: true,
        });
      }

      try {
        const battleBroadcastStatus = startBantahBroAgentBattleTelegramBroadcaster();
        console.log(
          `[OK] BantahBro Telegram battle broadcaster: enabled=${battleBroadcastStatus.enabled} started=${battleBroadcastStatus.started} intervalMs=${battleBroadcastStatus.intervalMs} limit=${battleBroadcastStatus.limit}${battleBroadcastStatus.reason ? ` reason=${battleBroadcastStatus.reason}` : ""}`,
        );
      } catch (err) {
        console.error("[WARN] Failed to start BantahBro Telegram battle broadcaster:", err);
      }

      try {
        const settlementStatus = startBantahBroAgentBattleSettlementWorker();
        console.log(
          `[OK] BantahBro battle settlement worker: enabled=${settlementStatus.enabled} started=${settlementStatus.started} intervalMs=${settlementStatus.intervalMs} limit=${settlementStatus.limit} maxPairs=${settlementStatus.maxPairsPerRound}${settlementStatus.reason ? ` reason=${settlementStatus.reason}` : ""}`,
        );
      } catch (err) {
        console.error("[WARN] Failed to start BantahBro battle settlement worker:", err);
      }
      try {
        const cleanupIntervalMs = Math.max(10_000, parseIntegerEnv("GEN1_RESERVATION_CLEANUP_INTERVAL_MS", 30_000));
        setTimeout(() => {
          void cleanupExpiredListingReservations().catch((error) => {
            console.error("[WARN] Initial Gen1 reservation cleanup failed:", error);
          });
        }, 0).unref?.();
        const cleanupTimer = setInterval(() => {
          void cleanupExpiredListingReservations().catch((error) => {
            console.error("[WARN] Gen1 reservation cleanup failed:", error);
          });
        }, cleanupIntervalMs);
        cleanupTimer.unref?.();
        console.log(`[OK] Gen1 reservation cleanup worker started: intervalMs=${cleanupIntervalMs}`);
      } catch (err) {
        console.error("[WARN] Failed to start Gen1 reservation cleanup worker:", err);
      }

      try {
        const automationStatus = await startBantahBroAutomationService();
        console.log(
          `[OK] BantahBro automation ready: enabled=${automationStatus.enabled} watchlist=${automationStatus.watchlistSize}`,
        );
      } catch (err) {
        console.error("[WARN] Failed to start BantahBro automation:", err);
      }

      // Onchain indexer (optional)
      try {
        const { startOnchainIndexer } = await import("./onchainIndexer");
        startOnchainIndexer();
      } catch (err) {
        console.error("[WARN] Failed to start onchain indexer:", err);
      }

      // Notification service
      try {
        const { storage } = await import("./storage");
        const notificationAlgorithm = new NotificationAlgorithmService(storage);
        notificationAlgorithm.startNotificationScheduler();
      } catch (err) {
        console.error("[WARN] Failed to start notification scheduler:", err);
      }

      // Lifecycle notifications (for local arena simulation)
      try {
        const { runBotaLifecycleNotificationsOnce } = await import("./bantahBro/botaLifecycleNotificationService");
        setInterval(() => {
          void runBotaLifecycleNotificationsOnce().catch((err) => {
            console.error("[WARN] Lifecycle tick failed:", err);
          });
        }, 15000);
        console.log("[OK] BOTA Lifecycle interval started");
      } catch (err) {
        console.error("[WARN] Failed to start BOTA Lifecycle interval:", err);
      }
    }

    // Seed admin users
    try {
      await seedAdmin();
    } catch (err) {
      console.error("[ERROR] Failed to seed admin users:", err);
    }
  })();
}

if (isMainModule() && !isVercelRuntime()) {
  startHttpServer().catch((err) => {
    console.error("[ERROR] Failed to start server:", err);
    process.exit(1);
  });
}

// -------------------------------------------------------------------
// Serverless export
// -------------------------------------------------------------------

export async function initAppForServerless() {
  try {
    console.log("[INIT] Initializing serverless app...");
    const runServerlessBackgroundWorkers =
      parseBooleanEnv("VERCEL_ENABLE_BACKGROUND_WORKERS", false) ||
      parseBooleanEnv("SERVERLESS_BACKGROUND_WORKERS", false);

    // Initialize database
    if (parseBooleanEnv("SERVERLESS_INIT_DB", !isVercelRuntime())) {
      try {
        await initializeDatabase();
        console.log("[OK] Database initialized");
      } catch (err) {
        console.error("[ERROR] Failed to initialize database:", err);
      }
    } else {
      console.log("[INIT] Serverless database initialization disabled.");
    }

    // Register routes
    console.log("[INIT] Registering routes...");
    registerCronRoutes(app);
    await registerRoutes(app, upload);
    console.log("[OK] Routes registered");

    addAuthTestRoutes(app);

    if (runServerlessBackgroundWorkers) {
      // Serverless background workers are opt-in because Vercel Functions are
      // request-scoped. Prefer webhooks or Vercel Cron for recurring work.
      const telegramBot = isPlatformTelegramBotEnabled() ? createTelegramBot() : null;
      if (isPlatformTelegramBotEnabled()) {
        await initializeTelegramBotRuntime({
          bot: telegramBot,
          label: "Platform",
          webhookUrl: resolveTelegramWebhookUrl(),
          enableWebhook:
            String(process.env.TELEGRAM_BOT_ENABLE_WEBHOOK || "true").trim().toLowerCase() !==
            "false",
          allowPollingFallback: false,
        });
      } else {
        console.log("[INIT] Platform Telegram bot disabled by TELEGRAM_BOT_ENABLED=false");
      }
      if (telegramBot) {
        console.log("[OK] Telegram bot connected");
      }

      const bantahBroTelegramBot = createBantahBroTelegramBot();
      if (bantahBroTelegramBot) {
        try {
          await bantahBroTelegramBot.syncBantahBroProfile();
        } catch (err) {
          console.error("[WARN] Failed to sync BantahBro Telegram profile:", err);
        }
      }
      if (shouldUseBantahBroElizaTelegramRuntime()) {
        try {
          const result = await ensureBantahBroTelegramRuntimeStarted();
          console.log(
            `[OK] BantahBro Eliza Telegram runtime ready: ${result.systemAgent.agentId} (${result.runtime?.status || "no-runtime"})`,
          );
        } catch (err) {
          console.error("[WARN] BantahBro Eliza Telegram runtime failed (non-critical)", err);
        }
      } else {
        await initializeTelegramBotRuntime({
          bot: bantahBroTelegramBot,
          label: "BantahBro",
          webhookUrl: resolveBantahBroTelegramWebhookUrl(),
          enableWebhook:
            String(process.env.BANTAHBRO_TELEGRAM_BOT_ENABLE_WEBHOOK || "true")
              .trim()
              .toLowerCase() !== "false",
          allowPollingFallback: false,
        });
        if (bantahBroTelegramBot) {
          console.log("[OK] BantahBro Telegram bot connected");
        }
      }

      try {
        const automationStatus = await startBantahBroAutomationService();
        console.log(
          `[OK] BantahBro automation ready: enabled=${automationStatus.enabled} watchlist=${automationStatus.watchlistSize}`,
        );
      } catch (err) {
        console.error("[WARN] BantahBro automation failed (non-critical)", err);
      }

      try {
        const settlementStatus = startBantahBroAgentBattleSettlementWorker();
        console.log(
          `[OK] BantahBro battle settlement worker: enabled=${settlementStatus.enabled} started=${settlementStatus.started} intervalMs=${settlementStatus.intervalMs} limit=${settlementStatus.limit} maxPairs=${settlementStatus.maxPairsPerRound}${settlementStatus.reason ? ` reason=${settlementStatus.reason}` : ""}`,
        );
      } catch (err) {
        console.error("[WARN] BantahBro battle settlement worker failed (non-critical)", err);
      }

      try {
        await cleanupExpiredListingReservations();
        console.log("[OK] Serverless Gen1 reservation cleanup completed");
      } catch (err) {
        console.error("[WARN] Serverless Gen1 reservation cleanup failed:", err);
      }

      try {
        const { storage } = await import("./storage");
        const notificationAlgorithm = new NotificationAlgorithmService(storage);
        notificationAlgorithm.startNotificationScheduler();
        console.log("[OK] Notification service started");
      } catch (err) {
        console.error("[WARN] Notification service failed:", err);
      }

      // Lifecycle notifications (for local arena simulation)
      try {
        const { runBotaLifecycleNotificationsOnce } = await import("./bantahBro/botaLifecycleNotificationService");
        setInterval(() => {
          void runBotaLifecycleNotificationsOnce().catch((err) => {
            console.error("[WARN] Lifecycle tick failed:", err);
          });
        }, 15000);
        console.log("[OK] BOTA Lifecycle interval started");
      } catch (err) {
        console.error("[WARN] Failed to start BOTA Lifecycle interval:", err);
      }
    } else {
      console.log(
        "[INIT] Serverless background workers disabled. Use webhooks or Vercel Cron for recurring work.",
      );
    }

    // Seed admin users
    try {
      await seedAdmin();
      console.log("[OK] Admin users seeded");
    } catch (err) {
      console.error("[WARN] Admin seed failed:", err);
    }

    // Global error handler
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      res.status(status).json({ message: err.message || "Internal Server Error" });
    });

    console.log("[OK] Serverless app initialized successfully");
    return app;
  } catch (err) {
    console.error("[ERROR] Error initializing serverless app:", err);
    throw err;
  }
}
