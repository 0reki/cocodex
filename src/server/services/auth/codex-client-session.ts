import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEVICE_TTL_MS = 15 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACCESS_TTL_SECS = 10 * 24 * 60 * 60;
const ID_TTL_SECS = 60 * 60;
const DEVICE_INTERVAL_SECONDS = 5;
const DEV_FALLBACK_JWT_SECRET = "cocodex-dev-client-jwt-secret";
const OPENAI_ISSUER = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type IssuedCodexClientTokens = {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
  token_type: "Bearer";
  expires_in: number;
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
  ownerUserId: string;
  email: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAtMs: number;
};

type RefreshSession = {
  refreshToken: string;
  ownerUserId: string;
  email: string;
  expiresAtMs: number;
};

export type PersistRefreshTokenInput = {
  tokenHash: string;
  ownerUserId: string;
  email: string;
  expiresAtMs: number;
};

export type RevokeRefreshTokenInput = {
  tokenHash?: string;
  ownerUserId?: string;
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

function getClientJwtSecret() {
  return (
    process.env.CODEX_CLIENT_JWT_SECRET?.trim() ||
    process.env.ADMIN_JWT_SECRET?.trim() ||
    DEV_FALLBACK_JWT_SECRET
  );
}

function signHs256Jwt(payload: unknown) {
  const headerPart = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = createHmac("sha256", getClientJwtSecret())
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

export function gatewayAccountId(ownerUserId: string) {
  return ownerUserId.trim();
}

function compactAlnum(value: string) {
  const compact = value.replace(/[^a-zA-Z0-9]/g, "");
  return compact || "gateway";
}

export function chatgptUserIdFor(accountId: string) {
  const compact = compactAlnum(accountId);
  return `user-${compact.slice(0, 24)}`;
}

function chatgptOrgIdFor(accountId: string) {
  const compact = compactAlnum(accountId);
  return `org-${compact.slice(0, 24)}`;
}

function displayNameFromEmail(email: string) {
  return email.split("@")[0]?.trim() || "user";
}

function atHash(accessToken: string) {
  return createHash("sha256").update(accessToken).digest().subarray(0, 16).toString("base64url");
}

export function hashCodexClientRefreshToken(token: string) {
  return createHash("sha256").update(token.trim()).digest("hex");
}

function issueRefreshToken() {
  return `rt.1.${randomToken(72)}`;
}

function buildAccessPayload(
  accountId: string,
  email: string,
  nowSecs: number,
  sessionId: string,
) {
  const chatgptUserId = chatgptUserIdFor(accountId);
  const orgId = chatgptOrgIdFor(accountId);
  const name = displayNameFromEmail(email);
  return {
    iss: OPENAI_ISSUER,
    aud: ["https://api.openai.com/v1"],
    client_id: CODEX_CLIENT_ID,
    "https://api.openai.com/auth": {
      amr: ["urn:openai:amr:pwd"],
      chatgpt_account_id: accountId,
      chatgpt_account_user_id: `${chatgptUserId}__${accountId}`,
      chatgpt_compute_residency: "no_constraint",
      chatgpt_plan_type: "pro",
      chatgpt_user_id: chatgptUserId,
      localhost: false,
      poid: orgId,
      user_id: chatgptUserId,
    },
    "https://api.openai.com/profile": {
      email,
      email_verified: true,
      name,
    },
    pwd_auth_time: nowSecs * 1000,
    scp: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "api.connectors.read",
      "api.connectors.invoke",
    ],
    session_id: sessionId,
    sl: true,
    sub: `cocodex|${accountId}`,
    iat: nowSecs,
    exp: nowSecs + ACCESS_TTL_SECS,
    jti: randomBytes(16).toString("hex"),
    nbf: nowSecs,
  };
}

function buildIdPayload(
  accountId: string,
  email: string,
  nowSecs: number,
  sessionId: string,
  accessToken: string,
) {
  const chatgptUserId = chatgptUserIdFor(accountId);
  const orgId = chatgptOrgIdFor(accountId);
  const name = displayNameFromEmail(email);
  return {
    amr: ["urn:openai:amr:pwd"],
    aud: [CODEX_CLIENT_ID],
    auth_provider: "password",
    auth_time: nowSecs,
    email,
    email_verified: true,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "pro",
      chatgpt_subscription_active_start: null,
      chatgpt_subscription_active_until: null,
      chatgpt_subscription_last_checked: new Date(nowSecs * 1000).toISOString(),
      chatgpt_user_id: chatgptUserId,
      groups: [],
      localhost: false,
      organizations: [
        {
          id: orgId,
          is_default: true,
          role: "owner",
          title: "Personal",
        },
      ],
      user_id: chatgptUserId,
    },
    iss: OPENAI_ISSUER,
    name,
    rat: nowSecs,
    sid: sessionId,
    sub: `cocodex|${accountId}`,
    iat: nowSecs,
    exp: nowSecs + ID_TTL_SECS,
    jti: randomBytes(16).toString("hex"),
    at_hash: atHash(accessToken),
  };
}

