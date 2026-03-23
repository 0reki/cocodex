import crypto from "node:crypto";

import { isRecord } from "./shared.ts";

function extractResponseMessageTextAndRefusal(
  response: Record<string, unknown>,
) {
  let contentText = "";
  let refusalText = "";
  let annotations: Array<Record<string, unknown>> = [];
  const output = Array.isArray(response.output) ? response.output : [];

  for (const item of output) {
    if (!isRecord(item) || item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part) || typeof part.type !== "string") continue;
      if (part.type === "output_text" && typeof part.text === "string") {
        contentText += part.text;
        const partAnnotations = Array.isArray(part.annotations)
          ? part.annotations.filter((a): a is Record<string, unknown> =>
              isRecord(a),
            )
          : [];
        annotations = annotations.concat(partAnnotations);
      }
      if (part.type === "refusal" && typeof part.refusal === "string") {
        refusalText += part.refusal;
      }
    }
  }

  return {
    contentText,
    refusalText,
    annotations,
  };
}

export function mapResponseOutputToChatToolCalls(
  response: Record<string, unknown>,
): Array<Record<string, unknown>> | undefined {
  const output = Array.isArray(response.output) ? response.output : [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    if (!isRecord(item) || typeof item.type !== "string") continue;
    if (
      item.type === "function_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : "{}",
        },
      });
      continue;
    }
    if (
      item.type === "custom_tool_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      toolCalls.push({
        id: item.call_id,
        type: "custom",
        custom: {
          name: item.name,
          input: typeof item.input === "string" ? item.input : "",
        },
      });
    }
  }

  return toolCalls.length > 0 ? toolCalls : undefined;
}

export function mapResponseUsageToChatUsage(
  usageRaw: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!usageRaw) return undefined;
  const getNestedNumber = (
    source: Record<string, unknown> | null,
    path: string[],
  ): number | null => {
    if (!source) return null;
    let current: unknown = source;
    for (const key of path) {
      if (!isRecord(current)) return null;
      current = current[key];
    }
    return typeof current === "number" && Number.isFinite(current)
      ? current
      : null;
  };

  const promptTokens =
    getNestedNumber(usageRaw, ["input_tokens"]) ??
    getNestedNumber(usageRaw, ["inputTokens"]) ??
    0;
  const completionTokens =
    getNestedNumber(usageRaw, ["output_tokens"]) ??
    getNestedNumber(usageRaw, ["outputTokens"]) ??
    0;
  const totalTokens =
    getNestedNumber(usageRaw, ["total_tokens"]) ??
    getNestedNumber(usageRaw, ["totalTokens"]) ??
    promptTokens + completionTokens;
  const cachedTokens =
    getNestedNumber(usageRaw, ["cached_input_tokens"]) ??
    getNestedNumber(usageRaw, ["cachedInputTokens"]) ??
    getNestedNumber(usageRaw, ["input_tokens_details", "cached_tokens"]) ??
    getNestedNumber(
      isRecord(usageRaw.input_tokens_details)
        ? (usageRaw.input_tokens_details as Record<string, unknown>)
        : null,
      ["cached_tokens"],
    ) ??
    0;
  const reasoningTokens = getNestedNumber(
    isRecord(usageRaw.output_tokens_details)
      ? (usageRaw.output_tokens_details as Record<string, unknown>)
      : null,
    ["reasoning_tokens"],
  );

  const usage: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    prompt_tokens_details: {
      cached_tokens: cachedTokens,
    },
  };
  if (reasoningTokens !== null) {
    usage.completion_tokens_details = {
      reasoning_tokens: reasoningTokens,
    };
  }
  return usage;
}

export function getChatFinishReasonFromResponse(
  response: Record<string, unknown>,
  toolCalls?: Array<Record<string, unknown>>,
): string {
  const resolvedToolCalls =
    toolCalls ?? mapResponseOutputToChatToolCalls(response);
  if (resolvedToolCalls && resolvedToolCalls.length > 0) return "tool_calls";
  if (
    isRecord(response.incomplete_details) &&
    response.incomplete_details.reason === "max_output_tokens"
  ) {
    return "length";
  }
  if (
    isRecord(response.incomplete_details) &&
    response.incomplete_details.reason === "content_filter"
  ) {
    return "content_filter";
  }
  return "stop";
}

export function mapResponseToChatCompletion(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const id =
    typeof response.id === "string"
      ? response.id
      : `chatcmpl_${crypto.randomUUID()}`;
  const created =
    typeof response.created_at === "number"
      ? response.created_at
      : Math.floor(Date.now() / 1000);
  const model = typeof response.model === "string" ? response.model : "";
  const { contentText, refusalText, annotations } =
    extractResponseMessageTextAndRefusal(response);
  const toolCalls = mapResponseOutputToChatToolCalls(response);
  const usage = mapResponseUsageToChatUsage(
    isRecord(response.usage)
      ? (response.usage as Record<string, unknown>)
      : null,
  );

  const finishReason = getChatFinishReasonFromResponse(response, toolCalls);

  const message: Record<string, unknown> = {
    role: "assistant",
    content: contentText,
  };
  if (refusalText) message.refusal = refusalText;
  if (toolCalls) message.tool_calls = toolCalls;
  if (annotations.length > 0) {
    const mappedAnnotations = annotations
      .map((annotation) => {
        if (
          annotation.type === "url_citation" &&
          typeof annotation.start_index === "number" &&
          typeof annotation.end_index === "number" &&
          typeof annotation.title === "string" &&
          typeof annotation.url === "string"
        ) {
          return {
            type: "url_citation",
            url_citation: {
              start_index: annotation.start_index,
              end_index: annotation.end_index,
              title: annotation.title,
              url: annotation.url,
            },
          };
        }
        return null;
      })
      .filter(Boolean);
    if (mappedAnnotations.length > 0) {
      message.annotations = mappedAnnotations;
    }
  }

  const result: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  };
  if (usage) result.usage = usage;
  if (typeof response.service_tier === "string") {
    result.service_tier = response.service_tier;
  }
  return result;
}

export { extractResponseMessageTextAndRefusal };
