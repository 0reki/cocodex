import { requireSessionForApi } from "@/lib/auth/api-route-auth";
import { verifyOpenAIAccountOtp } from "@/lib/backend/openai-account-login";

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
  const code = normalizeString(body?.code);

  try {
    const result = await verifyOpenAIAccountOtp({
      portalUserId: authed.session.sub,
      sessionId,
      code,
    });
    if (result && typeof result === "object" && "requiresWorkspace" in result) {
      return Response.json({ ok: true, ...result });
    }
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "otp verification failed" },
      { status: 400 },
    );
  }
}
