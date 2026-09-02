import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { Pool, type PoolConfig } from "pg";

import { resetDatabasePool } from "../../database/core/db.ts";
import { getInitSchemaSql } from "../../database/schema/sql.ts";
import { hashPassword, verifyPassword } from "../auth/portal-auth.ts";
import { persistSetupConfig } from "../utils/runtime/env-utils.ts";

type SetupReason =
  | "missing_database"
  | "database_unreachable"
  | "admin_missing"
  | "missing_jwt_secret";

type SetupStatus = {
  setupRequired: boolean;
  reason: SetupReason | null;
  databaseConfigured: boolean;
  databaseReachable: boolean | null;
  adminConfigured: boolean | null;
};

class SetupError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SetupError";
  }
}

function positiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

function createSetupPool(databaseUrl: string) {
  const config: PoolConfig = {
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: positiveIntegerEnv(
      "PG_CONNECTION_TIMEOUT_MS",
      5_000,
    ),
    statement_timeout: positiveIntegerEnv("PG_STATEMENT_TIMEOUT_MS", 15_000),
    query_timeout: positiveIntegerEnv("PG_QUERY_TIMEOUT_MS", 20_000),
    lock_timeout: positiveIntegerEnv("PG_LOCK_TIMEOUT_MS", 5_000),
  };
  if (process.env.PG_SSL_MODE === "require") {
    config.ssl = { rejectUnauthorized: false };
  }
  return new Pool(config);
}

function validateDatabaseUrl(value: unknown) {
  const databaseUrl = typeof value === "string" ? value.trim() : "";
  if (!databaseUrl) {
    throw new SetupError(400, "database_url_required", "数据库地址不能为空");
  }
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new SetupError(
      400,
      "database_url_invalid",
      "数据库地址必须是有效的 PostgreSQL URL",
    );
  }
  return databaseUrl;
}

function validateAdminUsername(value: unknown) {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!username) {
    throw new SetupError(400, "admin_username_required", "管理员用户名不能为空");
  }
  if (username.length > 80) {
    throw new SetupError(
      400,
      "admin_username_invalid",
      "管理员用户名不能超过 80 个字符",
    );
  }
  return username;
}

function validateAdminPassword(value: unknown) {
  const password = typeof value === "string" ? value : "";
  if (password.length < 8) {
    throw new SetupError(
      400,
      "admin_password_too_short",
      "管理员密码至少需要 8 个字符",
    );
  }
  return password;
}

async function inspectDatabase(databaseUrl: string) {
  const pool = createSetupPool(databaseUrl);
  try {
    const table = await pool.query<{ table_name: string | null }>(
      "SELECT to_regclass(current_schema() || '.portal_users')::text AS table_name",
    );
    if (!table.rows[0]?.table_name) return { adminConfigured: false };
    const users = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM portal_users",
    );
    return { adminConfigured: Number(users.rows[0]?.count ?? "0") > 0 };
  } finally {
    await pool.end();
  }
}

async function readSetupStatus(): Promise<SetupStatus> {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    return {
      setupRequired: true,
      reason: "missing_database",
      databaseConfigured: false,
      databaseReachable: false,
      adminConfigured: false,
    };
  }

  const jwtConfigured = Boolean(process.env.ADMIN_JWT_SECRET?.trim());
  // A JWT secret is only persisted after setup succeeds. Treat it as the
  // completion marker so a temporary database outage never reopens setup.
  // Database health is checked by the normal startup self-check instead of
  // delaying every frontend load on this public status endpoint.
  if (jwtConfigured) {
    return {
      setupRequired: false,
      reason: null,
      databaseConfigured: true,
      databaseReachable: null,
      adminConfigured: null,
    };
  }

  let adminConfigured = false;
  try {
    adminConfigured = (await inspectDatabase(databaseUrl)).adminConfigured;
  } catch {
    return {
      setupRequired: true,
      reason: "database_unreachable",
      databaseConfigured: true,
      databaseReachable: false,
      adminConfigured: false,
    };
  }

  if (adminConfigured) {
    return {
      setupRequired: true,
      reason: "missing_jwt_secret",
      databaseConfigured: true,
      databaseReachable: true,
      adminConfigured: true,
    };
  }

  const legacyBootstrapConfigured = Boolean(process.env.ADMIN_PASSWORD);
  if (!adminConfigured && !legacyBootstrapConfigured) {
    return {
      setupRequired: true,
      reason: "admin_missing",
      databaseConfigured: true,
      databaseReachable: true,
      adminConfigured: false,
    };
  }

  return {
    setupRequired: true,
    reason: "missing_jwt_secret",
    databaseConfigured: true,
    databaseReachable: true,
    adminConfigured,
  };
}

async function initializeDatabase(input: {
  databaseUrl: string;
  adminUsername: string;
  adminPassword: string;
}) {
  const pool = createSetupPool(input.databaseUrl);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      "8453201114257",
    ]);
    await client.query(getInitSchemaSql());

    const users = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM portal_users",
    );
    if (Number(users.rows[0]?.count ?? "0") === 0) {
      await client.query(
        `INSERT INTO portal_users
          (username, password_hash, role, enabled)
         VALUES ($1, $2, 'admin', true)`,
        [input.adminUsername, await hashPassword(input.adminPassword)],
      );
    } else {
      const existing = await client.query<{
        password_hash: string;
        role: string;
        enabled: boolean;
      }>(
        `SELECT password_hash, role, enabled
           FROM portal_users
          WHERE LOWER(username) = LOWER($1)
          LIMIT 1`,
        [input.adminUsername],
      );
      const admin = existing.rows[0];
      if (
        !admin ||
        admin.role !== "admin" ||
        !admin.enabled ||
        !(await verifyPassword(input.adminPassword, admin.password_hash))
      ) {
        throw new SetupError(
          409,
          "database_already_initialized",
          "该数据库已经初始化，请输入现有管理员账号和密码",
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

let setupInProgress = false;

export function registerSetupRoutes(app: Express) {
  app.get("/api/setup/status", async (_req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    try {
      res.json(await readSetupStatus());
    } catch (error) {
      res.status(500).json({
        error: {
          code: "setup_status_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.post("/api/setup/complete", async (req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    if (setupInProgress) {
      res.status(409).json({
        error: { code: "setup_in_progress", message: "初始化正在进行中" },
      });
      return;
    }

    setupInProgress = true;
    try {
      const current = await readSetupStatus();
      if (!current.setupRequired) {
        throw new SetupError(409, "setup_already_complete", "初始化已经完成");
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const databaseUrl = validateDatabaseUrl(
        current.databaseConfigured
          ? process.env.DATABASE_URL
          : body.databaseUrl,
      );
      const adminUsername = validateAdminUsername(body.adminUsername);
      const adminPassword = validateAdminPassword(body.adminPassword);
      const adminJwtSecret =
        process.env.ADMIN_JWT_SECRET?.trim() ||
        crypto.randomBytes(48).toString("base64url");

      await initializeDatabase({ databaseUrl, adminUsername, adminPassword });
      persistSetupConfig({ databaseUrl, adminJwtSecret });
      await resetDatabasePool();
      process.env.DATABASE_URL = databaseUrl;
      process.env.ADMIN_JWT_SECRET = adminJwtSecret;

      res.status(201).json({ ok: true, redirectTo: "/login" });
    } catch (error) {
      if (error instanceof SetupError) {
        res.status(error.status).json({
          error: { code: error.code, message: error.message },
        });
        return;
      }
      res.status(500).json({
        error: {
          code: "setup_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      setupInProgress = false;
    }
  });
}
