import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import * as openaiApiModule from "@workspace/openai-api";
import {
  ensureBillingAllowanceOrRespond,
  finalizeOpenAIRouteAccounting,
  prepareOpenAIRouteRequest,
  persistOpenAIResponseLog,
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

export function registerChatRoutes(app: Express, deps: any) {
  const {
    createRequestAbortContext,
    parsePriorityServiceTier,
    PRIORITY_SERVICE_TIER_ERROR_MESSAGE,
    buildInvalidPriorityServiceTierErrorPayload,
    refreshRuntimeSystemSettings,
    upstreamRetryConfig,
    ensureOpenAIModelsCacheLoaded,
    mapChatRequestToResponsesPayload,
    getStickyPromptCacheKey,
    isDisabledOpenAIModel,
    isConfiguredOpenAIModel,
    resolveOpenAIModelUpstreamPool,
    ensureSourceAccountPoolLoaded,
    getOpenAIApiRuntimeConfig,
    isRecord,
    postCodexResponsesWithTokenRefresh,
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
    buildPassthroughResponseFailureError,
    mapResponseToChatCompletion,
    markSourceAccountTransientFailure,
    createSseHeartbeatController,
    touchUserInFlightSlot,
    isResponseOutputTextDeltaEvent,
    mapResponseEventToChatStreamChunks,
    mapResponseUsageToChatUsage,
    buildPassthroughUpstreamError,
    shouldPersistModelResponseLog,
    rememberStickyPromptAccountOverride,
    isRetrySafePreTextResponsesEventType,
  } = deps;

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
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
    const requestedStream = requestBody.stream === true;
    const serviceTierResult = parsePriorityServiceTier(requestBody.service_tier);

    let apiKeyId: string | null = null;
    let ownerUserId: string | null = null;
    let allowanceRemainingBeforeRequest = 0;
    let model: string | null = null;
    let upstreamStatus: number | null = null;
    let firstEventAtMs: number | null = null;
    let finishedAtMs: number | null = null;
    let completedResponsePayload: Record<string, unknown> | null = null;
    let lastErrorPayload: Record<string, unknown> | null = null;
    let streamErrorMessage: string | null = null;
    let sawResponseCompleted = false;
    let sawResponseFailed = false;
    let streamHeartbeatCount = 0;
    let streamEndReason: string | null = null;
    let alreadyPersistedQuotaLog = false;
    let runtimeConfig: any = null;
    let lastUsedSourceAccount: any = null;
    let releaseUserInFlightSlot = () => { };
    let refundUserRpmAllowance = () => { };
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

      const payload = mapChatRequestToResponsesPayload({
        ...requestBody,
        stream: requestedStream,
      });
      if (serviceTierResult.value) {
        payload.service_tier = serviceTierResult.value;
      } else {
        delete payload.service_tier;
      }
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
      if (typeof openaiApiModule.postCodexResponses !== "function") {
        res.status(500).json({
          error: {
            message:
              "postCodexResponses is not exported from @workspace/openai-api",
            type: "server_error",
            code: "missing_openai_api_export",
          },
        });
        return;
      }

      let requestHandled = false;
      const triedSourceAccountIds = new Set<string>();
      const includeUsage =
        isRecord(requestBody.stream_options) &&
        (requestBody.stream_options as Record<string, unknown>).include_usage ===
        true;

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
          upstream = await postCodexResponsesWithTokenRefresh({
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
          streamErrorMessage = errorInfo.message;
          if (errorInfo.errorPayload) {
            lastErrorPayload = errorInfo.errorPayload;
          }
          const wasAborted = requestAbort.signal.aborted || isAbortError(error);
          if (wasAborted) {
            finishedAtMs = Date.now();
            if (requestedStream && !streamEndReason) {
              streamEndReason = "client_aborted_before_upstream_response";
            }
            requestHandled = true;
            break;
          }
          const accountRetryable = isUpstreamAccountSwitchRetryableError({
            error,
            status: upstreamStatus,
            errorPayload: errorInfo.errorPayload,
            message: streamErrorMessage,
          });
          const emptyForbiddenRetryable = isRetryableEmptyForbiddenUpstreamError({
            status: upstreamStatus,
            errorPayload: errorInfo.errorPayload,
            message: streamErrorMessage,
            rawResponseText: errorInfo.rawResponseText,
          });
          const bufferRetryable = isUpstreamBufferRetryLimitError({
            error,
            status: upstreamStatus,
            errorPayload: errorInfo.errorPayload,
            message: streamErrorMessage,
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

        if (!requestedStream) {
          const responseText = await upstream.text();
          if (!firstEventAtMs) firstEventAtMs = Date.now();
          finishedAtMs = Date.now();

          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(responseText) as Record<string, unknown>;
          } catch {
            parsed = null;
          }

          if (parsed?.error && isRecord(parsed.error)) {
            lastErrorPayload = parsed.error as Record<string, unknown>;
            if (attemptNo < maxAttempts && upstream.status === 429) {
              retryReason = "rate_limit";
              await sleep(computeRetryDelayMs(attemptNo), requestAbort.signal);
              continue;
            }
            res.status(upstream.status).json(parsed);
            requestHandled = true;
            break;
          }
          if (parsed) {
            const responseStatus = getResponseStatusFromPayload(parsed);
            if (responseStatus === "completed") {
              sawResponseCompleted = true;
              completedResponsePayload = parsed;
            }
            if (responseStatus === "failed") {
              sawResponseFailed = true;
            }
            const responseErrorPayload = extractResponseErrorPayload(parsed);
            if (responseErrorPayload) {
              lastErrorPayload = responseErrorPayload;
            }
            if (
              responseStatus === "failed" &&
              isRetryableResponseFailurePayload(parsed) &&
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
            if (
              !sawResponseCompleted &&
              !sawResponseFailed &&
              attemptNo < maxAttempts
            ) {
              retryReason = "stream_disconnected";
              markSourceAccountTransientFailure(
                sourceAccount.id,
                stickyPromptCacheKey,
              );
              await sleep(computeRetryDelayMs(attemptNo), requestAbort.signal);
              continue;
            }
            if (responseStatus === "failed") {
              const passthroughError = buildPassthroughResponseFailureError({
                payload: parsed,
                fallbackCode: "chat_completions_failed",
                fallbackMessage: "Upstream response failed",
              });
              upstreamStatus = passthroughError.status;
              res.status(passthroughError.status).json({
                error: passthroughError.error,
              });
              requestHandled = true;
              break;
            }
            res.status(upstream.status).json(mapResponseToChatCompletion(parsed));
            rememberStickyPromptAccountOverride(
              stickyPromptCacheKey,
              sourceAccount.id,
            );
            requestHandled = true;
            break;
          }

          if (attemptNo < maxAttempts) {
            retryReason = "stream_disconnected";
            markSourceAccountTransientFailure(
              sourceAccount.id,
              stickyPromptCacheKey,
            );
            await sleep(computeRetryDelayMs(attemptNo), requestAbort.signal);
            continue;
          }
          res.status(502).json({
            error: {
              message: "Invalid upstream response payload",
              type: "server_error",
              code: "invalid_upstream_payload",
            },
          });
          requestHandled = true;
          break;
        }

        if (!upstream.body) {
          if (attemptNo < maxAttempts) {
            retryReason = "connection_timeout";
            markSourceAccountTransientFailure(
              sourceAccount.id,
              stickyPromptCacheKey,
            );
            await sleep(computeRetryDelayMs(attemptNo), requestAbort.signal);
            continue;
          }
          if (requestedStream) {
            streamEndReason = "empty_upstream_body";
          }
          res.status(502).json({
            error: {
              message: "Upstream returned empty stream body",
              type: "server_error",
              code: "empty_upstream_body",
            },
          });
          requestHandled = true;
          break;
        }

        if (!res.headersSent) {
          res.status(upstream.status);
          res.setHeader("content-type", "text/event-stream; charset=utf-8");
          res.setHeader("cache-control", "no-cache");
          res.setHeader("connection", "keep-alive");
          res.flushHeaders();
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let parseBuffer = "";
        let eventName = "message";
        let dataLines: string[] = [];
        let doneSent = false;
        let wroteChunkThisAttempt = false;
        let sawFirstTextDeltaThisAttempt = false;
        let sawNonRetryablePreTextOutputThisAttempt = false;
        let sawResponseCompletedThisAttempt = false;
        let sawResponseFailedThisAttempt = false;
        let sawRetryableResponseFailureThisAttempt = false;
        const bufferedRetrySafePreludeChunks: Array<Record<string, unknown>> = [];
        let heartbeat: ReturnType<typeof createSseHeartbeatController> | null =
          null;
        const streamState = {
          id: `chatcmpl_${crypto.randomUUID()}`,
          model,
          created: Math.floor(Date.now() / 1000),
          emittedText: false,
        };

        const writeChunkNow = (chunk: Record<string, unknown>) => {
          if (!firstEventAtMs) firstEventAtMs = Date.now();
          heartbeat?.markActivity();
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          wroteChunkThisAttempt = true;
        };

        const writeDoneNow = () => {
          if (doneSent) return;
          if (!firstEventAtMs) firstEventAtMs = Date.now();
          heartbeat?.markActivity();
          res.write("data: [DONE]\n\n");
          doneSent = true;
        };

        const flushBufferedRetrySafePreludeChunks = () => {
          while (bufferedRetrySafePreludeChunks.length > 0) {
            const chunk = bufferedRetrySafePreludeChunks.shift();
            if (chunk) {
              writeChunkNow(chunk);
            }
          }
        };

        const writeMappedChunks = (
          eventType: string,
          chunks: Array<Record<string, unknown>>,
        ) => {
          if (chunks.length === 0) return;
          if (
            !sawFirstTextDeltaThisAttempt &&
            !sawResponseCompletedThisAttempt &&
            isRetrySafePreTextResponsesEventType(eventType)
          ) {
            bufferedRetrySafePreludeChunks.push(...chunks);
            return;
          }
          if (!sawFirstTextDeltaThisAttempt && !sawResponseCompletedThisAttempt) {
            sawNonRetryablePreTextOutputThisAttempt = true;
          }
          flushBufferedRetrySafePreludeChunks();
          for (const chunk of chunks) {
            writeChunkNow(chunk);
          }
        };

        const onEvent = (event: string, data: string) => {
          if (data === "[DONE]") return;
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            return;
          }
          if (!parsed) return;
          const type =
            typeof parsed.type === "string" ? parsed.type : event || "message";
          if (isResponseOutputTextDeltaEvent(type, parsed)) {
            sawFirstTextDeltaThisAttempt = true;
          }

          if (type === "response.completed" && isRecord(parsed.response)) {
            sawResponseCompleted = true;
            sawResponseCompletedThisAttempt = true;
            completedResponsePayload = parsed.response as Record<string, unknown>;
          }
          if (type === "error" || type === "response.error") {
            lastErrorPayload = extractResponseErrorPayload(parsed) ?? parsed;
          }
          if (type === "response.failed") {
            sawResponseFailed = true;
            sawResponseFailedThisAttempt = true;
            sawRetryableResponseFailureThisAttempt =
              isRetryableResponseFailurePayload(parsed);
            lastErrorPayload = extractResponseErrorPayload(parsed) ?? parsed;
          }

          const chunks = mapResponseEventToChatStreamChunks(
            type,
            parsed,
            streamState,
          );
          for (const chunk of chunks) {
            if (includeUsage && !("usage" in chunk)) {
              chunk.usage = null;
            }
          }
          writeMappedChunks(type, chunks);

          if (type === "response.completed") {
            if (includeUsage && completedResponsePayload) {
              flushBufferedRetrySafePreludeChunks();
              writeChunkNow({
                id: streamState.id,
                object: "chat.completion.chunk",
                created: streamState.created,
                model: streamState.model,
                choices: [],
                usage: mapResponseUsageToChatUsage(
                  isRecord(completedResponsePayload.usage)
                    ? (completedResponsePayload.usage as Record<string, unknown>)
                    : null,
                ),
              });
            }
            if (!doneSent) {
              flushBufferedRetrySafePreludeChunks();
              writeDoneNow();
            }
          }
        };

        const flushParsedEvent = () => {
          if (dataLines.length === 0) {
            eventName = "message";
            return;
          }
          const data = dataLines.join("\n");
          dataLines = [];
          const currentEvent = eventName;
          eventName = "message";
          onEvent(currentEvent, data);
        };

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!heartbeat) {
              heartbeat = createSseHeartbeatController({
                res,
                onHeartbeat: () => {
                  streamHeartbeatCount += 1;
                  touchUserInFlightSlot(ownerUserId);
                },
              });
            }
            heartbeat.markActivity();
            touchUserInFlightSlot(ownerUserId);
            parseBuffer += decoder.decode(value, { stream: true });
            let lineBreakIndex = parseBuffer.indexOf("\n");
            while (lineBreakIndex !== -1) {
              const rawLine = parseBuffer.slice(0, lineBreakIndex);
              parseBuffer = parseBuffer.slice(lineBreakIndex + 1);
              const line = rawLine.endsWith("\r")
                ? rawLine.slice(0, -1)
                : rawLine;

              if (line === "") {
                flushParsedEvent();
              } else if (line.startsWith("event:")) {
                eventName = line.slice(6).trim() || "message";
              } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
              }
              lineBreakIndex = parseBuffer.indexOf("\n");
            }
          }
          parseBuffer += decoder.decode();
          if (parseBuffer.trim()) {
            const trailing = parseBuffer.trim();
            if (trailing.startsWith("event:")) {
              eventName = trailing.slice(6).trim() || "message";
            } else if (trailing.startsWith("data:")) {
              dataLines.push(trailing.slice(5).trimStart());
            } else {
              dataLines.push(trailing);
            }
          }
          flushParsedEvent();

          if (sawResponseFailedThisAttempt) {
            if (
              sawRetryableResponseFailureThisAttempt &&
              !sawFirstTextDeltaThisAttempt &&
              !sawNonRetryablePreTextOutputThisAttempt &&
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
            finishedAtMs = Date.now();
            if (requestedStream && !streamEndReason) {
              streamEndReason = "response_failed";
            }
            if (!res.writableEnded) {
              const passthroughError = buildPassthroughResponseFailureError({
                payload: lastErrorPayload,
                fallbackCode: "chat_completions_failed",
                fallbackMessage: "Upstream response failed",
              });
              res.write(
                `data: ${JSON.stringify({
                  error: passthroughError.error,
                })}\n\n`,
              );
              res.write("data: [DONE]\n\n");
              res.end();
            }
            requestHandled = true;
            break;
          }

          if (!sawResponseCompletedThisAttempt && attemptNo < maxAttempts) {
            if (
              !sawFirstTextDeltaThisAttempt &&
              !sawNonRetryablePreTextOutputThisAttempt
            ) {
              retryReason = "stream_disconnected";
              markSourceAccountTransientFailure(
                sourceAccount.id,
                stickyPromptCacheKey,
              );
              await sleep(computeRetryDelayMs(attemptNo), requestAbort.signal);
              continue;
            }
            retryReason = "stream_disconnected";
            markSourceAccountTransientFailure(
              sourceAccount.id,
              stickyPromptCacheKey,
            );
            streamEndReason = "upstream_disconnected_after_partial";
            finishedAtMs = Date.now();
            if (!res.writableEnded) {
              res.write(
                `data: ${JSON.stringify({
                  error: {
                    message: "Upstream stream disconnected before completion",
                    type: "server_error",
                    code: "stream_disconnected",
                  },
                })}\n\n`,
              );
              res.write("data: [DONE]\n\n");
              res.end();
            }
            requestHandled = true;
            break;
          }

          if (!doneSent) {
            flushBufferedRetrySafePreludeChunks();
            writeDoneNow();
          }
          finishedAtMs = Date.now();
          if (requestedStream && !streamEndReason) {
            streamEndReason = sawResponseCompletedThisAttempt
              ? "completed"
              : "stream_ended_without_completed";
          }
          res.end();
          heartbeat?.stop();
          rememberStickyPromptAccountOverride(
            stickyPromptCacheKey,
            sourceAccount.id,
          );
          requestHandled = true;
          break;
        } catch (error) {
          heartbeat?.stop();
          const errorInfo = extractErrorInfo(error);
          streamErrorMessage = errorInfo.message;
          upstreamStatus = upstreamStatus ?? errorInfo.status;
          if (errorInfo.errorPayload) {
            lastErrorPayload = errorInfo.errorPayload;
          }
          const wasAborted = requestAbort.signal.aborted || isAbortError(error);
          const retryable =
            attemptNo < maxAttempts &&
            !wasAborted &&
            !sawFirstTextDeltaThisAttempt &&
            !sawNonRetryablePreTextOutputThisAttempt &&
            (isConnectionTimeoutError(error) || !sawResponseCompletedThisAttempt);
          if (retryable) {
            retryReason = isConnectionTimeoutError(error)
              ? "connection_timeout"
              : "stream_disconnected";
            markSourceAccountTransientFailure(
              sourceAccount.id,
              stickyPromptCacheKey,
            );
            await sleep(computeRetryDelayMs(attemptNo), requestAbort.signal);
            continue;
          }
          finishedAtMs = Date.now();
          if (wasAborted) {
            if (requestedStream && !streamEndReason) {
              streamEndReason = wroteChunkThisAttempt
                ? "client_aborted_after_partial"
                : "client_aborted_before_first_chunk";
            }
            requestHandled = true;
            break;
          }
          if (!sawResponseCompletedThisAttempt) {
            markSourceAccountTransientFailure(
              sourceAccount.id,
              stickyPromptCacheKey,
            );
          }
          if (requestedStream && !streamEndReason) {
            streamEndReason = wroteChunkThisAttempt
              ? "stream_proxy_error_after_partial"
              : "stream_proxy_error_before_first_chunk";
          }
          if (!res.writableEnded) {
            res.write(
              `data: ${JSON.stringify({
                error: {
                  message: streamErrorMessage,
                  type: "server_error",
                  code: "stream_error",
                },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }
          requestHandled = true;
          break;
        } finally {
          heartbeat?.stop();
          reader.releaseLock();
        }
      }

      if (!requestHandled && !res.headersSent) {
        if (requestedStream && !streamEndReason) {
          streamEndReason = "upstream_stream_failed_before_headers";
        }
        const passthroughError = buildPassthroughUpstreamError({
          status: upstreamStatus,
          errorPayload: lastErrorPayload,
          fallbackCode: "chat_completions_failed",
          fallbackMessage:
            streamErrorMessage ?? "Failed to proxy upstream response",
        });
        res.status(passthroughError.status).json({
          error: passthroughError.error,
        });
      }
    } catch (error) {
      const errorInfo = extractErrorInfo(error);
      streamErrorMessage = errorInfo.message;
      upstreamStatus = upstreamStatus ?? errorInfo.status;
      if (errorInfo.errorPayload) {
        lastErrorPayload = errorInfo.errorPayload;
      }
      finishedAtMs = Date.now();
      const wasAborted = requestAbort.signal.aborted || isAbortError(error);
      if (requestedStream && !streamEndReason) {
        streamEndReason = res.headersSent
          ? wasAborted
            ? "client_aborted_after_headers"
            : "stream_proxy_error_after_headers"
          : wasAborted
            ? "client_aborted_before_headers"
            : "stream_proxy_error_before_headers";
      }
      if (wasAborted) {
      } else if (!res.headersSent) {
        const passthroughError = buildPassthroughUpstreamError({
          status: upstreamStatus,
          errorPayload: lastErrorPayload,
          fallbackCode: "chat_completions_failed",
          fallbackMessage:
            streamErrorMessage ?? "Failed to proxy upstream response",
        });
        res.status(passthroughError.status).json({
          error: passthroughError.error,
        });
      } else if (!res.writableEnded) {
        const passthroughError = buildPassthroughUpstreamError({
          status: upstreamStatus,
          errorPayload: lastErrorPayload,
          fallbackCode: "chat_completions_failed",
          fallbackMessage:
            streamErrorMessage ?? "Failed to proxy upstream response",
        });
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: passthroughError.error.message,
              type: passthroughError.error.type,
              code: passthroughError.error.code,
            },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
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
          requestSucceeded: sawResponseCompleted,
        });
        const finalStreamEndReason = requestedStream
          ? (streamEndReason ??
            (sawResponseCompleted
              ? "completed"
              : (retryReason ?? (upstreamStatus ? `http_${upstreamStatus}` : null))))
          : null;
        await persistOpenAIResponseLog({
          deps,
          shouldPersist:
            !alreadyPersistedQuotaLog && shouldPersistModelResponseLog(req.path),
          path: req.path,
          intentId,
          attemptNo,
          isFinal: sawResponseCompleted,
          retryReason,
          heartbeatCount: requestedStream ? streamHeartbeatCount : null,
          streamEndReason: finalStreamEndReason,
          model,
          apiKeyId,
          serviceTier: serviceTierResult.value,
          statusCode: upstreamStatus ?? (res.headersSent ? res.statusCode : null),
          startedAtMs: startedAt,
          firstEventAtMs,
          finishedAtMs,
          usage: accounting.usage,
          cost: accounting.cost,
          fallbackErrorCode: streamErrorMessage ? "chat_completions_failed" : null,
          fallbackErrorMessage: streamErrorMessage,
        });
      } catch (error) {
        console.warn(
          `[logs] failed to write /v1/chat/completions log: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        requestAbort.cleanup();
      }
    }
  });
}
