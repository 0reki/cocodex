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
