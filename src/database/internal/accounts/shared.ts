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
  user_id: string | null
  name: string | null
  email: string
  picture: string | null
  account_id: string | null
  status: string | null
  access_token: string | null
  session_token: string | null
  created_at: Date
  updated_at: Date
}

export const OPENAI_ACCOUNT_COLUMNS = `
  id, user_id, name, email, picture, account_id, status, access_token, session_token,
  created_at, updated_at
`

export function mapOpenAIAccountRow(row: OpenAIAccountRow): OpenAIAccountRecord {
  const status = normalizeOpenAIAccountStatus(row.status ?? "") ?? "inactive"

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    picture: row.picture,
    accountId: row.account_id,
    status,
    accessToken: row.access_token,
    sessionToken: row.session_token,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}
