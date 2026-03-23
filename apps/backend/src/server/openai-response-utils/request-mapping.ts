import { isRecord } from "./shared.ts";

function normalizeChatContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (typeof part.refusal === "string") {
      parts.push(part.refusal);
    }
  }
  return parts.join("");
}

function mapChatContentPartToResponsePart(
  part: unknown,
): Record<string, unknown> | null {
  if (!isRecord(part) || typeof part.type !== "string") return null;

  if (part.type === "text" && typeof part.text === "string") {
    return {
      type: "input_text",
      text: part.text,
    };
  }

  if (part.type === "image_url" && isRecord(part.image_url)) {
    const url =
      typeof part.image_url.url === "string" ? part.image_url.url : null;
    if (!url) return null;
    const mapped: Record<string, unknown> = {
      type: "input_image",
      image_url: url,
    };
    if (typeof part.image_url.detail === "string") {
      mapped.detail = part.image_url.detail;
    }
    return mapped;
  }

  if (part.type === "file" && isRecord(part.file)) {
    const mapped: Record<string, unknown> = {
      type: "input_file",
    };
    if (typeof part.file.file_id === "string") {
      mapped.file_id = part.file.file_id;
    }
    if (typeof part.file.file_data === "string") {
      mapped.file_data = part.file.file_data;
    }
    if (typeof part.file.filename === "string") {
      mapped.filename = part.file.filename;
    }
    return mapped;
  }

  return null;
}

function mapAssistantChatContentPartToResponsePart(
  part: unknown,
): Record<string, unknown> | null {
  if (!isRecord(part) || typeof part.type !== "string") return null;

  if (part.type === "text" && typeof part.text === "string") {
    return {
      type: "output_text",
      text: part.text,
    };
  }

  if (part.type === "refusal" && typeof part.refusal === "string") {
    return {
      type: "refusal",
      refusal: part.refusal,
    };
  }

  return null;
}

function mapChatMessageToResponseItems(
  message: unknown,
): Record<string, unknown>[] {
  if (!isRecord(message) || typeof message.role !== "string") return [];

  const role = message.role;
  const items: Record<string, unknown>[] = [];
  const content = message.content;

  if (role === "tool" && typeof message.tool_call_id === "string") {
    const output = normalizeChatContentToText(content);
    items.push({
      type: "function_call_output",
      call_id: message.tool_call_id,
      output,
    });
    return items;
  }

  if (role === "function" && typeof message.name === "string") {
    const output = normalizeChatContentToText(content);
    items.push({
      type: "function_call_output",
      call_id: message.name,
      output,
    });
    return items;
  }

  if (
    role === "developer" ||
    role === "system" ||
    role === "user" ||
    role === "assistant"
  ) {
    let mappedContent: string | Record<string, unknown>[] = "";
    if (role === "assistant") {
      if (typeof content === "string") {
        mappedContent = content ? [{ type: "output_text", text: content }] : [];
      } else if (Array.isArray(content)) {
        const mappedParts = content
          .map((part) => mapAssistantChatContentPartToResponsePart(part))
          .filter((part): part is Record<string, unknown> => Boolean(part));
        if (mappedParts.length > 0) {
          mappedContent = mappedParts;
        } else {
          const fallback = normalizeChatContentToText(content);
          mappedContent = fallback
            ? [{ type: "output_text", text: fallback }]
            : [];
        }
      }
    } else if (typeof content === "string") {
      mappedContent = content;
    } else if (Array.isArray(content)) {
      const mappedParts = content
        .map((part) => mapChatContentPartToResponsePart(part))
        .filter((part): part is Record<string, unknown> => Boolean(part));
      if (mappedParts.length > 0) {
        mappedContent = mappedParts;
      } else {
        mappedContent = normalizeChatContentToText(content);
      }
    }

    items.push({
      type: "message",
      role,
      content: mappedContent,
    });

    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isRecord(call) || typeof call.type !== "string") continue;
        if (call.type === "function" && isRecord(call.function)) {
          if (
            typeof call.id === "string" &&
            typeof call.function.name === "string"
          ) {
            items.push({
              type: "function_call",
              call_id: call.id,
              name: call.function.name,
              arguments:
                typeof call.function.arguments === "string"
                  ? call.function.arguments
                  : "{}",
            });
          }
          continue;
        }
        if (call.type === "custom" && isRecord(call.custom)) {
          if (
            typeof call.id === "string" &&
            typeof call.custom.name === "string"
          ) {
            items.push({
              type: "custom_tool_call",
              call_id: call.id,
              name: call.custom.name,
              input:
                typeof call.custom.input === "string" ? call.custom.input : "",
            });
          }
        }
      }
    }
  }

  return items;
}

