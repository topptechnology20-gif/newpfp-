import { pool } from "./db";

export type PartnerMemberRole = "owner" | "manager" | "moderator" | "viewer";
export type PartnerWithdrawalDecisionAction = "approve" | "reject";
export type PartnerSignupStatus = "pending" | "reviewing" | "approved" | "rejected";

const PARTNER_ROLES: PartnerMemberRole[] = ["owner", "manager", "moderator", "viewer"];

let tablesReady = false;

function toInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function nowIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function parseJsonObject(value: unknown): Record<string, any> | null {
  if (value == null) return null;
  if (typeof value === "object") return value as Record<string, any>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed as Record<string, any>;
    } catch {
      return null;
    }
  }
  return null;
}

async function ensurePartnerWalletRow(programId: number, queryable: { query: (text: string, params?: any[]) => Promise<any> } = pool) {
  await queryable.query(
    `
      INSERT INTO partner_wallets (program_id)
      VALUES ($1)
      ON CONFLICT (program_id) DO NOTHING
    `,
    [programId],
  );
}

export function normalizePartnerSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export async function ensurePartnerProgramTables(): Promise<void> {
  if (tablesReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_programs (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      slug VARCHAR(80) NOT NULL UNIQUE,
      logo_url VARCHAR(255),
      badge_text VARCHAR(40),
      owner_user_id VARCHAR(255) NOT NULL,
      group_id INTEGER,
      default_fee_bps INTEGER NOT NULL DEFAULT 1000,
      chat_monitor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_program_members (
      id SERIAL PRIMARY KEY,
      program_id INTEGER NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'viewer',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      added_by VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(program_id, user_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_challenges (
      id SERIAL PRIMARY KEY,
      program_id INTEGER NOT NULL,
      challenge_id INTEGER NOT NULL UNIQUE,
      partner_fee_bps INTEGER NOT NULL DEFAULT 1000,
      chat_monitor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      settlement_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_by VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_fee_settlements (
      id SERIAL PRIMARY KEY,
      program_id INTEGER NOT NULL,
      challenge_id INTEGER NOT NULL UNIQUE,
      total_pool BIGINT NOT NULL DEFAULT 0,
      platform_fee BIGINT NOT NULL DEFAULT 0,
      partner_fee BIGINT NOT NULL DEFAULT 0,
      settled_by VARCHAR(255),
      settled_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_wallets (
      program_id INTEGER PRIMARY KEY,
      balance BIGINT NOT NULL DEFAULT 0,
      total_credited BIGINT NOT NULL DEFAULT 0,
      total_withdrawn BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_wallet_transactions (
      id SERIAL PRIMARY KEY,
      program_id INTEGER NOT NULL,
      challenge_id INTEGER,
      settlement_id INTEGER,
      withdrawal_id INTEGER,
      type VARCHAR(40) NOT NULL,
      amount BIGINT NOT NULL,
      balance_after BIGINT NOT NULL DEFAULT 0,
      meta JSONB,
      created_by VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(settlement_id, type)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_withdrawals (
      id SERIAL PRIMARY KEY,
      program_id INTEGER NOT NULL,
      requested_by VARCHAR(255) NOT NULL,
      amount BIGINT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      destination JSONB,
      note TEXT,
      review_note TEXT,
      processed_by VARCHAR(255),
      processed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_signup_applications (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(120) NOT NULL,
      email VARCHAR(255) NOT NULL,
      community_name VARCHAR(160) NOT NULL,
      role_title VARCHAR(80),
      phone VARCHAR(40),
      telegram_handle VARCHAR(120),
      website VARCHAR(255),
      community_cover_image_url VARCHAR(255),
      social_links JSONB,
      notes TEXT,
      requested_by_user_id VARCHAR(255),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      reviewed_by VARCHAR(255),
      review_note TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_programs_owner ON partner_programs(owner_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_program_members_user ON partner_program_members(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_challenges_program ON partner_challenges(program_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_wallet_transactions_program ON partner_wallet_transactions(program_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_withdrawals_program ON partner_withdrawals(program_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_withdrawals_status ON partner_withdrawals(status, created_at ASC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_signup_status ON partner_signup_applications(status, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_signup_email ON partner_signup_applications(email, created_at DESC)`);
  await pool.query(`ALTER TABLE partner_signup_applications ADD COLUMN IF NOT EXISTS social_links JSONB`);
  await pool.query(`ALTER TABLE partner_signup_applications ADD COLUMN IF NOT EXISTS community_cover_image_url VARCHAR(255)`);
  await pool.query(`ALTER TABLE partner_programs ADD COLUMN IF NOT EXISTS logo_url VARCHAR(255)`);
  await pool.query(`ALTER TABLE partner_programs ADD COLUMN IF NOT EXISTS badge_text VARCHAR(40)`);

  tablesReady = true;
}

function mapProgramRow(row: any) {
  return {
    id: toInt(row.id),
    name: String(row.name || ""),
    slug: String(row.slug || ""),
    logoUrl: toNullableString(row.logo_url),
    badgeText: toNullableString(row.badge_text),
    ownerUserId: String(row.owner_user_id || ""),
    groupId: row.group_id == null ? null : toInt(row.group_id),
    defaultFeeBps: toInt(row.default_fee_bps, 1000),
    chatMonitorEnabled: Boolean(row.chat_monitor_enabled),
    status: String(row.status || "active"),
    createdAt: nowIso(row.created_at),
    updatedAt: nowIso(row.updated_at),
  };
}

export async function getPartnerProgramById(programId: number) {
  await ensurePartnerProgramTables();
  const result = await pool.query(`SELECT * FROM partner_programs WHERE id = $1 LIMIT 1`, [programId]);
  if (!result.rows[0]) return null;
  return mapProgramRow(result.rows[0]);
}

export async function listPartnerProgramsForUser(userId: string, isAdmin: boolean) {
  await ensurePartnerProgramTables();
  const result = await pool.query(
    `
      SELECT DISTINCT p.*
      FROM partner_programs p
      LEFT JOIN partner_program_members m
        ON m.program_id = p.id
       AND m.status = 'active'
      WHERE $2::boolean = TRUE
         OR p.owner_user_id = $1
         OR m.user_id = $1
      ORDER BY p.created_at DESC
    `,
    [userId, isAdmin],
  );

  return result.rows.map(mapProgramRow);
}

export async function getPartnerDashboardAccess(input: {
  userId: string;
  email?: string | null;
  isAdmin: boolean;
}) {
  await ensurePartnerProgramTables();

  if (input.isAdmin) {
    return { allowed: true, reason: "admin" as const };
  }

  const activeProgramAccess = await pool.query(
    `
      SELECT 1
      FROM partner_programs p
      LEFT JOIN partner_program_members m
        ON m.program_id = p.id
       AND m.status = 'active'
      WHERE p.owner_user_id = $1
         OR m.user_id = $1
      LIMIT 1
    `,
    [input.userId],
  );

  if (activeProgramAccess.rows.length > 0) {
    return { allowed: true, reason: "program_member" as const };
  }

  const normalizedEmail = (input.email || "").trim().toLowerCase();
  const registeredSignup = normalizedEmail
    ? await pool.query(
        `
          SELECT 1
          FROM partner_signup_applications
          WHERE status IN ('pending', 'reviewing', 'approved')
            AND (
              requested_by_user_id = $1
              OR lower(email) = lower($2)
            )
          LIMIT 1
        `,
        [input.userId, normalizedEmail],
      )
    : await pool.query(
        `
          SELECT 1
          FROM partner_signup_applications
          WHERE status IN ('pending', 'reviewing', 'approved')
            AND requested_by_user_id = $1
          LIMIT 1
        `,
        [input.userId],
      );

  if (registeredSignup.rows.length > 0) {
    return { allowed: true, reason: "registered_signup" as const };
  }

  return { allowed: false, reason: "not_partner" as const };
}

export async function createPartnerProgram(input: {
  name: string;
  slug: string;
  ownerUserId: string;
  logoUrl?: string | null;
  badgeText?: string | null;
  groupId?: number | null;
  defaultFeeBps?: number;
  chatMonitorEnabled?: boolean;
}) {
  await ensurePartnerProgramTables();

  const normalizedSlug = normalizePartnerSlug(input.slug || input.name);
  if (!normalizedSlug) {
    throw new Error("Invalid partner slug");
  }

  const defaultFeeBps = Math.max(0, Math.min(10000, toInt(input.defaultFeeBps, 1000)));
  const groupId = input.groupId == null ? null : toInt(input.groupId);

  const created = await pool.query(
    `
      INSERT INTO partner_programs (
        name,
        slug,
        logo_url,
        badge_text,
        owner_user_id,
        group_id,
        default_fee_bps,
        chat_monitor_enabled
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `,
    [
      input.name.trim(),
      normalizedSlug,
      toNullableString(input.logoUrl || null),
      toNullableString(input.badgeText || null),
      input.ownerUserId,
      groupId,
      defaultFeeBps,
      input.chatMonitorEnabled ?? true,
    ],
  );

  const program = mapProgramRow(created.rows[0]);

  await pool.query(
    `
      INSERT INTO partner_program_members (program_id, user_id, role, status, added_by)
      VALUES ($1, $2, 'owner', 'active', $2)
      ON CONFLICT (program_id, user_id)
      DO UPDATE SET role = 'owner', status = 'active', updated_at = NOW()
    `,
    [program.id, input.ownerUserId],
  );

  await ensurePartnerWalletRow(program.id);

  return program;
}

export async function getPartnerProgramRole(programId: number, userId: string, isAdmin: boolean): Promise<PartnerMemberRole | "admin" | null> {
  await ensurePartnerProgramTables();

  if (isAdmin) return "admin";

  const ownerResult = await pool.query(
    `SELECT owner_user_id FROM partner_programs WHERE id = $1 LIMIT 1`,
    [programId],
  );

  if (!ownerResult.rows[0]) return null;
  if (String(ownerResult.rows[0].owner_user_id) === userId) return "owner";

  const memberResult = await pool.query(
    `
      SELECT role
      FROM partner_program_members
      WHERE program_id = $1 AND user_id = $2 AND status = 'active'
      LIMIT 1
    `,
    [programId, userId],
  );

  const role = memberResult.rows[0]?.role;
  if (!role || !PARTNER_ROLES.includes(role)) return null;
  return role as PartnerMemberRole;
}

export async function canManagePartnerProgram(programId: number, userId: string, isAdmin: boolean): Promise<boolean> {
  const role = await getPartnerProgramRole(programId, userId, isAdmin);
  return role === "admin" || role === "owner" || role === "manager";
}

export async function canViewPartnerProgram(programId: number, userId: string, isAdmin: boolean): Promise<boolean> {
  const role = await getPartnerProgramRole(programId, userId, isAdmin);
  return role !== null;
}

export async function upsertPartnerProgramMember(input: {
  programId: number;
  userId: string;
  role: PartnerMemberRole;
  addedBy: string;
}) {
  await ensurePartnerProgramTables();

  if (!PARTNER_ROLES.includes(input.role)) {
    throw new Error("Invalid partner role");
  }

  const result = await pool.query(
    `
      INSERT INTO partner_program_members (program_id, user_id, role, status, added_by)
      VALUES ($1, $2, $3, 'active', $4)
      ON CONFLICT (program_id, user_id)
      DO UPDATE SET role = EXCLUDED.role, status = 'active', added_by = EXCLUDED.added_by, updated_at = NOW()
      RETURNING *
    `,
    [input.programId, input.userId, input.role, input.addedBy],
  );

  return result.rows[0];
}

export async function listPartnerProgramMembers(programId: number) {
  await ensurePartnerProgramTables();

  const result = await pool.query(
    `
      SELECT
        m.id,
        m.program_id,
        m.user_id,
        m.role,
        m.status,
        m.added_by,
        m.created_at,
        m.updated_at,
        u.username,
        u.first_name,
        u.last_name,
        u.profile_image_url
      FROM partner_program_members m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.program_id = $1
      ORDER BY
        CASE m.role
          WHEN 'owner' THEN 1
          WHEN 'manager' THEN 2
          WHEN 'moderator' THEN 3
          ELSE 4
        END,
        m.created_at ASC
    `,
    [programId],
  );

  return result.rows.map((row) => ({
    id: toInt(row.id),
    programId: toInt(row.program_id),
    userId: String(row.user_id || ""),
    role: String(row.role || "viewer"),
    status: String(row.status || "active"),
    addedBy: row.added_by == null ? null : String(row.added_by),
    createdAt: nowIso(row.created_at),
    updatedAt: nowIso(row.updated_at),
    user: {
      username: row.username == null ? null : String(row.username),
      firstName: row.first_name == null ? null : String(row.first_name),
      lastName: row.last_name == null ? null : String(row.last_name),
      profileImageUrl: row.profile_image_url == null ? null : String(row.profile_image_url),
    },
  }));
}

export async function attachChallengeToPartnerProgram(input: {
  programId: number;
  challengeId: number;
  partnerFeeBps?: number;
  chatMonitorEnabled?: boolean;
  createdBy: string;
}) {
  await ensurePartnerProgramTables();

  const bps = Math.max(0, Math.min(10000, toInt(input.partnerFeeBps, 1000)));

  const result = await pool.query(
    `
      INSERT INTO partner_challenges (
        program_id,
        challenge_id,
        partner_fee_bps,
        chat_monitor_enabled,
        created_by
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (challenge_id)
      DO UPDATE SET
        program_id = EXCLUDED.program_id,
        partner_fee_bps = EXCLUDED.partner_fee_bps,
        chat_monitor_enabled = EXCLUDED.chat_monitor_enabled,
        updated_at = NOW()
      RETURNING *
    `,
    [
      input.programId,
      input.challengeId,
      bps,
      input.chatMonitorEnabled ?? true,
      input.createdBy,
    ],
  );

  return result.rows[0];
}

export async function getPartnerChallengeMeta(challengeId: number) {
  await ensurePartnerProgramTables();

  const result = await pool.query(
    `
      SELECT pc.*, p.name AS program_name, p.slug AS program_slug, p.owner_user_id
      FROM partner_challenges pc
      INNER JOIN partner_programs p ON p.id = pc.program_id
      WHERE pc.challenge_id = $1
      LIMIT 1
    `,
    [challengeId],
  );

  if (!result.rows[0]) return null;

  const row = result.rows[0];
  return {
    id: toInt(row.id),
    programId: toInt(row.program_id),
    challengeId: toInt(row.challenge_id),
    partnerFeeBps: toInt(row.partner_fee_bps, 1000),
    chatMonitorEnabled: Boolean(row.chat_monitor_enabled),
    settlementStatus: String(row.settlement_status || "pending"),
    programName: String(row.program_name || ""),
    programSlug: String(row.program_slug || ""),
    ownerUserId: String(row.owner_user_id || ""),
  };
}

export async function listPartnerChallenges(programId: number, limit = 50) {
  await ensurePartnerProgramTables();

  const safeLimit = Math.max(1, Math.min(200, toInt(limit, 50)));

  const result = await pool.query(
    `
      SELECT
        pc.program_id,
        pc.challenge_id,
        pc.partner_fee_bps,
        pc.chat_monitor_enabled,
        pc.settlement_status,
        pc.created_at AS linked_at,
        c.title,
        c.description,
        c.category,
        c.amount,
        c.status,
        c.admin_created,
        c.due_date,
        c.created_at,
        c.result,
        COALESCE(pq.participant_count, 0)::int AS participant_count,
        COALESCE(cm.comment_count, 0)::int AS comment_count
      FROM partner_challenges pc
      INNER JOIN challenges c ON c.id = pc.challenge_id
      LEFT JOIN (
        SELECT challenge_id, COUNT(DISTINCT user_id)::int AS participant_count
        FROM pair_queue
        WHERE status IN ('waiting', 'matched')
        GROUP BY challenge_id
      ) pq ON pq.challenge_id = c.id
      LEFT JOIN (
        SELECT challenge_id, COUNT(*)::int AS comment_count
        FROM challenge_messages
        GROUP BY challenge_id
      ) cm ON cm.challenge_id = c.id
      WHERE pc.program_id = $1
      ORDER BY c.created_at DESC
      LIMIT $2
    `,
    [programId, safeLimit],
  );

  return result.rows.map((row) => ({
    programId: toInt(row.program_id),
    challengeId: toInt(row.challenge_id),
    partnerFeeBps: toInt(row.partner_fee_bps, 1000),
    chatMonitorEnabled: Boolean(row.chat_monitor_enabled),
    settlementStatus: String(row.settlement_status || "pending"),
    linkedAt: nowIso(row.linked_at),
    challenge: {
      id: toInt(row.challenge_id),
      title: String(row.title || ""),
      description: row.description == null ? null : String(row.description),
      category: String(row.category || ""),
      amount: toInt(row.amount),
      status: String(row.status || ""),
      adminCreated: Boolean(row.admin_created),
      dueDate: row.due_date == null ? null : nowIso(row.due_date),
      createdAt: nowIso(row.created_at),
      result: row.result == null ? null : String(row.result),
      participantCount: toInt(row.participant_count),
      commentCount: toInt(row.comment_count),
    },
  }));
}

export async function listPublicPartnerChallengeLinks(limit = 100) {
  await ensurePartnerProgramTables();
  const safeLimit = Math.max(1, Math.min(500, toInt(limit, 100)));
  const result = await pool.query(
    `
      SELECT
        pc.challenge_id,
        pc.program_id,
        p.name AS program_name,
        p.slug AS program_slug,
        p.logo_url AS program_logo_url,
        p.badge_text AS program_badge_text
      FROM partner_challenges pc
      INNER JOIN partner_programs p ON p.id = pc.program_id
      INNER JOIN challenges c ON c.id = pc.challenge_id
      WHERE c.admin_created = TRUE
      ORDER BY c.created_at DESC
      LIMIT $1
    `,
    [safeLimit],
  );

  return result.rows.map((row) => ({
    challengeId: toInt(row.challenge_id),
    programId: toInt(row.program_id),
    programName: String(row.program_name || ""),
    programSlug: String(row.program_slug || ""),
    programLogoUrl: toNullableString(row.program_logo_url),
    programBadgeText: toNullableString(row.program_badge_text),
  }));
}

export async function calculatePartnerFeeSettlement(challengeId: number, settledBy?: string | null) {
  await ensurePartnerProgramTables();

  const existing = await pool.query(
    `SELECT * FROM partner_fee_settlements WHERE challenge_id = $1 LIMIT 1`,
    [challengeId],
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    const creditedToWallet = await creditSettlementToPartnerWallet(row, settledBy);
    return {
      settlementId: toInt(row.id),
      programId: toInt(row.program_id),
      challengeId: toInt(row.challenge_id),
      totalPool: toInt(row.total_pool),
      platformFee: toInt(row.platform_fee),
      partnerFee: toInt(row.partner_fee),
      settledAt: nowIso(row.settled_at),
      alreadyExisted: true,
      creditedToWallet,
    };
  }

  const meta = await getPartnerChallengeMeta(challengeId);
  if (!meta) return null;

  const stakeResult = await pool.query(
    `
      SELECT COALESCE(SUM(stake_amount), 0)::bigint AS total_pool
      FROM pair_queue
      WHERE challenge_id = $1
        AND status = 'matched'
    `,
    [challengeId],
  );

  const totalPool = toInt(stakeResult.rows[0]?.total_pool, 0);
  const platformFee = Math.floor(totalPool * 0.05);
  const partnerFee = Math.floor((platformFee * meta.partnerFeeBps) / 10000);

  const settled = await pool.query(
    `
      INSERT INTO partner_fee_settlements (
        program_id,
        challenge_id,
        total_pool,
        platform_fee,
        partner_fee,
        settled_by
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    [meta.programId, challengeId, totalPool, platformFee, partnerFee, settledBy || null],
  );

  await pool.query(
    `
      UPDATE partner_challenges
      SET settlement_status = 'settled', updated_at = NOW()
      WHERE challenge_id = $1
    `,
    [challengeId],
  );

  const row = settled.rows[0];
  const creditedToWallet = await creditSettlementToPartnerWallet(row, settledBy);
  return {
    settlementId: toInt(row.id),
    programId: toInt(row.program_id),
    challengeId: toInt(row.challenge_id),
    totalPool: toInt(row.total_pool),
    platformFee: toInt(row.platform_fee),
    partnerFee: toInt(row.partner_fee),
    settledAt: nowIso(row.settled_at),
    alreadyExisted: false,
    creditedToWallet,
  };
}

async function creditSettlementToPartnerWallet(settlementRow: any, settledBy?: string | null): Promise<boolean> {
  const settlementId = toInt(settlementRow?.id);
  const programId = toInt(settlementRow?.program_id);
  const challengeId = toInt(settlementRow?.challenge_id);
  const partnerFee = toInt(settlementRow?.partner_fee);

  if (!settlementId || !programId || partnerFee <= 0) return false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensurePartnerWalletRow(programId, client);

    const alreadyCredited = await client.query(
      `
        SELECT id
        FROM partner_wallet_transactions
        WHERE settlement_id = $1 AND type = 'settlement_credit'
        LIMIT 1
      `,
      [settlementId],
    );

    if (alreadyCredited.rows[0]) {
      await client.query("COMMIT");
      return false;
    }

    const walletResult = await client.query(
      `SELECT balance, total_credited FROM partner_wallets WHERE program_id = $1 FOR UPDATE`,
      [programId],
    );
    const currentBalance = toInt(walletResult.rows[0]?.balance, 0);
    const currentTotalCredited = toInt(walletResult.rows[0]?.total_credited, 0);
    const nextBalance = currentBalance + partnerFee;

    await client.query(
      `
        UPDATE partner_wallets
        SET
          balance = $2,
          total_credited = $3,
          updated_at = NOW()
        WHERE program_id = $1
      `,
      [programId, nextBalance, currentTotalCredited + partnerFee],
    );

    await client.query(
      `
        INSERT INTO partner_wallet_transactions (
          program_id,
          challenge_id,
          settlement_id,
          type,
          amount,
          balance_after,
          meta,
          created_by
        ) VALUES ($1, $2, $3, 'settlement_credit', $4, $5, $6::jsonb, $7)
      `,
      [
        programId,
        challengeId || null,
        settlementId,
        partnerFee,
        nextBalance,
        JSON.stringify({ source: "partner_fee_settlement" }),
        settledBy || null,
      ],
    );

    await client.query("COMMIT");
    return true;
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") return false;
    throw error;
  } finally {
    client.release();
  }
}

function mapPartnerWalletTxRow(row: any) {
  return {
    id: toInt(row.id),
    programId: toInt(row.program_id),
    challengeId: row.challenge_id == null ? null : toInt(row.challenge_id),
    settlementId: row.settlement_id == null ? null : toInt(row.settlement_id),
    withdrawalId: row.withdrawal_id == null ? null : toInt(row.withdrawal_id),
    type: String(row.type || ""),
    amount: toInt(row.amount),
    balanceAfter: toInt(row.balance_after),
    meta: parseJsonObject(row.meta),
    createdBy: toNullableString(row.created_by),
    createdAt: nowIso(row.created_at),
  };
}

function mapPartnerWithdrawalRow(row: any) {
  return {
    id: toInt(row.id),
    programId: toInt(row.program_id),
    requestedBy: String(row.requested_by || ""),
    amount: toInt(row.amount),
    status: String(row.status || "pending"),
    destination: parseJsonObject(row.destination),
    note: toNullableString(row.note),
    reviewNote: toNullableString(row.review_note),
    processedBy: toNullableString(row.processed_by),
    processedAt: row.processed_at == null ? null : nowIso(row.processed_at),
    createdAt: nowIso(row.created_at),
    updatedAt: nowIso(row.updated_at),
    requestedByUser: row.requested_username || row.requested_first_name || row.requested_last_name
      ? {
          username: toNullableString(row.requested_username),
          firstName: toNullableString(row.requested_first_name),
          lastName: toNullableString(row.requested_last_name),
          profileImageUrl: toNullableString(row.requested_profile_image_url),
        }
      : null,
    processedByUser: row.processed_username || row.processed_first_name || row.processed_last_name
      ? {
          username: toNullableString(row.processed_username),
          firstName: toNullableString(row.processed_first_name),
          lastName: toNullableString(row.processed_last_name),
          profileImageUrl: toNullableString(row.processed_profile_image_url),
        }
      : null,
    program: row.program_name || row.program_slug
      ? {
          id: toInt(row.program_id),
          name: String(row.program_name || ""),
          slug: String(row.program_slug || ""),
        }
      : null,
  };
}

function mapPartnerSignupApplicationRow(row: any) {
  return {
    id: toInt(row.id),
    fullName: String(row.full_name || ""),
    email: String(row.email || ""),
    communityName: String(row.community_name || ""),
    roleTitle: toNullableString(row.role_title),
    phone: toNullableString(row.phone),
    telegramHandle: toNullableString(row.telegram_handle),
    website: toNullableString(row.website),
    communityCoverImageUrl: toNullableString(row.community_cover_image_url),
    socialLinks: parseJsonObject(row.social_links),
    notes: toNullableString(row.notes),
    requestedByUserId: toNullableString(row.requested_by_user_id),
    status: String(row.status || "pending"),
    reviewedBy: toNullableString(row.reviewed_by),
    reviewNote: toNullableString(row.review_note),
    createdAt: nowIso(row.created_at),
    updatedAt: nowIso(row.updated_at),
    requestedByUser: row.requested_username || row.requested_first_name || row.requested_last_name
      ? {
          username: toNullableString(row.requested_username),
          firstName: toNullableString(row.requested_first_name),
          lastName: toNullableString(row.requested_last_name),
          profileImageUrl: toNullableString(row.requested_profile_image_url),
        }
      : null,
    reviewedByUser: row.reviewed_username || row.reviewed_first_name || row.reviewed_last_name
      ? {
          username: toNullableString(row.reviewed_username),
          firstName: toNullableString(row.reviewed_first_name),
          lastName: toNullableString(row.reviewed_last_name),
          profileImageUrl: toNullableString(row.reviewed_profile_image_url),
        }
      : null,
  };
}

export async function getPartnerWalletSummary(programId: number) {
  await ensurePartnerProgramTables();
  await ensurePartnerWalletRow(programId);

  const [walletResult, pendingResult] = await Promise.all([
    pool.query(
      `SELECT program_id, balance, total_credited, total_withdrawn, updated_at FROM partner_wallets WHERE program_id = $1 LIMIT 1`,
      [programId],
    ),
    pool.query(
      `
        SELECT COALESCE(SUM(amount), 0)::bigint AS pending_total
        FROM partner_withdrawals
        WHERE program_id = $1
          AND status = 'pending'
      `,
      [programId],
    ),
  ]);

  const walletRow = walletResult.rows[0];
  const pendingWithdrawals = toInt(pendingResult.rows[0]?.pending_total, 0);
  const balance = toInt(walletRow?.balance, 0);
  const availableBalance = Math.max(0, balance - pendingWithdrawals);

  return {
    programId,
    balance,
    totalCredited: toInt(walletRow?.total_credited, 0),
    totalWithdrawn: toInt(walletRow?.total_withdrawn, 0),
    pendingWithdrawals,
    availableBalance,
    updatedAt: nowIso(walletRow?.updated_at),
  };
}

export async function listPartnerWalletTransactions(programId: number, limit = 30) {
  await ensurePartnerProgramTables();
  await ensurePartnerWalletRow(programId);

  const safeLimit = Math.max(1, Math.min(200, toInt(limit, 30)));
  const result = await pool.query(
    `
      SELECT *
      FROM partner_wallet_transactions
      WHERE program_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [programId, safeLimit],
  );

  return result.rows.map(mapPartnerWalletTxRow);
}

export async function listPartnerWithdrawals(programId: number, limit = 50) {
  await ensurePartnerProgramTables();
  await ensurePartnerWalletRow(programId);

  const safeLimit = Math.max(1, Math.min(200, toInt(limit, 50)));
  const result = await pool.query(
    `
      SELECT
        w.*,
        req.username AS requested_username,
        req.first_name AS requested_first_name,
        req.last_name AS requested_last_name,
        req.profile_image_url AS requested_profile_image_url,
        proc.username AS processed_username,
        proc.first_name AS processed_first_name,
        proc.last_name AS processed_last_name,
        proc.profile_image_url AS processed_profile_image_url
      FROM partner_withdrawals w
      LEFT JOIN users req ON req.id = w.requested_by
      LEFT JOIN users proc ON proc.id = w.processed_by
      WHERE w.program_id = $1
      ORDER BY w.created_at DESC
      LIMIT $2
    `,
    [programId, safeLimit],
  );

  return result.rows.map(mapPartnerWithdrawalRow);
}

export async function createPartnerWithdrawalRequest(input: {
  programId: number;
  requestedBy: string;
  amount: number;
  destination?: Record<string, any> | null;
  note?: string | null;
}) {
  await ensurePartnerProgramTables();
  const amount = Math.max(0, toInt(input.amount));
  if (amount <= 0) {
    throw new Error("Withdrawal amount must be greater than zero");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensurePartnerWalletRow(input.programId, client);

    const walletResult = await client.query(
      `SELECT balance FROM partner_wallets WHERE program_id = $1 FOR UPDATE`,
      [input.programId],
    );
    const balance = toInt(walletResult.rows[0]?.balance, 0);

    const pendingResult = await client.query(
      `
        SELECT COALESCE(SUM(amount), 0)::bigint AS pending_total
        FROM partner_withdrawals
        WHERE program_id = $1
          AND status = 'pending'
      `,
      [input.programId],
    );
    const pendingTotal = toInt(pendingResult.rows[0]?.pending_total, 0);
    const available = Math.max(0, balance - pendingTotal);

    if (amount > available) {
      throw new Error(`Insufficient available balance. Available: ${available}`);
    }

    const created = await client.query(
      `
        INSERT INTO partner_withdrawals (
          program_id,
          requested_by,
          amount,
          destination,
          note
        ) VALUES ($1, $2, $3, $4::jsonb, $5)
        RETURNING *
      `,
      [
        input.programId,
        input.requestedBy,
        amount,
        input.destination ? JSON.stringify(input.destination) : null,
        input.note ? input.note.trim() : null,
      ],
    );

    await client.query("COMMIT");
    return mapPartnerWithdrawalRow(created.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function decidePartnerWithdrawal(input: {
  withdrawalId: number;
  action: PartnerWithdrawalDecisionAction;
  processedBy: string;
  reviewNote?: string | null;
}) {
  await ensurePartnerProgramTables();
  if (input.action !== "approve" && input.action !== "reject") {
    throw new Error("Invalid withdrawal decision action");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const withdrawalResult = await client.query(
      `
        SELECT *
        FROM partner_withdrawals
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [input.withdrawalId],
    );
    const withdrawalRow = withdrawalResult.rows[0];
    if (!withdrawalRow) {
      throw new Error("Withdrawal request not found");
    }

    const currentStatus = String(withdrawalRow.status || "pending");
    if (currentStatus !== "pending") {
      throw new Error(`Withdrawal request is already ${currentStatus}`);
    }

    const programId = toInt(withdrawalRow.program_id);
    const amount = toInt(withdrawalRow.amount, 0);

    await ensurePartnerWalletRow(programId, client);
    let balanceAfterDecision: number | null = null;

    if (input.action === "approve") {
      const walletResult = await client.query(
        `SELECT balance, total_withdrawn FROM partner_wallets WHERE program_id = $1 FOR UPDATE`,
        [programId],
      );
      const balance = toInt(walletResult.rows[0]?.balance, 0);
      const totalWithdrawn = toInt(walletResult.rows[0]?.total_withdrawn, 0);

      if (amount > balance) {
        throw new Error(`Wallet balance (${balance}) is lower than withdrawal amount (${amount})`);
      }

      balanceAfterDecision = balance - amount;

      await client.query(
        `
          UPDATE partner_wallets
          SET
            balance = $2,
            total_withdrawn = $3,
            updated_at = NOW()
          WHERE program_id = $1
        `,
        [programId, balanceAfterDecision, totalWithdrawn + amount],
      );

      await client.query(
        `
          INSERT INTO partner_wallet_transactions (
            program_id,
            withdrawal_id,
            type,
            amount,
            balance_after,
            created_by,
            meta
          ) VALUES ($1, $2, 'withdrawal_debit', $3, $4, $5, $6::jsonb)
        `,
        [
          programId,
          input.withdrawalId,
          -amount,
          balanceAfterDecision,
          input.processedBy,
          JSON.stringify({ reason: "partner_withdrawal_approved" }),
        ],
      );
    }

    const updated = await client.query(
      `
        UPDATE partner_withdrawals
        SET
          status = $2,
          processed_by = $3,
          processed_at = NOW(),
          review_note = $4,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        input.withdrawalId,
        input.action === "approve" ? "approved" : "rejected",
        input.processedBy,
        input.reviewNote ? input.reviewNote.trim() : null,
      ],
    );

    await client.query("COMMIT");

    return {
      withdrawal: mapPartnerWithdrawalRow(updated.rows[0]),
      wallet: await getPartnerWalletSummary(programId),
      balanceAfterDecision,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPendingPartnerWithdrawals(limit = 100, programId?: number | null) {
  await ensurePartnerProgramTables();
  const safeLimit = Math.max(1, Math.min(500, toInt(limit, 100)));

  const hasProgramFilter = typeof programId === "number" && Number.isFinite(programId) && programId > 0;

  const result = hasProgramFilter
    ? await pool.query(
        `
          SELECT
            w.*,
            p.name AS program_name,
            p.slug AS program_slug,
            req.username AS requested_username,
            req.first_name AS requested_first_name,
            req.last_name AS requested_last_name,
            req.profile_image_url AS requested_profile_image_url
          FROM partner_withdrawals w
          INNER JOIN partner_programs p ON p.id = w.program_id
          LEFT JOIN users req ON req.id = w.requested_by
          WHERE w.status = 'pending'
            AND w.program_id = $1
          ORDER BY w.created_at ASC
          LIMIT $2
        `,
        [programId, safeLimit],
      )
    : await pool.query(
        `
          SELECT
            w.*,
            p.name AS program_name,
            p.slug AS program_slug,
            req.username AS requested_username,
            req.first_name AS requested_first_name,
            req.last_name AS requested_last_name,
            req.profile_image_url AS requested_profile_image_url
          FROM partner_withdrawals w
          INNER JOIN partner_programs p ON p.id = w.program_id
          LEFT JOIN users req ON req.id = w.requested_by
          WHERE w.status = 'pending'
          ORDER BY w.created_at ASC
          LIMIT $1
        `,
        [safeLimit],
      );

  return result.rows.map(mapPartnerWithdrawalRow);
}

export async function createPartnerSignupApplication(input: {
  fullName: string;
  email: string;
  communityName: string;
  roleTitle?: string | null;
  phone?: string | null;
  telegramHandle?: string | null;
  website?: string | null;
  communityCoverImageUrl?: string | null;
  socialLinks?: Record<string, string> | null;
  notes?: string | null;
  requestedByUserId?: string | null;
}) {
  await ensurePartnerProgramTables();

  const created = await pool.query(
    `
      INSERT INTO partner_signup_applications (
        full_name,
        email,
        community_name,
        role_title,
        phone,
        telegram_handle,
        website,
        community_cover_image_url,
        social_links,
        notes,
        requested_by_user_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `,
    [
      input.fullName.trim(),
      input.email.trim().toLowerCase(),
      input.communityName.trim(),
      input.roleTitle?.trim() || null,
      input.phone?.trim() || null,
      input.telegramHandle?.trim() || null,
      input.website?.trim() || null,
      input.communityCoverImageUrl?.trim() || null,
      input.socialLinks && Object.keys(input.socialLinks).length > 0 ? JSON.stringify(input.socialLinks) : null,
      input.notes?.trim() || null,
      input.requestedByUserId || null,
    ],
  );

  return mapPartnerSignupApplicationRow(created.rows[0]);
}

export async function listPartnerSignupApplications(limit = 100, status?: string | null) {
  await ensurePartnerProgramTables();
  const safeLimit = Math.max(1, Math.min(500, toInt(limit, 100)));
  const normalizedStatus = status?.trim().toLowerCase() || "";

  const result = normalizedStatus
    ? await pool.query(
        `
          SELECT
            a.*,
            req.username AS requested_username,
            req.first_name AS requested_first_name,
            req.last_name AS requested_last_name,
            req.profile_image_url AS requested_profile_image_url,
            rev.username AS reviewed_username,
            rev.first_name AS reviewed_first_name,
            rev.last_name AS reviewed_last_name,
            rev.profile_image_url AS reviewed_profile_image_url
          FROM partner_signup_applications a
          LEFT JOIN users req ON req.id = a.requested_by_user_id
          LEFT JOIN users rev ON rev.id = a.reviewed_by
          WHERE a.status = $1
          ORDER BY a.created_at DESC
          LIMIT $2
        `,
        [normalizedStatus, safeLimit],
      )
    : await pool.query(
        `
          SELECT
            a.*,
            req.username AS requested_username,
            req.first_name AS requested_first_name,
            req.last_name AS requested_last_name,
            req.profile_image_url AS requested_profile_image_url,
            rev.username AS reviewed_username,
            rev.first_name AS reviewed_first_name,
            rev.last_name AS reviewed_last_name,
            rev.profile_image_url AS reviewed_profile_image_url
          FROM partner_signup_applications a
          LEFT JOIN users req ON req.id = a.requested_by_user_id
          LEFT JOIN users rev ON rev.id = a.reviewed_by
          ORDER BY a.created_at DESC
          LIMIT $1
        `,
        [safeLimit],
      );

  return result.rows.map(mapPartnerSignupApplicationRow);
}

export async function reviewPartnerSignupApplication(input: {
  applicationId: number;
  status: PartnerSignupStatus;
  reviewedBy: string;
  reviewNote?: string | null;
}) {
  await ensurePartnerProgramTables();

  const allowedStatus: PartnerSignupStatus[] = ["pending", "reviewing", "approved", "rejected"];
  if (!allowedStatus.includes(input.status)) {
    throw new Error("Invalid partner signup status");
  }

  const updated = await pool.query(
    `
      UPDATE partner_signup_applications
      SET
        status = $2,
        reviewed_by = $3,
        review_note = $4,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [input.applicationId, input.status, input.reviewedBy, input.reviewNote?.trim() || null],
  );

  if (!updated.rows[0]) {
    throw new Error("Partner signup application not found");
  }

  return mapPartnerSignupApplicationRow(updated.rows[0]);
}
