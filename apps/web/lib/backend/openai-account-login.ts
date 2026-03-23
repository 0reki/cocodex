import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getTeamAccountLoginByEmail,
  upsertOpenAIAccount,
} from "@workspace/database";
import { CloudMailClient } from "@workspace/cloud-mail";
import {
  extractPrimaryAccountInfo,
  getWhamUsage,
} from "@workspace/openai-api/accounts";
import { CodexAuthClient } from "@workspace/openai-codex-auth/client";
import { createPkceAuthRequest } from "@workspace/openai-codex-auth/pkce";

type PendingLoginSession = {
  pkce: ReturnType<typeof createPkceAuthRequest>;
  email: string;
  password: string;
  createdAt: number;
  cookieHeaders: {
    auth: string;
    chatgpt: string;
    sentinel: string;
  };
};

type ActiveLoginSession = {
  client: CodexAuthClient;
  pkce: ReturnType<typeof createPkceAuthRequest>;
  email: string;
  password: string;
  createdAt: number;
};

type WorkspaceChoice = {
  id: string;
  name: string | null;
  kind: string | null;
  planType: string | null;
};

type SavedAccountSummary = {
  email: string;
  accountUserRole: string | null;
  planType: string | null;
  teamMemberCount: number | null;
};

function loginLog(step: string, details?: Record<string, unknown>) {
  const suffix =
    details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  console.info(`[accounts-login] ${step}${suffix}`);
}

function normalizeWhamRateLimitPayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const nested =
    payload.rate_limit && typeof payload.rate_limit === "object"
      ? (payload.rate_limit as Record<string, unknown>)
      : null;
  if (!nested) return null;
  return {
    ...nested,
    ...(payload.additional_rate_limits !== undefined
      ? { additional_rate_limits: payload.additional_rate_limits }
      : {}),
    ...(payload.code_review_rate_limit !== undefined
      ? { code_review_rate_limit: payload.code_review_rate_limit }
      : {}),
  };
}

const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;
const AUTH_BASE_URL = "https://auth.openai.com";
const CHATGPT_BASE_URL = "https://chatgpt.com";
const SENTINEL_BASE_URL = "https://sentinel.openai.com";
const LOGIN_SESSION_DIR = path.join(os.tmpdir(), "cocodex-openai-login");

function getLoginSessionPath(sessionId: string) {
  return path.join(LOGIN_SESSION_DIR, `${sessionId}.json`);
}

async function ensureLoginSessionDir() {
  await fs.mkdir(LOGIN_SESSION_DIR, { recursive: true });
}

async function persistPendingLoginSession(
  sessionId: string,
  session: PendingLoginSession,
) {
  await ensureLoginSessionDir();
  await fs.writeFile(
    getLoginSessionPath(sessionId),
    JSON.stringify(session),
    "utf8",
  );
}

