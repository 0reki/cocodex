import type {
  GetChatgptSessionOptions,
  SessionTokenCookieMap,
} from "./runtime-types.ts";

type SseEvent = { event: string; data: string };

export async function* parseSseEvents(
  response: Response,
): AsyncGenerator<SseEvent, void, void> {
  if (!response.body) return;
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
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const rawLine = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          if (dataLines.length > 0) {
            yield { event: eventName, data: dataLines.join("\n") };
            eventName = "message";
            dataLines = [];
          }
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim() || "message";
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        index = buffer.indexOf("\n");
      }
    }
    if (buffer.startsWith("data:")) {
      dataLines.push(buffer.slice(5).trimStart());
    }
    if (dataLines.length > 0) {
      yield { event: eventName, data: dataLines.join("\n") };
    }
  } finally {
    reader.releaseLock();
  }
}

export async function assembleResponseFromEventStream(response: Response) {
  let completedResponse: Record<string, unknown> | null = null;
  let latestResponse: Record<string, unknown> | null = null;
  let streamError: Record<string, unknown> | null = null;
  for await (const event of parseSseEvents(response)) {
    if (!event.data.trim() || event.data.trim() === "[DONE]") continue;
    try {
      const parsed = JSON.parse(event.data) as Record<string, unknown>;
      if (parsed.object === "response") latestResponse = parsed;
      if (parsed.response && typeof parsed.response === "object") {
        latestResponse = parsed.response as Record<string, unknown>;
      }
      const type =
        typeof parsed.type === "string" ? parsed.type : event.event;
      if (
        type === "response.completed" &&
        parsed.response &&
        typeof parsed.response === "object"
      ) {
        completedResponse = parsed.response as Record<string, unknown>;
        break;
      }
      if (type === "error" || type === "response.error" || type === "response.failed") {
        streamError = parsed;
      } else if (parsed.error && typeof parsed.error === "object") {
        streamError = parsed.error as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  const body = completedResponse ?? latestResponse;
  if (body) {
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return new Response(
    JSON.stringify({
      error: streamError ?? {
        message: "Failed to assemble response from upstream stream",
        code: "stream_assemble_failed",
      },
    }),
    { status: streamError ? 500 : 502, headers },
  );
}

export function buildCookieHeader(options: GetChatgptSessionOptions) {
  if (options.cookieHeader?.trim()) return options.cookieHeader.trim();
  if (options.sessionToken?.trim()) {
    return `__Secure-next-auth.session-token=${options.sessionToken.trim()}`;
  }
  if (options.sessionTokenChunks?.length) {
    return options.sessionTokenChunks
      .map(
        (chunk, index) =>
          `__Secure-next-auth.session-token.${index}=${chunk.trim()}`,
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
    if (values.length > 0) return values;
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

export function extractSessionTokenCookies(
  setCookies: string[],
): SessionTokenCookieMap {
  const cookies: SessionTokenCookieMap = {};
  for (const line of setCookies) {
    const [pair] = line.split(";", 1);
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (
      name === "__Secure-next-auth.session-token" ||
      name.startsWith("__Secure-next-auth.session-token.")
    ) {
      cookies[name as keyof SessionTokenCookieMap] = pair.slice(separator + 1);
    }
  }
  return cookies;
}
