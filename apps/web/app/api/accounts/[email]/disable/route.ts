import {
  disableOpenAIAccountByEmail,
  disableTeamAccountByEmail,
  ensureDatabaseSchema,
  getOpenAIAccountByEmail,
  getTeamAccountLoginByEmail,
} from "@workspace/database";
import { requireSessionForApi } from "@/lib/auth/api-route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeEmail(value: string) {
  return decodeURIComponent(value).trim().toLowerCase();
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
    const updated = await disableOpenAIAccountByEmail(email);
    return updated
      ? Response.json({ ok: true })
      : Response.json({ error: "Account not found" }, { status: 404 });
  }

  const team = await getTeamAccountLoginByEmail(email);
  if (!team) {
    return Response.json({ error: "Account not found" }, { status: 404 });
  }
  if (team.portalUserId !== authed.session.sub) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const updated = await disableTeamAccountByEmail(email);
  return updated
    ? Response.json({ ok: true })
    : Response.json({ error: "Account not found" }, { status: 404 });
}
