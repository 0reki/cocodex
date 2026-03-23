CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TABLE IF EXISTS registration_results;
    DROP TABLE IF EXISTS portal_checkout_orders CASCADE;
    DROP TABLE IF EXISTS portal_user_invoices CASCADE;
    DROP TABLE IF EXISTS portal_user_topup_orders CASCADE;
    DROP TABLE IF EXISTS portal_subscription_plan_versions CASCADE;
    DROP TABLE IF EXISTS portal_user_subscriptions CASCADE;

    DROP TABLE IF EXISTS team_members;
    DROP TABLE IF EXISTS team_owners;

    CREATE TABLE IF NOT EXISTS team_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT,
      name TEXT,
      email TEXT NOT NULL UNIQUE,
      account_id TEXT,
      account_user_role TEXT,
      workspace_name TEXT,
      plan_type TEXT,
      team_member_count INTEGER,
      team_expires_at TIMESTAMPTZ(6),
      workspace_is_deactivated BOOLEAN NOT NULL DEFAULT false,
      workspace_cancelled_at TIMESTAMPTZ(6),
      system_created BOOLEAN NOT NULL DEFAULT false,
      proxy_id UUID,
      access_token TEXT,
      refresh_token TEXT,
      password TEXT,
      type TEXT,
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      cooldown_until TIMESTAMPTZ(6),
      rate_limit JSONB
    );

    CREATE INDEX IF NOT EXISTS idx_team_accounts_email
      ON team_accounts (email);

    CREATE INDEX IF NOT EXISTS idx_team_accounts_user_id
      ON team_accounts (user_id);

    CREATE INDEX IF NOT EXISTS idx_team_accounts_account_id
      ON team_accounts (account_id);

    CREATE INDEX IF NOT EXISTS idx_team_accounts_account_user_role
      ON team_accounts (account_user_role);

    CREATE INDEX IF NOT EXISTS idx_team_accounts_team_expires_at
      ON team_accounts (team_expires_at);

    CREATE INDEX IF NOT EXISTS idx_team_accounts_proxy_id
      ON team_accounts (proxy_id);

    CREATE INDEX IF NOT EXISTS idx_team_accounts_cooldown_until
      ON team_accounts (cooldown_until);

    CREATE INDEX IF NOT EXISTS idx_team_accounts_updated_at
      ON team_accounts (updated_at DESC);

    ALTER TABLE team_accounts
      DROP CONSTRAINT IF EXISTS fk_team_accounts_user;
    ALTER TABLE team_accounts
      DROP CONSTRAINT IF EXISTS fk_team_accounts_portal_user;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'team_accounts'
          AND column_name = 'user_id'
          AND udt_name = 'uuid'
      ) THEN
        ALTER TABLE team_accounts
          ALTER COLUMN user_id TYPE TEXT USING user_id::text;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'team_accounts'
          AND column_name = 'system_created'
      ) THEN
        ALTER TABLE team_accounts
          ADD COLUMN system_created BOOLEAN NOT NULL DEFAULT false;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'team_accounts'
          AND column_name = 'rate_limit'
      ) THEN
        ALTER TABLE team_accounts
          ADD COLUMN rate_limit JSONB;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'team_accounts'
          AND column_name = 'password'
      ) THEN
        ALTER TABLE team_accounts
          ADD COLUMN password TEXT;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'team_accounts'
          AND column_name = 'owner_id'
      ) THEN
        ALTER TABLE team_accounts
          ADD COLUMN owner_id UUID;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'team_accounts'
          AND column_name = 'team_member_count'
      ) THEN
        ALTER TABLE team_accounts
          ADD COLUMN team_member_count INTEGER;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'team_accounts'
          AND column_name = 'team_expires_at'
      ) THEN
        ALTER TABLE team_accounts
          ADD COLUMN team_expires_at TIMESTAMPTZ(6);
      END IF;
    END $$;

    ALTER TABLE team_accounts
      ADD COLUMN IF NOT EXISTS picture TEXT;
    ALTER TABLE team_accounts
      ADD COLUMN IF NOT EXISTS status TEXT;
    ALTER TABLE team_accounts
      ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE team_accounts
      ADD COLUMN IF NOT EXISTS session_token TEXT;
    ALTER TABLE team_accounts
      ADD COLUMN IF NOT EXISTS portal_user_id UUID;

    CREATE INDEX IF NOT EXISTS idx_team_accounts_portal_user_id
      ON team_accounts (portal_user_id);

    CREATE INDEX IF NOT EXISTS idx_team_accounts_status
      ON team_accounts (status);
    CREATE INDEX IF NOT EXISTS idx_team_accounts_status_updated_at
      ON team_accounts (status, updated_at DESC);

    UPDATE team_accounts
    SET
      status = CASE
        WHEN workspace_is_deactivated THEN 'disabled'
        ELSE 'active'
      END
    WHERE status IS NULL
      OR BTRIM(status) = '';

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = 'openai_accounts'
      ) THEN
        INSERT INTO team_accounts (
          user_id,
          portal_user_id,
          owner_id,
          name,
          email,
          picture,
          account_id,
          account_user_role,
          workspace_name,
          plan_type,
          workspace_is_deactivated,
          workspace_cancelled_at,
          status,
          is_shared,
          proxy_id,
          access_token,
          refresh_token,
          session_token,
          type,
          created_at,
          updated_at,
          cooldown_until,
          rate_limit
        )
        SELECT
          user_id,
          NULL,
          owner_id,
          name,
          email,
          picture,
          account_id,
          account_user_role,
          workspace_name,
          plan_type,
          workspace_is_deactivated,
          workspace_cancelled_at,
          status,
          COALESCE(is_shared, false),
          proxy_id,
          access_token,
          refresh_token,
          session_token,
          COALESCE(NULLIF(BTRIM(type), ''), 'openai'),
          created_at,
          updated_at,
          cooldown_until,
          rate_limit
        FROM openai_accounts
        ON CONFLICT (email)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          portal_user_id = COALESCE(team_accounts.portal_user_id, EXCLUDED.portal_user_id),
          owner_id = EXCLUDED.owner_id,
          name = EXCLUDED.name,
          picture = EXCLUDED.picture,
          account_id = EXCLUDED.account_id,
          account_user_role = EXCLUDED.account_user_role,
          workspace_name = EXCLUDED.workspace_name,
          plan_type = EXCLUDED.plan_type,
          workspace_is_deactivated = EXCLUDED.workspace_is_deactivated,
          workspace_cancelled_at = EXCLUDED.workspace_cancelled_at,
          status = EXCLUDED.status,
          is_shared = EXCLUDED.is_shared,
          proxy_id = EXCLUDED.proxy_id,
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          session_token = EXCLUDED.session_token,
          type = EXCLUDED.type,
          cooldown_until = EXCLUDED.cooldown_until,
          rate_limit = EXCLUDED.rate_limit;
      END IF;
    END $$;

    DROP TABLE IF EXISTS openai_accounts;

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_team_accounts ON team_accounts;
    CREATE TRIGGER trg_set_updated_at_on_team_accounts
      BEFORE UPDATE ON team_accounts
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS signup_proxies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      proxy_url TEXT NOT NULL UNIQUE,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_signup_proxies_enabled
      ON signup_proxies (enabled);

    CREATE INDEX IF NOT EXISTS idx_signup_proxies_updated_at
      ON signup_proxies (updated_at DESC);

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_signup_proxies ON signup_proxies;
    CREATE TRIGGER trg_set_updated_at_on_signup_proxies
      BEFORE UPDATE ON signup_proxies
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS signup_tasks (
      id UUID PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'openai',
      status TEXT NOT NULL,
      count INTEGER NOT NULL,
      concurrency INTEGER NOT NULL,
      cpu_max_concurrency INTEGER NOT NULL,
      proxy_pool_size INTEGER NOT NULL,
      saved_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ(6),
      finished_at TIMESTAMPTZ(6),
      duration_ms INTEGER,
      error TEXT,
      result JSONB,
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_signup_tasks_status
      ON signup_tasks (status);

    CREATE INDEX IF NOT EXISTS idx_signup_tasks_created_at
      ON signup_tasks (created_at DESC);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'signup_tasks'
          AND column_name = 'kind'
      ) THEN
        ALTER TABLE signup_tasks
          ADD COLUMN kind TEXT NOT NULL DEFAULT 'openai';
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_signup_tasks_kind
      ON signup_tasks (kind);

    UPDATE signup_tasks
    SET kind = CASE
      WHEN result->>'kind' = 'team-member' THEN 'team-member'
      WHEN result->>'kind' = 'team-member-join' THEN 'team-member-join'
      WHEN result->>'kind' = 'team-owner' THEN 'team-owner'
      WHEN result->>'kind' = 'team-owner-subscription' THEN 'team-owner-subscription'
      ELSE COALESCE(NULLIF(kind, ''), 'openai')
    END
    WHERE kind IS NULL
      OR kind = ''
      OR result->>'kind' IN ('team-member', 'team-member-join', 'team-owner', 'team-owner-subscription');

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_signup_tasks ON signup_tasks;
    CREATE TRIGGER trg_set_updated_at_on_signup_tasks
      BEFORE UPDATE ON signup_tasks
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS system_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      openai_api_user_agent TEXT,
      openai_client_version TEXT,
      inbox_translation_model TEXT,
      cloud_mail_domains JSONB,
      owner_mail_domains JSONB,
      account_submission_addon_daily_quota NUMERIC(20, 8),
      account_submission_addon_weekly_cap NUMERIC(20, 8),
      account_submission_addon_monthly_cap NUMERIC(20, 8),
      account_cache_size INTEGER,
      account_cache_refresh_seconds INTEGER,
      max_attempt_count INTEGER,
      user_rpm_limit INTEGER,
      user_max_in_flight INTEGER,
      check_in_reward_min NUMERIC(20, 8),
      check_in_reward_max NUMERIC(20, 8),
      openai_models JSONB,
      openai_models_updated_at TIMESTAMPTZ(6),
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
    );

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'openai_api_user_agent'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN openai_api_user_agent TEXT;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'account_submission_addon_daily_quota'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN account_submission_addon_daily_quota NUMERIC(20, 8);
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'account_submission_addon_weekly_cap'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN account_submission_addon_weekly_cap NUMERIC(20, 8);
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'account_submission_addon_monthly_cap'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN account_submission_addon_monthly_cap NUMERIC(20, 8);
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'openai_client_version'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN openai_client_version TEXT;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'inbox_translation_model'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN inbox_translation_model TEXT;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'cloud_mail_domains'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN cloud_mail_domains JSONB;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'owner_mail_domains'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN owner_mail_domains JSONB;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'account_cache_size'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN account_cache_size INTEGER;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'account_cache_refresh_seconds'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN account_cache_refresh_seconds INTEGER;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'max_attempt_count'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN max_attempt_count INTEGER;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'user_rpm_limit'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN user_rpm_limit INTEGER;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'user_max_in_flight'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN user_max_in_flight INTEGER;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'check_in_reward_min'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN check_in_reward_min NUMERIC(20, 8);
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'check_in_reward_max'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN check_in_reward_max NUMERIC(20, 8);
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'openai_models'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN openai_models JSONB;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'system_settings'
          AND column_name = 'openai_models_updated_at'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN openai_models_updated_at TIMESTAMPTZ(6);
      END IF;
    END $$;

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_system_settings ON system_settings;
    CREATE TRIGGER trg_set_updated_at_on_system_settings
      BEFORE UPDATE ON system_settings
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id UUID,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL,
      quota NUMERIC(20, 8),
      used NUMERIC(20, 8) NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ(6),
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
    );

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'api_keys'
          AND column_name = 'owner_user_id'
      ) THEN
        ALTER TABLE api_keys
          ADD COLUMN owner_user_id UUID;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'api_keys'
          AND column_name = 'quota'
      ) THEN
        ALTER TABLE api_keys
          ADD COLUMN quota INTEGER;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'api_keys'
          AND column_name = 'expires_at'
      ) THEN
        ALTER TABLE api_keys
          ADD COLUMN expires_at TIMESTAMPTZ(6);
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'api_keys'
          AND column_name = 'used'
      ) THEN
        ALTER TABLE api_keys
          ADD COLUMN used NUMERIC(20, 8) NOT NULL DEFAULT 0;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'api_keys'
          AND column_name = 'quota'
          AND udt_name IN ('int2', 'int4', 'int8')
      ) THEN
        ALTER TABLE api_keys
          ALTER COLUMN quota TYPE NUMERIC(20, 8) USING quota::numeric;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'api_keys'
          AND column_name = 'used'
          AND udt_name IN ('int2', 'int4', 'int8')
      ) THEN
        ALTER TABLE api_keys
          ALTER COLUMN used TYPE NUMERIC(20, 8) USING used::numeric;
      END IF;
    END $$;

    UPDATE api_keys
    SET used = 0
    WHERE used IS NULL;

    DO $$
    DECLARE
      _constraint_name text;
      _index_name text;
    BEGIN
      SELECT c.conname
      INTO _constraint_name
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema()
        AND t.relname = 'api_keys'
        AND c.contype = 'u'
        AND pg_get_constraintdef(c.oid) ILIKE '%(name)%'
      LIMIT 1;

      IF _constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE api_keys DROP CONSTRAINT %I', _constraint_name);
      END IF;

      FOR _index_name IN
        SELECT i.indexname
        FROM pg_indexes i
        WHERE i.schemaname = current_schema()
          AND i.tablename = 'api_keys'
          AND i.indexdef ILIKE 'CREATE UNIQUE INDEX%'
          AND i.indexdef ILIKE '%(name)%'
      LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', _index_name);
      END LOOP;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_api_keys_updated_at
      ON api_keys (updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at
      ON api_keys (expires_at);

    CREATE INDEX IF NOT EXISTS idx_api_keys_owner_user_id
      ON api_keys (owner_user_id);

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_api_keys ON api_keys;
    CREATE TRIGGER trg_set_updated_at_on_api_keys
      BEFORE UPDATE ON api_keys
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

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
      user_rpm_limit INTEGER,
      user_max_in_flight INTEGER,
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
    );

    ALTER TABLE portal_users
      ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE portal_users
      ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
    ALTER TABLE portal_users
      ADD COLUMN IF NOT EXISTS country TEXT;
    ALTER TABLE portal_users
      ADD COLUMN IF NOT EXISTS must_setup BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE portal_users
      ADD COLUMN IF NOT EXISTS user_rpm_limit INTEGER;
    ALTER TABLE portal_users
      ADD COLUMN IF NOT EXISTS user_max_in_flight INTEGER;
    ALTER TABLE portal_users
      DROP COLUMN IF EXISTS region;

    CREATE INDEX IF NOT EXISTS idx_portal_users_username
      ON portal_users (username);
    CREATE INDEX IF NOT EXISTS idx_portal_users_email
      ON portal_users (email);

    CREATE INDEX IF NOT EXISTS idx_portal_users_role
      ON portal_users (role);

    CREATE INDEX IF NOT EXISTS idx_portal_users_enabled
      ON portal_users (enabled);
    CREATE INDEX IF NOT EXISTS idx_portal_users_must_setup
      ON portal_users (must_setup);

    UPDATE team_accounts accounts
    SET portal_user_id = accounts.user_id::uuid
    WHERE accounts.portal_user_id IS NULL
      AND accounts.user_id IS NOT NULL
      AND BTRIM(accounts.user_id) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND EXISTS (
        SELECT 1
        FROM portal_users users
        WHERE users.id = accounts.user_id::uuid
      );

    UPDATE team_accounts accounts
    SET portal_user_id = NULL
    WHERE portal_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM portal_users users
        WHERE users.id = accounts.portal_user_id
      );

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relname = 'team_accounts'
          AND c.conname = 'fk_team_accounts_portal_user'
      ) THEN
        ALTER TABLE team_accounts
          ADD CONSTRAINT fk_team_accounts_portal_user
          FOREIGN KEY (portal_user_id)
          REFERENCES portal_users(id)
          ON DELETE SET NULL;
      END IF;
    END $$;

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_portal_users ON portal_users;
    CREATE TRIGGER trg_set_updated_at_on_portal_users
      BEFORE UPDATE ON portal_users
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS portal_inbox_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient_user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      sender_user_id UUID REFERENCES portal_users(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      ai_translated BOOLEAN NOT NULL DEFAULT false,
      read_at TIMESTAMPTZ(6),
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      CONSTRAINT chk_portal_inbox_messages_title
        CHECK (char_length(btrim(title)) > 0),
      CONSTRAINT chk_portal_inbox_messages_body
        CHECK (char_length(btrim(body)) > 0)
    );

    CREATE INDEX IF NOT EXISTS idx_portal_inbox_messages_recipient_created_at
      ON portal_inbox_messages (recipient_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_portal_inbox_messages_recipient_read_at
      ON portal_inbox_messages (recipient_user_id, read_at, created_at DESC);

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_portal_inbox_messages ON portal_inbox_messages;
    CREATE TRIGGER trg_set_updated_at_on_portal_inbox_messages
      BEFORE UPDATE ON portal_inbox_messages
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'portal_inbox_messages'
          AND column_name = 'ai_translated'
      ) THEN
        ALTER TABLE portal_inbox_messages
          ADD COLUMN ai_translated BOOLEAN NOT NULL DEFAULT false;
      END IF;
    END $$;

    -- Normalize orphan owner ids first, otherwise FK creation can fail.
    UPDATE api_keys keys
    SET owner_user_id = NULL
    WHERE owner_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM portal_users users
        WHERE users.id = keys.owner_user_id
      );

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relname = 'api_keys'
          AND c.conname = 'fk_api_keys_owner_user'
      ) THEN
        ALTER TABLE api_keys
          ADD CONSTRAINT fk_api_keys_owner_user
          FOREIGN KEY (owner_user_id)
          REFERENCES portal_users(id)
          ON DELETE CASCADE;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS portal_user_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      provider_username TEXT,
      provider_name TEXT,
      avatar_url TEXT,
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      CONSTRAINT uq_portal_user_identities_provider_user
        UNIQUE (provider, provider_user_id)
    );
    ALTER TABLE portal_user_identities
      DROP COLUMN IF EXISTS profile;

    CREATE INDEX IF NOT EXISTS idx_portal_user_identities_user_id
      ON portal_user_identities (user_id);
    CREATE INDEX IF NOT EXISTS idx_portal_user_identities_provider
      ON portal_user_identities (provider);
    CREATE INDEX IF NOT EXISTS idx_portal_user_identities_provider_user_id
      ON portal_user_identities (provider_user_id);

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_portal_user_identities ON portal_user_identities;
    CREATE TRIGGER trg_set_updated_at_on_portal_user_identities
      BEFORE UPDATE ON portal_user_identities
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    ALTER TABLE portal_users
      ADD COLUMN IF NOT EXISTS balance NUMERIC(20, 8) NOT NULL DEFAULT 0;
    ALTER TABLE portal_users
      ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = 'portal_user_billing_profiles'
      ) THEN
        UPDATE portal_users users
        SET balance = profiles.balance,
            currency = profiles.currency
        FROM portal_user_billing_profiles profiles
        WHERE profiles.user_id = users.id;
      END IF;
    END $$;

    DROP TABLE IF EXISTS portal_user_billing_profiles;

    DROP TABLE IF EXISTS portal_user_addon_allowances;
    DROP TABLE IF EXISTS portal_user_addon_grants;

    CREATE TABLE IF NOT EXISTS portal_user_addons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      source_account_id UUID NOT NULL REFERENCES team_accounts(id) ON DELETE CASCADE,
      source_account_email TEXT NOT NULL,
      source_account_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      disable_reason TEXT,
      granted_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      effective_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ(6),
      source_account_plan_expires_at TIMESTAMPTZ(6),
      last_validated_at TIMESTAMPTZ(6),
      daily_quota NUMERIC(20, 8) NOT NULL DEFAULT 0,
      weekly_cap NUMERIC(20, 8) NOT NULL DEFAULT 0,
      monthly_cap NUMERIC(20, 8) NOT NULL DEFAULT 0,
      metadata JSONB,
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      CONSTRAINT uq_portal_user_addons_source_account UNIQUE (source_account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_portal_user_addons_user_id
      ON portal_user_addons (user_id);
    CREATE INDEX IF NOT EXISTS idx_portal_user_addons_status
      ON portal_user_addons (status);
    CREATE INDEX IF NOT EXISTS idx_portal_user_addons_granted_at
      ON portal_user_addons (granted_at ASC);
    CREATE INDEX IF NOT EXISTS idx_portal_user_addons_expires_at
      ON portal_user_addons (expires_at);
    CREATE INDEX IF NOT EXISTS idx_portal_user_addons_source_account_email
      ON portal_user_addons (source_account_email);

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_portal_user_addons ON portal_user_addons;
    CREATE TRIGGER trg_set_updated_at_on_portal_user_addons
      BEFORE UPDATE ON portal_user_addons
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS portal_user_addon_usage (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      addon_id UUID NOT NULL REFERENCES portal_user_addons(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      period_type TEXT NOT NULL,
      period_key TEXT NOT NULL,
      used_amount NUMERIC(20, 8) NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ(6),
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      CONSTRAINT uq_portal_user_addon_usage_period UNIQUE (addon_id, period_type, period_key)
    );

    CREATE INDEX IF NOT EXISTS idx_portal_user_addon_usage_user_id
      ON portal_user_addon_usage (user_id);
    CREATE INDEX IF NOT EXISTS idx_portal_user_addon_usage_addon_id
      ON portal_user_addon_usage (addon_id);
    CREATE INDEX IF NOT EXISTS idx_portal_user_addon_usage_period
      ON portal_user_addon_usage (period_type, period_key);

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_portal_user_addon_usage ON portal_user_addon_usage;
    CREATE TRIGGER trg_set_updated_at_on_portal_user_addon_usage
      BEFORE UPDATE ON portal_user_addon_usage
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    DROP TABLE IF EXISTS portal_user_checkins;
    DROP TABLE IF EXISTS portal_user_invoices;

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
      key_id UUID REFERENCES api_keys (id) ON DELETE SET NULL,
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

    CREATE INDEX IF NOT EXISTS idx_model_response_logs_request_time_brin
      ON model_response_logs USING BRIN (request_time);

    CREATE INDEX IF NOT EXISTS idx_model_response_logs_intent_id
      ON model_response_logs (intent_id);

    CREATE INDEX IF NOT EXISTS idx_model_response_logs_key_id
      ON model_response_logs (key_id);

    CREATE INDEX IF NOT EXISTS idx_model_response_logs_key_request_time
      ON model_response_logs (key_id, request_time DESC);

    CREATE INDEX IF NOT EXISTS idx_model_response_logs_model_id
      ON model_response_logs (model_id);

    CREATE INDEX IF NOT EXISTS idx_model_response_logs_request_time_model_id
      ON model_response_logs (request_time DESC, model_id);

    CREATE INDEX IF NOT EXISTS idx_model_response_logs_status_code
      ON model_response_logs (status_code);

    CREATE INDEX IF NOT EXISTS idx_model_response_logs_path
      ON model_response_logs (path);

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_model_response_logs ON model_response_logs;
    CREATE TRIGGER trg_set_updated_at_on_model_response_logs
      BEFORE UPDATE ON model_response_logs
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS model_response_log_hourly_rollups (
      hour_bucket TIMESTAMPTZ(6) NOT NULL,
      key_id UUID,
      model_id TEXT NOT NULL,
      request_count BIGINT NOT NULL DEFAULT 0,
      total_tokens BIGINT NOT NULL DEFAULT 0,
      total_cost NUMERIC(20, 8) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      PRIMARY KEY (hour_bucket, key_id, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_model_response_log_hourly_rollups_hour_bucket
      ON model_response_log_hourly_rollups (hour_bucket DESC);

    CREATE INDEX IF NOT EXISTS idx_model_response_log_hourly_rollups_key_hour_bucket
      ON model_response_log_hourly_rollups (key_id, hour_bucket DESC);

    CREATE INDEX IF NOT EXISTS idx_model_response_log_hourly_rollups_model_hour_bucket
      ON model_response_log_hourly_rollups (model_id, hour_bucket DESC);

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_model_response_log_hourly_rollups ON model_response_log_hourly_rollups;
    CREATE TRIGGER trg_set_updated_at_on_model_response_log_hourly_rollups
      BEFORE UPDATE ON model_response_log_hourly_rollups
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE OR REPLACE FUNCTION upsert_model_response_log_hourly_rollup()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    DECLARE
      normalized_model_id TEXT;
      bucket TIMESTAMPTZ(6);
    BEGIN
      normalized_model_id := COALESCE(NULLIF(BTRIM(NEW.model_id), ''), 'unknown');
      bucket := date_trunc('hour', NEW.request_time);

      INSERT INTO model_response_log_hourly_rollups (
        hour_bucket,
        key_id,
        model_id,
        request_count,
        total_tokens,
        total_cost
      )
      VALUES (
        bucket,
        NEW.key_id,
        normalized_model_id,
        1,
        COALESCE(NEW.total_tokens, 0),
        COALESCE(NEW.cost, 0)
      )
      ON CONFLICT (hour_bucket, key_id, model_id)
      DO UPDATE SET
        request_count = model_response_log_hourly_rollups.request_count + 1,
        total_tokens = model_response_log_hourly_rollups.total_tokens + COALESCE(NEW.total_tokens, 0),
        total_cost = model_response_log_hourly_rollups.total_cost + COALESCE(NEW.cost, 0),
        updated_at = now();

      RETURN NEW;
    END $$;

    DROP TRIGGER IF EXISTS trg_upsert_model_response_log_hourly_rollup ON model_response_logs;
    CREATE TRIGGER trg_upsert_model_response_log_hourly_rollup
      AFTER INSERT ON model_response_logs
      FOR EACH ROW
      EXECUTE FUNCTION upsert_model_response_log_hourly_rollup();

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM model_response_logs LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM model_response_log_hourly_rollups LIMIT 1) THEN
        INSERT INTO model_response_log_hourly_rollups (
          hour_bucket,
          key_id,
          model_id,
          request_count,
          total_tokens,
          total_cost
        )
        SELECT
          date_trunc('hour', request_time) AS hour_bucket,
          key_id,
          COALESCE(NULLIF(BTRIM(model_id), ''), 'unknown') AS model_id,
          COUNT(*) AS request_count,
          COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS total_tokens,
          COALESCE(SUM(COALESCE(cost, 0)), 0) AS total_cost
        FROM model_response_logs
        GROUP BY 1, 2, 3
        ON CONFLICT (hour_bucket, key_id, model_id)
        DO UPDATE SET
          request_count = EXCLUDED.request_count,
          total_tokens = EXCLUDED.total_tokens,
          total_cost = EXCLUDED.total_cost,
          updated_at = now();
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'model_response_logs'
          AND column_name = 'heartbeat_count'
      ) THEN
        ALTER TABLE model_response_logs
          ADD COLUMN heartbeat_count INTEGER;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'model_response_logs'
          AND column_name = 'stream_end_reason'
      ) THEN
        ALTER TABLE model_response_logs
          ADD COLUMN stream_end_reason TEXT;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'model_response_logs'
          AND column_name = 'service_tier'
      ) THEN
        ALTER TABLE model_response_logs
          ADD COLUMN service_tier TEXT;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'model_response_logs'
          AND column_name = 'internal_error_details'
      ) THEN
        ALTER TABLE model_response_logs
          ADD COLUMN internal_error_details JSONB;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS service_status_monitors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      enabled BOOLEAN NOT NULL DEFAULT true,
      interval_seconds INTEGER NOT NULL DEFAULT 300,
      timeout_ms INTEGER NOT NULL DEFAULT 10000,
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      CONSTRAINT chk_service_status_monitors_interval_seconds
        CHECK (interval_seconds >= 30),
      CONSTRAINT chk_service_status_monitors_timeout_ms
        CHECK (timeout_ms >= 500)
    );

    CREATE INDEX IF NOT EXISTS idx_service_status_monitors_enabled
      ON service_status_monitors (enabled);

    DROP TRIGGER IF EXISTS trg_set_updated_at_on_service_status_monitors ON service_status_monitors;
    CREATE TRIGGER trg_set_updated_at_on_service_status_monitors
      BEFORE UPDATE ON service_status_monitors
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS service_status_samples (
      id BIGSERIAL PRIMARY KEY,
      monitor_id UUID NOT NULL REFERENCES service_status_monitors(id) ON DELETE CASCADE,
      checked_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      ok BOOLEAN NOT NULL,
      status_code INTEGER,
      latency_ms INTEGER,
      error_message TEXT,
      created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_service_status_samples_monitor_checked
      ON service_status_samples (monitor_id, checked_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_service_status_samples_checked_at
      ON service_status_samples (checked_at DESC);
