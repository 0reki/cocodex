export type PortalRole = "admin" | "user";

export type PortalUser = {
  id: string;
  username: string;
  role: PortalRole;
  enabled: boolean;
  balance?: number;
  accountId?: string | null;
  sourceAccountId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type TokenEnvelope = {
  token: string;
  expiresAt: number;
};

export type AuthResponse = {
  ok: true;
  user: PortalUser;
  accessToken: TokenEnvelope;
};

export type UpstreamPlatform = "windows" | "linux" | "darwin" | "all";

export type OpenAIAccount = {
  id: string;
  email: string;
  accountId: string;
  status: "active" | "inactive" | "disabled";
  platform: UpstreamPlatform;
  createdAt: string;
  updatedAt: string;
};

export type OpenAIAccountsResponse = {
  items: OpenAIAccount[];
  count: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type RequestLog = {
  id: string;
  intentId: string | null;
  isFinal: boolean | null;
  streamEndReason: string | null;
  path: string;
  modelId: string | null;
  requestedModel: string | null;
  usedModel: string | null;
  turnStateLen: number | null;
  keyId: string | null;
  serviceTier: string | null;
  statusCode: number | null;
  ttfbMs: number | null;
  // Time to the first generated token (not the first byte).
  ttftMs: number | null;
  latencyMs: number | null;
  tokensInfo: Record<string, unknown> | null;
  totalTokens: number | null;
  cost: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestTime: string;
  createdAt: string;
  updatedAt: string;
};

export type RequestLogsResponse = {
  items: RequestLog[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
};

export type HourlyPoint = {
  hour: string;
  values: Record<string, { tokens: number; cost: number; requests: number }>;
};

export type HourlyStatsResponse = {
  models: string[];
  points: HourlyPoint[];
  rpm5m: number;
  tpm5m: number;
};

export type UsersResponse = {
  items: PortalUser[];
  count: number;
};

export type PortalInvitationResponse = {
  ok: true;
  invitation: {
    id: string;
    expiresAt: string;
  };
  registrationPath: string;
  registrationUrl: string;
};

export type QuotaWindow = {
  resetAt: number;
  usedPercent: number;
  limitWindowSeconds: number;
};

export type UserQuotaAllocation = {
  sourceAccountId: string;
  quotaPool: "standard" | "spark";
  resetAt: number;
  usedPercent: number;
  carryInPercent: number;
  carryInUserId: string | null;
  syncRequired: boolean;
  initializedAt: string;
  updatedAt: string;
  userUsageAmount: number;
  totalUsageAmount: number;
  allocatedPercent: number;
};

export type UserQuotaPool = {
  available: boolean;
  usageUnit: "weighted_usd" | "tokens";
  shortWindow: QuotaWindow | null;
  weeklyWindow: QuotaWindow | null;
  allocation: UserQuotaAllocation | null;
  members: Array<{
    ownerUserId: string;
    username: string;
    role: PortalRole;
    enabled: boolean;
    usageAmount: number;
    allocatedPercent: number;
  }>;
};

export type MyUsageResponse = {
  ok: true;
  capturedAt: string;
  limitPercent: number;
  users: PortalUser[];
  pools: {
    standard: UserQuotaPool;
    // The backend only returns pools it has; Spark may be absent.
    spark?: UserQuotaPool;
  };
};
