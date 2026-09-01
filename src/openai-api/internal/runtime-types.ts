export type ChatgptSessionResponse = {
  accessToken?: string;
  [key: string]: unknown;
};

export type GetChatgptSessionOptions = {
  sessionToken?: string;
  sessionTokenChunks?: string[];
  cookieHeader?: string;
  userAgent?: string;
  signal?: AbortSignal;
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

export type PostCodexResponsesCompactOptions = PostCodexResponsesOptions;

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

export type SessionTokenCookieMap = {
  "__Secure-next-auth.session-token"?: string;
  "__Secure-next-auth.session-token.0"?: string;
  "__Secure-next-auth.session-token.1"?: string;
  [key: `__Secure-next-auth.session-token.${number}`]: string | undefined;
};

export type ChatgptSessionWithCookies = {
  session: ChatgptSessionResponse;
  setCookies: string[];
  sessionTokenCookies: SessionTokenCookieMap;
};
