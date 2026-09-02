const apiBase = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function readError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object")
    return { message: fallback, code: null };
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") {
    return {
      message: record.detail
        ? `${record.error}: ${String(record.detail)}`
        : record.error,
      code: null,
    };
  }
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    return {
      message: typeof error.message === "string" ? error.message : fallback,
      code: typeof error.code === "string" ? error.code : null,
    };
  }
  return {
    message: typeof record.detail === "string" ? record.detail : fallback,
    code: null,
  };
}

export async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);

  const response = await fetch(`${apiBase}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = readError(payload, `Request failed (${response.status})`);
    throw new ApiError(detail.message, response.status, detail.code);
  }
  return payload as T;
}

export function jsonBody(
  value: unknown,
): Pick<RequestInit, "body" | "headers"> {
  return {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
  };
}
