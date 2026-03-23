import WebSocket from "ws";

type WsListener = (...args: unknown[]) => void;

type WsUnexpectedResponse = {
  statusCode?: number;
  on: (
    event: "data" | "end" | "error",
    listener: (...args: unknown[]) => void,
  ) => void;
};

export type WsSocket = {
  readyState: number;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on(event: "open", listener: () => void): WsSocket;
  on(event: "error", listener: (error: Error) => void): WsSocket;
  on(
    event: "unexpected-response",
    listener: (request: unknown, response: WsUnexpectedResponse) => void,
  ): WsSocket;
  on(event: string, listener: WsListener): WsSocket;
  once(event: "open", listener: () => void): WsSocket;
  once(event: "error", listener: (error: Error) => void): WsSocket;
  once(
    event: "unexpected-response",
    listener: (request: unknown, response: WsUnexpectedResponse) => void,
  ): WsSocket;
  once(event: string, listener: WsListener): WsSocket;
  off(event: "open", listener: () => void): WsSocket;
  off(event: "error", listener: (error: Error) => void): WsSocket;
  off(
    event: "unexpected-response",
    listener: (request: unknown, response: WsUnexpectedResponse) => void,
  ): WsSocket;
  off(event: string, listener: WsListener): WsSocket;
};

type WsClientCtor = new (
  address: string,
  options?: Record<string, unknown>,
) => WsSocket;

export function getWsClientCtor(): WsClientCtor {
  return WebSocket as unknown as WsClientCtor;
}

export const WS_READY_STATE_CONNECTING = 0;
export const WS_READY_STATE_OPEN = 1;