export function createCodexAccessToken(
  ownerUserId: string,
  expiresAtMs: number,
  email = `${ownerUserId}@openai.com`,
) {
  const nowSecs = Math.floor(Date.now() / 1000);
  void expiresAtMs;
  const sessionId = `authsess_${randomBytes(16).toString("hex")}`;
  return signHs256Jwt(buildAccessPayload(ownerUserId, email, nowSecs, sessionId));
}

export function createCodexIdToken(
  ownerUserId: string,
  expiresAtMs: number,
  email = `${ownerUserId}@openai.com`,
) {
  const nowSecs = Math.floor(Date.now() / 1000);
  void expiresAtMs;
  const sessionId = `authsess_${randomBytes(16).toString("hex")}`;
  const accessToken = createCodexAccessToken(ownerUserId, expiresAtMs, email);
  return signHs256Jwt(buildIdPayload(ownerUserId, email, nowSecs, sessionId, accessToken));
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
  now?: () => number;
  storeRefreshToken?: (input: PersistRefreshTokenInput) => Promise<void>;
  consumeRefreshToken?: (
    tokenHash: string,
  ) => Promise<{ ownerUserId: string; email: string } | null>;
  revokeRefreshTokens?: (input: RevokeRefreshTokenInput) => Promise<void>;
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

  async function issueTokens(
    ownerUserId: string,
    email: string,
  ): Promise<IssuedCodexClientTokens> {
    const nowSecs = Math.floor(now() / 1000);
    const sessionId = `authsess_${randomBytes(16).toString("hex")}`;
    const accountId = gatewayAccountId(ownerUserId);
    const accessToken = signHs256Jwt(
      buildAccessPayload(accountId, email, nowSecs, sessionId),
    );
    const idToken = signHs256Jwt(
      buildIdPayload(accountId, email, nowSecs, sessionId, accessToken),
    );
    const refreshToken = issueRefreshToken();
    const expiresAtMs = now() + REFRESH_TTL_MS;
    if (deps.storeRefreshToken) {
      await deps.storeRefreshToken({
        tokenHash: hashCodexClientRefreshToken(refreshToken),
        ownerUserId: accountId,
        email,
        expiresAtMs,
      });
    } else {
      refreshSessions.set(refreshToken, {
        refreshToken,
        ownerUserId: accountId,
        email,
        expiresAtMs,
      });
    }
    return {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountId,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECS,
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
    ownerUserId: string;
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
      ownerUserId: input.ownerUserId,
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
    ownerUserId: string;
    email: string;
    codeChallenge: string;
    redirectUri: string;
  }) {
    sweepExpired();
    const code = randomToken();
    authCodes.set(code, {
      code,
      ownerUserId: input.ownerUserId,
      email: input.email,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      expiresAtMs: now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  async function exchangeAuthorizationCode(input: {
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
    return issueTokens(session.ownerUserId, session.email);
  }

  async function refresh(refreshToken: string) {
    sweepExpired();
    const normalized = refreshToken.trim();
    if (!normalized) return null;
    if (deps.consumeRefreshToken) {
      const record = await deps.consumeRefreshToken(
        hashCodexClientRefreshToken(normalized),
      );
      if (!record) return null;
      return issueTokens(record.ownerUserId, record.email);
    }
    const session = refreshSessions.get(normalized);
    if (!session) return null;
    refreshSessions.delete(session.refreshToken);
    return issueTokens(session.ownerUserId, session.email);
  }

  async function revoke(token: string) {
    sweepExpired();
    const normalized = token.trim();
    if (!normalized) return;
    const tokenHash = hashCodexClientRefreshToken(normalized);
    let ownerUserId = "";
    const parts = normalized.split(".");
    if (parts.length === 3 && parts[1]) {
      try {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf8"),
        ) as {
          "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
        };
        const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
        if (typeof accountId === "string") ownerUserId = accountId;
      } catch {
        // ignore malformed tokens
      }
    }
    if (deps.revokeRefreshTokens) {
      await deps.revokeRefreshTokens({
        tokenHash,
        ownerUserId: ownerUserId || undefined,
      });
      return;
    }
    refreshSessions.delete(normalized);
    if (ownerUserId) {
      for (const [refreshToken, session] of refreshSessions) {
        if (gatewayAccountId(session.ownerUserId) === ownerUserId) {
          refreshSessions.delete(refreshToken);
        }
      }
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

