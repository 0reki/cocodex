import type { Request, Response } from "express";

import type {
  ApiKeyRecord,
  PortalUserRecord,
} from "../../../database/index.ts";
import { verifyPortalAccessToken } from "../../auth/portal-auth.ts";
import { parseUsdAmount, type UsdAmount } from "../../../shared/usd.ts";

export type PortalPrincipal = Pick<
  PortalUserRecord,
  "id" | "username" | "role"
>;

export type ApiKeyAuthFailureReason =
  | "missing_authorization_header"
  | "unsupported_authorization_scheme"
  | "empty_bearer_token"
  | "api_key_not_found_or_expired";

export type PortalAccessTokenFailureReason =
  | "missing_access_token"
  | "unsupported_authorization_scheme"
  | "empty_bearer_token"
  | "access_token_secret_not_configured"
  | "invalid_access_token"
  | "user_unavailable";

export function createAuthServices(deps: {
  lruGet: <K, V extends { expiresAtMs: number }>(
    cache: Map<K, V>,
    key: K,
  ) => V | null;
  apiKeyAuthLruCache: Map<
    string,
    { value: ApiKeyRecord; expiresAtMs: number }
  >;
  apiKeyAuthTokenById: Map<string, string>;
  apiKeyPendingCharges: Map<string, UsdAmount>;
  getPortalUserById: (id: string) => Promise<PortalUserRecord | null>;
}) {
  function storeApiKey(apiKey: ApiKeyRecord) {
    const token = apiKey.apiKey.trim();
    if (!token) return;
    deps.apiKeyAuthLruCache.delete(token);
    deps.apiKeyAuthLruCache.set(token, {
      value: { ...apiKey },
      expiresAtMs: Number.POSITIVE_INFINITY,
    });
    deps.apiKeyAuthTokenById.set(apiKey.id, token);
  }

  function cacheApiKey(apiKey: ApiKeyRecord) {
    const token = apiKey.apiKey.trim();
    if (!token) return;
    storeApiKey(apiKey);
  }

  function invalidateApiKeyAuthCacheByToken(token: string) {
    const normalized = token.trim();
    if (!normalized) return;
    const cached = deps.apiKeyAuthLruCache.get(normalized)?.value;
    deps.apiKeyAuthLruCache.delete(normalized);
    if (cached && deps.apiKeyAuthTokenById.get(cached.id) === normalized) {
      deps.apiKeyAuthTokenById.delete(cached.id);
    }
  }

  function invalidateApiKeyAuthCacheByOwnerUserId(ownerUserId: string) {
    const normalized = ownerUserId.trim();
    if (!normalized) return;
    for (const [token, entry] of deps.apiKeyAuthLruCache) {
      if (entry.value.ownerUserId === normalized) {
        invalidateApiKeyAuthCacheByToken(token);
      }
    }
  }

  function isApiKeyUsable(apiKey: ApiKeyRecord) {
    if (apiKey.revokedAt) return false;
    if (!apiKey.expiresAt) return true;
    const expiresAtMs = Date.parse(apiKey.expiresAt);
    return Number.isNaN(expiresAtMs) || expiresAtMs > Date.now();
  }
  async function authenticatePortalAccessTokenWithReason(
    req: Request,
  ): Promise<{
    principal: PortalPrincipal | null;
    reason: PortalAccessTokenFailureReason | null;
  }> {
    const auth = req.header("authorization")?.trim() ?? "";
    if (!auth) {
      return { principal: null, reason: "missing_access_token" };
    }
    if (!auth.toLowerCase().startsWith("bearer ")) {
      return { principal: null, reason: "unsupported_authorization_scheme" };
    }
    const token = auth.slice(7).trim();
    if (!token) {
      return { principal: null, reason: "empty_bearer_token" };
    }
    if (!(process.env.ADMIN_JWT_SECRET?.trim() ?? "")) {
      return { principal: null, reason: "access_token_secret_not_configured" };
    }
    const claims = verifyPortalAccessToken(token);
    if (!claims) {
      return { principal: null, reason: "invalid_access_token" };
    }
    const user = await deps.getPortalUserById(claims.sub);
    if (!user?.enabled) {
      return { principal: null, reason: "user_unavailable" };
    }
    return {
      principal: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      reason: null,
    };
  }

  function authenticateApiKeyByAuthorizationHeaderWithReason(
    authorizationHeader: string | string[] | undefined,
  ): {
    apiKey: ApiKeyRecord | null;
    reason: ApiKeyAuthFailureReason | null;
  } {
    const auth = Array.isArray(authorizationHeader)
      ? (authorizationHeader[0] ?? "").trim()
      : (authorizationHeader ?? "").trim();
    if (!auth) {
      return { apiKey: null, reason: "missing_authorization_header" };
    }
    if (!auth.toLowerCase().startsWith("bearer ")) {
      return { apiKey: null, reason: "unsupported_authorization_scheme" };
    }
    const token = auth.slice(7).trim();
    if (!token) {
      return { apiKey: null, reason: "empty_bearer_token" };
    }

    const fromLru = deps.lruGet(deps.apiKeyAuthLruCache, token)?.value ?? null;
    if (fromLru && isApiKeyUsable(fromLru)) {
      return { apiKey: fromLru, reason: null };
    }
    if (fromLru) invalidateApiKeyAuthCacheByToken(token);

    return { apiKey: null, reason: "api_key_not_found_or_expired" };
  }

  function authenticateApiKeyWithReason(req: Request): {
    apiKey: ApiKeyRecord | null;
    reason: ApiKeyAuthFailureReason | null;
  } {
    return authenticateApiKeyByAuthorizationHeaderWithReason(
      req.header("authorization"),
    );
  }

  function getApiKeyAuthErrorDetail(reason: ApiKeyAuthFailureReason | null): {
    code: string;
    message: string;
  } {
    switch (reason) {
      case "missing_authorization_header":
        return {
          code: "missing_authorization_header",
          message: "Authorization header is required",
        };
      case "unsupported_authorization_scheme":
        return {
          code: "unsupported_authorization_scheme",
          message: "Authorization header must use Bearer scheme",
        };
      case "empty_bearer_token":
        return {
          code: "empty_bearer_token",
          message: "Bearer token is empty",
        };
      case "api_key_not_found_or_expired":
      default:
        return {
          code: "invalid_api_key",
          message: "Invalid API key",
        };
    }
  }

  function getAccessTokenAuthErrorDetail(
    reason: PortalAccessTokenFailureReason | null,
  ): {
    status: number;
    code: string;
    message: string;
  } {
    switch (reason) {
      case "missing_access_token":
        return {
          status: 401,
          code: "missing_access_token",
          message: "Access token is required",
        };
      case "unsupported_authorization_scheme":
        return {
          status: 401,
          code: "unsupported_authorization_scheme",
          message: "Authorization header must use Bearer scheme",
        };
      case "empty_bearer_token":
        return {
          status: 401,
          code: "empty_bearer_token",
          message: "Bearer token is empty",
        };
      case "access_token_secret_not_configured":
        return {
          status: 500,
          code: "access_token_secret_not_configured",
          message: "Access token verification is not configured",
        };
      case "user_unavailable":
        return {
          status: 401,
          code: "user_unavailable",
          message: "User is disabled or unavailable",
        };
      case "invalid_access_token":
      default:
        return {
          status: 401,
          code: "invalid_access_token",
          message: "Invalid access token",
        };
    }
  }

  function getPortalPrincipalFromLocals(
    res: Response,
  ): PortalPrincipal | null {
    const principal = res.locals.portalPrincipal;
    if (!principal || typeof principal !== "object") return null;
    const record = principal as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.username !== "string" ||
      (record.role !== "admin" && record.role !== "user")
    ) {
      return null;
    }
    return {
      id: record.id,
      username: record.username,
      role: record.role,
    };
  }

  function isApiKeyQuotaExceeded(apiKey: ApiKeyRecord): boolean {
    if (apiKey.quota == null) return false;
    const quota = parseUsdAmount(apiKey.quota);
    if (quota === null) return true;
    const used = parseUsdAmount(apiKey.used) ?? 0n;
    const pending = deps.apiKeyPendingCharges.get(apiKey.id) ?? 0n;
    return used + pending >= quota;
  }

  function hydrateResponseAuthState(input: {
    apiKeys: ApiKeyRecord[];
    users: Array<{ id: string; enabled: boolean }>;
  }) {
    deps.apiKeyAuthLruCache.clear();
    deps.apiKeyAuthTokenById.clear();
    const enabledUserIds = new Set(
      input.users.filter((user) => user.enabled).map((user) => user.id),
    );
    for (const apiKey of input.apiKeys) {
      if (apiKey.ownerUserId && enabledUserIds.has(apiKey.ownerUserId)) {
        storeApiKey(apiKey);
      }
    }
  }

  function isApiKeyBoundToUser(
    apiKey: ApiKeyRecord,
  ): apiKey is ApiKeyRecord & { ownerUserId: string } {
    return (
      typeof apiKey.ownerUserId === "string" &&
      apiKey.ownerUserId.trim().length > 0
    );
  }

  function applyApiKeyPendingCharge(apiKeyId: string, amount: UsdAmount) {
    if (amount <= 0n) return;
    deps.apiKeyPendingCharges.set(
      apiKeyId,
      (deps.apiKeyPendingCharges.get(apiKeyId) ?? 0n) + amount,
    );
  }

  function settleApiKeyPendingCharge(
    apiKeyId: string,
    amount: UsdAmount,
    accepted: boolean,
    committedUsedUsd?: string,
  ) {
    if (amount <= 0n) return;
    const remaining =
      (deps.apiKeyPendingCharges.get(apiKeyId) ?? 0n) - amount;
    if (remaining > 0n) deps.apiKeyPendingCharges.set(apiKeyId, remaining);
    else deps.apiKeyPendingCharges.delete(apiKeyId);
    if (!accepted) return;
    const token = deps.apiKeyAuthTokenById.get(apiKeyId);
    if (!token) return;
    const cached = deps.apiKeyAuthLruCache.get(token);
    if (!cached || cached.value.id !== apiKeyId) return;
    if (committedUsedUsd) {
      cached.value.used = committedUsedUsd;
    }
  }

  return {
    authenticatePortalAccessTokenWithReason,
    authenticateApiKeyByAuthorizationHeaderWithReason,
    authenticateApiKeyWithReason,
    getApiKeyAuthErrorDetail,
    getAccessTokenAuthErrorDetail,
    getPortalPrincipalFromLocals,
    cacheApiKey,
    hydrateResponseAuthState,
    invalidateApiKeyAuthCacheByToken,
    invalidateApiKeyAuthCacheByOwnerUserId,
    isApiKeyQuotaExceeded,
    isApiKeyBoundToUser,
    applyApiKeyPendingCharge,
    settleApiKeyPendingCharge,
  };
}
