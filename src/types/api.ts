export type PortalRole = "admin" | "user";

export type PortalUser = {
  id: string;
  username: string;
  role: PortalRole;
  enabled: boolean;
  balance?: number;
  accountId?: string | null;
  sourceAccountId?: string | null;
  // Admin user list only: the quota the user's profile and overrides give.
  quota?: UserQuota | null;
  createdAt?: string;
  updatedAt?: string;
};

// What a user may consume. A null feature limit means the gateway sets none
// of its own; the upstream account's pool still applies.
export type QuotaLimits = {
  weeklySharePercent: number;
  deepResearchLimit: number | null;
  imageGenLimit: number | null;
  // Messages to Pro models (gpt-*-pro) per rolling week.
  proMessageLimit: number | null;
};

export type QuotaProfile = QuotaLimits & {
  id: string;
  name: string;
  isDefault: boolean;
  userCount: number;
  createdAt: string;
  updatedAt: string;
};

export type QuotaProfilesResponse = { items: QuotaProfile[] };

// A key present in `overrides` replaces the profile's value (a null limit
// overrides to none).
export type UserQuota = {
  profileId: string | null;
  profileName: string | null;
  overrides: Partial<QuotaLimits>;
  effective: QuotaLimits;
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

// macOS clients are served by the Linux login, so a login is only ever
// Windows or Linux ("all" is a generic login that serves both).
export type UpstreamPlatform = "windows" | "linux" | "all";

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
