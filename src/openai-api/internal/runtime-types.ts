import type { WsSocket } from "./runtime-platform.ts";

export type RefreshCodexTokensOptions = {
  refreshToken: string;
  clientId?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type CodexTokenRefreshResponse = {
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
};

export type GetCodexModelsOptions = {
  accessToken: string;
  accountId?: string;
  clientVersion: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type CodexModelsResponse = {
  models?: Array<Record<string, unknown>>;
};

export type GetCodexUsageOptions = {
  accessToken: string;
  accountId?: string;
  clientVersion: string;
  userAgent?: string;
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
  originator?: string;
  signal?: AbortSignal;
};

export type CodexImageOperation = "generations" | "edits";

export type PostCodexImageOptions = {
  accessToken: string;
  accountId?: string;
  version: string;
  sessionId: string;
  operation: CodexImageOperation;
  requestHeaders?: HeadersInit;
  payload: Record<string, unknown>;
  userAgent?: string;
  originator?: string;
  signal?: AbortSignal;
};

export type ConnectCodexResponsesWebSocketOptions = {
  accessToken: string;
  accountId?: string;
  version: string;
  sessionId?: string;
  requestHeaders?: HeadersInit;
  query?: string;
  userAgent?: string;
  originator?: string;
  signal?: AbortSignal;
};

export type CodexResponsesWebSocketConnection = {
  socket: WsSocket;
  responseHeaders: Record<string, string>;
};
