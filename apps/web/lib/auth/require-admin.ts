import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { resolvePortalSessionFromCookieStore } from "@/lib/auth/admin-auth";

export async function requireAuth(nextPath: string) {
  const cookieStore = await cookies();
  const resolved = await resolvePortalSessionFromCookieStore(cookieStore);
  if (!resolved) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  const payload = resolved.session;
  if (payload.mustSetup && nextPath !== "/setup") {
    redirect("/setup?reason=setup_required");
  }
  return payload;
}

export async function requireAdmin(nextPath: string) {
  const payload = await requireAuth(nextPath);
  if (payload.role !== "admin") {
    redirect("/dashboard");
  }
  return payload;
}
