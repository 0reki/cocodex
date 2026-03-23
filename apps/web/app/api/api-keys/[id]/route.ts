import { getBackendBaseUrl } from "@/lib/backend/backend-base-url";
import { requireSessionForApi } from "@/lib/auth/api-route-auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;
  const { id } = await context.params;
  const base = getBackendBaseUrl();
  const upstream = await fetch(`${base}/api/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
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

export async function PUT(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;
  const { id } = await context.params;
  const base = getBackendBaseUrl();
  const body = await req.text();
  const upstream = await fetch(`${base}/api/api-keys/${encodeURIComponent(id)}`, {
    method: "PUT",
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
}
