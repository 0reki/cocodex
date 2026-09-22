CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS portal_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  enabled BOOLEAN NOT NULL DEFAULT true,
  quota NUMERIC(20, 8),
  used NUMERIC(20, 8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS quota NUMERIC(20, 8);
ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS used NUMERIC(20, 8) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_portal_users_role ON portal_users (role);
CREATE INDEX IF NOT EXISTS idx_portal_users_enabled ON portal_users (enabled);

DROP TRIGGER IF EXISTS trg_set_updated_at_on_portal_users ON portal_users;
CREATE TRIGGER trg_set_updated_at_on_portal_users
  BEFORE UPDATE ON portal_users
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS portal_user_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  registered_user_id UUID REFERENCES portal_users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  used_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_user_invitations_available
  ON portal_user_invitations (expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS openai_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One ChatGPT account logs in once per platform: same email and account_id
  -- across those rows, so email is not unique; (account_id, platform) is.
  email TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive',
  platform VARCHAR(32) NOT NULL DEFAULT 'all',
  id_token TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

ALTER TABLE openai_accounts
  ADD COLUMN IF NOT EXISTS platform VARCHAR(32) NOT NULL DEFAULT 'all';

-- The same account may hold one login per platform, so email is no longer
-- unique; uniqueness is (account_id, platform).
ALTER TABLE openai_accounts
  DROP CONSTRAINT IF EXISTS openai_accounts_email_key;
DROP INDEX IF EXISTS openai_accounts_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_openai_accounts_account_platform
  ON openai_accounts (account_id, (LOWER(TRIM(COALESCE(platform, 'all')))));

CREATE INDEX IF NOT EXISTS idx_openai_accounts_account_id
  ON openai_accounts (account_id);
CREATE INDEX IF NOT EXISTS idx_openai_accounts_status
  ON openai_accounts (status);
CREATE INDEX IF NOT EXISTS idx_openai_accounts_platform
  ON openai_accounts (platform);
DROP INDEX IF EXISTS uq_openai_accounts_single_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_openai_accounts_single_active_per_platform
  ON openai_accounts ((LOWER(TRIM(status))), (LOWER(TRIM(platform))))
  WHERE LOWER(TRIM(status)) = 'active';
CREATE INDEX IF NOT EXISTS idx_openai_accounts_updated_at
  ON openai_accounts (updated_at DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at_on_openai_accounts ON openai_accounts;
CREATE TRIGGER trg_set_updated_at_on_openai_accounts
  BEFORE UPDATE ON openai_accounts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Users are assigned a ChatGPT account (`openai_accounts.account_id`), not a
-- single row: one ChatGPT account is logged in once per client platform.
CREATE TABLE IF NOT EXISTS portal_user_upstream_assignments (
  owner_user_id UUID PRIMARY KEY REFERENCES portal_users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

ALTER TABLE portal_user_upstream_assignments
  ADD COLUMN IF NOT EXISTS account_id TEXT;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'portal_user_upstream_assignments'
      AND column_name = 'source_account_id'
  ) THEN
    UPDATE portal_user_upstream_assignments AS assignments
    SET account_id = accounts.account_id
    FROM openai_accounts AS accounts
    WHERE accounts.id = assignments.source_account_id
      AND assignments.account_id IS NULL;
    DELETE FROM portal_user_upstream_assignments WHERE account_id IS NULL;
    ALTER TABLE portal_user_upstream_assignments DROP COLUMN source_account_id;
  END IF;
END
$$;
ALTER TABLE portal_user_upstream_assignments
  ALTER COLUMN account_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_portal_user_upstream_assignments_account
  ON portal_user_upstream_assignments (account_id);

DROP TRIGGER IF EXISTS trg_set_updated_at_on_portal_user_upstream_assignments
  ON portal_user_upstream_assignments;
CREATE TRIGGER trg_set_updated_at_on_portal_user_upstream_assignments
  BEFORE UPDATE ON portal_user_upstream_assignments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Weekly upstream quota per ChatGPT account. Each assigned user may consume
-- at most a fixed share of `used_percent`, split by recorded usage.
CREATE TABLE IF NOT EXISTS upstream_account_quota_windows (
  account_id TEXT PRIMARY KEY,
  reset_at BIGINT NOT NULL,
  used_percent NUMERIC(12, 8) NOT NULL,
  synced_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS upstream_account_user_usage (
  account_id TEXT NOT NULL,
  reset_at BIGINT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  usage_amount NUMERIC(20, 8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, reset_at, owner_user_id)
);

CREATE TABLE IF NOT EXISTS upstream_account_quota_settlements (
  settlement_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  reset_at BIGINT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  usage_amount NUMERIC(20, 8) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_upstream_account_quota_settlements_created
  ON upstream_account_quota_settlements (created_at);

-- Carry the per-row quota tables over to per-account ones, dropping the
-- spark pool and the carry-in bookkeeping.
DO $$
BEGIN
  IF to_regclass(current_schema() || '.upstream_quota_windows') IS NOT NULL THEN
    INSERT INTO upstream_account_quota_windows (account_id, reset_at, used_percent)
    SELECT DISTINCT ON (accounts.account_id)
      accounts.account_id, windows.reset_at, windows.used_percent
    FROM upstream_quota_windows AS windows
    JOIN openai_accounts AS accounts ON accounts.id = windows.source_account_id
    WHERE windows.quota_pool = 'standard'
    ORDER BY accounts.account_id, windows.reset_at DESC, windows.used_percent DESC
    ON CONFLICT (account_id) DO NOTHING;
  END IF;
  IF to_regclass(current_schema() || '.upstream_user_window_usage') IS NOT NULL THEN
    INSERT INTO upstream_account_user_usage (
      account_id, reset_at, owner_user_id, usage_amount
    )
    SELECT accounts.account_id, usage.reset_at, usage.owner_user_id,
      SUM(usage.usage_amount)
    FROM upstream_user_window_usage AS usage
    JOIN openai_accounts AS accounts ON accounts.id = usage.source_account_id
    WHERE usage.quota_pool = 'standard'
    GROUP BY 1, 2, 3
    ON CONFLICT (account_id, reset_at, owner_user_id) DO NOTHING;
  END IF;
END
$$;
DROP TABLE IF EXISTS upstream_quota_settlements;
DROP TABLE IF EXISTS upstream_user_window_usage;
DROP TABLE IF EXISTS upstream_quota_windows;

-- API keys are gone. Keep any quota they carried before dropping them.
DO $$
BEGIN
  IF to_regclass(current_schema() || '.api_keys') IS NOT NULL THEN
    UPDATE portal_users users
    SET
      quota = keys.quota,
      used = COALESCE(keys.used, 0)
    FROM (
      SELECT DISTINCT ON (owner_user_id)
        owner_user_id,
        quota,
        used
      FROM api_keys
      WHERE revoked_at IS NULL
      ORDER BY
        owner_user_id,
        CASE WHEN name = 'Codex client' THEN 0 ELSE 1 END,
        updated_at DESC
    ) keys
    WHERE keys.owner_user_id = users.id
      AND users.quota IS NULL
      AND COALESCE(users.used, 0) = 0;
  END IF;
END
$$;
DROP TABLE IF EXISTS model_response_log_hourly_rollups;
DROP TABLE IF EXISTS api_keys CASCADE;

CREATE TABLE IF NOT EXISTS codex_client_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Access tokens are bound to a session and only honoured while the session
-- still holds an unexpired refresh token.
ALTER TABLE codex_client_refresh_tokens
  ADD COLUMN IF NOT EXISTS session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_codex_client_refresh_tokens_session
  ON codex_client_refresh_tokens (session_id);

CREATE INDEX IF NOT EXISTS idx_codex_client_refresh_tokens_owner
  ON codex_client_refresh_tokens (owner_user_id);
ALTER TABLE codex_client_refresh_tokens DROP COLUMN IF EXISTS api_key_id;
CREATE INDEX IF NOT EXISTS idx_codex_client_refresh_tokens_expires
  ON codex_client_refresh_tokens (expires_at);

DROP TRIGGER IF EXISTS trg_set_updated_at_on_codex_client_refresh_tokens
  ON codex_client_refresh_tokens;
CREATE TRIGGER trg_set_updated_at_on_codex_client_refresh_tokens
  BEFORE UPDATE ON codex_client_refresh_tokens
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS model_response_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id TEXT NOT NULL DEFAULT gen_random_uuid()::text UNIQUE,
  intent_id TEXT,
  is_final BOOLEAN,
  stream_end_reason TEXT,
  path TEXT NOT NULL,
  model_id TEXT,
  -- API keys are gone; the column only keeps history from that era.
  key_id UUID,
  owner_user_id UUID REFERENCES portal_users(id) ON DELETE SET NULL,
  service_tier TEXT,
  status_code INTEGER,
  ttfb_ms INTEGER,
  latency_ms INTEGER,
  tokens_info JSONB,
  total_tokens INTEGER,
  cost NUMERIC(20, 8),
  error_code TEXT,
  error_message TEXT,
  request_time TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- The model the client asked for, the model that served the request, and the
-- length of the upstream turn state. `model_id` keeps the billed model.
ALTER TABLE model_response_logs
  ADD COLUMN IF NOT EXISTS requested_model TEXT;
ALTER TABLE model_response_logs
  ADD COLUMN IF NOT EXISTS used_model TEXT;
ALTER TABLE model_response_logs
  ADD COLUMN IF NOT EXISTS turn_state_len INTEGER;

CREATE INDEX IF NOT EXISTS idx_model_response_logs_request_time
  ON model_response_logs (request_time DESC, id DESC);
DROP INDEX IF EXISTS idx_model_response_logs_key_request_time;
CREATE INDEX IF NOT EXISTS idx_model_response_logs_owner_request_time
  ON model_response_logs (owner_user_id, request_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_model_response_logs_model_id
  ON model_response_logs (model_id, request_time DESC, id DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at_on_model_response_logs
  ON model_response_logs;
CREATE TRIGGER trg_set_updated_at_on_model_response_logs
  BEFORE UPDATE ON model_response_logs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


DROP TRIGGER IF EXISTS trg_upsert_model_response_log_hourly_rollup
  ON model_response_logs;
DROP FUNCTION IF EXISTS upsert_model_response_log_hourly_rollup();

-- Hourly usage per portal user and model, maintained by settlement batches.
CREATE TABLE IF NOT EXISTS model_response_log_owner_hourly_rollups (
  hour_bucket TIMESTAMPTZ(6) NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost NUMERIC(20, 8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (hour_bucket, owner_user_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_model_response_log_owner_rollups_owner_hour
  ON model_response_log_owner_hourly_rollups (owner_user_id, hour_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_model_response_log_owner_rollups_model_hour
  ON model_response_log_owner_hourly_rollups (model_id, hour_bucket DESC);

-- One-time backfill from existing logs; later rows come from settlements.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM model_response_log_owner_hourly_rollups) THEN
    INSERT INTO model_response_log_owner_hourly_rollups (
      hour_bucket, owner_user_id, model_id, request_count, total_tokens, total_cost
    )
    SELECT
      date_trunc('hour', request_time),
      owner_user_id,
      COALESCE(NULLIF(BTRIM(model_id), ''), 'unknown'),
      COUNT(*),
      SUM(COALESCE(total_tokens, 0)),
      SUM(COALESCE(cost, 0))
    FROM model_response_logs
    WHERE owner_user_id IS NOT NULL
    GROUP BY 1, 2, 3;
  END IF;
END
$$;

-- Gateway settings the console writes at runtime, one JSON document per
-- key (`turn_state` holds turn-state handling and its probe).
CREATE TABLE IF NOT EXISTS gateway_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_set_updated_at_on_gateway_settings ON gateway_settings;
CREATE TRIGGER trg_set_updated_at_on_gateway_settings
  BEFORE UPDATE ON gateway_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
