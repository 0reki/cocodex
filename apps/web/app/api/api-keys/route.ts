import { getBackendBaseUrl } from "@/lib/backend/backend-base-url";
import { requireSessionForApi } from "@/lib/auth/api-route-auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;
  const base = getBackendBaseUrl();
  const upstream = await fetch(`${base}/api/api-keys`, {
    method: "GET",
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

export async function POST(req: Request) {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;
  const base = getBackendBaseUrl();
  const body = await req.text();
  const upstream = await fetch(`${base}/api/api-keys`, {
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
}