async function loadPendingLoginSession(
  sessionId: string,
): Promise<PendingLoginSession | null> {
  try {
    const raw = await fs.readFile(getLoginSessionPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as PendingLoginSession;
    if (Date.now() - parsed.createdAt > LOGIN_SESSION_TTL_MS) {
      await deletePendingLoginSession(sessionId);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function deletePendingLoginSession(sessionId: string) {
  try {
    await fs.unlink(getLoginSessionPath(sessionId));
  } catch {}
}

async function cleanupExpiredSessions() {
  await ensureLoginSessionDir();
  const entries = await fs.readdir(LOGIN_SESSION_DIR).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const filePath = path.join(LOGIN_SESSION_DIR, name);
        try {
          const raw = await fs.readFile(filePath, "utf8");
          const parsed = JSON.parse(raw) as { createdAt?: number };
          if (
            typeof parsed.createdAt !== "number" ||
            now - parsed.createdAt > LOGIN_SESSION_TTL_MS
          ) {
            await fs.unlink(filePath).catch(() => {});
          }
        } catch {
          await fs.unlink(filePath).catch(() => {});
        }
      }),
  );
}

async function serializeClientCookies(client: CodexAuthClient) {
  const jar = client.getCookieJar();
  return {
    auth: await jar.getCookieString(AUTH_BASE_URL),
    chatgpt: await jar.getCookieString(CHATGPT_BASE_URL),
    sentinel: await jar.getCookieString(SENTINEL_BASE_URL),
  };
}

async function rehydrateLoginClient(session: PendingLoginSession) {
  const client = new CodexAuthClient();
  if (session.cookieHeaders.auth) {
    await client.seedCookiesFromHeader(session.cookieHeaders.auth, AUTH_BASE_URL);
  }
  if (session.cookieHeaders.chatgpt) {
    await client.seedCookiesFromHeader(
      session.cookieHeaders.chatgpt,
      CHATGPT_BASE_URL,
    );
  }
  if (session.cookieHeaders.sentinel) {
    await client.seedCookiesFromHeader(
      session.cookieHeaders.sentinel,
      SENTINEL_BASE_URL,
    );
  }
  return client;
}

async function tryGetSentinelToken(client: CodexAuthClient, flows: string[]) {
  for (const flow of flows) {
    try {
      const result = await client.getSentinelToken(flow);
      if (typeof result.token === "string" && result.token.trim()) {
        return result.token.trim();
      }
    } catch (error) {
      continue;
    }
  }
  return null;
}

async function visitContinueUrl(client: CodexAuthClient, value: unknown) {
  if (typeof value !== "string" || !value.trim()) return;
  await client.visitPage(value.trim());
}

async function resolveWorkspaceId(client: CodexAuthClient) {
  try {
    const accountsCheckWorkspaces = await client.getAccountsCheckWorkspaces({
      timezoneOffsetMin: -480,
    });
    const preferred = client.selectPreferredWorkspaceId(accountsCheckWorkspaces);
    if (preferred) return preferred;
  } catch {
    // Fall back to auth cookie parsing below.
  }

  const workspaces = await client.extractWorkspacesFromAuthSessionCookie();
  const preferredWorkspace =
    workspaces.find(
      (item: { id?: string; kind?: string }) =>
        typeof item.id === "string" &&
        item.id.trim().length > 0 &&
        item.kind === "organization",
    ) ??
    workspaces.find(
      (item: { id?: string }) =>
        typeof item.id === "string" && item.id.trim().length > 0,
    ) ??
    null;

  if (preferredWorkspace && typeof preferredWorkspace.id === "string") {
    return preferredWorkspace.id.trim();
  }
  throw new Error("No workspace found during account login");
}

async function listWorkspaceChoices(
  client: CodexAuthClient,
  accessToken?: string,
): Promise<WorkspaceChoice[]> {
  try {
    const workspaces = await client.getAccountsCheckWorkspaces({
      ...(accessToken ? { accessToken } : {}),
      timezoneOffsetMin: -480,
    });
    const normalized = workspaces
      .map((item) => ({
        id: item.workspaceId,
        name: item.workspaceName,
        kind: "organization",
        planType: item.planType,
      }))
      .filter((item) => item.id.trim().length > 0);
    if (normalized.length > 0) {
      return normalized;
    }
  } catch {}

  const workspaces = await client.extractWorkspacesFromAuthSessionCookie();
  return workspaces
    .map((item) => ({
      id: typeof item.id === "string" ? item.id.trim() : "",
      name: typeof item.name === "string" ? item.name : null,
      kind: typeof item.kind === "string" ? item.kind : null,
      planType: null,
    }))
    .filter((item) => item.id.length > 0);
}

async function saveOpenAIAccount(params: {
  client: CodexAuthClient;
  portalUserId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}) {
  loginLog("save-account:start", { email: params.email });
  const metadataAccessToken = params.accessToken.trim();
  if (!metadataAccessToken) {
    throw new Error("Missing accessToken from OAuth token exchange");
  }
  const accountsCheck = await params.client.getAccountsCheckV4Raw({
    accessToken: metadataAccessToken,
    timezoneOffsetMin: -480,
  });
  const primary = extractPrimaryAccountInfo(
    accountsCheck as Parameters<typeof extractPrimaryAccountInfo>[0],
  );
  const accountId = primary?.accountId ?? null;
  const me = accountId
    ? await params.client.getMeRaw({
        accessToken: metadataAccessToken,
        accountId,
      })
    : null;
  const subscription = accountId
    ? await params.client
        .getSubscriptionRaw({
          accessToken: metadataAccessToken,
          accountId,
        })
        .catch(() => null)
    : null;
  const rateLimit = accountId
    ? await getWhamUsage({
        accessToken: metadataAccessToken,
        accountId,
      }).catch(() => null)
    : null;

  await ensureDatabaseSchema();
  const saved = await upsertOpenAIAccount({
    portalUserId: params.portalUserId,
    email: params.email,
    password: params.password,
    accessToken: params.accessToken,
    refreshToken: params.refreshToken,
    userId: typeof me?.id === "string" ? me.id : null,
    name: typeof me?.name === "string" ? me.name : null,
    accountId,
    accountUserRole: primary?.accountUserRole ?? null,
    workspaceName: primary?.name ?? null,
    planType: primary?.planType ?? null,
    teamMemberCount:
      subscription && typeof subscription.seats_in_use === "number"
        ? Math.max(0, Math.trunc(subscription.seats_in_use))
        : null,
    teamExpiresAt: primary?.expiresAt ?? null,
    workspaceIsDeactivated: Boolean(primary?.workspaceIsDeactivated),
    workspaceCancelledAt: primary?.cancelsAt ?? null,
    status: primary?.workspaceIsDeactivated ? "disabled" : "active",
    type: "openai",
    cooldownUntil: null,
    rateLimit: normalizeWhamRateLimitPayload(
      rateLimit && typeof rateLimit === "object"
        ? (rateLimit as Record<string, unknown>)
        : null,
    ),
  });
  loginLog("save-account:done", {
    email: saved.email,
    planType: saved.planType,
    workspaceName: saved.workspaceName,
  });
  return {
    saved,
    summary: {
      email: saved.email,
      accountUserRole: saved.accountUserRole,
      planType: saved.planType,
      teamMemberCount:
        subscription && typeof subscription.seats_in_use === "number"
          ? Math.max(0, Math.trunc(subscription.seats_in_use))
          : null,
    } satisfies SavedAccountSummary,
  };
}

async function getCloudMailOtp(email: string) {
  loginLog("cloud-mail-otp:start", { email });
  const cloudMail = new CloudMailClient();
  const otp = await cloudMail.waitForOpenAiOtp({
    accountEmail: email,
    toEmail: email,
    senderContains: "openai",
    subjectIncludes: ["chatgpt", "openai", "code", "验证码", "代码"],
    timeoutMs: 120_000,
    pollIntervalMs: 2_500,
  });
  loginLog("cloud-mail-otp:done", { email });
  return otp;
}

async function finalizeLogin(
  session: ActiveLoginSession,
  portalUserId: string,
  workspaceId?: string,
) {
  loginLog("finalize:start", {
    email: session.email,
    hasWorkspaceId: Boolean(workspaceId?.trim()),
  });
  const resolvedWorkspaceId =
    typeof workspaceId === "string" && workspaceId.trim()
      ? workspaceId.trim()
      : await resolveWorkspaceId(session.client);
  loginLog("finalize:workspace-resolved", {
    email: session.email,
    workspaceId: resolvedWorkspaceId,
  });
  const workspaceStep = await session.client.selectWorkspace(resolvedWorkspaceId);
  const externalUrl =
    typeof workspaceStep.continue_url === "string"
      ? workspaceStep.continue_url.trim()
      : "";
  if (!externalUrl) {
    throw new Error("OpenAI auth did not return continue_url");
  }

  const callback = await session.client.resolveCallbackFromExternalUrl(externalUrl, {
    expectedState: session.pkce.state,
  });
  loginLog("finalize:callback-resolved", { email: session.email });
  const tokens = await session.client.exchangeToken({
    code: callback.code,
    codeVerifier: session.pkce.codeVerifier,
  });
  loginLog("finalize:token-exchanged", { email: session.email });

  const refreshToken =
    typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : "";
  const accessToken =
    typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  if (!refreshToken || !accessToken) {
    throw new Error("OpenAI auth did not return required tokens");
  }

  return saveOpenAIAccount({
    client: session.client,
    portalUserId,
    email: session.email,
    password: session.password,
    accessToken,
    refreshToken,
  });
}

export async function startOpenAIAccountLogin(params: {
  portalUserId: string;
  email: string;
  password: string;
}) {
  loginLog("start-login:start", { email: params.email.trim().toLowerCase() });
  await cleanupExpiredSessions();

  const email = params.email.trim().toLowerCase();
  const password = params.password.trim();
  if (!email) throw new Error("email is required");
  if (!password) throw new Error("password is required");

  const pkce = createPkceAuthRequest({
    originator: "codex_cli_rs",
  });
  const client = new CodexAuthClient();

  loginLog("start-login:initialize-authorize-session", { email });
  await client.initializeAuthorizeSession(pkce.authorizationUrl);
  loginLog("start-login:initialize-authorize-session:done", { email });

  loginLog("start-login:get-authorize-sentinel", { email });
  const authorizeSentinelToken = await tryGetSentinelToken(client, [
    "oauth_login",
    "oauth_authorize",
    "oauth_create_account",
  ]);
  loginLog("start-login:get-authorize-sentinel:done", {
    email,
    hasToken: Boolean(authorizeSentinelToken),
  });
  if (!authorizeSentinelToken) {
    throw new Error(
      "Failed to acquire OpenAI authorize sentinel token; aborting before authorize-continue",
    );
  }
  loginLog("start-login:authorize-continue", { email });
  const authorizeStep = await client.authorizeContinue({
    email,
    sentinelToken: authorizeSentinelToken,
  });
  loginLog("start-login:authorize-continue:done", { email });
  await visitContinueUrl(client, authorizeStep.continue_url);
  loginLog("start-login:visit-authorize-continue-url:done", { email });

  loginLog("start-login:get-password-sentinel", { email });
  const passwordSentinelToken = await tryGetSentinelToken(client, [
    "username_password_login",
    "username_password",
    "username_password_create",
  ]);
  loginLog("start-login:get-password-sentinel:done", {
    email,
    hasToken: Boolean(passwordSentinelToken),
  });
  if (!passwordSentinelToken) {
    throw new Error(
      "Failed to acquire OpenAI password sentinel token; aborting before verify-password",
    );
  }
  loginLog("start-login:verify-password", { email });
  const verifyStep = await client.verifyPassword(password, {
    ...(typeof authorizeStep.continue_url === "string" &&
    authorizeStep.continue_url.trim()
      ? { referer: authorizeStep.continue_url.trim() }
      : {}),
    sentinelToken: passwordSentinelToken,
  });
  loginLog("start-login:verify-password:done", { email });
  await visitContinueUrl(client, verifyStep.continue_url);
  loginLog("start-login:visit-verify-continue-url:done", { email });

  const continueUrl =
    typeof verifyStep.continue_url === "string"
      ? verifyStep.continue_url.trim()
      : "";
  if (continueUrl.includes("/email-verification")) {
    loginLog("start-login:requires-otp", { email });
    const sessionId = randomUUID();
    await persistPendingLoginSession(sessionId, {
      pkce,
      email,
      password,
      createdAt: Date.now(),
      cookieHeaders: await serializeClientCookies(client),
    });
    return {
      requiresOtp: true,
      sessionId,
    };
  }

  const workspaceChoices = await listWorkspaceChoices(client);
  loginLog("start-login:workspace-choices", {
    email,
    count: workspaceChoices.length,
  });
  if (workspaceChoices.length > 1) {
    const sessionId = randomUUID();
    await persistPendingLoginSession(sessionId, {
      pkce,
      email,
      password,
      createdAt: Date.now(),
      cookieHeaders: await serializeClientCookies(client),
    });
    return {
      requiresOtp: false,
      requiresWorkspace: true,
      sessionId,
      workspaces: workspaceChoices,
    };
  }

  const saved = await finalizeLogin(
    {
      client,
      pkce,
      email,
      password,
      createdAt: Date.now(),
    },
    params.portalUserId,
  );
  return {
    requiresOtp: false,
    account: saved.summary,
  };
}

export async function startStoredOpenAIAccountLogin(params: {
  portalUserId: string;
  email: string;
  systemCreatedHint?: boolean;
}) {
  const email = params.email.trim().toLowerCase();
  loginLog("start-stored-login:start", {
    email,
    systemCreatedHint: params.systemCreatedHint === true,
  });
  if (!email) throw new Error("email is required");

  await ensureDatabaseSchema();
  const account = await getTeamAccountLoginByEmail(email);
  if (!account) {
    throw new Error("account not found");
  }
  if (account.portalUserId !== params.portalUserId) {
    throw new Error("forbidden");
  }
  loginLog("start-stored-login:loaded-account", {
    email,
    systemCreated: account.systemCreated,
    hasPassword: Boolean(account.password?.trim()),
  });
  const password = typeof account.password === "string" ? account.password.trim() : "";
  if (!password) {
    throw new Error("stored password is missing");
  }
  const result = await startOpenAIAccountLogin({
    portalUserId: params.portalUserId,
    email,
    password,
  });

  if (
    (account.systemCreated || params.systemCreatedHint === true) &&
    result &&
    typeof result === "object" &&
    "requiresOtp" in result &&
    result.requiresOtp === true &&
    typeof result.sessionId === "string" &&
    result.sessionId.trim()
  ) {
    loginLog("start-stored-login:auto-otp", { email });
    const code = await getCloudMailOtp(email);
    loginLog("start-stored-login:auto-otp:verify", { email });
    return verifyOpenAIAccountOtp({
      portalUserId: params.portalUserId,
      sessionId: result.sessionId,
      code,
    });
  }

  return result;
}

export async function verifyOpenAIAccountOtp(params: {
  portalUserId: string;
  sessionId: string;
  code: string;
}) {
  loginLog("verify-otp:start", { sessionId: params.sessionId });
  await cleanupExpiredSessions();
  const session = await loadPendingLoginSession(params.sessionId);
  if (!session) {
    throw new Error("login session expired");
  }

  const client = await rehydrateLoginClient(session);
  loginLog("verify-otp:rehydrated", { email: session.email });
  await client.validateEmailOtp(params.code, {
    referer: "https://auth.openai.com/email-verification",
  });
  loginLog("verify-otp:validated", { email: session.email });
  const workspaceChoices = await listWorkspaceChoices(client);
  loginLog("verify-otp:workspace-choices", {
    email: session.email,
    count: workspaceChoices.length,
  });
  if (workspaceChoices.length > 1) {
    await persistPendingLoginSession(params.sessionId, {
      pkce: session.pkce,
      email: session.email,
      password: session.password,
      createdAt: session.createdAt,
      cookieHeaders: await serializeClientCookies(client),
    });
    return {
      requiresWorkspace: true,
      sessionId: params.sessionId,
      workspaces: workspaceChoices,
    };
  }
  const saved = await finalizeLogin(
    {
      client,
      pkce: session.pkce,
      email: session.email,
      password: session.password,
      createdAt: session.createdAt,
    },
    params.portalUserId,
  );
  await deletePendingLoginSession(params.sessionId);
  return {
    account: saved.summary,
  };
}

export async function completeOpenAIAccountLogin(params: {
  portalUserId: string;
  sessionId: string;
  workspaceId: string;
}) {
  loginLog("complete-login:start", {
    sessionId: params.sessionId,
    workspaceId: params.workspaceId,
  });
  await cleanupExpiredSessions();
  const session = await loadPendingLoginSession(params.sessionId);
  if (!session) {
    throw new Error("login session expired");
  }
  const client = await rehydrateLoginClient(session);
  const saved = await finalizeLogin(
    {
      client,
      pkce: session.pkce,
      email: session.email,
      password: session.password,
      createdAt: session.createdAt,
    },
    params.portalUserId,
    params.workspaceId,
  );
  await deletePendingLoginSession(params.sessionId);
  return {
    account: saved.summary,
  };
}
