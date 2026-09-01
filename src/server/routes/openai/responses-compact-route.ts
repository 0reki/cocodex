import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
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

export function registerResponsesCompactRoute(
  app: Express,
  deps: OpenAIResponsesRouteDependencies,
) {
  app.post("/v1/responses/compact", async (req: Request, res: Response) => {
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
    const requestAbort = deps.createRequestAbortContext(req, res);

    let apiKeyId: string | null = null;
    let ownerUserId: string | null = null;
    let upstreamStatus: number | null = null;
    let firstEventAtMs: number | null = null;
    let finishedAtMs: number | null = null;
    let responsePayload: Record<string, unknown> | null = null;
    let lastErrorPayload: Record<string, unknown> | null = null;
    let errorMessage: string | null = null;
    let requestSucceeded = false;
    let alreadyPersistedQuotaLog = false;

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
        compact: true,
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
      const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
      const upstream = await deps.postCodexResponsesCompactWithTokenRefresh({
        module: openaiApiModule,
        account: activeAccount.sourceAccount,
        payload,
        requestHeaders: getForwardRequestHeaders(req.headers),
        runtimeConfig,
        signal: requestAbort.signal,
      });
      upstreamStatus = upstream.status;
      requestSucceeded = upstream.ok;

      const observation = await forwardUpstreamResponse(upstream, res);
      firstEventAtMs = observation.firstByteAtMs;
      finishedAtMs = observation.finishedAtMs;
      responsePayload = observation.responsePayload;
      lastErrorPayload = observation.errorPayload;
    } catch (error) {
      const errorInfo = deps.extractErrorInfo(error);
      upstreamStatus = upstreamStatus ?? errorInfo.status;
      errorMessage = errorInfo.message;
      lastErrorPayload = errorInfo.errorPayload ?? lastErrorPayload;
      finishedAtMs = Date.now();
      const wasAborted = requestAbort.signal.aborted || deps.isAbortError(error);
      if (!wasAborted && !res.headersSent) {
        const passthrough = deps.buildPassthroughUpstreamError({
          status: upstreamStatus,
          errorPayload: lastErrorPayload,
          fallbackCode: "responses_compact_proxy_failed",
          fallbackMessage:
            errorMessage ?? "Failed to reach upstream Responses Compact API",
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
          completedResponsePayload: responsePayload,
          lastErrorPayload,
          serviceTier,
          requestSucceeded,
        });
        await persistOpenAIResponseLog({
          deps,
          shouldPersist:
            !alreadyPersistedQuotaLog && deps.shouldPersistModelResponseLog(req.path),
          path: req.path,
          intentId,
          attemptNo,
          isFinal: requestSucceeded,
          retryReason,
          model,
          apiKeyId,
          serviceTier,
          statusCode: upstreamStatus ?? (res.headersSent ? res.statusCode : null),
          startedAtMs,
          firstEventAtMs,
          finishedAtMs,
          usage: accounting.usage,
          cost: accounting.cost,
          fallbackErrorCode: errorMessage
            ? "responses_compact_proxy_failed"
            : null,
          fallbackErrorMessage: errorMessage,
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
