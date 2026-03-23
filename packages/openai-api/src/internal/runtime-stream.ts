import type {
  GetChatgptSessionOptions,
  SessionTokenCookieMap,
  SseEvent,
} from "./runtime-types.ts";

const jsonStartChars = new Set(["{", "["]);

function tryExtractJsonToken(
  input: string,
): { token: string; nextIndex: number } | null {
  let index = 0;
  while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
  if (index >= input.length) return null;

  const first = input[index] ?? "";
  if (!jsonStartChars.has(first)) return null;

  const stack: string[] = [];
  let inString = false;
  let escaping = false;

  for (let i = index; i < input.length; i += 1) {
    const ch = input[i] ?? "";
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const top = stack.at(-1);
      const matched =
        (ch === "}" && top === "{") || (ch === "]" && top === "[");
      if (!matched) return null;
      stack.pop();
      if (stack.length === 0) {
        const token = input.slice(index, i + 1);
        return { token, nextIndex: i + 1 };
      }
    }
  }
  return null;
}

export function createSseStreamFromHttpStream(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      let pending = "";
      let pendingEventName: string | null = null;

      const emitSse = (data: string, eventName?: string | null) => {
        const safeData = data.trim();
        if (!safeData) return;
        const parts: string[] = [];
        if (eventName?.trim()) {
          parts.push(`event: ${eventName.trim()}`);
        }
        for (const line of safeData.replace(/\r/g, "").split("\n")) {
          parts.push(`data: ${line}`);
        }
        controller.enqueue(encoder.encode(`${parts.join("\n")}\n\n`));
      };

      const emitFromJson = (jsonText: string) => {
        let eventName: string | null = null;
        try {
          const parsed = JSON.parse(jsonText) as Record<string, unknown>;
          if (typeof parsed.type === "string" && parsed.type.trim()) {
            eventName = parsed.type.trim();
          }
        } catch {
          // fallback to data-only
        }
        emitSse(jsonText, eventName);
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });

          while (true) {
            const trimmed = pending.trimStart();
            if (!trimmed) {
              pending = "";
              break;
            }

            const nextJson = tryExtractJsonToken(trimmed);
            if (!nextJson) {
              const lineBreakIndex = trimmed.indexOf("\n");
              if (lineBreakIndex < 0) break;
              const line = trimmed.slice(0, lineBreakIndex).trim();
              if (line.startsWith("event:")) {
                const eventName = line.slice(6).trim();
                pendingEventName = eventName || null;
              } else if (line.startsWith("data:")) {
                const payload = line.slice(5).trimStart();
                emitSse(payload, pendingEventName);
                pendingEventName = null;
              } else if (line === "[DONE]") {
                emitSse("[DONE]", pendingEventName);
                pendingEventName = null;
              } else if (line) {
                emitSse(line, pendingEventName);
                pendingEventName = null;
              }
              pending = trimmed.slice(lineBreakIndex + 1);
              continue;
            }

            const token = nextJson.token.trim();
            emitFromJson(token);
            pending = trimmed.slice(nextJson.nextIndex);
          }
        }

        pending += decoder.decode();
        const finalToken = tryExtractJsonToken(pending.trimStart());
        if (finalToken) {
          const token = finalToken.token.trim();
          if (token) {
            emitFromJson(token);
          }
        } else {
          const tail = pending.trim();
          if (tail) {
            if (tail.startsWith("event:")) {
              const eventName = tail.slice(6).trim();
              pendingEventName = eventName || null;
            } else if (tail.startsWith("data:")) {
              const payload = tail.slice(5).trimStart();
              emitSse(payload, pendingEventName);
              pendingEventName = null;
            } else if (tail === "[DONE]") {
              emitSse("[DONE]", pendingEventName);
              pendingEventName = null;
            } else {
              emitSse(tail, pendingEventName);
              pendingEventName = null;
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

export async function assembleResponseFromEventStream(
  response: Response,
): Promise<Response> {
  let completedResponse: Record<string, unknown> | null = null;
  let latestResponse: Record<string, unknown> | null = null;
  let streamError: Record<string, unknown> | null = null;

  for await (const evt of parseSseEvents(response)) {
    const data = evt.data.trim();
    if (!data || data === "[DONE]") continue;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!parsed) continue;

    if (parsed.object === "response") {
      latestResponse = parsed;
    }
    if (parsed.response && typeof parsed.response === "object") {
      latestResponse = parsed.response as Record<string, unknown>;
    }

    const type =
      typeof parsed.type === "string" ? parsed.type : evt.event || "message";
    if (
      type === "response.completed" &&
      parsed.response &&
      typeof parsed.response === "object"
    ) {
      completedResponse = parsed.response as Record<string, unknown>;
      break;
    }
    if (
      type === "error" ||
      type === "response.error" ||
      type === "response.failed"
    ) {
      streamError = parsed;
    } else if (parsed.error && typeof parsed.error === "object") {
      streamError = parsed.error as Record<string, unknown>;
    }
  }

  const headers = new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  const body = completedResponse ?? latestResponse;
  if (body) {
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (streamError) {
    return new Response(JSON.stringify({ error: streamError }), {
      status: response.status >= 400 ? response.status : 500,
      headers,
    });
  }

  return new Response(
    JSON.stringify({
      error: {
        message: "Failed to assemble response from upstream stream",
        code: "stream_assemble_failed",
      },
    }),
    {
      status: 500,
      headers,
    },
  );
}

export async function* parseSseEvents(
  response: Response,
): AsyncGenerator<SseEvent, void, void> {
  if (!response.body) {
    return;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          if (dataLines.length > 0) {
            yield {
              event: eventName,
              data: dataLines.join("\n"),
            };
            eventName = "message";
            dataLines = [];
          }
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim() || "message";
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        idx = buffer.indexOf("\n");
      }
    }

    if (buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      yield {
        event: eventName,
        data: dataLines.join("\n"),
      };
    }
  } finally {
    reader.releaseLock();
  }
}

export function buildCookieHeader(options: GetChatgptSessionOptions) {
  if (options.cookieHeader?.trim()) return options.cookieHeader.trim();

  if (options.sessionToken && options.sessionToken.trim()) {
    return `__Secure-next-auth.session-token=${options.sessionToken.trim()}`;
  }

  if (options.sessionTokenChunks && options.sessionTokenChunks.length > 0) {
    return options.sessionTokenChunks
      .map(
        (chunk, idx) =>
          `__Secure-next-auth.session-token.${idx}=${chunk.trim()}`,
      )
      .join("; ");
  }

  throw new Error(
    "Missing session cookie. Provide sessionToken, sessionTokenChunks, or cookieHeader.",
  );
}

export function extractSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as unknown as {
    getSetCookie?: () => string[];
  };
  if (typeof withGetSetCookie.getSetCookie === "function") {
    const values = withGetSetCookie.getSetCookie();
    if (Array.isArray(values) && values.length > 0) return values;
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

export function extractSessionTokenCookies(
  setCookies: string[],
): SessionTokenCookieMap {
  const map: SessionTokenCookieMap = {};
  for (const line of setCookies) {
    const [pair] = line.split(";", 1);
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (
      name === "__Secure-next-auth.session-token" ||
      name.startsWith("__Secure-next-auth.session-token.")
    ) {
      map[name as keyof SessionTokenCookieMap] = value;
    }
  }
  return map;
}
