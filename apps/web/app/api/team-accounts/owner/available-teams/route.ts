import { getBackendBaseUrl } from "@/lib/backend/backend-base-url";
import { requireAdminForApi } from "@/lib/auth/api-route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const authed = await requireAdminForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;

  try {
    const base = getBackendBaseUrl();
    const upstream = await fetch(`${base}/api/team-accounts/owner/available-teams`, {
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
  } catch {
    return Response.json(
      {
        error: "upstream_request_failed",
      },
      { status: 500 },
    );
  }
}
