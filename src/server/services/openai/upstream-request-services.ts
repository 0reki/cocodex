import type { WsSocket } from "../../utils/network/ws.ts";

type RuntimeConfig = {
  userAgent: string;
  clientVersion: string;
};

type UpstreamSourceAccountRecord = {
  id: string;
  idToken: string;
  accessToken: string;
  accountId: string;
  refreshToken: string;
};

type OpenAIApiModule = {
  refreshCodexTokens?: (args: {
    refreshToken: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<{
    idToken?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
  }>;
  getCodexModels?: (args: {
    accessToken: string;
    accountId?: string;
    clientVersion: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<{ models?: Array<Record<string, unknown>> }>;
  getCodexUsage?: (args: {
    accessToken: string;
    accountId?: string;
    clientVersion: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<Record<string, unknown>>;
  getCodexDailyWorkspaceUsage?: (args: {
    accessToken: string;
    accountId?: string;
    clientVersion: string;
    userAgent?: string;
    startDate: string;
    endDate: string;
    signal?: AbortSignal;
  }) => Promise<Record<string, unknown>>;
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
  postCodexImage?: (args: {
    accessToken: string;
    accountId?: string;
    version: string;
    sessionId: string;
    operation: "generations" | "edits";
    requestHeaders?: HeadersInit;
    payload: Record<string, unknown>;
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
    account: Pick<UpstreamSourceAccountRecord, "accountId">,
  ) => string | null;
  updateOpenAIAccountTokensById: (
    id: string,
    tokens: {
      idToken?: string | null;
      accessToken: string;
      refreshToken?: string | null;
    },
  ) => Promise<unknown>;
  isTokenInvalidatedError: (error: unknown) => boolean;
}) {
  type RefreshedAccountTokens = {
    idToken: string | null;
    accessToken: string;
    refreshToken: string | null;
  };

  const refreshTasks = new Map<string, Promise<RefreshedAccountTokens>>();
  const latestRefreshByAccountId = new Map<
    string,
    RefreshedAccountTokens & { replacedAccessToken: string }
  >();
  const tokenPersistenceTasks = new Map<string, Promise<void>>();

  function queueTokenPersistence(
    accountId: string,
    tokens: RefreshedAccountTokens,
  ) {
    const previous = tokenPersistenceTasks.get(accountId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        await deps.updateOpenAIAccountTokensById(accountId, tokens);
      })
      .catch((error) => {
        console.warn(
          `[upstream] failed to persist refreshed tokens for ${accountId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (tokenPersistenceTasks.get(accountId) === task) {
          tokenPersistenceTasks.delete(accountId);
        }
      });
    tokenPersistenceTasks.set(accountId, task);
  }

  async function flushUpstreamTokenPersistence() {
    while (tokenPersistenceTasks.size > 0) {
      await Promise.all(tokenPersistenceTasks.values());
    }
  }

  function requireWsSocket(value: unknown): WsSocket {
    if (!value || typeof value !== "object") {
      throw new Error("Responses WebSocket connector returned no socket");
    }
    const socket = value as Record<string, unknown>;
    if (
      typeof socket.readyState !== "number" ||
      typeof socket.bufferedAmount !== "number" ||
      typeof socket.pause !== "function" ||
      typeof socket.resume !== "function" ||
      typeof socket.send !== "function" ||
      typeof socket.close !== "function" ||
      typeof socket.terminate !== "function" ||
      typeof socket.on !== "function"
    ) {
      throw new Error("Responses WebSocket connector returned an invalid socket");
    }
    return value as WsSocket;
  }

  function requireWsConnection(value: unknown): {
    upstreamSocket: WsSocket;
    responseHeaders: Record<string, string>;
  } {
    if (!value || typeof value !== "object") {
      throw new Error("Responses WebSocket connector returned no connection");
    }
    const connection = value as Record<string, unknown>;
    const responseHeaders: Record<string, string> = {};
    if (
      connection.responseHeaders &&
      typeof connection.responseHeaders === "object"
    ) {
      for (const [name, headerValue] of Object.entries(
        connection.responseHeaders,
      )) {
        if (typeof headerValue === "string") {
          responseHeaders[name] = headerValue;
        }
      }
    }
    return {
      upstreamSocket: requireWsSocket(connection.socket),
      responseHeaders,
    };
  }

  function requireActiveAccount(account: UpstreamSourceAccountRecord) {
    const accessToken = account.accessToken?.trim() ?? "";
    const accountId = deps.resolveOpenAIUpstreamAccountId(account);
    if (!accessToken || !accountId) {
      throw new Error("No active upstream account");
    }
    return { accessToken, accountId };
  }

  async function refreshAccessToken(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    runtimeConfig: RuntimeConfig;
    failedAccessToken: string;
  }) {
    const { module, account, runtimeConfig, failedAccessToken } = params;
    if (typeof module.refreshCodexTokens !== "function") {
      throw new Error("Access token refresh is unavailable");
    }

    const latest = latestRefreshByAccountId.get(account.id);
    if (latest?.replacedAccessToken === failedAccessToken) {
      applyRefreshedTokens(account, latest);
      return latest.accessToken;
    }

    let task = refreshTasks.get(account.id);
    if (!task) {
      task = (async () => {
        const refreshToken = account.refreshToken?.trim() ?? "";
        if (!refreshToken) {
          throw new Error("Missing refresh token for access token refresh");
        }
        const refreshed = await module.refreshCodexTokens!({
          refreshToken,
          userAgent: runtimeConfig.userAgent,
          signal: AbortSignal.timeout(15_000),
        });
        const accessToken = refreshed.accessToken?.trim() ?? "";
        if (!accessToken) {
          throw new Error("Access token refresh returned no access token");
        }
        const tokens: RefreshedAccountTokens = {
          idToken: refreshed.idToken?.trim() || null,
          accessToken,
          refreshToken: refreshed.refreshToken?.trim() || null,
        };
        latestRefreshByAccountId.set(account.id, {
          ...tokens,
          replacedAccessToken: failedAccessToken,
        });
        applyRefreshedTokens(account, tokens);
        queueTokenPersistence(account.id, tokens);
        return tokens;
      })();
      refreshTasks.set(account.id, task);
    }

    try {
      const tokens = await task;
      applyRefreshedTokens(account, tokens);
      return tokens.accessToken;
    } finally {
      if (refreshTasks.get(account.id) === task) {
        refreshTasks.delete(account.id);
      }
    }
  }

  function applyRefreshedTokens(
    account: UpstreamSourceAccountRecord,
    tokens: RefreshedAccountTokens,
  ) {
    if (tokens.idToken) {
      account.idToken = tokens.idToken;
    }
    account.accessToken = tokens.accessToken;
    if (tokens.refreshToken) {
      account.refreshToken = tokens.refreshToken;
    }
  }

  async function shouldRefreshResponse(response: Response) {
    if (response.status !== 401) return false;
    const body = await response.clone().text();
    return deps.isTokenInvalidatedError(new Error(`HTTP 401: ${body}`));
  }

  async function callCodexGetWithTokenRefresh<T>(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    runtimeConfig: RuntimeConfig;
    call: (args: {
      accessToken: string;
      accountId: string;
      clientVersion: string;
      userAgent: string;
    }) => Promise<T>;
  }) {
    const { module, account, runtimeConfig, call } = params;
    const { accessToken, accountId } = requireActiveAccount(account);
    const callUpstream = (token: string) =>
      call({
        accessToken: token,
        accountId,
        clientVersion: runtimeConfig.clientVersion,
        userAgent: runtimeConfig.userAgent,
      });
    try {
      return await callUpstream(accessToken);
    } catch (error) {
      if (!deps.isTokenInvalidatedError(error)) throw error;
      const refreshedToken = await refreshAccessToken({
        module,
        account,
        runtimeConfig,
        failedAccessToken: accessToken,
      });
      return callUpstream(refreshedToken);
    }
  }

  async function postCodexResponsesWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    payload: Record<string, unknown>;
    requestHeaders?: HeadersInit;
    runtimeConfig: RuntimeConfig;
    signal?: AbortSignal;
  }): Promise<Response> {
    const { module, account, payload, requestHeaders, runtimeConfig, signal } =
      params;
    if (typeof module.postCodexResponses !== "function") {
      throw new Error(
        "postCodexResponses is not exported from the internal OpenAI module",
      );
    }
    const { accessToken, accountId } = requireActiveAccount(account);
    const sessionId = deps.randomUUID();
    const callUpstream = (token: string) =>
      module.postCodexResponses!({
        accessToken: token,
        accountId,
        version: runtimeConfig.clientVersion,
        sessionId,
        requestHeaders,
        payload,
        userAgent: runtimeConfig.userAgent,
        signal,
      });

    const response = await callUpstream(accessToken);
    if (!(await shouldRefreshResponse(response))) return response;
    const refreshedToken = await refreshAccessToken({
      module,
      account,
      runtimeConfig,
      failedAccessToken: accessToken,
    });
    return callUpstream(refreshedToken);
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
    const { accessToken, accountId } = requireActiveAccount(account);
    const callUpstream = (token: string) =>
      module.getCodexModels!({
        accessToken: token,
        accountId,
        clientVersion: runtimeConfig.clientVersion,
        userAgent: runtimeConfig.userAgent,
        signal,
      });

    try {
      return await callUpstream(accessToken);
    } catch (error) {
      if (!deps.isTokenInvalidatedError(error)) throw error;
      const refreshedToken = await refreshAccessToken({
        module,
        account,
        runtimeConfig,
        failedAccessToken: accessToken,
      });
      return callUpstream(refreshedToken);
    }
  }

  async function getCodexUsageWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    runtimeConfig: RuntimeConfig;
    signal?: AbortSignal;
  }) {
    const { module, account, runtimeConfig, signal } = params;
    if (typeof module.getCodexUsage !== "function") {
      throw new Error(
        "getCodexUsage is not exported from the internal OpenAI module",
      );
    }
    return callCodexGetWithTokenRefresh({
      module,
      account,
      runtimeConfig,
      call: (args) => module.getCodexUsage!({ ...args, signal }),
    });
  }

  async function getCodexDailyWorkspaceUsageWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    runtimeConfig: RuntimeConfig;
    startDate: string;
    endDate: string;
    signal?: AbortSignal;
  }) {
    const {
      module,
      account,
      runtimeConfig,
      startDate,
      endDate,
      signal,
    } = params;
    if (typeof module.getCodexDailyWorkspaceUsage !== "function") {
      throw new Error(
        "getCodexDailyWorkspaceUsage is not exported from the internal OpenAI module",
      );
    }
    return callCodexGetWithTokenRefresh({
      module,
      account,
      runtimeConfig,
      call: (args) =>
        module.getCodexDailyWorkspaceUsage!({
          ...args,
          startDate,
          endDate,
          signal,
        }),
    });
  }

  async function postCodexImageWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    operation: "generations" | "edits";
    payload: Record<string, unknown>;
    requestHeaders?: HeadersInit;
    runtimeConfig: RuntimeConfig;
    signal?: AbortSignal;
  }): Promise<Response> {
    const {
      module,
      account,
      operation,
      payload,
      requestHeaders,
      runtimeConfig,
      signal,
    } = params;
    if (typeof module.postCodexImage !== "function") {
      throw new Error(
        "postCodexImage is not exported from the internal OpenAI module",
      );
    }
    const { accessToken, accountId } = requireActiveAccount(account);
    const sessionId = deps.randomUUID();
    const callUpstream = (token: string) =>
      module.postCodexImage!({
        accessToken: token,
        accountId,
        version: runtimeConfig.clientVersion,
        sessionId,
        operation,
        requestHeaders,
        payload,
        userAgent: runtimeConfig.userAgent,
        signal,
      });

    const response = await callUpstream(accessToken);
    if (!(await shouldRefreshResponse(response))) return response;
    const refreshedToken = await refreshAccessToken({
      module,
      account,
      runtimeConfig,
      failedAccessToken: accessToken,
    });
    return callUpstream(refreshedToken);
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
    const { accessToken, accountId } = requireActiveAccount(account);
    const sessionId = deps.randomUUID();
    const callUpstream = async (token: string) => {
      const connection = await module.connectCodexResponsesWebSocket!({
        accessToken: token,
        accountId,
        version: runtimeConfig.clientVersion,
        sessionId,
        requestHeaders,
        query,
        userAgent: runtimeConfig.userAgent,
        signal,
      });
      return requireWsConnection(connection);
    };

    try {
      return await callUpstream(accessToken);
    } catch (error) {
      if (!deps.isTokenInvalidatedError(error)) throw error;
      const refreshedToken = await refreshAccessToken({
        module,
        account,
        runtimeConfig,
        failedAccessToken: accessToken,
      });
      return callUpstream(refreshedToken);
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
    upstreamSocket: WsSocket;
    responseHeaders: Record<string, string>;
  }> {
    const {
      openaiApiModule,
      account,
      runtimeConfig,
      requestHeaders,
      query,
      signal,
    } = args;
    return connectCodexResponsesWebSocketWithTokenRefresh({
      module: openaiApiModule,
      account,
      runtimeConfig,
      requestHeaders,
      query,
      signal,
    });
  }

  return {
    getCodexDailyWorkspaceUsageWithTokenRefresh,
    getCodexModelsWithTokenRefresh,
    getCodexUsageWithTokenRefresh,
    flushUpstreamTokenPersistence,
    postCodexImageWithTokenRefresh,
    postCodexResponsesWithTokenRefresh,
    connectResponsesWebSocketProxyUpstream,
  };
}
