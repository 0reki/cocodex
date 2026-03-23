import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import type { PortalUserRole } from "@workspace/database"

export const ADMIN_ACCESS_COOKIE = "admin_access_token"
export const ADMIN_REFRESH_COOKIE = "admin_refresh_token"

type PortalTokenKind = "access" | "refresh"

export type PortalSessionPayload = {
  sub: string
  username: string
  role: PortalUserRole
  mustSetup: boolean
  typ?: PortalTokenKind
  iat: number
  exp: number
}

export type ResolvedPortalSession = {
  session: PortalSessionPayload
  accessToken: string
  refreshed: boolean
}

type CookieGetter = {
  get(name: string): { value: string } | undefined
}

type CookieSetter = {
  set(options: {
    name: string
    value: string
    httpOnly: boolean
    secure: boolean
    sameSite: "lax"
    path: string
    maxAge: number
  }): void
}

export function getAdminPassword() {
  return process.env.ADMIN_PASSWORD ?? ""
}

export function getAdminUsername() {
  return (process.env.ADMIN_USERNAME ?? "admin").trim().toLowerCase()
}

export function getAdminJwtSecret() {
  return process.env.ADMIN_JWT_SECRET ?? ""
}

function getAdminAccessTokenTtlSeconds() {
  const raw = Number(process.env.ADMIN_ACCESS_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 10)
  if (!Number.isFinite(raw) || raw <= 0) {
    return 60 * 60 * 24 * 10
  }
  return Math.floor(raw)
}

function getAdminRefreshTokenTtlSeconds() {
  const raw = Number(process.env.ADMIN_REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 90)
  if (!Number.isFinite(raw) || raw <= 0) {
    return 60 * 60 * 24 * 90
  }
  return Math.floor(raw)
}

function toBase64Url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function fromBase64Url(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

async function getHmacKey() {
  const secret = getAdminJwtSecret()
  if (!secret) {
    throw new Error("ADMIN_JWT_SECRET is not configured")
  }

  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

function parsePayload(payloadPart: string): PortalSessionPayload | null {
  try {
    const json = new TextDecoder().decode(fromBase64Url(payloadPart))
    const payload = JSON.parse(json) as Partial<PortalSessionPayload>
    if (
      typeof payload.sub !== "string" ||
      typeof payload.username !== "string" ||
      (payload.role !== "admin" && payload.role !== "user") ||
      (typeof payload.mustSetup !== "boolean" && payload.mustSetup !== undefined) ||
      (payload.typ !== undefined && payload.typ !== "access" && payload.typ !== "refresh") ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null
    }
    return {
      ...(payload as PortalSessionPayload),
      mustSetup: Boolean(payload.mustSetup),
    }
  } catch {
    return null
  }
}

async function createSignedToken(input: {
  userId: string
  username: string
  role: PortalUserRole
  mustSetup?: boolean
  typ: PortalTokenKind
  ttlSeconds: number
}) {
  const now = Math.floor(Date.now() / 1000)
  const payload: PortalSessionPayload = {
    sub: input.userId,
    username: input.username,
    role: input.role,
    mustSetup: Boolean(input.mustSetup),
    typ: input.typ,
    iat: now,
    exp: now + input.ttlSeconds,
  }
  const headerPart = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  )
  const payloadPart = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const signingInput = `${headerPart}.${payloadPart}`
  const key = await getHmacKey()
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  )
  const signaturePart = toBase64Url(new Uint8Array(signature))

  return {
    token: `${signingInput}.${signaturePart}`,
    expiresAt: payload.exp,
  }
}

export async function createAccessToken(input: {
  userId: string
  username: string
  role: PortalUserRole
  mustSetup?: boolean
}) {
  return createSignedToken({
    ...input,
    typ: "access",
    ttlSeconds: getAdminAccessTokenTtlSeconds(),
  })
}

export async function createRefreshToken(input: {
  userId: string
  username: string
  role: PortalUserRole
  mustSetup?: boolean
}) {
  return createSignedToken({
    ...input,
    typ: "refresh",
    ttlSeconds: getAdminRefreshTokenTtlSeconds(),
  })
}

