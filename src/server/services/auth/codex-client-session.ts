import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { ApiKeyRecord } from "../../../database/index.ts";

const DEVICE_TTL_MS = 15 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_INTERVAL_SECONDS = 5;

export type IssuedCodexClientTokens = {
  id_token: string;
  access_token: string;
  refresh_token: string;
};

type DeviceSession = {
  deviceAuthId: string;
  userCode: string;
  expiresAtMs: number;
  authorization:
    | {
        code: string;
        codeChallenge: string;
        codeVerifier: string;
      }
    | null;
};

type AuthCodeSession = {
  code: string;
  apiKey: ApiKeyRecord;
  email: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAtMs: number;
};

type RefreshSession = {
  refreshToken: string;
  apiKey: ApiKeyRecord;
  email: string;
  expiresAtMs: number;
};

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function generateUserCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let raw = "";
  const bytes = randomBytes(8);
  for (const byte of bytes) {
    raw += alphabet[byte % alphabet.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createCodexIdToken(
  apiKey: ApiKeyRecord,
  expiresAtMs: number,
  email = `${apiKey.ownerUserId ?? apiKey.id}@cocodex.local`,
) {
  const accountId = apiKey.ownerUserId ?? apiKey.id;
  const payload = {
    email,
    exp: Math.floor(expiresAtMs / 1000),
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "pro",
      chatgpt_user_id: accountId,
      chatgpt_account_id: accountId,
    },
  };
  return `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson(payload)}.`;
}

export function createPkcePair() {
  const codeVerifier = randomToken(48);
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function verifyPkce(codeVerifier: string, codeChallenge: string) {
  const expected = createHash("sha256").update(codeVerifier).digest("base64url");
  const left = Buffer.from(expected);
  const right = Buffer.from(codeChallenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createCodexClientSessionStore(deps: {
  cacheApiKey?: (apiKey: ApiKeyRecord) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const devicesById = new Map<string, DeviceSession>();
  const devicesByUserCode = new Map<string, string>();
  const authCodes = new Map<string, AuthCodeSession>();
  const refreshSessions = new Map<string, RefreshSession>();

  function sweepExpired() {
    const ts = now();
    for (const [id, session] of devicesById) {
      if (session.expiresAtMs <= ts) {
        devicesById.delete(id);
        devicesByUserCode.delete(session.userCode);
      }
    }
    for (const [code, session] of authCodes) {
      if (session.expiresAtMs <= ts) authCodes.delete(code);
    }
    for (const [token, session] of refreshSessions) {
      if (session.expiresAtMs <= ts) refreshSessions.delete(token);
    }
  }

  function issueTokens(
    apiKey: ApiKeyRecord,
    email: string,
  ): IssuedCodexClientTokens {
    const expiresAtMs = now() + 10 * 24 * 60 * 60 * 1000;
    const refreshToken = randomToken();
    refreshSessions.set(refreshToken, {
      refreshToken,
      apiKey,
      email,
      expiresAtMs: now() + REFRESH_TTL_MS,
    });
    deps.cacheApiKey?.(apiKey);
    return {
      id_token: createCodexIdToken(apiKey, expiresAtMs, email),
      access_token: apiKey.apiKey,
      refresh_token: refreshToken,
    };
  }

  function createDeviceCode() {
    sweepExpired();
    const deviceAuthId = randomToken(18);
    const userCode = generateUserCode();
    devicesById.set(deviceAuthId, {
      deviceAuthId,
      userCode,
      expiresAtMs: now() + DEVICE_TTL_MS,
      authorization: null,
    });
    devicesByUserCode.set(userCode, deviceAuthId);
    return {
      device_auth_id: deviceAuthId,
      user_code: userCode,
      interval: String(DEVICE_INTERVAL_SECONDS),
    };
  }

  function approveDevice(input: {
    userCode: string;
    apiKey: ApiKeyRecord;
    email: string;
  }) {
    sweepExpired();
    const normalizedCode = input.userCode.trim().toUpperCase();
    const deviceAuthId = devicesByUserCode.get(normalizedCode);
    const device = deviceAuthId ? devicesById.get(deviceAuthId) : null;
    if (!device) {
      throw new Error("Invalid or expired device code");
    }
    const pkce = createPkcePair();
    const code = randomToken();
    device.authorization = {
      code,
      codeChallenge: pkce.codeChallenge,
      codeVerifier: pkce.codeVerifier,
    };
    authCodes.set(code, {
      code,
      apiKey: input.apiKey,
      email: input.email,
      codeChallenge: pkce.codeChallenge,
      redirectUri: "/deviceauth/callback",
      expiresAtMs: now() + AUTH_CODE_TTL_MS,
    });
    return { ok: true as const };
  }

  function pollDeviceToken(deviceAuthId: string, userCode: string) {
    sweepExpired();
    const device = devicesById.get(deviceAuthId.trim());
    if (!device || device.userCode !== userCode.trim().toUpperCase()) {
      return { status: "unknown" as const };
    }
    if (!device.authorization) {
      return { status: "pending" as const };
    }
    return {
      status: "complete" as const,
      authorization_code: device.authorization.code,
      code_challenge: device.authorization.codeChallenge,
      code_verifier: device.authorization.codeVerifier,
    };
  }

  function createBrowserAuthorization(input: {
    apiKey: ApiKeyRecord;
    email: string;
    codeChallenge: string;
    redirectUri: string;
  }) {
    sweepExpired();
    const code = randomToken();
    authCodes.set(code, {
      code,
      apiKey: input.apiKey,
      email: input.email,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      expiresAtMs: now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  function exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }) {
    sweepExpired();
    const session = authCodes.get(input.code.trim());
    if (!session) return null;
    authCodes.delete(session.code);
    if (session.redirectUri !== input.redirectUri) return null;
    if (!verifyPkce(input.codeVerifier, session.codeChallenge)) return null;
    return issueTokens(session.apiKey, session.email);
  }

  function refresh(refreshToken: string) {
    sweepExpired();
    const session = refreshSessions.get(refreshToken.trim());
    if (!session) return null;
    refreshSessions.delete(session.refreshToken);
    return issueTokens(session.apiKey, session.email);
  }

  function revoke(token: string) {
    sweepExpired();
    const normalized = token.trim();
    refreshSessions.delete(normalized);
    for (const [code, session] of authCodes) {
      if (session.apiKey.apiKey === normalized) authCodes.delete(code);
    }
  }

  return {
    createDeviceCode,
    approveDevice,
    pollDeviceToken,
    createBrowserAuthorization,
    exchangeAuthorizationCode,
    refresh,
    revoke,
    issueTokens,
  };
}
