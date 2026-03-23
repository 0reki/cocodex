import crypto from "node:crypto";

import type { Request, Response } from "express";

import type { ApiKeyRecord } from "@workspace/database";

export type ApiKeyAuthFailureReason =
  | "missing_authorization_header"
  | "unsupported_authorization_scheme"
  | "empty_bearer_token"
  | "api_key_not_found_or_expired";

export type PortalAccessSession = {
  sub: string;
  username: string;
  role: "admin" | "user";
  mustSetup: boolean;
  iat: number;
  exp: number;
};

export type PortalAccessTokenFailureReason =
  | "missing_access_token"
  | "unsupported_authorization_scheme"
  | "empty_bearer_token"
  | "access_token_secret_not_configured"
  | "invalid_access_token";

type PortalUserSpendAllowanceValue = {
  allowanceRemaining: number;
  addonRemaining: number;
  balance: number;
  totalAvailable: number;
};

type UserRateLimitValue = {
  userRpmLimit: number | null;
  userMaxInFlight: number | null;
};

export function createAuthServices(deps: {
  adminAccessCookieName: string;
  isRecord: (value: unknown) => value is Record<string, unknown>;
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
  userRateLimitLruCache: Map<
    string,
    { value: UserRateLimitValue; expiresAtMs: number }
  >;
  userRateLimitLoadingPromises: Map<string, Promise<UserRateLimitValue>>;
  userRateLimitLruMax: number;
  userRateLimitLruTtlMs: number;
  requestRateLimitConfig: {
    userRpmLimit: number;
    userMaxInFlight: number;
  };
  normalizeUserRpmLimit: (value: unknown) => number;
  normalizeUserMaxInFlight: (value: unknown) => number;
  getPortalUserSpendAllowance: (
    ownerUserId: string,
  ) => Promise<PortalUserSpendAllowanceValue>;
  getPortalUserById: (ownerUserId: string) => Promise<{
    userRpmLimit?: number | null;
    userMaxInFlight?: number | null;
  } | null>;
  setApiKeysCache: (items: ApiKeyRecord[]) => void;
}) {
  function decodeBase64UrlToBuffer(value: string): Buffer | null {
    if (!value) return null;
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    try {
      return Buffer.from(padded, "base64");
    } catch {
      return null;
    }
  }

  function parsePortalAccessPayload(
    payloadRaw: unknown,
  ): PortalAccessSession | null {
    if (!deps.isRecord(payloadRaw)) return null;
    if (typeof payloadRaw.sub !== "string" || !payloadRaw.sub.trim()) return null;
    if (
      typeof payloadRaw.username !== "string" ||
      !payloadRaw.username.trim()
    ) {
      return null;
    }
    if (payloadRaw.role !== "admin" && payloadRaw.role !== "user") {
      return null;
    }
    if (
      typeof payloadRaw.iat !== "number" ||
      !Number.isFinite(payloadRaw.iat)
    ) {
      return null;
    }
    if (
      typeof payloadRaw.exp !== "number" ||
      !Number.isFinite(payloadRaw.exp)
    ) {
      return null;
    }
    const mustSetup =
      typeof payloadRaw.mustSetup === "boolean"
        ? payloadRaw.mustSetup
        : typeof payloadRaw.must_setup === "boolean"
          ? payloadRaw.must_setup
          : false;
    return {
      sub: payloadRaw.sub.trim(),
      username: payloadRaw.username.trim(),
      role: payloadRaw.role,
      mustSetup,
      iat: Math.trunc(payloadRaw.iat),
      exp: Math.trunc(payloadRaw.exp),
    };
  }

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

  function verifyPortalAccessToken(token: string): PortalAccessSession | null {
    const secret = process.env.ADMIN_JWT_SECRET?.trim() ?? "";
    if (!secret) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts;
    if (!headerPart || !payloadPart || !signaturePart) return null;

    const headerBuffer = decodeBase64UrlToBuffer(headerPart);
    const payloadBuffer = decodeBase64UrlToBuffer(payloadPart);
    const signatureBuffer = decodeBase64UrlToBuffer(signaturePart);
    if (!headerBuffer || !payloadBuffer || !signatureBuffer) return null;

    let header: Record<string, unknown> | null = null;
    let payloadParsed: unknown = null;
    try {
      header = JSON.parse(headerBuffer.toString("utf8")) as Record<
        string,
        unknown
      >;
      payloadParsed = JSON.parse(payloadBuffer.toString("utf8")) as unknown;
    } catch {
      return null;
    }

    if (!header || header.alg !== "HS256") return null;
    if (
      typeof header.typ === "string" &&
      header.typ.trim() &&
      header.typ.trim().toUpperCase() !== "JWT"
    ) {
      return null;
    }

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(`${headerPart}.${payloadPart}`)
      .digest();
    if (expectedSignature.length !== signatureBuffer.length) return null;
    if (!crypto.timingSafeEqual(expectedSignature, signatureBuffer)) return null;

    const payload = parsePortalAccessPayload(payloadParsed);
    if (!payload) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp <= nowSec) return null;
    return payload;
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

  async function authenticateApiKey(req: Request) {
    const result = await authenticateApiKeyWithReason(req);
    return result.apiKey;
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

  async function ensureEffectiveUserRateLimitOrNull(ownerUserId: string | null) {
    if (!ownerUserId) return null;
    const ownerId = ownerUserId.trim();
    if (!ownerId) return null;
    const cached = deps.lruGet(deps.userRateLimitLruCache, ownerId);
    const raw = cached
      ? cached.value
      : await (async () => {
          const loading = deps.userRateLimitLoadingPromises.get(ownerId);
          if (loading) return await loading;
          const loadPromise = (async () => {
            const user = await deps.getPortalUserById(ownerId);
            const value = {
              userRpmLimit:
                user?.userRpmLimit == null
                  ? null
                  : deps.normalizeUserRpmLimit(user.userRpmLimit),
              userMaxInFlight:
                user?.userMaxInFlight == null
                  ? null
                  : deps.normalizeUserMaxInFlight(user.userMaxInFlight),
            };
            deps.lruSet(
              deps.userRateLimitLruCache,
              ownerId,
              {
                value,
                expiresAtMs: Date.now() + deps.userRateLimitLruTtlMs,
              },
              deps.userRateLimitLruMax,
            );
            return value;
          })();
          deps.userRateLimitLoadingPromises.set(ownerId, loadPromise);
          try {
            return await loadPromise;
          } finally {
            deps.userRateLimitLoadingPromises.delete(ownerId);
          }
        })();

    return {
      userRpmLimit: raw.userRpmLimit ?? deps.requestRateLimitConfig.userRpmLimit,
      userMaxInFlight:
        raw.userMaxInFlight ?? deps.requestRateLimitConfig.userMaxInFlight,
    };
  }

  function applyUserBillingAllowanceChargeCache(
    ownerUserId: string | null,
    amounts: {
      consumedFromAllowance: number;
      chargedFromBalance: number;
    },
  ) {
    const ownerId = ownerUserId?.trim();
    if (!ownerId) return;
    const cached = deps.lruGet(deps.billingAllowanceLruCache, ownerId);
    if (!cached) return;

    const consumedFromAllowance =
      Number.isFinite(amounts.consumedFromAllowance) &&
      amounts.consumedFromAllowance > 0
        ? amounts.consumedFromAllowance
        : 0;
    const chargedFromBalance =
      Number.isFinite(amounts.chargedFromBalance) &&
      amounts.chargedFromBalance > 0
        ? amounts.chargedFromBalance
        : 0;
    if (consumedFromAllowance <= 0 && chargedFromBalance <= 0) return;

    const nextAllowanceRemaining = Math.max(
      0,
      cached.value.allowanceRemaining - consumedFromAllowance,
    );
    const consumedFromAddons = Math.min(
      cached.value.addonRemaining,
      consumedFromAllowance,
    );
    const nextBalance = Math.max(0, cached.value.balance - chargedFromBalance);
    const next: PortalUserSpendAllowanceValue = {
      allowanceRemaining: nextAllowanceRemaining,
      addonRemaining: Math.max(0, cached.value.addonRemaining - consumedFromAddons),
      balance: nextBalance,
      totalAvailable: nextAllowanceRemaining + nextBalance,
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
    authenticateApiKey,
    getApiKeyAuthErrorDetail,
    getAccessTokenAuthErrorDetail,
    getPortalSessionFromLocals,
    isApiKeyQuotaExceeded,
    ensureUserBillingAllowanceOrNull,
    ensureEffectiveUserRateLimitOrNull,
    applyUserBillingAllowanceChargeCache,
    isApiKeyBoundToUser,
    applyApiKeyCacheUpdate,
  };
}
