import {
  disableOpenAIAccountByEmail,
  disableTeamAccountByEmail,
  ensureDatabaseSchema,
  getOpenAIAccountByEmail,
  getTeamAccountLoginByEmail,
  updateOpenAIAccountRateLimitById,
  updateTeamAccountRateLimitById,
} from "@workspace/database";
import { getWhamUsage } from "@workspace/openai-api/accounts";
import { requireSessionForApi } from "@/lib/auth/api-route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeEmail(value: string) {
  return decodeURIComponent(value).trim().toLowerCase();
}

function normalizeWhamRateLimitPayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const nested =
    payload.rate_limit && typeof payload.rate_limit === "object"
      ? (payload.rate_limit as Record<string, unknown>)
      : null;
  if (!nested) return null;
  return {
    ...nested,
    ...(payload.additional_rate_limits !== undefined
      ? { additional_rate_limits: payload.additional_rate_limits }
      : {}),
    ...(payload.code_review_rate_limit !== undefined
      ? { code_review_rate_limit: payload.code_review_rate_limit }
      : {}),
  };
}

function shouldDisableOnWhamUsageError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("HTTP 402");
}

export async function POST(
  _req: Request,
  context: { params: Promise<{ email: string }> },
) {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }

  await ensureDatabaseSchema();
  const { email: rawEmail } = await context.params;
  const email = normalizeEmail(rawEmail);

  const openai = await getOpenAIAccountByEmail(email);
  if (openai) {
    if (openai.portalUserId !== authed.session.sub) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!openai.accessToken) {
      return Response.json({ error: "Account has no access token" }, { status: 400 });
    }
    if (!openai.accountId) {
      return Response.json({ error: "Account has no account id" }, { status: 400 });
    }
    let rateLimit: Awaited<ReturnType<typeof getWhamUsage>>;
    try {
      rateLimit = await getWhamUsage({
        accessToken: openai.accessToken,
        accountId: openai.accountId,
      });
    } catch (error) {
      if (shouldDisableOnWhamUsageError(error)) {
        await disableOpenAIAccountByEmail(email);
      }
      throw error;
    }
    await updateOpenAIAccountRateLimitById(
      openai.id,
      normalizeWhamRateLimitPayload(rateLimit as Record<string, unknown>),
    );
    return Response.json({ ok: true });
  }

  const team = await getTeamAccountLoginByEmail(email);
  if (!team) {
    return Response.json({ error: "Account not found" }, { status: 404 });
  }
  if (team.portalUserId !== authed.session.sub) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!team.accessToken) {
    return Response.json({ error: "Account has no access token" }, { status: 400 });
  }
  if (!team.accountId) {
    return Response.json({ error: "Account has no account id" }, { status: 400 });
  }

  let rateLimit: Awaited<ReturnType<typeof getWhamUsage>>;
  try {
    rateLimit = await getWhamUsage({
      accessToken: team.accessToken,
      accountId: team.accountId,
    });
  } catch (error) {
    if (shouldDisableOnWhamUsageError(error)) {
      await disableTeamAccountByEmail(email);
    }
    throw error;
  }
  await updateTeamAccountRateLimitById(
    team.id,
    normalizeWhamRateLimitPayload(rateLimit as Record<string, unknown>),
  );
  return Response.json({ ok: true });
}
