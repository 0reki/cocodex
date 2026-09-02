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
    typeof payload.message === "string" ||
    typeof payload.detail === "string" ||
    payload.type === "error" ||
    payload.type === "response.failed"
  ) {
    return payload;
  }
  return null;
}
