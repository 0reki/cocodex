import {
  assembleResponseFromEventStream,
  CHATGPT_CODEX_RESPONSES_URL,
  zstdCompressBuffer,
} from "./runtime.ts";
import type { PostCodexResponsesOptions } from "./runtime.ts";
import { resolveResponseTransport } from "./responses-shared.ts";

function normalizePayload(payload: Record<string, unknown>) {
  const next: Record<string, unknown> = {
    ...payload,
    stream: true,
    store: false,
    instructions: payload.instructions ?? "",
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
      const role = typeof record.role === "string" ? record.role : null;
      const text = typeof record.text === "string" ? record.text : null;
      if (!role || record.content != null || text === null) return item;
      const transformed: Record<string, unknown> = {
        ...record,
        type: typeof record.type === "string" ? record.type : "message",
        content: [{ type: "input_text", text }],
      };
      delete transformed.text;
      return transformed;
    });
  }

  for (const field of [
    "max_output_tokens",
    "context_management",
    "max_tool_calls",
    "temperature",
    "top_p",
    "logprobs",
    "top_logprobs",
    "prompt_cache_retention",
    "safety_identifier",
    "metadata",
    "user",
  ]) {
    delete next[field];
  }

  if (Array.isArray(next.include)) {
    const include = next.include.filter(
      (item) => item !== "message.output_text.logprobs",
    );
    if (include.length === 0) delete next.include;
    else next.include = include;
  }
  if (next.reasoning && typeof next.reasoning === "object") {
    const reasoning = {
      ...(next.reasoning as Record<string, unknown>),
    };
    if (typeof reasoning.summary !== "string") {
      reasoning.summary =
        typeof reasoning.generate_summary === "string"
          ? reasoning.generate_summary
          : "auto";
    }
    delete reasoning.generate_summary;
    next.reasoning = reasoning;
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
  const input = basePayload.input;
  if (
    !(
      (typeof input === "string" && input.trim()) ||
      (Array.isArray(input) && input.length > 0)
    )
  ) {
    throw new Error(
      "Missing required field: input. input must contain at least one message.",
    );
  }

  const payload = normalizePayload(basePayload);
  const body = await zstdCompressBuffer(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const headers = new Headers(transportHeaders);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("content-encoding", "zstd");

  const response = await fetch(CHATGPT_CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: Uint8Array.from(body),
    signal: options.signal,
  });
  if (!response.ok || requestedStream) return response;
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return response;
  }
  return assembleResponseFromEventStream(response);
}
