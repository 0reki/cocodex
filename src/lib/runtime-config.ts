export type OpenAIApiEndpoint = {
  id: string;
  label: string;
  baseUrl: string;
};

function parseEndpoint(value: unknown): OpenAIApiEndpoint | null {
  if (!value || typeof value !== "object") return null;
  const endpoint = value as Record<string, unknown>;
  const id = typeof endpoint.id === "string" ? endpoint.id.trim() : "";
  const label =
    typeof endpoint.label === "string" ? endpoint.label.trim() : "";
  const rawBaseUrl =
    typeof endpoint.baseUrl === "string" ? endpoint.baseUrl.trim() : "";
  if (!id || !label || !rawBaseUrl) return null;

  try {
    const baseUrl = new URL(rawBaseUrl);
    if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
      return null;
    }
    baseUrl.hash = "";
    baseUrl.search = "";
    return {
      id,
      label,
      baseUrl: baseUrl.toString().replace(/\/+$/, ""),
    };
  } catch {
    return null;
  }
}

export async function loadOpenAIApiEndpoints(signal?: AbortSignal) {
  const fallback: OpenAIApiEndpoint[] = [
    {
      id: "same-origin",
      label: "当前站点",
      baseUrl: window.location.origin,
    },
  ];

  try {
    const response = await fetch("/config.json", {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) return fallback;
    const payload = (await response.json()) as Record<string, unknown>;
    if (!Array.isArray(payload.openaiApiEndpoints)) return fallback;

    const ids = new Set<string>();
    const endpoints = payload.openaiApiEndpoints.flatMap((value) => {
      const endpoint = parseEndpoint(value);
      if (!endpoint || ids.has(endpoint.id)) return [];
      ids.add(endpoint.id);
      return [endpoint];
    });
    return endpoints.length > 0 ? endpoints : fallback;
  } catch {
    return fallback;
  }
}
