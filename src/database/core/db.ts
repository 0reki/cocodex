import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { getInitSchemaSql } from "../schema/sql.ts";

declare global {
  var __cocodexPgPool: Pool | undefined;
  var __cocodexSchemaReady: boolean | undefined;
  var __cocodexSchemaInitPromise: Promise<void> | undefined;
}

const SCHEMA_INIT_LOCK_KEY = 8_453_201_114_257n;

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  return url;
}

export function getDbPool() {
  if (!globalThis.__cocodexPgPool) {
    const pool = new Pool({
      connectionString: requireDatabaseUrl(),
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
      ssl:
        process.env.PG_SSL_MODE === "require"
          ? { rejectUnauthorized: false }
          : undefined,
    });
    pool.on("error", (error) => {
      console.error(
        "[database] pg pool emitted an idle client error:",
        error instanceof Error ? error.message : String(error),
      );
    });
    globalThis.__cocodexPgPool = pool;
  }

  return globalThis.__cocodexPgPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  return getDbPool().query<T>(text, values);
}

export async function withTransaction<T>(
  handler: (client: PoolClient) => Promise<T>,
) {
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureDatabaseSchema() {
  if (globalThis.__cocodexSchemaReady) return;

  if (!globalThis.__cocodexSchemaInitPromise) {
    globalThis.__cocodexSchemaInitPromise = (async () => {
      const client = await getDbPool().connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [
          SCHEMA_INIT_LOCK_KEY.toString(),
        ]);
        await client.query(getInitSchemaSql());
        globalThis.__cocodexSchemaReady = true;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore rollback failure
        }
        throw error;
      } finally {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [
            SCHEMA_INIT_LOCK_KEY.toString(),
          ]);
        } catch {
          // ignore unlock failure on broken connections
        }
        client.release();
      }
    })().finally(() => {
      if (!globalThis.__cocodexSchemaReady) {
        globalThis.__cocodexSchemaInitPromise = undefined;
      }
    });
  }

  await globalThis.__cocodexSchemaInitPromise;
}
