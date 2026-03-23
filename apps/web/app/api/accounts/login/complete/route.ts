import { requireSessionForApi } from "@/lib/auth/api-route-auth";
import { completeOpenAIAccountLogin } from "@/lib/backend/openai-account-login";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: Request) {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = normalizeString(body?.sessionId);
  const workspaceId = normalizeString(body?.workspaceId);

  try {
    const result = await completeOpenAIAccountLogin({
      portalUserId: authed.session.sub,
      sessionId,
      workspaceId,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "workspace selection failed" },
      { status: 400 },
    );
  }
}
