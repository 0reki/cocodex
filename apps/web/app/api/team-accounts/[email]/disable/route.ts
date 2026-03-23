import { disableTeamAccountByEmail, ensureDatabaseSchema } from "@workspace/database";
import { requireAdminForApi } from "@/lib/auth/api-route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
  context: { params: Promise<{ email: string }> },
) {
  const authed = await requireAdminForApi();
  if (authed instanceof Response) {
    return authed;
  }

  await ensureDatabaseSchema();
  const { email } = await context.params;
  const updated = await disableTeamAccountByEmail(email);

  if (!updated) {
    return Response.json({ error: "Team account not found" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
