import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import * as openaiApiModule from "../../../openai-api/index.ts";
import type { ServerServices } from "../../bootstrap/services.ts";
import {
  finalizeOpenAIRouteAccounting,
  getReadyAssignedSourceAccount,
  persistOpenAIResponseLog,
  prepareOpenAIRouteRequest,
  type ActiveSourceAccountDependencies,
  type OpenAIAccountingDependencies,
  type OpenAIRequestPreparationDependencies,
  type OpenAIResponseLogDependencies,
} from "../../services/openai/openai-route-services.ts";
import { forwardUpstreamResponse } from "../../services/openai/transparent-response-proxy.ts";
import { getForwardRequestHeaders } from "../../utils/index.ts";

type ImageOperation = "generations" | "edits";

type ImageRouteDependencies = OpenAIRequestPreparationDependencies &
  ActiveSourceAccountDependencies &
  OpenAIAccountingDependencies &
  OpenAIResponseLogDependencies &
  Pick<
    ServerServices,
    | "createRequestAbortContext"
    | "getOpenAIApiRuntimeConfig"
    | "postCodexImageWithTokenRefresh"
    | "extractErrorInfo"
    | "isAbortError"
    | "buildPassthroughUpstreamError"
    | "shouldPersistModelResponseLog"
  >;

export function registerImageRoutes(
  app: Express,
  deps: ImageRouteDependencies,
) {
  const register = (path: string, operation: ImageOperation) => {
    app.post(path, async (req: Request, res: Response) => {
      const startedAtMs = Date.now();
      const requestBody = (req.body ?? {}) as Record<string, unknown>;
      const intentId = crypto.randomUUID();
      const model =
        typeof requestBody.model === "string" && requestBody.model.trim()
          ? requestBody.model.trim()
          : null;
      const requestAbort = deps.createRequestAbortContext(req, res);
      res.locals.intentId = intentId;

      let apiKeyId: string | null = null;
      let ownerUserId: string | null = null;
      let upstreamStatus: number | null = null;
      let firstByteAtMs: number | null = null;
      let finishedAtMs: number | null = null;
      let responsePayload: Record<string, unknown> | null = null;
      let errorPayload: Record<string, unknown> | null = null;
      let errorMessage: string | null = null;
      let requestSucceeded = false;
      let alreadyPersistedQuotaLog = false;

      try {
        const preparedRequest = await prepareOpenAIRouteRequest({
          req,
          res,
          deps,
          intentId,
          model,
          startedAtMs,
          billable: false,
        });
        if (!preparedRequest.ok) {
          alreadyPersistedQuotaLog = preparedRequest.alreadyPersistedQuotaLog;
          apiKeyId = preparedRequest.apiKeyId ?? null;
          ownerUserId = preparedRequest.ownerUserId ?? null;
          return;
        }
        apiKeyId = preparedRequest.apiKeyId;
        ownerUserId = preparedRequest.ownerUserId;

        const assignedAccount = await getReadyAssignedSourceAccount({
          deps,
          ownerUserId,
        });
        if (!assignedAccount.ok) {
          upstreamStatus = 403;
          res.status(403).json({
            error: {
              message: "No upstream account assigned",
              type: "invalid_request_error",
              code: "upstream_account_unassigned",
            },
          });
          return;
        }
        const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
        const upstream = await deps.postCodexImageWithTokenRefresh({
          module: openaiApiModule,
          account: assignedAccount.sourceAccount,
          operation,
          payload: requestBody,
          requestHeaders: getForwardRequestHeaders(req.headers),
          runtimeConfig,
          signal: requestAbort.signal,
        });
        upstreamStatus = upstream.status;
        const observation = await forwardUpstreamResponse(upstream, res, {
          jsonTailBytes: 256 * 1024,
        });
        firstByteAtMs = observation.firstByteAtMs;
        finishedAtMs = observation.finishedAtMs;
        responsePayload = observation.responsePayload;
        errorPayload = observation.errorPayload;
        requestSucceeded = upstream.ok;
      } catch (error) {
        const errorInfo = deps.extractErrorInfo(error);
        upstreamStatus = upstreamStatus ?? errorInfo.status;
        errorMessage = errorInfo.message;
        errorPayload = errorInfo.errorPayload ?? errorPayload;
        finishedAtMs = Date.now();
        const wasAborted = requestAbort.signal.aborted || deps.isAbortError(error);
        if (!wasAborted && !res.headersSent) {
          const passthrough = deps.buildPassthroughUpstreamError({
            status: upstreamStatus,
            errorPayload,
            fallbackCode: "image_proxy_failed",
            fallbackMessage: errorMessage ?? "Failed to reach upstream Images API",
          });
          res.status(passthrough.status).json({ error: passthrough.error });
        } else if (!res.writableEnded) {
          res.end();
        }
      } finally {
        try {
          const accounting = finalizeOpenAIRouteAccounting({
            deps,
            apiKeyId,
            model,
            usageResponsePayload: responsePayload,
            lastErrorPayload: errorPayload,
            serviceTier: null,
            billable: false,
          });
          persistOpenAIResponseLog({
            deps,
            shouldPersist:
              !alreadyPersistedQuotaLog &&
              deps.shouldPersistModelResponseLog(req.path),
            path: req.path,
            intentId,
            isFinal: requestSucceeded,
            streamEndReason: requestSucceeded
              ? "completed"
              : errorMessage ??
                (upstreamStatus ? `http_${upstreamStatus}` : null),
            model,
            apiKeyId,
            ownerUserId,
            charge: accounting.charge,
            serviceTier: null,
            statusCode:
              upstreamStatus ?? (res.headersSent ? res.statusCode : null),
            startedAtMs,
            firstEventAtMs: firstByteAtMs,
            finishedAtMs,
            usage: accounting.usage,
            cost: accounting.cost,
            fallbackErrorCode: errorMessage ? "image_proxy_failed" : null,
            fallbackErrorMessage: errorMessage,
          });
        } catch (error) {
          deps.cancelResponseRequestReservation(intentId);
          console.warn(
            `[logs] failed to write ${req.path} log: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        requestAbort.cleanup();
      }
    });
  };

  register("/v1/images/generations", "generations");
  register("/v1/images/edits", "edits");
}
