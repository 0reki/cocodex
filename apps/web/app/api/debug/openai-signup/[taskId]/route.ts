import { getBackendBaseUrl } from "@/lib/backend/backend-base-url";
import { requireAdminForApi } from "@/lib/auth/api-route-auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const authed = await requireAdminForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;
  const { taskId } = await context.params;
  const base = getBackendBaseUrl();
  const upstream = await fetch(
    `${base}/api/openai-signup/tasks/${encodeURIComponent(taskId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
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
}

export async function POST(
  req: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const authed = await requireAdminForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;
  const { taskId } = await context.params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (action !== "start" && action !== "stop") {
    return Response.json(
      { ok: false, error: "action must be 'start' or 'stop'" },
      { status: 400 },
    );
  }

  const base = getBackendBaseUrl();
  const upstream = await fetch(
    `${base}/api/openai-signup/tasks/${encodeURIComponent(taskId)}/${action}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
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
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const authed = await requireAdminForApi();
  if (authed instanceof Response) {
    return authed;
  }
  const { token } = authed;
  const { taskId } = await context.params;
  const base = getBackendBaseUrl();
  const upstream = await fetch(
    `${base}/api/openai-signup/tasks/${encodeURIComponent(taskId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
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
}
