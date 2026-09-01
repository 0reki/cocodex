import { query } from "../../core/db.ts"
import {
  mapOpenAIAccountRow,
  OPENAI_ACCOUNT_COLUMNS,
  type OpenAIAccountRow,
} from "./shared.ts"

export async function getActiveOpenAIAccount() {
  const result = await query<OpenAIAccountRow>(
    `
      SELECT ${OPENAI_ACCOUNT_COLUMNS}
      FROM openai_accounts
      WHERE LOWER(TRIM(status)) = 'active'
        AND access_token IS NOT NULL
        AND BTRIM(access_token) <> ''
      ORDER BY updated_at DESC
      LIMIT 1
    `,
  )
  const row = result.rows[0]
  return row ? mapOpenAIAccountRow(row) : null
}
