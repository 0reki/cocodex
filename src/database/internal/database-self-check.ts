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
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = 'api_keys'
            AND c.conname = 'fk_api_keys_owner_user'
        ) AS exists
      `,
    )
    if (!fkRes.rows[0]?.exists) {
      pushIssue({
        id: "api_keys_owner_fk_missing",
        level: "error",
        message: "Missing foreign key fk_api_keys_owner_user on api_keys.owner_user_id",
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
