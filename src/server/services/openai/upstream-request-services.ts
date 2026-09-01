import type { WsSocket } from "../../utils/network/ws.ts";

type RuntimeConfig = {
  userAgent: string;
  clientVersion: string;
};

type UpstreamTrace = {
  sourceAccountId?: string | null;
  sourceAccountEmail?: string | null;
  selectedUpstreamAccountId?: string | null;
};

type UpstreamSourceAccountRecord = {
  id: string;
  email: string;
  accessToken: string | null;
  accountId: string | null;
  userId: string | null;
  sessionToken?: string | null;
};

type OpenAIApiModule = {
  getAccessToken?: (args: {
    sessionToken: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<{
    accessToken?: string;
    session?: unknown;
    sessionTokenCookies?: Record<string, string | undefined>;
  }>;
  getCodexModels?: (args: {
    accessToken: string;
    accountId?: string;
    clientVersion: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<{ models?: Array<Record<string, unknown>> }>;
  postCodexResponses?: (args: {
    accessToken: string;
    accountId?: string;
    version: string;
    sessionId: string;
    requestHeaders?: HeadersInit;
    payload?: Record<string, unknown> | null;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<Response>;
  postCodexResponsesCompact?: (args: {
    accessToken: string;
    accountId?: string;
    version: string;
    sessionId: string;
    requestHeaders?: HeadersInit;
    payload?: Record<string, unknown> | null;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<Response>;
  connectCodexResponsesWebSocket?: (args: {
    accessToken: string;
    accountId?: string;
    version: string;
    sessionId: string;
    requestHeaders?: HeadersInit;
    query?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<unknown>;
};

export function createUpstreamRequestServices(deps: {
  randomUUID: () => string;
  resolveOpenAIUpstreamAccountId: (
    account: Pick<UpstreamSourceAccountRecord, "accountId" | "userId">,
  ) => string | null;
  updateOpenAIAccountAccessTokenById: (
    id: string,
    accessToken: string,
  ) => Promise<unknown>;
  disableOpenAIAccountByEmail: (email: string) => Promise<unknown>;
  extractErrorInfo: (error: unknown) => {
    status: number | null;
    errorPayload: Record<string, unknown> | null;
    message: string | null;
    rawResponseText: string | null;
  };
  isTokenInvalidatedError: (error: unknown) => boolean;
  createAbortError: () => Error;
}) {
  function requireWsSocket(value: unknown): WsSocket {
    if (!value || typeof value !== "object") {
      throw new Error("Responses WebSocket connector returned no socket");
    }
    const socket = value as Record<string, unknown>;
    if (
      typeof socket.readyState !== "number" ||
      typeof socket.send !== "function" ||
      typeof socket.close !== "function" ||
      typeof socket.terminate !== "function" ||
      typeof socket.on !== "function"
    ) {
      throw new Error("Responses WebSocket connector returned an invalid socket");
    }
    return value as WsSocket;
  }

  function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payloadPart = parts[1];
    if (!payloadPart) return null;
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    try {
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      const parsed = JSON.parse(decoded) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  function getAccessTokenExp(token: string): number | null {
    const payload = decodeJwtPayload(token);
    if (!payload) return null;
    const expRaw = payload.exp;
    if (typeof expRaw === "number" && Number.isFinite(expRaw)) {
      return Math.trunc(expRaw);
    }
    if (typeof expRaw === "string") {
      const parsed = Number(expRaw);
      if (Number.isFinite(parsed)) return Math.trunc(parsed);
    }
    return null;
  }

  function getSessionTokenFromCookieMap(
    cookies: Record<string, string | undefined> | undefined,
  ): string | null {
    if (!cookies || typeof cookies !== "object") return null;
    const direct = cookies["__Secure-next-auth.session-token"];
    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }
    const chunks = Object.entries(cookies)
      .filter(([name]) => name.startsWith("__Secure-next-auth.session-token."))
      .map(([name, value]) => {
        const index = Number(name.split(".").pop() ?? "");
        return {
          index: Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER,
          value: typeof value === "string" ? value : "",
        };
      })
      .sort((a, b) => a.index - b.index)
      .map((item) => item.value)
      .filter((item) => item.length > 0);
    if (chunks.length === 0) return null;
    return chunks.join("");
  }

  async function disableAccountForInvalidAuth(
    account: UpstreamSourceAccountRecord,
    reason: string,
  ) {
    await markAccountDisabledForInvalidAuth(account, reason);
    throw new Error(reason);
  }

  async function markAccountDisabledForInvalidAuth(
    account: UpstreamSourceAccountRecord,
    reason: string,
  ) {
    try {
      await deps.disableOpenAIAccountByEmail(account.email);
    } catch (error) {
      console.warn(
        `[auth] failed to disable account ${account.email}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.warn(`[auth] disabled account ${account.email}: ${reason}`);
  }

  async function isTokenInvalidatedResponse(response: Response) {
    if (response.status !== 401) return false;
    const body = await response.clone().text();
    return deps.isTokenInvalidatedError(new Error(`HTTP 401: ${body}`));
  }

  async function refreshUpstreamSourceAccountAccessToken(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    runtimeConfig: RuntimeConfig;
    signal?: AbortSignal;
  }) {
    const { module, account, runtimeConfig, signal } = params;
    if (typeof module.getAccessToken !== "function") {
      await disableAccountForInvalidAuth(
        account,
        "Account disabled: refresh function unavailable",
      );
    }

    const currentAccessToken = account.accessToken?.trim() ?? "";
    const exp = getAccessTokenExp(currentAccessToken);
    const nowSec = Math.floor(Date.now() / 1000);
    if (exp === null || exp >= nowSec) {
      await disableAccountForInvalidAuth(
        account,
        "Account disabled: access token exp is not expired for refresh policy.",
      );
    }

    const sessionToken = account.sessionToken?.trim() ?? "";
    if (!sessionToken) {
      await disableAccountForInvalidAuth(
        account,
        "Account disabled: missing session token for refresh",
      );
    }

    const refreshed = await module.getAccessToken!({
      sessionToken,
      userAgent: runtimeConfig.userAgent,
      signal,
    });
    const refreshedSession =
      refreshed &&
      "session" in refreshed &&
      refreshed.session &&
      typeof refreshed.session === "object"
        ? (refreshed.session as Record<string, unknown>)
        : null;
    const isEmptySessionResponse =
      refreshedSession !== null && Object.keys(refreshedSession).length === 0;
    if (isEmptySessionResponse) {
      await disableAccountForInvalidAuth(
        account,
        "Account disabled: refresh endpoint returned empty JSON object",
      );
    }
    const refreshedAccessToken =
      typeof refreshed.accessToken === "string"
        ? refreshed.accessToken.trim()
        : "";
    if (!refreshedAccessToken) {
      await disableAccountForInvalidAuth(
        account,
        "Account disabled: refresh did not return a valid access token",
      );
    }

    const refreshedSessionToken = getSessionTokenFromCookieMap(
      refreshed.sessionTokenCookies,
    );
    account.accessToken = refreshedAccessToken;
    if (refreshedSessionToken) {
      account.sessionToken = refreshedSessionToken;
    }
    await deps.updateOpenAIAccountAccessTokenById(account.id, refreshedAccessToken);
    return refreshedAccessToken;
  }

  async function postCodexResponsesWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    payload: Record<string, unknown>;
    requestHeaders?: HeadersInit;
    runtimeConfig: RuntimeConfig;
    trace?: UpstreamTrace;
    signal?: AbortSignal;
  }): Promise<Response> {
    const {
      module,
      account,
      payload,
      requestHeaders,
      runtimeConfig,
      trace,
      signal,
    } = params;
    if (typeof module.postCodexResponses !== "function") {
      throw new Error(
        "postCodexResponses is not exported from the internal OpenAI module",
      );
    }

    const resolvedAccountId = deps.resolveOpenAIUpstreamAccountId(account);
    if (!resolvedAccountId) {
      throw new Error("No active upstream account");
    }
    const sessionId = deps.randomUUID();
    if (trace) {
      trace.sourceAccountId = account.id;
      trace.sourceAccountEmail = account.email;
      trace.selectedUpstreamAccountId = resolvedAccountId;
    }

    const callUpstream = async (accessToken: string) =>
      module.postCodexResponses!({
        accessToken,
        accountId: resolvedAccountId,
        version: runtimeConfig.clientVersion,
        sessionId,
        requestHeaders,
        payload,
        userAgent: runtimeConfig.userAgent,
        signal,
      });

    const currentAccessToken = account.accessToken?.trim() ?? "";
    if (!currentAccessToken) {
      throw new Error("No active upstream account");
    }

    const response = await callUpstream(currentAccessToken);
    if (!(await isTokenInvalidatedResponse(response))) return response;

    const refreshedAccessToken = await refreshUpstreamSourceAccountAccessToken({
      module,
      account,
      runtimeConfig,
      signal,
    });
    const retryResponse = await callUpstream(refreshedAccessToken);
    if (await isTokenInvalidatedResponse(retryResponse)) {
      await markAccountDisabledForInvalidAuth(
        account,
        "token still invalidated after refresh",
      );
    }
    return retryResponse;
  }

  async function getCodexModelsWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    runtimeConfig: RuntimeConfig;
    signal?: AbortSignal;
  }) {
    const { module, account, runtimeConfig, signal } = params;
    if (typeof module.getCodexModels !== "function") {
      throw new Error(
        "getCodexModels is not exported from the internal OpenAI module",
      );
    }

    const resolvedAccountId = deps.resolveOpenAIUpstreamAccountId(account);
    if (!resolvedAccountId) throw new Error("No active upstream account");

    const callUpstream = (accessToken: string) =>
      module.getCodexModels!({
        accessToken,
        accountId: resolvedAccountId,
        clientVersion: runtimeConfig.clientVersion,
        userAgent: runtimeConfig.userAgent,
        signal,
      });
    const currentAccessToken = account.accessToken?.trim() ?? "";
    if (!currentAccessToken) throw new Error("No active upstream account");

    try {
      return await callUpstream(currentAccessToken);
    } catch (error) {
      if (!deps.isTokenInvalidatedError(error)) throw error;
      const refreshedAccessToken = await refreshUpstreamSourceAccountAccessToken({
        module,
        account,
        runtimeConfig,
        signal,
      });
      try {
        return await callUpstream(refreshedAccessToken);
      } catch (retryError) {
        if (deps.isTokenInvalidatedError(retryError)) {
          await disableAccountForInvalidAuth(
            account,
            "Account disabled: token still invalidated after refresh",
          );
        }
        throw retryError;
      }
    }
  }

  async function postCodexResponsesCompactWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    payload: Record<string, unknown>;
    requestHeaders?: HeadersInit;
    runtimeConfig: RuntimeConfig;
    signal?: AbortSignal;
  }): Promise<Response> {
    const {
      module,
      account,
      payload,
      requestHeaders,
      runtimeConfig,
      signal,
    } = params;
    if (typeof module.postCodexResponsesCompact !== "function") {
      throw new Error(
        "postCodexResponsesCompact is not exported from the internal OpenAI module",
      );
    }

    const resolvedAccountId = deps.resolveOpenAIUpstreamAccountId(account);
    if (!resolvedAccountId) {
      throw new Error("No active upstream account");
    }
    const sessionId = deps.randomUUID();

    const callUpstream = async (accessToken: string) =>
      module.postCodexResponsesCompact!({
        accessToken,
        accountId: resolvedAccountId,
        version: runtimeConfig.clientVersion,
        sessionId,
        requestHeaders,
        payload,
        userAgent: runtimeConfig.userAgent,
        signal,
      });

    const currentAccessToken = account.accessToken?.trim() ?? "";
    if (!currentAccessToken) {
      throw new Error("No active upstream account");
    }

    const response = await callUpstream(currentAccessToken);
    if (!(await isTokenInvalidatedResponse(response))) return response;

    const refreshedAccessToken = await refreshUpstreamSourceAccountAccessToken({
      module,
      account,
      runtimeConfig,
      signal,
    });
    const retryResponse = await callUpstream(refreshedAccessToken);
    if (await isTokenInvalidatedResponse(retryResponse)) {
      await markAccountDisabledForInvalidAuth(
        account,
        "token still invalidated after refresh",
      );
    }
    return retryResponse;
  }

  async function connectCodexResponsesWebSocketWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    runtimeConfig: RuntimeConfig;
    requestHeaders?: HeadersInit;
    query?: string;
    signal?: AbortSignal;
  }) {
    const { module, account, runtimeConfig, requestHeaders, query, signal } =
      params;
    if (typeof module.connectCodexResponsesWebSocket !== "function") {
      throw new Error(
        "connectCodexResponsesWebSocket is not exported from the internal OpenAI module",
      );
    }

    const resolvedAccountId = deps.resolveOpenAIUpstreamAccountId(account);
    if (!resolvedAccountId) {
      throw new Error("No active upstream account");
    }
    const callUpstream = async (accessToken: string) => {
      const socket = await module.connectCodexResponsesWebSocket!({
        accessToken,
        accountId: resolvedAccountId,
        version: runtimeConfig.clientVersion,
        sessionId: deps.randomUUID(),
        requestHeaders,
        query,
        userAgent: runtimeConfig.userAgent,
        signal,
      });
      return requireWsSocket(socket);
    };

    const currentAccessToken = account.accessToken?.trim() ?? "";
    if (!currentAccessToken) {
      throw new Error("No active upstream account");
    }

    try {
      return await callUpstream(currentAccessToken);
    } catch (error) {
      const errorInfo = deps.extractErrorInfo(error);
      if (errorInfo.status === 507) {
        throw error;
      }
      if (!deps.isTokenInvalidatedError(error)) throw error;
      const refreshedAccessToken = await refreshUpstreamSourceAccountAccessToken({
        module,
        account,
        runtimeConfig,
        signal,
      });
      try {
        return await callUpstream(refreshedAccessToken);
      } catch (retryError) {
        if (deps.isTokenInvalidatedError(retryError)) {
          await disableAccountForInvalidAuth(
            account,
            "Account disabled: token still invalidated after refresh",
          );
        }
        throw retryError;
      }
    }
  }

  async function connectResponsesWebSocketProxyUpstream(args: {
    openaiApiModule: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    runtimeConfig: RuntimeConfig;
    requestHeaders?: HeadersInit;
    query?: string;
    signal?: AbortSignal;
  }): Promise<{
    sourceAccount: UpstreamSourceAccountRecord;
    upstreamSocket: WsSocket;
  }> {
    const {
      openaiApiModule,
      account,
      runtimeConfig,
      requestHeaders,
      query,
      signal,
    } = args;
    if (signal?.aborted) {
      throw deps.createAbortError();
    }

    if (
      !account.accessToken?.trim() ||
      !deps.resolveOpenAIUpstreamAccountId(account)
    ) {
      throw new Error("No active upstream account");
    }

    const upstreamSocket = await connectCodexResponsesWebSocketWithTokenRefresh({
      module: openaiApiModule,
      account,
      runtimeConfig,
      requestHeaders,
      query,
      signal,
    });
    return { sourceAccount: account, upstreamSocket };
  }

  return {
    getCodexModelsWithTokenRefresh,
    postCodexResponsesWithTokenRefresh,
    postCodexResponsesCompactWithTokenRefresh,
    connectResponsesWebSocketProxyUpstream,
  };
}
