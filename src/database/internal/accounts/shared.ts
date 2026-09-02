import type {
  OpenAIAccountRecord,
  OpenAIAccountStatus,
} from "../types.ts"

export const OPENAI_ACCOUNT_STATUSES = [
  "active",
  "inactive",
  "disabled",
] as const satisfies readonly OpenAIAccountStatus[]

export function normalizeOpenAIAccountStatus(
  status: string,
): OpenAIAccountStatus | null {
  const normalized = status.trim().toLowerCase().replaceAll(" ", "_")
  return OPENAI_ACCOUNT_STATUSES.find((item) => item === normalized) ?? null
}

export type OpenAIAccountRow = {
  id: string
  email: string
  account_id: string
  status: string | null
  id_token: string
  access_token: string
  refresh_token: string
  created_at: Date
  updated_at: Date
}

export const OPENAI_ACCOUNT_COLUMNS = `
  id, email, account_id, status, id_token, access_token, refresh_token,
  created_at, updated_at
`

export function mapOpenAIAccountRow(row: OpenAIAccountRow): OpenAIAccountRecord {
  const status = normalizeOpenAIAccountStatus(row.status ?? "") ?? "inactive"

  return {
    id: row.id,
    email: row.email,
    accountId: row.account_id,
    status,
    idToken: row.id_token,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}
