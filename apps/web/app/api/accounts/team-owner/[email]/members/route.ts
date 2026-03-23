import { getBackendBaseUrl } from "@/lib/backend/backend-base-url";
import { requireSessionForApi } from "@/lib/auth/api-route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function withUserProxy(
  context: { params: Promise<{ email: string }> },
  init: RequestInit,
) {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;

  try {
    const { email } = await context.params;
    const base = getBackendBaseUrl();
    const outgoingHeaders = {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    };
    const upstream = await fetch(
      `${base}/api/team-accounts/owner/${encodeURIComponent(email)}/members`,
      {
        ...init,
        headers: outgoingHeaders,
        cache: "no-store",
      },
    );
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

export async function GET(
  _req: Request,
  context: { params: Promise<{ email: string }> },
) {
  return withUserProxy(context, { method: "GET" });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ email: string }> },
) {
  const body = await req.text();
  return withUserProxy(context, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ email: string }> },
) {
  const body = await req.text();
  return withUserProxy(context, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
}
