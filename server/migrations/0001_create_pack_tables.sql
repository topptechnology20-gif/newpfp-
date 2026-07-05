-- Migration: Create pack and agent memory tables
CREATE TABLE IF NOT EXISTS "pack_catalog" (
  "pack_id" varchar(180) PRIMARY KEY NOT NULL,
  "type" varchar(80) NOT NULL,
  "display_name" varchar(180) NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "initial_supply" integer DEFAULT 0,
  "remaining_supply" integer DEFAULT 0,
  "price_bc" integer DEFAULT 0,
  "price_usd" numeric DEFAULT 0,
  "saleable" boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS "pack_ownership" (
  "pack_instance_id" varchar(180) PRIMARY KEY NOT NULL,
  "pack_id" varchar(180) NOT NULL REFERENCES "pack_catalog" ("pack_id"),
  "owner_user_id" varchar(180) NOT NULL,
  "status" varchar(40) NOT NULL DEFAULT 'unopened',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "pack_open_events" (
  "event_id" varchar(180) PRIMARY KEY NOT NULL,
  "pack_instance_id" varchar(180) NOT NULL REFERENCES "pack_ownership" ("pack_instance_id"),
  "agent_id" varchar(180) NULL,
  "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "agent_memories" (
  "id" varchar(180) PRIMARY KEY NOT NULL,
  "agent_id" varchar(180) NOT NULL,
  "kind" varchar(80) NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "score" numeric DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_agent_memories_agent" ON "agent_memories" ("agent_id");
CREATE INDEX IF NOT EXISTS "idx_agent_memories_kind" ON "agent_memories" ("kind");

-- Pack drop entries (weights / drop tables)
CREATE TABLE IF NOT EXISTS "pack_drops" (
  "id" serial PRIMARY KEY,
  "pack_type" varchar(180) NOT NULL,
  "tool_id" varchar(180) NOT NULL,
  "weight" integer NOT NULL DEFAULT 100,
  "name" varchar(180),
  "rarity" varchar(32),
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_pack_drops_pack_type" ON "pack_drops" ("pack_type");
