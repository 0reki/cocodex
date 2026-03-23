import * as openaiApiModule from "@workspace/openai-api";

type RateLimitSource = {
  id?: string | null;
  email: string;
  accessToken: string | null;
  sessionToken?: string | null;
  refreshToken?: string | null;
  accountId: string | null;
  userId: string | null;
  proxyId?: string | null;
  rateLimit?: Record<string, unknown> | null;
};

type RuntimeConfig = {
  userAgent: string;
  clientVersion: string;
};

type UpstreamTrace = {
  sourceAccountId?: string | null;
  sourceAccountEmail?: string | null;
  sourceProxyId?: string | null;
  selectedUpstreamAccountId?: string | null;
  selectedProxyUrl?: string | null;
};

type UpstreamSourceAccountRecord = {
  id: string;
  email: string;
  accessToken: string | null;
  accountId: string | null;
  userId: string | null;
  proxyId?: string | null;
  sessionToken?: string | null;
  refreshToken?: string | null;
};

type OpenAIApiModule = {
  getAccessToken?: (args: {
    sessionToken: string;
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<{
    accessToken?: string;
    session?: unknown;
    sessionTokenCookies?: Record<string, string | undefined>;
  }>;
  postCodexResponses?: (args: {
    accessToken: string;
    accountId?: string;
    version: string;
    sessionId: string;
    payload?: Record<string, unknown> | null;
    debugLabel?: string;
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<Response>;
  postCodexResponsesCompact?: (args: {
    accessToken: string;
    accountId?: string;
    version: string;
    sessionId: string;
    payload?: Record<string, unknown> | null;
    debugLabel?: string;
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<Response>;
  connectCodexResponsesWebSocket?: (args: {
    accessToken: string;
    accountId?: string;
    version: string;
    sessionId: string;
    serviceTier?: "priority";
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  postAudioTranscription?: (args: {
    accessToken: string;
    accountId?: string;
    contentType: string;
    body: BodyInit;
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<Response>;
  getWhamUsage?: (args: {
    accessToken: string;
    accountId: string;
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<{ rate_limit?: Record<string, unknown> | null }>;
};

function resolveCodexSessionIdFromPayload(
  payload: Record<string, unknown>,
  fallback: () => string,
): string {
  const promptCacheKey =
    typeof payload.prompt_cache_key === "string"
      ? payload.prompt_cache_key.trim()
      : "";
  if (promptCacheKey) return promptCacheKey;
  const promptCacheKeyCamel =
    typeof payload.promptCacheKey === "string"
      ? payload.promptCacheKey.trim()
      : "";
  if (promptCacheKeyCamel) return promptCacheKeyCamel;
  return fallback();
}

export function createUpstreamRequestServices(deps: {
  randomUUID: () => string;
  rateLimitRefreshTimeoutMs: number;
  resolveOpenAIUpstreamProxyUrl: (
    account: UpstreamSourceAccountRecord | RateLimitSource,
  ) => Promise<string | null>;
  isOpenAIUpstreamSourceAccount: (account: unknown) => boolean;
  resolveOpenAIUpstreamAccountId: (
    account: Pick<UpstreamSourceAccountRecord, "accountId" | "userId">,
  ) => string | null;
  refreshAccessTokenByRefreshToken: (args: {
    refreshToken: string;
    userAgent?: string;
  }) => Promise<{ accessToken: string; refreshToken?: string | null }>;
  updateOpenAIAccountAccessTokenById: (
    id: string,
    accessToken: string,
  ) => Promise<unknown>;
  updateTeamAccountTokensById: (args: {
    id: string;
    accessToken: string;
    refreshToken?: string | null;
  }) => Promise<unknown>;
  disableOpenAIAccountByEmail: (email: string) => Promise<unknown>;
  markOpenAIAccountsHashSelectionDirty: () => void;
  markTeamAccountsHashSelectionDirty: () => void;
  openAIAccountsLruCache: {
    items: Map<string, UpstreamSourceAccountRecord>;
  };
  teamAccountsLruCache: {
    items: Map<string, UpstreamSourceAccountRecord>;
  };
  ensureOpenAIAccountsLruLoaded: (force?: boolean) => Promise<void>;
  refreshRuntimeSystemSettings: () => Promise<unknown>;
  selectRandomSourceAccountForResponsesWebSocket: (
    excludedSourceAccountIds?: Set<string>,
  ) => UpstreamSourceAccountRecord | null;
  markSourceAccountTransientFailure: (
    accountId: string | null,
    stickyPromptCacheKey?: string | null,
  ) => void;
  upstreamRetryConfig: {
    maxAttemptCount: number;
  };
  extractErrorInfo: (error: unknown) => {
    status: number | null;
    errorPayload: Record<string, unknown> | null;
    message: string | null;
    rawResponseText: string | null;
  };
  isAbortError: (error: unknown) => boolean;
  isTokenInvalidatedError: (error: unknown) => boolean;
  isConnectionTimeoutError: (error: unknown) => boolean;
  isRetryableUpstreamServerErrorStatus: (status: number | null) => boolean;
  isUpstreamAccountSwitchRetryableError: (args: {
    error: unknown;
    status: number | null;
    errorPayload: Record<string, unknown> | null;
    message: string | null;
  }) => boolean;
  computeRetryDelayMs: (attemptNo: number) => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  createAbortError: () => Error;
}) {
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

  function updateAccessTokenInLruByEmail(email: string, accessToken: string) {
    const existing = deps.openAIAccountsLruCache.items.get(email);
    if (!existing) return;
    const hadToken = existing.accessToken?.trim().length ? true : false;
    existing.accessToken = accessToken;
    deps.openAIAccountsLruCache.items.set(email, existing);
    const hasToken = accessToken.trim().length > 0;
    if (hadToken !== hasToken) {
      deps.markOpenAIAccountsHashSelectionDirty();
    }
  }

  function updateTeamTokensInLruByEmail(
    email: string,
    accessToken: string,
    refreshToken?: string | null,
  ) {
    const existing = deps.teamAccountsLruCache.items.get(email);
    if (!existing) return;
    const hadToken = existing.accessToken?.trim().length ? true : false;
    existing.accessToken = accessToken;
    if (refreshToken !== undefined) {
      existing.refreshToken = refreshToken;
    }
    deps.teamAccountsLruCache.items.set(email, existing);
    const hasToken = accessToken.trim().length > 0;
    if (hadToken !== hasToken) {
      deps.markTeamAccountsHashSelectionDirty();
    }
  }

  async function disableAccountForInvalidAuth(
    account: UpstreamSourceAccountRecord,
    reason: string,
  ) {
    try {
      await deps.disableOpenAIAccountByEmail(account.email);
      deps.openAIAccountsLruCache.items.delete(account.email);
      deps.markOpenAIAccountsHashSelectionDirty();
    } catch (error) {
      console.warn(
        `[auth] failed to disable account ${account.email}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new Error(reason);
  }

  async function refreshUpstreamSourceAccountAccessToken(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    runtimeConfig: RuntimeConfig;
    signal?: AbortSignal;
  }) {
    const { module, account, runtimeConfig, signal } = params;
    const proxyUrl = await deps.resolveOpenAIUpstreamProxyUrl(account);
    if (deps.isOpenAIUpstreamSourceAccount(account)) {
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
        proxyUrl: proxyUrl ?? undefined,
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
      updateAccessTokenInLruByEmail(account.email, refreshedAccessToken);
      return refreshedAccessToken;
    }

    const refreshToken = account.refreshToken?.trim() ?? "";
    if (!refreshToken) {
      throw new Error("No available upstream account");
    }
    const refreshed = await deps.refreshAccessTokenByRefreshToken({
      refreshToken,
      userAgent: runtimeConfig.userAgent,
    });
    const refreshedAccessToken = refreshed.accessToken.trim();
    if (!refreshedAccessToken) {
      throw new Error("No available upstream account");
    }
    account.accessToken = refreshedAccessToken;
    account.refreshToken = refreshed.refreshToken ?? refreshToken;
    await deps.updateTeamAccountTokensById({
      id: account.id,
      accessToken: refreshedAccessToken,
      refreshToken: account.refreshToken,
    });
    updateTeamTokensInLruByEmail(
      account.email,
      refreshedAccessToken,
      account.refreshToken,
    );
    return refreshedAccessToken;
  }

  async function postCodexResponsesWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    payload: Record<string, unknown>;
    debugLabel?: string;
    runtimeConfig: RuntimeConfig;
    trace?: UpstreamTrace;
    signal?: AbortSignal;
  }): Promise<Response> {
    const { module, account, payload, debugLabel, runtimeConfig, trace, signal } =
      params;
    if (typeof module.postCodexResponses !== "function") {
      throw new Error(
        "postCodexResponses is not exported from @workspace/openai-api",
      );
    }

    const resolvedAccountId = deps.resolveOpenAIUpstreamAccountId(account);
    if (!resolvedAccountId) {
      throw new Error("No available upstream account");
    }
    const proxyUrl = await deps.resolveOpenAIUpstreamProxyUrl(account);
    const sessionId = resolveCodexSessionIdFromPayload(payload, deps.randomUUID);
    if (trace) {
      trace.sourceAccountId = account.id;
      trace.sourceAccountEmail = account.email;
      trace.sourceProxyId = account.proxyId ?? null;
      trace.selectedUpstreamAccountId = resolvedAccountId;
      trace.selectedProxyUrl = proxyUrl;
    }

    const callUpstream = async (accessToken: string) =>
      module.postCodexResponses!({
        accessToken,
        accountId: resolvedAccountId,
        version: runtimeConfig.clientVersion,
        sessionId,
        payload,
        debugLabel,
        proxyUrl: proxyUrl ?? undefined,
        userAgent: runtimeConfig.userAgent,
        signal,
      });

    const currentAccessToken = account.accessToken?.trim() ?? "";
    if (!currentAccessToken) {
      throw new Error("No available upstream account");
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
        if (
          deps.isTokenInvalidatedError(retryError) &&
          deps.isOpenAIUpstreamSourceAccount(account)
        ) {
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
    debugLabel?: string;
    runtimeConfig: RuntimeConfig;
    signal?: AbortSignal;
  }): Promise<Response> {
    const { module, account, payload, debugLabel, runtimeConfig, signal } =
      params;
    if (typeof module.postCodexResponsesCompact !== "function") {
      throw new Error(
        "postCodexResponsesCompact is not exported from @workspace/openai-api",
      );
    }

    const resolvedAccountId = deps.resolveOpenAIUpstreamAccountId(account);
    if (!resolvedAccountId) {
      throw new Error("No available upstream account");
    }
    const proxyUrl = await deps.resolveOpenAIUpstreamProxyUrl(account);
    const sessionId = resolveCodexSessionIdFromPayload(payload, deps.randomUUID);

    const callUpstream = async (accessToken: string) =>
      module.postCodexResponsesCompact!({
        accessToken,
        accountId: resolvedAccountId,
        version: runtimeConfig.clientVersion,
        sessionId,
        payload,
        debugLabel,
        proxyUrl: proxyUrl ?? undefined,
        userAgent: runtimeConfig.userAgent,
        signal,
      });

    const currentAccessToken = account.accessToken?.trim() ?? "";
    if (!currentAccessToken) {
      throw new Error("No available upstream account");
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
        if (
          deps.isTokenInvalidatedError(retryError) &&
          deps.isOpenAIUpstreamSourceAccount(account)
        ) {
          await disableAccountForInvalidAuth(
            account,
            "Account disabled: token still invalidated after refresh",
          );
        }
        throw retryError;
      }
    }
  }

  async function connectCodexResponsesWebSocketWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    runtimeConfig: RuntimeConfig;
    serviceTier?: "priority";
    signal?: AbortSignal;
  }) {
    const { module, account, runtimeConfig, serviceTier, signal } = params;
    if (typeof module.connectCodexResponsesWebSocket !== "function") {
      throw new Error(
        "connectCodexResponsesWebSocket is not exported from @workspace/openai-api",
      );
    }

    const resolvedAccountId = deps.resolveOpenAIUpstreamAccountId(account);
    if (!resolvedAccountId) {
      throw new Error("No available upstream account");
    }
    const proxyUrl = await deps.resolveOpenAIUpstreamProxyUrl(account);

    const callUpstream = async (accessToken: string) =>
      module.connectCodexResponsesWebSocket!({
        accessToken,
        accountId: resolvedAccountId,
        version: runtimeConfig.clientVersion,
        sessionId: deps.randomUUID(),
        serviceTier,
        proxyUrl: proxyUrl ?? undefined,
        userAgent: runtimeConfig.userAgent,
        signal,
      });

    const currentAccessToken = account.accessToken?.trim() ?? "";
    if (!currentAccessToken) {
      throw new Error("No available upstream account");
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
        if (
          deps.isTokenInvalidatedError(retryError) &&
          deps.isOpenAIUpstreamSourceAccount(account)
        ) {
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
    runtimeConfig: RuntimeConfig;
    serviceTier: "priority" | null;
    excludedSourceAccountIds?: Iterable<string>;
    signal?: AbortSignal;
  }): Promise<{
    sourceAccount: UpstreamSourceAccountRecord;
    upstreamSocket: unknown;
  }> {
    const {
      openaiApiModule,
      runtimeConfig,
      serviceTier,
      excludedSourceAccountIds,
      signal,
    } = args;
    await deps.refreshRuntimeSystemSettings();
    const maxAttempts = deps.upstreamRetryConfig.maxAttemptCount;
    const triedSourceAccountIds = new Set<string>(excludedSourceAccountIds ?? []);
    let lastError: unknown = null;

    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
      if (signal?.aborted) {
        throw deps.createAbortError();
      }

      let sourceAccount = deps.selectRandomSourceAccountForResponsesWebSocket(
        triedSourceAccountIds,
      );
      if (!sourceAccount) {
        await deps.ensureOpenAIAccountsLruLoaded(true);
        sourceAccount = deps.selectRandomSourceAccountForResponsesWebSocket(
          triedSourceAccountIds,
        );
      }
      if (!sourceAccount || !sourceAccount.accessToken?.trim()) {
        break;
      }
      if (!deps.resolveOpenAIUpstreamAccountId(sourceAccount)) {
        triedSourceAccountIds.add(sourceAccount.id);
        lastError = new Error("No available upstream account");
        continue;
      }

      triedSourceAccountIds.add(sourceAccount.id);
      try {
        const upstreamSocket =
          await connectCodexResponsesWebSocketWithTokenRefresh({
            module: openaiApiModule,
            account: sourceAccount,
            runtimeConfig,
            serviceTier: serviceTier ?? undefined,
            signal,
          });
        return { sourceAccount, upstreamSocket };
      } catch (error) {
        lastError = error;
        const errorInfo = deps.extractErrorInfo(error);
        const retryable =
          attemptNo < maxAttempts &&
          (errorInfo.status === 429 ||
            deps.isConnectionTimeoutError(error) ||
            deps.isRetryableUpstreamServerErrorStatus(errorInfo.status) ||
            deps.isUpstreamAccountSwitchRetryableError({
              error,
              status: errorInfo.status,
              errorPayload: errorInfo.errorPayload,
              message: errorInfo.message,
            }));
        if (retryable) {
          deps.markSourceAccountTransientFailure(sourceAccount.id, null);
          await deps.sleep(deps.computeRetryDelayMs(attemptNo), signal);
          continue;
        }
        throw error;
      }
    }

    throw lastError ?? new Error("No available upstream account");
  }

  async function postAudioTranscriptionWithTokenRefresh(params: {
    module: OpenAIApiModule;
    account: UpstreamSourceAccountRecord;
    contentType: string;
    body: BodyInit;
    allowRetryAfterRefresh?: boolean;
    runtimeConfig: RuntimeConfig;
    signal?: AbortSignal;
  }): Promise<Response> {
    const {
      module,
      account,
      contentType,
      body,
      allowRetryAfterRefresh = true,
      runtimeConfig,
      signal,
    } = params;
    if (typeof module.postAudioTranscription !== "function") {
      throw new Error(
        "postAudioTranscription is not exported from @workspace/openai-api",
      );
    }

    const resolvedAccountId = deps.resolveOpenAIUpstreamAccountId(account);
    if (!resolvedAccountId) {
      throw new Error("No available upstream account");
    }
    const proxyUrl = await deps.resolveOpenAIUpstreamProxyUrl(account);

    const callUpstream = async (accessToken: string) =>
      module.postAudioTranscription!({
        accessToken,
        accountId: resolvedAccountId,
        contentType,
        body,
        proxyUrl: proxyUrl ?? undefined,
        userAgent: runtimeConfig.userAgent,
        signal,
      });

    const currentAccessToken = account.accessToken?.trim() ?? "";
    if (!currentAccessToken) {
      throw new Error("No available upstream account");
    }

    try {
      return await callUpstream(currentAccessToken);
    } catch (error) {
      const errorInfo = deps.extractErrorInfo(error);
      if (errorInfo.status === 507) {
        throw error;
      }
      if (!deps.isTokenInvalidatedError(error)) throw error;
      if (!allowRetryAfterRefresh) throw error;
      const refreshedAccessToken = await refreshUpstreamSourceAccountAccessToken({
        module,
        account,
        runtimeConfig,
        signal,
      });
      try {
        return await callUpstream(refreshedAccessToken);
      } catch (retryError) {
        if (
          deps.isTokenInvalidatedError(retryError) &&
          deps.isOpenAIUpstreamSourceAccount(account)
        ) {
          await disableAccountForInvalidAuth(
            account,
            "Account disabled: token still invalidated after refresh",
          );
        }
        throw retryError;
      }
    }
  }

  async function resolveRateLimitForAccount(
    account: RateLimitSource,
    runtimeConfig?: Pick<RuntimeConfig, "userAgent">,
  ): Promise<Record<string, unknown> | null> {
    if (account.rateLimit && typeof account.rateLimit === "object") {
      return account.rateLimit;
    }

    const accessToken = account.accessToken?.trim() ?? "";
    const accountId = (account.accountId ?? account.userId ?? "").trim();
    if (!accessToken || !accountId) return null;

    if (typeof openaiApiModule.getWhamUsage !== "function") {
      return null;
    }
    const proxyUrl = await deps.resolveOpenAIUpstreamProxyUrl(account);

    const timeoutMs = Number.isFinite(deps.rateLimitRefreshTimeoutMs)
      ? Math.max(0, Math.floor(deps.rateLimitRefreshTimeoutMs))
      : 0;
    const timeoutController = new AbortController();
    const timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => timeoutController.abort(), timeoutMs)
        : null;
    const timeoutSignal = timeoutController.signal;

    const disableForUsage = async (reason: string) => {
      if (account.sessionToken) {
        try {
          await deps.disableOpenAIAccountByEmail(account.email);
          deps.openAIAccountsLruCache.items.delete(account.email);
          deps.markOpenAIAccountsHashSelectionDirty();
        } catch (error) {
          console.warn(
            `[usage] failed to disable account ${account.email}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        deps.teamAccountsLruCache.items.delete(account.email);
        deps.markTeamAccountsHashSelectionDirty();
      }
      console.warn(`[usage] disabled account ${account.email}: ${reason}`);
    };

    const callUsage = async (accessTokenValue: string) =>
      openaiApiModule.getWhamUsage!({
        accessToken: accessTokenValue,
        accountId,
        proxyUrl: proxyUrl ?? undefined,
        userAgent: runtimeConfig?.userAgent,
        signal: timeoutSignal,
      });

    try {
      try {
        const usage = await callUsage(accessToken);
        return usage.rate_limit ?? null;
      } catch (error) {
        if (deps.isTokenInvalidatedError(error)) {
          const exp = getAccessTokenExp(accessToken);
          const nowSec = Math.floor(Date.now() / 1000);

          if (exp === null || exp >= nowSec) {
            await disableForUsage("exp policy rejected refresh.");
            return null;
          }

          if (typeof openaiApiModule.getAccessToken !== "function") {
            if (!account.refreshToken?.trim()) {
              await disableForUsage("refresh function unavailable");
              return null;
            }
          }
          const sessionToken = account.sessionToken?.trim() ?? "";
          try {
            let refreshedAccessToken = "";
            if (sessionToken) {
              const refreshed = await openaiApiModule.getAccessToken!({
                sessionToken,
                proxyUrl: proxyUrl ?? undefined,
                userAgent: runtimeConfig?.userAgent,
                signal: timeoutSignal,
              });
              const refreshedSession =
                refreshed.session && typeof refreshed.session === "object"
                  ? refreshed.session
                  : null;
              if (
                refreshedSession &&
                Object.keys(refreshedSession).length === 0
              ) {
                await disableForUsage(
                  "refresh endpoint returned empty JSON object",
                );
                return null;
              }

              refreshedAccessToken =
                typeof refreshed.accessToken === "string"
                  ? refreshed.accessToken.trim()
                  : "";
              if (!refreshedAccessToken) {
                await disableForUsage("refresh did not return access token");
                return null;
              }

              const refreshedSessionToken = getSessionTokenFromCookieMap(
                refreshed.sessionTokenCookies,
              );
              account.accessToken = refreshedAccessToken;
              if (refreshedSessionToken) {
                account.sessionToken = refreshedSessionToken;
              }
              if (account.id) {
                await deps.updateOpenAIAccountAccessTokenById(
                  account.id,
                  refreshedAccessToken,
                );
              }
              updateAccessTokenInLruByEmail(account.email, refreshedAccessToken);
            } else {
              const refreshToken = account.refreshToken?.trim() ?? "";
              if (!refreshToken) {
                await disableForUsage("missing refresh token for refresh");
                return null;
              }
              const refreshed = await deps.refreshAccessTokenByRefreshToken({
                refreshToken,
                userAgent: runtimeConfig?.userAgent,
              });
              refreshedAccessToken = refreshed.accessToken.trim();
              if (!refreshedAccessToken) {
                await disableForUsage("refresh did not return access token");
                return null;
              }
              account.accessToken = refreshedAccessToken;
              account.refreshToken = refreshed.refreshToken ?? refreshToken;
              if (account.id) {
                await deps.updateTeamAccountTokensById({
                  id: account.id,
                  accessToken: refreshedAccessToken,
                  refreshToken: account.refreshToken,
                });
              }
              updateTeamTokensInLruByEmail(
                account.email,
                refreshedAccessToken,
                account.refreshToken,
              );
            }

            try {
              const usageAfterRefresh = await callUsage(refreshedAccessToken);
              return usageAfterRefresh.rate_limit ?? null;
            } catch (retryError) {
              if (deps.isTokenInvalidatedError(retryError)) {
                await disableForUsage("token still invalidated after refresh");
                return null;
              }
              throw retryError;
            }
          } catch (refreshError) {
            if (deps.isTokenInvalidatedError(refreshError)) {
              await disableForUsage("token invalidated during refresh");
              return null;
            }
            throw refreshError;
          }
        }

        if (deps.isAbortError?.(error)) {
          console.warn(
            `[usage] rate_limit fetch timed out for ${account.email} after ${timeoutMs}ms`,
          );
          return null;
        }

        console.warn(
          `[usage] rate_limit fetch failed for ${account.email}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  return {
    getAccessTokenExp,
    getSessionTokenFromCookieMap,
    resolveRateLimitForAccount,
    refreshUpstreamSourceAccountAccessToken,
    postCodexResponsesWithTokenRefresh,
    postCodexResponsesCompactWithTokenRefresh,
    connectResponsesWebSocketProxyUpstream,
    postAudioTranscriptionWithTokenRefresh,
  };
}
