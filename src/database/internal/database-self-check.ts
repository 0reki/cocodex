import { query } from "../core/db.ts"
import type {
  DatabaseSelfCheckIssue,
  DatabaseSelfCheckReport,
} from "./types.ts"

export async function runDatabaseSelfCheck(): Promise<DatabaseSelfCheckReport> {
  const issues: DatabaseSelfCheckIssue[] = []

  const pushIssue = (issue: DatabaseSelfCheckIssue) => {
    issues.push(issue)
  }

  const pushQueryFailure = (id: string, error: unknown) => {
    pushIssue({
      id,
      level: "warning",
      message: "Self-check query failed",
      details: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    const fkRes = await query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_class source_table ON source_table.oid = c.conrelid
          JOIN pg_namespace source_schema ON source_schema.oid = source_table.relnamespace
          JOIN pg_class target_table ON target_table.oid = c.confrelid
          JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
          JOIN LATERAL unnest(c.conkey) WITH ORDINALITY
            AS source_key(attnum, position) ON TRUE
          JOIN LATERAL unnest(c.confkey) WITH ORDINALITY
            AS target_key(attnum, position)
            ON target_key.position = source_key.position
          JOIN pg_attribute source_column
            ON source_column.attrelid = c.conrelid
            AND source_column.attnum = source_key.attnum
          JOIN pg_attribute target_column
            ON target_column.attrelid = c.confrelid
            AND target_column.attnum = target_key.attnum
          WHERE c.contype = 'f'
            AND source_schema.nspname = current_schema()
            AND target_schema.nspname = current_schema()
            AND source_table.relname = 'api_keys'
            AND source_column.attname = 'owner_user_id'
            AND target_table.relname = 'portal_users'
            AND target_column.attname = 'id'
        ) AS exists
      `,
    )
    if (!fkRes.rows[0]?.exists) {
      pushIssue({
        id: "api_keys_owner_fk_missing",
        level: "error",
        message: "Missing foreign key from api_keys.owner_user_id to portal_users.id",
      })
    }
  } catch (error) {
    pushQueryFailure("api_keys_owner_fk_check_failed", error)
  }

  try {
    const orphanApiKeysRes = await query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM api_keys keys
        LEFT JOIN portal_users users ON users.id = keys.owner_user_id
        WHERE keys.owner_user_id IS NOT NULL
          AND users.id IS NULL
      `,
    )
    const count = Number(orphanApiKeysRes.rows[0]?.count ?? "0")
    if (count > 0) {
      pushIssue({
        id: "api_keys_orphan_owner",
        level: "error",
        message: "Found API keys with missing owner user",
        count,
      })
    }
  } catch (error) {
    pushQueryFailure("api_keys_orphan_owner_check_failed", error)
  }

  return {
    ok: issues.filter((item) => item.level === "error").length === 0,
    checkedAt: new Date().toISOString(),
    issues,
  }
}
