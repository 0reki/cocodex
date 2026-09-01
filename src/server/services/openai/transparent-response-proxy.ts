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
  completedResponsePayload: Record<string, unknown> | null;
  errorPayload: Record<string, unknown> | null;
  sawCompleted: boolean;
};

export async function forwardUpstreamResponse(
  upstream: Response,
  res: ExpressResponse,
): Promise<UpstreamResponseObservation> {
  res.status(upstream.status);
  applyUpstreamResponseHeaders(res, upstream.headers);

  let firstByteAtMs: number | null = null;
  let responsePayload: Record<string, unknown> | null = null;
  let completedResponsePayload: Record<string, unknown> | null = null;
  let errorPayload: Record<string, unknown> | null = null;
  let sawCompleted = false;

  const observePayload = (payload: Record<string, unknown>) => {
    responsePayload = payload;
    const type = typeof payload.type === "string" ? payload.type : "";
    if (type === "response.completed" && isRecord(payload.response)) {
      completedResponsePayload = payload.response;
      sawCompleted = true;
    } else if (getResponseStatusFromPayload(payload) === "completed") {
      completedResponsePayload = isRecord(payload.response)
        ? payload.response
        : payload;
      sawCompleted = true;
    }
    errorPayload = extractResponseErrorPayload(payload) ?? errorPayload;
  };

  if (!upstream.body) {
    res.end();
    return {
      firstByteAtMs,
      finishedAtMs: Date.now(),
      responsePayload,
      completedResponsePayload,
      errorPayload,
      sawCompleted,
    };
  }

  const isEventStream = (upstream.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const bodyChunks: Buffer[] = [];
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
      res.write(chunk);
      if (isEventStream) {
        observeEventStreamText(decoder.decode(value, { stream: true }));
      } else {
        bodyChunks.push(chunk);
      }
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
      try {
        const parsed = JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) as unknown;
        if (isRecord(parsed)) observePayload(parsed);
      } catch {
        responsePayload = null;
      }
    }
    res.end();
  } finally {
    reader.releaseLock();
  }

  return {
    firstByteAtMs,
    finishedAtMs: Date.now(),
    responsePayload,
    completedResponsePayload,
    errorPayload,
    sawCompleted,
  };
}
