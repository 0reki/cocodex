import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

import {
  countPortalUsers,
  createPortalUser,
  ensureDatabaseSchema,
  getPortalUserByUsername,
} from "../../database/index.ts";

type PortalTokenKind = "access" | "refresh";

export const PORTAL_PASSWORD_MIN_LENGTH = 8;
export const PORTAL_PASSWORD_MAX_LENGTH = 128;

export type PortalAccessClaims = {
  sub: string;
  typ: PortalTokenKind;
  iat: number;
  exp: number;
};

function getJwtSecret() {
  const secret = process.env.ADMIN_JWT_SECRET?.trim() ?? "";
  if (!secret) {
    throw new Error("ADMIN_JWT_SECRET is not configured");
  }
  return secret;
}

function getTokenTtlSeconds(kind: PortalTokenKind) {
  const defaultTtl = kind === "access" ? 60 * 60 * 24 * 10 : 60 * 60 * 24 * 30;
  const envName =
    kind === "access"
      ? "ADMIN_ACCESS_TOKEN_TTL_SECONDS"
      : "ADMIN_REFRESH_TOKEN_TTL_SECONDS";
  const configured = Number(process.env[envName] ?? defaultTtl);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : defaultTtl;
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
    "base64",
  );
}

export function parsePortalAccessPayload(
  payloadRaw: unknown,
): PortalAccessClaims | null {
  if (!payloadRaw || typeof payloadRaw !== "object") return null;
  const payload = payloadRaw as Record<string, unknown>;
  if (typeof payload.sub !== "string" || !payload.sub.trim()) return null;
  if (payload.typ !== "access" && payload.typ !== "refresh") return null;
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
    return null;
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return null;
  }
  return {
    sub: payload.sub.trim(),
    typ: payload.typ,
    iat: Math.trunc(payload.iat),
    exp: Math.trunc(payload.exp),
  };
}

function createPortalToken(userId: string, kind: PortalTokenKind) {
  const now = Math.floor(Date.now() / 1000);
  const payload: PortalAccessClaims = {
    sub: userId,
    typ: kind,
    iat: now,
    exp: now + getTokenTtlSeconds(kind),
  };
  const headerPart = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = createHmac("sha256", getJwtSecret())
    .update(signingInput)
    .digest("base64url");
  return {
    token: `${signingInput}.${signature}`,
    expiresAt: payload.exp,
  };
}

export function createPortalTokens(input: { userId: string }) {
  return {
    accessToken: createPortalToken(input.userId, "access"),
    refreshToken: createPortalToken(input.userId, "refresh"),
  };
}

export function verifyPortalToken(
  token: string,
  kind: PortalTokenKind,
): PortalAccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return null;

  try {
    const header = JSON.parse(decodeBase64Url(headerPart).toString("utf8")) as {
      alg?: unknown;
      typ?: unknown;
    };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;

    const actualSignature = decodeBase64Url(signaturePart);
    const expectedSignature = createHmac("sha256", getJwtSecret())
      .update(`${headerPart}.${payloadPart}`)
      .digest();
    if (actualSignature.length !== expectedSignature.length) return null;
    if (!timingSafeEqual(actualSignature, expectedSignature)) return null;

    const payload = parsePortalAccessPayload(
      JSON.parse(decodeBase64Url(payloadPart).toString("utf8")),
    );
    if (!payload || payload.typ !== kind) return null;
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

export function verifyPortalAccessToken(token: string) {
  return verifyPortalToken(token, "access");
}

export function createPortalInvitationToken() {
  return randomBytes(32).toString("base64url");
}

export function hashPortalInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function getPortalPasswordValidationError(password: string) {
  if (password.length < PORTAL_PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PORTAL_PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PORTAL_PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PORTAL_PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}

function derivePasswordKey(
  password: string,
  salt: Buffer,
  length: number,
) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, length, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const digest = await derivePasswordKey(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${digest.toString("base64")}`;
}

export async function verifyPassword(password: string, passwordHash: string) {
  const [algorithm, saltRaw, hashRaw] = passwordHash.split("$");
  if (algorithm !== "scrypt" || !saltRaw || !hashRaw) return false;
  const expected = Buffer.from(hashRaw, "base64");
  const actual = await derivePasswordKey(
    password,
    Buffer.from(saltRaw, "base64"),
    expected.length,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function ensureBootstrapAdminUser() {
  await ensureDatabaseSchema();
  if ((await countPortalUsers()) > 0) return;

  const username = (process.env.ADMIN_USERNAME ?? "admin").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "";
  getJwtSecret();
  if (!username || !password) {
    throw new Error(
      "Configure ADMIN_USERNAME and ADMIN_PASSWORD before the first login",
    );
  }
  if (await getPortalUserByUsername(username)) return;

  await createPortalUser({
    username,
    passwordHash: await hashPassword(password),
    role: "admin",
    enabled: true,
  });
}
