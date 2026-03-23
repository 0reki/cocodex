import type { Duplex } from "node:stream";
import {
  CHATGPT_CODEX_RESPONSES_WS_URL,
  WS_READY_STATE_CONNECTING,
  WS_READY_STATE_OPEN,
  buildCodexSentryHeaders,
  createWebSocketProxyConnection,
  getWsClientCtor,
} from "./runtime.ts";
import type {
  ConnectCodexResponsesWebSocketOptions,
  WsSocket,
} from "./runtime.ts";
import { resolveResponseTransport } from "./responses-shared.ts";

export async function connectCodexResponsesWebSocket(
  options: ConnectCodexResponsesWebSocketOptions,
): Promise<WsSocket> {
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

  const sentryHeaders = buildCodexSentryHeaders();
  const WsClientCtor = getWsClientCtor();
  const wsUrl = new URL(CHATGPT_CODEX_RESPONSES_WS_URL);
  if (options.serviceTier === "priority") {
    wsUrl.searchParams.set("service_tier", "priority");
  }

  const socketOptions: Record<string, unknown> = {
    headers: {
      ...transportHeaders,
      ...sentryHeaders,
      "openai-beta": "responses_websockets=2026-02-06",
    },
    handshakeTimeout: 30_000,
  };
  if (typeof options.proxyUrl === "string" && options.proxyUrl.trim()) {
    socketOptions.createConnection = (
      createOptions: { host?: string | null; port?: number | string | null },
      oncreate: (err: Error | null, socket: Duplex) => void,
    ) =>
      createWebSocketProxyConnection(
        options.proxyUrl as string,
        createOptions,
        oncreate,
        30_000,
      );
  }

  const socket = new WsClientCtor(wsUrl.toString(), socketOptions);

  return await new Promise<WsSocket>((resolve, reject) => {
    let settled = false;
    const swallowSocketError = () => {};

    const cleanup = () => {
      socket.off("open", onOpen);
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
      resolve(socket);
    };

    const onAbort = () => {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      settleReject(abortError);
    };

    const onOpen = () => {
      settleResolve();
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
          new Error(`responses websocket ${status}: ${body.slice(0, 500)}`),
        );
      });
      response.on("error", () => {
        settleReject(new Error(`responses websocket ${status}`));
      });
    };

    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("unexpected-response", onUnexpectedResponse);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
