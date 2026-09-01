import type { Request, Response } from "express";

import type { ApiKeyRecord } from "../../../database/index.ts";
import {
  parsePortalAccessPayload,
  verifyPortalAccessToken,
  type PortalAccessSession,
} from "../../auth/portal-auth.ts";

export type { PortalAccessSession } from "../../auth/portal-auth.ts";

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
  | "invalid_access_token";

type PortalUserSpendAllowanceValue = {
  balance: number;
  totalAvailable: number;
};

export function createAuthServices(deps: {
  adminAccessCookieName: string;
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
  apiKeysCache: {
    items: ApiKeyRecord[];
    byToken: Map<string, ApiKeyRecord[]>;
  };
  apiKeyAuthLruCache: Map<
    string,
    { value: ApiKeyRecord; expiresAtMs: number }
  >;
  apiKeyAuthLruMax: number;
  apiKeyAuthLruTtlMs: number;
  ensureApiKeysCacheLoaded: (force?: boolean) => Promise<void>;
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
  getPortalUserSpendAllowance: (
    ownerUserId: string,
  ) => Promise<PortalUserSpendAllowanceValue>;
  setApiKeysCache: (items: ApiKeyRecord[]) => void;
}) {
  function readCookieValueFromHeader(
    cookieHeader: string,
    targetName: string,
  ): string | null {
    if (!cookieHeader.trim()) return null;
    for (const segment of cookieHeader.split(";")) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      if (name !== targetName) continue;
      const rawValue = trimmed.slice(eq + 1).trim();
      if (!rawValue) return null;
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
    return null;
  }

  async function authenticatePortalAccessTokenWithReason(
    req: Request,
  ): Promise<{
    session: PortalAccessSession | null;
    reason: PortalAccessTokenFailureReason | null;
  }> {
    const auth = req.header("authorization")?.trim() ?? "";
    let token = "";
    if (auth) {
      if (!auth.toLowerCase().startsWith("bearer ")) {
        return { session: null, reason: "unsupported_authorization_scheme" };
      }
      token = auth.slice(7).trim();
      if (!token) {
        return { session: null, reason: "empty_bearer_token" };
      }
    }

    if (!token) {
      token =
        readCookieValueFromHeader(
          req.header("cookie") ?? "",
          deps.adminAccessCookieName,
        ) ?? "";
    }
    if (!token) {
      return { session: null, reason: "missing_access_token" };
    }
    if (!(process.env.ADMIN_JWT_SECRET?.trim() ?? "")) {
      return { session: null, reason: "access_token_secret_not_configured" };
    }
    const session = verifyPortalAccessToken(token);
    if (!session) {
      return { session: null, reason: "invalid_access_token" };
    }
    return { session, reason: null };
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
    if (fromLru) {
      const now = Date.now();
      if (!fromLru.expiresAt) return { apiKey: fromLru, reason: null };
      const expiresAtMs = Date.parse(fromLru.expiresAt);
      if (Number.isNaN(expiresAtMs) || expiresAtMs > now) {
        return { apiKey: fromLru, reason: null };
      }
    }

    await deps.ensureApiKeysCacheLoaded();
    const now = Date.now();
    const candidates = deps.apiKeysCache.byToken.get(token) ?? [];
    const matched =
      candidates.find((item) => {
        if (!item.expiresAt) return true;
        const expiresAtMs = Date.parse(item.expiresAt);
        if (Number.isNaN(expiresAtMs)) return true;
        return expiresAtMs > now;
      }) ?? null;
    if (matched) {
      deps.lruSet(
        deps.apiKeyAuthLruCache,
        token,
        { value: matched, expiresAtMs: now + deps.apiKeyAuthLruTtlMs },
        deps.apiKeyAuthLruMax,
      );
    }
    if (!matched) {
      return { apiKey: null, reason: "api_key_not_found_or_expired" };
    }
    return { apiKey: matched, reason: null };
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
      case "invalid_access_token":
      default:
        return {
          status: 401,
          code: "invalid_access_token",
          message: "Invalid access token",
        };
    }
  }

  function getPortalSessionFromLocals(
    res: Response,
  ): PortalAccessSession | null {
    const session = res.locals.portalSession;
    const parsed = parsePortalAccessPayload(session);
    if (!parsed) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (parsed.exp <= nowSec) return null;
    return parsed;
  }

  function isApiKeyQuotaExceeded(apiKey: ApiKeyRecord): boolean {
    if (apiKey.quota == null) return false;
    return apiKey.used >= apiKey.quota;
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
      deps.lruSet(
        deps.billingAllowanceLruCache,
        ownerId,
        {
          value: allowance,
          expiresAtMs: Date.now() + deps.billingAllowanceLruTtlMs,
        },
        deps.billingAllowanceLruMax,
      );
      return allowance;
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
      chargedFromBalance: number;
    },
  ) {
    const ownerId = ownerUserId?.trim();
    if (!ownerId) return;
    const cached = deps.lruGet(deps.billingAllowanceLruCache, ownerId);
    if (!cached) return;

    const chargedFromBalance =
      Number.isFinite(amounts.chargedFromBalance) &&
      amounts.chargedFromBalance > 0
        ? amounts.chargedFromBalance
        : 0;
    if (chargedFromBalance <= 0) return;

    const nextBalance = Math.max(0, cached.value.balance - chargedFromBalance);
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

  function isApiKeyBoundToUser(apiKey: ApiKeyRecord): boolean {
    return (
      typeof apiKey.ownerUserId === "string" &&
      apiKey.ownerUserId.trim().length > 0
    );
  }

  function applyApiKeyCacheUpdate(updated: ApiKeyRecord) {
    deps.setApiKeysCache(
      deps.apiKeysCache.items.map((item) =>
        item.id === updated.id ? { ...updated } : item,
      ),
    );
  }

  return {
    authenticatePortalAccessTokenWithReason,
    authenticateApiKeyByAuthorizationHeaderWithReason,
    authenticateApiKeyWithReason,
    getApiKeyAuthErrorDetail,
    getAccessTokenAuthErrorDetail,
    getPortalSessionFromLocals,
    isApiKeyQuotaExceeded,
    ensureUserBillingAllowanceOrNull,
    applyUserBillingAllowanceChargeCache,
    isApiKeyBoundToUser,
    applyApiKeyCacheUpdate,
  };
}
