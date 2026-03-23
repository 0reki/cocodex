import { requireSessionForApi } from "@/lib/auth/api-route-auth";
import {
  startOpenAIAccountLogin,
  startStoredOpenAIAccountLogin,
} from "@/lib/backend/openai-account-login";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBoolean(value: unknown) {
  return value === true;
}

export async function POST(req: Request) {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const email = normalizeString(body?.email);
  const password = normalizeString(body?.password);
  const relogin = body?.relogin === true;
  const systemCreatedHint = normalizeBoolean(body?.systemCreated);
  console.info(
    `[accounts-login-route] start ${JSON.stringify({
      email,
      relogin,
      systemCreatedHint,
      hasPassword: Boolean(password),
    })}`,
  );

  try {
    const result = relogin
      ? await startStoredOpenAIAccountLogin({
          portalUserId: authed.session.sub,
          email,
          systemCreatedHint,
        })
      : await startOpenAIAccountLogin({
          portalUserId: authed.session.sub,
          email,
          password,
        });
    if (result && typeof result === "object" && "requiresOtp" in result) {
      console.info(
        `[accounts-login-route] result ${JSON.stringify({
          email,
          requiresOtp: result.requiresOtp,
          sessionId: "sessionId" in result ? result.sessionId : null,
        })}`,
      );
      return Response.json({ ok: true, ...result });
    }
    console.info(
      `[accounts-login-route] done ${JSON.stringify({
        email,
        hasAccount: Boolean(result && typeof result === "object" && "account" in result),
      })}`,
    );
    return Response.json({
      ok: true,
      ...(result && typeof result === "object" ? result : {}),
    });
  } catch (error) {
    console.error(
      `[accounts-login-route] failed ${JSON.stringify({
        email,
        error: error instanceof Error ? error.message : "login failed",
      })}`,
    );
    return Response.json(
      { error: error instanceof Error ? error.message : "login failed" },
      { status: 400 },
    );
  }
}
