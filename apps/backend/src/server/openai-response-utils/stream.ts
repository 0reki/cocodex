import {
  extractResponseMessageTextAndRefusal,
  getChatFinishReasonFromResponse,
  mapResponseOutputToChatToolCalls,
} from "./response-mapping.ts";
import { isRecord } from "./shared.ts";

export function mapResponseEventToChatStreamChunks(
  eventType: string,
  payload: Record<string, unknown>,
  state: {
    id: string;
    model: string;
    created: number;
    emittedText: boolean;
  },
): Record<string, unknown>[] {
  const extractReasoningDelta = () => {
    const pickString = (value: unknown): string | null => {
      if (typeof value === "string") {
        const text = value.trim();
        return text.length > 0 ? value : null;
      }
      return null;
    };

    const direct = [
      payload.delta,
      payload.summary,
      payload.text,
      isRecord(payload.reasoning) ? payload.reasoning.summary : null,
      isRecord(payload.reasoning) ? payload.reasoning.text : null,
      isRecord(payload.item) ? payload.item.summary : null,
      isRecord(payload.item) ? payload.item.text : null,
      isRecord(payload.part) ? payload.part.summary : null,
      isRecord(payload.part) ? payload.part.text : null,
      isRecord(payload.content) ? payload.content.summary : null,
      isRecord(payload.content) ? payload.content.text : null,
    ];

    for (const candidate of direct) {
      const matched = pickString(candidate);
      if (matched) return matched;
    }

    const outputArray =
      isRecord(payload.response) && Array.isArray(payload.response.output)
        ? payload.response.output
        : [];
    for (const item of outputArray) {
      if (!isRecord(item)) continue;
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (!isRecord(part)) continue;
        const matched =
          pickString(part.summary) ??
          pickString(part.text) ??
          pickString(part.delta) ??
          (isRecord(part.reasoning)
            ? pickString(part.reasoning.summary)
            : null) ??
          (isRecord(part.reasoning) ? pickString(part.reasoning.text) : null);
        if (matched) return matched;
      }
    }

    return null;
  };

  if (eventType === "response.created" && isRecord(payload.response)) {
    const response = payload.response as Record<string, unknown>;
    if (typeof response.id === "string") state.id = response.id;
    if (typeof response.model === "string") state.model = response.model;
    if (typeof response.created_at === "number")
      state.created = response.created_at;
    return [
      {
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ],
      },
    ];
  }

  if (
    eventType === "response.output_text.delta" &&
    typeof payload.delta === "string"
  ) {
    state.emittedText = true;
    return [
      {
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: { content: payload.delta },
            finish_reason: null,
          },
        ],
      },
    ];
  }

  if (
    eventType === "response.reasoning_summary.delta" ||
    eventType === "response.reasoning_summary_text.delta" ||
    eventType === "response.reasoning_text.delta"
  ) {
    const reasoningDelta = extractReasoningDelta();
    if (!reasoningDelta) return [];
    return [
      {
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: { reasoning_content: reasoningDelta },
            finish_reason: null,
          },
        ],
      },
    ];
  }

  if (
    eventType === "response.refusal.delta" &&
    typeof payload.delta === "string"
  ) {
    return [
      {
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: { refusal: payload.delta },
            finish_reason: null,
          },
        ],
      },
    ];
  }

  if (eventType === "response.completed" && isRecord(payload.response)) {
    const response = payload.response as Record<string, unknown>;
    const chunks: Record<string, unknown>[] = [];
    const toolCalls = mapResponseOutputToChatToolCalls(response);
    if (!state.emittedText) {
      const { contentText } = extractResponseMessageTextAndRefusal(response);
      if (contentText) {
        state.emittedText = true;
        chunks.push({
          id: state.id,
          object: "chat.completion.chunk",
          created: state.created,
          model: state.model,
          choices: [
            {
              index: 0,
              delta: { content: contentText },
              finish_reason: null,
            },
          ],
        });
      }
    }
    if (toolCalls && toolCalls.length > 0) {
      chunks.push({
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: toolCalls.map((call, index) => ({
                index,
                ...call,
              })),
            },
            finish_reason: null,
          },
        ],
      });
    }
    chunks.push({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: getChatFinishReasonFromResponse(response, toolCalls),
        },
      ],
    });
    return chunks;
  }

  return [];
}
