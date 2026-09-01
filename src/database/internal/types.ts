export type OpenAIAccountStatus =
  | "active"
  | "inactive"
  | "disabled"

export type OpenAIAccountRecord = {
  id: string
  userId: string | null
  name: string | null
  email: string
  picture: string | null
  accountId: string | null
  status: OpenAIAccountStatus
  accessToken: string | null
  sessionToken: string | null
  createdAt: string
  updatedAt: string
}

export type ApiKeyRecord = {
  id: string
  ownerUserId: string | null
  name: string
  apiKey: string
  quota: number | null
  used: number
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export type PortalUserRole = "admin" | "user"

export type PortalUserRecord = {
  id: string
  username: string
  email: string | null
  passwordHash: string
  avatarUrl: string | null
  country: string | null
  role: PortalUserRole
  enabled: boolean
  mustSetup: boolean
  createdAt: string
  updatedAt: string
}

export type PortalUserWithBalanceRecord = PortalUserRecord & {
  balance: number
}

export type PortalUserBillingProfileRecord = {
  userId: string
  balance: number
  currency: string
  createdAt: string
  updatedAt: string
}

export type PortalUserSpendAllowance = {
  balance: number
  totalAvailable: number
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
  attemptNo: number | null
  isFinal: boolean | null
  retryReason: string | null
  heartbeatCount: number | null
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
  userId?: string | null
  name?: string | null
  email: string
  picture?: string | null
  accountId?: string | null
  status?: string | null
  accessToken?: string | null
  sessionToken?: string | null
}
