import { query } from "../../core/db.ts"
import {
  mapOpenAIAccountRow,
  OPENAI_ACCOUNT_COLUMNS,
  type OpenAIAccountRow,
} from "./shared.ts"

export async function listOpenAIAccountsPage(
  page = 1,
  pageSize = 50,
  filters?: { status?: string | null; keyword?: string | null },
) {
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.max(1, Math.min(Math.floor(pageSize), 500))
  const offset = (safePage - 1) * safePageSize
  const whereClauses: string[] = []
  const values: unknown[] = []
  const status = filters?.status?.trim().toLowerCase()
  const keyword = filters?.keyword?.trim()

  if (status) {
    values.push(status)
    whereClauses.push(`LOWER(TRIM(COALESCE(status, ''))) = $${values.length}`)
  }
  if (keyword) {
    values.push(`%${keyword}%`)
    whereClauses.push(`email ILIKE $${values.length}`)
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : ""
  const totalResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM openai_accounts ${whereSql}`,
    values,
  )
  const result = await query<OpenAIAccountRow>(
    `
      SELECT ${OPENAI_ACCOUNT_COLUMNS}
      FROM openai_accounts
      ${whereSql}
      ORDER BY updated_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, safePageSize, offset],
  )

  return {
    items: result.rows.map(mapOpenAIAccountRow),
    total: Number(totalResult.rows[0]?.count ?? "0"),
    page: safePage,
    pageSize: safePageSize,
  }
}

export async function getOpenAIAccountByEmail(email: string) {
  const normalizedEmail = email.trim()
  if (!normalizedEmail) return null

  const result = await query<OpenAIAccountRow>(
    `
      SELECT ${OPENAI_ACCOUNT_COLUMNS}
      FROM openai_accounts
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `,
    [normalizedEmail],
  )
  return result.rows[0] ? mapOpenAIAccountRow(result.rows[0]) : null
}
