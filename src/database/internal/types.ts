export type OpenAIAccountStatus =
  | "active"
  | "inactive"
  | "disabled"

export type OpenAIAccountRecord = {
  id: string
  email: string
  accountId: string
  status: OpenAIAccountStatus
  idToken: string
  accessToken: string
  refreshToken: string
  createdAt: string
  updatedAt: string
}

export type ApiKeyRecord = {
  id: string
  ownerUserId: string | null
  name: string
  apiKey: string
  quota: string | null
  used: string
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
  updatedAt: string
}

export type PortalUserRole = "admin" | "user"

export type PortalUserRecord = {
  id: string
  username: string
  passwordHash: string
  role: PortalUserRole
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type DatabaseSelfCheckIssue = {
  id: string
  level: "warning" | "error"
  message: string
  count?: number
  details?: string
}

export type DatabaseSelfCheckReport = {
  ok: boolean
  checkedAt: string
  issues: DatabaseSelfCheckIssue[]
}

export type ModelResponseLogRecord = {
  id: string
  intentId: string | null
  isFinal: boolean | null
  streamEndReason: string | null
  path: string
  modelId: string | null
  keyId: string | null
  serviceTier: string | null
  statusCode: number | null
  ttfbMs: number | null
  latencyMs: number | null
  tokensInfo: Record<string, unknown> | null
  totalTokens: number | null
  cost: number | null
  errorCode: string | null
  errorMessage: string | null
  requestTime: string
  createdAt: string
  updatedAt: string
}

export type ModelHourlyTokenPoint = {
  hour: string
  values: Record<string, number>
}

export type ModelHourlyTokenSeries = {
  models: string[]
  points: ModelHourlyTokenPoint[]
}

export type ModelHourlyStatsPoint = {
  hour: string
  values: Record<
    string,
    {
      tokens: number
      cost: number
      requests: number
    }
  >
}

export type ModelHourlyStatsSeries = {
  models: string[]
  points: ModelHourlyStatsPoint[]
}

export type ApiKeyUsageStats = {
  dailyRequestCount: number
  totalRequestCount: number
  dailyRequestTokens: number
  totalTokens: number
  dailyRequestCost: number
  totalCost: number
  quota: number | null
  used: number
  remaining: number | null
  rpm5m: number
  tpm5m: number
}

export type PortalUserUsageStats = {
  dailyRequestCount: number
  totalRequestCount: number
  dailyRequestTokens: number
  totalTokens: number
  dailyRequestCost: number
  totalCost: number
  rpm5m: number
  tpm5m: number
}

export type RequestRateStats = {
  rpm5m: number
  tpm5m: number
}

export type ApiKeyModelUsage = {
  modelId: string
  requestCount: number
  totalTokens: number
  totalCost: number
  lastRequestTime: string | null
}

export type ApiKeyHourlyStatsPoint = {
  hour: string
  requests: number
  tokens: number
  cost: number
}

export type ApiKeyHourlyStatsSeries = {
  points: ApiKeyHourlyStatsPoint[]
}

export type UpsertOpenAIAccountInput = {
  email: string
  accountId: string
  status?: string | null
  idToken: string
  accessToken: string
  refreshToken: string
}
