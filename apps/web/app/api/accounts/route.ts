import {
  deleteOpenAIAccountByEmail,
  deleteTeamAccountByEmail,
  ensureDatabaseSchema,
  getOpenAIAccountByEmail,
  getTeamAccountLoginByEmail,
  listOpenAIAccountsByUserId,
  listTeamAccountsByUserId,
} from "@workspace/database";
import { requireSessionForApi } from "@/lib/auth/api-route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sanitizeAccountItem<T extends Record<string, unknown>>(item: T) {
  const {
    accessToken: _accessToken,
    refreshToken: _refreshToken,
    sessionToken: _sessionToken,
    ...safe
  } = item;
  return safe;
}

export async function GET() {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }

  await ensureDatabaseSchema();
  const [openaiAccounts, teamAccounts] = await Promise.all([
    listOpenAIAccountsByUserId(authed.session.sub),
    listTeamAccountsByUserId(authed.session.sub),
  ]);

  return Response.json({
    items: [
      ...openaiAccounts.map((item) =>
        sanitizeAccountItem({ ...item, kind: "openai" as const }),
      ),
      ...teamAccounts.map((item) => ({
        ...sanitizeAccountItem(item),
        kind:
          item.accountUserRole === "account-owner"
            ? ("team-owner" as const)
            : ("team-member" as const),
      })),
    ],
  });
}

export async function DELETE(req: Request) {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }

  await ensureDatabaseSchema();

  const body = (await req.json().catch(() => null)) as { emails?: unknown } | null;
  const emails = Array.isArray(body?.emails)
    ? body.emails
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    : [];

  if (emails.length === 0) {
    return Response.json(
      { error: "emails must be a non-empty string array" },
      { status: 400 },
    );
  }

  let deleted = 0;
  for (const email of emails) {
    const openai = await getOpenAIAccountByEmail(email);
    if (openai && openai.portalUserId === authed.session.sub) {
      if (await deleteOpenAIAccountByEmail(email)) {
        deleted += 1;
      }
      continue;
    }

    const team = await getTeamAccountLoginByEmail(email);
    if (team && team.portalUserId === authed.session.sub) {
      if (await deleteTeamAccountByEmail(email)) {
        deleted += 1;
      }
    }
  }

  return Response.json({ ok: true, deleted });
}
