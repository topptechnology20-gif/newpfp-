import fs, { readFileSync } from 'fs';
import { pool } from './db';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initializeDatabase() {
  try {
    // Read all migration files in migrations/ and apply in filename order
    const migrationsDir = path.resolve(__dirname, '../migrations');
    let statements: string[] = [];
    try {
      const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        try {
          const migrationPath = path.resolve(migrationsDir, file);
          const sql = readFileSync(migrationPath, 'utf-8');
          const parts = sql.split('--> statement-breakpoint').filter(s => s.trim());
          statements = statements.concat(parts);
        } catch (err: any) {
          console.warn('[INIT] Failed to read migration', file, err?.message || err);
        }
      }
    } catch (err: any) {
      console.warn('[INIT] Skipping migrations folder (likely serverless env)', err.message);
    }
    
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i].trim();
      if (!statement) continue;
      
      try {
        const result = await pool.query(statement);
        successCount++;
      } catch (error: any) {
        // Ignore "already exists" errors (42P07) and other benign errors
        if (error.code === '42P07' || error.code === '42P06') {
          skipCount++;
        } else if (error.message?.includes('already exists')) {
          skipCount++;
        } else {
          errorCount++;
          console.error(`✗ Statement ${i + 1} FAILED:`, error.message?.substring(0, 100));
          console.error(`   SQL: ${statement.substring(0, 80).replace(/\n/g, ' ')}...`);
        }
      }
    }

    // Ensure onchain columns exist in shared tables (safe to run repeatedly)
    const onchainStatements = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_wallet_address varchar`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_addresses jsonb DEFAULT '[]'::jsonb`,
      `ALTER TABLE users ALTER COLUMN points SET DEFAULT 5`,
      `CREATE INDEX IF NOT EXISTS idx_users_primary_wallet_address ON users(primary_wallet_address)`,
      `CREATE TABLE IF NOT EXISTS agents (
        agent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_name varchar NOT NULL,
        avatar_url varchar,
        agent_type varchar(32) NOT NULL,
        wallet_address varchar NOT NULL UNIQUE,
        endpoint_url varchar(512) NOT NULL UNIQUE,
        bantah_skill_version varchar(24) NOT NULL DEFAULT '1.0.0',
        specialty varchar(32) NOT NULL DEFAULT 'general',
        status varchar(32) NOT NULL DEFAULT 'active',
        can_trade boolean NOT NULL DEFAULT true,
        strategy_type varchar(48) NOT NULL DEFAULT 'probability_threshold',
        strategy_config jsonb,
        risk_profile jsonb,
        visibility varchar(24) NOT NULL DEFAULT 'public',
        max_position_size decimal(12,2) NOT NULL DEFAULT '25.00',
        daily_trade_limit integer NOT NULL DEFAULT 5,
        max_open_positions integer NOT NULL DEFAULT 3,
        skill_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
        wallet_network_id varchar(64),
        wallet_provider varchar(64),
        owner_wallet_address varchar,
        wallet_data jsonb,
        runtime_engine varchar(32),
        runtime_status varchar(32),
        runtime_config jsonb,
        points integer NOT NULL DEFAULT 0,
        win_count integer NOT NULL DEFAULT 0,
        loss_count integer NOT NULL DEFAULT 0,
        market_count integer NOT NULL DEFAULT 0,
        is_tokenized boolean NOT NULL DEFAULT false,
        last_skill_check_at timestamp,
        last_skill_check_score integer,
        last_skill_check_status varchar(16),
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
      )`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS endpoint_url varchar(512)`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar_url varchar`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_skill_check_at timestamp`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_skill_check_score integer`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_skill_check_status varchar(16)`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS can_trade boolean NOT NULL DEFAULT true`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS strategy_type varchar(48) NOT NULL DEFAULT 'probability_threshold'`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS strategy_config jsonb`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS risk_profile jsonb`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS visibility varchar(24) NOT NULL DEFAULT 'public'`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_position_size decimal(12,2) NOT NULL DEFAULT '25.00'`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS daily_trade_limit integer NOT NULL DEFAULT 5`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_open_positions integer NOT NULL DEFAULT 3`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS skill_actions jsonb DEFAULT '[]'::jsonb`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_network_id varchar(64)`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_provider varchar(64)`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_wallet_address varchar`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_data jsonb`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_engine varchar(32)`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_status varchar(32)`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_config jsonb`,
      `CREATE INDEX IF NOT EXISTS idx_agents_owner_id ON agents(owner_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agents_agent_type ON agents(agent_type)`,
      `CREATE INDEX IF NOT EXISTS idx_agents_endpoint_url ON agents(endpoint_url)`,
      `CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)`,
      `CREATE INDEX IF NOT EXISTS idx_agents_specialty ON agents(specialty)`,
      `CREATE INDEX IF NOT EXISTS idx_agents_points ON agents(points)`,
      `CREATE INDEX IF NOT EXISTS idx_agents_can_trade ON agents(can_trade)`,
      `CREATE TABLE IF NOT EXISTS agent_follows (
        id serial PRIMARY KEY,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        created_at timestamp DEFAULT now(),
        CONSTRAINT agent_follows_user_agent_unique UNIQUE (user_id, agent_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_follows_user_id ON agent_follows(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_follows_agent_id ON agent_follows(agent_id)`,
      `CREATE TABLE IF NOT EXISTS token_launches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        agent_id uuid REFERENCES agents(agent_id) ON DELETE SET NULL,
        chain_id integer NOT NULL,
        network_id varchar(64) NOT NULL,
        factory_address varchar(64),
        token_address varchar(64),
        owner_address varchar(64) NOT NULL,
        token_name varchar(80) NOT NULL,
        token_symbol varchar(16) NOT NULL,
        decimals integer NOT NULL DEFAULT 18,
        initial_supply varchar(80) NOT NULL,
        initial_supply_atomic varchar(96) NOT NULL,
        deploy_tx_hash varchar(80),
        status varchar(24) NOT NULL DEFAULT 'pending',
        error_message text,
        metadata jsonb DEFAULT '{}'::jsonb,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_token_launches_user_id ON token_launches(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_token_launches_chain_id ON token_launches(chain_id)`,
      `CREATE INDEX IF NOT EXISTS idx_token_launches_token_address ON token_launches(token_address)`,
      `CREATE INDEX IF NOT EXISTS idx_token_launches_status ON token_launches(status)`,
      `CREATE INDEX IF NOT EXISTS idx_token_launches_created_at ON token_launches(created_at)`,
      `CREATE TABLE IF NOT EXISTS agent_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id uuid NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        market_id varchar(128) NOT NULL,
        external_market_id varchar(128) NOT NULL,
        market_question text,
        side varchar(8) NOT NULL,
        action varchar(16) NOT NULL DEFAULT 'buy',
        intended_stake_usd decimal(12,2) NOT NULL,
        intended_price decimal(8,4) NOT NULL,
        external_order_id varchar(255),
        status varchar(32) NOT NULL DEFAULT 'pending',
        failure_reason text,
        last_synced_at timestamp,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_orders_agent_id ON agent_orders(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_orders_market_id ON agent_orders(market_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_orders_external_market_id ON agent_orders(external_market_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_orders_status ON agent_orders(status)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_orders_created_at ON agent_orders(created_at)`,
      `CREATE TABLE IF NOT EXISTS agent_positions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id uuid NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        market_id varchar(128) NOT NULL,
        external_market_id varchar(128) NOT NULL,
        market_question text,
        side varchar(8) NOT NULL,
        total_shares decimal(18,6) NOT NULL DEFAULT '0',
        avg_entry_price decimal(8,4) NOT NULL DEFAULT '0',
        current_mark_price decimal(8,4),
        realized_pnl decimal(14,4) NOT NULL DEFAULT '0',
        unrealized_pnl decimal(14,4) NOT NULL DEFAULT '0',
        status varchar(16) NOT NULL DEFAULT 'open',
        opened_at timestamp DEFAULT now(),
        closed_at timestamp,
        last_synced_at timestamp,
        updated_at timestamp DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_positions_agent_id ON agent_positions(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_positions_market_id ON agent_positions(market_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_positions_external_market_id ON agent_positions(external_market_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_positions_status ON agent_positions(status)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_positions_updated_at ON agent_positions(updated_at)`,
      `CREATE TABLE IF NOT EXISTS decision_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id uuid NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        market_id varchar(128) NOT NULL,
        external_market_id varchar(128) NOT NULL,
        market_question text,
        strategy_type varchar(48) NOT NULL,
        action varchar(16) NOT NULL,
        confidence decimal(5,4) NOT NULL DEFAULT '0',
        intended_price decimal(8,4),
        intended_stake_usd decimal(12,2),
        reason text NOT NULL,
        risk_allowed boolean NOT NULL DEFAULT false,
        risk_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
        linked_order_id uuid REFERENCES agent_orders(id) ON DELETE SET NULL,
        created_at timestamp DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_decision_logs_agent_id ON decision_logs(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_decision_logs_market_id ON decision_logs(market_id)`,
      `CREATE INDEX IF NOT EXISTS idx_decision_logs_external_market_id ON decision_logs(external_market_id)`,
      `CREATE INDEX IF NOT EXISTS idx_decision_logs_created_at ON decision_logs(created_at)`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS settlement_rail varchar DEFAULT 'offchain'`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS chain_id integer`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS token_symbol varchar`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS token_address varchar`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS challenged_wallet_address varchar`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS creator_type varchar(16) DEFAULT 'human'`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS challenger_type varchar(16) DEFAULT 'human'`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS challenged_type varchar(16) DEFAULT 'human'`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS creator_agent_id uuid`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS challenger_agent_id uuid`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS challenged_agent_id uuid`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS created_by_agent boolean DEFAULT false`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS agent_involved boolean DEFAULT false`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS stake_atomic varchar`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS decimals integer`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS escrow_tx_hash varchar`,
      `ALTER TABLE challenges ADD COLUMN IF NOT EXISTS settle_tx_hash varchar`,
      `CREATE INDEX IF NOT EXISTS idx_challenges_settlement_rail ON challenges(settlement_rail)`,
      `CREATE INDEX IF NOT EXISTS idx_challenges_chain_id ON challenges(chain_id)`,
      `CREATE INDEX IF NOT EXISTS idx_challenges_challenged_wallet_address ON challenges(challenged_wallet_address)`,
      `CREATE INDEX IF NOT EXISTS idx_challenges_creator_agent_id ON challenges(creator_agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_challenges_challenger_agent_id ON challenges(challenger_agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_challenges_challenged_agent_id ON challenges(challenged_agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_challenges_agent_involved ON challenges(agent_involved)`,
      `ALTER TABLE pair_queue ADD COLUMN IF NOT EXISTS participant_type varchar(16) DEFAULT 'human'`,
      `ALTER TABLE pair_queue ADD COLUMN IF NOT EXISTS agent_id uuid`,
      `CREATE INDEX IF NOT EXISTS idx_pair_queue_agent_id ON pair_queue(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_pair_queue_participant_type ON pair_queue(participant_type)`,
      `CREATE TABLE IF NOT EXISTS onchain_challenge_metadata (
        metadata_hash varchar primary key,
        chain_id integer,
        escrow_tx_hash varchar,
        challenge_id integer,
        payload jsonb not null,
        created_at timestamp default now(),
        updated_at timestamp default now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_onchain_metadata_escrow_tx_hash ON onchain_challenge_metadata(escrow_tx_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_onchain_metadata_challenge_id ON onchain_challenge_metadata(challenge_id)`,
      `CREATE TABLE IF NOT EXISTS onchain_indexer_state (
        chain_id integer primary key,
        last_block bigint not null,
        updated_at timestamp default now()
      )`,
      `CREATE TABLE IF NOT EXISTS media_assets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        original_filename varchar(512),
        mime_type varchar(128) NOT NULL,
        storage_kind varchar(24) NOT NULL DEFAULT 'database',
        data_base64 text,
        local_path varchar(1024),
        remote_url text,
        provider varchar(64),
        created_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamp DEFAULT now()
      )`,
      `ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS remote_url text`,
      `ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS provider varchar(64)`,
      `CREATE INDEX IF NOT EXISTS idx_media_assets_created_at ON media_assets(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_media_assets_created_by_user_id ON media_assets(created_by_user_id)`,
    ];

    for (const statement of onchainStatements) {
      try {
        await pool.query(statement);
      } catch (error: any) {
        // Ignore if target table is missing in an older boot sequence
        if (error.code === '42P01') {
          continue;
        }
        console.error(`✗ Onchain schema statement FAILED: ${statement.substring(0, 90)}...`);
        console.error(`   ${error.message?.substring(0, 120)}`);
      }
    }
    
    return true;
  } catch (error: any) {
    console.error('❌ Database initialization error:', error.message);
    throw error;
  }
}
