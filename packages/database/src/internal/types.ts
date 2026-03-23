export type OpenAIAccountRecord = {
  id: string
  userId: string | null
  portalUserId: string | null
  name: string | null
  email: string
  picture: string | null
  accountId: string | null
  accountUserRole: string | null
  workspaceName: string | null
  planType: string | null
  teamExpiresAt: string | null
  workspaceIsDeactivated: boolean
  workspaceCancelledAt: string | null
  status: string | null
  isShared: boolean
  systemCreated: boolean
  proxyId: string | null
  accessToken: string | null
  refreshToken: string | null
  sessionToken: string | null
  type: string | null
  createdAt: string
  updatedAt: string
  cooldownUntil: string | null
  rateLimit: Record<string, unknown> | null
}

export type TeamAccountRecord = {
  id: string
  userId: string | null
  portalUserId: string | null
  ownerId: string | null
  name: string | null
  email: string
  accountId: string | null
  accountUserRole: string | null
  workspaceName: string | null
  planType: string | null
  teamMemberCount: number | null
  teamExpiresAt: string | null
  workspaceIsDeactivated: boolean
  workspaceCancelledAt: string | null
  systemCreated: boolean
  proxyId: string | null
  accessToken: string | null
  refreshToken: string | null
  type: string | null
  createdAt: string
  updatedAt: string
  cooldownUntil: string | null
  rateLimit: Record<string, unknown> | null
}

export type TeamAccountLoginRecord = TeamAccountRecord & {
  password: string | null
}

