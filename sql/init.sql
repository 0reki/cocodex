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
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  country TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  enabled BOOLEAN NOT NULL DEFAULT true,
  must_setup BOOLEAN NOT NULL DEFAULT false,
  balance NUMERIC(20, 8) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
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
  user_id TEXT,
  name TEXT,
  email TEXT NOT NULL UNIQUE,
  picture TEXT,
  account_id TEXT,
  status TEXT NOT NULL DEFAULT 'inactive',
  access_token TEXT,
  session_token TEXT,
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
  api_key TEXT NOT NULL,
  quota NUMERIC(20, 8),
  used NUMERIC(20, 8) NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_token ON api_keys (api_key);
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
  intent_id TEXT,
  attempt_no INTEGER,
  is_final BOOLEAN,
  retry_reason TEXT,
  heartbeat_count INTEGER,
  stream_end_reason TEXT,
  path TEXT NOT NULL,
  model_id TEXT,
  key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  service_tier TEXT,
  status_code INTEGER,
  ttfb_ms INTEGER,
  latency_ms INTEGER,
  tokens_info JSONB,
  total_tokens INTEGER,
  cost NUMERIC(20, 8),
  error_code TEXT,
  error_message TEXT,
  internal_error_details JSONB,
  request_time TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_response_logs_request_time
  ON model_response_logs (request_time DESC);
CREATE INDEX IF NOT EXISTS idx_model_response_logs_key_request_time
  ON model_response_logs (key_id, request_time DESC);
CREATE INDEX IF NOT EXISTS idx_model_response_logs_model_id
  ON model_response_logs (model_id);

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

CREATE OR REPLACE FUNCTION upsert_model_response_log_hourly_rollup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_model_id TEXT;
  bucket TIMESTAMPTZ(6);
BEGIN
  IF NEW.key_id IS NULL THEN
    RETURN NEW;
  END IF;
  normalized_model_id := COALESCE(NULLIF(BTRIM(NEW.model_id), ''), 'unknown');
  bucket := date_trunc('hour', NEW.request_time);

  INSERT INTO model_response_log_hourly_rollups (
    hour_bucket, key_id, model_id, request_count, total_tokens, total_cost
  )
  VALUES (
    bucket, NEW.key_id, normalized_model_id, 1,
    COALESCE(NEW.total_tokens, 0), COALESCE(NEW.cost, 0)
  )
  ON CONFLICT (hour_bucket, key_id, model_id)
  DO UPDATE SET
    request_count = model_response_log_hourly_rollups.request_count + 1,
    total_tokens = model_response_log_hourly_rollups.total_tokens
      + COALESCE(NEW.total_tokens, 0),
    total_cost = model_response_log_hourly_rollups.total_cost
      + COALESCE(NEW.cost, 0),
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_upsert_model_response_log_hourly_rollup
  ON model_response_logs;
CREATE TRIGGER trg_upsert_model_response_log_hourly_rollup
  AFTER INSERT ON model_response_logs
  FOR EACH ROW
  EXECUTE FUNCTION upsert_model_response_log_hourly_rollup();
