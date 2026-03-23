import crypto from "node:crypto";
import * as openaiApiModule from "@workspace/openai-api";

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
  deps: any,
  request: any,
) {
  const startedAtMs = Date.now();
  const serviceTierResult = deps.parsePriorityServiceTier(
    deps.parseUpgradeQueryParam(request, "service_tier"),
  );
  if (!serviceTierResult.valid) {
    throw new ResponsesWebSocketUpgradeError(
      400,
      deps.buildInvalidPriorityServiceTierErrorPayload(),
      deps.isRecord,
    );
  }
  const requestedServiceTier = serviceTierResult.value;
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
  let releaseUserInFlightSlot = () => { };
  let refundUserRpmAllowance = () => { };

  try {
    if (ownerUserId) {
      const userRateLimit =
        await deps.ensureEffectiveUserRateLimitOrNull(ownerUserId);
      const inFlightResult = deps.acquireUserInFlightSlot(
        ownerUserId,
        userRateLimit?.userMaxInFlight,
      );
      if (!inFlightResult.allowed) {
        throw new ResponsesWebSocketUpgradeError(
          429,
          {
            error: {
              message: "User concurrent request limit exceeded",
              type: "rate_limit_error",
              code: "user_concurrency_limit_exceeded",
            },
          },
          deps.isRecord,
        );
      }
      releaseUserInFlightSlot = inFlightResult.release;

      const rpmResult = deps.consumeUserRpmAllowance(
        ownerUserId,
        userRateLimit?.userRpmLimit,
      );
      if (!rpmResult.allowed) {
        releaseUserInFlightSlot();
        releaseUserInFlightSlot = () => { };
        throw new ResponsesWebSocketUpgradeError(
          429,
          {
            error: {
              message: "User RPM limit exceeded",
              type: "rate_limit_error",
              code: "user_rpm_limit_exceeded",
            },
          },
          deps.isRecord,
        );
      }
      refundUserRpmAllowance = rpmResult.refund;

      const allowance = await deps.ensureUserBillingAllowanceOrNull(ownerUserId);
      if (!allowance || allowance.totalAvailable <= 0) {
        refundUserRpmAllowance();
        refundUserRpmAllowance = () => { };
        releaseUserInFlightSlot();
        releaseUserInFlightSlot = () => { };
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

    await deps.ensureOpenAIModelsCacheLoaded();
    await deps.ensureOpenAIAccountsLruLoaded();
    const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
    if (typeof openaiApiModule.connectCodexResponsesWebSocket !== "function") {
      throw new ResponsesWebSocketUpgradeError(
        500,
        {
          error: {
            message:
              "connectCodexResponsesWebSocket is not exported from @workspace/openai-api",
            type: "server_error",
            code: "missing_openai_api_export",
          },
        },
        deps.isRecord,
      );
    }

    let upstreamConnection: {
      sourceAccount: any;
      upstreamSocket: any;
    } | null = null;
    let lastError: unknown = null;
    try {
      upstreamConnection = await deps.connectResponsesWebSocketProxyUpstream({
        openaiApiModule,
        runtimeConfig,
        serviceTier: requestedServiceTier,
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
      releaseUserInFlightSlot,
      refundUserRpmAllowance,
    };
  } catch (error) {
    releaseUserInFlightSlot();
    refundUserRpmAllowance();
    throw error;
  }
}

export function setupResponsesWebSocketProxy(deps: any, args: {
  clientSocket: any;
  upstreamSocket: any;
  context: any;
}) {
  const { clientSocket, upstreamSocket, context } = args;
  const completedResponseIds = new Set<string>();
  const wsIntentId = crypto.randomUUID();
  let sawCompletedResponse = false;
  let lastRequestedModel: string | null = null;
  let activeTurnStartedAtMs: number | null = null;
  let activeTurnFirstEventAtMs: number | null = null;
  let turnSeq = 0;
  const pendingTurnServiceTiers: Array<typeof deps.PRIORITY_SERVICE_TIER | null> = [];
  const responseServiceTierById = new Map<string, typeof deps.PRIORITY_SERVICE_TIER | null>();
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

  const getCurrentTurnStartedAtMs = () =>
    activeTurnStartedAtMs ?? context.startedAtMs;

  const persistWsFailureLog = (failureCode: string, failureMessage: string) => {
    if (!deps.shouldPersistModelResponseLog("/v1/responses")) return;
    void (async () => {
      try {
        const startedAtMs = getCurrentTurnStartedAtMs();
        await deps.createModelResponseLog({
          intentId: wsIntentId,
          attemptNo: Math.max(1, turnSeq),
          isFinal: false,
          retryReason: null,
          streamEndReason:
            closeSource ?? "responses_websocket_closed_without_completed",
          path: "/v1/responses",
          modelId: lastRequestedModel,
          keyId: context.apiKeyId,
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
        });
      } catch (error) {
        console.warn(
          `[responses-ws] failed to write failure log: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  };

  const persistWsCompletedLog = async (
    payload: Record<string, unknown>,
    modelId: string | null,
    serviceTier: typeof deps.PRIORITY_SERVICE_TIER | null,
  ) => {
    if (!deps.shouldPersistModelResponseLog("/v1/responses")) return;
    const startedAtMs = getCurrentTurnStartedAtMs();
    const { tokensInfo, totalTokens } = deps.extractResponseUsage({
      response: payload,
    });
    const cost = deps.applyServiceTierBillingMultiplier(
      deps.estimateUsageCost(modelId, tokensInfo),
      serviceTier,
    );
    await deps.createModelResponseLog({
      intentId: wsIntentId,
      attemptNo: Math.max(1, turnSeq),
      isFinal: true,
      retryReason: null,
      streamEndReason: "completed",
      path: "/v1/responses",
      modelId,
      keyId: context.apiKeyId,
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
      errorCode: null,
      errorMessage: null,
      requestTime: new Date(startedAtMs).toISOString(),
    });
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (!sawCompletedResponse) {
      persistWsFailureLog(
        "responses_websocket_closed_without_completed",
        closeReason || "Responses websocket closed before completion",
      );
    }
    context.releaseUserInFlightSlot();
    if (!sawCompletedResponse) {
      context.refundUserRpmAllowance();
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

  const maybeChargeCompletedUsage = async (parsed: Record<string, unknown>) => {
    if (parsed.type === "response.created" && deps.isRecord(parsed.response)) {
      const response = parsed.response as Record<string, unknown>;
      if (typeof response.model === "string" && response.model.trim()) {
        lastRequestedModel = response.model.trim();
      }
      const responseId =
        typeof response.id === "string" ? response.id.trim() : "";
      if (responseId) {
        const responseTier =
          deps.resolvePriorityServiceTierForBilling(response.service_tier) ??
          (pendingTurnServiceTiers.length > 0
            ? (pendingTurnServiceTiers.shift() ?? null)
            : context.serviceTier);
        responseServiceTierById.set(responseId, responseTier);
      }
    }

    let completedPayload: Record<string, unknown> | null = null;
    if (parsed.type === "response.completed" && deps.isRecord(parsed.response)) {
      completedPayload = parsed.response as Record<string, unknown>;
    } else if (parsed.object === "response" && parsed.status === "completed") {
      completedPayload = parsed;
    }
    if (!completedPayload) return;

    const responseId =
      typeof completedPayload.id === "string" ? completedPayload.id.trim() : "";
    if (responseId) {
      if (completedResponseIds.has(responseId)) return;
      completedResponseIds.add(responseId);
    }

    const modelId =
      typeof completedPayload.model === "string" &&
      completedPayload.model.trim()
        ? completedPayload.model.trim()
        : lastRequestedModel;
    const billedServiceTier =
      deps.resolvePriorityServiceTierForBilling(completedPayload.service_tier) ??
      (responseId ? (responseServiceTierById.get(responseId) ?? null) : null) ??
      (pendingTurnServiceTiers.length > 0
        ? (pendingTurnServiceTiers.shift() ?? null)
        : null) ??
      context.serviceTier;
    if (responseId) {
      responseServiceTierById.delete(responseId);
    }
    sawCompletedResponse = true;
    try {
      try {
        await persistWsCompletedLog(
          completedPayload,
          modelId,
          billedServiceTier,
        );
      } catch (error) {
        console.warn(
          `[responses-ws] failed to write completed log: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await deps.chargeCompletedResponseUsage({
        apiKeyId: context.apiKeyId,
        ownerUserId: context.ownerUserId,
        modelId,
        responsePayload: completedPayload,
        serviceTier: billedServiceTier,
      });
    } catch (error) {
      console.warn(
        `[responses-ws] failed to charge usage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  clientSocket.on("message", (data: any, isBinary: boolean) => {
    deps.touchUserInFlightSlot(context.ownerUserId);
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
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (deps.isRecord(parsed) && parsed.type === "response.create") {
            const serviceTierResult = deps.parsePriorityServiceTier(
              parsed.service_tier,
            );
            if (!serviceTierResult.valid) {
              deps.sendWsErrorEvent(clientSocket, {
                status: 400,
                error: {
                  message: deps.PRIORITY_SERVICE_TIER_ERROR_MESSAGE,
                  type: "invalid_request_error",
                  code: "invalid_request_error",
                },
              });
              return;
            }
            pendingTurnServiceTiers.push(
              serviceTierResult.value ?? context.serviceTier,
            );
            if (typeof parsed.model === "string" && parsed.model.trim()) {
              lastRequestedModel = parsed.model.trim();
            }
            turnSeq += 1;
            activeTurnStartedAtMs = Date.now();
            activeTurnFirstEventAtMs = null;
          }
        } catch {
          // pass through opaque client payloads as-is
        }
      }
    }

    upstreamSocket.send(data, { binary: isBinary }, (error?: Error) => {
      if (!error) return;
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
  });

  upstreamSocket.on("message", (data: any, isBinary: boolean) => {
    deps.touchUserInFlightSlot(context.ownerUserId);
    if (clientSocket.readyState !== deps.WS_READY_STATE_OPEN) return;
    if (!isBinary && activeTurnFirstEventAtMs === null) {
      activeTurnFirstEventAtMs = Date.now();
    }
    clientSocket.send(data, { binary: isBinary }, (error?: Error) => {
      if (!error) return;
      closeClientSocket(1011, "forward_failed");
      closeUpstreamSocket(1011, "forward_failed");
    });
    if (!isBinary) {
      const text = deps.wsRawDataToText(data);
      if (text?.trim()) {
        const parsed = deps.parseJsonRecordText(text);
        if (parsed) {
          void maybeChargeCompletedUsage(parsed);
        }
      }
    }
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