function mapChatToolsToResponsesTools(
  chatTools: unknown,
  functions: unknown,
): unknown[] | undefined {
  const mapped: unknown[] = [];

  if (Array.isArray(chatTools)) {
    for (const tool of chatTools) {
      if (!isRecord(tool) || typeof tool.type !== "string") continue;
      if (tool.type === "function" && isRecord(tool.function)) {
        if (typeof tool.function.name !== "string") continue;
        mapped.push({
          type: "function",
          name: tool.function.name,
          description:
            typeof tool.function.description === "string"
              ? tool.function.description
              : undefined,
          parameters: isRecord(tool.function.parameters)
            ? tool.function.parameters
            : undefined,
          strict:
            typeof tool.function.strict === "boolean"
              ? tool.function.strict
              : undefined,
        });
        continue;
      }
      if (tool.type === "custom" && isRecord(tool.custom)) {
        if (typeof tool.custom.name !== "string") continue;
        let format: Record<string, unknown> | undefined;
        if (isRecord(tool.custom.format)) {
          if (tool.custom.format.type === "text") {
            format = { type: "text" };
          } else if (
            tool.custom.format.type === "grammar" &&
            isRecord(tool.custom.format.grammar)
          ) {
            format = {
              type: "grammar",
              definition: tool.custom.format.grammar.definition,
              syntax: tool.custom.format.grammar.syntax,
            };
          }
        }
        mapped.push({
          type: "custom",
          name: tool.custom.name,
          description:
            typeof tool.custom.description === "string"
              ? tool.custom.description
              : undefined,
          format,
        });
      }
    }
  }

  if (Array.isArray(functions)) {
    for (const fn of functions) {
      if (!isRecord(fn) || typeof fn.name !== "string") continue;
      mapped.push({
        type: "function",
        name: fn.name,
        description:
          typeof fn.description === "string" ? fn.description : undefined,
        parameters: isRecord(fn.parameters) ? fn.parameters : undefined,
      });
    }
  }

  return mapped.length > 0 ? mapped : undefined;
}

function mapChatToolChoiceToResponsesToolChoice(
  toolChoice: unknown,
  functionCall: unknown,
): unknown {
  if (
    toolChoice === "none" ||
    toolChoice === "auto" ||
    toolChoice === "required"
  ) {
    return toolChoice;
  }
  if (
    isRecord(toolChoice) &&
    toolChoice.type === "function" &&
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === "string"
  ) {
    return {
      type: "function",
      name: toolChoice.function.name,
    };
  }
  if (
    isRecord(toolChoice) &&
    toolChoice.type === "custom" &&
    isRecord(toolChoice.custom) &&
    typeof toolChoice.custom.name === "string"
  ) {
    return {
      type: "custom",
      name: toolChoice.custom.name,
    };
  }
  if (toolChoice === undefined || toolChoice === null) {
    if (functionCall === "none" || functionCall === "auto") return functionCall;
    if (isRecord(functionCall) && typeof functionCall.name === "string") {
      return {
        type: "function",
        name: functionCall.name,
      };
    }
  }
  return undefined;
}

