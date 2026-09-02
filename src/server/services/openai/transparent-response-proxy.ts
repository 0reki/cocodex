import type { Response as ExpressResponse } from "express";
import {
  extractResponseErrorPayload,
  getResponseStatusFromPayload,
  isRecord,
} from "../../openai-response-utils.ts";
import { applyUpstreamResponseHeaders } from "../../utils/index.ts";

export type UpstreamResponseObservation = {
  firstByteAtMs: number | null;
  finishedAtMs: number;
  responsePayload: Record<string, unknown> | null;
  terminalResponsePayload: Record<string, unknown> | null;
  terminalStatus: ResponseTerminalStatus | null;
  errorPayload: Record<string, unknown> | null;
};

export type ResponseTerminalStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "error";

function getTerminalStatus(
  payload: Record<string, unknown>,
): ResponseTerminalStatus | null {
  const type = typeof payload.type === "string" ? payload.type : "";
  switch (type) {
    case "response.completed":
    case "response.done":
      return "completed";
    case "response.incomplete":
      return "incomplete";
    case "response.failed":
      return "failed";
    case "response.cancelled":
      return "cancelled";
    case "error":
      return "error";
  }

  const status = getResponseStatusFromPayload(payload);
  return status === "completed" ||
    status === "incomplete" ||
    status === "failed" ||
    status === "cancelled"
    ? status
    : null;
}

function extractJsonObjectProperty(
  source: string,
  property: string,
): Record<string, unknown> | null {
  let propertyIndex = source.lastIndexOf(`"${property}"`);
  while (propertyIndex >= 0) {
    const colonIndex = source.indexOf(":", propertyIndex + property.length + 2);
    if (colonIndex < 0) return null;
    let start = colonIndex + 1;
    while (/\s/.test(source[start] ?? "")) start += 1;
    if (source[start] !== "{") {
      propertyIndex = source.lastIndexOf(`"${property}"`, propertyIndex - 1);
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(source.slice(start, index + 1)) as unknown;
            return isRecord(parsed) ? parsed : null;
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
  return null;
}

function waitForResponseDrain(res: ExpressResponse): Promise<void> {
  if (res.destroyed || res.writableEnded) {
    return Promise.reject(new Error("Downstream response is closed"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Downstream response closed before draining"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

export async function forwardUpstreamResponse(
  upstream: Response,
  res: ExpressResponse,
  options: { expectEventStream?: boolean; jsonTailBytes?: number } = {},
): Promise<UpstreamResponseObservation> {
  res.status(upstream.status);
  applyUpstreamResponseHeaders(res, upstream.headers);
  const upstreamContentType = upstream.headers.get("content-type") ?? "";
  const isEventStream =
    options.expectEventStream === true ||
    upstreamContentType.toLowerCase().includes("text/event-stream");
  if (isEventStream) {
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
  }

  let firstByteAtMs: number | null = null;
  let responsePayload: Record<string, unknown> | null = null;
  let terminalResponsePayload: Record<string, unknown> | null = null;
  let terminalStatus: ResponseTerminalStatus | null = null;
  let errorPayload: Record<string, unknown> | null = null;

  const observePayload = (payload: Record<string, unknown>) => {
    responsePayload = payload;
    const observedTerminalStatus = getTerminalStatus(payload);
    if (observedTerminalStatus) {
      terminalResponsePayload = isRecord(payload.response)
        ? payload.response
        : payload;
      terminalStatus = observedTerminalStatus;
    }
    errorPayload = extractResponseErrorPayload(payload) ?? errorPayload;
  };

  if (!upstream.body) {
    res.end();
    return {
      firstByteAtMs,
      finishedAtMs: Date.now(),
      responsePayload,
      terminalResponsePayload,
      terminalStatus,
      errorPayload,
    };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const bodyChunks: Buffer[] = [];
  let bodyChunksBytes = 0;
  let parseBuffer = "";
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed)) observePayload(parsed);
    } catch {
      return;
    }
  };

  const observeEventStreamText = (text: string) => {
    parseBuffer += text;
    let lineBreakIndex = parseBuffer.indexOf("\n");
    while (lineBreakIndex !== -1) {
      const rawLine = parseBuffer.slice(0, lineBreakIndex);
      parseBuffer = parseBuffer.slice(lineBreakIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        flushEvent();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      lineBreakIndex = parseBuffer.indexOf("\n");
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstByteAtMs === null) firstByteAtMs = Date.now();
      const chunk = Buffer.from(value);
      const canContinue = res.write(chunk);
      if (isEventStream) {
        observeEventStreamText(decoder.decode(value, { stream: true }));
      } else {
        bodyChunks.push(chunk);
        bodyChunksBytes += chunk.byteLength;
        const jsonTailBytes = options.jsonTailBytes;
        if (jsonTailBytes && jsonTailBytes > 0) {
          while (bodyChunksBytes > jsonTailBytes && bodyChunks.length > 0) {
            const overflow = bodyChunksBytes - jsonTailBytes;
            const first = bodyChunks[0];
            if (!first) break;
            if (first.byteLength <= overflow) {
              bodyChunks.shift();
              bodyChunksBytes -= first.byteLength;
            } else {
              bodyChunks[0] = first.subarray(overflow);
              bodyChunksBytes -= overflow;
            }
          }
        }
      }
      if (!canContinue) await waitForResponseDrain(res);
    }

    if (isEventStream) {
      observeEventStreamText(decoder.decode());
      if (parseBuffer.trim()) {
        const trailing = parseBuffer.trim();
        if (trailing.startsWith("data:")) {
          dataLines.push(trailing.slice(5).trimStart());
        }
      }
      flushEvent();
    } else if (bodyChunks.length > 0) {
      const bodyText = Buffer.concat(bodyChunks, bodyChunksBytes).toString("utf8");
      try {
        const parsed = JSON.parse(bodyText) as unknown;
        if (isRecord(parsed)) observePayload(parsed);
      } catch {
        const usage = extractJsonObjectProperty(bodyText, "usage");
        const error = extractJsonObjectProperty(bodyText, "error");
        if (usage) responsePayload = { usage };
        if (error) errorPayload = error;
      }
    }
    res.end();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return {
    firstByteAtMs,
    finishedAtMs: Date.now(),
    responsePayload,
    terminalResponsePayload,
    terminalStatus,
    errorPayload,
  };
}
