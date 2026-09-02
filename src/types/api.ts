export type PortalRole = "admin" | "user";

export type PortalUser = {
  id: string;
  username: string;
  role: PortalRole;
  enabled: boolean;
  balance?: number;
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
  refreshToken: TokenEnvelope;
};

export type OpenAIAccount = {
  id: string;
  email: string;
  accountId: string;
  status: "active" | "inactive" | "disabled";
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

export type ApiKey = {
  id: string;
  ownerUserId: string | null;
  name: string;
  apiKey: string;
  quota: number | null;
  used: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiKeysResponse = {
  items: ApiKey[];
  count: number;
};

export type RequestLog = {
  id: string;
  intentId: string | null;
  isFinal: boolean | null;
  streamEndReason: string | null;
  path: string;
  modelId: string | null;
  keyId: string | null;
  serviceTier: string | null;
  statusCode: number | null;
  ttfbMs: number | null;
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
