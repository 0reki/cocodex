export type RefreshCodexTokensOptions = {
  refreshToken: string;
  clientId?: string;
  userAgent?: string;
  platform?: string;
  signal?: AbortSignal;
};

export type CodexTokenRefreshResponse = {
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
};

export type GetCodexUsageOptions = {
  accessToken: string;
  accountId?: string;
  clientVersion: string;
  userAgent?: string;
  platform?: string;
  signal?: AbortSignal;
};

export type GetCodexDailyWorkspaceUsageOptions = GetCodexUsageOptions & {
  startDate: string;
  endDate: string;
};

export type PostCodexResponsesOptions = {
  accessToken: string;
  accountId?: string;
  version: string;
  sessionId: string;
  requestHeaders?: HeadersInit;
  payload?: Record<string, unknown> | null;
  userAgent?: string;
  platform?: string;
  originator?: string;
  signal?: AbortSignal;
};
