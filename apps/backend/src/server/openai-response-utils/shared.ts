export function extractCodexResultFromSse(responseText: string): string | null {
  let result = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }
    const data = dataLines.join("\n");
    dataLines = [];
    eventName = "message";
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!parsed) return;

    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "response.output_text.delta") {
      const delta = parsed.delta;
      if (typeof delta === "string") {
        result += delta;
      }
      return;
    }

    if (type === "response.completed" && !result) {
      const response = parsed.response as Record<string, unknown> | undefined;
      const output = Array.isArray(response?.output) ? response.output : [];
      for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const content = Array.isArray((item as Record<string, unknown>).content)
          ? ((item as Record<string, unknown>).content as unknown[])
          : [];
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const partObj = part as Record<string, unknown>;
          if (
            partObj.type === "output_text" &&
            typeof partObj.text === "string"
          ) {
            result += partObj.text;
          }
        }
      }
    }
  };

  for (const rawLine of responseText.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      flushEvent();
      continue;
    }
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    if (eventName === "message") {
      dataLines.push(line);
    }
  }
  flushEvent();
  return result || null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonRecordText(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isResponseOutputTextDeltaEvent(
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  return (
    eventType === "response.output_text.delta" &&
    typeof payload.delta === "string"
  );
}

function getResponsePayloadRecord(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return null;
  if (payload.object === "response") return payload;
  return isRecord(payload.response)
    ? (payload.response as Record<string, unknown>)
    : null;
}

export function getResponseStatusFromPayload(
  payload: Record<string, unknown> | null,
): string | null {
  const response = getResponsePayloadRecord(payload);
  return response && typeof response.status === "string"
    ? response.status
    : null;
}

export function extractResponseErrorPayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return null;
  if (isRecord(payload.error)) {
    return payload.error as Record<string, unknown>;
  }
  const response = getResponsePayloadRecord(payload);
  if (response && isRecord(response.error)) {
    return response.error as Record<string, unknown>;
  }
  if (
    typeof payload.code === "string" ||
    typeof payload.type === "string" ||
    typeof payload.message === "string" ||
    typeof payload.detail === "string"
  ) {
    return payload;
  }
  return null;
}

export function isRetryableResponseFailurePayload(
  payload: Record<string, unknown> | null,
): boolean {
  const errorPayload = extractResponseErrorPayload(payload);
  const code =
    typeof errorPayload?.code === "string" ? errorPayload.code.trim() : "";
  const type =
    typeof errorPayload?.type === "string" ? errorPayload.type.trim() : "";
  return code === "server_error" || type === "server_error";
}

function inferPublicStatusFromResponseFailureError(
  errorPayload: Record<string, unknown> | null,
): number {
  const code =
    typeof errorPayload?.code === "string" ? errorPayload.code.trim() : "";
  const type =
    typeof errorPayload?.type === "string" ? errorPayload.type.trim() : "";
  if (
    type === "rate_limit_error" ||
    code === "rate_limit_error" ||
    code === "rate_limit_exceeded"
  ) {
    return 429;
  }
  if (type === "invalid_request_error") {
    return 400;
  }
  if (type === "authentication_error") {
    return 401;
  }
  if (type === "permission_error") {
    return 403;
  }
  return 502;
}

export function buildPassthroughResponseFailureError(args: {
  payload: Record<string, unknown> | null;
  fallbackCode: string;
  fallbackMessage: string;
}): {
  status: number;
  error: {
    message: string;
    type: string;
    code: string;
  };
} {
  const errorPayload = extractResponseErrorPayload(args.payload);
  let status = inferPublicStatusFromResponseFailureError(errorPayload);
  if (status === 401 || status === 403) {
    status = 503;
  }
  const message =
    (typeof errorPayload?.message === "string" &&
      errorPayload.message.trim()) ||
    (typeof errorPayload?.detail === "string" && errorPayload.detail.trim()) ||
    args.fallbackMessage;
  const code =
    (typeof errorPayload?.code === "string" && errorPayload.code.trim()) ||
    args.fallbackCode;
  const type =
    (typeof errorPayload?.type === "string" && errorPayload.type.trim()) ||
    (status === 429
      ? "rate_limit_error"
      : status >= 500
        ? "server_error"
        : "invalid_request_error");
  return {
    status,
    error: {
      message,
      type,
      code,
    },
  };
}

function responseEventCarriesVisibleOutput(
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (!payload) return false;

  const hasContent = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0;

  if (
    hasContent(payload.delta) ||
    hasContent(payload.text) ||
    hasContent(payload.refusal) ||
    hasContent(payload.summary) ||
    hasContent(payload.arguments) ||
    hasContent(payload.input)
  ) {
    return true;
  }

  for (const key of ["item", "part", "content"]) {
    if (!isRecord(payload[key])) continue;
    if (
      responseEventCarriesVisibleOutput(payload[key] as Record<string, unknown>)
    ) {
      return true;
    }
  }

  return false;
}

export function isRetrySafePreTextResponsesEventType(
  eventType: string,
  payload?: Record<string, unknown> | null,
): boolean {
  if (
    eventType === "response.created" ||
    eventType === "response.in_progress"
  ) {
    return true;
  }
  if (eventType.endsWith(".added")) {
    return !responseEventCarriesVisibleOutput(payload);
  }
  return false;
}