export type SignupProxyRecord = {
  id: string
  proxyUrl: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type SignupTaskRecord = {
  id: string
  kind: string
  status: string
  count: number
  concurrency: number
  cpuMaxConcurrency: number
  proxyPoolSize: number
  savedCount: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  error: string | null
  result: Record<string, unknown> | null
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
  userRpmLimit: number | null
  userMaxInFlight: number | null
  createdAt: string
  updatedAt: string
}

export type PortalUserWithBalanceRecord = PortalUserRecord & {
  balance: number
}

export type PortalInboxMessageRecord = {
  id: string
  recipientUserId: string
  senderUserId: string | null
  senderUsername: string | null
  title: string
  body: string
  aiTranslated: boolean
  readAt: string | null
  createdAt: string
  updatedAt: string
}

export type PortalUserBillingProfileRecord = {
  userId: string
  balance: number
  currency: string
  createdAt: string
  updatedAt: string
}

export type PortalUserBillingUsage = {
  dailyCost: number
  weeklyCost: number
  monthlyCost: number
}

export type PortalUserSpendAllowance = {
  allowanceRemaining: number
  addonRemaining: number
  balance: number
  totalAvailable: number
}

export type PortalUserAddonAllowanceRecord = {
  userId: string
  submittedAccounts: number
  dailyQuota: number
  dailyUsed: number
  weeklyCap: number
  weeklyUsed: number
  monthlyCap: number
  monthlyUsed: number
  dailyRemaining: number
  weeklyRemaining: number
  monthlyRemaining: number
  createdAt: string
  updatedAt: string
}

export type PortalUserAddonItemRecord = {
  id: string
  sourceAccountId: string
  sourceAccountEmail: string
  sourceAccountType: string
  status: string
  disableReason: string | null
  grantedAt: string
  effectiveAt: string
  expiresAt: string | null
  sourceAccountPlanExpiresAt: string | null
  lastValidatedAt: string | null
  dailyQuota: number
  dailyUsed: number
  dailyRemaining: number
  weeklyCap: number
  weeklyUsed: number
  weeklyRemaining: number
  monthlyCap: number
  monthlyUsed: number
  monthlyRemaining: number
  createdAt: string
  updatedAt: string
}

export type PortalUserBillingSnapshot = {
  profile: PortalUserBillingProfileRecord
  usage: PortalUserBillingUsage
  addOns: PortalUserAddonAllowanceRecord
  addOnItems: PortalUserAddonItemRecord[]
  allowance: PortalUserSpendAllowance
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

export type PortalUserIdentityRecord = {
  id: string
  userId: string
  provider: string
  providerUserId: string
  providerUsername: string | null
  providerName: string | null
  avatarUrl: string | null
  createdAt: string
  updatedAt: string
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

export type OpenAIAccountStats = {
  total: number
  active: number
  coolingDown: number
  disabled: number
  dailyRequestCount: number
  totalRequestCount: number
  dailyRequestTokens: number
  totalTokens: number
  dailyRequestCost: number
  totalCost: number
  rpm5m: number
  tpm5m: number
}

export type PortalUserAccountStats = {
  total: number
  active: number
  coolingDown: number
  disabled: number
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

export type SystemSettingsRecord = {
  openaiApiUserAgent: string | null
  openaiClientVersion: string | null
  inboxTranslationModel: string | null
  cloudMailDomains: string[] | null
  ownerMailDomains: string[] | null
  accountSubmissionAddonDailyQuota: number | null
  accountSubmissionAddonWeeklyCap: number | null
  accountSubmissionAddonMonthlyCap: number | null
  accountCacheSize: number | null
  accountCacheRefreshSeconds: number | null
  maxAttemptCount: number | null
  userRpmLimit: number | null
  userMaxInFlight: number | null
  checkInRewardMin: number | null
  checkInRewardMax: number | null
  openaiModels: Array<Record<string, unknown>> | null
  openaiModelsUpdatedAt: string | null
  createdAt: string
  updatedAt: string
}

export type UpsertSystemSettingsInput = {
  openaiApiUserAgent: string | null
  openaiClientVersion: string | null
  inboxTranslationModel?: string | null
  cloudMailDomains?: string[] | null
  ownerMailDomains?: string[] | null
  accountSubmissionAddonDailyQuota?: number | null
  accountSubmissionAddonWeeklyCap?: number | null
  accountSubmissionAddonMonthlyCap?: number | null
  accountCacheSize: number | null
  accountCacheRefreshSeconds: number | null
  maxAttemptCount: number | null
  userRpmLimit: number | null
  userMaxInFlight: number | null
  checkInRewardMin: number | null
  checkInRewardMax: number | null
}

export type ServiceStatusLevel = "operational" | "degraded" | "unknown"

export type ServiceStatusMonitorRecord = {
  id: string
  slug: string
  name: string
  endpoint: string
  method: string
  enabled: boolean
  intervalSeconds: number
  timeoutMs: number
  createdAt: string
  updatedAt: string
}

export type ServiceStatusSampleRecord = {
  id: string
  monitorId: string
  checkedAt: string
  ok: boolean
  statusCode: number | null
  latencyMs: number | null
  errorMessage: string | null
  createdAt: string
}

export type ServiceStatusMonitorSnapshot = ServiceStatusMonitorRecord & {
  level: ServiceStatusLevel
  uptimePercent: number
  latestCheckedAt: string | null
  latestStatusCode: number | null
  latestLatencyMs: number | null
  latestErrorMessage: string | null
  samples: ServiceStatusSampleRecord[]
}

export type ServiceStatusOverview = {
  level: ServiceStatusLevel
  monitors: ServiceStatusMonitorSnapshot[]
  generatedAt: string
}

export type UpsertOpenAIAccountInput = {
  userId?: string | null
  portalUserId?: string | null
  name?: string | null
  email: string
  picture?: string | null
  accountId?: string | null
  accountUserRole?: string | null
  workspaceName?: string | null
  planType?: string | null
  teamMemberCount?: number | null
  teamExpiresAt?: string | Date | null
  workspaceIsDeactivated?: boolean
  workspaceCancelledAt?: string | Date | null
  status?: string | null
  isShared?: boolean
  systemCreated?: boolean
  proxyId?: string | null
  accessToken?: string | null
  refreshToken?: string | null
  sessionToken?: string | null
  password?: string | null
  type?: string | null
  cooldownUntil?: string | Date | null
  rateLimit?: Record<string, unknown> | null
}

export type UpsertTeamAccountInput = {
  userId?: string | null
  portalUserId?: string | null
  ownerId?: string | null
  name?: string | null
  email: string
  accountId?: string | null
  accountUserRole?: string | null
  workspaceName?: string | null
  planType?: string | null
  teamMemberCount?: number | null
  teamExpiresAt?: string | Date | null
  workspaceIsDeactivated?: boolean
  workspaceCancelledAt?: string | Date | null
  status?: string | null
  systemCreated?: boolean
  proxyId?: string | null
  accessToken?: string | null
  refreshToken?: string | null
  password?: string | null
  type?: string | null
  cooldownUntil?: string | Date | null
  rateLimit?: Record<string, unknown> | null
}
