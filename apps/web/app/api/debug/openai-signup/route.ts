import { getBackendBaseUrl } from "@/lib/backend/backend-base-url";
import { requireAdminForApi } from "@/lib/auth/api-route-auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const authed = await requireAdminForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;
  const base = getBackendBaseUrl();
  const url = new URL(req.url);
  const limit = url.searchParams.get("limit");
  const suffix = limit ? `?limit=${encodeURIComponent(limit)}` : "";
  const upstream = await fetch(`${base}/api/openai-signup/tasks${suffix}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}

export async function POST(req: Request) {
  const authed = await requireAdminForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;

  try {
    const body = await req.text();
    const base = getBackendBaseUrl();
    const upstream = await fetch(`${base}/api/openai-signup/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body || "{}",
      cache: "no-store",
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return Response.json(
      {
        error: "upstream_request_failed",
      },
      { status: 500 },
    );
  }
}
