function normalizeLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    normalized === "0.0.0.0"
  ) {
    return "localhost";
  }
  return normalized;
}

function normalizeOriginForComparison(value: string) {
  const url = new URL(value);
  const hostname = normalizeLoopbackHostname(url.hostname);
  const port =
    url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  return `${url.protocol}//${hostname}${port ? `:${port}` : ""}`;
}

export function resolveExternalOrigin(req: Request) {
  const configuredOrigin =
    process.env.PORTAL_PUBLIC_ORIGIN?.trim() ||
    process.env.APP_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_BASE_URL?.trim();
  if (configuredOrigin) {
    try {
      const url = new URL(configuredOrigin);
      if (url.protocol === "https:" || process.env.NODE_ENV !== "production") {
        return `${url.protocol}//${url.host}`;
      }
    } catch {
      // Fall through to request-derived origin.
    }
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PORTAL_PUBLIC_ORIGIN (or APP_BASE_URL) must be configured in production",
    );
  }
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export function isSameOriginRequest(req: Request) {
  const expectedOrigin = resolveExternalOrigin(req);
  const origin = req.headers.get("origin")?.trim();
  const referer = req.headers.get("referer")?.trim();
  const candidate = origin || referer;
  if (!candidate) return false;
  try {
    return (
      normalizeOriginForComparison(candidate) ===
      normalizeOriginForComparison(expectedOrigin)
    );
  } catch {
    return false;
  }
}

export function sanitizeNextPath(input: string | null | undefined) {
  if (!input) return "/";
  const value = input.trim();
  if (!value || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\") || value.includes("\\")) {
    return "/";
  }
  if (value.includes("://")) return "/";
  try {
    const base = new URL("https://internal.local");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return "/";
  }
}
