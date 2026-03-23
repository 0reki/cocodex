import { STATUS_CODES, type IncomingMessage } from "node:http";
import { type Socket as NetSocket } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";

export type WsRawData = string | Buffer | ArrayBuffer | Buffer[];

export type WsSocket = {
  readyState: number;
  send: (
    data: WsRawData,
    options?: { binary?: boolean },
    cb?: (error?: Error) => void,
  ) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on: {
    (
      event: "message",
      listener: (data: WsRawData, isBinary: boolean) => void,
    ): WsSocket;
    (
      event: "close",
      listener: (code: number, reason: Buffer) => void,
    ): WsSocket;
    (event: "error", listener: (error: Error) => void): WsSocket;
    (event: string, listener: (...args: unknown[]) => void): WsSocket;
  };
  once: {
    (event: "open", listener: () => void): WsSocket;
    (
      event: "unexpected-response",
      listener: (request: unknown, response: unknown) => void,
    ): WsSocket;
    (event: "error", listener: (error: Error) => void): WsSocket;
    (event: string, listener: (...args: unknown[]) => void): WsSocket;
  };
  off: (event: string, listener: (...args: unknown[]) => void) => WsSocket;
};

export type WsServer = {
  handleUpgrade: (
    request: IncomingMessage,
    socket: NetSocket | Duplex,
    head: Buffer,
    callback: (socket: WsSocket, request: IncomingMessage) => void,
  ) => void;
};

type WsSocketCtorType = {
  new(address: string, options?: Record<string, unknown>): WsSocket;
  CONNECTING?: number;
  OPEN?: number;
};

export const WsSocketCtor = WebSocket as unknown as WsSocketCtorType;
export const WsServerCtor = WebSocketServer as unknown as new (options: {
  noServer?: boolean;
}) => WsServer;
export const WS_READY_STATE_CONNECTING = Number.isFinite(WsSocketCtor.CONNECTING)
  ? Math.trunc(WsSocketCtor.CONNECTING as number)
  : 0;
export const WS_READY_STATE_OPEN = Number.isFinite(WsSocketCtor.OPEN)
  ? Math.trunc(WsSocketCtor.OPEN as number)
  : 1;

export function parseUpgradeUrl(req: IncomingMessage): URL | null {
  const rawUrl = typeof req.url === "string" ? req.url : "";
  if (!rawUrl) return null;
  try {
    const host =
      typeof req.headers.host === "string" && req.headers.host.trim()
        ? req.headers.host.trim()
        : "localhost";
    return new URL(rawUrl, `http://${host}`);
  } catch {
    return null;
  }
}

export function parseUpgradePathname(req: IncomingMessage): string | null {
  const parsedUrl = parseUpgradeUrl(req);
  if (parsedUrl) return parsedUrl.pathname;
  const rawUrl = typeof req.url === "string" ? req.url : "";
  if (!rawUrl) return null;
  return rawUrl.split("?")[0] ?? rawUrl;
}

export function parseUpgradeQueryParam(
  req: IncomingMessage,
  key: string,
): string | null {
  const parsedUrl = parseUpgradeUrl(req);
  if (parsedUrl) {
    const value = parsedUrl.searchParams.get(key);
    return value === null ? null : value;
  }
  const rawUrl = typeof req.url === "string" ? req.url : "";
  if (!rawUrl) return null;
  const queryStart = rawUrl.indexOf("?");
  if (queryStart < 0) return null;
  try {
    return new URLSearchParams(rawUrl.slice(queryStart + 1)).get(key);
  } catch {
    return null;
  }
}

export function sendWebSocketUpgradeErrorResponse(
  socket: NetSocket | Duplex,
  status: number,
  body: Record<string, unknown>,
) {
  if (socket.destroyed) return;
  const safeStatus = Number.isFinite(status)
    ? Math.max(400, Math.min(599, Math.trunc(status)))
    : 500;
  const reason = STATUS_CODES[safeStatus] ?? "Error";
  const payload = JSON.stringify(body);
  const headers = [
    `HTTP/1.1 ${safeStatus} ${reason}`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(payload)}`,
    "",
    payload,
  ];
  socket.write(headers.join("\r\n"));
  socket.destroy();
}

export function wsRawDataToText(data: WsRawData): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    const buffers = data.map((item) =>
      Buffer.isBuffer(item) ? item : Buffer.from(item),
    );
    return Buffer.concat(buffers).toString("utf8");
  }
  return null;
}

export function normalizeWsCloseCode(code: number, fallback = 1000): number {
  if (!Number.isFinite(code)) return fallback;
  const value = Math.trunc(code);
  if (value === 1000) return value;
  if (
    value >= 1001 &&
    value <= 1014 &&
    value !== 1004 &&
    value !== 1005 &&
    value !== 1006
  ) {
    return value;
  }
  if (value >= 3000 && value <= 4999) return value;
  return fallback;
}

export function normalizeWsCloseReason(reason: string): string {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) return "";
  const bytes = Buffer.from(trimmed);
  if (bytes.byteLength <= 123) return trimmed;
  return bytes.subarray(0, 123).toString("utf8");
}