export async function createSessionTokens(input: {
  userId: string
  username: string
  role: PortalUserRole
  mustSetup?: boolean
}) {
  const [accessToken, refreshToken] = await Promise.all([
    createAccessToken(input),
    createRefreshToken(input),
  ])
  return { accessToken, refreshToken }
}

async function verifyToken(
  token: string | undefined,
  expectedType: PortalTokenKind,
): Promise<PortalSessionPayload | null> {
  if (!token) return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [headerPart, payloadPart, signaturePart] = parts
  if (!headerPart || !payloadPart || !signaturePart) return null

  try {
    const key = await getHmacKey()
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    )
    if (!verified) return null

    const payload = parsePayload(payloadPart)
    if (!payload) return null
    if (payload.typ && payload.typ !== expectedType) return null
    const now = Math.floor(Date.now() / 1000)
    return payload.exp > now ? payload : null
  } catch {
    return null
  }
}

export async function verifyAccessToken(token: string | undefined) {
  return verifyToken(token, "access")
}

export async function verifyRefreshToken(token: string | undefined) {
  return verifyToken(token, "refresh")
}

export async function verifyAdminAccessToken(token: string | undefined) {
  const payload = await verifyAccessToken(token)
  return payload?.role === "admin"
}

export async function resolvePortalSessionFromTokens(input: {
  accessToken?: string
  refreshToken?: string
}): Promise<ResolvedPortalSession | null> {
  const accessToken = input.accessToken?.trim() ?? ""
  const accessPayload = await verifyAccessToken(accessToken)
  if (accessPayload) {
    return {
      session: accessPayload,
      accessToken,
      refreshed: false,
    }
  }

  const refreshPayload = await verifyRefreshToken(input.refreshToken?.trim())
  if (!refreshPayload) {
    return null
  }

  const nextAccessToken = await createAccessToken({
    userId: refreshPayload.sub,
    username: refreshPayload.username,
    role: refreshPayload.role,
    mustSetup: refreshPayload.mustSetup,
  })

  return {
    session: refreshPayload,
    accessToken: nextAccessToken.token,
    refreshed: true,
  }
}

export async function resolvePortalSessionFromCookieStore(cookieStore: CookieGetter) {
  return resolvePortalSessionFromTokens({
    accessToken: cookieStore.get(ADMIN_ACCESS_COOKIE)?.value,
    refreshToken: cookieStore.get(ADMIN_REFRESH_COOKIE)?.value,
  })
}

function createAuthCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  }
}

export function setAdminSessionCookies(
  cookieTarget: CookieSetter,
  tokens: {
    accessToken: string
    refreshToken: string
  },
) {
  cookieTarget.set({
    name: ADMIN_ACCESS_COOKIE,
    value: tokens.accessToken,
    ...createAuthCookieOptions(getAdminAccessTokenTtlSeconds()),
  })
  cookieTarget.set({
    name: ADMIN_REFRESH_COOKIE,
    value: tokens.refreshToken,
    ...createAuthCookieOptions(getAdminRefreshTokenTtlSeconds()),
  })
}

export function refreshAdminAccessCookie(cookieTarget: CookieSetter, accessToken: string) {
  cookieTarget.set({
    name: ADMIN_ACCESS_COOKIE,
    value: accessToken,
    ...createAuthCookieOptions(getAdminAccessTokenTtlSeconds()),
  })
}

export function clearAdminSessionCookies(cookieTarget: CookieSetter) {
  cookieTarget.set({
    name: ADMIN_ACCESS_COOKIE,
    value: "",
    ...createAuthCookieOptions(0),
  })
  cookieTarget.set({
    name: ADMIN_REFRESH_COOKIE,
    value: "",
    ...createAuthCookieOptions(0),
  })
}

export function hashPassword(password: string) {
  const salt = randomBytes(16)
  const digest = scryptSync(password, salt, 64)
  return `scrypt$${salt.toString("base64")}$${digest.toString("base64")}`
}

export function verifyPassword(password: string, passwordHash: string) {
  const parts = passwordHash.split("$")
  if (parts.length !== 3 || parts[0] !== "scrypt") return false
  const saltRaw = parts[1]
  const hashRaw = parts[2]
  if (!saltRaw || !hashRaw) return false
  const salt = Buffer.from(saltRaw, "base64")
  const expected = Buffer.from(hashRaw, "base64")
  const actual = scryptSync(password, salt, expected.length)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
