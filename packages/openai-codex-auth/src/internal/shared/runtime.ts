import crypto from "node:crypto"
import { CookieJar as ToughCookieJar } from "tough-cookie"
import { Agent, fetch as undiciFetch } from "undici"
import type { CookieJarLike } from "./types.ts"

type CookieJarCtor = new (...args: unknown[]) => CookieJarLike

type HeaderLike = {
  get: (name: string) => string | null
  getSetCookie?: () => string[]
}

export const CookieJar = ToughCookieJar as unknown as CookieJarCtor
export { Agent, undiciFetch }

export const AUTH_BASE_URL = "https://auth.openai.com"
export const CHATGPT_BASE_URL = "https://chatgpt.com"
export const SENTINEL_BASE_URL = "https://sentinel.openai.com"
export const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback"
export const DEFAULT_SCOPE = "openid profile email offline_access"
export const DEFAULT_ORIGINATOR = "codex_cli_rs"
export const DEFAULT_USER_AGENT =
  "Apifox/1.0.0 (https://apifox.com)"

export function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

export function fromBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padding = (4 - (normalized.length % 4)) % 4
  return Buffer.from(normalized + "=".repeat(padding), "base64").toString(
    "utf8",
  )
}

export function getSetCookies(headers: HeaderLike): string[] {
  const withGetSetCookie = headers as unknown as {
    getSetCookie?: () => string[]
  }
  if (typeof withGetSetCookie.getSetCookie === "function") {
    return withGetSetCookie.getSetCookie() ?? []
  }
  const single = headers.get("set-cookie")
  return single ? [single] : []
}

export function formatRequestBody(body: RequestInit["body"]): string {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof FormData) return "[FormData]"
  if (body instanceof Blob) return `[Blob size=${body.size}]`
  return "[UnsupportedBodyType]"
}

export function headersInitToRecord(
  headersInit: HeadersInit | undefined,
): Record<string, string> {
  if (!headersInit) return {}

  if (headersInit instanceof Headers) {
    return Object.fromEntries(headersInit.entries())
  }

  if (Array.isArray(headersInit)) {
    return Object.fromEntries(
      headersInit.map(([key, value]) => [String(key), String(value)]),
    )
  }

  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headersInit)) {
    if (typeof value === "undefined") continue
    result[key] = String(value)
  }
  return result
}

export function describeFetchError(error: unknown, url: string): Error {
  if (error instanceof Error) {
    const details: string[] = []
    const record = error as Error & {
      cause?: unknown
      code?: string
      errno?: string | number
      syscall?: string
      address?: string
      port?: number
    }
    if (record.code) details.push(`code=${record.code}`)
    if (typeof record.errno !== "undefined") details.push(`errno=${String(record.errno)}`)
    if (record.syscall) details.push(`syscall=${record.syscall}`)
    if (record.address) details.push(`address=${record.address}`)
    if (typeof record.port === "number") details.push(`port=${String(record.port)}`)
    if (record.cause instanceof Error) {
      details.push(`cause=${record.cause.message}`)
    } else if (typeof record.cause !== "undefined") {
      details.push(`cause=${String(record.cause)}`)
    }
    return new Error(
      `Request to ${url} failed: ${error.message}${details.length > 0 ? ` (${details.join(", ")})` : ""}`,
    )
  }
  return new Error(`Request to ${url} failed: ${String(error)}`)
}

export function randomUuid(): string {
  return crypto.randomUUID()
}

export function randomHex(bytes = 6): string {
  return crypto.randomBytes(bytes).toString("hex")
}

export function randomBuffer(bytes: number): Buffer {
  return crypto.randomBytes(bytes)
}

export function sha256(input: string): Buffer {
  return crypto.createHash("sha256").update(input, "utf8").digest()
}
