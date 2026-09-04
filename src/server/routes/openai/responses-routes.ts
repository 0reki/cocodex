import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import * as openaiApiModule from "../../../openai-api/index.ts";
import {
  finalizeOpenAIRouteAccounting,
  getReadyAssignedSourceAccount,
  persistOpenAIResponseLog,
  prepareOpenAIRouteRequest,
  type OpenAIResponsesRouteDependencies,
} from "../../services/openai/openai-route-services.ts";
import {
  forwardUpstreamResponse,
  type ResponseTerminalStatus,
} from "../../services/openai/transparent-response-proxy.ts";
import { prepareResponsesPayload } from "../../services/openai/responses-format.ts";
import { getForwardRequestHeaders } from "../../utils/index.ts";

export function registerResponsesRoutes(
  app: Express,
  deps: OpenAIResponsesRouteDependencies,
) {
  app.post("/v1/responses", async (req: Request, res: Response) => {
    const startedAtMs = Date.now();
    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    const intentId = crypto.randomUUID();
    res.locals.intentId = intentId;
    const model =
      typeof requestBody.model === "string" && requestBody.model.trim()
        ? requestBody.model.trim()
        : null;
    const serviceTier = deps.resolveFastServiceTierForBilling(
      requestBody.service_tier,
    );
    const pricingModelId = deps.resolveUsagePricingModelId(model, requestBody);
    const requestAbort = deps.createRequestAbortContext(req, res);

    let apiKeyId: string | null = null;
    let ownerUserId: string | null = null;
    let upstreamStatus: number | null = null;
    let firstEventAtMs: number | null = null;
    let finishedAtMs: number | null = null;
    let terminalResponsePayload: Record<string, unknown> | null = null;
    let terminalStatus: ResponseTerminalStatus | null = null;
    let lastErrorPayload: Record<string, unknown> | null = null;
    let errorMessage: string | null = null;
    let alreadyPersistedQuotaLog = false;
    let terminalSettlementPersisted = false;
    let quotaSourceAccount: Parameters<
      OpenAIResponsesRouteDependencies["ensureUserUpstreamQuota"]
    >[0]["sourceAccount"] | null = null;
    let upstreamRequestStarted = false;
    let upstreamQuotaRejected = false;

    try {
      const preparedRequest = await prepareOpenAIRouteRequest({
        req,
        res,
        deps,
        intentId,
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
      if (requestBody.stream !== true) {
        await deps.persistShortCircuitErrorLog({
          requestPath: req.path,
          intentId,
          model,
          keyId: apiKeyId,
          startedAtMs,
          statusCode: 400,
          errorCode: "streaming_required",
          errorMessage: "Only streaming Responses requests are supported",
        });
        alreadyPersistedQuotaLog = true;
        res.status(400).json({
          error: {
            message: "Only streaming Responses requests are supported; set stream to true",
            type: "invalid_request_error",
            code: "streaming_required",
            param: "stream",
          },
        });
        return;
      }
      const payload = prepareResponsesPayload({
        requestBody,
        ownerUserId,
        apiKeyId,
      });

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
      quotaSourceAccount = assignedAccount.sourceAccount;
      const quota = await deps.ensureUserUpstreamQuota({
        sourceAccount: assignedAccount.sourceAccount,
        ownerUserId,
        model,
      });
      if (!quota.allowed) {
        upstreamQuotaRejected = true;
        upstreamStatus = 429;
        errorMessage = "Upstream weekly user quota exceeded";
        res.status(429).json({
          error: {
            message: errorMessage,
            type: "insufficient_quota",
            code: "upstream_user_quota_exceeded",
          },
        });
        return;
      }
      const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
      upstreamRequestStarted = true;
      const upstream = await deps.postCodexResponsesWithTokenRefresh({
        module: openaiApiModule,
        account: assignedAccount.sourceAccount,
        payload,
        requestHeaders: getForwardRequestHeaders(req.headers),
        runtimeConfig,
        signal: requestAbort.signal,
      });
      upstreamStatus = upstream.status;

      const observation = await forwardUpstreamResponse(upstream, res, {
        expectEventStream: upstream.ok,
        onTerminalResponse: async (terminal) => {
          firstEventAtMs = terminal.firstByteAtMs;
          finishedAtMs = Date.now();
          terminalResponsePayload = terminal.terminalResponsePayload;
          terminalStatus = terminal.terminalStatus;
          lastErrorPayload = terminal.errorPayload;
          const accounting = finalizeOpenAIRouteAccounting({
            deps,
            apiKeyId,
            model,
            pricingModelId,
            usageResponsePayload: terminal.terminalResponsePayload,
            lastErrorPayload: terminal.errorPayload,
            serviceTier,
          });
          const completed = terminal.terminalStatus === "completed";
          await persistOpenAIResponseLog({
            deps,
            shouldPersist:
              !alreadyPersistedQuotaLog &&
              deps.shouldPersistModelResponseLog(req.path),
            path: req.path,
            intentId,
            isFinal: completed,
            streamEndReason: terminal.terminalStatus,
            model,
            apiKeyId,
            ownerUserId,
            charge: accounting.charge,
            serviceTier,
            statusCode: upstreamStatus,
            startedAtMs,
            firstEventAtMs: terminal.firstByteAtMs,
            finishedAtMs,
            usage: accounting.usage,
            cost: accounting.cost,
            fallbackErrorCode: completed
              ? null
              : `response_${terminal.terminalStatus}`,
            fallbackErrorMessage: completed
              ? null
              : `Responses stream ended with status ${terminal.terminalStatus}`,
          });
          terminalSettlementPersisted = true;
        },
      });
      firstEventAtMs = observation.firstByteAtMs;
      finishedAtMs = observation.finishedAtMs;
      terminalResponsePayload = observation.terminalResponsePayload;
      terminalStatus = observation.terminalStatus;
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
          fallbackCode: "responses_proxy_failed",
          fallbackMessage: errorMessage ?? "Failed to reach upstream Responses API",
        });
        res.status(passthrough.status).json({ error: passthrough.error });
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      let accounting: ReturnType<typeof finalizeOpenAIRouteAccounting> | null =
        null;
      try {
        accounting = finalizeOpenAIRouteAccounting({
          deps,
          apiKeyId,
          model,
          pricingModelId,
          usageResponsePayload: terminalResponsePayload,
          lastErrorPayload,
          serviceTier,
        });
        const completed = terminalStatus === "completed";
        const protocolFailure =
          terminalStatus && !completed ? `response_${terminalStatus}` : null;
        const endedBeforeTerminal =
          !terminalStatus &&
          !errorMessage &&
          upstreamStatus !== null &&
          upstreamStatus >= 200 &&
          upstreamStatus < 300;
        const streamEndReason =
          terminalStatus ??
          errorMessage ??
          (endedBeforeTerminal
            ? "upstream_eof_before_terminal"
            : upstreamStatus
              ? `http_${upstreamStatus}`
              : null);
        await persistOpenAIResponseLog({
          deps,
          shouldPersist:
            !terminalSettlementPersisted &&
            !alreadyPersistedQuotaLog &&
            deps.shouldPersistModelResponseLog(req.path),
          path: req.path,
          intentId,
          isFinal: completed,
          streamEndReason,
          model,
          apiKeyId,
          ownerUserId,
          charge: accounting.charge,
          serviceTier,
          statusCode: upstreamStatus ?? (res.headersSent ? res.statusCode : null),
          startedAtMs,
          firstEventAtMs,
          finishedAtMs,
          usage: accounting.usage,
          cost: accounting.cost,
          fallbackErrorCode:
            upstreamQuotaRejected
              ? "upstream_user_quota_exceeded"
              : protocolFailure ??
                (endedBeforeTerminal
                  ? "upstream_eof_before_terminal"
                  : errorMessage
                    ? "responses_proxy_failed"
                    : null),
          fallbackErrorMessage:
            errorMessage ??
            (protocolFailure
              ? `Responses stream ended with status ${terminalStatus}`
              : endedBeforeTerminal
                ? "Responses stream ended before a terminal event"
                : null),
        });
      } catch (error) {
        deps.cancelResponseRequestReservation(intentId);
        console.warn(
          `[logs] failed to write /v1/responses log: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        accounting &&
        upstreamRequestStarted &&
        quotaSourceAccount &&
        ownerUserId
      ) {
        try {
          await deps.settleUserUpstreamQuota({
            settlementId: intentId,
            sourceAccount: quotaSourceAccount,
            ownerUserId,
            model,
            cost: accounting.cost,
            totalTokens: accounting.usage.totalTokens,
          });
        } catch (error) {
          console.warn(
            `[quota] failed to settle /v1/responses usage: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      requestAbort.cleanup();
    }
  });
}
