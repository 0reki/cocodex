import crypto from "crypto";
import {
  buildAccountRecordFromSession,
  buildAccountRecordFromTokens,
} from "../account/account-builder.ts";
import { OpenAIRegistration } from "../registration/registration.ts";
import {
  closeDispatcherIfNeeded,
  createDispatcher,
  formatDuration,
  requestContextStorage,
} from "./runtime.ts";
import type { SignupMailProvider, SignupRunResult } from "./types.ts";
import { generateRandomProfile } from "../account/profile.ts";
import { CodexAuthClient } from "@workspace/openai-codex-auth/client";
import { createPkceAuthRequest } from "@workspace/openai-codex-auth/pkce";
import type { AccountsCheckWorkspace, Workspace } from "@workspace/openai-codex-auth/types";

const OTP_TIMEOUT_MS = 30000;
const OTP_POLL_INTERVAL_MS = 1000;
const MAX_FLOW_RETRIES = 10;
const MAX_SENTINEL_STEP_RETRIES = 3;

function unwrapErrorText(error: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = error;
  let depth = 0;
  while (cursor && depth < 5) {
    if (cursor instanceof Error) {
      parts.push(cursor.message);
      cursor = (cursor as { cause?: unknown }).cause;
      depth += 1;
      continue;
    }
    if (typeof cursor === "object" && cursor !== null) {
      const maybeCause = (cursor as { cause?: unknown }).cause;
      if (typeof maybeCause !== "undefined") {
        cursor = maybeCause;
        depth += 1;
        continue;
      }
    }
    parts.push(String(cursor));
    break;
  }
  return parts.join(" | ");
}

function isLikelyProxyError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("proxy") ||
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("http tunneling") ||
    lower.includes("und_err_aborted") ||
    lower.includes("terminated") ||
    lower.includes("timeout") ||
    lower.includes("aborted") ||
    lower.includes("socket hang up") ||
    lower.includes("other side closed")
  );
}

function isLikelyTransientNetworkError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("sentinel init timed out") ||
    lower.includes("sentinel token timed out") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("fetch failed") ||
    lower.includes("und_err_") ||
    lower.includes("terminated") ||
    lower.includes("timeout") ||
    lower.includes("aborted") ||
    lower.includes("socket hang up") ||
    lower.includes("other side closed")
  );
}

