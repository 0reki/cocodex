import {
  CHATGPT_CODEX_RESPONSES_URL,
  assembleResponseFromEventStream,
  createSseStreamFromHttpStream,
  createUpstreamHttpError,
  fetchWithOptionalProxy,
  zstdCompressBuffer,
} from "./runtime.ts";
import type { PostCodexResponsesOptions } from "./runtime.ts";
import { resolveResponseTransport } from "./responses-shared.ts";

function normalizePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...payload,
    stream: true,
    store: false,
    instructions:
      payload.instructions === undefined || payload.instructions === null
        ? ""
        : payload.instructions,
  };

  if (typeof next.input === "string") {
    next.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: next.input }],
      },
    ];
  }
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) => {
      if (!item || typeof item !== "object") return item;
      const record = item as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role : undefined;
      const hasContent =
        Array.isArray(record.content) || record.content != null;
      const text = typeof record.text === "string" ? record.text : undefined;
      if (!role || hasContent || text === undefined) return item;
      const transformed: Record<string, unknown> = {
        ...record,
        type: typeof record.type === "string" ? record.type : "message",
        content: [{ type: "input_text", text }],
      };
      delete transformed.text;
      return transformed;
    });
  }

  delete next.max_output_tokens;
  delete next.context_management;
  delete next.max_tool_calls;
  delete next.temperature;
  delete next.top_p;
  delete next.logprobs;
  delete next.top_logprobs;
  delete next.prompt_cache_retention;
  delete next.safety_identifier;
  delete next.metadata;
  delete next.user;

  if (Array.isArray(next.include)) {
    const filteredInclude = next.include.filter(
      (item) => item !== "message.output_text.logprobs",
    );
    if (filteredInclude.length === 0) {
      delete next.include;
    } else {
      next.include = filteredInclude;
    }
  }

  if (Array.isArray(next.tools)) {
    const filteredTools = next.tools.filter((tool) => {
      if (!tool || typeof tool !== "object") return false;
      const type = (tool as Record<string, unknown>).type;
      return type === "function" || type === "custom";
    });
    if (filteredTools.length === 0) {
      delete next.tools;
    } else {
      next.tools = filteredTools;
    }
  }
  if (next.tool_choice && typeof next.tool_choice === "object") {
    const type = (next.tool_choice as Record<string, unknown>).type;
    if (type !== "function" && type !== "custom") {
      delete next.tool_choice;
    }
  }
  if (next.reasoning && typeof next.reasoning === "object") {
    const reasoning = next.reasoning as Record<string, unknown>;
    if (typeof reasoning.summary !== "string") {
      if (typeof reasoning.generate_summary === "string") {
        reasoning.summary = reasoning.generate_summary;
      } else {
        reasoning.summary = "auto";
      }
    }
  }

  return next;
}

export async function postCodexResponses(
  options: PostCodexResponsesOptions,
): Promise<Response> {
  const { transportHeaders } = resolveResponseTransport(options);
  const basePayload =
    typeof options.payload === "object" && options.payload !== null
      ? (options.payload as Record<string, unknown>)
      : {};
  const requestedStream = basePayload.stream !== false;
  const rawInput = basePayload.input;
  const hasValidInput =
    (typeof rawInput === "string" && rawInput.trim().length > 0) ||
    (Array.isArray(rawInput) && rawInput.length > 0);
  if (!hasValidInput) {
    throw new Error(
      "Missing required field: input. input must contain at least one message.",
    );
  }

  const payload = normalizePayload(basePayload);
  const compressedPayload = await zstdCompressBuffer(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );

  const res = await fetchWithOptionalProxy(
    CHATGPT_CODEX_RESPONSES_URL,
    {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "Content-Encoding": "zstd",
        "x-oai-web-search-eligible": "true",
        ...transportHeaders,
      },
      body: Uint8Array.from(compressedPayload),
      signal: options.signal,
    },
    options.proxyUrl,
  );

  if (!res.ok) {
    const text = await res.text();
    throw createUpstreamHttpError({
      label: "Responses Error",
      status: res.status,
      responseText: text,
      responseUrl: CHATGPT_CODEX_RESPONSES_URL,
      responseContentType: res.headers.get("content-type"),
    });
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const sseResponse = contentType.includes("text/event-stream")
    ? res
    : (() => {
      if (!res.body) {
        throw new Error("Upstream responses stream body is empty");
      }
      const nextHeaders = new Headers();
      nextHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
      nextHeaders.set("Cache-Control", "no-cache");
      nextHeaders.set("Connection", "keep-alive");
      return new Response(createSseStreamFromHttpStream(res.body), {
        status: res.status,
        statusText: res.statusText,
        headers: nextHeaders,
      });
    })();

  if (!requestedStream) {
    return assembleResponseFromEventStream(sseResponse);
  }

  return sseResponse;
}
