import { withTransaction } from "../../core/db.ts"
import type { UpsertOpenAIAccountInput } from "../types.ts"
import {
  mapOpenAIAccountRow,
  normalizeOpenAIAccountStatus,
  type OpenAIAccountRow,
} from "./shared.ts"

export async function upsertOpenAIAccount(input: UpsertOpenAIAccountInput) {
  return withTransaction(async (client) => {
    const requestedStatus = input.status?.trim() ?? ""
    const normalizedRequestedStatus = requestedStatus
      ? normalizeOpenAIAccountStatus(requestedStatus)
      : null
    if (requestedStatus && !normalizedRequestedStatus) {
      throw new Error(`Invalid OpenAI account status: ${requestedStatus}`)
    }

    const existing = await client.query<{ status: string | null }>(
      `SELECT status FROM openai_accounts WHERE email = $1 FOR UPDATE`,
      [input.email],
    )
    let status = normalizedRequestedStatus
    if (!status && existing.rows[0]) {
      status = normalizeOpenAIAccountStatus(existing.rows[0].status ?? "") ?? "inactive"
    }
    if (!status) {
      const active = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM openai_accounts
          WHERE LOWER(TRIM(status)) = 'active'
        ) AS exists
      `)
      status = active.rows[0]?.exists ? "inactive" : "active"
    }

    if (status === "active") {
      await client.query(
        `
          UPDATE openai_accounts
          SET status = 'inactive'
          WHERE LOWER(TRIM(status)) = 'active'
            AND email <> $1
        `,
        [input.email],
      )
    }

    const result = await client.query<OpenAIAccountRow>(
      `
        INSERT INTO openai_accounts (
          user_id, name, email, picture, account_id, status,
          access_token, session_token
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )
        ON CONFLICT (email) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          name = EXCLUDED.name,
          picture = EXCLUDED.picture,
          account_id = EXCLUDED.account_id,
          status = EXCLUDED.status,
          access_token = EXCLUDED.access_token,
          session_token = EXCLUDED.session_token
        RETURNING *
      `,
      [
        input.userId ?? null,
        input.name ?? null,
        input.email,
        input.picture ?? null,
        input.accountId ?? null,
        status,
        input.accessToken ?? null,
        input.sessionToken ?? null,
      ],
    )

    const row = result.rows[0]
    if (!row) throw new Error("Failed to upsert OpenAI account")

    return mapOpenAIAccountRow(row)
  })
}
