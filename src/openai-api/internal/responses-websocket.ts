import {
  WS_READY_STATE_CONNECTING,
  WS_READY_STATE_OPEN,
  getWsClientCtor,
} from "./runtime-platform.ts";
import { CHATGPT_CODEX_RESPONSES_WS_URL } from "./runtime-constants.ts";
import type { WsUpgradeResponse } from "./runtime-platform.ts";
import type {
  CodexResponsesWebSocketConnection,
  ConnectCodexResponsesWebSocketOptions,
} from "./runtime-types.ts";
import { resolveResponseTransport } from "./responses-shared.ts";

const CODEX_WEBSOCKET_RESPONSE_HEADERS = [
  "openai-model",
  "x-codex-turn-state",
  "x-reasoning-included",
] as const;

function getCodexWebSocketResponseHeaders(response: WsUpgradeResponse) {
  const headers: Record<string, string> = {};
  for (const name of CODEX_WEBSOCKET_RESPONSE_HEADERS) {
    const value = response.headers[name];
    const normalized = Array.isArray(value) ? value[0] : value;
    if (normalized !== undefined) headers[name] = normalized;
  }
  return headers;
}

export async function connectCodexResponsesWebSocket(
  options: ConnectCodexResponsesWebSocketOptions,
): Promise<CodexResponsesWebSocketConnection> {
  const { transportHeaders } = resolveResponseTransport({
    ...options,
    sessionId:
      typeof options.sessionId === "string" && options.sessionId.trim()
        ? options.sessionId
        : globalThis.crypto.randomUUID(),
  });

  if (options.signal?.aborted) {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    throw abortError;
  }

  const WsClientCtor = getWsClientCtor();
  const wsUrl = new URL(CHATGPT_CODEX_RESPONSES_WS_URL);
  if (options.query) {
    const query = new URLSearchParams(options.query.replace(/^\?/, ""));
    query.forEach((value, name) => wsUrl.searchParams.append(name, value));
  }

  const headers = new Headers(transportHeaders);
  headers.set("openai-beta", "responses_websockets=2026-02-06");
  const socketOptions: Record<string, unknown> = {
    headers: Object.fromEntries(headers.entries()),
    handshakeTimeout: 30_000,
  };
  const socket = new WsClientCtor(wsUrl.toString(), socketOptions);

  return await new Promise<CodexResponsesWebSocketConnection>(
    (resolve, reject) => {
      let settled = false;
      let responseHeaders: Record<string, string> = {};
      const swallowSocketError = () => {};

      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("upgrade", onUpgrade);
        socket.off("error", onError);
        socket.off("unexpected-response", onUnexpectedResponse);
        options.signal?.removeEventListener("abort", onAbort);
      };

      const settleReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.on("error", swallowSocketError);
        try {
          if (socket.readyState === WS_READY_STATE_CONNECTING) {
            socket.close();
          } else if (socket.readyState === WS_READY_STATE_OPEN) {
            socket.terminate();
          }
        } catch {
          // Ignore socket teardown errors after rejecting the connection attempt.
        }
        queueMicrotask(() => {
          socket.off("error", swallowSocketError);
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ socket, responseHeaders });
      };

      const onAbort = () => {
        const abortError = new Error("Aborted");
        abortError.name = "AbortError";
        settleReject(abortError);
      };

      const onOpen = () => {
        settleResolve();
      };

      const onUpgrade = (response: WsUpgradeResponse) => {
        responseHeaders = getCodexWebSocketResponseHeaders(response);
      };

      const onError = (error: Error) => {
        settleReject(error);
      };

      const onUnexpectedResponse = (
        _request: unknown,
        response: {
          statusCode?: number;
          on: (
            event: "data" | "end" | "error",
            listener: (...args: unknown[]) => void,
          ) => void;
        },
      ) => {
        const status = Number(response.statusCode ?? 0);
        const chunks: Buffer[] = [];
        response.on("data", (chunk: unknown) => {
          if (Buffer.isBuffer(chunk)) chunks.push(chunk);
          else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          settleReject(
            new Error(
              `responses websocket HTTP ${status}: ${body.slice(0, 500)}`,
            ),
          );
        });
        response.on("error", () => {
          settleReject(new Error(`responses websocket HTTP ${status}`));
        });
      };

      socket.once("open", onOpen);
      socket.once("upgrade", onUpgrade);
      socket.once("error", onError);
      socket.once("unexpected-response", onUnexpectedResponse);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    },
  );
}
