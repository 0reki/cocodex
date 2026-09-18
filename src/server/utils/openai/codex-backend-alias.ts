const CODEX_RESPONSES_PATHS = new Set([
  "/backend-api/codex/responses",
]);

function normalizePathname(pathname: string | null | undefined) {
  if (!pathname) return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

export function isCodexBackendApiPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === "/backend-api" || normalized.startsWith("/backend-api/");
}

export function isCodexResponsesPath(pathname: string | null | undefined): boolean {
  return CODEX_RESPONSES_PATHS.has(normalizePathname(pathname));
}

export type CodexBackendForwardKind =
  | "responses"
  | "images"
  | "search"
  | "passthrough";

export function classifyCodexBackendForward(
  pathname: string,
): CodexBackendForwardKind {
  const normalized = normalizePathname(pathname);
  if (normalized === "/backend-api/codex/responses") return "responses";
  if (
    normalized === "/backend-api/codex/images/generations" ||
    normalized === "/backend-api/codex/images/edits"
  ) {
    return "images";
  }
  if (normalized === "/backend-api/codex/alpha/search") return "search";
  return "passthrough";
}

export function isPublicCodexClientPath(pathname: string): boolean {
  return (
    pathname === "/codex/device" ||
    pathname.startsWith("/codex/device/") ||
    pathname === "/oauth/authorize" ||
    pathname === "/oauth/token" ||
    pathname === "/oauth/revoke" ||
    pathname.startsWith("/api/accounts/deviceauth/") ||
    pathname.startsWith("/deviceauth/")
  );
}
