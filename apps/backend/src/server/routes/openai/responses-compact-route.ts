import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import * as openaiApiModule from "@workspace/openai-api";

import {
  ensureBillingAllowanceOrRespond,
  finalizeOpenAIRouteAccounting,
  persistOpenAIResponseLog,
  prepareOpenAIRouteRequest,
  selectReadySourceAccountForModelRequest,
} from "../../services/openai/openai-route-services.ts";

function ensurePromptCacheKey(
  payload: Record<string, unknown>,
  ownerUserId: string | null,
  apiKeyId: string | null,
) {
  if (typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.trim()) {
    return;
  }
  const seed = ownerUserId?.trim() || apiKeyId?.trim() || "";
  if (!seed) {
    payload.prompt_cache_key = crypto.randomUUID();
    return;
  }
  payload.prompt_cache_key = crypto
    .createHash("sha256")
    .update(`prompt-cache:${seed}`)
    .digest("hex")
    .slice(0, 32);
}

export function registerResponsesCompactRoute(app: Express, deps: any) {
  const {
    createRequestAbortContext,
    parsePriorityServiceTier,
    PRIORITY_SERVICE_TIER_ERROR_MESSAGE,
    buildInvalidPriorityServiceTierErrorPayload,
    refreshRuntimeSystemSettings,
    upstreamRetryConfig,
    ensureOpenAIModelsCacheLoaded,
    stripUnsupportedResponsesFields,
    getStickyPromptCacheKey,
    isDisabledOpenAIModel,
    isConfiguredOpenAIModel,
    resolveOpenAIModelUpstreamPool,
    ensureSourceAccountPoolLoaded,
    getOpenAIApiRuntimeConfig,
    postCodexResponsesCompactWithTokenRefresh,
    extractErrorInfo,
    isAbortError,
    isUpstreamAccountSwitchRetryableError,
    isRetryableEmptyForbiddenUpstreamError,
    isUpstreamBufferRetryLimitError,
    isRetryableUpstreamServerErrorStatus,
    isConnectionTimeoutError,
    markSelectedSourceAccountTransientFailure,
    sleep,
    computeRetryDelayMs,
    getResponseStatusFromPayload,
    extractResponseErrorPayload,
    isRetryableResponseFailurePayload,
    markSourceAccountTransientFailure,
    buildPassthroughUpstreamError,
    shouldPersistModelResponseLog,
    rememberStickyPromptAccountOverride,
  } = deps;

  app.post("/v1/responses/compact", async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    const intentId =
      typeof requestBody.intent_id === "string" && requestBody.intent_id.trim()
        ? requestBody.intent_id.trim()
        : crypto.randomUUID();
    res.locals.intentId = intentId;
    const requestAbort = createRequestAbortContext(req, res);
    const initialRetryReason =
      typeof requestBody.retry_reason === "string" &&
        requestBody.retry_reason.trim()
        ? requestBody.retry_reason.trim()
        : null;
    let attemptNo = 1;
    let retryReason = initialRetryReason;
    let apiKeyId: string | null = null;
    let ownerUserId: string | null = null;
    let allowanceRemainingBeforeRequest = 0;
    let model: string | null = null;
    let upstreamStatus: number | null = null;
    let firstEventAtMs: number | null = null;
    let finishedAtMs: number | null = null;
    let completedResponsePayload: Record<string, unknown> | null = null;
    let lastErrorPayload: Record<string, unknown> | null = null;
    let compactErrorMessage: string | null = null;
    let sawResponseCompleted = false;
    let alreadyPersistedQuotaLog = false;
    let runtimeConfig: any = null;
    let lastUsedSourceAccount: any = null;
    let releaseUserInFlightSlot = () => { };
    let refundUserRpmAllowance = () => { };
    const serviceTierResult = parsePriorityServiceTier(requestBody.service_tier);
    let maxAttempts = upstreamRetryConfig.maxAttemptCount;
    model =
      typeof requestBody.model === "string" && requestBody.model.trim()
        ? requestBody.model.trim()
        : null;

    try {
      if (!serviceTierResult.valid) {
        upstreamStatus = 400;
        finishedAtMs = Date.now();
        lastErrorPayload = {
          message: PRIORITY_SERVICE_TIER_ERROR_MESSAGE,
          type: "invalid_request_error",
          code: "invalid_request_error",
        };
        res.status(400).json(buildInvalidPriorityServiceTierErrorPayload());
        return;
      }

      const preparedRequest = await prepareOpenAIRouteRequest({
        req,
        res,
        deps,
        intentId,
        attemptNo,
        retryReason,
        model,
        startedAtMs: startedAt,
      });
      if (!preparedRequest.ok) {
        alreadyPersistedQuotaLog = preparedRequest.alreadyPersistedQuotaLog;
        apiKeyId = preparedRequest.apiKeyId ?? null;
        ownerUserId = preparedRequest.ownerUserId ?? null;
        return;
      }
      apiKeyId = preparedRequest.apiKeyId;
      ownerUserId = preparedRequest.ownerUserId;
      allowanceRemainingBeforeRequest =
        preparedRequest.allowanceRemainingBeforeRequest;
      releaseUserInFlightSlot = preparedRequest.releaseUserInFlightSlot;
      refundUserRpmAllowance = preparedRequest.refundUserRpmAllowance;

      await refreshRuntimeSystemSettings();
      maxAttempts = upstreamRetryConfig.maxAttemptCount;
      await ensureOpenAIModelsCacheLoaded();
      const payload: Record<string, unknown> = {
        ...requestBody,
      };
      if (serviceTierResult.value) {
        payload.service_tier = serviceTierResult.value;
      } else {
        delete payload.service_tier;
      }
      if (
        typeof payload.promptCacheKey === "string" &&
        typeof payload.prompt_cache_key !== "string"
      ) {
        payload.prompt_cache_key = payload.promptCacheKey;
      }
      delete payload.promptCacheKey;
      stripUnsupportedResponsesFields(payload);
      delete payload.prompt_cache_retention;
      delete payload.stream;
      ensurePromptCacheKey(payload, ownerUserId, apiKeyId);
      const stickyPromptCacheKey = getStickyPromptCacheKey(requestBody, payload);

      model =
        typeof payload.model === "string" && payload.model.trim()
          ? payload.model.trim()
          : model;
      if (!model) {
        res.status(400).json({
          error: {
            message: "Missing required field: model",
            type: "invalid_request_error",
            code: "invalid_request_error",
          },
        });
        return;
      }
      if (isDisabledOpenAIModel(model)) {
        upstreamStatus = 400;
        finishedAtMs = Date.now();
        lastErrorPayload = {
          message: `The model '${model}' is disabled`,
          type: "invalid_request_error",
          code: "model_disabled",
        };
        res.status(400).json({
          error: {
            message: `The model '${model}' is disabled`,
            type: "invalid_request_error",
            code: "model_disabled",
          },
        });
        return;
      }
      if (!isConfiguredOpenAIModel(model)) {
        upstreamStatus = 404;
        finishedAtMs = Date.now();
        lastErrorPayload = {
          message: `The model '${model}' does not exist`,
          type: "invalid_request_error",
          code: "model_not_found",
        };
        res.status(404).json({
          error: {
            message: `The model '${model}' does not exist`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        });
        return;
      }
      const modelUpstreamPool = await resolveOpenAIModelUpstreamPool({
        modelId: model,
        ownerUserId,
      });
      if (!modelUpstreamPool.ok) {
        res.status(modelUpstreamPool.status).json({
          error: {
            message: modelUpstreamPool.message,
            type: "invalid_request_error",
            code: modelUpstreamPool.code,
          },
        });
        return;
      }
      await ensureSourceAccountPoolLoaded(modelUpstreamPool.pool);

      runtimeConfig = await getOpenAIApiRuntimeConfig();
      if (typeof openaiApiModule.postCodexResponsesCompact !== "function") {
        res.status(500).json({
          error: {
            message:
              "postCodexResponsesCompact is not exported from @workspace/openai-api",
            type: "server_error",
            code: "missing_openai_api_export",
          },
        });
        return;
      }

      let requestHandled = false;
      const triedSourceAccountIds = new Set<string>();
      for (attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
        if (ownerUserId) {
          const allowanceResult = await ensureBillingAllowanceOrRespond({
            req,
            res,
            deps,
            ownerUserId,
            apiKeyId,
            intentId,
            attemptNo,
            retryReason,
            model,
            startedAtMs: startedAt,
          });
          if (!allowanceResult.ok) {
            alreadyPersistedQuotaLog = true;
            requestHandled = true;
            break;
          }
          if (attemptNo === 1) {
            allowanceRemainingBeforeRequest =
              allowanceResult.allowanceRemaining;
          }
        }

        const selectedAccount = await selectReadySourceAccountForModelRequest({
          deps,
          pool: modelUpstreamPool.pool,
          stickyPromptCacheKey,
          attemptNo,
          triedSourceAccountIds,
        });
        if (!selectedAccount.ok && selectedAccount.reason === "unavailable") {
          res.status(503).json({
            error: {
              message: "No available upstream account",
              type: "server_error",
              code: "upstream_account_unavailable",
            },
          });
          requestHandled = true;
          break;
        }
        if (!selectedAccount.ok) {
          retryReason = "upstream_account_unavailable";
          continue;
        }
        const sourceAccount = selectedAccount.sourceAccount;
        lastUsedSourceAccount = sourceAccount;

        let upstream!: globalThis.Response;
        try {
          upstream = await postCodexResponsesCompactWithTokenRefresh({
            module: openaiApiModule,
            account: sourceAccount,
            payload,
            debugLabel: intentId,
            runtimeConfig,
            signal: requestAbort.signal,
          });
        } catch (error) {
          const errorInfo = extractErrorInfo(error);
          upstreamStatus = errorInfo.status;
          compactErrorMessage = errorInfo.message;
          if (errorInfo.errorPayload) {
            lastErrorPayload = errorInfo.errorPayload;
          }
          const wasAborted = requestAbort.signal.aborted || isAbortError(error);
          if (wasAborted) {
            finishedAtMs = Date.now();
            requestHandled = true;
            break;
          }
          const accountRetryable = isUpstreamAccountSwitchRetryableError({
            error,
            status: upstreamStatus,
            errorPayload: errorInfo.errorPayload,
            message: compactErrorMessage,
          });
          const emptyForbiddenRetryable = isRetryableEmptyForbiddenUpstreamError({
            status: upstreamStatus,
            errorPayload: errorInfo.errorPayload,
            message: compactErrorMessage,
            rawResponseText: errorInfo.rawResponseText,
          });
          const bufferRetryable = isUpstreamBufferRetryLimitError({
            error,
            status: upstreamStatus,
            errorPayload: errorInfo.errorPayload,
            message: compactErrorMessage,
          });
          const serverErrorRetryable =
            isRetryableUpstreamServerErrorStatus(upstreamStatus);
          const retryBudget = emptyForbiddenRetryable
            ? Math.max(maxAttempts, 2)
            : maxAttempts;
          const shouldRetry =
            attemptNo < retryBudget &&
            (upstreamStatus === 429 ||
              isConnectionTimeoutError(error) ||
              bufferRetryable ||
              serverErrorRetryable ||
              emptyForbiddenRetryable ||
              accountRetryable);
          if (shouldRetry) {
            maxAttempts = retryBudget;
            retryReason =
              upstreamStatus === 429
                ? "rate_limit"
                : isConnectionTimeoutError(error)
                  ? "connection_timeout"
                  : bufferRetryable
                    ? "upstream_transport_error"
                    : serverErrorRetryable
                      ? "upstream_server_error"
                      : emptyForbiddenRetryable
                        ? "upstream_forbidden"
                        : "upstream_account_unavailable";
            if (
              retryReason !== "rate_limit" &&
              retryReason !== "upstream_forbidden"
            ) {
              markSelectedSourceAccountTransientFailure({
                account: sourceAccount,
                stickyPromptCacheKey,
              });
            }
            await sleep(computeRetryDelayMs(attemptNo), requestAbort.signal);
            continue;
          }
          throw error;
        }

        upstreamStatus = upstream.status;
        if (upstream.status === 429 && attemptNo < maxAttempts) {
          retryReason = "rate_limit";
          await sleep(computeRetryDelayMs(attemptNo), requestAbort.signal);
          continue;
        }

        const responseText = await upstream.text();
        if (!firstEventAtMs) firstEventAtMs = Date.now();
        finishedAtMs = Date.now();

        let parsedBody: Record<string, unknown> | null = null;
        try {
          parsedBody = JSON.parse(responseText) as Record<string, unknown>;
        } catch {
          parsedBody = null;
        }
        if (parsedBody) {
          completedResponsePayload = parsedBody;
          const responseStatus = getResponseStatusFromPayload(parsedBody);
          if (responseStatus === "completed") {
            sawResponseCompleted = true;
          }
          const responseErrorPayload = extractResponseErrorPayload(parsedBody);
          if (responseErrorPayload) {
            lastErrorPayload = responseErrorPayload;
          }
          if (
            responseStatus === "failed" &&
            isRetryableResponseFailurePayload(parsedBody) &&
            attemptNo < maxAttempts
          ) {
            retryReason = "upstream_server_error";
            markSourceAccountTransientFailure(
              sourceAccount.id,
              stickyPromptCacheKey,
            );
            await sleep(computeRetryDelayMs(attemptNo), requestAbort.signal);
            continue;
          }
        }

        res.status(upstream.status);
        res.setHeader(
          "content-type",
          upstream.headers.get("content-type") ??
          "application/json; charset=utf-8",
        );
        res.send(responseText);
        rememberStickyPromptAccountOverride(
          stickyPromptCacheKey,
          sourceAccount.id,
        );
        requestHandled = true;
        break;
      }

      if (!requestHandled && !res.headersSent) {
        const passthroughError = buildPassthroughUpstreamError({
          status: upstreamStatus,
          errorPayload: lastErrorPayload,
          fallbackCode: "responses_compact_failed",
          fallbackMessage:
            compactErrorMessage ?? "Failed to proxy upstream compact response",
        });
        res.status(passthroughError.status).json({
          error: passthroughError.error,
        });
      }
    } catch (error) {
      const errorInfo = extractErrorInfo(error);
      compactErrorMessage = errorInfo.message;
      upstreamStatus = upstreamStatus ?? errorInfo.status;
      if (errorInfo.errorPayload) {
        lastErrorPayload = errorInfo.errorPayload;
      }
      finishedAtMs = Date.now();
      const wasAborted = requestAbort.signal.aborted || isAbortError(error);
      if (wasAborted) {
      } else if (!res.headersSent) {
        const passthroughError = buildPassthroughUpstreamError({
          status: upstreamStatus,
          errorPayload: lastErrorPayload,
          fallbackCode: "responses_compact_failed",
          fallbackMessage:
            compactErrorMessage ?? "Failed to proxy upstream compact response",
        });
        res.status(passthroughError.status).json({
          error: passthroughError.error,
        });
      }
    } finally {
      releaseUserInFlightSlot();
      const requestSucceeded = !requestAbort.signal.aborted && sawResponseCompleted;
      if (!requestSucceeded) {
        refundUserRpmAllowance();
      }
      try {
        const accounting = await finalizeOpenAIRouteAccounting({
          deps,
          apiKeyId,
          ownerUserId,
          intentId,
          path: req.path,
          model,
          completedResponsePayload,
          lastErrorPayload,
          serviceTier: serviceTierResult.value,
          allowanceRemainingBeforeRequest,
          runtimeConfig,
          lastUsedSourceAccount,
          requestSucceeded,
        });
        await persistOpenAIResponseLog({
          deps,
          shouldPersist:
            !alreadyPersistedQuotaLog && shouldPersistModelResponseLog(req.path),
          path: req.path,
          intentId,
          attemptNo,
          isFinal: requestSucceeded,
          retryReason,
          model,
          apiKeyId,
          serviceTier: serviceTierResult.value,
          statusCode: upstreamStatus ?? (res.headersSent ? res.statusCode : null),
          startedAtMs: startedAt,
          firstEventAtMs,
          finishedAtMs,
          usage: accounting.usage,
          cost: accounting.cost,
          fallbackErrorCode: compactErrorMessage
            ? "responses_compact_failed"
            : null,
          fallbackErrorMessage: compactErrorMessage,
        });
      } catch (error) {
        console.warn(
          `[logs] failed to write /v1/responses/compact log: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        requestAbort.cleanup();
      }
    }
  });
}
