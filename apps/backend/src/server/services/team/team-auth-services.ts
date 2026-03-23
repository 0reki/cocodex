import * as openaiApiModule from "@workspace/openai-api";
import { CloudMailClient } from "@workspace/cloud-mail";
import { CodexAuthClient, createPkceAuthRequest } from "@workspace/openai-codex-auth";

type CloudMailInboxClient = {
  initialize(email: string): Promise<void>;
  snapshot(email: string): Promise<{ fingerprints: Set<string> }>;
  waitForOtp(
    email: string,
    timeoutMs?: number,
    pollIntervalMs?: number,
    snapshot?: { fingerprints: Set<string> },
  ): Promise<string>;
};

export function createTeamAuthServices(deps: {
  authUserAgent: string;
  getSystemSettings: () => Promise<{
    ownerMailDomains?: unknown[] | null;
    cloudMailDomains?: unknown[] | null;
  } | null>;
  refreshAccessTokenByRefreshTokenExternal?: (args: {
    refreshToken: string;
    userAgent?: string;
  }) => Promise<{ accessToken: string; refreshToken?: string | null }>;
}) {
  function createCloudMailInbox(): CloudMailInboxClient {
    const cloudMail = new CloudMailClient();
    let minEmailId = 0;
    let initializedEmail: string | null = null;

    return {
      async initialize(email: string) {
        const normalized = email.trim().toLowerCase();
        if (!normalized) {
          throw new Error("Cloud mail initialize requires email");
        }
        initializedEmail = normalized;
        try {
          minEmailId = await cloudMail.getMaxEmailId(normalized);
        } catch {
          minEmailId = 0;
        }
      },
      async snapshot(email: string) {
        const normalized = email.trim().toLowerCase();
        if (!initializedEmail || initializedEmail !== normalized) {
          await this.initialize(normalized);
        }
        return {
          fingerprints: new Set([String(minEmailId)]),
        };
      },
      async waitForOtp(
        email: string,
        timeoutMs = 30_000,
        pollIntervalMs = 1_000,
      ) {
        const normalized = email.trim().toLowerCase();
        if (!initializedEmail || initializedEmail !== normalized) {
          await this.initialize(normalized);
        }
        return cloudMail.waitForOpenAiOtp({
          accountEmail: normalized,
          timeoutMs,
          pollIntervalMs,
          minEmailId,
          createdAfterMs: Date.now(),
        });
      },
    };
  }

  function randomWorkspaceName(seed: string) {
    const cleaned = seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "Team";
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${cleaned}_${suffix}`;
  }

  async function refreshAccessTokenByRefreshToken(params: {
    refreshToken: string;
    userAgent?: string;
  }) {
    if (deps.refreshAccessTokenByRefreshTokenExternal) {
      return deps.refreshAccessTokenByRefreshTokenExternal(params);
    }
    const response = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": params.userAgent || deps.authUserAgent,
      },
      body: JSON.stringify({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: params.refreshToken,
        scope: "openid profile email",
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `refresh_token refresh failed: HTTP ${response.status}${text ? ` ${text}` : ""}`,
      );
    }
    const token = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!token.access_token) {
      throw new Error("refresh_token refresh failed: missing access_token");
    }
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
    };
  }

  function createRandomDomainPicker(domains: string[]) {
    const availableDomains = domains
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (availableDomains.length === 0) {
      throw new Error("No available domains configured");
    }
    let shuffled = [...availableDomains];
    let cursor = 0;
    const shuffleInPlace = <T>(items: T[]) => {
      for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = items[i]!;
        items[i] = items[j]!;
        items[j] = tmp;
      }
    };
    shuffleInPlace(shuffled);
    return () => {
      if (cursor >= shuffled.length) {
        shuffled = [...availableDomains];
        shuffleInPlace(shuffled);
        cursor = 0;
      }
      const domain = shuffled[cursor];
      if (!domain) throw new Error("No available domains configured");
      cursor += 1;
      return domain;
    };
  }

  async function exchangeCodexRefreshToken(options: {
    email: string;
    password: string;
    ensureNotStopped?: () => void;
    preferredWorkspaceId?: string | null;
  }): Promise<{
    refreshToken: string;
    workspaceId: string | null;
  }> {
    const createLoginOtpWaiter = async () => {
      const normalizedEmail = options.email.trim().toLowerCase();
      const [, domain = ""] = normalizedEmail.split("@");
      const settings = await deps.getSystemSettings();
      const supportedDomains = new Set(
        [
          ...(settings?.ownerMailDomains ?? []),
          ...(settings?.cloudMailDomains ?? []),
        ]
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item.length > 0),
      );
      if (supportedDomains.has(domain)) {
        const inbox = createCloudMailInbox();
        await inbox.initialize(normalizedEmail);
        return {
          waitForOtp: (timeoutMs = 30_000, pollIntervalMs = 1_000) =>
            inbox.waitForOtp(normalizedEmail, timeoutMs, pollIntervalMs),
        };
      }

      return null;
    };
    const maxAttempts = 3;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        options.ensureNotStopped?.();
        console.info(
          `[team-auth] codex-oauth start email=${options.email} attempt=${attempt}/${maxAttempts}`,
        );
        const pkce = createPkceAuthRequest({
          originator: "codex_cli_rs",
        });
        const client = new CodexAuthClient({
          userAgent: deps.authUserAgent,
        });
        const tryGetSentinelToken = async (flows: string[]) => {
          for (const flow of flows) {
            try {
              const result = await client.getSentinelToken(flow);
              if (typeof result.token === "string" && result.token.trim()) {
                return result.token.trim();
              }
            } catch {
              continue;
            }
          }
          return null;
        };
        const visitContinueUrl = async (value: unknown) => {
          if (typeof value !== "string" || !value.trim()) return;
          await client.visitPage(value.trim());
        };

        await client.initializeAuthorizeSession(pkce.authorizationUrl);
        const authorizeSentinelToken = await tryGetSentinelToken([
          "oauth_login",
          "oauth_authorize",
          "oauth_create_account",
        ]);
        const authorizeStep = await client.authorizeContinue({
          email: options.email,
          ...(authorizeSentinelToken
            ? { sentinelToken: authorizeSentinelToken }
            : {}),
        });
        await visitContinueUrl(authorizeStep.continue_url);
        const loginOtpWaiter = await createLoginOtpWaiter();
        const passwordSentinelToken = await tryGetSentinelToken([
          "username_password_login",
          "username_password",
          "username_password_create",
        ]);
        const verifyStep = await client.verifyPassword(options.password, {
          ...(typeof authorizeStep.continue_url === "string" &&
          authorizeStep.continue_url.trim()
            ? { referer: authorizeStep.continue_url.trim() }
            : {}),
          ...(passwordSentinelToken ? { sentinelToken: passwordSentinelToken } : {}),
        });
        await visitContinueUrl(verifyStep.continue_url);

        const verifyContinueUrl =
          typeof verifyStep.continue_url === "string"
            ? verifyStep.continue_url.trim()
            : "";
        if (
          verifyContinueUrl.includes("/email-verification") &&
          typeof client.validateEmailOtp === "function"
        ) {
          if (!loginOtpWaiter) {
            throw new Error(
              `Email verification required for ${options.email}, but no OTP mailbox provider matched this domain`,
            );
          }
          const otp = await loginOtpWaiter.waitForOtp();
          const emailOtpStep = await client.validateEmailOtp(otp, {
            referer: verifyContinueUrl,
          });
          await visitContinueUrl(emailOtpStep.continue_url);
        }

        let workspaceId: string | null = null;
        if (typeof client.getAccountsCheckWorkspaces === "function") {
          try {
            const accountsCheckWorkspaces = await client.getAccountsCheckWorkspaces({
              timezoneOffsetMin: -480,
            });
            const preferredWorkspaceId = options.preferredWorkspaceId?.trim() || null;
            if (preferredWorkspaceId) {
              workspaceId =
                accountsCheckWorkspaces.find(
                  (item: any) => item.workspaceId?.trim() === preferredWorkspaceId,
                )?.workspaceId?.trim() ?? null;
            }
            if (!workspaceId && typeof client.selectPreferredWorkspaceId === "function") {
              workspaceId = client.selectPreferredWorkspaceId(accountsCheckWorkspaces);
            } else if (
              !workspaceId &&
              typeof client.resolvePreferredWorkspaceIdBeforeConsent === "function"
            ) {
              workspaceId = await client.resolvePreferredWorkspaceIdBeforeConsent({
                timezoneOffsetMin: -480,
              });
            }
          } catch {
            workspaceId = null;
          }
        }
        if (!workspaceId) {
          const workspaces = await client.extractWorkspacesFromAuthSessionCookie();
          const preferredWorkspaceId = options.preferredWorkspaceId?.trim() || null;
          const preferredAuthWorkspace =
            (preferredWorkspaceId
              ? workspaces.find(
                  (item: any) =>
                    typeof item.id === "string" &&
                    item.id.trim() === preferredWorkspaceId,
                )
              : null) ??
            workspaces.find(
              (item: any) =>
                typeof item.id === "string" &&
                item.id.trim().length > 0 &&
                item.kind === "organization",
            ) ??
            workspaces.find(
              (item: any) => typeof item.id === "string" && item.id.trim().length > 0,
            ) ??
            null;
          workspaceId =
            preferredAuthWorkspace && typeof preferredAuthWorkspace.id === "string"
              ? preferredAuthWorkspace.id.trim()
              : null;
        }
        if (!workspaceId) {
          throw new Error("No workspace found during codex auth");
        }

        const workspaceStep = await client.selectWorkspace(workspaceId);
        const externalUrl =
          typeof workspaceStep.continue_url === "string"
            ? workspaceStep.continue_url.trim()
            : "";
        if (!externalUrl) {
          throw new Error("Codex auth did not return continue_url");
        }
        const callback = await client.resolveCallbackFromExternalUrl(externalUrl, {
          expectedState: pkce.state,
        });
        const tokens = await client.exchangeToken({
          code: callback.code,
          codeVerifier: pkce.codeVerifier,
        });
        const refreshToken =
          typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : "";
        if (!refreshToken) {
          throw new Error("Codex auth did not return refresh_token");
        }
        console.info(
          `[team-auth] codex-oauth done email=${options.email} attempt=${attempt}/${maxAttempts}`,
        );
        return { refreshToken, workspaceId };
      } catch (error) {
        lastError = error;
        console.warn(
          `[team-auth] codex-oauth retry email=${options.email} attempt=${attempt}/${maxAttempts} reason=${error instanceof Error ? error.message : String(error)}`,
        );
        if (attempt >= maxAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  function getOpenAIApiAccountHelpers() {
    return openaiApiModule;
  }

  async function loadTeamAccountMetadata(params: {
    accessToken: string;
    email?: string | null;
    targetAccountId?: string | null;
    logPrefix?: string;
  }) {
    const openaiApiModule = getOpenAIApiAccountHelpers();
    if (
      typeof openaiApiModule.getAccountsCheckV4 !== "function" ||
      typeof openaiApiModule.extractPrimaryAccountInfo !== "function" ||
      typeof openaiApiModule.getSubscription !== "function"
    ) {
      throw new Error("OpenAI account helpers are not exported from @workspace/openai-api");
    }
    const accountsCheck = await openaiApiModule.getAccountsCheckV4({
      accessToken: params.accessToken,
      timezoneOffsetMin: -480,
      userAgent: deps.authUserAgent,
    });
    const primary = openaiApiModule.extractPrimaryAccountInfo(accountsCheck);
    const accounts =
      accountsCheck && typeof accountsCheck === "object"
        ? ((accountsCheck.accounts as Record<string, Record<string, unknown>> | undefined) ?? {})
        : {};
    const selectedAccountKey =
      params.targetAccountId && params.targetAccountId in accounts
        ? params.targetAccountId
        : primary?.accountKey && primary.accountKey in accounts
          ? primary.accountKey
          : null;
    const primaryNode = selectedAccountKey ? accounts[selectedAccountKey] ?? null : null;
    const accountId =
      ((primaryNode?.account as Record<string, unknown> | undefined)?.account_id as
        | string
        | null
        | undefined) ??
      selectedAccountKey ??
      primary?.accountId ??
      null;
    const workspaceName =
      ((primaryNode?.account as Record<string, unknown> | undefined)?.name as
        | string
        | null
        | undefined) ?? null;
    const me =
      accountId && typeof openaiApiModule.getMe === "function"
        ? await openaiApiModule.getMe({
            accessToken: params.accessToken,
            accountId,
            userAgent: deps.authUserAgent,
          })
        : null;
    const subscription =
      accountId
        ? await openaiApiModule.getSubscription({
            accessToken: params.accessToken,
            accountId,
            userAgent: deps.authUserAgent,
          })
        : null;
    return {
      userId: me?.id ?? null,
      name: me?.name ?? null,
      accountId,
      workspaceName,
      teamMemberCount:
        typeof subscription?.seats_in_use === "number"
          ? Math.max(0, Math.trunc(subscription.seats_in_use))
          : null,
      planType: primary?.planType ?? null,
      teamExpiresAt: primary?.expiresAt ?? null,
      workspaceIsDeactivated: Boolean(primary?.workspaceIsDeactivated),
      workspaceCancelledAt: primary?.cancelsAt ?? null,
    };
  }

  return {
    createCloudMailInbox,
    randomWorkspaceName,
    refreshAccessTokenByRefreshToken,
    createRandomDomainPicker,
    exchangeCodexRefreshToken,
    getOpenAIApiAccountHelpers,
    loadTeamAccountMetadata,
  };
}