async function prepareRetryCheckpoint(
  mailProvider: SignupMailProvider,
  email: string,
  runId: number,
  total: number,
) {
  try {
    await mailProvider.prepareForRetry?.(email);
  } catch (error) {
    console.warn(
      `[Run ${runId}/${total}] prepareForRetry failed for ${email}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runSentinelStepWithRetry(
  reg: OpenAIRegistration,
  flow: string,
  runId: number,
  total: number,
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_SENTINEL_STEP_RETRIES; attempt += 1) {
    try {
      return await reg.stage2_Sentinel(flow);
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_SENTINEL_STEP_RETRIES) break;
      console.warn(
        `[Run ${runId}/${total}] sentinel-step retry flow=${flow} attempt=${attempt}/${MAX_SENTINEL_STEP_RETRIES} reason=${error instanceof Error ? error.message : String(error)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function recoverExistingAccountWithLogin(
  email: string,
  password: string,
  mailProvider: SignupMailProvider,
) {
  const pkce = createPkceAuthRequest({
    originator: "codex_cli_rs",
  });
  const client = new CodexAuthClient();

  const visitContinueUrl = async (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    await client.visitPage(value.trim());
  };

  const tryGetSentinelToken = async (flows: string[]) => {
    for (const flow of flows) {
      try {
        const result = await client.getSentinelToken(flow);
        if (typeof result.token === "string" && result.token.trim()) {
          return result.token.trim();
        }
      } catch {}
    }
    return null;
  };

  await client.initializeAuthorizeSession(pkce.authorizationUrl);
  const authorizeSentinelToken = await tryGetSentinelToken([
    "oauth_login",
    "oauth_authorize",
    "oauth_create_account",
  ]);
  const authorizeStep = await client.authorizeContinue({
    email,
    ...(authorizeSentinelToken ? { sentinelToken: authorizeSentinelToken } : {}),
  });
  await visitContinueUrl(authorizeStep.continue_url);

  const passwordSentinelToken = await tryGetSentinelToken([
    "username_password_login",
    "username_password",
    "username_password_create",
  ]);
  const verifyStep = await client.verifyPassword(password, {
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
  if (verifyContinueUrl.includes("/email-verification")) {
    const otp = await mailProvider.waitForOtp(email, OTP_TIMEOUT_MS, OTP_POLL_INTERVAL_MS);
    const emailOtpStep = await client.validateEmailOtp(otp, {
      referer: verifyContinueUrl,
    });
    await visitContinueUrl(emailOtpStep.continue_url);
  }

  const workspaceId =
    (await client
      .getAccountsCheckWorkspaces({
        timezoneOffsetMin: -480,
      })
      .then((workspaces: AccountsCheckWorkspace[]) =>
        client.selectPreferredWorkspaceId(workspaces),
      )
      .catch(() => null)) ??
    (await client
      .extractWorkspacesFromAuthSessionCookie()
      .then((workspaces: Workspace[]) => {
        const preferred =
          workspaces.find(
            (item: Workspace) =>
              typeof item.id === "string" &&
              item.id.trim().length > 0 &&
              item.kind === "organization",
          ) ??
          workspaces.find(
            (item: Workspace) =>
              typeof item.id === "string" && item.id.trim().length > 0,
          ) ??
          null;
        return preferred && typeof preferred.id === "string"
          ? preferred.id.trim()
          : null;
      })
      .catch(() => null));
  if (!workspaceId) {
    throw new Error("No workspace found during recovery login");
  }

  const workspaceStep = await client.selectWorkspace(workspaceId);
  const externalUrl =
    typeof workspaceStep.continue_url === "string"
      ? workspaceStep.continue_url.trim()
      : "";
  if (!externalUrl) {
    throw new Error("Recovery login did not return continue_url");
  }

  const callback = await client.resolveCallbackFromExternalUrl(externalUrl, {
    expectedState: pkce.state,
  });
  const tokens = await client.exchangeToken({
    code: callback.code,
    codeVerifier: pkce.codeVerifier,
  });
  const accessToken =
    typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  if (!accessToken) {
    throw new Error("Recovery login did not return access_token");
  }
  const refreshToken =
    typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : null;

  return buildAccountRecordFromTokens({
    email,
    password,
    accessToken,
    refreshToken,
  });
}

export async function runSingleFlow(
  runId: number,
  total: number,
  _allowManualOtp: boolean,
  proxyUrl?: string | null,
  proxyPool: string[] = [],
  mailProvider?: SignupMailProvider,
): Promise<SignupRunResult> {
  const startedAt = Date.now();
  let email = "<unknown>";
  let currentPassword = "";
  let retryEmail: string | null = null;
  let stage = "init";
  const proxyCandidates = Array.from(
    new Set([
      ...(typeof proxyUrl === "string" && proxyUrl.trim()
        ? [proxyUrl.trim()]
        : []),
      ...proxyPool.map((item) => item.trim()).filter((item) => item.length > 0),
      ...(proxyPool.length > 0 ? ["__DIRECT__"] : []),
    ]),
  );

  let attempts = 0;
  if (!mailProvider) {
    throw new Error("mailProvider must be configured explicitly");
  }

  while (attempts < MAX_FLOW_RETRIES) {
    attempts += 1;
    const attemptProxy =
      proxyCandidates.length > 0
        ? proxyCandidates[(attempts - 1) % proxyCandidates.length]
        : null;
    const resolvedProxy =
      attemptProxy === "__DIRECT__" ? null : (attemptProxy ?? null);

    const currentDispatcher = createDispatcher(resolvedProxy);
    const reg = new OpenAIRegistration();
    const activeMailProvider = mailProvider;

    try {
      return await requestContextStorage.run(
        {
          dispatcher: currentDispatcher,
          proxyUrl: resolvedProxy,
          runId,
          total,
        },
        async () => {
          console.log(
            `--- Run ${runId}/${total} Attempt ${attempts}/${MAX_FLOW_RETRIES}: OpenAI Registration State Machine ---`,
          );
          if (resolvedProxy) {
            console.log(`[Run ${runId}/${total}] proxy=${resolvedProxy}`);
          } else if (attemptProxy === "__DIRECT__") {
            console.log(`[Run ${runId}/${total}] proxy=direct`);
          }

          if (retryEmail) {
            email = retryEmail;
            console.log(`[Run ${runId}/${total}] reusing email=${email}`);
          } else {
            email = await activeMailProvider.generateEmail();
          }
          console.log(`[Run ${runId}/${total}] email=${email}`);
          stage = "stage0-nextauth";
          await reg.stage0_InitializeNextAuth(email);
          stage = "stage1-authorize";
          await reg.stage1_Initialize();
          stage = "stage2-sentinel-oauth_create_account";
          const { token: continueToken, p: continueP } =
            await runSentinelStepWithRetry(
              reg,
              "oauth_create_account",
              runId,
              total,
            );
          if (!continueP) {
            console.warn("[Config] Continue token did not expose p.");
          }
          stage = "stage3-verify";
          await reg.stage3_Verify(email, continueToken);

          const password = crypto.randomBytes(12).toString("base64") + "aA1!";
          currentPassword = password;
          stage = "stage2-sentinel-username_password_create";
          const { token, p } = await runSentinelStepWithRetry(
            reg,
            "username_password_create",
            runId,
            total,
          );
          if (!p) {
            console.warn("[Config] SDK token did not expose p.");
          }
          stage = "stage3-set-password";
          await reg.stage3_SetPassword(email, password, token);

          stage = "stage3-trigger-otp";
          await prepareRetryCheckpoint(activeMailProvider, email, runId, total);
          await reg.stage3_TriggerOTPSend();
          console.log("[Mail] Waiting for OTP email...");
          stage = "wait-otp";
          const otp = await activeMailProvider.waitForOtp(
            email,
            OTP_TIMEOUT_MS,
            OTP_POLL_INTERVAL_MS,
          );
          console.log("[Mail] OTP received.");
          console.log(`[Mail] OTP value for ${email}: ${otp}`);
          stage = "stage3-validate-otp";
          await reg.stage3_ValidateOTP(otp);

          const { name, birthdate } = generateRandomProfile();

          stage = "stage2-sentinel-create_account";
          const { token: createAccountToken, p: createAccountP } =
            await runSentinelStepWithRetry(
              reg,
              "create_account",
              runId,
              total,
            );
          if (!createAccountP) {
            console.warn("[Config] create_account token did not expose p.");
          }

          stage = "stage4-create-account";
          await reg.stage4_CreateAccount(
            name,
            birthdate,
            email,
            createAccountToken,
          );
          stage = "build-account-record";
          const sessionResult = reg.getFinalSessionResult();
          if (!sessionResult) {
            throw new Error("Missing final session cookies after signup flow");
          }
          const account = await buildAccountRecordFromSession(
            sessionResult,
            password,
          );

          const durationMs = Date.now() - startedAt;
          console.log(
            `--- Run ${runId}/${total} Completed in ${formatDuration(durationMs)} ---`,
          );
          console.log(
            `[Run ${runId}/${total}] summary ok=true email=${email} attempts=${attempts} stage=${stage}`,
          );
          return {
            runId,
            ok: true,
            email,
            durationMs,
            attempts,
            sessionResult,
            account,
          };
        },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const fullErrorText = unwrapErrorText(e);
      const isOtpTimeout =
        message.includes("Timed out waiting for OTP") ||
        message.includes("Auto OTP failed");
      const isWrongOtp =
        fullErrorText.toLowerCase().includes("wrong_email_otp_code") ||
        message.includes("OTP Validation failed");
      const isInvalidState =
        fullErrorText.toLowerCase().includes("invalid_state") ||
        message.includes("Password registration failed");
      const isUserAlreadyExists =
        fullErrorText.toLowerCase().includes("user_already_exists");
      const shouldReplaceEmail =
        email !== "<unknown>" &&
        stage !== "build-account-record" &&
        isInvalidState;
      const shouldReuseEmail =
        email !== "<unknown>" &&
        stage !== "build-account-record" &&
        !shouldReplaceEmail;
      const shouldRotateProxy =
        attempts < MAX_FLOW_RETRIES &&
        proxyCandidates.length > 1 &&
        isLikelyProxyError(fullErrorText);
      const shouldRetryNetwork =
        attempts < MAX_FLOW_RETRIES &&
        isLikelyTransientNetworkError(fullErrorText);

      if (isUserAlreadyExists) {
        try {
          console.warn(
            `[Run ${runId}/${total}] account already exists for ${email}, attempting recovery login...`,
          );
          const account = await recoverExistingAccountWithLogin(
            email,
            currentPassword,
            activeMailProvider,
          );
          const durationMs = Date.now() - startedAt;
          console.log(
            `--- Run ${runId}/${total} Recovered in ${formatDuration(durationMs)} ---`,
          );
          console.log(
            `[Run ${runId}/${total}] summary ok=true email=${email} attempts=${attempts} stage=recovery-login`,
          );
          return {
            runId,
            ok: true,
            email,
            durationMs,
            attempts,
            account,
          };
        } catch (recoverError) {
          console.error(
            `[Run ${runId}/${total}] recovery login failed for ${email}:`,
            recoverError,
          );
        }
      }

      if (
        (isOtpTimeout || isWrongOtp || isInvalidState || shouldRetryNetwork) &&
        attempts < MAX_FLOW_RETRIES
      ) {
        if (shouldReplaceEmail) {
          retryEmail = null;
          try {
            await activeMailProvider.abandonEmail?.(email, stage);
          } catch (error) {
            console.warn(
              `[Run ${runId}/${total}] abandonEmail failed for ${email}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else if (shouldReuseEmail) {
          retryEmail = email;
          await prepareRetryCheckpoint(activeMailProvider, email, runId, total);
        }
        console.warn(
          `[Run ${runId}/${total}] pre-step9 issue at stage=${stage}, restarting flow with ${shouldReuseEmail ? "same" : "new"} email...`,
        );
        continue;
      }
      if (shouldRotateProxy && attempts < MAX_FLOW_RETRIES) {
        if (shouldReuseEmail) {
          retryEmail = email;
          await prepareRetryCheckpoint(activeMailProvider, email, runId, total);
        }
        console.warn(
          `[Run ${runId}/${total}] proxy unavailable at stage=${stage}, switching proxy and retrying with ${shouldReuseEmail ? "same" : "new"} email...`,
        );
        continue;
      }

      const durationMs = Date.now() - startedAt;
      console.error(
        `[Run ${runId}/${total}] summary ok=false email=${email} attempts=${attempts} stage=${stage} duration=${formatDuration(durationMs)}`,
      );
      console.error(`\x1b[31mRun ${runId}/${total} Error:\x1b[0m`, e);
      console.log(
        `--- Run ${runId}/${total} Failed in ${formatDuration(durationMs)} ---`,
      );
      return {
        runId,
        ok: false,
        email,
        durationMs,
        attempts,
        error: message,
      };
    } finally {
      activeMailProvider.dispose?.();
      try {
        await closeDispatcherIfNeeded(currentDispatcher);
      } catch (cleanupError) {
        console.warn(
          `[Run ${runId}/${total}] dispatcher cleanup failed:`,
          cleanupError,
        );
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  console.error(
    `[Run ${runId}/${total}] summary ok=false email=${email} attempts=${attempts} stage=${stage} duration=${formatDuration(durationMs)} reason=max-retries`,
  );
  return {
    runId,
    ok: false,
    email,
    durationMs,
    attempts,
    error: "Max flow retries reached due to OTP timeout",
  };
}
