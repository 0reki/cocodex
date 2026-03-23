import { deleteTeamAccountsByEmails, ensureDatabaseSchema } from "@workspace/database";
import { requireAdminForApi } from "@/lib/auth/api-route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const authed = await requireAdminForApi();
  if (authed instanceof Response) {
    return authed;
  }

  await ensureDatabaseSchema();

  const body = (await req.json().catch(() => null)) as
    | { emails?: unknown }
    | null;
  const emails = Array.isArray(body?.emails)
    ? body.emails.filter((item): item is string => typeof item === "string")
    : [];

  if (emails.length === 0) {
    return Response.json({ error: "emails must be a non-empty string array" }, { status: 400 });
  }

  const deleted = await deleteTeamAccountsByEmails(emails);
  return Response.json({ ok: true, deleted });
}
