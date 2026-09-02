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

type PortalUserSpendAllowanceValue = {
  balance: UsdAmount;
  totalAvailable: UsdAmount;
};

export function createAuthServices(deps: {
  lruGet: <K, V extends { expiresAtMs: number }>(
    cache: Map<K, V>,
    key: K,
  ) => V | null;
  lruSet: <K, V extends { expiresAtMs: number }>(
    cache: Map<K, V>,
    key: K,
    value: V,
    maxSize: number,
  ) => void;
  apiKeyAuthLruCache: Map<
    string,
    { value: ApiKeyRecord; expiresAtMs: number }
  >;
  apiKeyAuthTokenById: Map<string, string>;
  apiKeyAuthLoadingPromises: Map<string, Promise<ApiKeyRecord | null>>;
  apiKeyAuthTokenVersions: Map<string, number>;
  apiKeyPendingCharges: Map<string, UsdAmount>;
  apiKeyAuthLruMax: number;
  apiKeyAuthLruTtlMs: number;
  getApiKeyByToken: (token: string) => Promise<ApiKeyRecord | null>;
  billingAllowanceLruCache: Map<
    string,
    { value: PortalUserSpendAllowanceValue; expiresAtMs: number }
  >;
  billingAllowanceLoadingPromises: Map<
    string,
    Promise<PortalUserSpendAllowanceValue>
  >;
  billingAllowanceLruMax: number;
  billingAllowanceLruTtlMs: number;
  billingOverdraftLimitUsd: UsdAmount;
  billingInflightReserveUsd: UsdAmount;
  billingPendingChargesByOwnerId: Map<string, UsdAmount>;
  billingReservationById: Map<
    string,
    { ownerUserId: string; amount: UsdAmount }
  >;
  billingReservedAmountsByOwnerId: Map<string, UsdAmount>;
  getPortalUserSpendAllowance: (
    ownerUserId: string,
  ) => Promise<PortalUserSpendAllowanceValue>;
  getPortalUserById: (id: string) => Promise<PortalUserRecord | null>;
}) {
  let apiKeyAuthInvalidationVersion = 0;

  function storeApiKey(apiKey: ApiKeyRecord) {
    const token = apiKey.apiKey.trim();
    if (!token) return;
    deps.lruSet(
      deps.apiKeyAuthLruCache,
      token,
      {
        value: { ...apiKey },
        expiresAtMs: Date.now() + deps.apiKeyAuthLruTtlMs,
      },
      deps.apiKeyAuthLruMax,
    );
    deps.apiKeyAuthTokenById.set(apiKey.id, token);
    if (deps.apiKeyAuthTokenById.size > deps.apiKeyAuthLruMax * 2) {
      for (const [id, indexedToken] of deps.apiKeyAuthTokenById) {
        if (!deps.apiKeyAuthLruCache.has(indexedToken)) {
          deps.apiKeyAuthTokenById.delete(id);
        }
        if (deps.apiKeyAuthTokenById.size <= deps.apiKeyAuthLruMax) break;
      }
    }
  }

  function advanceApiKeyTokenVersion(token: string) {
    deps.apiKeyAuthTokenVersions.set(
      token,
      (deps.apiKeyAuthTokenVersions.get(token) ?? 0) + 1,
    );
    deps.apiKeyAuthLoadingPromises.delete(token);
  }

  function cacheApiKey(apiKey: ApiKeyRecord) {
    const token = apiKey.apiKey.trim();
    if (!token) return;
    advanceApiKeyTokenVersion(token);
    storeApiKey(apiKey);
  }

  function invalidateApiKeyAuthCacheByToken(token: string) {
    const normalized = token.trim();
    if (!normalized) return;
    advanceApiKeyTokenVersion(normalized);
    const cached = deps.apiKeyAuthLruCache.get(normalized)?.value;
    deps.apiKeyAuthLruCache.delete(normalized);
    if (cached && deps.apiKeyAuthTokenById.get(cached.id) === normalized) {
      deps.apiKeyAuthTokenById.delete(cached.id);
    }
  }

  function invalidateApiKeyAuthCacheByOwnerUserId(ownerUserId: string) {
    const normalized = ownerUserId.trim();
    if (!normalized) return;
    apiKeyAuthInvalidationVersion += 1;
    deps.apiKeyAuthLoadingPromises.clear();
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

  async function authenticateApiKeyByAuthorizationHeaderWithReason(
    authorizationHeader: string | string[] | undefined,
  ): Promise<{
    apiKey: ApiKeyRecord | null;
    reason: ApiKeyAuthFailureReason | null;
  }> {
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

    const tokenVersion = deps.apiKeyAuthTokenVersions.get(token) ?? 0;
    const invalidationVersion = apiKeyAuthInvalidationVersion;
    let loading = deps.apiKeyAuthLoadingPromises.get(token);
    if (!loading) {
      loading = deps.getApiKeyByToken(token);
      deps.apiKeyAuthLoadingPromises.set(token, loading);
    }
    let matched: ApiKeyRecord | null;
    try {
      matched = await loading;
    } finally {
      if (deps.apiKeyAuthLoadingPromises.get(token) === loading) {
        deps.apiKeyAuthLoadingPromises.delete(token);
      }
    }
    if (
      (deps.apiKeyAuthTokenVersions.get(token) ?? 0) !== tokenVersion ||
      apiKeyAuthInvalidationVersion !== invalidationVersion
    ) {
      matched = await deps.getApiKeyByToken(token);
    }
    if (matched && isApiKeyUsable(matched)) {
      storeApiKey(matched);
      return { apiKey: matched, reason: null };
    }
    return { apiKey: null, reason: "api_key_not_found_or_expired" };
  }

  async function authenticateApiKeyWithReason(req: Request): Promise<{
    apiKey: ApiKeyRecord | null;
    reason: ApiKeyAuthFailureReason | null;
  }> {
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

  async function ensureUserBillingAllowanceOrNull(ownerUserId: string | null) {
    if (!ownerUserId) return null;
    const ownerId = ownerUserId.trim();
    if (!ownerId) return null;
    const cached = deps.lruGet(deps.billingAllowanceLruCache, ownerId);
    if (cached) return cached.value;

    const loading = deps.billingAllowanceLoadingPromises.get(ownerId);
    if (loading) {
      return await loading;
    }

    const loadPromise = (async () => {
      const allowance = await deps.getPortalUserSpendAllowance(ownerId);
      const pendingCharge =
        deps.billingPendingChargesByOwnerId.get(ownerId) ?? 0n;
      const availableAfterPending = allowance.totalAvailable - pendingCharge;
      const effectiveAllowance: PortalUserSpendAllowanceValue = {
        balance: allowance.balance - pendingCharge,
        totalAvailable: availableAfterPending,
      };
      deps.lruSet(
        deps.billingAllowanceLruCache,
        ownerId,
        {
          value: effectiveAllowance,
          expiresAtMs: Date.now() + deps.billingAllowanceLruTtlMs,
        },
        deps.billingAllowanceLruMax,
      );
      return effectiveAllowance;
    })();
    deps.billingAllowanceLoadingPromises.set(ownerId, loadPromise);
    try {
      return await loadPromise;
    } finally {
      deps.billingAllowanceLoadingPromises.delete(ownerId);
    }
  }

  function applyUserBillingAllowanceChargeCache(
    ownerUserId: string | null,
    amounts: {
      chargedFromBalance: UsdAmount;
    },
  ) {
    const ownerId = ownerUserId?.trim();
    if (!ownerId) return;
    const chargedFromBalance =
      typeof amounts.chargedFromBalance === "bigint" &&
      amounts.chargedFromBalance > 0n
        ? amounts.chargedFromBalance
        : 0n;
    if (chargedFromBalance <= 0n) return;

    deps.billingPendingChargesByOwnerId.set(
      ownerId,
      (deps.billingPendingChargesByOwnerId.get(ownerId) ?? 0n) +
        chargedFromBalance,
    );

    const cached = deps.billingAllowanceLruCache.get(ownerId) ?? null;
    if (!cached) return;

    const nextBalance = cached.value.balance - chargedFromBalance;
    const next: PortalUserSpendAllowanceValue = {
      balance: nextBalance,
      totalAvailable: nextBalance,
    };
    deps.lruSet(
      deps.billingAllowanceLruCache,
      ownerId,
      {
        value: next,
        expiresAtMs: Date.now() + deps.billingAllowanceLruTtlMs,
      },
      deps.billingAllowanceLruMax,
    );
  }

  function settleUserBillingAllowanceChargeCache(
    ownerUserId: string | null,
    amount: UsdAmount,
    accepted: boolean,
  ) {
    const ownerId = ownerUserId?.trim();
    if (!ownerId || amount <= 0n) return;

    const pending =
      (deps.billingPendingChargesByOwnerId.get(ownerId) ?? 0n) - amount;
    if (pending > 0n) {
      deps.billingPendingChargesByOwnerId.set(ownerId, pending);
    } else {
      deps.billingPendingChargesByOwnerId.delete(ownerId);
    }
    if (accepted) return;

    const cached = deps.billingAllowanceLruCache.get(ownerId) ?? null;
    if (!cached) return;
    const balance = cached.value.balance + amount;
    deps.lruSet(
      deps.billingAllowanceLruCache,
      ownerId,
      {
        value: { balance, totalAvailable: balance },
        expiresAtMs: Date.now() + deps.billingAllowanceLruTtlMs,
      },
      deps.billingAllowanceLruMax,
    );
  }

  function isUserBillingAllowanceExceeded(ownerUserId: string | null) {
    const ownerId = ownerUserId?.trim();
    if (!ownerId) return true;
    const cached = deps.billingAllowanceLruCache.get(ownerId) ?? null;
    if (!cached) return true;
    const reserved =
      deps.billingReservedAmountsByOwnerId.get(ownerId) ?? 0n;
    return (
      cached.value.totalAvailable - reserved <=
      -deps.billingOverdraftLimitUsd
    );
  }

  function tryReserveUserBillingRequest(
    ownerUserId: string,
    reservationId: string,
  ) {
    const ownerId = ownerUserId.trim();
    const normalizedReservationId = reservationId.trim();
    if (!ownerId || !normalizedReservationId) return false;

    const existing = deps.billingReservationById.get(normalizedReservationId);
    if (existing) return existing.ownerUserId === ownerId;

    const cached = deps.billingAllowanceLruCache.get(ownerId) ?? null;
    if (!cached) return false;
    const currentlyReserved =
      deps.billingReservedAmountsByOwnerId.get(ownerId) ?? 0n;
    const amount = deps.billingInflightReserveUsd;
    if (
      cached.value.totalAvailable - currentlyReserved - amount <
      -deps.billingOverdraftLimitUsd
    ) {
      return false;
    }

    deps.billingReservationById.set(normalizedReservationId, {
      ownerUserId: ownerId,
      amount,
    });
    deps.billingReservedAmountsByOwnerId.set(
      ownerId,
      currentlyReserved + amount,
    );
    return true;
  }

  function releaseUserBillingRequestReservation(reservationId: string) {
    const normalizedReservationId = reservationId.trim();
    if (!normalizedReservationId) return;
    const reservation = deps.billingReservationById.get(
      normalizedReservationId,
    );
    if (!reservation) return;
    deps.billingReservationById.delete(normalizedReservationId);

    const remaining =
      (deps.billingReservedAmountsByOwnerId.get(reservation.ownerUserId) ??
        0n) - reservation.amount;
    if (remaining > 0n) {
      deps.billingReservedAmountsByOwnerId.set(
        reservation.ownerUserId,
        remaining,
      );
    } else {
      deps.billingReservedAmountsByOwnerId.delete(reservation.ownerUserId);
    }
  }

  function isApiKeyBoundToUser(apiKey: ApiKeyRecord): boolean {
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
    invalidateApiKeyAuthCacheByToken,
    invalidateApiKeyAuthCacheByOwnerUserId,
    isApiKeyQuotaExceeded,
    ensureUserBillingAllowanceOrNull,
    isUserBillingAllowanceExceeded,
    tryReserveUserBillingRequest,
    releaseUserBillingRequestReservation,
    applyUserBillingAllowanceChargeCache,
    settleUserBillingAllowanceChargeCache,
    isApiKeyBoundToUser,
    applyApiKeyPendingCharge,
    settleApiKeyPendingCharge,
  };
}
