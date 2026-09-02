import type { IncomingHttpHeaders } from "node:http";
import type { Response } from "express";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PROXY_CONTEXT_HEADERS = new Set([
  "cookie",
  "forwarded",
  "origin",
  "via",
  "x-real-ip",
]);

const PROXY_CONTEXT_HEADER_PREFIXES = ["cf-", "x-forwarded-"];

export function getForwardRequestHeaders(headers: IncomingHttpHeaders) {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      PROXY_CONTEXT_HEADERS.has(normalized) ||
      PROXY_CONTEXT_HEADER_PREFIXES.some((prefix) =>
        normalized.startsWith(prefix),
      ) ||
      normalized.startsWith("sec-websocket-")
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) forwarded.append(name, item);
    } else {
      forwarded.set(name, value);
    }
  }
  forwarded.delete("content-length");
  return forwarded;
}

export function applyUpstreamResponseHeaders(res: Response, headers: Headers) {
  headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      normalized === "content-length" ||
      normalized === "content-encoding"
    ) {
      return;
    }
    res.setHeader(name, value);
  });
}
