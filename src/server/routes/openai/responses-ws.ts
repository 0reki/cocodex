import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import * as openaiApiModule from "../../../openai-api/index.ts";
import type {
  isRecord,
  parseJsonRecordText,
} from "../../openai-response-utils.ts";
import type { sendWsErrorEvent } from "../../bootstrap/helpers.ts";
import type { ServerServices } from "../../bootstrap/services.ts";
import {
  getReadyAssignedSourceAccount,
  type ActiveSourceAccountDependencies,
} from "../../services/openai/openai-route-services.ts";
import type { ResponseTerminalStatus } from "../../services/openai/transparent-response-proxy.ts";
import type {
  WsRawData,
  WsSocket,
} from "../../utils/network/ws.ts";
import type {
  applyServiceTierBillingMultiplier,
  normalizeWsCloseCode,
  normalizeWsCloseReason,
  resolveFastServiceTierForBilling,
  wsRawDataToText,
} from "../../utils/index.ts";
import { getForwardRequestHeaders } from "../../utils/index.ts";

type FastServiceTier = ReturnType<
  typeof resolveFastServiceTierForBilling
>;

type PrepareResponsesWebSocketDependencies =
  ActiveSourceAccountDependencies &
    Pick<
      ServerServices,
      | "authenticateApiKeyByAuthorizationHeaderWithReason"
      | "getApiKeyAuthErrorDetail"
      | "isApiKeyQuotaExceeded"
      | "isApiKeyBoundToUser"
      | "ensureUserBillingAllowanceOrNull"
      | "isUserBillingAllowanceExceeded"
      | "getOpenAIApiRuntimeConfig"
      | "connectResponsesWebSocketProxyUpstream"
      | "extractErrorInfo"
      | "buildPassthroughUpstreamError"
    > & {
      resolveFastServiceTierForBilling: typeof resolveFastServiceTierForBilling;
      isRecord: typeof isRecord;
    };

type ResponsesWebSocketProxyDependencies = Pick<
  ServerServices,
  | "shouldPersistModelResponseLog"
  | "extractResponseUsage"
  | "estimateUsageCost"
  | "resolveUsagePricingModelId"
  | "enqueueResponseSettlement"
  | "tryReserveResponseRequest"
  | "cancelResponseRequestReservation"
  | "ensureUserUpstreamQuota"
  | "settleUserUpstreamQuota"
> & {
  applyServiceTierBillingMultiplier: typeof applyServiceTierBillingMultiplier;
  normalizeWsCloseCode: typeof normalizeWsCloseCode;
  normalizeWsCloseReason: typeof normalizeWsCloseReason;
  resolveFastServiceTierForBilling: typeof resolveFastServiceTierForBilling;
  sendWsErrorEvent: typeof sendWsErrorEvent;
  wsRawDataToText: typeof wsRawDataToText;
  parseJsonRecordText: typeof parseJsonRecordText;
  isRecord: typeof isRecord;
  WS_READY_STATE_OPEN: number;
  WS_READY_STATE_CONNECTING: number;
};

type ResponsesWebSocketProxyContext = {
  apiKeyId: string;
  ownerUserId: string | null;
  serviceTier: FastServiceTier;
  startedAtMs: number;
  upstreamSocket: WsSocket;
  upstreamResponseHeaders: Record<string, string>;
  sourceAccount: Parameters<
    ServerServices["ensureUserUpstreamQuota"]
  >[0]["sourceAccount"];
};

export class ResponsesWebSocketUpgradeError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>, isRecord: (value: unknown) => value is Record<string, unknown>) {
    super(
      isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : "WebSocket upgrade rejected",
    );
    this.name = "ResponsesWebSocketUpgradeError";
    this.status = status;
    this.payload = payload;
  }
}

