import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type { OpenAIAccountRecord } from "../../../database/index.ts";
import * as openaiApiModule from "../../../openai-api/index.ts";
import {
  finalizeOpenAIRouteAccounting,
  getReadyActiveSourceAccount,
  persistOpenAIResponseLog,
  prepareOpenAIRouteRequest,
  type OpenAIResponsesRouteDependencies,
} from "../../services/openai/openai-route-services.ts";
import { forwardUpstreamResponse } from "../../services/openai/transparent-response-proxy.ts";
import { prepareResponsesPayload } from "../../services/openai/responses-format.ts";
import { getForwardRequestHeaders } from "../../utils/index.ts";
import { registerResponsesCompactRoute } from "./responses-compact-route.ts";

export function registerResponsesRoutes(
  app: Express,
  deps: OpenAIResponsesRouteDependencies,
) {
  app.post("/v1/responses", async (req: Request, res: Response) => {
    const startedAtMs = Date.now();
    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    const intentId = crypto.randomUUID();
    res.locals.intentId = intentId;
    const retryReason = null;
    const attemptNo = 1;
    const model =
      typeof requestBody.model === "string" && requestBody.model.trim()
        ? requestBody.model.trim()
        : null;
    const serviceTier = deps.resolvePriorityServiceTierForBilling(
      requestBody.service_tier,
    );
    const requestedStream = requestBody.stream !== false;
    const requestAbort = deps.createRequestAbortContext(req, res);

    let apiKeyId: string | null = null;
    let ownerUserId: string | null = null;
    let upstreamStatus: number | null = null;
    let firstEventAtMs: number | null = null;
    let finishedAtMs: number | null = null;
    let completedResponsePayload: Record<string, unknown> | null = null;
    let lastErrorPayload: Record<string, unknown> | null = null;
    let errorMessage: string | null = null;
    let sawCompleted = false;
    let alreadyPersistedQuotaLog = false;
    let activeSourceAccount: OpenAIAccountRecord | null = null;
    let internalErrorDetails: Record<string, unknown> | null = null;

    try {
      const preparedRequest = await prepareOpenAIRouteRequest({
        req,
        res,
        deps,
        intentId,
        attemptNo,
        retryReason,
        model,
        startedAtMs,
      });
      if (!preparedRequest.ok) {
        alreadyPersistedQuotaLog = preparedRequest.alreadyPersistedQuotaLog;
        apiKeyId = preparedRequest.apiKeyId ?? null;
        ownerUserId = preparedRequest.ownerUserId ?? null;
        return;
      }
      apiKeyId = preparedRequest.apiKeyId;
      ownerUserId = preparedRequest.ownerUserId;
      const payload = prepareResponsesPayload({
        requestBody,
        ownerUserId,
        apiKeyId,
      });

      const activeAccount = await getReadyActiveSourceAccount({ deps });
      if (!activeAccount.ok) {
        upstreamStatus = 503;
        res.status(503).json({
          error: {
            message: "No active upstream account",
            type: "server_error",
            code: "upstream_account_unavailable",
          },
        });
        return;
      }
      activeSourceAccount = activeAccount.sourceAccount;
      const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
      const upstream = await deps.postCodexResponsesWithTokenRefresh({
        module: openaiApiModule,
        account: activeSourceAccount,
        payload,
        requestHeaders: getForwardRequestHeaders(req.headers),
        runtimeConfig,
        signal: requestAbort.signal,
      });
      upstreamStatus = upstream.status;

      const observation = await forwardUpstreamResponse(upstream, res);
      firstEventAtMs = observation.firstByteAtMs;
      finishedAtMs = observation.finishedAtMs;
      completedResponsePayload = observation.completedResponsePayload;
      lastErrorPayload = observation.errorPayload;
      sawCompleted = observation.sawCompleted;
    } catch (error) {
      const errorInfo = deps.extractErrorInfo(error);
      upstreamStatus = upstreamStatus ?? errorInfo.status;
      errorMessage = errorInfo.message;
      lastErrorPayload = errorInfo.errorPayload ?? lastErrorPayload;
      finishedAtMs = Date.now();
      const wasAborted = requestAbort.signal.aborted || deps.isAbortError(error);
      if (!wasAborted) {
        internalErrorDetails = deps.buildInternalUpstreamErrorDetails({
          path: req.path,
          model,
          status: upstreamStatus,
          sourceAccount: activeSourceAccount,
          trace: null,
          errorInfo,
        });
      }
      if (!wasAborted && !res.headersSent) {
        const passthrough = deps.buildPassthroughUpstreamError({
          status: upstreamStatus,
          errorPayload: lastErrorPayload,
          fallbackCode: "responses_proxy_failed",
          fallbackMessage: errorMessage ?? "Failed to reach upstream Responses API",
        });
        res.status(passthrough.status).json({ error: passthrough.error });
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
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
          serviceTier,
          requestSucceeded: sawCompleted,
        });
        await persistOpenAIResponseLog({
          deps,
          shouldPersist:
            !alreadyPersistedQuotaLog && deps.shouldPersistModelResponseLog(req.path),
          path: req.path,
          intentId,
          attemptNo,
          isFinal: sawCompleted,
          retryReason,
          heartbeatCount: null,
          streamEndReason: requestedStream
            ? sawCompleted
              ? "completed"
              : errorMessage ?? (upstreamStatus ? `http_${upstreamStatus}` : null)
            : null,
          model,
          apiKeyId,
          serviceTier,
          statusCode: upstreamStatus ?? (res.headersSent ? res.statusCode : null),
          startedAtMs,
          firstEventAtMs,
          finishedAtMs,
          usage: accounting.usage,
          cost: accounting.cost,
          fallbackErrorCode: errorMessage ? "responses_proxy_failed" : null,
          fallbackErrorMessage: errorMessage,
          internalErrorDetails: sawCompleted ? null : internalErrorDetails,
        });
      } catch (error) {
        console.warn(
          `[logs] failed to write /v1/responses log: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        requestAbort.cleanup();
      }
    }
  });

  registerResponsesCompactRoute(app, deps);
}
