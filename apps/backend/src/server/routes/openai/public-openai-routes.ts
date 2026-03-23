import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import * as openaiApiModule from "@workspace/openai-api";

export function registerPublicOpenAIRoutes(app: Express, deps: any) {
  const {
    ensureDatabaseSchema,
    authenticateApiKey,
    ensureOpenAIModelsCacheLoaded,
    openAIModelsCache,
    isOpenAIModelEnabled,
    buildPublicModelsList,
    createRequestAbortContext,
    authenticateApiKeyWithReason,
    getApiKeyAuthErrorDetail,
    persistShortCircuitErrorLog,
    isApiKeyQuotaExceeded,
    persistQuotaExceededLog,
    isApiKeyBoundToUser,
    ensureEffectiveUserRateLimitOrNull,
    acquireUserInFlightSlot,
    consumeUserRpmAllowance,
    ensureUserBillingAllowanceOrNull,
    readRequestBodyBuffer,
    AUDIO_TRANSCRIPTION_BODY_MAX_BYTES,
    refreshRuntimeSystemSettings,
    ensureOpenAIAccountsLruLoaded,
    getOpenAIApiRuntimeConfig,
    postAudioTranscriptionWithTokenRefresh,
    upstreamRetryConfig,
    selectSourceAccountForModelResponse,
    extractErrorInfo,
    isAbortError,
    isUpstreamAccountSwitchRetryableError,
    isRetryableUpstreamServerErrorStatus,
    isConnectionTimeoutError,
    markSourceAccountTransientFailure,
    sleep,
    computeRetryDelayMs,
    shouldPersistModelResponseLog,
    createModelResponseLog,
  } = deps;

  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await ensureDatabaseSchema();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/v1/models", async (req: Request, res: Response) => {
    const intentId =
      typeof req.query.intent_id === "string" && req.query.intent_id.trim()
        ? req.query.intent_id.trim()
        : crypto.randomUUID();
    res.locals.intentId = intentId;
    try {
      const apiKey = await authenticateApiKey(req);
      if (!apiKey) {
        res.status(401).json({
          error: {
            message: "Invalid API key",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        });
        return;
      }

      await ensureOpenAIModelsCacheLoaded();
      const data = buildPublicModelsList({
        openaiModels: openAIModelsCache.models.filter((model: Record<string, unknown>) =>
          isOpenAIModelEnabled(model),
        ),
        fallbackCreatedAt: openAIModelsCache.updatedAt,
      });
      res.json({
        object: "list" as const,
        data,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to list models",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/v1/audio/transcriptions", async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const intentId =
      typeof req.query.intent_id === "string" && req.query.intent_id.trim()
        ? req.query.intent_id.trim()
        : crypto.randomUUID();
    res.locals.intentId = intentId;
    const requestAbort = createRequestAbortContext(req, res);

    let attemptNo = 1;
    let retryReason: string | null = null;
    let apiKeyId: string | null = null;
    let ownerUserId: string | null = null;
    let upstreamStatus: number | null = null;
    let firstEventAtMs: number | null = null;
    let finishedAtMs: number | null = null;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let runtimeConfig: any = null;
    let alreadyPersistedQuotaLog = false;
    let releaseUserInFlightSlot = () => {};
    let refundUserRpmAllowance = () => {};

    try {
      const contentType = req.headers["content-type"];
      const contentTypeValue =
        typeof contentType === "string"
          ? contentType
          : Array.isArray(contentType)
            ? (contentType[0] ?? "")
            : "";
      if (!contentTypeValue.toLowerCase().includes("multipart/form-data")) {
        res.status(400).json({
          error: {
            message:
              "Content-Type must be multipart/form-data with a 'file' form field",
            type: "invalid_request_error",
            code: "invalid_content_type",
          },
        });
        return;
      }

      const { apiKey, reason: apiKeyAuthFailureReason } =
        await authenticateApiKeyWithReason(req);
      if (!apiKey) {
        const authError = getApiKeyAuthErrorDetail(apiKeyAuthFailureReason);
        await persistShortCircuitErrorLog({
          requestPath: req.path,
          intentId,
          attemptNo,
          retryReason,
          model: null,
          keyId: null,
          startedAtMs: startedAt,
          statusCode: 401,
          errorCode: authError.code,
          errorMessage: authError.message,
        });
        alreadyPersistedQuotaLog = true;
        res.status(401).json({
          error: {
            message: "Invalid API key",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        });
        return;
      }
      if (isApiKeyQuotaExceeded(apiKey)) {
        apiKeyId = apiKey.id;
        await persistQuotaExceededLog({
          requestPath: req.path,
          intentId,
          attemptNo,
          retryReason,
          model: null,
          keyId: apiKeyId,
          startedAtMs: startedAt,
        });
        alreadyPersistedQuotaLog = true;
        res.status(429).json({
          error: {
            message: "API key quota exceeded",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
        });
        return;
      }
      apiKeyId = apiKey.id;
      if (!isApiKeyBoundToUser(apiKey)) {
        await persistShortCircuitErrorLog({
          requestPath: req.path,
          intentId,
          attemptNo,
          retryReason,
          model: null,
          keyId: apiKeyId,
          startedAtMs: startedAt,
          statusCode: 403,
          errorCode: "api_key_owner_missing",
          errorMessage: "API key must be bound to a user for billing enforcement",
        });
        alreadyPersistedQuotaLog = true;
        res.status(403).json({
          error: {
            message: "API key must be bound to a user for billing enforcement",
            type: "invalid_request_error",
            code: "api_key_owner_missing",
          },
        });
        return;
      }
      ownerUserId = apiKey.ownerUserId;
      if (ownerUserId) {
        const userRateLimit = await ensureEffectiveUserRateLimitOrNull(ownerUserId);
        const inFlightResult = acquireUserInFlightSlot(
          ownerUserId,
          userRateLimit?.userMaxInFlight,
        );
        if (!inFlightResult.allowed) {
          await persistShortCircuitErrorLog({
            requestPath: req.path,
            intentId,
            attemptNo,
            retryReason,
            model: null,
            keyId: apiKeyId,
            startedAtMs: startedAt,
            statusCode: 429,
            errorCode: "user_concurrency_limit_exceeded",
            errorMessage: "User concurrent request limit exceeded",
          });
          alreadyPersistedQuotaLog = true;
          if (inFlightResult.retryAfterSec) {
            res.setHeader("retry-after", String(inFlightResult.retryAfterSec));
          }
          res.status(429).json({
            error: {
              message: "User concurrent request limit exceeded",
              type: "rate_limit_error",
              code: "user_concurrency_limit_exceeded",
            },
          });
          return;
        }
        releaseUserInFlightSlot = inFlightResult.release;

        const rpmResult = consumeUserRpmAllowance(
          ownerUserId,
          userRateLimit?.userRpmLimit,
        );
        if (!rpmResult.allowed) {
          await persistShortCircuitErrorLog({
            requestPath: req.path,
            intentId,
            attemptNo,
            retryReason,
            model: null,
            keyId: apiKeyId,
            startedAtMs: startedAt,
            statusCode: 429,
            errorCode: "user_rpm_limit_exceeded",
            errorMessage: "User RPM limit exceeded",
          });
          alreadyPersistedQuotaLog = true;
          if (rpmResult.retryAfterSec) {
            res.setHeader("retry-after", String(rpmResult.retryAfterSec));
          }
          res.status(429).json({
            error: {
              message: "User RPM limit exceeded",
              type: "rate_limit_error",
              code: "user_rpm_limit_exceeded",
            },
          });
          return;
        }
        refundUserRpmAllowance = rpmResult.refund;

        const allowance = await ensureUserBillingAllowanceOrNull(ownerUserId);
        if (!allowance || allowance.totalAvailable <= 0) {
          await persistShortCircuitErrorLog({
            requestPath: req.path,
            intentId,
            attemptNo,
            retryReason,
            model: null,
            keyId: apiKeyId,
            startedAtMs: startedAt,
            statusCode: 429,
            errorCode: "insufficient_quota",
            errorMessage: "Billing quota exceeded",
          });
          alreadyPersistedQuotaLog = true;
          res.status(429).json({
            error: {
              message: "Billing quota exceeded",
              type: "insufficient_quota",
              code: "insufficient_quota",
            },
          });
          return;
        }
      }

      const rawBody = (await readRequestBodyBuffer(
        req,
        AUDIO_TRANSCRIPTION_BODY_MAX_BYTES,
      )) as unknown as BodyInit;
      await refreshRuntimeSystemSettings();
      await ensureOpenAIAccountsLruLoaded();
      runtimeConfig = await getOpenAIApiRuntimeConfig();
      if (typeof openaiApiModule.postAudioTranscription !== "function") {
        res.status(500).json({
          error: {
            message:
              "postAudioTranscription is not exported from @workspace/openai-api",
            type: "server_error",
            code: "missing_openai_api_export",
          },
        });
        return;
      }

      const maxAttempts = upstreamRetryConfig.maxAttemptCount;
      const triedSourceAccountIds = new Set<string>();
      let requestHandled = false;

      for (attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
        let sourceAccount = selectSourceAccountForModelResponse({
          stickyPromptCacheKey: null,
          attemptNo,
          excludeAccountIds: triedSourceAccountIds,
        });
        if (!sourceAccount || !sourceAccount.accessToken?.trim()) {
          await ensureOpenAIAccountsLruLoaded(true);
          sourceAccount = selectSourceAccountForModelResponse({
            stickyPromptCacheKey: null,
            attemptNo,
            excludeAccountIds: triedSourceAccountIds,
          });
        }
        if (!sourceAccount || !sourceAccount.accessToken?.trim()) {
          upstreamStatus = 503;
          errorCode = "upstream_account_unavailable";
          errorMessage = "No available upstream account";
          break;
        }
        const resolvedAccountId =
          (sourceAccount.accountId ?? sourceAccount.userId ?? "").trim() || null;
        if (!resolvedAccountId) {
          triedSourceAccountIds.add(sourceAccount.id);
          retryReason = "upstream_account_unavailable";
          continue;
        }
        triedSourceAccountIds.add(sourceAccount.id);

        try {
          const upstream = await postAudioTranscriptionWithTokenRefresh({
            module: openaiApiModule,
            account: sourceAccount,
            contentType: contentTypeValue,
            body: rawBody,
            allowRetryAfterRefresh: true,
            runtimeConfig,
            signal: requestAbort.signal,
          });
          upstreamStatus = upstream.status;
          firstEventAtMs = Date.now();
          const responseText = await upstream.text();
          finishedAtMs = Date.now();

          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(responseText) as Record<string, unknown>;
          } catch {
            parsed = null;
          }

          if (parsed && typeof parsed.text === "string") {
            res.status(upstream.status).json(parsed);
          } else if (parsed) {
            res.status(upstream.status).json(parsed);
          } else {
            res.status(upstream.status).json({
              text: responseText || "",
            });
          }
          requestHandled = true;
          break;
        } catch (error) {
          const wasAborted = requestAbort.signal.aborted || isAbortError(error);
          if (wasAborted) {
            finishedAtMs = Date.now();
            requestHandled = true;
            break;
          }
          const errorInfo = extractErrorInfo(error);
          upstreamStatus = errorInfo.status;
          errorMessage = errorInfo.message;
          errorCode =
            errorInfo.errorPayload &&
            typeof errorInfo.errorPayload.code === "string"
              ? errorInfo.errorPayload.code
              : "audio_transcriptions_failed";
          const accountRetryable = isUpstreamAccountSwitchRetryableError({
            error,
            status: upstreamStatus,
            errorPayload: errorInfo.errorPayload,
            message: errorMessage,
          });
          const serverErrorRetryable =
            isRetryableUpstreamServerErrorStatus(upstreamStatus);
          const shouldRetry =
            attemptNo < maxAttempts &&
            (upstreamStatus === 429 ||
              isConnectionTimeoutError(error) ||
              serverErrorRetryable ||
              accountRetryable);
          if (shouldRetry) {
            retryReason =
              upstreamStatus === 429
                ? "rate_limit"
                : isConnectionTimeoutError(error)
                  ? "connection_timeout"
                  : serverErrorRetryable
                    ? "upstream_server_error"
                    : "upstream_account_unavailable";
            if (retryReason !== "rate_limit") {
              markSourceAccountTransientFailure(sourceAccount.id, null);
            }
            await sleep(computeRetryDelayMs(attemptNo), requestAbort.signal);
            continue;
          }
          break;
        }
      }

      if (!requestHandled) {
        finishedAtMs = finishedAtMs ?? Date.now();
        res.status(upstreamStatus ?? 500).json({
          error: {
            message: errorMessage ?? "Failed to transcribe audio",
            type: "server_error",
            code: errorCode ?? "audio_transcriptions_failed",
          },
        });
      }
    } catch (error) {
      finishedAtMs = finishedAtMs ?? Date.now();
      const wasAborted = requestAbort.signal.aborted || isAbortError(error);
      if (wasAborted) {
        return;
      }
      const errorInfo = extractErrorInfo(error);
      upstreamStatus = upstreamStatus ?? errorInfo.status;
      errorMessage = errorMessage ?? errorInfo.message;
      errorCode = errorCode ?? "audio_transcriptions_failed";
      res.status(upstreamStatus ?? 500).json({
        error: {
          message: errorMessage,
          type: "server_error",
          code: errorCode,
        },
      });
    } finally {
      releaseUserInFlightSlot();
      const requestSucceeded =
        !requestAbort.signal.aborted &&
        upstreamStatus !== null &&
        upstreamStatus >= 200 &&
        upstreamStatus < 300;
      if (!requestSucceeded) {
        refundUserRpmAllowance();
      }
      try {
        if (!alreadyPersistedQuotaLog && shouldPersistModelResponseLog(req.path)) {
          await createModelResponseLog({
            intentId,
            attemptNo,
            isFinal:
              upstreamStatus !== null &&
              upstreamStatus >= 200 &&
              upstreamStatus < 300,
            retryReason,
            path: req.path,
            modelId: null,
            keyId: apiKeyId,
            statusCode: upstreamStatus ?? (res.headersSent ? res.statusCode : null),
            ttfbMs: firstEventAtMs ? Math.max(0, firstEventAtMs - startedAt) : null,
            latencyMs: finishedAtMs ? Math.max(0, finishedAtMs - startedAt) : null,
            tokensInfo: null,
            totalTokens: null,
            cost: null,
            errorCode:
              upstreamStatus !== null &&
              upstreamStatus >= 200 &&
              upstreamStatus < 300
                ? null
                : (errorCode ?? "audio_transcriptions_failed"),
            errorMessage:
              upstreamStatus !== null &&
              upstreamStatus >= 200 &&
              upstreamStatus < 300
                ? null
                : (errorMessage ?? "Failed to transcribe audio"),
            requestTime: new Date(startedAt).toISOString(),
          });
        }
      } catch (logError) {
        console.warn(
          `[logs] failed to write /v1/audio/transcriptions log: ${logError instanceof Error ? logError.message : String(logError)}`,
        );
      } finally {
        requestAbort.cleanup();
      }
    }
  });
}