export function mapChatRequestToResponsesPayload(
  requestBody: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  let requiresJsonObjectInstruction = false;

  if (typeof requestBody.model === "string") payload.model = requestBody.model;
  if (typeof requestBody.stream === "boolean")
    payload.stream = requestBody.stream;
  if (typeof requestBody.store === "boolean") payload.store = requestBody.store;
  if (typeof requestBody.temperature === "number")
    payload.temperature = requestBody.temperature;
  if (typeof requestBody.top_p === "number") payload.top_p = requestBody.top_p;
  if (typeof requestBody.user === "string") payload.user = requestBody.user;
  if (typeof requestBody.prompt_cache_key === "string")
    payload.prompt_cache_key = requestBody.prompt_cache_key;
  if (
    typeof requestBody.promptCacheKey === "string" &&
    typeof payload.prompt_cache_key !== "string"
  ) {
    payload.prompt_cache_key = requestBody.promptCacheKey;
  }
  if (typeof requestBody.safety_identifier === "string")
    payload.safety_identifier = requestBody.safety_identifier;
  if (typeof requestBody.service_tier === "string")
    payload.service_tier = requestBody.service_tier;
  if (typeof requestBody.parallel_tool_calls === "boolean")
    payload.parallel_tool_calls = requestBody.parallel_tool_calls;
  if (isRecord(requestBody.metadata)) payload.metadata = requestBody.metadata;

  const textConfig: Record<string, unknown> = {};
  if (typeof requestBody.verbosity === "string") {
    textConfig.verbosity = requestBody.verbosity;
  }
  if (
    isRecord(requestBody.response_format) &&
    typeof requestBody.response_format.type === "string"
  ) {
    if (
      requestBody.response_format.type === "json_schema" &&
      isRecord(requestBody.response_format.json_schema)
    ) {
      textConfig.format = {
        type: "json_schema",
        name: requestBody.response_format.json_schema.name,
        description: requestBody.response_format.json_schema.description,
        schema: requestBody.response_format.json_schema.schema,
        strict: requestBody.response_format.json_schema.strict,
      };
    } else if (
      requestBody.response_format.type === "json_object" ||
      requestBody.response_format.type === "text"
    ) {
      textConfig.format = { type: requestBody.response_format.type };
      if (requestBody.response_format.type === "json_object") {
        requiresJsonObjectInstruction = true;
      }
    }
  }
  if (Object.keys(textConfig).length > 0) payload.text = textConfig;

  const reasoningConfig: Record<string, unknown> = {};
  if (isRecord(requestBody.reasoning)) {
    if (typeof requestBody.reasoning.effort === "string") {
      reasoningConfig.effort = requestBody.reasoning.effort;
    }
    if (typeof requestBody.reasoning.summary === "string") {
      reasoningConfig.summary = requestBody.reasoning.summary;
    }
  }
  if (typeof requestBody.reasoning_effort === "string") {
    reasoningConfig.effort = requestBody.reasoning_effort;
  }
  if (typeof requestBody.reasoning_summary === "string") {
    reasoningConfig.summary = requestBody.reasoning_summary;
  }
  if (Object.keys(reasoningConfig).length > 0) {
    payload.reasoning = reasoningConfig;
  }

  const toolChoice = mapChatToolChoiceToResponsesToolChoice(
    requestBody.tool_choice,
    requestBody.function_call,
  );
  if (toolChoice !== undefined) payload.tool_choice = toolChoice;

  const tools = mapChatToolsToResponsesTools(
    requestBody.tools,
    requestBody.functions,
  );
  if (tools) payload.tools = tools;

  if (Array.isArray(requestBody.messages)) {
    const nonSystemMessages: unknown[] = [];
    const systemInstructionParts: string[] = [];

    for (const message of requestBody.messages) {
      if (!isRecord(message) || typeof message.role !== "string") continue;
      if (message.role === "system") {
        const text = normalizeChatContentToText(message.content).trim();
        if (text) systemInstructionParts.push(text);
        continue;
      }
      nonSystemMessages.push(message);
    }

    const existingInstructions =
      typeof requestBody.instructions === "string"
        ? requestBody.instructions.trim()
        : "";
    const mergedInstructions = [existingInstructions, ...systemInstructionParts]
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .join("\n\n");
    const finalInstructionsParts = mergedInstructions
      ? [mergedInstructions]
      : [];
    const hasJsonWord = /json/i.test(mergedInstructions);
    if (requiresJsonObjectInstruction && !hasJsonWord) {
      finalInstructionsParts.push(
        "Return the final answer as valid JSON (a single JSON object).",
      );
    }
    const finalInstructions = finalInstructionsParts.join("\n\n").trim();
    if (finalInstructions) {
      payload.instructions = finalInstructions;
    }

    const inputItems = nonSystemMessages.flatMap((message) =>
      mapChatMessageToResponseItems(message),
    );
    payload.input = inputItems;
  }

  return payload;
}

const RESPONSES_UNSUPPORTED_FIELDS = [
  "forkedFromIdentifier",
  "forked_from_identifier",
] as const;

export function stripUnsupportedResponsesFields(payload: Record<string, unknown>) {
  for (const key of RESPONSES_UNSUPPORTED_FIELDS) {
    if (key in payload) {
      delete payload[key];
    }
  }
}
