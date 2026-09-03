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
  balance NUMERIC(20, 8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

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
  email TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive',
  id_token TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_openai_accounts_account_id
  ON openai_accounts (account_id);
CREATE INDEX IF NOT EXISTS idx_openai_accounts_status
  ON openai_accounts (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_openai_accounts_single_active
  ON openai_accounts ((LOWER(TRIM(status))))
  WHERE LOWER(TRIM(status)) = 'active';
CREATE INDEX IF NOT EXISTS idx_openai_accounts_updated_at
  ON openai_accounts (updated_at DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at_on_openai_accounts ON openai_accounts;
CREATE TRIGGER trg_set_updated_at_on_openai_accounts
  BEFORE UPDATE ON openai_accounts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS portal_user_upstream_assignments (
  owner_user_id UUID PRIMARY KEY REFERENCES portal_users(id) ON DELETE CASCADE,
  source_account_id UUID NOT NULL REFERENCES openai_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_user_upstream_assignments_source
  ON portal_user_upstream_assignments (source_account_id);

DROP TRIGGER IF EXISTS trg_set_updated_at_on_portal_user_upstream_assignments
  ON portal_user_upstream_assignments;
CREATE TRIGGER trg_set_updated_at_on_portal_user_upstream_assignments
  BEFORE UPDATE ON portal_user_upstream_assignments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS upstream_quota_windows (
  source_account_id UUID NOT NULL REFERENCES openai_accounts(id) ON DELETE CASCADE,
  quota_pool TEXT NOT NULL,
  reset_at BIGINT NOT NULL,
  used_percent NUMERIC(12, 8) NOT NULL,
  carry_in_percent NUMERIC(12, 8) NOT NULL DEFAULT 0,
  carry_in_user_id UUID REFERENCES portal_users(id) ON DELETE SET NULL,
  sync_required BOOLEAN NOT NULL DEFAULT false,
  initialized_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (source_account_id, quota_pool),
  CHECK (quota_pool IN ('standard', 'spark'))
);

ALTER TABLE upstream_quota_windows
  ADD COLUMN IF NOT EXISTS quota_pool TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE upstream_quota_windows ALTER COLUMN quota_pool DROP DEFAULT;
ALTER TABLE upstream_quota_windows
  ADD COLUMN IF NOT EXISTS reset_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE upstream_quota_windows ALTER COLUMN reset_at DROP DEFAULT;
ALTER TABLE upstream_quota_windows
  ADD COLUMN IF NOT EXISTS used_percent NUMERIC(12, 8) NOT NULL DEFAULT 0;
ALTER TABLE upstream_quota_windows ALTER COLUMN used_percent DROP DEFAULT;
ALTER TABLE upstream_quota_windows
  ADD COLUMN IF NOT EXISTS carry_in_percent NUMERIC(12, 8) NOT NULL DEFAULT 0;
ALTER TABLE upstream_quota_windows
  ADD COLUMN IF NOT EXISTS carry_in_user_id UUID
    REFERENCES portal_users(id) ON DELETE SET NULL;
ALTER TABLE upstream_quota_windows
  ADD COLUMN IF NOT EXISTS sync_required BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE upstream_quota_windows ALTER COLUMN sync_required SET DEFAULT false;
ALTER TABLE upstream_quota_windows
  ADD COLUMN IF NOT EXISTS initialized_at TIMESTAMPTZ(6) NOT NULL DEFAULT now();
ALTER TABLE upstream_quota_windows
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now();
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'upstream_quota_windows'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) =
        'PRIMARY KEY (source_account_id, quota_pool)'
  ) THEN
    ALTER TABLE upstream_quota_windows
      DROP CONSTRAINT upstream_quota_windows_pkey;
    ALTER TABLE upstream_quota_windows
      ADD PRIMARY KEY (source_account_id, quota_pool);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'upstream_quota_windows'::regclass
      AND conname = 'upstream_quota_windows_quota_pool_check'
  ) THEN
    ALTER TABLE upstream_quota_windows
      ADD CONSTRAINT upstream_quota_windows_quota_pool_check
      CHECK (quota_pool IN ('standard', 'spark'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS upstream_user_window_usage (
  source_account_id UUID NOT NULL REFERENCES openai_accounts(id) ON DELETE CASCADE,
  quota_pool TEXT NOT NULL,
  reset_at BIGINT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  usage_amount NUMERIC(20, 8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (source_account_id, quota_pool, reset_at, owner_user_id),
  CHECK (quota_pool IN ('standard', 'spark'))
);

ALTER TABLE upstream_user_window_usage
  ADD COLUMN IF NOT EXISTS quota_pool TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE upstream_user_window_usage ALTER COLUMN quota_pool DROP DEFAULT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'upstream_user_window_usage'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) =
        'PRIMARY KEY (source_account_id, quota_pool, reset_at, owner_user_id)'
  ) THEN
    ALTER TABLE upstream_user_window_usage
      DROP CONSTRAINT upstream_user_window_usage_pkey;
    ALTER TABLE upstream_user_window_usage
      ADD PRIMARY KEY (
        source_account_id, quota_pool, reset_at, owner_user_id
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'upstream_user_window_usage'::regclass
      AND conname = 'upstream_user_window_usage_quota_pool_check'
  ) THEN
    ALTER TABLE upstream_user_window_usage
      ADD CONSTRAINT upstream_user_window_usage_quota_pool_check
      CHECK (quota_pool IN ('standard', 'spark'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS upstream_quota_settlements (
  settlement_id TEXT NOT NULL,
  source_account_id UUID NOT NULL REFERENCES openai_accounts(id) ON DELETE CASCADE,
  quota_pool TEXT NOT NULL,
  reset_at BIGINT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  usage_amount NUMERIC(20, 8) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (settlement_id, quota_pool),
  CHECK (quota_pool IN ('standard', 'spark'))
);

ALTER TABLE upstream_quota_settlements
  ADD COLUMN IF NOT EXISTS quota_pool TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE upstream_quota_settlements ALTER COLUMN quota_pool DROP DEFAULT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'upstream_quota_settlements'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) =
        'PRIMARY KEY (settlement_id, quota_pool)'
  ) THEN
    ALTER TABLE upstream_quota_settlements
      DROP CONSTRAINT upstream_quota_settlements_pkey;
    ALTER TABLE upstream_quota_settlements
      ADD PRIMARY KEY (settlement_id, quota_pool);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'upstream_quota_settlements'::regclass
      AND conname = 'upstream_quota_settlements_quota_pool_check'
  ) THEN
    ALTER TABLE upstream_quota_settlements
      ADD CONSTRAINT upstream_quota_settlements_quota_pool_check
      CHECK (quota_pool IN ('standard', 'spark'));
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_upstream_quota_settlements_window;
CREATE INDEX IF NOT EXISTS idx_upstream_quota_settlements_window
  ON upstream_quota_settlements (source_account_id, quota_pool, reset_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  quota NUMERIC(20, 8),
  used NUMERIC(20, 8) NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ(6),
  revoked_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_owner_user_id
  ON api_keys (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at
  ON api_keys (expires_at);

DROP TRIGGER IF EXISTS trg_set_updated_at_on_api_keys ON api_keys;
CREATE TRIGGER trg_set_updated_at_on_api_keys
  BEFORE UPDATE ON api_keys
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
  key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS idx_model_response_logs_request_time
  ON model_response_logs (request_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_model_response_logs_key_request_time
  ON model_response_logs (key_id, request_time DESC, id DESC);
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

CREATE TABLE IF NOT EXISTS model_response_log_hourly_rollups (
  hour_bucket TIMESTAMPTZ(6) NOT NULL,
  key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost NUMERIC(20, 8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (hour_bucket, key_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_model_response_log_rollups_key_hour
  ON model_response_log_hourly_rollups (key_id, hour_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_model_response_log_rollups_model_hour
  ON model_response_log_hourly_rollups (model_id, hour_bucket DESC);

DROP TRIGGER IF EXISTS trg_upsert_model_response_log_hourly_rollup
  ON model_response_logs;
DROP FUNCTION IF EXISTS upsert_model_response_log_hourly_rollup();
