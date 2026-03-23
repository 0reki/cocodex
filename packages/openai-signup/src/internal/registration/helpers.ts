import { AUTH_URL, CHATGPT_URL } from "../shared/runtime.ts";
import type { OAuthBootstrap, SignupSessionResult } from "../shared/types.ts";

export function decodeBase64UrlJson(input: string): any | null {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function findStringDeep(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const hit = findStringDeep(item, key);
      if (hit) return hit;
    }
    return undefined;
  }

  const record = data as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && direct.length > 0) return direct;

  for (const value of Object.values(record)) {
    const hit = findStringDeep(value, key);
    if (hit) return hit;
  }
  return undefined;
}

export function tryGetUrlParamDeep(
  data: unknown,
  param: string,
): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const hit = tryGetUrlParamDeep(item, param);
      if (hit) return hit;
    }
    return undefined;
  }

  const record = data as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (typeof value === "string") {
      try {
        const u = new URL(value);
        const p = u.searchParams.get(param);
        if (p) return p;
      } catch {}
    } else {
      const hit = tryGetUrlParamDeep(value, param);
      if (hit) return hit;
    }
  }
  return undefined;
}

export async function extractOAuthBootstrap(args: {
  createAccountResponseText: string;
  getCookieValue: (url: string, name: string) => Promise<string | null>;
}): Promise<OAuthBootstrap> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(args.createAccountResponseText);
  } catch {
    parsed = null;
  }

  let loginVerifier =
    findStringDeep(parsed, "login_verifier") ??
    tryGetUrlParamDeep(parsed, "login_verifier");

  let authSessionLoggingId =
    findStringDeep(parsed, "auth_session_logging_id") ??
    tryGetUrlParamDeep(parsed, "auth_session_logging_id");
  const continueUrl =
    findStringDeep(parsed, "continue_url") ?? findStringDeep(parsed, "url");

  if (!authSessionLoggingId) {
    const cookieVal = await args.getCookieValue(AUTH_URL, "oai-client-auth-session");
    if (cookieVal) {
      const payloadPart = cookieVal.split(".")[0] ?? "";
      const payload = decodeBase64UrlJson(payloadPart);
      if (payload && typeof payload === "object") {
        const fromCookie = (payload as Record<string, unknown>)[
          "auth_session_logging_id"
        ];
        if (typeof fromCookie === "string" && fromCookie.length > 0) {
          authSessionLoggingId = fromCookie;
        }
      }
    }
  }

  return { loginVerifier, authSessionLoggingId, continueUrl };
}

export function saveFinalSessionCookies(
  email: string,
  setCookies: string[],
): SignupSessionResult {
  const names = new Set([
    "__Secure-next-auth.session-token",
    "__Secure-next-auth.session-token.0",
    "__Secure-next-auth.session-token.1",
  ]);
  const sessionCookies: Record<string, string> = {};

  for (const cookie of setCookies) {
    const [pair] = cookie.split(";", 1);
    if (!pair) continue;
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1);
    if (names.has(name) || name.startsWith("__Secure-next-auth.session.")) {
      sessionCookies[name] = value;
    }
  }

  return {
    email,
    session_cookies: sessionCookies,
    captured_at: new Date().toISOString(),
  };
}

export function updateClientBuildFromHtml(args: {
  html: string;
  currentClientVersion: string;
  currentBuildNumber: string;
}) {
  const buildMatch = args.html.match(/<html[^>]*\sdata-build="([^"]+)"/i);
  const seqMatch = args.html.match(/<html[^>]*\sdata-seq="([^"]+)"/i);
  return {
    clientVersion: buildMatch?.[1]?.trim() || args.currentClientVersion,
    buildNumber: seqMatch?.[1]?.trim() || args.currentBuildNumber,
  };
}

export function normalizeTokenWithStableP(
  token: string,
  stableP: string | null,
): {
  token: string;
  p: string | null;
  patched: boolean;
  stableP: string | null;
} {
  try {
    const parsed = JSON.parse(token);
    const currentP = typeof parsed?.p === "string" ? parsed.p : null;
    if (!currentP) return { token, p: null, patched: false, stableP };

    if (!stableP) {
      return { token, p: currentP, patched: false, stableP: currentP };
    }

    if (currentP === stableP) {
      return { token, p: currentP, patched: false, stableP };
    }

    parsed.p = stableP;
    return {
      token: JSON.stringify(parsed),
      p: stableP,
      patched: true,
      stableP,
    };
  } catch {
    return { token, p: null, patched: false, stableP };
  }
}

export function extractIdFromSentinelToken(token: string): string | null {
  try {
    const parsed = JSON.parse(token);
    return typeof parsed?.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

export function getBuildId(clientVersion: string): string {
  const match = clientVersion.match(/[a-f0-9]{12,}/i);
  if (match?.[0]) return match[0].slice(0, 12);
  return globalThis.crypto.getRandomValues(new Uint8Array(6))
    .reduce((acc, byte) => acc + byte.toString(16).padStart(2, "0"), "");
}

export async function getNextAuthCsrfToken(args: {
  getCookieValue: (url: string, name: string) => Promise<string | null>;
}): Promise<string | null> {
  const raw = await args.getCookieValue(
    CHATGPT_URL,
    "__Host-next-auth.csrf-token",
  );
  if (!raw) return null;
  const decoded = decodeURIComponent(raw);
  const token = decoded.split("|")[0];
  return token || null;
}
