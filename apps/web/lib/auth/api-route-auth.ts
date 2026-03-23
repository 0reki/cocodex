import { cookies } from "next/headers";
import {
  type PortalSessionPayload,
  resolvePortalSessionFromCookieStore,
} from "@/lib/auth/admin-auth";

type AuthenticatedApiSession = {
  token: string;
  session: PortalSessionPayload;
};

function unauthorizedResponse() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return Response.json({ error: "Forbidden" }, { status: 403 });
}

export async function requireSessionForApi(): Promise<
  AuthenticatedApiSession | Response
> {
  const cookieStore = await cookies();
  const resolved = await resolvePortalSessionFromCookieStore(cookieStore);
  if (!resolved) {
    return unauthorizedResponse();
  }
  return { token: resolved.accessToken, session: resolved.session };
}

export async function requireAdminForApi(): Promise<
  AuthenticatedApiSession | Response
> {
  const authed = await requireSessionForApi();
  if (authed instanceof Response) {
    return authed;
  }
  if (authed.session.role !== "admin") {
    return forbiddenResponse();
  }
  return authed;
}
