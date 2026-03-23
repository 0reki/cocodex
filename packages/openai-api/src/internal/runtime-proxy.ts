import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import {
  getUndiciRuntimeModule,
  undiciProxyDispatcherCache,
} from "./runtime-undici.ts";

export function normalizeProxyUrl(proxyUrl: string): string {
  const raw = proxyUrl.trim();
  if (!raw) {
    throw new Error("Proxy URL is empty");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `http://${raw}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
  }
  if (parsed.protocol === "https:" && isIP(parsed.hostname)) {
    parsed.protocol = "http:";
  }
  return parsed.toString();
}

async function getUndiciProxyDispatcher(proxyUrl: string) {
  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
  const cached = undiciProxyDispatcherCache.get(normalizedProxyUrl);
  if (cached) return cached;
  const runtime = await getUndiciRuntimeModule();
  const dispatcher = new runtime.ProxyAgent(normalizedProxyUrl);
  undiciProxyDispatcherCache.set(normalizedProxyUrl, dispatcher);
  return dispatcher;
}

export async function fetchWithOptionalProxy(
  input: string | URL | Request,
  init: RequestInit = {},
  proxyUrl?: string,
): Promise<Response> {
  const normalizedProxyUrl =
    typeof proxyUrl === "string" && proxyUrl.trim()
      ? normalizeProxyUrl(proxyUrl)
      : "";
  if (!normalizedProxyUrl) {
    return fetch(input, init);
  }
  const runtime = await getUndiciRuntimeModule();
  const dispatcher = await getUndiciProxyDispatcher(normalizedProxyUrl);
  return runtime.fetch(input, {
    ...(init as RequestInit & Record<string, unknown>),
    dispatcher,
  } as RequestInit);
}

export function createUpstreamHttpError(args: {
  label: string;
  status: number;
  responseText: string;
  responseUrl?: string;
  responseContentType?: string | null;
}): Error & {
  status: number;
  responseText: string;
  responseUrl?: string;
  responseContentType?: string | null;
} {
  const error = new Error(`${args.label}: HTTP ${args.status}`) as Error & {
    status: number;
    responseText: string;
    responseUrl?: string;
    responseContentType?: string | null;
  };
  error.status = args.status;
  error.responseText = args.responseText.slice(0, 4_000);
  if (args.responseUrl) {
    error.responseUrl = args.responseUrl;
  }
  error.responseContentType = args.responseContentType ?? null;
  return error;
}

function buildProxyAuthorizationHeader(proxy: URL): string | null {
  if (!proxy.username && !proxy.password) return null;
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function createWebSocketProxyConnection(
  proxyUrl: string,
  options: {
    host?: string | null;
    port?: number | string | null;
  },
  oncreate: (err: Error | null, socket: Duplex) => void,
  timeoutMs = 30_000,
): Duplex | undefined {
  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
  const proxy = new URL(normalizedProxyUrl);
  const targetHost =
    typeof options.host === "string" && options.host.trim()
      ? options.host.trim()
      : "";
  const targetPort = Number(options.port ?? 443);
  if (!targetHost || !Number.isFinite(targetPort) || targetPort <= 0) {
    queueMicrotask(() => {
      oncreate(
        new Error("Invalid websocket proxy target"),
        undefined as unknown as Duplex,
      );
    });
    return undefined;
  }

  let settled = false;
  const settle = (err: Error | null, socket?: Duplex) => {
    if (settled) return;
    settled = true;
    oncreate(err, (socket ?? undefined) as unknown as Duplex);
  };

  const requestFn = proxy.protocol === "https:" ? https.request : http.request;
  const proxyPort = Number(
    proxy.port || (proxy.protocol === "https:" ? 443 : 80),
  );
  const headers: Record<string, string> = {
    Host: `${targetHost}:${targetPort}`,
  };
  const proxyAuthorization = buildProxyAuthorizationHeader(proxy);
  if (proxyAuthorization) {
    headers["Proxy-Authorization"] = proxyAuthorization;
  }

  const request = requestFn({
    protocol: proxy.protocol,
    host: proxy.hostname,
    port: proxyPort,
    method: "CONNECT",
    path: `${targetHost}:${targetPort}`,
    headers,
    agent: false,
    servername:
      proxy.protocol === "https:" && !isIP(proxy.hostname)
        ? proxy.hostname
        : undefined,
  });

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
        request.destroy(new Error("Proxy CONNECT timeout"));
      }, timeoutMs)
      : null;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
  };

  request.once("connect", (response, socket, head) => {
    clearTimer();
    if (response.statusCode !== 200) {
      socket.destroy();
      settle(
        new Error(
          `Proxy CONNECT ${response.statusCode ?? 502}${response.statusMessage ? ` ${response.statusMessage}` : ""}`,
        ),
      );
      return;
    }
    if (head && head.length > 0) {
      socket.unshift(head);
    }
    const tlsSocket = tls.connect({
      socket,
      servername: !isIP(targetHost) ? targetHost : undefined,
      ALPNProtocols: ["http/1.1"],
    });
    tlsSocket.once("secureConnect", () => {
      settle(null, tlsSocket);
    });
    tlsSocket.once("error", (error) => {
      settle(error instanceof Error ? error : new Error(String(error)));
    });
  });

  request.once("error", (error) => {
    clearTimer();
    settle(error instanceof Error ? error : new Error(String(error)));
  });

  request.end();
  return undefined;
}