export async function prepareResponsesWebSocketProxyContext(
  deps: PrepareResponsesWebSocketDependencies,
  request: IncomingMessage,
): Promise<ResponsesWebSocketProxyContext> {
  const startedAtMs = Date.now();
  const requestUrl = new URL(request.url ?? "/v1/responses", "http://localhost");
  const requestedServiceTier = deps.resolveFastServiceTierForBilling(
    requestUrl.searchParams.get("service_tier"),
  );
  const { apiKey, reason: apiKeyAuthFailureReason } =
    await deps.authenticateApiKeyByAuthorizationHeaderWithReason(
      request.headers.authorization,
    );
  if (!apiKey) {
    const authError = deps.getApiKeyAuthErrorDetail(apiKeyAuthFailureReason);
    throw new ResponsesWebSocketUpgradeError(
      401,
      {
        error: {
          message: authError.message,
          type: "invalid_request_error",
          code: authError.code,
        },
      },
      deps.isRecord,
    );
  }
  if (deps.isApiKeyQuotaExceeded(apiKey)) {
    throw new ResponsesWebSocketUpgradeError(
      429,
      {
        error: {
          message: "API key quota exceeded",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      },
      deps.isRecord,
    );
  }
  if (!deps.isApiKeyBoundToUser(apiKey)) {
    throw new ResponsesWebSocketUpgradeError(
      403,
      {
        error: {
          message: "API key must be bound to a user for billing enforcement",
          type: "invalid_request_error",
          code: "api_key_owner_missing",
        },
      },
      deps.isRecord,
    );
  }

  const ownerUserId = apiKey.ownerUserId;

  try {
    if (ownerUserId) {
      const allowance = await deps.ensureUserBillingAllowanceOrNull(ownerUserId);
      if (
        !allowance ||
        deps.isUserBillingAllowanceExceeded(ownerUserId)
      ) {
        throw new ResponsesWebSocketUpgradeError(
          429,
          {
            error: {
              message: "Billing quota exceeded",
              type: "insufficient_quota",
              code: "insufficient_quota",
            },
          },
          deps.isRecord,
        );
      }
    }

    const assignedAccount = await getReadyAssignedSourceAccount({
      deps,
      ownerUserId,
    });
    if (!assignedAccount.ok) {
      throw new ResponsesWebSocketUpgradeError(
        403,
        {
          error: {
            message: "No upstream account assigned",
            type: "invalid_request_error",
            code: "upstream_account_unassigned",
          },
        },
        deps.isRecord,
      );
    }
    const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
    if (typeof openaiApiModule.connectCodexResponsesWebSocket !== "function") {
      throw new ResponsesWebSocketUpgradeError(
        500,
        {
          error: {
            message:
              "connectCodexResponsesWebSocket is not exported from the internal OpenAI module",
            type: "server_error",
            code: "missing_openai_api_export",
          },
        },
        deps.isRecord,
      );
    }

    let upstreamConnection: Awaited<
      ReturnType<
        PrepareResponsesWebSocketDependencies["connectResponsesWebSocketProxyUpstream"]
      >
    > | null = null;
    let lastError: unknown = null;
    try {
      upstreamConnection = await deps.connectResponsesWebSocketProxyUpstream({
        openaiApiModule,
        account: assignedAccount.sourceAccount,
        runtimeConfig,
        requestHeaders: getForwardRequestHeaders(request.headers),
        query: requestUrl.search,
      });
    } catch (error) {
      lastError = error;
    }

    if (!upstreamConnection) {
      const errorInfo = deps.extractErrorInfo(lastError);
      const passthrough = deps.buildPassthroughUpstreamError({
        status: errorInfo.status,
        errorPayload: errorInfo.errorPayload,
        fallbackCode: "responses_websocket_connect_failed",
        fallbackMessage:
          errorInfo.message ?? "Failed to connect upstream responses websocket",
      });
      throw new ResponsesWebSocketUpgradeError(
        passthrough.status,
        { error: passthrough.error },
        deps.isRecord,
      );
    }

    return {
      apiKeyId: apiKey.id,
      ownerUserId,
      serviceTier: requestedServiceTier,
      startedAtMs,
      upstreamSocket: upstreamConnection.upstreamSocket,
      upstreamResponseHeaders: upstreamConnection.responseHeaders,
      sourceAccount: assignedAccount.sourceAccount,
    };
  } catch (error) {
    throw error;
  }
}

export function setupResponsesWebSocketProxy(
  deps: ResponsesWebSocketProxyDependencies,
  args: {
    clientSocket: WsSocket;
    upstreamSocket: WsSocket;
    context: ResponsesWebSocketProxyContext;
  },
) {
  const { clientSocket, upstreamSocket, context } = args;
  const terminalResponseIds = new Set<string>();
  const wsIntentId = crypto.randomUUID();
  let sawTerminalResponse = false;
  let lastRequestedModel: string | null = null;
  let activeTurnStartedAtMs: number | null = null;
  let activeTurnFirstEventAtMs: number | null = null;
  let turnSeq = 0;
  const pendingTurns: Array<{
    intentId: string;
    serviceTier: FastServiceTier;
    pricingModelId: string | null;
  }> = [];
  const responseServiceTierById = new Map<string, FastServiceTier>();
  const responsePricingModelIdById = new Map<string, string | null>();
  const responseReservationIdById = new Map<string, string>();
  const activeReservationIds = new Set<string>();
  let closeSource:
    | "client_closed"
    | "upstream_closed"
    | "client_error"
    | "upstream_error"
    | "forward_failed"
    | "upstream_unavailable"
    | null = null;
  let closeCode: number | null = null;
  let closeReason = "";
  let finalized = false;
  let quotaBlocked = false;
  let quotaSettlementPending = Promise.resolve();
  let clientMessageQueue = Promise.resolve();
  let upstreamMessageQueue = Promise.resolve();

  const getCurrentTurnStartedAtMs = () =>
    activeTurnStartedAtMs ?? context.startedAtMs;
  const getCurrentTurnIntentId = () =>
    `${wsIntentId}:${Math.max(1, turnSeq)}`;

  const persistWsFailureLog = (
    failureCode: string,
    failureMessage: string,
    reservationId = getCurrentTurnIntentId(),
  ) => {
    if (!deps.shouldPersistModelResponseLog("/v1/responses")) {
      deps.cancelResponseRequestReservation(reservationId);
      return;
    }
    try {
      const startedAtMs = getCurrentTurnStartedAtMs();
      void deps.enqueueResponseSettlement({
        settlementId: reservationId,
        reservationId,
        intentId: reservationId,
        ownerUserId: context.ownerUserId,
        apiKeyId: context.apiKeyId,
        isFinal: false,
        streamEndReason:
          closeSource ?? "responses_websocket_closed_without_completed",
        path: "/v1/responses",
        modelId: lastRequestedModel,
        serviceTier: context.serviceTier,
        statusCode: closeCode ?? 502,
        ttfbMs:
          activeTurnFirstEventAtMs === null
            ? null
            : Math.max(0, activeTurnFirstEventAtMs - startedAtMs),
        latencyMs: Math.max(0, Date.now() - startedAtMs),
        errorCode: failureCode,
        errorMessage: failureMessage,
        requestTime: new Date(startedAtMs).toISOString(),
      }).catch((error) => {
        deps.cancelResponseRequestReservation(reservationId);
        console.warn(
          `[responses-ws] failed to queue failure settlement: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } catch (error) {
      deps.cancelResponseRequestReservation(reservationId);
      console.warn(
        `[responses-ws] failed to create failure settlement: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const persistWsTerminalLog = async (
    payload: Record<string, unknown>,
    modelId: string | null,
    pricingModelId: string | null,
    serviceTier: FastServiceTier,
    responseId: string,
    reservationId: string,
    terminalStatus: ResponseTerminalStatus,
    errorCode: string | null,
    errorMessage: string | null,
  ) => {
    const startedAtMs = getCurrentTurnStartedAtMs();
    const { tokensInfo, totalTokens } = deps.extractResponseUsage({
      response: payload,
    });
    const billedModelId = pricingModelId ?? modelId;
    const cost = deps.applyServiceTierBillingMultiplier(
      deps.estimateUsageCost(billedModelId, tokensInfo),
      serviceTier,
      billedModelId,
    );
    const settlementId = responseId || reservationId;
    if (!deps.shouldPersistModelResponseLog("/v1/responses")) {
      deps.cancelResponseRequestReservation(reservationId);
      return { settlementId, cost, totalTokens };
    }
    await deps.enqueueResponseSettlement({
      settlementId,
      reservationId,
      intentId: reservationId,
      ownerUserId: context.ownerUserId,
      apiKeyId: context.apiKeyId,
      charge: typeof cost === "bigint" && cost > 0n ? cost : 0n,
      isFinal: terminalStatus === "completed",
      streamEndReason: terminalStatus,
      path: "/v1/responses",
      modelId,
      serviceTier,
      statusCode: 200,
      ttfbMs:
        activeTurnFirstEventAtMs === null
          ? null
          : Math.max(0, activeTurnFirstEventAtMs - startedAtMs),
      latencyMs: Math.max(0, Date.now() - startedAtMs),
      tokensInfo,
      totalTokens,
      cost,
      errorCode,
      errorMessage,
      requestTime: new Date(startedAtMs).toISOString(),
    });
    return { settlementId, cost, totalTokens };
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (activeReservationIds.size > 0) {
      for (const reservationId of activeReservationIds) {
        persistWsFailureLog(
          "responses_websocket_closed_without_completed",
          closeReason || "Responses websocket closed before completion",
          reservationId,
        );
      }
      activeReservationIds.clear();
    } else if (!sawTerminalResponse) {
      persistWsFailureLog(
        "responses_websocket_closed_without_completed",
        closeReason || "Responses websocket closed before completion",
      );
    }
  };

  const closeClientSocket = (code: number, reason: string) => {
    if (
      clientSocket.readyState === deps.WS_READY_STATE_OPEN ||
      clientSocket.readyState === deps.WS_READY_STATE_CONNECTING
    ) {
      clientSocket.close(
        deps.normalizeWsCloseCode(code, 1000),
        deps.normalizeWsCloseReason(reason),
      );
    }
  };

  const closeUpstreamSocket = (code: number, reason: string) => {
    if (
      upstreamSocket.readyState === deps.WS_READY_STATE_OPEN ||
      upstreamSocket.readyState === deps.WS_READY_STATE_CONNECTING
    ) {
      upstreamSocket.close(
        deps.normalizeWsCloseCode(code, 1000),
        deps.normalizeWsCloseReason(reason),
      );
    }
  };

  const forwardMessage = (
    source: WsSocket,
    target: WsSocket,
    data: WsRawData,
    isBinary: boolean,
    onError: (error: Error) => void,
  ) => {
    let paused = false;
    try {
      target.send(data, { binary: isBinary }, (error?: Error) => {
        if (paused && source.readyState === deps.WS_READY_STATE_OPEN) {
          source.resume();
        }
        if (error) onError(error);
      });
      if (
        target.bufferedAmount > 0 &&
        source.readyState === deps.WS_READY_STATE_OPEN
      ) {
        paused = true;
        source.pause();
      }
    } catch (error) {
      if (paused && source.readyState === deps.WS_READY_STATE_OPEN) {
        source.resume();
      }
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const maybeSettleTerminalUsage = async (parsed: Record<string, unknown>) => {
    if (parsed.type === "response.created" && deps.isRecord(parsed.response)) {
      const response = parsed.response as Record<string, unknown>;
      if (typeof response.model === "string" && response.model.trim()) {
        lastRequestedModel = response.model.trim();
      }
      const responseId =
        typeof response.id === "string" ? response.id.trim() : "";
      if (responseId) {
        const pendingTurn = pendingTurns.shift();
        const responseTier =
          deps.resolveFastServiceTierForBilling(response.service_tier) ??
          pendingTurn?.serviceTier ??
          context.serviceTier;
        responseServiceTierById.set(responseId, responseTier);
        if (pendingTurn) {
          responseReservationIdById.set(responseId, pendingTurn.intentId);
          responsePricingModelIdById.set(
            responseId,
            pendingTurn.pricingModelId,
          );
        }
      }
    }

    let terminalPayload: Record<string, unknown> | null = null;
    let terminalStatus: ResponseTerminalStatus | null = null;
    if (parsed.type === "response.completed" && deps.isRecord(parsed.response)) {
      terminalPayload = parsed.response as Record<string, unknown>;
      terminalStatus = "completed";
    } else if (
      parsed.type === "response.done" &&
      deps.isRecord(parsed.response)
    ) {
      terminalPayload = parsed.response as Record<string, unknown>;
      terminalStatus = "completed";
    } else if (
      (parsed.type === "response.failed" ||
        parsed.type === "response.incomplete" ||
        parsed.type === "response.cancelled") &&
      deps.isRecord(parsed.response)
    ) {
      terminalPayload = parsed.response as Record<string, unknown>;
      terminalStatus =
        parsed.type === "response.failed"
          ? "failed"
          : parsed.type === "response.incomplete"
            ? "incomplete"
            : "cancelled";
    } else if (parsed.object === "response" && parsed.status === "completed") {
      terminalPayload = parsed;
      terminalStatus = "completed";
    } else if (
      parsed.object === "response" &&
      (parsed.status === "failed" ||
        parsed.status === "incomplete" ||
        parsed.status === "cancelled")
    ) {
      terminalPayload = parsed;
      terminalStatus = parsed.status;
    } else if (parsed.type === "error") {
      terminalPayload = parsed;
      terminalStatus = "error";
    }
    if (!terminalPayload || !terminalStatus) return;

    const responseId =
      typeof terminalPayload.id === "string"
        ? terminalPayload.id.trim()
        : typeof parsed.response_id === "string"
          ? parsed.response_id.trim()
          : "";
    if (responseId) {
      if (terminalResponseIds.has(responseId)) return;
      terminalResponseIds.add(responseId);
    }

    const modelId =
      typeof terminalPayload.model === "string" && terminalPayload.model.trim()
        ? terminalPayload.model.trim()
        : lastRequestedModel;
    const pendingTurn =
      responseId && responseReservationIdById.has(responseId)
        ? null
        : pendingTurns.shift();
    let billedServiceTier = deps.resolveFastServiceTierForBilling(
      terminalPayload.service_tier,
    );
    if (billedServiceTier === null && responseId) {
      billedServiceTier = responseServiceTierById.get(responseId) ?? null;
    }
    if (billedServiceTier === null) {
      billedServiceTier = pendingTurn?.serviceTier ?? null;
    }
    billedServiceTier ??= context.serviceTier;
    const pricingModelId =
      (responseId ? responsePricingModelIdById.get(responseId) : null) ??
      pendingTurn?.pricingModelId ??
      modelId;
    const reservationId =
      (responseId ? responseReservationIdById.get(responseId) : null) ??
      pendingTurn?.intentId ??
      getCurrentTurnIntentId();
    if (responseId) {
      responseServiceTierById.delete(responseId);
      responsePricingModelIdById.delete(responseId);
      responseReservationIdById.delete(responseId);
    }
    activeReservationIds.delete(reservationId);
    sawTerminalResponse = true;
    const errorPayload = deps.isRecord(terminalPayload.error)
      ? terminalPayload.error
      : terminalPayload;
    const incompleteDetails = deps.isRecord(terminalPayload.incomplete_details)
      ? terminalPayload.incomplete_details
      : null;
    const incompleteReason =
      incompleteDetails && typeof incompleteDetails.reason === "string"
        ? incompleteDetails.reason.trim()
        : "";
    const errorCode =
      terminalStatus === "completed"
        ? null
        : typeof errorPayload.code === "string" && errorPayload.code.trim()
          ? errorPayload.code.trim()
          : `response_${terminalStatus}`;
    const errorMessage =
      terminalStatus === "completed"
        ? null
        : typeof errorPayload.message === "string" &&
            errorPayload.message.trim()
          ? errorPayload.message.trim()
          : incompleteReason ||
            `Responses websocket turn ended with status ${terminalStatus}`;
    const quotaUsage = await persistWsTerminalLog(
      terminalPayload,
      modelId,
      pricingModelId,
      billedServiceTier,
      responseId,
      reservationId,
      terminalStatus,
      errorCode,
      errorMessage,
    );
    if (quotaUsage && context.ownerUserId) {
      const ownerUserId = context.ownerUserId;
      quotaSettlementPending = quotaSettlementPending.then(async () => {
        try {
          const quota = await deps.settleUserUpstreamQuota({
            settlementId: quotaUsage.settlementId,
            sourceAccount: context.sourceAccount,
            ownerUserId,
            model: modelId,
            cost: quotaUsage.cost,
            totalTokens: quotaUsage.totalTokens,
          });
          if (quota.allowed) return;
          quotaBlocked = true;
          deps.sendWsErrorEvent(clientSocket, {
            status: 429,
            error: {
              message: "Upstream weekly user quota exceeded",
              type: "insufficient_quota",
              code: "upstream_user_quota_exceeded",
            },
          });
          closeClientSocket(1008, "upstream_user_quota_exceeded");
          closeUpstreamSocket(1008, "upstream_user_quota_exceeded");
        } catch (error) {
          console.warn(
            `[quota] failed to settle websocket usage: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    }
  };

  const handleClientMessage = async (
    data: WsRawData,
    isBinary: boolean,
  ) => {
    if (upstreamSocket.readyState !== deps.WS_READY_STATE_OPEN) {
      deps.sendWsErrorEvent(clientSocket, {
        status: 503,
        error: {
          message: "Upstream websocket is unavailable",
          type: "server_error",
          code: "upstream_websocket_unavailable",
        },
      });
      closeClientSocket(1011, "upstream_unavailable");
      closeUpstreamSocket(1011, "upstream_unavailable");
      closeSource = "upstream_unavailable";
      closeCode = 1011;
      closeReason = "upstream_unavailable";
      return;
    }
    if (!isBinary) {
      const text = deps.wsRawDataToText(data);
      if (text?.trim()) {
        let parsed: Record<string, unknown> | null = null;
        try {
          const candidate = JSON.parse(text) as unknown;
          if (deps.isRecord(candidate)) parsed = candidate;
        } catch {
          parsed = null;
        }
        if (parsed?.type === "response.create") {
          await quotaSettlementPending;
          if (quotaBlocked) return;
          if (context.ownerUserId) {
            const requestedModel =
              typeof parsed.model === "string" && parsed.model.trim()
                ? parsed.model.trim()
                : lastRequestedModel;
            const quota = await deps.ensureUserUpstreamQuota({
              sourceAccount: context.sourceAccount,
              ownerUserId: context.ownerUserId,
              model: requestedModel,
            });
            if (!quota.allowed) {
              quotaBlocked = true;
              deps.sendWsErrorEvent(clientSocket, {
                status: 429,
                error: {
                  message: "Upstream weekly user quota exceeded",
                  type: "insufficient_quota",
                  code: "upstream_user_quota_exceeded",
                },
              });
              closeClientSocket(1008, "upstream_user_quota_exceeded");
              closeUpstreamSocket(1008, "upstream_user_quota_exceeded");
              return;
            }
          }
          turnSeq += 1;
          const reservationId = getCurrentTurnIntentId();
          const reservation = deps.tryReserveResponseRequest({
            reservationId,
            ownerUserId: context.ownerUserId,
          });
          if (!reservation.ok) {
            const queueUnavailable = reservation.reason === "queue";
            deps.sendWsErrorEvent(clientSocket, {
              status: queueUnavailable ? 503 : 429,
              error: {
                message: queueUnavailable
                  ? "Billing settlement is temporarily unavailable"
                  : "Billing quota exceeded",
                type: queueUnavailable ? "server_error" : "insufficient_quota",
                code: queueUnavailable
                  ? "settlement_queue_unavailable"
                  : "insufficient_quota",
              },
            });
            return;
          }
          pendingTurns.push({
            intentId: reservationId,
            serviceTier:
              deps.resolveFastServiceTierForBilling(
                parsed.service_tier,
              ) ?? context.serviceTier,
            pricingModelId: deps.resolveUsagePricingModelId(
              typeof parsed.model === "string" && parsed.model.trim()
                ? parsed.model.trim()
                : lastRequestedModel,
              parsed,
            ),
          });
          activeReservationIds.add(reservationId);
          if (typeof parsed.model === "string" && parsed.model.trim()) {
            lastRequestedModel = parsed.model.trim();
          }
          activeTurnStartedAtMs = Date.now();
          activeTurnFirstEventAtMs = null;
        }
      }
    }

    forwardMessage(clientSocket, upstreamSocket, data, isBinary, () => {
      deps.sendWsErrorEvent(clientSocket, {
        status: 502,
        error: {
          message: "Failed to forward websocket payload to upstream",
          type: "server_error",
          code: "websocket_forward_failed",
        },
      });
      closeSource = "forward_failed";
      closeCode = 1011;
      closeReason = "forward_failed";
      closeClientSocket(1011, "forward_failed");
      closeUpstreamSocket(1011, "forward_failed");
      finalize();
    });
  };

  clientSocket.on("message", (data: WsRawData, isBinary: boolean) => {
    clientMessageQueue = clientMessageQueue
      .then(() => handleClientMessage(data, isBinary))
      .catch((error) => {
        console.warn(
          `[responses-ws] failed to process client payload: ${error instanceof Error ? error.message : String(error)}`,
        );
        deps.sendWsErrorEvent(clientSocket, {
          status: 503,
          error: {
            message: "Failed to verify upstream user quota",
            type: "server_error",
            code: "upstream_quota_unavailable",
          },
        });
        closeClientSocket(1011, "upstream_quota_unavailable");
        closeUpstreamSocket(1011, "upstream_quota_unavailable");
      });
  });

  upstreamSocket.on("message", (data: WsRawData, isBinary: boolean) => {
    if (clientSocket.readyState !== deps.WS_READY_STATE_OPEN) return;
    if (!isBinary && activeTurnFirstEventAtMs === null) {
      activeTurnFirstEventAtMs = Date.now();
    }
    let settlementTask = Promise.resolve();
    if (!isBinary) {
      const text = deps.wsRawDataToText(data);
      if (text?.trim()) {
        const parsed = deps.parseJsonRecordText(text);
        if (parsed) settlementTask = maybeSettleTerminalUsage(parsed);
      }
    }
    upstreamMessageQueue = upstreamMessageQueue
      .then(async () => {
        await settlementTask;
        if (clientSocket.readyState !== deps.WS_READY_STATE_OPEN) return;
        forwardMessage(upstreamSocket, clientSocket, data, isBinary, () => {
          closeSource = "forward_failed";
          closeCode = 1011;
          closeReason = "forward_failed";
          closeClientSocket(1011, "forward_failed");
          closeUpstreamSocket(1011, "forward_failed");
          finalize();
        });
      })
      .catch((error) => {
        closeSource = "forward_failed";
        closeCode = 1011;
        closeReason = error instanceof Error ? error.message : String(error);
        console.warn(
          `[responses-ws] failed to persist upstream terminal event: ${closeReason}`,
        );
        closeClientSocket(1011, "settlement_wal_failed");
        closeUpstreamSocket(1011, "settlement_wal_failed");
        finalize();
      });
  });

  clientSocket.on("close", (code: number, reason: Buffer) => {
    closeSource = "client_closed";
    closeCode = code;
    closeReason = reason.toString();
    closeUpstreamSocket(code || 1000, reason.toString() || "client_closed");
    finalize();
  });

  clientSocket.on("error", (error: unknown) => {
    closeSource = "client_error";
    closeCode = 1011;
    closeReason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[responses-ws] client websocket error: ${error instanceof Error ? error.message : String(error)}`,
    );
    closeUpstreamSocket(1011, "client_error");
    finalize();
  });

  upstreamSocket.on("close", (code: number, reason: Buffer) => {
    closeSource = "upstream_closed";
    closeCode = code;
    closeReason = reason.toString();
    closeClientSocket(code || 1000, reason.toString() || "upstream_closed");
    finalize();
  });

  upstreamSocket.on("error", (error: unknown) => {
    closeSource = "upstream_error";
    closeCode = 1011;
    closeReason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[responses-ws] upstream websocket error: ${error instanceof Error ? error.message : String(error)}`,
    );
    deps.sendWsErrorEvent(clientSocket, {
      status: 502,
      error: {
        message: "Upstream websocket connection failed",
        type: "server_error",
        code: "upstream_websocket_error",
      },
    });
    closeClientSocket(1011, "upstream_error");
    closeUpstreamSocket(1011, "upstream_error");
    finalize();
  });
}
