import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  disableOpenAIAccountByEmail,
  ensureDatabaseSchema,
  getSystemSettings,
  listOpenAIAccountsPage,
  updateOpenAIAccountAccessTokenById,
  updateOpenAIAccountRateLimitById,
} from "@workspace/database";
import { getAccessToken, getWhamUsage } from "@workspace/openai-api";

function loadEnvFile(filePath: string, overwrite = false) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (overwrite || !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function loadEnv() {
  const cwd = process.cwd();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const backendDir = path.resolve(here, "..");
  const rootDir = path.resolve(backendDir, "..", "..");

  // Base defaults from repo root.
  loadEnvFile(path.join(rootDir, ".env.local"), false);
  loadEnvFile(path.join(rootDir, ".env"), false);
  // Backend-specific values override root defaults.
  loadEnvFile(path.join(backendDir, ".env.local"), true);
  loadEnvFile(path.join(backendDir, ".env"), true);
  // Keep cwd values as opt-in fallback only.
  loadEnvFile(path.join(cwd, ".env.local"));
  loadEnvFile(path.join(cwd, ".env"));
}

function normalizeLocalDbSslMode() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const sslMode = (process.env.PG_SSL_MODE ?? "").toLowerCase();
  if (sslMode !== "require") return;

  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname;
    const isLocal =
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLocal) return;
    process.env.PG_SSL_MODE = "disable";
    console.warn(
      "[rate-limit] PG_SSL_MODE=require with local DATABASE_URL; forcing disable for this script.",
    );
  } catch {
    // Ignore invalid URL; existing DB logic will surface a clearer error.
  }
}

function isTokenInvalidatedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    /\bHTTP\s+401\b/i.test(message) && message.includes("token_invalidated")
  );
}

function isWorkspaceDeactivatedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    /\bHTTP\s+402\b/i.test(message) &&
    message.toLowerCase().includes("deactivated_workspace")
  );
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payloadPart = parts[1];
  if (!payloadPart) return null;
  const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getAccessTokenExp(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const expRaw = payload.exp;
  if (typeof expRaw === "number" && Number.isFinite(expRaw)) {
    return Math.trunc(expRaw);
  }
  if (typeof expRaw === "string") {
    const parsed = Number(expRaw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function getSessionTokenFromCookieMap(
  cookies: Record<string, string | undefined> | undefined,
): string | null {
  if (!cookies || typeof cookies !== "object") return null;
  const direct = cookies["__Secure-next-auth.session-token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const chunks = Object.entries(cookies)
    .filter(([name]) => name.startsWith("__Secure-next-auth.session-token."))
    .map(([name, value]) => {
      const index = Number(name.split(".").pop() ?? "");
      return {
        index: Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER,
        value: typeof value === "string" ? value : "",
      };
    })
    .sort((a, b) => a.index - b.index)
    .map((item) => item.value)
    .filter((item) => item.length > 0);
  if (chunks.length === 0) return null;
  return chunks.join("");
}

async function main() {
  const defaultUserAgent =
    process.env.OPENAI_API_USER_AGENT?.trim() || "node/22.14.0";
  loadEnv();
  normalizeLocalDbSslMode();
  await ensureDatabaseSchema();
  const settings = await getSystemSettings();
  const userAgent = settings?.openaiApiUserAgent?.trim() || defaultUserAgent;

  const pageSize = 100;
  const configuredConcurrency = Number(
    process.env.RATE_LIMIT_SYNC_CONCURRENCY ?? 10,
  );
  const concurrency = Number.isFinite(configuredConcurrency)
    ? Math.max(1, Math.min(100, Math.floor(configuredConcurrency)))
    : 10;
  let page = 1;
  let total = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let disabled = 0;
  const startedAt = Date.now();
  let lastProgressLogAt = 0;

  function logProgress(force = false) {
    const now = Date.now();
    if (!force && now - lastProgressLogAt < 1500) return;
    lastProgressLogAt = now;
    const elapsedMs = now - startedAt;
    console.log(
      `[rate-limit] progress total=${total} updated=${updated} skipped=${skipped} failed=${failed} elapsed=${Math.round(
        elapsedMs / 1000,
      )}s disabled=${disabled}`,
    );
  }

  console.log(
    `[rate-limit] sync started pageSize=${pageSize} concurrency=${concurrency} ua=${userAgent}`,
  );

  while (true) {
    console.log(`[rate-limit] scanning page=${page} size=${pageSize}`);
    const data = await listOpenAIAccountsPage(page, pageSize);
    if (data.items.length === 0) break;

    async function processAccount(account: {
      id: string;
      email: string;
      userId: string | null;
      accountId: string | null;
      accessToken: string | null;
      sessionToken: string | null;
    }) {
      total += 1;
      let accessToken = account.accessToken?.trim() ?? "";
      const accountId = (account.accountId ?? account.userId ?? "").trim();
      if (!accessToken || !accountId) {
        skipped += 1;
        logProgress();
        return;
      }

      try {
        const usage = await getWhamUsage({
          accessToken,
          accountId,
          userAgent,
        });
        const rateLimit = usage.rate_limit ?? null;
        await updateOpenAIAccountRateLimitById(account.id, rateLimit);
        updated += 1;
        logProgress();
      } catch (error) {
        if (isWorkspaceDeactivatedError(error)) {
          await disableOpenAIAccountByEmail(account.email);
          disabled += 1;
          console.warn(
            `[rate-limit] disabled ${account.email}: deactivated workspace`,
          );
          logProgress();
          return;
        }
        if (isTokenInvalidatedError(error)) {
          const exp = getAccessTokenExp(accessToken);
          const nowSec = Math.floor(Date.now() / 1000);

          const disableWithReason = async (reason: string) => {
            await disableOpenAIAccountByEmail(account.email);
            disabled += 1;
            console.warn(`[rate-limit] disabled ${account.email}: ${reason}`);
            logProgress();
          };

          // Policy: only exp < now can refresh. Others disable directly.
          if (exp === null || exp >= nowSec) {
            await disableWithReason(`exp policy rejected refresh.`);
            return;
          }

          const sessionToken = account.sessionToken?.trim() ?? "";
          if (!sessionToken) {
            await disableWithReason("missing session token for refresh");
            return;
          }

          try {
            const refreshed = await getAccessToken({
              sessionToken,
              userAgent,
            });
            const refreshedSession =
              refreshed.session && typeof refreshed.session === "object"
                ? refreshed.session
                : null;
            if (
              refreshedSession &&
              Object.keys(refreshedSession).length === 0
            ) {
              await disableWithReason(
                "refresh endpoint returned empty JSON object",
              );
              return;
            }
            const refreshedAccessToken =
              typeof refreshed.accessToken === "string"
                ? refreshed.accessToken.trim()
                : "";
            if (!refreshedAccessToken) {
              await disableWithReason("refresh did not return access token");
              return;
            }

            await updateOpenAIAccountAccessTokenById(
              account.id,
              refreshedAccessToken,
            );
            const refreshedSessionToken = getSessionTokenFromCookieMap(
              refreshed.sessionTokenCookies,
            );
            if (refreshedSessionToken) {
              account.sessionToken = refreshedSessionToken;
            }
            accessToken = refreshedAccessToken;

            try {
              const usageAfterRefresh = await getWhamUsage({
                accessToken: refreshedAccessToken,
                accountId,
                userAgent,
              });
              const rateLimit = usageAfterRefresh.rate_limit ?? null;
              await updateOpenAIAccountRateLimitById(
                account.id,
                rateLimit,
              );
              updated += 1;
              logProgress();
              return;
            } catch (retryError) {
              if (isTokenInvalidatedError(retryError)) {
                await disableWithReason(
                  "token still invalidated after refresh",
                );
                return;
              }
              throw retryError;
            }
          } catch (refreshError) {
            failed += 1;
            const message =
              refreshError instanceof Error
                ? refreshError.message
                : String(refreshError);
            console.warn(
              `[rate-limit] refresh failed for ${account.email}: ${message}`,
            );
            logProgress();
            return;
          }
        }

        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[rate-limit] failed for ${account.email}: ${message}`);
        logProgress();
      }
    }

    let index = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, data.items.length) },
      async () => {
        while (true) {
          const current = index;
          index += 1;
          if (current >= data.items.length) return;
          const account = data.items[current];
          if (!account) return;
          await processAccount(account);
        }
      },
    );
    await Promise.all(workers);

    if (data.items.length < pageSize) break;
    page += 1;
  }

  logProgress(true);

  console.log(
    JSON.stringify(
      {
        ok: true,
        total,
        updated,
        skipped,
        failed,
        disabled,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exit(1);
});
